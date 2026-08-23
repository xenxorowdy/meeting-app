const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { MeetingOrchestrator, SessionState } = require('./orchestrator');

/**
 * Core Backend Standalone Server (HTTP REST + WebSocket Streaming).
 */
class BackendServer {
    constructor(options = {}) {
        this.port = options.port || parseInt(process.env.CORE_BACKEND_PORT || process.env.PORT || '48900', 10);
        this.host = options.host || '127.0.0.1';

        this.orchestrator = options.orchestrator || new MeetingOrchestrator(options.orchestratorOptions);
        this.httpServer = null;
        this.wss = null;
        this.clients = new Set();
        this.isRunning = false;
        this.startTime = Date.now();
    }

    /**
     * Start the HTTP and WebSocket API Server.
     */
    async start() {
        if (this.isRunning) return this;

        await this.orchestrator.initialize();

        this.httpServer = http.createServer(this._handleHttpRequest.bind(this));
        this.wss = new WebSocketServer({ server: this.httpServer });

        this._setupWebSocketHandlers();
        this._setupOrchestratorBroadcasts();

        return new Promise((resolve, reject) => {
            this.httpServer.listen(this.port, this.host, () => {
                this.isRunning = true;
                const addr = this.httpServer.address();
                if (addr && typeof addr === 'object') {
                    this.port = addr.port;
                }
                console.log(`[Alpha Core Backend] API Server listening on http://${this.host}:${this.port}`);
                console.log(`[Alpha Core Backend] WebSocket endpoint available at ws://${this.host}:${this.port}`);
                resolve(this);
            });

            this.httpServer.on('error', reject);
        });
    }

    /**
     * Get the active listening port.
     */
    getPort() {
        return this.port;
    }

    /**
     * Stop the server cleanly.
     */
    async stop() {
        this.isRunning = false;

        // Close all WebSocket clients
        for (const client of this.clients) {
            try {
                client.close(1000, 'Server stopping');
            } catch (_) {}
        }
        this.clients.clear();

        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }

        if (this.httpServer) {
            await new Promise(resolve => this.httpServer.close(resolve));
            this.httpServer = null;
        }

        if (this.orchestrator) {
            if (this.orchestrator.state === SessionState.RECORDING) {
                await this.orchestrator.stopMeeting();
            }
            if (this.orchestrator.storage) {
                await this.orchestrator.storage.close();
            }
        }

        console.log('[Alpha Core Backend] Server stopped cleanly.');
    }

    /**
     * HTTP REST Request Router.
     * @private
     */
    async _handleHttpRequest(req, res) {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://${this.host}:${this.port}`);
        const pathname = url.pathname;

        try {
            // Health Check
            if (pathname === '/health' && req.method === 'GET') {
                return this._json(res, 200, {
                    status: 'ok',
                    version: '1.0.0',
                    uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
                    state: this.orchestrator.state,
                });
            }

            // Live Status
            if (pathname === '/api/status' && req.method === 'GET') {
                return this._json(res, 200, this.orchestrator.getLiveStatus());
            }

            // List Meetings
            if (pathname === '/api/meetings' && req.method === 'GET') {
                const search = url.searchParams.get('search') || '';
                const limit = parseInt(url.searchParams.get('limit') || '50', 10);
                const offset = parseInt(url.searchParams.get('offset') || '0', 10);
                const meetings = await this.orchestrator.storage.listMeetings({ search, limit, offset });
                return this._json(res, 200, { meetings });
            }

            // Start Meeting Session
            if (pathname === '/api/meetings/start' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const meeting = await this.orchestrator.startMeeting(body);
                return this._json(res, 200, { success: true, meeting });
            }

            // Pause Meeting Session
            if (pathname === '/api/meetings/pause' && req.method === 'POST') {
                this.orchestrator.pauseMeeting();
                return this._json(res, 200, { success: true, state: this.orchestrator.state });
            }

            // Resume Meeting Session
            if (pathname === '/api/meetings/resume' && req.method === 'POST') {
                this.orchestrator.resumeMeeting();
                return this._json(res, 200, { success: true, state: this.orchestrator.state });
            }

            // Stop Meeting Session
            if (pathname === '/api/meetings/stop' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const meeting = await this.orchestrator.stopMeeting(body);
                return this._json(res, 200, { success: true, meeting });
            }

            // Search Transcripts
            if (pathname === '/api/search' && req.method === 'GET') {
                const q = url.searchParams.get('q') || '';
                const meetingId = url.searchParams.get('meetingId') || null;
                const limit = parseInt(url.searchParams.get('limit') || '50', 10);
                const results = await this.orchestrator.storage.searchTranscripts(q, { meetingId, limit });
                return this._json(res, 200, { results });
            }

            // License Status
            if (pathname === '/api/license/status' && req.method === 'GET') {
                return this._json(res, 200, this.orchestrator.licenseManager.getLicenseStatus());
            }

            // License Activation
            if (pathname === '/api/license/activate' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const result = await this.orchestrator.licenseManager.activateKey(body.licenseKey);
                return this._json(res, result.success ? 200 : 400, result);
            }

            // License Deactivation
            if (pathname === '/api/license/deactivate' && req.method === 'POST') {
                const result = await this.orchestrator.licenseManager.deactivateKey();
                return this._json(res, 200, result);
            }

            // Settings Get/Save
            if (pathname === '/api/settings' && req.method === 'GET') {
                const settings = await this.orchestrator.storage.getSetting('app_settings', {});
                return this._json(res, 200, { settings });
            }
            if (pathname === '/api/settings' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                await this.orchestrator.storage.saveSetting('app_settings', body);
                return this._json(res, 200, { success: true });
            }

            // Parameterized Meeting Routes: /api/meetings/:id, /api/meetings/:id/export, /api/meetings/:id/summarize
            const meetingIdMatch = pathname.match(/^\/api\/meetings\/([a-zA-Z0-9_-]+)(?:\/([a-zA-Z0-9_-]+))?$/);
            if (meetingIdMatch) {
                const meetingId = meetingIdMatch[1];
                const subAction = meetingIdMatch[2];

                if (!subAction && req.method === 'GET') {
                    const meeting = await this.orchestrator.storage.getMeeting(meetingId);
                    if (!meeting) return this._json(res, 404, { error: 'Meeting not found' });
                    const turns = await this.orchestrator.storage.getTranscriptTurns(meetingId);
                    const actionItems = await this.orchestrator.storage.getActionItems(meetingId);
                    return this._json(res, 200, { meeting, transcriptTurns: turns, actionItems });
                }

                if (!subAction && req.method === 'DELETE') {
                    await this.orchestrator.storage.deleteMeeting(meetingId);
                    return this._json(res, 200, { success: true });
                }

                if (subAction === 'export' && req.method === 'GET') {
                    const format = url.searchParams.get('format') || 'md';
                    const exported = await this.orchestrator.exportMeeting(meetingId, format);
                    res.writeHead(200, { 'Content-Type': exported.mimeType });
                    res.end(exported.data);
                    return;
                }

                if (subAction === 'summarize' && req.method === 'POST') {
                    const meeting = await this.orchestrator.storage.getMeeting(meetingId);
                    if (!meeting) return this._json(res, 404, { error: 'Meeting not found' });
                    const turns = await this.orchestrator.storage.getTranscriptTurns(meetingId);
                    const summary = await this.orchestrator.summarizer.generateSummary(meeting, turns);

                    await this.orchestrator.storage.updateMeeting(meetingId, {
                        summaryMarkdown: summary.rawMarkdown,
                        actionItems: summary.actionItems,
                        keyDecisions: summary.keyDecisions,
                    });
                    await this.orchestrator.storage.saveActionItems(meetingId, summary.actionItems);

                    return this._json(res, 200, { success: true, summary });
                }
            }

            // Not found
            this._json(res, 404, { error: 'Not Found' });
        } catch (err) {
            console.error('[API Server Error]', err);
            this._json(res, 500, { error: err.message });
        }
    }

    /**
     * WebSocket Client Connections & Message Handlers.
     * @private
     */
    _setupWebSocketHandlers() {
        this.wss.on('connection', ws => {
            this.clients.add(ws);

            // Send initial connection handshake & state
            ws.send(JSON.stringify({
                type: 'connection_established',
                status: this.orchestrator.getLiveStatus(),
            }));

            ws.on('message', async rawMessage => {
                try {
                    const message = JSON.parse(rawMessage.toString('utf8'));
                    await this._handleWsMessage(ws, message);
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: `Invalid WS message: ${err.message}` }));
                }
            });

            ws.on('close', () => {
                this.clients.delete(ws);
            });

            ws.on('error', () => {
                this.clients.delete(ws);
            });
        });
    }

    /**
     * Handle incoming WebSocket message from frontend UI.
     * @private
     */
    async _handleWsMessage(ws, msg) {
        const { action, payload = {} } = msg;

        switch (action) {
            case 'start_meeting': {
                try {
                    const meeting = await this.orchestrator.startMeeting(payload);
                    ws.send(JSON.stringify({ type: 'meeting_started_ack', meeting }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', error: err.message }));
                }
                break;
            }

            case 'pause_meeting':
                this.orchestrator.pauseMeeting();
                break;

            case 'resume_meeting':
                this.orchestrator.resumeMeeting();
                break;

            case 'stop_meeting': {
                try {
                    const meeting = await this.orchestrator.stopMeeting(payload);
                    ws.send(JSON.stringify({ type: 'meeting_stopped_ack', meeting }));
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', error: err.message }));
                }
                break;
            }

            case 'get_status':
                ws.send(JSON.stringify({ type: 'status_update', status: this.orchestrator.getLiveStatus() }));
                break;

            case 'rename_speaker':
                if (payload.oldName && payload.newName) {
                    this.orchestrator.diarizerEngine.renameSpeaker(payload.oldName, payload.newName);
                }
                break;

            case 'activate_license': {
                const result = await this.orchestrator.licenseManager.activateKey(payload.licenseKey);
                ws.send(JSON.stringify({ type: 'license_result', ...result }));
                break;
            }

            default:
                ws.send(JSON.stringify({ type: 'warning', message: `Unknown action: ${action}` }));
                break;
        }
    }

    /**
     * Forward Orchestrator events to all connected WebSocket clients.
     * @private
     */
    _setupOrchestratorBroadcasts() {
        const broadcast = (type, data) => {
            const payload = JSON.stringify({ type, data, timestamp: Date.now() });
            for (const client of this.clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(payload);
                }
            }
        };

        this.orchestrator.on('state_change', data => broadcast('state_change', data));
        this.orchestrator.on('audio_level', data => broadcast('audio_level', data));
        this.orchestrator.on('speech_segment', data => broadcast('speech_segment', { id: data.id, channel: data.channel }));
        this.orchestrator.on('transcript_turn', data => broadcast('transcript_turn', data));
        this.orchestrator.on('speaker_discovered', data => broadcast('speaker_discovered', data));
        this.orchestrator.on('speaker_renamed', data => broadcast('speaker_renamed', data));
        this.orchestrator.on('meeting_started', data => broadcast('meeting_started', data));
        this.orchestrator.on('meeting_paused', data => broadcast('meeting_paused', data));
        this.orchestrator.on('meeting_resumed', data => broadcast('meeting_resumed', data));
        this.orchestrator.on('meeting_completed', data => broadcast('meeting_completed', data));
        this.orchestrator.on('quota_exceeded', data => broadcast('quota_exceeded', data));
        this.orchestrator.on('warning', data => broadcast('warning', data));
        this.orchestrator.on('error', err => broadcast('error', { message: err.message }));
    }

    _json(res, statusCode, data) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    _parseJsonBody(req) {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
                if (!data) return resolve({});
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Invalid JSON payload'));
                }
            });
            req.on('error', reject);
        });
    }
}

/**
 * Standalone server launcher function.
 */
async function startServer(options = {}) {
    const server = new BackendServer(options);
    await server.start();
    return server;
}

// Auto-run if executed directly as entrypoint
if (require.main === module) {
    const server = new BackendServer();
    server.start().catch(err => {
        console.error('Fatal Server Error:', err);
        process.exit(1);
    });

    const shutdown = async () => {
        console.log('\nShutting down backend server...');
        await server.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = {
    BackendServer,
    startServer,
};
