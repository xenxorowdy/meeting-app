// Synthetic capacity check: 20 users, separate mic/system streams, no real provider calls.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn twenty_meetings_forward_two_audio_streams_each() {
    let auth: Responder = Arc::new(|seen: &Seen| {
        let user = seen
            .headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer beta-user-"))
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|user| *user < 20);
        match user {
            Some(user) => (
                StatusCode::OK,
                json!({
                    "id": format!("12345678-1234-1234-1234-{user:012}"),
                    "is_anonymous": false,
                })
                .to_string(),
            ),
            None => (StatusCode::UNAUTHORIZED, "{}".into()),
        }
    });
    let seconds = std::env::var("KESAMI_RELAY_SOAK_SECONDS")
        .ok()
        .map(|value| value.parse::<u64>().expect("invalid soak duration"))
        .unwrap_or(3);
    assert!(
        (1..=7190).contains(&seconds),
        "leave headroom before the relay's two-hour deadline"
    );
    let mut app = Fixture::with(auth, gemini_ok(), |_| {}).await;
    let mut streams = Vec::new();
    for user in 0..20 {
        for _ in 0..2 {
            let client = app.connect(&format!("beta-user-{user}")).await.unwrap();
            let provider = app.provider().await;
            streams.push((client, provider));
        }
    }
    assert_eq!(app.relay.ledger.lock().unwrap().streams, 40);
    assert_eq!(rejected_with(app.connect("beta-user-0").await), 429);
    let mut workers = tokio::task::JoinSet::new();
    let start = tokio::time::Instant::now() + Duration::from_millis(100);
    for (mut client, mut provider) in streams {
        workers.spawn(async move {
            let _provider_connection = provider.hang_up.take();
            let mut ticker = tokio::time::interval_at(start, Duration::from_millis(200));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // 200 ms of mono 16 kHz, signed 16-bit PCM, encoded for the provider protocol.
            let audio =
                json!({ "event": "audio_input", "audio": "A".repeat(8532) + "AA==" }).to_string();
            let transcript = r#"{"type":"data","data":{"transcript":"synthetic capacity sample"}}"#;
            for _ in 0..seconds * 5 {
                ticker.tick().await;
                timeout(WAIT, client.send(Message::text(audio.clone())))
                    .await
                    .unwrap()
                    .unwrap();
                let received = timeout(WAIT, provider.received.recv())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(received, audio);
                provider.reply.send(transcript.into()).unwrap();
                let received = timeout(WAIT, client.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
                assert_eq!(received.into_text().unwrap().as_str(), transcript);
            }
            assert!(
                start.elapsed() <= Duration::from_secs(seconds + 2),
                "stream failed to sustain the realtime audio rate"
            );
            client.close(None).await.unwrap();
        });
    }
    while let Some(worker) = workers.join_next().await {
        worker.unwrap();
    }
    timeout(WAIT, async {
        while app.relay.ledger.lock().unwrap().streams != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(app.health().await, 200);
    app.relay.close();
    timeout(WAIT, app.server).await.unwrap().unwrap();
}
