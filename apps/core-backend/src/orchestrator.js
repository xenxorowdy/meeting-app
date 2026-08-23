const EventEmitter = require('events');
const crypto = require('crypto');
const { NativeAudioBridge } = require('./audio/nativeBridge');
const { AudioIngestionPipeline } = require('./audio/ingestion');
const { EchoSuppressor } = require('./audio/echoSuppressor');
const { WhisperEngine } = require('./stt/whisperEngine');
const { DiarizerEngine } = require('./diarization/diarizerEngine');
const { SqliteStore } = require('./storage/sqliteStore');
const { ExportUtils, exportToMarkdown, exportToJSON, exportToPlainText, exportToSRT, exportToVTT, exportToSlackMarkdown } = require('./storage/exportUtils');
const { MeetingSummarizer } = require('./ai/summarizer');
const { LicenseManager } = require('./billing/licenseManager');

const SessionState = {
    IDLE: 'IDLE',
    STARTING: 'STARTING',
    RECORDING: 'RECORDING',
    PAUSED: 'PAUSED',
    PROCESSING_STT: 'PROCESSING_STT',
    SUMMARIZING: 'SUMMARIZING',
    COMPLETED: 'COMPLETED',
    ERROR: 'ERROR',
};

/**
 * Central Meeting Session Orchestrator & State Machine.
 */
class MeetingOrchestrator extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            autoSummarizeOnStop: options.autoSummarizeOnStop !== undefined ? options.autoSummarizeOnStop : true,
            storage: options.storage || null,
            licenseManager: options.licenseManager || null,
            ...options,
        };

        this.state = SessionState.IDLE;
        this.currentMeeting = null;
        this.startTime = null;
        this.pauseTime = null;
        this.accumulatedPauseDuration = 0;
        this.inFlightSttJobs = new Set();

        // Subsystems
        this.storage = options.storage || new SqliteStore(options.storageOptions);
        this.licenseManager = options.licenseManager || new LicenseManager(this.storage, options.licenseOptions);
        this.audioBridge = options.audioBridge || new NativeAudioBridge(options.audioBridgeOptions);
        this.ingestionPipeline = options.ingestionPipeline || new AudioIngestionPipeline(options.ingestionOptions);
        this.echoSuppressor = options.echoSuppressor || new EchoSuppressor(options.echoOptions);
        this.whisperEngine = options.whisperEngine || new WhisperEngine(options.sttOptions);
        this.diarizerEngine = options.diarizerEngine || new DiarizerEngine(options.diarizationOptions);
        this.summarizer = options.summarizer || new MeetingSummarizer(options.aiOptions);

        this.isInitialized = false;
        this._bindSubsystemEvents();
    }

    /**
     * Initialize all backend subsystems and storage.
     */
    async initialize() {
        if (this.isInitialized) return this;

        await this.storage.initialize();
        await this.licenseManager.initialize();
        await this.whisperEngine.initialize();

        this.isInitialized = true;
        this.emit('ready', {
            state: this.state,
            license: this.licenseManager.getLicenseStatus(),
            sttBackend: this.whisperEngine.activeBackend,
        });

        return this;
    }

    /**
     * Wire event bindings between subsystems.
     * @private
     */
    _bindSubsystemEvents() {
        // 1. Native Audio Bridge -> Audio Ingestion
        this.audioBridge.on('packet', packet => {
            if (this.state === SessionState.RECORDING) {
                this.ingestionPipeline.ingestPacket(packet);
            }
        });

        // 2. Audio Ingestion -> Audio Level VU Meters (forwarded to UI)
        this.ingestionPipeline.on('audio_level', level => {
            this.emit('audio_level', level);
        });

        // 3. Audio Ingestion -> Speech Segment Emitted
        this.ingestionPipeline.on('speech_segment', async segment => {
            await this._handleSpeechSegment(segment);
        });

        // 4. Diarizer Events -> UI
        this.diarizerEngine.on('speaker_discovered', data => {
            this.emit('speaker_discovered', data);
        });

        this.diarizerEngine.on('speaker_renamed', data => {
            this.emit('speaker_renamed', data);
        });

        // 5. Native Bridge Warnings / Errors
        this.audioBridge.on('warning', w => this.emit('warning', w));
        this.audioBridge.on('error', err => this.emit('error', err));
    }

    /**
     * Start a new meeting recording session.
     * @param {Object} [options]
     * @param {string} [options.title]
     * @param {Object} [options.metadata]
     * @param {string} [options.language]
     * @param {string} [options.sttModel]
     * @returns {Promise<Object>} Meeting session record
     */
    async startMeeting(options = {}) {
        await this.initialize();

        if (this.state === SessionState.RECORDING || this.state === SessionState.PAUSED) {
            throw new Error('A meeting session is already in progress.');
        }

        // Feature & Quota Check
        const canStart = this.licenseManager.canStartMeeting();
        if (!canStart.allowed) {
            const err = new Error(canStart.reason || 'Meeting recording quota exceeded.');
            this.emit('quota_exceeded', canStart);
            throw err;
        }

        this._setState(SessionState.STARTING);

        try {
            const meetingId = crypto.randomUUID();
            const now = Date.now();

            this.currentMeeting = {
                id: meetingId,
                title: options.title || `Meeting ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
                startedAt: now,
                endedAt: null,
                durationSeconds: 0,
                summaryMarkdown: '',
                actionItems: [],
                keyDecisions: [],
                metadata: options.metadata || {},
                createdAt: now,
            };

            // Save initial record in SQLite
            await this.storage.createMeeting(this.currentMeeting);

            // Reset pipelines
            this.diarizerEngine.reset();
            this.echoSuppressor.reset();
            this.inFlightSttJobs.clear();
            this.startTime = now;
            this.pauseTime = null;
            this.accumulatedPauseDuration = 0;

            // Start audio capture
            this.audioBridge.start();
            this.ingestionPipeline.resume();

            this._setState(SessionState.RECORDING);
            this.emit('meeting_started', this.currentMeeting);

            return this.currentMeeting;
        } catch (err) {
            this._setState(SessionState.ERROR);
            this.emit('error', err);
            throw err;
        }
    }

    /**
     * Pause the active meeting recording.
     */
    pauseMeeting() {
        if (this.state !== SessionState.RECORDING) return;

        this.pauseTime = Date.now();
        this.ingestionPipeline.pause();
        this._setState(SessionState.PAUSED);
        this.emit('meeting_paused', { meetingId: this.currentMeeting ? this.currentMeeting.id : null });
    }

    /**
     * Resume a paused meeting.
     */
    resumeMeeting() {
        if (this.state !== SessionState.PAUSED) return;

        if (this.pauseTime) {
            this.accumulatedPauseDuration += (Date.now() - this.pauseTime);
            this.pauseTime = null;
        }

        this.ingestionPipeline.resume();
        this._setState(SessionState.RECORDING);
        this.emit('meeting_resumed', { meetingId: this.currentMeeting ? this.currentMeeting.id : null });
    }

    /**
     * Stop the meeting recording and generate structured AI intelligence notes.
     * @param {Object} [options]
     * @returns {Promise<Object>} Completed meeting with summaries
     */
    async stopMeeting(options = {}) {
        if (this.state !== SessionState.RECORDING && this.state !== SessionState.PAUSED) {
            return this.currentMeeting;
        }

        this._setState(SessionState.PROCESSING_STT);
        this.emit('meeting_stopping', { meetingId: this.currentMeeting.id });

        // 1. Stop audio capture and flush pending speech segments
        this.audioBridge.stop();
        this.ingestionPipeline.flush();

        // 2. Wait for all in-flight STT jobs to complete
        await this._waitForSttJobs();

        // 3. Compute final meeting duration
        const endTime = Date.now();
        const rawDurationMs = endTime - this.startTime - this.accumulatedPauseDuration;
        const durationSeconds = Math.max(1, Math.round(rawDurationMs / 1000));

        this.currentMeeting.endedAt = endTime;
        this.currentMeeting.durationSeconds = durationSeconds;

        const transcriptTurns = this.diarizerEngine.getTimeline();

        // 4. Summarization step
        if (this.options.autoSummarizeOnStop || options.summarize) {
            this._setState(SessionState.SUMMARIZING);
            this.emit('summarizing_started', { meetingId: this.currentMeeting.id });

            try {
                // Optional LLM speaker name resolution
                if (this.licenseManager.isFeatureEnabled('advanced_diarization')) {
                    const genericSpeakers = this.diarizerEngine.getSpeakers().filter(s => s.startsWith('Speaker'));
                    if (genericSpeakers.length > 0) {
                        const nameMapping = await this.summarizer.resolveSpeakerNames(transcriptTurns, genericSpeakers);
                        for (const [oldName, newName] of Object.entries(nameMapping)) {
                            this.diarizerEngine.renameSpeaker(oldName, newName);
                        }
                    }
                }

                // AI Meeting Intelligence Generation
                const summaryResult = await this.summarizer.generateSummary(
                    this.currentMeeting,
                    this.diarizerEngine.getTimeline(),
                    options
                );

                this.currentMeeting.summaryMarkdown = summaryResult.rawMarkdown || '';
                this.currentMeeting.actionItems = summaryResult.actionItems || [];
                this.currentMeeting.keyDecisions = summaryResult.keyDecisions || [];

                // Persist action items in SQLite
                if (summaryResult.actionItems && summaryResult.actionItems.length > 0) {
                    await this.storage.saveActionItems(this.currentMeeting.id, summaryResult.actionItems);
                }
            } catch (sumErr) {
                this.emit('warning', { message: `Summarization warning: ${sumErr.message}` });
            }
        }

        // 5. Update meeting in persistent SQLite storage
        await this.storage.updateMeeting(this.currentMeeting.id, this.currentMeeting);

        // 6. Record usage against license
        await this.licenseManager.recordMeetingUsage(durationSeconds);

        const completedMeeting = { ...this.currentMeeting };
        this.currentMeeting = null;
        this._setState(SessionState.COMPLETED);
        this.emit('meeting_completed', completedMeeting);

        // Transition back to IDLE
        this._setState(SessionState.IDLE);
        return completedMeeting;
    }

    /**
     * Ingest and process an incoming speech segment.
     * @private
     */
    async _handleSpeechSegment(segment) {
        if (!this.currentMeeting) return;
        segment.meetingId = this.currentMeeting.id;

        // Acoustic Echo Suppression Check
        if (segment.channel === 'system') {
            this.echoSuppressor.recordSystemSegment(segment);
        } else if (segment.channel === 'mic') {
            const echoCheck = this.echoSuppressor.filterMicSegment(segment);
            if (echoCheck.isEcho) {
                this.emit('echo_rejected', {
                    segmentId: segment.id,
                    confidence: echoCheck.confidence,
                    reason: echoCheck.reason,
                });
                return;
            }
        }

        // Dispatch to STT Engine
        const jobId = segment.id;
        this.inFlightSttJobs.add(jobId);

        try {
            const transcriptResult = await this.whisperEngine.transcribe(segment);
            if (!transcriptResult || !transcriptResult.text) {
                return;
            }

            // Transcript text duplicate filter
            if (segment.channel === 'system') {
                this.echoSuppressor.recordSystemTranscript(transcriptResult.text, segment.endMs);
            } else if (segment.channel === 'mic') {
                const dupCheck = this.echoSuppressor.isDuplicateTranscript(transcriptResult.text, segment.endMs);
                if (dupCheck.isDuplicate) {
                    this.emit('duplicate_transcript_rejected', {
                        segmentId: segment.id,
                        text: transcriptResult.text,
                        matched: dupCheck.matchedText,
                    });
                    return;
                }
            }

            // Diarize and interleave into timeline
            const turn = this.diarizerEngine.diarizeTurn(segment, transcriptResult);
            if (turn) {
                // Save to SQLite
                await this.storage.addTranscriptTurn(turn);
                this.emit('transcript_turn', turn);
            }
        } catch (err) {
            this.emit('warning', { message: `STT error on segment ${segment.id}: ${err.message}` });
        } finally {
            this.inFlightSttJobs.delete(jobId);
        }
    }

    /**
     * Wait until all pending STT transcription jobs finish.
     * @private
     */
    async _waitForSttJobs(timeoutMs = 15000) {
        const start = Date.now();
        while (this.inFlightSttJobs.size > 0 && (Date.now() - start) < timeoutMs) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    /**
     * Feed external raw audio packet directly into orchestrator.
     * @param {Object} packet
     */
    feedAudioPacket(packet) {
        if (this.state === SessionState.RECORDING) {
            this.ingestionPipeline.ingestPacket(packet);
        }
    }

    /**
     * Get live status and current session stats.
     */
    getLiveStatus() {
        let currentDurationSec = 0;
        if (this.startTime && this.state === SessionState.RECORDING) {
            currentDurationSec = Math.floor((Date.now() - this.startTime - this.accumulatedPauseDuration) / 1000);
        } else if (this.startTime && this.state === SessionState.PAUSED) {
            currentDurationSec = Math.floor((this.pauseTime - this.startTime - this.accumulatedPauseDuration) / 1000);
        }

        return {
            state: this.state,
            currentMeeting: this.currentMeeting ? {
                id: this.currentMeeting.id,
                title: this.currentMeeting.title,
                startedAt: this.currentMeeting.startedAt,
                durationSeconds: currentDurationSec,
            } : null,
            turnsCount: this.diarizerEngine.timelineTurns.length,
            speakersCount: this.diarizerEngine.getSpeakers().length,
            license: this.licenseManager.getLicenseStatus(),
            sttBackend: this.whisperEngine.activeBackend,
            audioStats: this.ingestionPipeline.getStats(),
        };
    }

    /**
     * Export a meeting by ID or current meeting.
     * @param {string} meetingId
     * @param {string} format 'md' | 'json' | 'txt' | 'srt' | 'vtt' | 'slack'
     */
    async exportMeeting(meetingId, format = 'md') {
        const meeting = await this.storage.getMeeting(meetingId);
        if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

        const turns = await this.storage.getTranscriptTurns(meetingId);
        const actionItems = await this.storage.getActionItems(meetingId);

        switch (format.toLowerCase()) {
            case 'json':
                return { mimeType: 'application/json', data: exportToJSON(meeting, turns, actionItems, meeting.keyDecisions) };
            case 'txt':
                return { mimeType: 'text/plain', data: exportToPlainText(meeting, turns) };
            case 'srt':
                return { mimeType: 'text/plain', data: exportToSRT(turns) };
            case 'vtt':
                return { mimeType: 'text/vtt', data: exportToVTT(turns) };
            case 'slack':
                return { mimeType: 'text/markdown', data: exportToSlackMarkdown(meeting, meeting.summaryMarkdown, actionItems) };
            case 'md':
            default:
                return { mimeType: 'text/markdown', data: exportToMarkdown(meeting, turns, actionItems, meeting.keyDecisions) };
        }
    }

    _setState(newState) {
        const oldState = this.state;
        this.state = newState;
        this.emit('state_change', { from: oldState, to: newState });
    }
}

function createOrchestrator(options = {}) {
    return new MeetingOrchestrator(options);
}

module.exports = {
    MeetingOrchestrator,
    createOrchestrator,
    SessionState,
};
