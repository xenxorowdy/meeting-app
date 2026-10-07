const { app, desktopCapturer, ipcMain, net, protocol, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { env, LIBRARY } = require('./legacy');

// One visible folder per meeting, holding its recording next to the transcript and
// summary the backend writes. The shell streams into `.in-progress/<meetingId>`
// while the meeting runs — a uuid directory has no business sitting in a folder the
// user browses — and the backend moves the finished file into the meeting's folder.
// Both processes must agree on this root: it reaches the backend as
// KESAMI_LIBRARY_DIR and KESAMI_RECORDINGS_DIR.
const LIBRARY_ROOT = env('LIBRARY_DIR') ? path.resolve(env('LIBRARY_DIR')) : path.join(app.getPath('documents'), LIBRARY);
const IN_PROGRESS = path.join(LIBRARY_ROOT, '.in-progress');

// Where recordings lived before the library existed. Meetings recorded then still
// point at `<meetingId>/screen.webm` under it, so playback falls back to this root
// rather than breaking every recording made before the move.
const LEGACY_ROOT = path.join(app.getPath('userData'), 'recordings');

// A dedicated scheme rather than file://. `<video>` needs HTTP range requests to
// seek, and `net.fetch` over a file URL implements them; serving the file through
// the Rust core would mean hand-writing 206 partial-content support into a server
// whose every response is currently `Connection: close`.
const MEDIA_SCHEME = 'kesami-media';

const streams = new Map();
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
let nextId = 1;
let selectedSourceId = null;

const toPosix = value => value.split(path.sep).join('/');

function meetingDir(meetingId) {
    // Reject invalid ids instead of silently mapping different values to the
    // same recording, which could overwrite or remove another meeting's data.
    if (typeof meetingId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(meetingId)) {
        throw new Error('a recording needs a valid meeting id');
    }
    return path.join(IN_PROGRESS, meetingId);
}

/** Resolve a path from the media scheme, refusing anything outside the root. */
function resolveUnder(root, relativePath) {
    const resolved = path.resolve(root, relativePath);
    const base = path.resolve(root);
    // `startsWith` alone would accept a sibling directory whose name shares the
    // prefix, so the separator has to be part of the comparison.
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
}

function resolveMedia(relativePath) {
    return resolveUnder(LIBRARY_ROOT, relativePath);
}

function resolveLegacyMedia(relativePath) {
    return resolveUnder(LEGACY_ROOT, relativePath);
}

function existingMedia(root, relativePath) {
    const candidate = resolveUnder(root, relativePath);
    if (!candidate) return null;
    try {
        const base = fs.realpathSync(root);
        const resolved = fs.realpathSync(candidate);
        return resolveUnder(base, resolved) && fs.statSync(resolved).isFile() ? resolved : null;
    } catch {
        return null;
    }
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
            privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
        },
    ]);
}

function serveMediaScheme() {
    protocol.handle(MEDIA_SCHEME, request => {
        // kesami-media://recordings/<meetingId>/<file>
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

        const resolved = existingMedia(LIBRARY_ROOT, withoutHost) || existingMedia(LEGACY_ROOT, withoutHost);
        if (!resolved) {
            return new Response('Not found', { status: 404 });
        }
        // net.fetch honours the Range header, which is what makes seeking work.
        return net.fetch(pathToFileURL(resolved).toString(), { headers: request.headers });
    });
}

function registerHandlers(ipc = ipcMain) {
    ipc.handle('recorder:screen-permission', () =>
        process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
    );

    ipc.handle('recorder:list-sources', async () => {
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

    ipc.handle('recorder:select-source', (_event, sourceId) => {
        selectedSourceId = typeof sourceId === 'string' && sourceId ? sourceId : null;
        return { selected: selectedSourceId };
    });

    ipc.handle('recorder:start', async (_event, options = {}) => {
        const dir = meetingDir(options.meetingId);
        await fsp.mkdir(dir, { recursive: true });
        const base = await fsp.realpath(LIBRARY_ROOT);
        if (!resolveUnder(base, await fsp.realpath(dir))) throw new Error('recording directory is outside the library');

        const file = path.join(dir, 'screen.webm');
        // Exclusive creation preserves recoverable recordings after a crash or
        // a duplicate start request. Await opening so disk errors reach the UI.
        const descriptor = await fsp.open(file, 'wx', 0o600);
        try {
            await fsp.writeFile(
                path.join(dir, 'recording.json'),
                JSON.stringify({ meetingId: options.meetingId, mimeType: options.mimeType, startedAtMs: options.startedAtMs }, null, 2),
                { flag: 'wx', mode: 0o600 }
            );
        } catch (cause) {
            await descriptor.close();
            await fsp.rm(file, { force: true });
            throw cause;
        }
        const id = String(nextId++);
        streams.set(id, { id, file, bytes: 0, descriptor, pending: Promise.resolve(), pendingBytes: 0, error: null, closing: false });

        // Always report a URL-shaped path: `path.relative` yields backslashes on
        // Windows, and the media scheme these become part of is not a filesystem
        // path. Converted here rather than in every consumer.
        return { id, path: toPosix(path.relative(LIBRARY_ROOT, file)) };
    });

    ipc.handle('recorder:write-chunk', async (_event, id, chunk) => {
        const handle = streams.get(String(id));
        if (!handle || handle.closing) throw new Error('that recording is not open');
        if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) throw new Error('recording chunk must contain binary data');
        if (chunk.byteLength > MAX_CHUNK_BYTES || handle.pendingBytes + chunk.byteLength > MAX_PENDING_BYTES) {
            throw new Error('recording data exceeded the write buffer limit');
        }
        const buffer = ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(chunk);
        handle.pendingBytes += buffer.byteLength;
        const write = handle.pending.then(async () => {
            if (handle.error) throw handle.error;
            let offset = 0;
            while (offset < buffer.byteLength) {
                const { bytesWritten } = await handle.descriptor.write(buffer, offset, buffer.byteLength - offset);
                if (bytesWritten <= 0) throw new Error('could not write the recording to disk');
                offset += bytesWritten;
                handle.bytes += bytesWritten;
            }
            return { bytes: handle.bytes };
        }).catch(cause => {
            handle.error = cause;
            throw cause;
        }).finally(() => { handle.pendingBytes -= buffer.byteLength; });
        // Keep serialization alive after rejection; every subsequent operation
        // reports the original disk failure instead of waiting forever on drain.
        handle.pending = write.catch(() => {});
        return write;
    });

    ipc.handle('recorder:stop', async (_event, id) => {
        const handle = streams.get(String(id));
        if (!handle) return null;
        return closeRecording(handle);
    });

    ipc.handle('recorder:remove', async (_event, meetingId) => {
        const partial = meetingDir(meetingId);
        if ([...streams.values()].some(handle => path.dirname(handle.file) === partial)) throw new Error('cannot remove an open recording');
        await fsp.rm(partial, { recursive: true, force: true });
        await fsp.rm(path.join(LEGACY_ROOT, path.basename(partial)), { recursive: true, force: true });
        return { removed: true };
    });

    ipc.handle('recorder:usage', async () => ({ bytes: await directorySize(LIBRARY_ROOT) }));
}

/**
 * Hand our chosen source to `getDisplayMedia`, so the app picks the screen in its
 * own UI instead of Chromium's picker.
 *
 * `audio: 'loopback'` is what captures the other participants. Where the platform
 * or build cannot do it the stream simply comes back without an audio track, and
 * the renderer reports that rather than pretending both sides were recorded.
 */
function installDisplayMediaHandler(targetSession = session.defaultSession, isTrustedRequest = () => false) {
    targetSession.setDisplayMediaRequestHandler(
        async (request, callback) => {
            if (!isTrustedRequest(request)) {
                callback({});
                return;
            }
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
    await Promise.allSettled([...streams.values()].map(closeRecording));
}

function closeRecording(handle) {
    if (handle.closed) return handle.closed;
    handle.closing = true;
    handle.closed = (async () => {
        await handle.pending;
        try {
            await handle.descriptor.close();
            if (handle.error) throw handle.error;
            return { path: toPosix(path.relative(LIBRARY_ROOT, handle.file)), bytes: handle.bytes };
        } finally {
            streams.delete(handle.id);
        }
    })();
    return handle.closed;
}

module.exports = {
    MEDIA_SCHEME,
    LIBRARY_ROOT,
    IN_PROGRESS,
    LEGACY_ROOT,
    registerMediaScheme,
    serveMediaScheme,
    registerHandlers,
    installDisplayMediaHandler,
    shutdown,
    _testing: { resolveMedia, resolveLegacyMedia, meetingDir },
};
