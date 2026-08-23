const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const FAKE_USER_DATA = path.join('/tmp', 'alpha-podcast-test-userdata');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
        return {
            app: { getPath: name => name === 'temp' ? '/tmp' : FAKE_USER_DATA },
            dialog: {}, ipcMain: { handle() {} }, net: {}, protocol: { registerSchemesAsPrivileged() {}, handle() {} },
            safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
            shell: { openExternal() {} },
            nativeImage: { createFromDataURL: () => ({ resize() { return this; }, toPNG: () => Buffer.from('png') }) },
        };
    }
    return originalLoad(request, parent, isMain);
};

const podcast = require('../apps/desktop/podcast');
Module._load = originalLoad;
const { safeId, projectDir, resolveProjectPath, firstJsonObject, defaultProject, normalizeProject, createProject, getProject, deleteProject, mutateProject, addAssetToTimeline, parseRss, parseVtt, isPrivateAddress, renderGraph } = podcast._testing;

test('podcast ids and paths stay inside one project directory', () => {
    const id = '8ce1321e-1163-49da-a1fe-f51476cb4881';
    assert.equal(safeId(id), id);
    assert.equal(resolveProjectPath(id, 'assets/voice.wav'), path.join(projectDir(id), 'assets', 'voice.wav'));
    assert.throws(() => resolveProjectPath(id, '../../credentials.json'), /outside/);
    assert.throws(() => resolveProjectPath('///', 'x'), /valid id/);
    assert.throws(() => safeId('../render-project'), /valid id/);
});

test('old project manifests receive current safe defaults', () => {
    const project = normalizeProject({ id: 'legacy-project', title: 'Legacy', source: { kind: 'file' } });
    assert.equal(project.schemaVersion, 1);
    assert.equal(project.script.hosts.length, 2);
    assert.ok(project.timeline.tracks.some(track => track.id === 'speech'));
    assert.deepEqual(project.assets, []);
});

test('a complete project JSON prefix can be recovered from a collided save tail', async () => {
    const id = 'recover-collided-project';
    await deleteProject(id);
    const original = await createProject({ id, title: 'Recover me' });
    const file = path.join(projectDir(id), 'project.json');
    fs.appendFileSync(file, 'etLufs": -16}\n}');
    assert.equal(firstJsonObject(fs.readFileSync(file, 'utf8')).id, id);
    const recovered = await getProject(id);
    assert.equal(recovered.title, original.title);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(recovered.recoveryHistory.length, 1);
    assert.ok(fs.readdirSync(projectDir(id)).some(name => name.includes('.corrupt-') && name.endsWith('.bak')));
    await deleteProject(id);
});

test('RSS parser returns only episodes with enclosures', () => {
    const feed = parseRss(`<?xml version="1.0"?><rss><channel><title>Alpha &amp; Friends</title>
      <item><guid>one</guid><title>First</title><enclosure url="https://media.example/one.mp3" type="audio/mpeg" length="42" /></item>
      <item><guid>two</guid><title>Text only</title></item></channel></rss>`, 'https://example.com/feed.xml');
    assert.equal(feed.title, 'Alpha & Friends');
    assert.equal(feed.episodes.length, 1);
    assert.equal(feed.episodes[0].length, 42);
});

test('VTT captions become timestamped source turns', () => {
    const turns = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello <b>team</b>.\n\n00:03.500 --> 00:04.000\nNext.');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].startMs, 1000);
    assert.equal(turns[0].endMs, 3500);
    assert.equal(turns[0].text, 'Hello team.');
});

test('private and link-local RSS destinations are recognized', () => {
    for (const address of ['127.0.0.1', '10.0.0.2', '172.16.5.1', '192.168.1.2', '169.254.1.1', '::1', 'fe80::1']) {
        assert.equal(isPrivateAddress(address), true, address);
    }
    assert.equal(isPrivateAddress('8.8.8.8'), false);
});

test('render graph uses argument arrays and maps a normalized master', () => {
    const project = defaultProject({ id: 'render-project' });
    project.assets.push({ id: 'voice', relativePath: 'assets/voice.wav', hasAudio: true, hasVideo: false, durationMs: 1000 });
    project.timeline.tracks[0].clips.push({ id: 'clip', assetId: 'voice', sourceStartMs: 0, durationMs: 1000, timelineStartMs: 0, gainDb: 0 });
    project.timeline.durationMs = 1000;
    const args = renderGraph(project, 'mp3', '/tmp/out.mp3');
    assert.ok(Array.isArray(args));
    assert.ok(args.includes('-filter_complex'));
    assert.ok(args.join(' ').includes('loudnorm=I=-16:TP=-1'));
    assert.equal(args.at(-1), '/tmp/out.mp3');
});

test('video clips honor fill mode and source trims in the MP4 graph', () => {
    const project = defaultProject({ id: 'video-trim-project' });
    project.assets.push(
        { id: 'voice', relativePath: 'assets/voice.wav', hasAudio: true, hasVideo: false, durationMs: 2000 },
        { id: 'camera', relativePath: 'assets/camera.mp4', hasAudio: false, hasVideo: true, durationMs: 5000 },
    );
    project.timeline.tracks.find(track => track.id === 'speech').clips.push({ id: 'voice-clip', assetId: 'voice', sourceStartMs: 0, sourceEndMs: 2000, durationMs: 2000, timelineStartMs: 0, gainDb: 0 });
    project.timeline.tracks.find(track => track.id === 'video').clips.push({ id: 'video-clip', assetId: 'camera', sourceStartMs: 1000, sourceEndMs: 4000, durationMs: 3000, timelineStartMs: 0, fit: 'cover', opacity: 1 });
    project.timeline.durationMs = 3000;
    const graph = renderGraph(project, 'mp4', '/tmp/video-trim.mp4').join(' ');
    assert.match(graph, /trim=start=1\.000:duration=3\.000/);
    assert.match(graph, /force_original_aspect_ratio=increase,crop=1920:1080/);
});

test('synchronized capture assets share a fixed timeline origin', () => {
    const project = defaultProject({ id: 'capture-project' });
    addAssetToTimeline(project, { id: 'mic', hasAudio: true, hasVideo: false, durationMs: 1200 }, 'speech', 5000);
    addAssetToTimeline(project, { id: 'camera', hasAudio: false, hasVideo: true, durationMs: 1000 }, 'video-camera-take', 5000);
    assert.equal(project.timeline.tracks.find(track => track.id === 'speech').clips[0].timelineStartMs, 5000);
    assert.equal(project.timeline.tracks.find(track => track.id === 'video-camera-take').clips[0].timelineStartMs, 5000);
    assert.equal(project.timeline.durationMs, 6200);
});

test('concurrent capture mutations serialize without losing tracks', async () => {
    const id = 'concurrent-capture-project';
    await deleteProject(id);
    await createProject({ id });
    await Promise.all([
        mutateProject(id, async project => {
            await new Promise(resolve => setTimeout(resolve, 5));
            const asset = { id: 'mic-asset', hasAudio: true, hasVideo: false, durationMs: 1200 };
            project.assets.push(asset);
            addAssetToTimeline(project, asset, 'speech', 0);
        }),
        mutateProject(id, project => {
            const asset = { id: 'camera-asset', hasAudio: false, hasVideo: true, durationMs: 1000 };
            project.assets.push(asset);
            addAssetToTimeline(project, asset, 'video-camera-take', 0);
        }),
    ]);
    const project = await getProject(id);
    assert.deepEqual(project.assets.map(asset => asset.id).sort(), ['camera-asset', 'mic-asset']);
    assert.equal(project.timeline.tracks.find(track => track.id === 'speech').clips.length, 1);
    assert.equal(project.timeline.tracks.find(track => track.id === 'video-camera-take').clips.length, 1);
    await deleteProject(id);
});

test('FFmpeg renders real normalized MP3 and MP4 outputs from the project graph', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, () => {
    const id = 'render-smoke';
    const dir = projectDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    const input = path.join(dir, 'assets', 'voice.wav');
    const output = path.join(dir, 'out.mp3');
    const videoOutput = path.join(dir, 'out.mp4');
    assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', input]).status, 0);
    const project = defaultProject({ id });
    project.assets.push({ id: 'voice', relativePath: 'assets/voice.wav', hasAudio: true, hasVideo: false, durationMs: 1000 });
    project.timeline.tracks[0].clips.push({ id: 'clip', assetId: 'voice', sourceStartMs: 0, durationMs: 1000, timelineStartMs: 0, gainDb: 0 });
    project.timeline.durationMs = 1000;
    const rendered = spawnSync('ffmpeg', renderGraph(project, 'mp3', output), { encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(fs.statSync(output).size > 10_000);
    const videoArgs = renderGraph(project, 'mp4', videoOutput);
    const encoderIndex = videoArgs.indexOf('-c:v');
    videoArgs[encoderIndex + 1] = 'libx264';
    const allowIndex = videoArgs.indexOf('-allow_sw');
    if (allowIndex >= 0) videoArgs.splice(allowIndex, 2);
    const renderedVideo = spawnSync('ffmpeg', videoArgs, { encoding: 'utf8' });
    assert.equal(renderedVideo.status, 0, renderedVideo.stderr);
    assert.ok(fs.statSync(videoOutput).size > 10_000);
    fs.rmSync(dir, { recursive: true, force: true });
});
