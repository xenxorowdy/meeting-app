// Actual Rust HTTP/persistence with synthetic local meetings; no provider traffic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('post-meeting review covers each action type, permissions, repeat confirmation and restart', { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-actions-http-'));
    let backend;
    t.after(async () => { if (backend?.exitCode === null) { backend.kill('SIGTERM'); await once(backend, 'exit'); } await fs.rm(root, { recursive: true, force: true }); });
    const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const library = path.join(root, 'library');
    const transcript = ["I'll review the API tomorrow.", "Let's schedule a follow-up next Tuesday.", "I'll send the proposal tomorrow.", "I'll create the Jira ticket.", 'I might create a ticket.', 'If we get approval, I will send an email.'].map((text, i) => ({ id:`t${i}`,speaker:'Riyam',text,channel:'mic',startMs:i*1000,endMs:i*1000+900,confidence:1 }));
    const meeting = { id:'synthetic',title:'Synthetic actions',startedAt:0,endedAt:10000,durationSeconds:10,createdAt:0,summaryMarkdown:'',keyDecisions:[],emailDraft:'Subject: Proposal\n\nPlease review the proposal.',metadata:{},transcript,
        actionItems:[{id:'review',task:'Review API design',owner:'Riyam',deadline:'Tomorrow',completed:false,priority:'High',customField:'preserve'}, {id:'followup',task:'Follow up with engineering',owner:'Riyam',completed:false}, {id:'done',task:'Completed task',owner:'Riyam',completed:true}] };
    for (const m of [meeting,{...meeting,id:'live',endedAt:null}]) { await fs.mkdir(path.join(library,m.id),{recursive:true}); await fs.writeFile(path.join(library,m.id,'meeting.json'),JSON.stringify(m)); }
    const fake = path.join(root,'fake-claude');
    await fs.writeFile(fake, `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end',()=>process.stdout.write(JSON.stringify({structured_output:{executiveSummary:'Synthetic summary.',sections:[],keyDecisions:[],followUpEmail:{subject:'Updated recap',body:'A regenerated email draft.'},memoryFacts:[],actionItems:[{task:'Review API design',owner:'Riyam',deadline:'Friday',priority:'Low',sourceTurns:[0]}]}})));
`,{mode:0o700});
    const env = {...process.env}; for(const key of Object.keys(env)) if(/SUPABASE|DATABASE|POSTGRES|KESAMI_CLOUD|ALPHA_CLOUD/.test(key)) delete env[key];
    Object.assign(env,{KESAMI_DATA_DIR:root,KESAMI_LIBRARY_DIR:library,KESAMI_RECORDINGS_DIR:library,CORE_BACKEND_DATA_FILE:path.join(root,'missing.json'),CORE_BACKEND_PORT:String(port),KESAMI_CLOUD_URL:'',ALPHA_CLOUD_URL:'',KESAMI_CHAT_EMBEDDINGS:'off',KESAMI_GEMINI_API_KEY:'',KESAMI_OPENAI_API_KEY:'',KESAMI_SARVAM_API_KEY:'',KESAMI_CLAUDE_BIN:fake,KESAMI_SUMMARY_PROVIDER:'claude'});
    const start = async () => { backend=spawn(path.resolve(__dirname,'../apps/core-backend/target/debug/kesami-core-backend'),[],{cwd:root,env,stdio:'ignore'}); let error;backend.on('error',e=>{error=e;});for(let i=0;i<100;i++){if(error)throw error;if(backend.exitCode!==null)throw Error('Backend exited');try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Build Rust debug backend first'); };
    await start();
    const api=async(route,body,method=body===undefined?'GET':'POST')=>{const res=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:res.status,data:await res.json()};};
    const route='/api/meetings/synthetic/actions';
    assert.equal((await api('/api/meetings/missing/actions')).status,404);
    assert.deepEqual((await api('/api/meetings/live/actions')).data.suggestions,[]);
    await api('/api/meetings/synthetic/commitments',{});
    const before=(await api(route)).data;
    for(const kind of ['action_item','commitment','follow_up','calendar','email','jira']) assert.ok(before.suggestions.some(s=>s.kind===kind),kind);
    assert.equal(before.history.length,0,'viewing suggestions has no effects');
    assert.ok(!before.suggestions.some(s=>s.title.includes('might')||s.title.includes('If we')));
    assert.ok(!before.suggestions.some(s=>s.title==='Completed task'));
    const review=s=>({confirmed:true,revision:s.revision,destination:s.destination,title:s.title,person:'Riyam',dueDate:s.dueDate,body:'Reviewed content only',recipients:[],start:'',end:'',providerRevision:before.providers[s.destination]?.revision || ''});
    const run=(s,r)=>api(`${route}/${s.id}`,r);
    const local=before.suggestions.find(s=>s.kind==='action_item');
    assert.equal((await run(local,{...review(local),confirmed:false})).status,400);
    assert.equal((await run(local,{...review(local),person:'Speaker 1'})).status,400);
    assert.equal((await run(local,{...review(local),revision:'stale'})).status,409);
    assert.equal((await api('/api/meetings/live/actions/unknown',review(local))).status,409);
    assert.equal((await api(`${route}/unknown`,review(local))).status,404);
    assert.equal((await run(local,{...review(local),extra:'unreviewed'})).status,400);
    const concurrent=await Promise.all([
        ...Array.from({length:3},()=>run(local,review(local))),
        api('/api/meetings/synthetic/notes',{text:'Concurrent manual review note'}),
        api('/api/connectors/send',{meetingId:'synthetic',provider:'jira',force:true}),
        api('/api/connectors/send',{meetingId:'synthetic',provider:'slack',force:true}),
    ]);
    assert.ok(concurrent.slice(0,4).every(r=>r.status===200));
    assert.ok(concurrent.slice(4).every(r=>r.status===502),'unconfigured connectors cannot send');
    let saved=(await api('/api/meetings/synthetic')).data.meeting;
    assert.equal(saved.actionItems.filter(t=>t.task===local.title).length,1,'deduplicates an existing task');
    assert.equal(saved.notes.length,1);assert.equal(saved.metadata.connectorDeliveries.jira.ok,false);assert.equal(saved.metadata.connectorDeliveries.slack.ok,false);assert.equal(saved.metadata.postMeetingActions.items.length,1,'concurrent receipts preserve confirmations');
    const task=saved.actionItems.find(t=>t.task===local.title); assert.equal(task.id,'review');assert.equal(task.priority,'High');assert.equal(task.customField,'preserve');
    const commitment=before.suggestions.find(s=>s.kind==='commitment');assert.equal((await run(commitment,review(commitment))).status,200);
    const followup=before.suggestions.find(s=>s.kind==='follow_up');assert.equal((await run(followup,review(followup))).status,200);
    const emails=before.suggestions.filter(s=>s.kind==='email');
    for(const email of emails){assert.equal((await run(email,review(email))).status,400);const r={...review(email),recipients:['recipient@example.com']};assert.equal((await run(email,r)).status,200);assert.equal((await run(email,r)).status,200);}
    const calendar=before.suggestions.find(s=>s.kind==='calendar');assert.equal((await run(calendar,review(calendar))).status,400);
    const event={...review(calendar),start:'2026-10-13T10:00:00+05:30',end:'2026-10-13T10:30:00+05:30'};
    assert.equal((await run(calendar,event)).status,200);
    let record=(await api(route)).data.history.find(r=>r.id===calendar.id);assert.equal(record.status,'failed');assert.equal(record.error.code,'permission_required');assert.equal(record.error.retryable,true);
    assert.equal((await run(calendar,event)).status,200);record=(await api(route)).data.history.find(r=>r.id===calendar.id);assert.equal(record.attempts,2);
    const jira=before.suggestions.find(s=>s.kind==='jira');assert.equal((await run(jira,review(jira))).status,200);record=(await api(route)).data.history.find(r=>r.id===jira.id);assert.equal(record.status,'failed');assert.equal(record.error.code,'permission_required');
    // Regeneration/data edits cannot silently erase review history; saved drafts remain readable.
    await api('/api/meetings/synthetic',{emailDraft:'Changed generated email'},'PATCH');
    const oldEmail=emails.find(s=>s.body);const changed={...review(oldEmail),recipients:['recipient@example.com'],body:'Changed user draft'};assert.equal((await run(oldEmail,changed)).status,409);
    saved=(await api('/api/meetings/synthetic')).data.meeting;
    await api('/api/meetings/synthetic',{actionItems:saved.actionItems.map(t=>({...t,completed:true}))},'PATCH');
    const beforeRegeneration=(await api(route)).data.history;
    const regenerated=await api('/api/meetings/synthetic/summarize',{regenerate:true});
    assert.equal(regenerated.status,200,JSON.stringify(regenerated.data));
    assert.deepEqual((await api(route)).data.history,beforeRegeneration,'regeneration keeps local drafts and receipts');
    saved=(await api('/api/meetings/synthetic')).data.meeting;
    assert.ok(saved.actionItems.every(t=>t.completed),'regeneration preserves task completion');
    assert.equal(saved.actionItems.find(t=>t.id==='review').priority,'High');
    assert.equal(saved.actionItems.find(t=>t.id==='review').customField,'preserve');
    // Both summary destinations reuse durable review APIs; no credentials/network.
    const shares=(await api(route)).data.suggestions.filter(s=>s.kind.startsWith('summary_'));
    assert.equal(shares.length,2);
    for (const share of shares) {
        assert.ok(share.body.includes('Synthetic summary.'));
        assert.ok(!share.body.includes('Concurrent manual review note') && !share.body.includes('email draft'));
        const r={...review(share),body:share.body,providerRevision:(await api(route)).data.providers[share.destination].revision};
        assert.equal((await run(share,{...r,confirmed:false})).status,400);
        assert.equal((await run(share,{...r,body:''})).status,400);
        assert.equal((await run(share,{...r,revision:'old summary'})).status,409);
        assert.equal((await run(share,r)).status,200);
        const attempt=(await api(route)).data.history.find(record=>record.id===share.id);
        assert.equal(attempt.status,'failed');assert.equal(attempt.error.code,'permission_required');
        assert.equal(attempt.review.body,share.body);
    }
    assert.equal((await api('/api/meetings/synthetic',{turnSpeakers:{t0:'John'}},'PATCH')).status,200);
    assert.ok([404,409].includes((await run(calendar,event)).status),'stale external suggestion cannot retry');
    const history=(await api(route)).data.history;
    assert.equal(history.length,9); // Three tasks, two drafts, Calendar/Jira and two recap reviews.
    assert.equal(history.filter(r=>r.result?.draft).length,2);assert.ok(history.filter(r=>r.result?.draft).every(r=>r.result.sent===false));
    saved=(await api('/api/meetings/synthetic')).data.meeting;
    const canonical=JSON.parse(await fs.readFile(path.join(library,saved.folder,'meeting.json'),'utf8'));assert.deepEqual(canonical.metadata.postMeetingActions.items,history);
    backend.kill('SIGTERM');await once(backend,'exit');await start();
    assert.deepEqual((await api(route)).data.history,history);
    assert.equal((await run(local,review(local))).status,200,'same receipt survives restart without creating tasks');
    assert.ok((await api('/api/meetings/synthetic')).data.meeting.actionItems.every(t=>t.completed));
});
