const { app, desktopCapturer, ipcMain, net, protocol, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Recordings live under Electron's own userData rather than the Rust core's data
// directory: the shell owns these files and the backend only stores the path. Two
// processes writing one directory is how partial files and orphans happen.
const RECORDINGS_ROOT = path.join(app.getPath('userData'), 'recordings');

// A dedicated scheme rather than file://. `<video>` needs HTTP range requests to
// seek, and `net.fetch` over a file URL implements them; serving the file through
// the Rust core would mean hand-writing 206 partial-content support into a server
// whose every response is currently `Connection: close`.
const MEDIA_SCHEME = 'alpha-media';

const streams = new Map();
let nextId = 1;
let selectedSourceId = null;

const toPosix = value => value.split(path.sep).join('/');

function meetingDir(meetingId) {
    // The id comes from the backend (a UUID), but it reaches us through the
    // renderer, so it is treated as untrusted input and stripped to a safe name.
    const safe = String(meetingId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) throw new Error('a recording needs a meeting id');
    return path.join(RECORDINGS_ROOT, safe);
}

/** Resolve a path from the media scheme, refusing anything outside the root. */
function resolveMedia(relativePath) {
    const resolved = path.resolve(RECORDINGS_ROOT, relativePath);
    const root = path.resolve(RECORDINGS_ROOT);
    // `startsWith` alone would accept a sibling directory whose name shares the
    // prefix, so the separator has to be part of the comparison.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

async function directorySize(dir) {
    let total = 0;
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            total += await directorySize(full);
        } else {
            total += await fsp
                .stat(full)
                .then(s => s.size)
                .catch(() => 0);
        }
    }
    return total;
}

/**
 * Register the media scheme as privileged. Must run before `app.ready`, or the
 * page is not allowed to treat the responses as media it can stream and seek.
 */
function registerMediaScheme() {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: MEDIA_SCHEME,
            privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
        },
    ]);
}

function serveMediaScheme() {
    protocol.handle(MEDIA_SCHEME, request => {
        // alpha-media://recordings/<meetingId>/<file>
        let withoutHost;
        try {
            const url = new URL(request.url);
            // The URL parser resolves `..` in the path, but an *encoded* `%2e%2e%2f`
            // survives until this decode — which is why resolveMedia below is the
            // check that matters, not the parser.
            const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
            withoutHost = url.hostname === 'recordings' ? relative : path.join(url.hostname, relative);
        } catch {
            // A malformed percent-escape makes decodeURIComponent throw; without
            // this the whole protocol handler rejects instead of the one request.
            return new Response('Bad request', { status: 400 });
        }

        const resolved = resolveMedia(withoutHost);
        if (!resolved || !fs.existsSync(resolved)) {
            return new Response('Not found', { status: 404 });
        }
        // net.fetch honours the Range header, which is what makes seeking work.
        return net.fetch(pathToFileURL(resolved).toString(), { headers: request.headers });
    });
}

function registerHandlers() {
    ipcMain.handle('recorder:screen-permission', () =>
        process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
    );

    ipcMain.handle('recorder:list-sources', async () => {
        const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 320, height: 200 },
            fetchWindowIcons: false,
        });
        return sources.map(source => ({
            id: source.id,
            name: source.name,
            kind: source.id.startsWith('screen') ? 'screen' : 'window',
            displayId: source.display_id || null,
            thumbnail: source.thumbnail?.isEmpty() ? null : source.thumbnail.toDataURL(),
        }));
    });

    ipcMain.handle('recorder:select-source', (_event, sourceId) => {
        selectedSourceId = typeof sourceId === 'string' && sourceId ? sourceId : null;
        return { selected: selectedSourceId };
    });

    ipcMain.handle('recorder:start', async (_event, options = {}) => {
        const dir = meetingDir(options.meetingId);
        await fsp.mkdir(dir, { recursive: true });

        const file = path.join(dir, 'screen.webm');
        const id = String(nextId++);
        const handle = {
            id,
            file,
            bytes: 0,
            stream: fs.createWriteStream(file),
            meetingId: options.meetingId,
        };
        streams.set(id, handle);

        await fsp.writeFile(
            path.join(dir, 'recording.json'),
            JSON.stringify({ meetingId: options.meetingId, mimeType: options.mimeType, startedAtMs: options.startedAtMs }, null, 2)
        );

        // Always report a URL-shaped path: `path.relative` yields backslashes on
        // Windows, and the media scheme these become part of is not a filesystem
        // path. Converted here rather than in every consumer.
        return { id, path: toPosix(path.relative(RECORDINGS_ROOT, file)) };
    });

    ipcMain.handle('recorder:write-chunk', async (_event, id, chunk) => {
        const handle = streams.get(String(id));
        if (!handle) throw new Error('that recording is not open');

        const buffer = Buffer.from(chunk);
        handle.bytes += buffer.byteLength;

        // Respect backpressure: a slow disk must not let the queue grow without
        // bound while a long meeting keeps producing a chunk every second.
        if (!handle.stream.write(buffer)) {
            await new Promise(resolve => handle.stream.once('drain', resolve));
        }
        return { bytes: handle.bytes };
    });

    ipcMain.handle('recorder:stop', async (_event, id) => {
        const handle = streams.get(String(id));
        if (!handle) return null;
        streams.delete(String(id));

        await new Promise(resolve => handle.stream.end(resolve));
        return { path: toPosix(path.relative(RECORDINGS_ROOT, handle.file)), bytes: handle.bytes };
    });

    ipcMain.handle('recorder:remove', async (_event, meetingId) => {
        await fsp.rm(meetingDir(meetingId), { recursive: true, force: true });
        return { removed: true };
    });

    ipcMain.handle('recorder:usage', async () => ({ bytes: await directorySize(RECORDINGS_ROOT) }));
}

/**
 * Hand our chosen source to `getDisplayMedia`, so the app picks the screen in its
 * own UI instead of Chromium's picker.
 *
 * `audio: 'loopback'` is what captures the other participants. Where the platform
 * or build cannot do it the stream simply comes back without an audio track, and
 * the renderer reports that rather than pretending both sides were recorded.
 */
function installDisplayMediaHandler(targetSession = session.defaultSession) {
    targetSession.setDisplayMediaRequestHandler(
        async (_request, callback) => {
            try {
                const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
                const chosen =
                    sources.find(source => source.id === selectedSourceId) || sources.find(source => source.id.startsWith('screen')) || sources[0];

                if (!chosen) {
                    callback({});
                    return;
                }
                callback({ video: chosen, audio: 'loopback' });
            } catch {
                callback({});
            }
        },
        // Our own picker is already shown, so the system one would be a second
        // prompt for a choice the user has made.
        { useSystemPicker: false }
    );
}

/** Close any file still open, so a quit mid-meeting leaves a playable recording. */
async function shutdown() {
    for (const [, handle] of streams) {
        await new Promise(resolve => handle.stream.end(resolve)).catch(() => {});
    }
    streams.clear();
}

module.exports = {
    MEDIA_SCHEME,
    RECORDINGS_ROOT,
    registerMediaScheme,
    serveMediaScheme,
    registerHandlers,
    installDisplayMediaHandler,
    shutdown,
    _testing: { resolveMedia, meetingDir },
};
