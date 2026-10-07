use serde_json::Value;
use std::collections::{HashMap, HashSet};

const MATCH_SLACK_MS: i64 = 800;
const MIN_ATTRIBUTION_MS: i64 = 2_000;
const MIN_SHARE: f64 = 0.5;
const AMBIGUITY_RATIO: f64 = 0.5;
const STILL_TALKING_MS: i64 = i64::MAX / 4;

/// Display names for live remote identities. Unknown mixed audio stays one
/// provisional speaker until the provider or meeting client separates voices.
#[derive(Default)]
pub struct NumberedSpeakers {
    labels: HashMap<String, String>,
}

impl NumberedSpeakers {
    pub fn label(&mut self, identity: Option<&str>) -> String {
        let key = identity.unwrap_or_default();
        if let Some(label) = self.labels.get(key) {
            return label.clone();
        }
        let label = format!("Speaker {}", self.labels.len() + 1);
        self.labels.insert(key.to_string(), label.clone());
        label
    }

    pub fn peek(&self, identity: Option<&str>) -> Option<&str> {
        self.labels
            .get(identity.unwrap_or_default())
            .map(String::as_str)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpeechSpan {
    pub name: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiarizedSpan {
    pub speaker_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Default)]
pub struct SpeechLog {
    spans: Vec<SpeechSpan>,
    open: HashMap<String, i64>,
    roster: Vec<String>,
    source: Option<String>,
    self_name: Option<String>,
    observations: u64,
}

impl SpeechLog {
    pub fn set_source(&mut self, source: Option<String>) {
        if let Some(source) = source {
            self.source = Some(source);
        }
    }

    pub fn source(&self) -> Option<&str> {
        self.source.as_deref()
    }

    pub fn set_self_name(&mut self, name: Option<String>) {
        if let Some(name) = name {
            self.self_name = Some(name);
        }
    }

    pub fn self_name(&self) -> Option<&str> {
        self.self_name.as_deref()
    }

    pub fn observations(&self) -> u64 {
        self.observations
    }

    pub fn extend_roster(&mut self, names: &[String]) {
        for name in names {
            if !self.roster.iter().any(|known| known == name) {
                self.roster.push(name.clone());
            }
        }
    }

    pub fn roster(&self) -> &[String] {
        &self.roster
    }

    pub fn spans(&self) -> &[SpeechSpan] {
        &self.spans
    }

    pub fn is_empty(&self) -> bool {
        self.spans.is_empty() && self.open.is_empty()
    }

    pub fn current_speaker(&self) -> Option<String> {
        let others: Vec<_> = self
            .open
            .keys()
            .filter(|name| Some(name.as_str()) != self.self_name())
            .collect();
        if others.len() == 1 {
            Some(others[0].clone())
        } else {
            None
        }
    }

    pub fn observe(&mut self, speaking: &[String], at_ms: i64) {
        self.observations += 1;
        self.extend_roster(speaking);
        let current: HashSet<&str> = speaking.iter().map(String::as_str).collect();
        let ended: Vec<String> = self
            .open
            .keys()
            .filter(|name| !current.contains(name.as_str()))
            .cloned()
            .collect();
        for name in ended {
            if let Some(start_ms) = self.open.remove(&name) {
                self.push(name, start_ms, at_ms);
            }
        }
        for name in speaking {
            self.open.entry(name.clone()).or_insert(at_ms);
        }
    }

    pub fn close(&mut self, at_ms: i64) {
        let open = std::mem::take(&mut self.open);
        let mut open: Vec<(String, i64)> = open.into_iter().collect();
        open.sort();
        for (name, start_ms) in open {
            self.push(name, start_ms, at_ms);
        }
    }

    fn push(&mut self, name: String, start_ms: i64, end_ms: i64) {
        if end_ms <= start_ms {
            return;
        }
        if let Some(last) = self
            .spans
            .iter_mut()
            .rev()
            .find(|span| span.name == name)
            .filter(|span| span.end_ms >= start_ms)
        {
            last.end_ms = last.end_ms.max(end_ms);
            return;
        }
        self.spans.push(SpeechSpan {
            name,
            start_ms,
            end_ms,
        });
    }

    fn overlaps(&self, start_ms: i64, end_ms: i64) -> HashMap<&str, i64> {
        let mut totals: HashMap<&str, i64> = HashMap::new();
        let open = self
            .open
            .iter()
            .map(|(name, start)| (name.as_str(), *start, STILL_TALKING_MS));
        let closed = self
            .spans
            .iter()
            .map(|span| (span.name.as_str(), span.start_ms, span.end_ms));
        for (name, span_start, span_end) in closed.chain(open) {
            let overlap = (end_ms.min(span_end + MATCH_SLACK_MS)
                - start_ms.max(span_start - MATCH_SLACK_MS))
            .max(0);
            if overlap > 0 {
                *totals.entry(name).or_insert(0) += overlap;
            }
        }
        totals
    }

    pub fn speaker_during(&self, start_ms: i64, end_ms: i64) -> Option<String> {
        let duration = (end_ms - start_ms).max(0);
        if duration == 0 {
            return None;
        }
        let mut ranked: Vec<(&str, f64)> = self
            .overlaps(start_ms, end_ms)
            .into_iter()
            .map(|(name, overlap)| (name, overlap.min(duration) as f64 / duration as f64))
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));

        let (best, share) = *ranked.first()?;
        let runner_up = ranked.get(1).map(|(_, share)| *share).unwrap_or(0.0);
        if share < MIN_SHARE || runner_up > share * AMBIGUITY_RATIO {
            return None;
        }
        Some(best.to_string())
    }

    pub fn attribute(
        &self,
        spans: &[DiarizedSpan],
        taken_ids: &[&str],
        taken_names: &[&str],
    ) -> HashMap<String, String> {
        let mut spoken: HashMap<&str, i64> = HashMap::new();
        let mut overlaps: HashMap<(&str, &str), i64> = HashMap::new();
        for span in spans {
            if taken_ids.contains(&span.speaker_id.as_str()) {
                continue;
            }
            let duration = (span.end_ms - span.start_ms).max(0);
            if duration == 0 {
                continue;
            }
            *spoken.entry(span.speaker_id.as_str()).or_insert(0) += duration;
            for (name, overlap) in self.overlaps(span.start_ms, span.end_ms) {
                if taken_names.contains(&name) {
                    continue;
                }
                *overlaps
                    .entry((span.speaker_id.as_str(), name))
                    .or_insert(0) += overlap.min(duration);
            }
        }

        let mut candidates: Vec<(&str, &str, f64)> = overlaps
            .iter()
            .filter_map(|((speaker_id, name), overlap)| {
                let total = *spoken.get(speaker_id)?;
                if total < MIN_ATTRIBUTION_MS {
                    return None;
                }
                Some((*speaker_id, *name, *overlap as f64 / total as f64))
            })
            .collect();
        candidates.sort_by(|a, b| {
            b.2.total_cmp(&a.2)
                .then_with(|| a.0.cmp(b.0))
                .then_with(|| a.1.cmp(b.1))
        });

        let mut named: HashMap<String, String> = HashMap::new();
        let mut used_names: HashSet<&str> = HashSet::new();
        for (index, (speaker_id, name, share)) in candidates.iter().enumerate() {
            if *share < MIN_SHARE || named.contains_key(*speaker_id) || used_names.contains(*name) {
                continue;
            }
            let runner_up = candidates
                .iter()
                .skip(index + 1)
                .find(|(other_id, other_name, _)| other_id == speaker_id || other_name == name)
                .map(|(_, _, share)| *share)
                .unwrap_or(0.0);
            if runner_up > share * AMBIGUITY_RATIO {
                continue;
            }
            named.insert((*speaker_id).to_string(), (*name).to_string());
            used_names.insert(name);
        }
        named
    }
}

pub fn clean_name(name: &str) -> Option<String> {
    let cleaned = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned
        .trim_matches(|ch: char| ch == '"' || ch == '\'')
        .trim();
    if cleaned.is_empty() || cleaned.chars().count() > 80 {
        return None;
    }
    Some(cleaned.to_string())
}

pub fn clean_names(value: Option<&Value>) -> Vec<String> {
    let mut names = Vec::new();
    for name in value.and_then(Value::as_array).into_iter().flatten() {
        let Some(cleaned) = name.as_str().and_then(clean_name) else {
            continue;
        };
        if !names.contains(&cleaned) {
            names.push(cleaned);
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn log(script: &[(&[&str], i64)]) -> SpeechLog {
        let mut log = SpeechLog::default();
        for (speaking, at_ms) in script {
            log.observe(&names(speaking), *at_ms);
        }
        log
    }

    #[test]
    fn snapshots_become_intervals_that_close_when_a_name_stops_talking() {
        let mut log = log(&[
            (&["Aditi"], 1_000),
            (&["Aditi"], 2_000),
            (&["Riyam"], 3_000),
            (&["Riyam"], 4_000),
        ]);
        log.close(5_000);
        assert_eq!(
            log.spans,
            vec![
                SpeechSpan {
                    name: "Aditi".into(),
                    start_ms: 1_000,
                    end_ms: 3_000
                },
                SpeechSpan {
                    name: "Riyam".into(),
                    start_ms: 3_000,
                    end_ms: 5_000
                },
            ]
        );
        assert_eq!(log.roster(), ["Aditi", "Riyam"]);
        assert_eq!(log.observations(), 4);
    }

    #[test]
    fn a_name_that_starts_talking_again_extends_its_own_interval() {
        let mut log = log(&[(&["Aditi"], 0), (&[], 4_000), (&["Aditi"], 4_000)]);
        log.close(6_000);
        assert_eq!(log.spans.len(), 1);
        assert_eq!(log.spans[0].end_ms, 6_000);
    }

    #[test]
    fn names_the_person_the_page_had_talking_over_a_turn() {
        let mut log = log(&[(&["Aditi"], 10_000), (&[], 16_000)]);
        log.close(16_000);
        assert_eq!(log.speaker_during(10_400, 15_600).as_deref(), Some("Aditi"));
        assert_eq!(log.speaker_during(30_000, 34_000), None);
    }

    #[test]
    fn a_turn_lands_on_whoever_is_still_talking() {
        let log = log(&[(&["Aditi"], 10_000)]);
        assert_eq!(log.speaker_during(12_000, 16_000).as_deref(), Some("Aditi"));
        assert_eq!(log.speaker_during(2_000, 6_000), None);
    }

    #[test]
    fn declines_a_turn_two_people_talked_across() {
        let mut log = log(&[(&["Aditi", "Riyam"], 0)]);
        log.close(10_000);
        assert_eq!(log.speaker_during(1_000, 9_000), None);
    }

    #[test]
    fn matches_diarized_speakers_to_names_one_for_one() {
        let mut log = log(&[
            (&["Aditi"], 0),
            (&["Riyam"], 10_000),
            (&["Aditi"], 20_000),
            (&[], 30_000),
        ]);
        log.close(30_000);
        let spans = vec![
            DiarizedSpan {
                speaker_id: "0".into(),
                start_ms: 0,
                end_ms: 9_500,
            },
            DiarizedSpan {
                speaker_id: "1".into(),
                start_ms: 10_200,
                end_ms: 19_500,
            },
            DiarizedSpan {
                speaker_id: "0".into(),
                start_ms: 20_100,
                end_ms: 29_000,
            },
        ];
        let named = log.attribute(&spans, &[], &[]);
        assert_eq!(named["0"], "Aditi");
        assert_eq!(named["1"], "Riyam");
        assert_eq!(named.len(), 2);
    }

    #[test]
    fn leaves_out_speakers_and_names_that_are_already_spoken_for() {
        let mut log = log(&[(&["Aditi"], 0), (&["Riyam"], 10_000), (&[], 20_000)]);
        log.close(20_000);
        let spans = vec![
            DiarizedSpan {
                speaker_id: "0".into(),
                start_ms: 0,
                end_ms: 9_500,
            },
            DiarizedSpan {
                speaker_id: "1".into(),
                start_ms: 10_200,
                end_ms: 19_500,
            },
        ];
        let named = log.attribute(&spans, &["0"], &["Riyam"]);
        assert!(named.is_empty());
    }

    #[test]
    fn a_speaker_who_barely_talked_is_left_unnamed() {
        let mut log = log(&[(&["Aditi"], 0), (&[], 20_000)]);
        log.close(20_000);
        let spans = vec![DiarizedSpan {
            speaker_id: "0".into(),
            start_ms: 0,
            end_ms: 900,
        }];
        assert!(log.attribute(&spans, &[], &[]).is_empty());
    }

    #[test]
    fn current_speaker_identifies_the_sole_open_remote_speaker() {
        let mut log = SpeechLog::default();
        log.set_self_name(Some("Riyam".into()));
        assert_eq!(log.current_speaker(), None);

        log.observe(&["Riyam".to_string()], 0);
        assert_eq!(log.current_speaker(), None);

        log.observe(&["Riyam".to_string(), "Aditi".to_string()], 1_000);
        assert_eq!(log.current_speaker().as_deref(), Some("Aditi"));

        log.observe(&["Riyam".to_string(), "Aditi".to_string(), "Ben".to_string()], 2_000);
        assert_eq!(log.current_speaker(), None); // multiple speakers is ambiguous

        log.observe(&["Ben".to_string()], 3_000);
        assert_eq!(log.current_speaker().as_deref(), Some("Ben"));
    }

    #[test]
    fn participant_names_are_tidied_and_bounded() {
        assert_eq!(
            clean_name("  Aditi   Sharma \n").as_deref(),
            Some("Aditi Sharma")
        );
        assert_eq!(clean_name("   "), None);
        assert_eq!(clean_name(&"a".repeat(81)), None);
        assert_eq!(
            clean_names(Some(&json!(["Riyam", " Riyam ", "", "Aditi"]))),
            vec!["Riyam".to_string(), "Aditi".to_string()]
        );
    }
}
