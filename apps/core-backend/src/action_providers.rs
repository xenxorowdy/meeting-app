//! Provider adapters. No meeting-processing dependency on external destinations.
use crate::{
    actions::{ActionError, ActionProvider, Destination, Review},
    calendar::CalendarService,
    connectors::ConnectorService,
};
use serde_json::{json, Value};

pub struct ExistingProviders<'a> {
    pub calendar: &'a CalendarService,
    pub connectors: &'a ConnectorService,
}
impl ExistingProviders<'_> {
    pub async fn targets(&self) -> Value {
        let mut google = self.calendar.oauth_status(crate::calendar::GOOGLE).await;
        google["label"] = json!("Google Calendar · primary calendar");
        google["revision"] = json!(crate::actions::target_revision(&google));
        let jira = self.connectors.reviewed_jira_target().await;
        let slack = self.connectors.reviewed_slack_target().await;
        json!({"google_calendar":google,"jira":jira,"slack":slack})
    }
}

impl ActionProvider for ExistingProviders<'_> {
    async fn execute(&self, review: &Review) -> Result<Value, ActionError> {
        match review.destination {
            Destination::GoogleCalendar => self.calendar.create_reviewed_event(&review.provider_revision, &json!({"title":review.title,"start":review.start,"end":review.end,"description":review.body,"attendees":review.recipients})).await,
            Destination::Jira => self.connectors.create_reviewed_jira_issue(&review.provider_revision, &review.title, &review.body).await,
            Destination::Slack => self.connectors.post_reviewed_slack_summary(&review.provider_revision, &review.title, &review.body).await,
            _ => Err(ActionError { code:"unsupported_destination".into(),message:"This destination is handled locally.".into(),retryable:false,uncertain:false }),
        }
    }
}

/// Shared conservative handling: only definite rejections permit redispatch.
/// Network failure, malformed success and server failure could hide a created object.
pub async fn dispatch(request: reqwest::RequestBuilder) -> Result<Value, ActionError> {
    let response = request.send().await.map_err(|_| ActionError::uncertain())?;
    let status = response.status();
    if !status.is_success() {
        return Err(ActionError::response(status.as_u16()));
    }
    response.json().await.map_err(|_| ActionError::uncertain())
}

/// Webhooks acknowledge with plain text, not a JSON object or message URL.
pub async fn dispatch_slack(request: reqwest::RequestBuilder) -> Result<Value, ActionError> {
    let response = request.send().await.map_err(|_| ActionError::uncertain())?;
    let status = response.status();
    if status.as_u16() == 410 {
        return Err(ActionError::permission(
            "The Slack webhook is disabled. Update it in Settings, then review and confirm again.",
        ));
    }
    if !status.is_success() {
        return Err(ActionError::response(status.as_u16()));
    }
    let text = response
        .text()
        .await
        .map_err(|_| ActionError::uncertain())?;
    if status.as_u16() != 200 || text.trim() != "ok" {
        return Err(ActionError::uncertain());
    }
    Ok(json!({"posted":true,"provider":"slack"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    async fn response(status: u16, body: &str) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_string();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            let n = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]).to_string();
            socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            request
        });
        (format!("http://{address}"), task)
    }
    #[tokio::test]
    async fn calendar_and_jira_payloads_and_structured_rejections() {
        for body in [crate::calendar::google_event_body(&json!({"title":"Reviewed follow-up","start":"2026-10-13T10:00:00+05:30","end":"2026-10-13T10:30:00+05:30","attendees":["user@example.com"],"description":"Reviewed description"})).unwrap(), crate::connectors::reviewed_jira_body(json!({"projectKey":"TEST","issueType":"Task"}).as_object().unwrap(),"Reviewed Jira issue","Reviewed description")] {
            assert!(!body.to_string().contains("transcript"));
            assert!(body.to_string().contains("Reviewed description"));
            let (url,task)=response(201,"{\"id\":\"created\"}").await;
            let receipt=dispatch(reqwest::Client::new().post(url).json(&body)).await.unwrap(); assert_eq!(receipt["id"],"created");
            let captured=task.await.unwrap(); assert!(captured.contains(body["summary"].as_str().or(body["fields"]["summary"].as_str()).unwrap()));
        }
        for (status, retryable, uncertain) in [
            (401, true, false),
            (403, true, false),
            (429, true, false),
            (400, true, false),
            (500, false, true),
        ] {
            let (url, task) = response(
                status,
                "{\"error\":\"do not expose provider private response\"}",
            )
            .await;
            let err = dispatch(reqwest::Client::new().post(url))
                .await
                .unwrap_err();
            task.await.unwrap();
            assert_eq!(err.retryable, retryable);
            assert_eq!(err.uncertain, uncertain);
            assert!(!err.message.contains("private response"));
        }
        let (url, task) = response(200, "malformed").await;
        assert!(
            dispatch(reqwest::Client::new().post(url))
                .await
                .unwrap_err()
                .uncertain
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn slack_summary_payload_and_plain_text_receipts_are_conservative() {
        let body = crate::connectors::reviewed_slack_body("Reviewed title", "Only reviewed recap");
        let (url, task) = response(200, "ok").await;
        let receipt = dispatch_slack(reqwest::Client::new().post(url).json(&body))
            .await
            .unwrap();
        assert_eq!(receipt["posted"], true);
        let request = task.await.unwrap();
        assert!(request.contains("Only reviewed recap") && !request.contains("transcript"));
        for (status, body, retryable, uncertain) in [
            (403, "private token", true, false),
            (429, "rate_limited", true, false),
            (400, "invalid_payload", true, false),
            (410, "channel_is_archived", true, false),
            (500, "server_error", false, true),
            (200, "unexpected_ack", false, true),
        ] {
            let (url, task) = response(status, body).await;
            let error = dispatch_slack(reqwest::Client::new().post(url))
                .await
                .unwrap_err();
            task.await.unwrap();
            assert_eq!(error.retryable, retryable);
            assert_eq!(error.uncertain, uncertain);
            assert!(!error.message.contains("private token"));
        }
    }
}
