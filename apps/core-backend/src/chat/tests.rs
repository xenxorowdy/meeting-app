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
