use super::*;

fn meeting(id: &str, text: &str) -> Meeting {
    serde_json::from_value(json!({"id":id,"title":format!("Meeting {id}"),"startedAt":1000,"endedAt":2000,"durationSeconds":1,"summaryMarkdown":"","actionItems":[],"keyDecisions":[],"metadata":{},"transcript":[{"id":"t1","channel":"system","speaker":"Asha","startMs":10,"endMs":100,"text":text,"confidence":1.0}],"createdAt":1000})).unwrap()
}

#[test]
fn retrieves_middle_passage_without_sending_whole_meeting() {
    let text = format!(
        "{} The zephyr deadline is Friday. {}",
        "Boring unrelated weather discussion. ".repeat(300),
        "Unrelated lunch preferences. ".repeat(300)
    );
    let m = meeting("m1", &text);
    let mut index = Index::open(std::path::Path::new(":memory:")).unwrap();
    index
        .sync(
            &[
                m.clone(),
                meeting("outside", "The zephyr deadline is Monday"),
            ],
            true,
        )
        .unwrap();
    let evidence = index
        .retrieve("zephyr deadline", &[m], None, false)
        .unwrap();
    assert!(evidence.iter().any(|p| p.excerpt.contains("Friday")));
    assert!(evidence.iter().all(|p| p.meeting_id == "m1"));
    let packet =
        EvidencePacket::build("What is the zephyr deadline?", &[], evidence, &json!({})).unwrap();
    assert!(packet.prompt.len() < 8000);
    assert!(!packet.prompt.contains("Monday"));
    assert!(!packet.prompt.contains(&text));
}

#[test]
fn reviewed_commitment_tasks_link_current_transcript_but_never_stale_quotes() {
    let mut m = meeting("commitments", "I will send the proposal tomorrow.");
    crate::commitments::detect(&mut m);
    let candidate = crate::commitments::candidates(&m).remove(0);
    let review = json!({"status":"confirmed","person":"Asha","targetAction":"Send the proposal","transcriptRevision":crate::memory::transcript_revision(&m)});
    crate::commitments::review(&mut m, &candidate.id, &review).unwrap();
    let chunks = index::chunks(&m);
    let action = chunks.iter().find(|p| p.source_kind == "action").unwrap();
    assert_eq!(action.turn_ids, ["t1"]);
    assert_eq!(action.start_ms, Some(10));
    assert!(action.excerpt.contains("human_reviewed"));
    m.transcript[0].text = "I cannot send the proposal.".into();
    let chunks = index::chunks(&m);
    let action = chunks.iter().find(|p| p.source_kind == "action").unwrap();
    assert!(action.turn_ids.is_empty());
    assert!(action.excerpt.contains("original transcript has changed"));
}

#[test]
fn edits_deletes_and_slow_embeddings_cannot_restore_stale_evidence() {
    let old = meeting("m1", "Zephyr ships Friday");
    let new = meeting("m1", "Zephyr ships Monday");
    let mut index = Index::open(std::path::Path::new(":memory:")).unwrap();
    index.sync(&[old.clone()], true).unwrap();
    let pending = index.pending_vectors(16).unwrap();
    assert!(index
        .retrieve("Zephyr", &[new.clone()], None, false)
        .unwrap()
        .is_empty());
    index.sync(&[new.clone()], true).unwrap();
    index
        .save_vectors(&pending, &vec![vec![1.0; 384]; pending.len()])
        .unwrap();
    assert_eq!(
        index
            .db
            .query_row("SELECT count(*) FROM vectors", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(index.retrieve("Zephyr", &[new], None, false).unwrap()[0]
        .excerpt
        .contains("Monday"));
    index.sync(&[], true).unwrap();
    assert!(index
        .retrieve("Zephyr", &[old], None, false)
        .unwrap()
        .is_empty());
}

#[test]
fn citations_and_byte_budget_are_enforced() {
    let evidence = index::chunks(&meeting("m1", "We ship Friday"));
    let packet = EvidencePacket::build("When?", &[], evidence.clone(), &json!({})).unwrap();
    assert!(packet
        .validate_answer(&json!({"answer":"Friday [1]","citations":[1]}))
        .is_ok());
    for bad in [
        json!({"answer":"Friday [99]","citations":[99]}),
        json!({"answer":"Friday [2]","citations":[1]}),
        json!({"answer":"Friday","citations":[]}),
        json!({"answer":"Friday","citations":[1]}),
    ] {
        assert!(packet.validate_answer(&bad).is_err());
    }
    assert!(EvidencePacket::build(&"x".repeat(9000), &[], evidence, &json!({})).is_err());
}

#[test]
fn unicode_query_and_chunks_remain_valid() {
    let m = meeting("m1", &format!("{} समयसीमा शुक्रवार है", "नमस्ते ".repeat(400)));
    let mut index = Index::open(std::path::Path::new(":memory:")).unwrap();
    index.sync(&[m.clone()], true).unwrap();
    let result = index.retrieve("समयसीमा", &[m], None, false).unwrap();
    assert!(result.iter().any(|p| p.excerpt.contains("शुक्रवार")));
    assert!(result.iter().all(|p| p.excerpt.len() <= 1100));
    assert!(index::search_terms("\" OR * (deadline)").contains(&"deadline".into()));
}

#[tokio::test]
async fn live_scope_uses_a_snapshot_and_survives_append_only_transcription() {
    let mut live = meeting("live", "Zephyr ships Friday");
    live.ended_at = None;
    live.notes = vec![json!({"id":"n1","text":"Check rollout"})];
    let store = Store {
        library: Arc::new(tokio::sync::RwLock::new(crate::library::Library::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())))),
        meetings: Arc::new(tokio::sync::RwLock::new(HashMap::from([(live.id.clone(), live.clone())]))),
    };
    let scope = json!({"type":"meetings","meetingIds":["live"]});
    assert!(resolve_scope(&store, &json!({"type":"all"})).await.unwrap().is_empty());
    let snapshot = resolve_scope(&store, &scope).await.unwrap();
    assert_eq!(snapshot.len(), 1);
    let rev = revision(&live);
    assert!(rev.starts_with("live:"));
    let mut next = live.transcript[0].clone();
    next.id = "t2".into(); next.text = "Additional discussion".into(); next.start_ms = 101; next.end_ms = 200;
    live.transcript.push(next);
    live.notes.push(json!({"id":"n2","text":"New note"}));
    store.meetings.write().await.insert(live.id.clone(), live.clone());
    assert!(current(&store, &scope, &snapshot).await);
    assert!(source_matches(&live, &rev));
    let mut message = json!({"citations":[{"meetingId":"live","sourceRevision":rev}]});
    mark_citations(&store, &mut message).await;
    assert_eq!(message["citations"][0]["available"], true);
    live.ended_at = Some(3000);
    live.summary_markdown = "New completed summary".into();
    assert!(source_matches(&live, &rev), "completion preserves original transcript references");
    live.transcript[0].text = "Zephyr ships Monday".into();
    assert!(!source_matches(&live, &rev), "a correction invalidates the snapshot");
    store.meetings.write().await.insert(live.id.clone(), live);
    assert!(!current(&store, &scope, &snapshot).await);
    mark_citations(&store, &mut message).await;
    assert_eq!(message["citations"][0]["available"], false);
    for malformed in ["live:", "live:x:0:hash", "live:999:0:hash", "live:1:1:bad", "live:1:1:hash:extra"] {
        assert!(!source_matches(&snapshot[0], malformed));
    }
    store.meetings.write().await.clear();
    assert!(!current(&store, &scope, &snapshot).await);
}

#[test]
fn threads_persist_idempotently_and_rebuild_does_not_remove_history() {
    let root = std::env::temp_dir().join(format!("kesami-chat-test-{}", uuid::Uuid::new_v4()));
    private_directory(&root).unwrap();
    let path = root.join("threads.sqlite");
    let mut db = threads::Threads::open(&path).unwrap();
    let thread = db.create(&json!({"type":"all"}), "All meetings").unwrap();
    let id = thread["id"].as_str().unwrap();
    assert!(db.begin(id, "req", "Question").unwrap().is_none());
    db.finish(id, "req", &json!({"answer":"Answer","citations":[]}))
        .unwrap();
    assert!(db.begin(id, "req", "Question").unwrap().is_some());
    assert!(db.begin(id, "req", "Another question").is_err());
    drop(db);
    let mut index = Index::open(&root.join("search.sqlite")).unwrap();
    index.sync(&[], true).unwrap();
    let db = threads::Threads::open(&path).unwrap();
    assert_eq!(
        db.messages(id, i64::MAX).unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    db.delete(id).unwrap();
    assert!(db.get(id).is_err());
    drop(db);
    drop(index);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn scopes_are_resolved_from_the_whole_library_and_revalidated() {
    let root = std::env::temp_dir().join(format!("kesami-chat-scope-{}", uuid::Uuid::new_v4()));
    let meetings: HashMap<_, _> = (0..205)
        .map(|i| {
            let m = meeting(&format!("m{i}"), "Zephyr ships Friday");
            (m.id.clone(), m)
        })
        .collect();
    let store = Store {
        library: Arc::new(tokio::sync::RwLock::new(crate::library::Library::new(root))),
        meetings: Arc::new(tokio::sync::RwLock::new(meetings)),
    };
    let scope = json!({"type":"all"});
    let snapshot = resolve_scope(&store, &scope).await.unwrap();
    assert_eq!(snapshot.len(), 205);
    assert!(current(&store, &scope, &snapshot).await);
    store.meetings.write().await.remove("m204");
    assert!(!current(&store, &scope, &snapshot).await);
    assert!(
        resolve_scope(&store, &json!({"type":"meetings","meetingIds":["m204"]}))
            .await
            .is_err()
    );
    let limited = resolve_scope(&store, &json!({"type":"meetings","meetingIds":["m2","m2"]}))
        .await
        .unwrap();
    assert_eq!(limited.len(), 1);
    assert!(
        resolve_scope(&store, &json!({"type":"all","fromMs":2000,"toMs":1000}))
            .await
            .is_err()
    );
}

#[test]
fn semantic_retrieval_can_find_a_paraphrase_without_keyword_overlap() {
    let m = meeting("m1", "The vehicle needs repairs");
    let mut index = Index::open(std::path::Path::new(":memory:")).unwrap();
    index.sync(&[m.clone()], true).unwrap();
    let pending = index.pending_vectors(16).unwrap();
    let vector = vec![1.0; 384];
    index
        .save_vectors(&pending, &vec![vector.clone(); pending.len()])
        .unwrap();
    assert!(index
        .retrieve("automobile maintenance", &[m.clone()], None, false)
        .unwrap()
        .is_empty());
    assert!(!index
        .retrieve("automobile maintenance", &[m], Some(&vector), false)
        .unwrap()
        .is_empty());
}

fn memory_meeting(id: &str) -> Meeting {
    let mut m = meeting(id, "I will send Acme the API proposal on Friday.");
    let request = crate::summarizer::SummaryRequest { title:m.title.clone(), started_at:m.started_at, duration_seconds:1, notes:vec![], attendees:vec![], turns:m.transcript.iter().map(|t|crate::summarizer::SummaryTurn { id:t.id.clone(), speaker:t.speaker.clone(), start_ms:t.start_ms, text:t.text.clone() }).collect() };
    let records = json!([
        {"kind":"company","name":"Acme","quote":"send Acme the API proposal","owner":"","date":"","sourceTurns":[0]},
        {"kind":"commitment","name":"Send proposal","quote":"I will send Acme the API proposal on Friday.","owner":"Asha","date":"Friday","sourceTurns":[0]}
    ]);
    let facts = crate::memory::extract(&records, &request);
    crate::memory::persist(&mut m, &facts, "test");
    m
}

#[test]
fn memory_schema_migrates_reopens_and_prunes_entities_and_facts() {
    let root = std::env::temp_dir().join(format!("kesami-memory-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("search.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE meetings(id TEXT PRIMARY KEY,revision TEXT NOT NULL); INSERT INTO meetings VALUES('m1','old-v1'); PRAGMA user_version=1;").unwrap();
    drop(db);
    let mut index = Index::open(&path).unwrap();
    let m = memory_meeting("m1");
    index.sync(&[m.clone()], true).unwrap();
    assert_eq!(index.db.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(), 2);
    assert_eq!(index.db.query_row("SELECT count(*) FROM memory_facts",[],|r|r.get::<_,i64>(0)).unwrap(), 2);
    assert_eq!(index.db.query_row("SELECT count(*) FROM entities WHERE kind='company' AND normalized_name='acme'",[],|r|r.get::<_,i64>(0)).unwrap(), 1);
    assert!(index.retrieve("Acme", &[m.clone()], None, false).unwrap().iter().any(|p|p.source_kind == "commitment" && p.turn_ids == ["t1"]));
    drop(index);
    let mut index = Index::open(&path).unwrap();
    index.sync(&[m.clone()], true).unwrap();
    let mut edited = m;
    edited.transcript[0].text = "We are only considering a proposal.".into();
    assert!(crate::memory::facts(&edited).is_empty());
    index.sync(&[edited], true).unwrap();
    assert_eq!(index.db.query_row("SELECT count(*) FROM memory_facts",[],|r|r.get::<_,i64>(0)).unwrap(), 0);
    index.sync(&[], true).unwrap();
    for table in ["entities", "meeting_entities", "memory_facts", "chunks", "vectors"] {
        assert_eq!(index.db.query_row(&format!("SELECT count(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(), 0);
    }
    drop(index); std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn memory_filters_match_entities_and_dates_without_inventing_attendees() {
    let mut old = memory_meeting("old"); old.started_at = 1000;
    let mut new = memory_meeting("new"); new.started_at = 5000;
    let mut unrelated = meeting("unrelated", "Lunch today"); unrelated.transcript[0].speaker = "John".into();
    unrelated.metadata = json!({"attendees":["Asha"]});
    let store = Store { library:Arc::new(tokio::sync::RwLock::new(crate::library::Library::new(std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())))), meetings:Arc::new(tokio::sync::RwLock::new(HashMap::from([(old.id.clone(),old),(new.id.clone(),new),(unrelated.id.clone(),unrelated)]))) };
    let matches = resolve_scope(&store, &json!({"type":"all","entity":{"kind":"company","name":" acme "},"fromMs":3000,"toMs":6000})).await.unwrap();
    assert_eq!(matches.iter().map(|m|m.id.as_str()).collect::<Vec<_>>(), ["new"]);
    assert_eq!(resolve_scope(&store,&json!({"type":"all","entity":{"kind":"person","name":"Asha"}})).await.unwrap().len(),2);
    assert!(resolve_scope(&store,&json!({"type":"all","entity":{"kind":"company","name":"Imaginary"}})).await.unwrap().is_empty());
    for invalid in [json!({"kind":"agent","name":"Asha"}),json!({"kind":"person","name":" "}),Value::Null] {
        assert!(resolve_scope(&store,&json!({"type":"all","entity":invalid})).await.is_err());
    }
}

#[test]
fn recent_matches_rank_first_and_history_keeps_multiple_meetings() {
    let mut old = meeting("old", "Pricing is thirty dollars."); old.started_at = 0;
    let mut new = meeting("new", "Pricing is thirty dollars."); new.started_at = 365 * 86_400_000;
    let mut index = Index::open(std::path::Path::new(":memory:")).unwrap();
    index.sync(&[old.clone(),new.clone()], true).unwrap();
    let passages = index.retrieve("pricing", &[old,new], None, false).unwrap();
    assert_eq!(passages[0].meeting_id, "new");
    assert_eq!(passages.iter().map(|p|&p.meeting_id).collect::<HashSet<_>>().len(), 2);
    let packet = EvidencePacket::build("Pricing?",&[],passages,&json!({})).unwrap();
    let payload:Value = serde_json::from_str(&packet.prompt).unwrap();
    assert!(payload["sources"][0]["date"].is_string());
}

#[tokio::test]
async fn summary_save_preserves_latest_task_state_and_rejects_changed_or_deleted_sources() {
    let root = std::env::temp_dir().join(format!("kesami-memory-save-{}",uuid::Uuid::new_v4()));
    let mut m = meeting("m1", "I will send a proposal.");
    m.action_items = vec![json!({"id":"user-task","task":"Send proposal","owner":"Asha","completed":false})];
    let expected = crate::memory::summary_revision(&m);
    let store = Store { library:Arc::new(tokio::sync::RwLock::new(crate::library::Library::new(root.clone()))),meetings:Arc::new(tokio::sync::RwLock::new(HashMap::from([(m.id.clone(),m.clone())]))) };
    // The user checks the task while an AI request is in flight.
    m.action_items[0]["completed"] = json!(true);
    store.meetings.write().await.insert(m.id.clone(),m.clone());
    let summary = crate::summarizer::MeetingSummary { summary_markdown:"Proposal discussed.".into(), action_items:vec![json!({"task":"Send proposal","owner":"Asha"})],provider:"test".into(),..Default::default() };
    let stored = store.apply_summary("m1", &summary, &expected).await.unwrap();
    assert_eq!(stored.action_items[0]["completed"],true);
    assert_eq!(stored.action_items[0]["id"],"user-task");
    m.transcript[0].text = "There is no commitment.".into();
    store.meetings.write().await.insert(m.id.clone(),m);
    assert_eq!(store.apply_summary("m1",&summary,&expected).await.unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    store.meetings.write().await.clear();
    assert_eq!(store.apply_summary("m1",&summary,&expected).await.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[ignore = "Downloads the pinned 487 MB public model; run explicitly with network access"]
async fn local_multilingual_embedding_smoke() {
    let cache = std::env::temp_dir().join("kesami-chat-model-smoke");
    let mut model = embeddings::load(&cache).await.unwrap();
    let docs = vec![
        "query: When is the deadline?",
        "passage: The project must be delivered by Friday.",
        "passage: Lunch today includes pizza.",
        "query: समयसीमा कब है?",
        "passage: समयसीमा शुक्रवार है।",
    ];
    let vectors = tokio::task::spawn_blocking(move || {
        let vectors =
            embeddings::embed(&mut model, docs.into_iter().map(str::to_string).collect()).unwrap();
        // More than 512 tokens must still produce a valid pooled embedding.
        let long = format!(
            "passage: {} Final deadline is Friday.",
            "a ! b ? ".repeat(400)
        );
        assert_eq!(
            embeddings::embed(&mut model, vec![long]).unwrap()[0].len(),
            384
        );
        vectors
    })
    .await
    .unwrap();
    assert!(vectors
        .iter()
        .all(|v| v.len() == 384 && v.iter().all(|x| x.is_finite())));
    let dot = |a: usize, b: usize| {
        vectors[a]
            .iter()
            .zip(&vectors[b])
            .map(|(x, y)| x * y)
            .sum::<f32>()
    };
    assert!(
        dot(0, 1) > dot(0, 2),
        "English paraphrase must outrank unrelated content"
    );
    assert!(
        dot(3, 4) > dot(3, 2),
        "Hindi evidence must outrank unrelated content"
    );
    let m = meeting("m1", "The project must be delivered by Friday.");
    let mut index = Index::open(std::path::Path::new(":memory:")).unwrap();
    index.sync(&[m.clone()], true).unwrap();
    let passages = index.pending_vectors(16).unwrap();
    index
        .save_vectors(&passages, &[vectors[1].clone()])
        .unwrap();
    assert!(!index
        .retrieve("When is the deadline?", &[m], Some(&vectors[0]), false)
        .unwrap()
        .is_empty());
    eprintln!("Local embedding smoke: English relevant={:.3}, unrelated={:.3}; Hindi relevant={:.3}, unrelated={:.3}",dot(0,1),dot(0,2),dot(3,4),dot(3,2));
}
