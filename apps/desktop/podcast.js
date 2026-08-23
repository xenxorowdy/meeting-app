const { app, dialog, ipcMain, nativeImage, net, protocol, safeStorage, shell } = require('electron');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const PODCAST_SCHEME = 'alpha-podcast';
const PODCASTS_ROOT = path.join(app.getPath('userData'), 'podcast-projects');
const SETTINGS_PATH = path.join(PODCASTS_ROOT, 'settings.json');
const TOKEN_PATH = path.join(PODCASTS_ROOT, 'youtube-token.bin');
const SCHEMA_VERSION = 1;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_ENCLOSURE_BYTES = 4 * 1024 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.mp4', '.mov', '.mkv', '.webm']);
const jobs = new Map();
const captures = new Map();
const projectLocks = new Map();
let nextCaptureId = 1;

function safeId(value) {
    const candidate = String(value || '');
    if (!candidate || !/^[a-zA-Z0-9_-]+$/.test(candidate)) {
        throw new Error('a podcast project needs a valid id');
    }
    return candidate;
}

function projectDir(projectId) {
    return path.join(PODCASTS_ROOT, safeId(projectId));
}

function resolveProjectPath(projectId, relative = '') {
    const root = path.resolve(projectDir(projectId));
    const resolved = path.resolve(root, String(relative || ''));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('the podcast asset path is outside its project');
    }
    return resolved;
}

function toPosix(value) {
    return value.split(path.sep).join('/');
}

function relativeAsset(projectId, file) {
    return toPosix(path.relative(projectDir(projectId), file));
}

async function atomicJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    try {
        await fsp.writeFile(temp, JSON.stringify(value, null, 2));
        await fsp.rename(temp, file);
    } finally {
        await fsp.rm(temp, { force: true }).catch(() => {});
    }
}

async function withProjectLock(projectId, task) {
    const id = safeId(projectId);
    const previous = projectLocks.get(id) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    projectLocks.set(id, current);
    await previous.catch(() => {});
    try {
        return await task();
    } finally {
        release();
        if (projectLocks.get(id) === current) projectLocks.delete(id);
    }
}

async function readJson(file, fallback = null) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function firstJsonObject(text) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let started = false;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') { depth += 1; started = true; }
        else if (character === '}' && started && --depth === 0) {
            try {
                return JSON.parse(text.slice(0, index + 1));
            } catch {
                return null;
            }
        }
    }
    return null;
}

function defaultProject(options = {}) {
    const now = Date.now();
    const id = safeId(options.id || crypto.randomUUID());
    return {
        schemaVersion: SCHEMA_VERSION,
        id,
        title: String(options.title || 'Untitled podcast').slice(0, 180),
        description: '',
        createdAt: now,
        updatedAt: now,
        source: options.source || { kind: 'recording' },
        language: options.language || 'auto',
        generationDisclosureAcceptedAt: null,
        script: {
            status: 'empty',
            hosts: [
                { id: 'host-a', name: 'Avery', voice: 'Kore' },
                { id: 'host-b', name: 'Riley', voice: 'Puck' },
            ],
            detectedLanguage: null,
            estimatedDurationSeconds: 0,
            turns: [],
            chapters: [],
        },
        assets: [],
        timeline: {
            revision: 0,
            durationMs: 0,
            tracks: [
                { id: 'speech', name: 'Speech', kind: 'audio', muted: false, solo: false, clips: [] },
                { id: 'music', name: 'Music', kind: 'audio', muted: false, solo: false, clips: [] },
                { id: 'video', name: 'Video', kind: 'video', muted: false, solo: false, clips: [] },
                { id: 'captions', name: 'Captions', kind: 'caption', muted: false, solo: false, clips: [] },
            ],
            master: { stereo: true, targetLufs: -16, truePeakDb: -1 },
        },
        jobs: {},
        exports: [],
        publication: { channelId: null, playlistId: null, videoId: null, privacy: 'private', status: 'draft', studioUrl: null },
    };
}

function normalizeProject(project) {
    const base = defaultProject({ id: project.id, title: project.title, source: project.source, language: project.language });
    return {
        ...base,
        ...project,
        schemaVersion: SCHEMA_VERSION,
        script: { ...base.script, ...(project.script || {}) },
        timeline: { ...base.timeline, ...(project.timeline || {}), master: { ...base.timeline.master, ...(project.timeline?.master || {}) } },
        assets: Array.isArray(project.assets) ? project.assets : [],
        jobs: project.jobs || {},
        exports: Array.isArray(project.exports) ? project.exports : [],
        publication: { ...base.publication, ...(project.publication || {}) },
    };
}

async function createProject(options = {}) {
    const project = defaultProject(options);
    const dir = projectDir(project.id);
    await Promise.all(['assets', 'generated', 'proxies', 'renders', 'exports', 'captures'].map(name => fsp.mkdir(path.join(dir, name), { recursive: true })));
    await atomicJson(path.join(dir, 'project.json'), project);
    return project;
}

async function getProject(projectId) {
    const file = path.join(projectDir(projectId), 'project.json');
    let text;
    try {
        text = await fsp.readFile(file, 'utf8');
    } catch {
        throw new Error('Podcast project not found');
    }
    try {
        return normalizeProject(JSON.parse(text));
    } catch (cause) {
        const recovered = firstJsonObject(text);
        if (!recovered || recovered.id !== safeId(projectId)) {
            throw new Error(`Podcast project is damaged and could not be recovered: ${cause.message}`);
        }
        const backup = `${file}.corrupt-${Date.now()}-${crypto.randomUUID()}.bak`;
        await fsp.copyFile(file, backup);
        const project = normalizeProject(recovered);
        await recoverOrphanCaptures(project);
        project.recoveryHistory = [...(project.recoveryHistory || []), { recoveredAt: Date.now(), backupFile: path.basename(backup), reason: 'concurrent-save-tail' }].slice(-10);
        await atomicJson(file, project);
        return project;
    }
}

async function saveProjectUnlocked(project) {
    if (!project || typeof project !== 'object') throw new Error('project must be an object');
    const existing = await getProject(project.id);
    const merged = normalizeProject({ ...existing, ...project, id: existing.id, createdAt: existing.createdAt, updatedAt: Date.now() });
    await atomicJson(path.join(projectDir(existing.id), 'project.json'), merged);
    return merged;
}

async function saveProject(project) {
    if (!project || typeof project !== 'object') throw new Error('project must be an object');
    return withProjectLock(project.id, () => saveProjectUnlocked(project));
}

async function mutateProject(projectId, change) {
    return withProjectLock(projectId, async () => {
        const project = await getProject(projectId);
        await change(project);
        return saveProjectUnlocked(project);
    });
}

async function listProjects() {
    await fsp.mkdir(PODCASTS_ROOT, { recursive: true });
    const entries = await fsp.readdir(PODCASTS_ROOT, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            projects.push(await getProject(entry.name));
        } catch {
            // A directory without a recoverable manifest is not a project.
        }
    }
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function recoverOrphanCaptures(project) {
    const directory = resolveProjectPath(project.id, 'captures');
    let entries;
    try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
        return;
    }
    const known = new Set(project.assets.map(asset => asset.relativePath));
    const recorded = project.assets.filter(asset => asset.provenance?.kind === 'recording');
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const relativePath = toPosix(path.join('captures', entry.name));
        if (known.has(relativePath) || !ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const file = path.join(directory, entry.name);
        try {
            const [metadata, stat] = await Promise.all([inspectMedia(file), fsp.stat(file)]);
            const nearest = recorded.reduce((best, asset) => !best || Math.abs(asset.createdAt - stat.mtimeMs) < Math.abs(best.createdAt - stat.mtimeMs) ? asset : best, null);
            const group = nearest?.provenance?.captureGroupId || crypto.randomUUID();
            const matchingClip = project.timeline.tracks.flatMap(track => track.clips || []).find(clip => clip.assetId === nearest?.id);
            const asset = {
                id: crypto.randomUUID(),
                name: `Recovered ${metadata.hasVideo ? 'video' : 'audio'} take`,
                kind: metadata.hasVideo ? 'video' : 'audio',
                relativePath,
                createdAt: Math.round(stat.mtimeMs),
                provenance: { kind: 'recording', sourceKind: 'recovered', captureGroupId: group, recovered: true },
                ...metadata,
            };
            project.assets.push(asset);
            addAssetToTimeline(project, asset, metadata.hasVideo ? `video-recovered-${asset.id}` : 'speech', matchingClip?.timelineStartMs || 0);
            known.add(relativePath);
        } catch {
            // Keep unreadable capture bytes in place for manual recovery.
        }
    }
}

async function deleteProject(projectId) {
    const dir = projectDir(projectId);
    await fsp.rm(dir, { recursive: true, force: true });
    return { removed: true };
}

function executable(name) {
    const envName = `ALPHA_${name.replace(/-/g, '_').toUpperCase()}_PATH`;
    if (process.env[envName]) return process.env[envName];
    const file = process.platform === 'win32' ? `${name}.exe` : name;
    const bundled = path.join(process.resourcesPath || '', 'media-tools', process.platform, process.arch, file);
    return fs.existsSync(bundled) ? bundled : file;
}

function runProcess(command, args, { signal, onStderr } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.on('data', chunk => {
            stderr.push(chunk);
            onStderr?.(chunk.toString());
        });
        const abort = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', abort, { once: true });
        child.once('error', reject);
        child.once('exit', code => {
            signal?.removeEventListener('abort', abort);
            if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
            else reject(new Error(Buffer.concat(stderr).toString().trim().slice(-2000) || `${command} exited with ${code}`));
        });
    });
}

async function inspectMedia(file) {
    const { stdout } = await runProcess(executable('ffprobe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
    const info = JSON.parse(stdout.toString());
    const audio = info.streams?.find(stream => stream.codec_type === 'audio');
    const video = info.streams?.find(stream => stream.codec_type === 'video');
    if (!audio && !video) throw new Error('The selected file contains no usable audio or video stream.');
    return {
        durationMs: Math.round(Number(info.format?.duration || Math.max(audio?.duration || 0, video?.duration || 0)) * 1000),
        sizeBytes: Number(info.format?.size || 0),
        mimeType: video ? `video/${video.codec_name || 'unknown'}` : `audio/${audio?.codec_name || 'unknown'}`,
        hasAudio: Boolean(audio),
        hasVideo: Boolean(video),
        sampleRate: audio ? Number(audio.sample_rate || 0) : null,
        channels: audio ? Number(audio.channels || 0) : null,
        width: video ? Number(video.width || 0) : null,
        height: video ? Number(video.height || 0) : null,
    };
}

function uniqueFile(dir, original) {
    const ext = path.extname(original).toLowerCase();
    const stem = path.basename(original, ext).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'media';
    return path.join(dir, `${stem}-${crypto.randomUUID().slice(0, 8)}${ext}`);
}

function addAssetToTimeline(project, asset, trackId = null, fixedStartMs = null) {
    const chosen = trackId || (asset.hasVideo ? 'video' : 'speech');
    let track = project.timeline.tracks.find(item => item.id === chosen);
    if (!track) {
        track = { id: chosen, name: chosen.replace(/^video-/, '').replace(/-/g, ' '), kind: asset.hasVideo ? 'video' : 'audio', muted: false, solo: false, clips: [] };
        project.timeline.tracks.push(track);
    }
    const startMs = fixedStartMs == null ? track.clips.reduce((end, clip) => Math.max(end, clip.timelineStartMs + (clip.durationMs || 0)), 0) : Math.max(0, Number(fixedStartMs) || 0);
    track.clips.push({
        id: crypto.randomUUID(),
        assetId: asset.id,
        sourceStartMs: 0,
        sourceEndMs: asset.durationMs,
        timelineStartMs: startMs,
        durationMs: asset.durationMs,
        gainDb: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        transition: null,
        fit: 'contain',
        opacity: 1,
    });
    project.timeline.durationMs = Math.max(project.timeline.durationMs, startMs + asset.durationMs);
    project.timeline.revision += 1;
}

async function importFile(projectId, sourceFile = null, provenance = { kind: 'file' }) {
    let selected = sourceFile;
    if (!selected) {
        const result = await dialog.showOpenDialog({
            title: 'Import podcast media',
            properties: ['openFile'],
            filters: [{ name: 'Audio and video', extensions: Array.from(ALLOWED_EXTENSIONS).map(ext => ext.slice(1)) }],
        });
        if (result.canceled || !result.filePaths[0]) return null;
        [selected] = result.filePaths;
    }
    const ext = path.extname(selected).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) throw new Error(`Unsupported media type: ${ext || 'unknown'}`);
    const project = await getProject(projectId);
    const destination = uniqueFile(path.join(projectDir(projectId), 'assets'), selected);
    await fsp.copyFile(selected, destination);
    try {
        const metadata = await inspectMedia(destination);
        const asset = {
            id: crypto.randomUUID(),
            name: path.basename(selected),
            kind: metadata.hasVideo ? 'video' : 'audio',
            relativePath: relativeAsset(projectId, destination),
            createdAt: Date.now(),
            provenance,
            ...metadata,
        };
        project.assets.push(asset);
        addAssetToTimeline(project, asset);
        await saveProject(project);
        return { project: await getProject(projectId), asset };
    } catch (cause) {
        await fsp.rm(destination, { force: true });
        throw cause;
    }
}

function isPrivateAddress(address) {
    if (!address) return true;
    const normalized = address.replace(/^::ffff:/, '');
    return normalized === '::1' || normalized === '0.0.0.0' || normalized.startsWith('127.') || normalized.startsWith('10.') || normalized.startsWith('192.168.') || normalized.startsWith('169.254.') || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

async function validateRemoteUrl(input) {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RSS URLs must use HTTP or HTTPS.');
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(result => isPrivateAddress(result.address))) {
        throw new Error('RSS imports cannot access local or private-network addresses.');
    }
    return url;
}

async function fetchLimited(input, maxBytes, redirects = 0) {
    if (redirects > 4) throw new Error('Too many redirects while importing the RSS feed.');
    const url = await validateRemoteUrl(input);
    const response = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Alpha-Podcast-Studio/1.0' } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        return fetchLimited(new URL(response.headers.get('location'), url).toString(), maxBytes, redirects + 1);
    }
    if (!response.ok) throw new Error(`RSS request failed with ${response.status}.`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('The remote file is larger than Alpha allows.');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error('The remote file is larger than Alpha allows.');
        chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), contentType: response.headers.get('content-type') || '', finalUrl: url.toString() };
}

async function downloadLimited(input, file, maxBytes, redirects = 0) {
    if (redirects > 4) throw new Error('Too many redirects while importing the RSS enclosure.');
    const url = await validateRemoteUrl(input);
    const response = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'Alpha-Podcast-Studio/1.0' } });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        return downloadLimited(new URL(response.headers.get('location'), url).toString(), file, maxBytes, redirects + 1);
    }
    if (!response.ok) throw new Error(`RSS enclosure request failed with ${response.status}.`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('The remote file is larger than Alpha allows.');
    const handle = await fsp.open(file, 'w');
    let total = 0;
    try {
        const reader = response.body.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new Error('The remote file is larger than Alpha allows.');
            await handle.write(Buffer.from(value));
        }
    } catch (cause) {
        await handle.close();
        await fsp.rm(file, { force: true });
        throw cause;
    }
    await handle.close();
    return { contentType: response.headers.get('content-type') || '', finalUrl: url.toString(), bytes: total };
}

function xmlText(value = '') {
    return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function tag(block, name) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return xmlText(match?.[1] || '');
}

function parseRss(xml, feedUrl) {
    const channel = xml.match(/<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel>/i)?.[1] || xml;
    const episodes = [];
    for (const match of channel.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
        const item = match[1];
        const enclosure = item.match(/<enclosure\b([^>]*)\/?\s*>/i)?.[1] || '';
        const enclosureUrl = enclosure.match(/\burl=["']([^"']+)["']/i)?.[1];
        if (!enclosureUrl) continue;
        episodes.push({
            id: tag(item, 'guid') || crypto.createHash('sha256').update(enclosureUrl).digest('hex').slice(0, 20),
            title: tag(item, 'title') || 'Untitled episode',
            description: tag(item, 'description') || tag(item, 'content:encoded'),
            publishedAt: tag(item, 'pubDate') || null,
            enclosureUrl: new URL(enclosureUrl, feedUrl).toString(),
            enclosureType: enclosure.match(/\btype=["']([^"']+)["']/i)?.[1] || null,
            length: Number(enclosure.match(/\blength=["']([^"']+)["']/i)?.[1] || 0),
        });
    }
    return { title: tag(channel, 'title') || 'Podcast feed', description: tag(channel, 'description'), url: feedUrl, episodes };
}

async function inspectRss(url) {
    const response = await fetchLimited(url, MAX_FEED_BYTES);
    return parseRss(response.buffer.toString('utf8'), response.finalUrl);
}

async function importRssEpisode(projectId, feed, episode) {
    if (!episode?.enclosureUrl) throw new Error('Choose an RSS episode with a media enclosure.');
    if (Number(episode.length || 0) > MAX_ENCLOSURE_BYTES) throw new Error('That RSS enclosure is larger than Alpha allows.');
    const guessedUrl = new URL(episode.enclosureUrl);
    let ext = path.extname(guessedUrl.pathname).toLowerCase();
    const initialTemp = path.join(app.getPath('temp'), `alpha-rss-${crypto.randomUUID()}${ALLOWED_EXTENSIONS.has(ext) ? ext : '.media'}`);
    const response = await downloadLimited(episode.enclosureUrl, initialTemp, MAX_ENCLOSURE_BYTES);
    const url = new URL(response.finalUrl);
    ext = path.extname(url.pathname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        const byType = { 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/wav': '.wav', 'audio/flac': '.flac', 'video/mp4': '.mp4', 'video/webm': '.webm' };
        ext = byType[(response.contentType || '').split(';')[0]] || '';
    }
    if (!ext) {
        await fsp.rm(initialTemp, { force: true });
        throw new Error('The RSS enclosure is not a supported audio or video format.');
    }
    const temp = initialTemp.endsWith(ext) ? initialTemp : `${initialTemp}${ext}`;
    if (temp !== initialTemp) await fsp.rename(initialTemp, temp);
    try {
        const result = await importFile(projectId, temp, { kind: 'rss', feedUrl: feed.url, feedTitle: feed.title, episodeId: episode.id, episodeUrl: episode.enclosureUrl });
        if (result?.project) {
            result.project.title = episode.title || result.project.title;
            result.project.description = episode.description || result.project.description;
            result.project.source = { kind: 'rss', feedUrl: feed.url, feedTitle: feed.title, episodeId: episode.id, episodeUrl: episode.enclosureUrl };
            result.project = await saveProject(result.project);
        }
        return result;
    } finally {
        await fsp.rm(temp, { force: true });
    }
}

async function waveform(projectId, assetId) {
    const project = await getProject(projectId);
    const asset = project.assets.find(item => item.id === assetId);
    if (!asset) throw new Error('Podcast asset not found');
    const input = resolveProjectPath(projectId, asset.relativePath);
    const { stdout } = await runProcess(executable('ffmpeg'), ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '100', '-f', 'f32le', '-']);
    const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 4));
    const peaks = Array.from(samples, sample => Math.round(Math.min(1, Math.abs(sample)) * 1000) / 1000);
    const file = resolveProjectPath(projectId, `proxies/${safeId(assetId)}.waveform.json`);
    await atomicJson(file, { samplesPerSecond: 100, peaks });
    asset.waveformPath = relativeAsset(projectId, file);
    await saveProject(project);
    return { assetId, peaks };
}

async function updateJob(projectId, jobId, patch) {
    const project = await getProject(projectId);
    project.jobs[jobId] = { ...(project.jobs[jobId] || {}), ...patch, updatedAt: Date.now() };
    return saveProject(project);
}

async function cleanSpeech(projectId, assetId) {
    const project = await getProject(projectId);
    const asset = project.assets.find(item => item.id === assetId);
    if (!asset?.hasAudio) throw new Error('Choose an asset with audio to clean.');
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    jobs.set(jobId, controller);
    await updateJob(projectId, jobId, { type: 'clean-speech', status: 'running', progress: 0, assetId });
    const input = resolveProjectPath(projectId, asset.relativePath);
    const output = resolveProjectPath(projectId, `generated/clean-${safeId(assetId)}-${Date.now()}.wav`);
    const work = resolveProjectPath(projectId, `generated/.clean-${safeId(jobId)}`);
    const prepared = path.join(work, 'input.wav');
    const enhancedDir = path.join(work, 'enhanced');
    const enhanced = path.join(enhancedDir, 'input.wav');
    const temp = path.join(work, 'master.wav');
    try {
        await fsp.mkdir(enhancedDir, { recursive: true });
        await runProcess(executable('ffmpeg'), ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', prepared], { signal: controller.signal });
        const deepFilter = executable('deep-filter');
        try {
            await runProcess(deepFilter, ['-o', enhancedDir, prepared], { signal: controller.signal });
        } catch (cause) {
            if (cause.code === 'ENOENT' || /ENOENT|not found/i.test(cause.message)) {
                throw new Error('DeepFilterNet is not installed in this Alpha build. Set ALPHA_DEEP_FILTER_PATH or install the packaged media tools.');
            }
            throw cause;
        }
        if (!fs.existsSync(enhanced)) throw new Error('DeepFilterNet completed without producing cleaned audio.');
        await runProcess(executable('ffmpeg'), ['-y', '-v', 'error', '-i', enhanced, '-af', 'highpass=f=70,lowpass=f=16000,acompressor=threshold=-18dB:ratio=3:attack=10:release=120,loudnorm=I=-16:TP=-1:LRA=11', '-ar', '48000', '-c:a', 'pcm_s24le', temp], { signal: controller.signal });
        await fsp.rename(temp, output);
        const metadata = await inspectMedia(output);
        const cleaned = { id: crypto.randomUUID(), name: `${asset.name} — cleaned`, kind: 'audio', relativePath: relativeAsset(projectId, output), createdAt: Date.now(), provenance: { kind: 'cleaned', sourceAssetId: asset.id }, ...metadata };
        const latest = await getProject(projectId);
        latest.assets.push(cleaned);
        latest.jobs[jobId] = { ...(latest.jobs[jobId] || {}), status: 'completed', progress: 1, outputAssetId: cleaned.id, updatedAt: Date.now() };
        await saveProject(latest);
        return { project: await getProject(projectId), asset: cleaned, jobId };
    } catch (cause) {
        await fsp.rm(output, { force: true });
        await updateJob(projectId, jobId, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: cause.message });
        throw cause;
    } finally {
        jobs.delete(jobId);
        await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
}

function assetFor(project, clip) {
    return project.assets.find(asset => asset.id === clip.assetId);
}

function seconds(ms) {
    return (Math.max(0, Number(ms) || 0) / 1000).toFixed(3);
}

function finiteNumber(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function renderGraph(project, format, output) {
    const tracks = project.timeline.tracks || [];
    const anySolo = tracks.some(track => track.solo);
    const active = tracks.filter(track => !track.muted && (!anySolo || track.solo));
    const clips = active.flatMap(track => (track.clips || []).map(clip => ({ ...clip, trackKind: track.kind, asset: assetFor(project, clip) }))).filter(item => item.asset);
    const inputs = [];
    const audio = [];
    const video = [];
    for (const clip of clips) {
        const index = inputs.length;
        inputs.push(resolveProjectPath(project.id, clip.asset.relativePath));
        if (clip.asset.hasAudio && clip.trackKind !== 'video-muted') audio.push({ ...clip, input: index });
        if (clip.asset.hasVideo && clip.trackKind === 'video') video.push({ ...clip, input: index });
    }
    if (!audio.length) throw new Error('The timeline has no audible clips to render.');
    const filters = [];
    const audioLabels = [];
    audio.forEach((clip, index) => {
        const duration = Math.max(1, finiteNumber(clip.durationMs || clip.sourceEndMs - clip.sourceStartMs, 1, 1, 24 * 60 * 60 * 1000));
        const gainDb = finiteNumber(clip.gainDb, 0, -60, 24);
        const fadeInMs = finiteNumber(clip.fadeInMs, 0, 0, duration);
        const fadeOutMs = finiteNumber(clip.fadeOutMs, 0, 0, duration);
        const parts = [`[${clip.input}:a]atrim=start=${seconds(clip.sourceStartMs)}:duration=${seconds(duration)}`, 'asetpts=PTS-STARTPTS', `volume=${gainDb}dB`];
        if (fadeInMs) parts.push(`afade=t=in:st=0:d=${seconds(fadeInMs)}`);
        if (fadeOutMs) parts.push(`afade=t=out:st=${seconds(duration - fadeOutMs)}:d=${seconds(fadeOutMs)}`);
        const delay = Math.max(0, Math.round(clip.timelineStartMs || 0));
        parts.push(`adelay=${delay}|${delay}[a${index}]`);
        filters.push(parts.join(','));
        audioLabels.push(`[a${index}]`);
    });
    const needsWave = format === 'mp4' && !video.length;
    const targetLufs = finiteNumber(project.timeline.master?.targetLufs, -16, -30, -5);
    const truePeakDb = finiteNumber(project.timeline.master?.truePeakDb, -1, -9, 0);
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=11,aresample=48000${needsWave ? ',asplit=2[master][wave]' : '[master]'}`);
    const args = ['-y', '-v', 'error', ...inputs.flatMap(file => ['-i', file]), '-filter_complex'];
    const duration = Math.max(1000, project.timeline.durationMs || Math.max(...audio.map(clip => clip.timelineStartMs + clip.durationMs)));
    if (format === 'mp4') {
        filters.push(`color=c=0x111827:s=1920x1080:r=30:d=${seconds(duration)}[base]`);
        let current = 'base';
        video.forEach((clip, index) => {
            const durationMs = Math.max(1, clip.durationMs || clip.sourceEndMs - clip.sourceStartMs);
            const fit = clip.fit === 'cover'
                ? 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080'
                : 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black';
            filters.push(`[${clip.input}:v]trim=start=${seconds(clip.sourceStartMs)}:duration=${seconds(durationMs)},setpts=PTS-STARTPTS+${seconds(clip.timelineStartMs)}/TB,${fit},format=rgba,colorchannelmixer=aa=${Math.max(0, Math.min(1, Number(clip.opacity ?? 1)))}[v${index}]`);
            filters.push(`[${current}][v${index}]overlay=enable='between(t,${seconds(clip.timelineStartMs)},${seconds(clip.timelineStartMs + durationMs)})'[ov${index}]`);
            current = `ov${index}`;
        });
        if (!video.length) {
            filters.push(`[wave]showwaves=s=1720x280:mode=cline:colors=0x60a5fa@0.9,format=rgba[waves]`);
            filters.push(`[base][waves]overlay=100:400[videoout]`);
            current = 'videoout';
        }
        const videoEncoder = process.platform === 'darwin' ? 'h264_videotoolbox' : process.platform === 'win32' ? 'h264_mf' : 'libx264';
        args.push(filters.join(';'), '-map', `[${current}]`, '-map', '[master]', '-t', seconds(duration), '-r', '30', '-c:v', videoEncoder);
        if (process.platform === 'darwin') args.push('-allow_sw', '1');
        args.push('-b:v', '8M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', output);
    } else {
        args.push(filters.join(';'), '-map', '[master]');
        if (format === 'wav') args.push('-c:a', 'pcm_s24le', '-ar', '48000', output);
        else args.push('-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000', output);
    }
    return args;
}

async function renderProject(projectId, format = 'mp3', destination = null) {
    if (!['wav', 'mp3', 'mp4'].includes(format)) throw new Error('Choose WAV, MP3, or MP4.');
    const project = await getProject(projectId);
    let output = destination;
    if (!output) {
        const result = await dialog.showSaveDialog({ title: `Export ${project.title}`, defaultPath: `${project.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'podcast'}.${format}` });
        if (result.canceled || !result.filePath) return null;
        output = result.filePath;
    }
    const jobId = crypto.randomUUID();
    const controller = new AbortController();
    jobs.set(jobId, controller);
    await updateJob(projectId, jobId, { type: 'render', format, status: 'running', progress: 0, timelineRevision: project.timeline.revision || 0 });
    const internal = resolveProjectPath(projectId, `renders/${safeId(jobId)}.${format}`);
    try {
        const args = renderGraph(project, format, internal);
        try {
            await runProcess(executable('ffmpeg'), args, { signal: controller.signal });
        } catch (cause) {
            const encoderIndex = args.indexOf('-c:v');
            if (format !== 'mp4' || encoderIndex < 0 || !/encoder|compression session|external library/i.test(cause.message)) throw cause;
            const fallback = [...args];
            fallback[encoderIndex + 1] = 'libx264';
            const allowIndex = fallback.indexOf('-allow_sw');
            if (allowIndex >= 0) fallback.splice(allowIndex, 2);
            await runProcess(executable('ffmpeg'), fallback, { signal: controller.signal });
        }
        await fsp.copyFile(internal, output);
        const metadata = await inspectMedia(internal);
        const createdExport = { id: crypto.randomUUID(), format, relativePath: relativeAsset(projectId, internal), externalPath: output, createdAt: Date.now(), timelineRevision: project.timeline.revision || 0, ...metadata };
        const latest = await getProject(projectId);
        latest.exports.push(createdExport);
        latest.jobs[jobId] = { ...(latest.jobs[jobId] || {}), status: 'completed', progress: 1, output: relativeAsset(projectId, internal), updatedAt: Date.now() };
        await saveProject(latest);
        return { project: await getProject(projectId), export: createdExport, jobId };
    } catch (cause) {
        await fsp.rm(internal, { force: true });
        await updateJob(projectId, jobId, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: cause.message });
        throw cause;
    } finally {
        jobs.delete(jobId);
    }
}

function cancelJob(jobId) {
    const controller = jobs.get(String(jobId));
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
}

async function podcastSettings() {
    return (await readJson(SETTINGS_PATH, {})) || {};
}

async function savePodcastSettings(patch) {
    const current = await podcastSettings();
    const next = { ...current };
    if (Object.hasOwn(patch || {}, 'youtubeClientId')) next.youtubeClientId = String(patch.youtubeClientId || '').trim();
    await atomicJson(SETTINGS_PATH, next);
    return { ...next, youtubeConnected: Boolean(await loadToken()) };
}

async function loadToken() {
    try {
        const encrypted = await fsp.readFile(TOKEN_PATH);
        if (!safeStorage.isEncryptionAvailable()) return null;
        return JSON.parse(safeStorage.decryptString(encrypted));
    } catch {
        return null;
    }
}

async function storeToken(token) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
    await fsp.mkdir(PODCASTS_ROOT, { recursive: true });
    await fsp.writeFile(TOKEN_PATH, safeStorage.encryptString(JSON.stringify(token)), { mode: 0o600 });
}

async function oauthClientId() {
    const settings = await podcastSettings();
    const clientId = process.env.ALPHA_GOOGLE_OAUTH_CLIENT_ID || settings.youtubeClientId;
    if (!clientId) throw new Error('Add a Google OAuth client ID in Podcast settings before connecting YouTube.');
    return clientId;
}

function base64url(buffer) {
    return Buffer.from(buffer).toString('base64url');
}

async function connectYouTube() {
    const clientId = await oauthClientId();
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const server = http.createServer();
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl', code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' }).toString();
    const callback = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('YouTube sign-in timed out.')), 5 * 60 * 1000);
        server.on('request', (request, response) => {
            const incoming = new URL(request.url, redirectUri);
            response.end('<!doctype html><title>Alpha connected</title><p>You can return to Alpha.</p>');
            clearTimeout(timer);
            if (incoming.searchParams.get('state') !== state) reject(new Error('YouTube sign-in state did not match.'));
            else if (incoming.searchParams.get('error')) reject(new Error(`YouTube sign-in failed: ${incoming.searchParams.get('error')}`));
            else resolve(incoming.searchParams.get('code'));
        });
    });
    await shell.openExternal(auth.toString());
    try {
        const code = await callback;
        const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri }) });
        const token = await response.json();
        if (!response.ok) throw new Error(token.error_description || token.error || 'YouTube token exchange failed.');
        await storeToken({ ...token, expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000 });
        return { connected: true };
    } finally {
        server.close();
    }
}

async function accessToken() {
    const token = await loadToken();
    if (!token) throw new Error('Connect YouTube first.');
    if (token.access_token && token.expiresAt > Date.now() + 60_000) return token.access_token;
    if (!token.refresh_token) throw new Error('Reconnect YouTube to refresh access.');
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: await oauthClientId(), refresh_token: token.refresh_token, grant_type: 'refresh_token' }) });
    const refreshed = await response.json();
    if (!response.ok) throw new Error(refreshed.error_description || refreshed.error || 'YouTube token refresh failed.');
    const next = { ...token, ...refreshed, refresh_token: token.refresh_token, expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000 };
    await storeToken(next);
    return next.access_token;
}

async function youtubeJson(endpoint, options = {}) {
    const response = await fetch(`https://www.googleapis.com/youtube/v3/${endpoint}`, { ...options, headers: { Authorization: `Bearer ${await accessToken()}`, ...(options.headers || {}) } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || `YouTube request failed with ${response.status}.`);
    return value;
}

async function listOwnedYouTube() {
    const channel = await youtubeJson('channels?part=snippet,contentDetails&mine=true');
    const mine = channel.items?.[0];
    if (!mine) return { channel: null, videos: [] };
    const uploads = mine.contentDetails?.relatedPlaylists?.uploads;
    const playlist = await youtubeJson(`playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploads)}`);
    const ids = playlist.items?.map(item => item.contentDetails?.videoId).filter(Boolean) || [];
    const details = ids.length ? await youtubeJson(`videos?part=snippet,contentDetails,status&id=${ids.join(',')}`) : { items: [] };
    return { channel: { id: mine.id, title: mine.snippet?.title }, videos: details.items || [] };
}

async function importYouTubeCaptions(projectId, video) {
    if (!video?.id) throw new Error('Choose an owned YouTube video.');
    const captions = await youtubeJson(`captions?part=snippet&videoId=${encodeURIComponent(video.id)}`);
    const caption = captions.items?.find(item => item.snippet?.status !== 'failed');
    if (!caption) throw new Error('That video has no downloadable caption track.');
    const response = await fetch(`https://www.googleapis.com/youtube/v3/captions/${encodeURIComponent(caption.id)}?tfmt=vtt`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (!response.ok) throw new Error(`YouTube caption download failed with ${response.status}.`);
    const project = await getProject(projectId);
    const file = resolveProjectPath(projectId, `assets/youtube-${safeId(video.id)}.vtt`);
    const captionText = Buffer.from(await response.arrayBuffer()).toString('utf8');
    await fsp.writeFile(file, captionText);
    const asset = { id: crypto.randomUUID(), name: `${video.snippet?.title || 'YouTube video'} captions`, kind: 'caption', relativePath: relativeAsset(projectId, file), mimeType: 'text/vtt', durationMs: 0, createdAt: Date.now(), provenance: { kind: 'youtube', videoId: video.id, url: `https://www.youtube.com/watch?v=${video.id}` } };
    project.assets.push(asset);
    project.source = { kind: 'youtube', videoId: video.id, title: video.snippet?.title, url: `https://www.youtube.com/watch?v=${video.id}`, captionsOnly: true };
    project.title = video.snippet?.title || project.title;
    project.description = video.snippet?.description || project.description;
    project.transcript = parseVtt(captionText);
    await saveProject(project);
    return { project: await getProject(projectId), asset };
}

function captionClock(value) {
    const parts = value.trim().replace(',', '.').split(':').map(Number);
    if (parts.some(Number.isNaN)) return 0;
    const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    return Math.round(seconds * 1000);
}

function parseVtt(text) {
    const turns = [];
    for (const block of String(text || '').replace(/^WEBVTT[^\n]*\n/i, '').split(/\r?\n\s*\r?\n/)) {
        const lines = block.split(/\r?\n/).filter(Boolean);
        const timeIndex = lines.findIndex(line => line.includes('-->'));
        if (timeIndex < 0) continue;
        const [start, end] = lines[timeIndex].split('-->').map(value => value.trim().split(/\s+/)[0]);
        const spoken = xmlText(lines.slice(timeIndex + 1).join(' '));
        if (!spoken) continue;
        turns.push({ id: `youtube-${turns.length}`, speaker: 'Speaker', startMs: captionClock(start), endMs: captionClock(end), text: spoken });
    }
    return turns;
}

function streamUpload(url, file, headers) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const request = (target.protocol === 'https:' ? https : http).request(target, { method: 'PUT', headers }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                if (response.statusCode >= 200 && response.statusCode < 300) resolve(body ? JSON.parse(body) : {});
                else reject(new Error(`YouTube upload failed with ${response.statusCode}: ${body.slice(0, 500)}`));
            });
        });
        request.on('error', reject);
        fs.createReadStream(file).on('error', reject).pipe(request);
    });
}

async function ensurePodcastPlaylist(project, title) {
    if (project.publication.playlistId) return project.publication.playlistId;
    const playlistTitle = `${title} Podcast`;
    const playlistDescription = project.description || `Podcast episodes from ${title}`;
    const created = await youtubeJson('playlists?part=snippet,status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snippet: { title: playlistTitle, description: playlistDescription }, status: { privacyStatus: 'private' } }) });
    const escapedTitle = String(title).replace(/[<>&]/g, '').slice(0, 80);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#2563eb"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="800" height="800" rx="80" fill="url(#g)"/><circle cx="400" cy="315" r="120" fill="none" stroke="white" stroke-width="32"/><path d="M230 390c0 104 76 180 170 180s170-76 170-180M400 570v90M320 660h160" fill="none" stroke="white" stroke-width="32" stroke-linecap="round"/><text x="400" y="745" fill="white" font-family="sans-serif" font-size="34" text-anchor="middle">${escapedTitle}</text></svg>`;
    const png = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`).resize({ width: 800, height: 800 }).toPNG();
    const boundary = `alpha-playlist-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ snippet: { playlistId: created.id, type: 'hero', width: 800, height: 800 } });
    const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: image/png\r\nContent-Disposition: form-data; name="media"; filename="podcast.png"\r\n\r\n`),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const imageResponse = await fetch('https://www.googleapis.com/upload/youtube/v3/playlistImages?part=snippet&uploadType=multipart', { method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': String(multipart.length) }, body: multipart });
    if (!imageResponse.ok) throw new Error(`YouTube could not set podcast artwork: ${await imageResponse.text()}`);
    await youtubeJson('playlists?part=snippet,status', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: created.id, snippet: { title: playlistTitle, description: playlistDescription }, status: { privacyStatus: 'private', podcastStatus: 'enabled' } }) });
    return created.id;
}

async function publishYouTube(projectId, exportId = null) {
    const project = await getProject(projectId);
    const chosen = exportId ? project.exports.find(item => item.id === exportId) : [...project.exports].reverse().find(item => item.format === 'mp4');
    if (!chosen || chosen.format !== 'mp4') throw new Error('Render an MP4 before publishing to YouTube.');
    const file = resolveProjectPath(projectId, chosen.relativePath);
    const stat = await fsp.stat(file);
    const token = await accessToken();
    const metadata = { snippet: { title: project.title.slice(0, 100), description: project.description || 'Created with Alpha Podcast Studio', categoryId: '22' }, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: project.script?.turns?.length > 0 } };
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(stat.size), 'X-Upload-Content-Type': 'video/mp4' }, body: JSON.stringify(metadata) });
    if (!init.ok) throw new Error(`YouTube upload could not start: ${await init.text()}`);
    const location = init.headers.get('location');
    if (!location) throw new Error('YouTube did not return an upload location.');
    const uploaded = await streamUpload(location, file, { Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4', 'Content-Length': stat.size });
    const playlistId = await ensurePodcastPlaylist(project, project.title);
    await youtubeJson('playlistItems?part=snippet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: uploaded.id } } }) });
    project.publication = { ...project.publication, playlistId, videoId: uploaded.id, privacy: 'private', status: 'uploaded', studioUrl: `https://studio.youtube.com/video/${uploaded.id}/edit`, publishedAt: Date.now() };
    await saveProject(project);
    await shell.openExternal(project.publication.studioUrl);
    return { project: await getProject(projectId), videoId: uploaded.id, studioUrl: project.publication.studioUrl };
}

function registerScheme() {
    protocol.registerSchemesAsPrivileged([{ scheme: PODCAST_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);
}

function serveScheme() {
    protocol.handle(PODCAST_SCHEME, request => {
        try {
            const url = new URL(request.url);
            const projectId = safeId(url.hostname);
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            const file = resolveProjectPath(projectId, relative);
            if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
            return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
        } catch {
            return new Response('Bad request', { status: 400 });
        }
    });
}

function registerHandlers() {
    ipcMain.handle('podcast:list', listProjects);
    ipcMain.handle('podcast:create', (_event, options) => createProject(options));
    ipcMain.handle('podcast:get', (_event, id) => getProject(id));
    ipcMain.handle('podcast:save', (_event, project) => saveProject(project));
    ipcMain.handle('podcast:delete', (_event, id) => deleteProject(id));
    ipcMain.handle('podcast:import-file', (_event, id) => importFile(id));
    ipcMain.handle('podcast:add-asset', async (_event, projectId, assetId, options = {}) => {
        let addedClip = null;
        const project = await mutateProject(projectId, current => {
            const asset = current.assets.find(item => item.id === assetId);
            if (!asset) throw new Error('Podcast asset not found');
            const defaultTrack = asset.kind === 'caption' ? 'captions' : asset.hasVideo ? 'video' : 'speech';
            const trackId = safeId(options.trackId || defaultTrack);
            const startMs = options.startMs == null ? null : Math.max(0, Number(options.startMs) || 0);
            addAssetToTimeline(current, asset, trackId, startMs);
            addedClip = current.timeline.tracks.find(track => track.id === trackId)?.clips.at(-1) || null;
        });
        return { project, clip: addedClip };
    });
    ipcMain.handle('podcast:rss-inspect', (_event, url) => inspectRss(url));
    ipcMain.handle('podcast:rss-import', (_event, id, feed, episode) => importRssEpisode(id, feed, episode));
    ipcMain.handle('podcast:waveform', (_event, id, assetId) => waveform(id, assetId));
    ipcMain.handle('podcast:clean-speech', (_event, id, assetId) => cleanSpeech(id, assetId));
    ipcMain.handle('podcast:render', (_event, id, format) => renderProject(id, format));
    ipcMain.handle('podcast:cancel-job', (_event, id) => cancelJob(id));
    ipcMain.handle('podcast:settings', async () => ({ ...(await podcastSettings()), youtubeConnected: Boolean(await loadToken()), mediaTools: { ffmpeg: executable('ffmpeg'), deepFilter: executable('deep-filter') } }));
    ipcMain.handle('podcast:settings-save', (_event, patch) => savePodcastSettings(patch));
    ipcMain.handle('podcast:youtube-connect', connectYouTube);
    ipcMain.handle('podcast:youtube-disconnect', async () => { await fsp.rm(TOKEN_PATH, { force: true }); return { connected: false }; });
    ipcMain.handle('podcast:youtube-list', listOwnedYouTube);
    ipcMain.handle('podcast:youtube-import', (_event, id, video) => importYouTubeCaptions(id, video));
    ipcMain.handle('podcast:youtube-publish', (_event, id, exportId) => publishYouTube(id, exportId));
    ipcMain.handle('podcast:capture-start', async (_event, projectId, options = {}) => {
        const dir = resolveProjectPath(projectId, 'captures');
        await fsp.mkdir(dir, { recursive: true });
        const id = String(nextCaptureId++);
        const ext = options.mimeType?.includes('mp4') ? '.mp4' : '.webm';
        const file = uniqueFile(dir, `take${ext}`);
        captures.set(id, { id, projectId: safeId(projectId), file, bytes: 0, stream: fs.createWriteStream(file), mimeType: options.mimeType || 'video/webm', sourceKind: options.sourceKind || 'recording', captureGroupId: safeId(options.captureGroupId || crypto.randomUUID()), timelineStartMs: Math.max(0, Number(options.timelineStartMs) || 0) });
        return { id };
    });
    ipcMain.handle('podcast:capture-write', async (_event, id, chunk) => {
        const handle = captures.get(String(id));
        if (!handle) throw new Error('that podcast take is not open');
        const buffer = Buffer.from(chunk);
        handle.bytes += buffer.byteLength;
        if (!handle.stream.write(buffer)) await new Promise(resolve => handle.stream.once('drain', resolve));
        return { bytes: handle.bytes };
    });
    ipcMain.handle('podcast:capture-stop', async (_event, id) => {
        const handle = captures.get(String(id));
        if (!handle) return null;
        captures.delete(String(id));
        await new Promise(resolve => handle.stream.end(resolve));
        const metadata = await inspectMedia(handle.file);
        const asset = { id: crypto.randomUUID(), name: `${handle.sourceKind} take ${new Date().toLocaleString()}`, kind: metadata.hasVideo ? 'video' : 'audio', relativePath: relativeAsset(handle.projectId, handle.file), createdAt: Date.now(), provenance: { kind: 'recording', sourceKind: handle.sourceKind, captureGroupId: handle.captureGroupId }, ...metadata };
        const project = await mutateProject(handle.projectId, current => {
            current.assets.push(asset);
            const trackId = handle.sourceKind === 'microphone' ? 'speech' : `video-${handle.sourceKind}-${handle.captureGroupId}`;
            addAssetToTimeline(current, asset, trackId, handle.timelineStartMs);
        });
        return { project, asset };
    });
}

async function shutdown() {
    for (const controller of jobs.values()) controller.abort();
    jobs.clear();
    for (const [, handle] of captures) await new Promise(resolve => handle.stream.end(resolve)).catch(() => {});
    captures.clear();
}

module.exports = {
    PODCAST_SCHEME,
    PODCASTS_ROOT,
    registerScheme,
    serveScheme,
    registerHandlers,
    shutdown,
    mediaTool: executable,
    _testing: { safeId, projectDir, resolveProjectPath, firstJsonObject, defaultProject, normalizeProject, createProject, getProject, deleteProject, mutateProject, addAssetToTimeline, parseRss, parseVtt, isPrivateAddress, renderGraph },
};
