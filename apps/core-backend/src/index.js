/**
 * @alpha/core-backend
 * Commercial Desktop Meeting Assistant Core Engine.
 */

const { NativeAudioBridge, HEADER_SIZE, STREAM_MIC, STREAM_SYSTEM } = require('./audio/nativeBridge');
const { AudioIngestionPipeline } = require('./audio/ingestion');
const { EchoSuppressor } = require('./audio/echoSuppressor');
const { WhisperEngine } = require('./stt/whisperEngine');
const { DiarizerEngine } = require('./diarization/diarizerEngine');
const { SqliteStore } = require('./storage/sqliteStore');
const ExportUtils = require('./storage/exportUtils');
const { MeetingSummarizer } = require('./ai/summarizer');
const { ClaudeCliClient, findClaudeBinary } = require('./ai/claudeCliClient');
const PromptTemplates = require('./ai/promptTemplates');
const { LicenseManager } = require('./billing/licenseManager');
const { MeetingOrchestrator, createOrchestrator, SessionState } = require('./orchestrator');
const { BackendServer, startServer } = require('./server');

module.exports = {
    // Session State Machine & Orchestration
    MeetingOrchestrator,
    createOrchestrator,
    SessionState,

    // Audio Ingestion & Native IPC
    NativeAudioBridge,
    HEADER_SIZE,
    STREAM_MIC,
    STREAM_SYSTEM,
    AudioIngestionPipeline,
    EchoSuppressor,

    // Speech-To-Text
    WhisperEngine,

    // Speaker Diarization
    DiarizerEngine,

    // Persistence & Exports
    SqliteStore,
    ExportUtils,
    exportToMarkdown: ExportUtils.exportToMarkdown,
    exportToJSON: ExportUtils.exportToJSON,
    exportToPlainText: ExportUtils.exportToPlainText,
    exportToSRT: ExportUtils.exportToSRT,
    exportToVTT: ExportUtils.exportToVTT,
    exportToSlackMarkdown: ExportUtils.exportToSlackMarkdown,

    // AI Intelligence & Prompts
    MeetingSummarizer,
    ClaudeCliClient,
    findClaudeBinary,
    PromptTemplates,

    // Billing & Monetization
    LicenseManager,

    // API Server
    BackendServer,
    startServer,
};
