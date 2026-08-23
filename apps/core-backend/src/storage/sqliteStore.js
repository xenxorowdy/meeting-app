const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/**
 * SQLite Storage Layer with FTS5 Full-Text Search and JSON Fallback.
 */
class SqliteStore {
    constructor(options = {}) {
        const defaultDbDir = path.join(os.homedir(), '.alpha-meeting-assistant');
        this.options = {
            dbPath: options.dbPath || path.join(defaultDbDir, 'meetings.sqlite'),
            driver: options.driver || 'auto', // 'auto' | 'better-sqlite3' | 'sqlite3' | 'fallback'
            ...options,
        };

        this.db = null;
        this.driverType = 'fallback';
        this.isInitialized = false;

        // In-memory / file-backed fallback storage
        this._fallbackData = {
            meetings: new Map(),
            transcriptTurns: new Map(),
            actionItems: new Map(),
            settings: new Map(),
            license: null,
        };
    }

    /**
     * Initialize database connection and schemas.
     */
    async initialize() {
        if (this.isInitialized) return this;

        // Ensure database directory exists
        const dbDir = path.dirname(this.options.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        if (this.options.driver === 'auto' || this.options.driver === 'better-sqlite3') {
            try {
                const Database = require('better-sqlite3');
                this.db = new Database(this.options.dbPath);
                this.driverType = 'better-sqlite3';
                this._initTablesBetterSqlite();
                this.isInitialized = true;
                return this;
            } catch (_) {}
        }

        if (this.options.driver === 'auto' || this.options.driver === 'sqlite3') {
            try {
                const sqlite3 = require('sqlite3').verbose();
                this.db = new sqlite3.Database(this.options.dbPath);
                this.driverType = 'sqlite3';
                await this._initTablesSqlite3();
                this.isInitialized = true;
                return this;
            } catch (_) {}
        }

        // Persistent JSON store fallback
        this.driverType = 'fallback';
        this.fallbackFilePath = this.options.dbPath.endsWith('.sqlite')
            ? this.options.dbPath.replace('.sqlite', '.json')
            : this.options.dbPath + '.json';
        this._loadFallbackData();
        this.isInitialized = true;

        return this;
    }

    /**
     * Better-sqlite3 Table Schema Initialization.
     * @private
     */
    _initTablesBetterSqlite() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                duration_seconds INTEGER DEFAULT 0,
                summary_markdown TEXT,
                action_items_json TEXT,
                key_decisions_json TEXT,
                metadata_json TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transcript_turns (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                channel TEXT NOT NULL,
                speaker TEXT NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                text TEXT NOT NULL,
                confidence REAL DEFAULT 1.0,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_turns_meeting_id ON transcript_turns(meeting_id);
            CREATE INDEX IF NOT EXISTS idx_turns_start_ms ON transcript_turns(start_ms);

            CREATE TABLE IF NOT EXISTS action_items (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                task TEXT NOT NULL,
                owner TEXT,
                deadline TEXT,
                status TEXT DEFAULT 'pending',
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS licenses (
                id TEXT PRIMARY KEY,
                license_key TEXT NOT NULL,
                tier TEXT NOT NULL,
                status TEXT NOT NULL,
                activated_at INTEGER NOT NULL,
                expires_at INTEGER,
                usage_stats_json TEXT
            );
        `);

        // Try creating FTS5 table
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
                    meeting_id UNINDEXED,
                    speaker,
                    text,
                    content='transcript_turns',
                    content_rowid='rowid'
                );

                CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON transcript_turns BEGIN
                    INSERT INTO transcripts_fts(rowid, meeting_id, speaker, text)
                    VALUES (new.rowid, new.meeting_id, new.speaker, new.text);
                END;

                CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON transcript_turns BEGIN
                    INSERT INTO transcripts_fts(transcripts_fts, rowid, meeting_id, speaker, text)
                    VALUES('delete', old.rowid, old.meeting_id, old.speaker, old.text);
                END;
            `);
        } catch (_) {}
    }

    /**
     * sqlite3 Driver Schema Initialization.
     * @private
     */
    _initTablesSqlite3() {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS meetings (
                        id TEXT PRIMARY KEY,
                        title TEXT NOT NULL,
                        started_at INTEGER NOT NULL,
                        ended_at INTEGER,
                        duration_seconds INTEGER DEFAULT 0,
                        summary_markdown TEXT,
                        action_items_json TEXT,
                        key_decisions_json TEXT,
                        metadata_json TEXT,
                        created_at INTEGER NOT NULL
                    )
                `);
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS transcript_turns (
                        id TEXT PRIMARY KEY,
                        meeting_id TEXT NOT NULL,
                        channel TEXT NOT NULL,
                        speaker TEXT NOT NULL,
                        start_ms INTEGER NOT NULL,
                        end_ms INTEGER NOT NULL,
                        text TEXT NOT NULL,
                        confidence REAL DEFAULT 1.0,
                        created_at INTEGER NOT NULL
                    )
                `);
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS action_items (
                        id TEXT PRIMARY KEY,
                        meeting_id TEXT NOT NULL,
                        task TEXT NOT NULL,
                        owner TEXT,
                        deadline TEXT,
                        status TEXT DEFAULT 'pending',
                        created_at INTEGER NOT NULL
                    )
                `);
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS settings (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL,
                        updated_at INTEGER NOT NULL
                    )
                `);
                this.db.run(`
                    CREATE TABLE IF NOT EXISTS licenses (
                        id TEXT PRIMARY KEY,
                        license_key TEXT NOT NULL,
                        tier TEXT NOT NULL,
                        status TEXT NOT NULL,
                        activated_at INTEGER NOT NULL,
                        expires_at INTEGER,
                        usage_stats_json TEXT
                    )
                `, err => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    }

    /* ------------------------------------------------------------- */
    /* MEETINGS CRUD                                                */
    /* ------------------------------------------------------------- */

    async createMeeting(meeting) {
        await this.initialize();
        const record = {
            id: meeting.id || crypto.randomUUID(),
            title: meeting.title || `Meeting ${new Date().toLocaleDateString()}`,
            started_at: meeting.startedAt || meeting.started_at || Date.now(),
            ended_at: meeting.endedAt || meeting.ended_at || null,
            duration_seconds: meeting.durationSeconds || meeting.duration_seconds || 0,
            summary_markdown: meeting.summaryMarkdown || meeting.summary_markdown || '',
            action_items_json: JSON.stringify(meeting.actionItems || []),
            key_decisions_json: JSON.stringify(meeting.keyDecisions || []),
            metadata_json: JSON.stringify(meeting.metadata || {}),
            created_at: Date.now(),
        };

        if (this.driverType === 'better-sqlite3') {
            const stmt = this.db.prepare(`
                INSERT INTO meetings (id, title, started_at, ended_at, duration_seconds, summary_markdown, action_items_json, key_decisions_json, metadata_json, created_at)
                VALUES (@id, @title, @started_at, @ended_at, @duration_seconds, @summary_markdown, @action_items_json, @key_decisions_json, @metadata_json, @created_at)
            `);
            stmt.run(record);
            return record;
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                const query = `
                    INSERT INTO meetings (id, title, started_at, ended_at, duration_seconds, summary_markdown, action_items_json, key_decisions_json, metadata_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;
                this.db.run(query, [
                    record.id, record.title, record.started_at, record.ended_at, record.duration_seconds,
                    record.summary_markdown, record.action_items_json, record.key_decisions_json, record.metadata_json, record.created_at,
                ], err => {
                    if (err) reject(err);
                    else resolve(record);
                });
            });
        }

        // Fallback
        this._fallbackData.meetings.set(record.id, record);
        this._saveFallbackData();
        return record;
    }

    async updateMeeting(id, updates) {
        await this.initialize();
        const existing = await this.getMeeting(id);
        if (!existing) return null;

        const merged = {
            title: updates.title !== undefined ? updates.title : existing.title,
            ended_at: updates.endedAt !== undefined ? updates.endedAt : (updates.ended_at !== undefined ? updates.ended_at : existing.ended_at),
            duration_seconds: updates.durationSeconds !== undefined ? updates.durationSeconds : (updates.duration_seconds !== undefined ? updates.duration_seconds : existing.duration_seconds),
            summary_markdown: updates.summaryMarkdown !== undefined ? updates.summaryMarkdown : (updates.summary_markdown !== undefined ? updates.summary_markdown : existing.summary_markdown),
            action_items_json: updates.actionItems ? JSON.stringify(updates.actionItems) : (updates.action_items_json || existing.action_items_json),
            key_decisions_json: updates.keyDecisions ? JSON.stringify(updates.keyDecisions) : (updates.key_decisions_json || existing.key_decisions_json),
            metadata_json: updates.metadata ? JSON.stringify(updates.metadata) : (updates.metadata_json || existing.metadata_json),
        };

        if (this.driverType === 'better-sqlite3') {
            const stmt = this.db.prepare(`
                UPDATE meetings
                SET title = ?, ended_at = ?, duration_seconds = ?, summary_markdown = ?, action_items_json = ?, key_decisions_json = ?, metadata_json = ?
                WHERE id = ?
            `);
            stmt.run(merged.title, merged.ended_at, merged.duration_seconds, merged.summary_markdown, merged.action_items_json, merged.key_decisions_json, merged.metadata_json, id);
            return this.getMeeting(id);
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                const query = `
                    UPDATE meetings
                    SET title = ?, ended_at = ?, duration_seconds = ?, summary_markdown = ?, action_items_json = ?, key_decisions_json = ?, metadata_json = ?
                    WHERE id = ?
                `;
                this.db.run(query, [
                    merged.title, merged.ended_at, merged.duration_seconds, merged.summary_markdown, merged.action_items_json, merged.key_decisions_json, merged.metadata_json, id,
                ], err => {
                    if (err) reject(err);
                    else resolve(this.getMeeting(id));
                });
            });
        }

        // Fallback
        const updated = { ...existing, ...merged };
        this._fallbackData.meetings.set(id, updated);
        this._saveFallbackData();
        return this._formatMeetingRecord(updated);
    }

    async getMeeting(id) {
        await this.initialize();

        if (this.driverType === 'better-sqlite3') {
            const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
            return row ? this._formatMeetingRecord(row) : null;
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                this.db.get('SELECT * FROM meetings WHERE id = ?', [id], (err, row) => {
                    if (err) reject(err);
                    else resolve(row ? this._formatMeetingRecord(row) : null);
                });
            });
        }

        // Fallback
        const rec = this._fallbackData.meetings.get(id);
        return rec ? this._formatMeetingRecord(rec) : null;
    }

    async listMeetings(options = {}) {
        await this.initialize();
        const limit = options.limit || 50;
        const offset = options.offset || 0;
        const search = options.search ? options.search.trim().toLowerCase() : null;

        if (this.driverType === 'better-sqlite3') {
            let rows;
            if (search) {
                rows = this.db.prepare(`
                    SELECT * FROM meetings
                    WHERE title LIKE ? OR summary_markdown LIKE ?
                    ORDER BY started_at DESC
                    LIMIT ? OFFSET ?
                `).all(`%${search}%`, `%${search}%`, limit, offset);
            } else {
                rows = this.db.prepare(`
                    SELECT * FROM meetings
                    ORDER BY started_at DESC
                    LIMIT ? OFFSET ?
                `).all(limit, offset);
            }
            return rows.map(r => this._formatMeetingRecord(r));
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                let query = 'SELECT * FROM meetings ORDER BY started_at DESC LIMIT ? OFFSET ?';
                let params = [limit, offset];

                if (search) {
                    query = 'SELECT * FROM meetings WHERE title LIKE ? OR summary_markdown LIKE ? ORDER BY started_at DESC LIMIT ? OFFSET ?';
                    params = [`%${search}%`, `%${search}%`, limit, offset];
                }

                this.db.all(query, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve((rows || []).map(r => this._formatMeetingRecord(r)));
                });
            });
        }

        // Fallback
        let items = Array.from(this._fallbackData.meetings.values());
        if (search) {
            items = items.filter(m =>
                (m.title && m.title.toLowerCase().includes(search)) ||
                (m.summary_markdown && m.summary_markdown.toLowerCase().includes(search))
            );
        }
        items.sort((a, b) => b.started_at - a.started_at);
        const sliced = items.slice(offset, offset + limit);
        return sliced.map(r => this._formatMeetingRecord(r));
    }

    async deleteMeeting(id) {
        await this.initialize();

        if (this.driverType === 'better-sqlite3') {
            this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
            this.db.prepare('DELETE FROM transcript_turns WHERE meeting_id = ?').run(id);
            this.db.prepare('DELETE FROM action_items WHERE meeting_id = ?').run(id);
            return true;
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                this.db.run('DELETE FROM meetings WHERE id = ?', [id], err => {
                    if (err) return reject(err);
                    this.db.run('DELETE FROM transcript_turns WHERE meeting_id = ?', [id], () => {
                        this.db.run('DELETE FROM action_items WHERE meeting_id = ?', [id], () => resolve(true));
                    });
                });
            });
        }

        // Fallback
        this._fallbackData.meetings.delete(id);
        for (const [turnId, turn] of this._fallbackData.transcriptTurns.entries()) {
            if (turn.meeting_id === id) this._fallbackData.transcriptTurns.delete(turnId);
        }
        for (const [itemId, item] of this._fallbackData.actionItems.entries()) {
            if (item.meeting_id === id) this._fallbackData.actionItems.delete(itemId);
        }
        this._saveFallbackData();
        return true;
    }

    /* ------------------------------------------------------------- */
    /* TRANSCRIPT TURNS                                             */
    /* ------------------------------------------------------------- */

    async addTranscriptTurn(turn) {
        await this.initialize();
        const record = {
            id: turn.id || crypto.randomUUID(),
            meeting_id: turn.meetingId || turn.meeting_id,
            channel: turn.channel || 'mic',
            speaker: turn.speaker || 'Speaker',
            start_ms: turn.startMs !== undefined ? turn.startMs : (turn.start_ms || 0),
            end_ms: turn.endMs !== undefined ? turn.endMs : (turn.end_ms || 0),
            text: turn.text || '',
            confidence: turn.confidence !== undefined ? turn.confidence : 1.0,
            created_at: Date.now(),
        };

        if (this.driverType === 'better-sqlite3') {
            const stmt = this.db.prepare(`
                INSERT INTO transcript_turns (id, meeting_id, channel, speaker, start_ms, end_ms, text, confidence, created_at)
                VALUES (@id, @meeting_id, @channel, @speaker, @start_ms, @end_ms, @text, @confidence, @created_at)
            `);
            stmt.run(record);
            return record;
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                const query = `
                    INSERT INTO transcript_turns (id, meeting_id, channel, speaker, start_ms, end_ms, text, confidence, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `;
                this.db.run(query, [
                    record.id, record.meeting_id, record.channel, record.speaker,
                    record.start_ms, record.end_ms, record.text, record.confidence, record.created_at,
                ], err => {
                    if (err) reject(err);
                    else resolve(record);
                });
            });
        }

        // Fallback
        this._fallbackData.transcriptTurns.set(record.id, record);
        this._saveFallbackData();
        return record;
    }

    async getTranscriptTurns(meetingId) {
        await this.initialize();

        if (this.driverType === 'better-sqlite3') {
            const rows = this.db.prepare(`
                SELECT * FROM transcript_turns
                WHERE meeting_id = ?
                ORDER BY start_ms ASC
            `).all(meetingId);
            return rows.map(r => this._formatTurnRecord(r));
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                this.db.all(`
                    SELECT * FROM transcript_turns
                    WHERE meeting_id = ?
                    ORDER BY start_ms ASC
                `, [meetingId], (err, rows) => {
                    if (err) reject(err);
                    else resolve((rows || []).map(r => this._formatTurnRecord(r)));
                });
            });
        }

        // Fallback
        const turns = [];
        for (const turn of this._fallbackData.transcriptTurns.values()) {
            if (turn.meeting_id === meetingId) {
                turns.push(this._formatTurnRecord(turn));
            }
        }
        turns.sort((a, b) => a.startMs - b.startMs);
        return turns;
    }

    async searchTranscripts(query, options = {}) {
        await this.initialize();
        const limit = options.limit || 50;
        const meetingId = options.meetingId || null;

        if (this.driverType === 'better-sqlite3') {
            try {
                // Try FTS query
                const sql = meetingId
                    ? `SELECT t.* FROM transcript_turns t
                       JOIN transcripts_fts f ON t.rowid = f.rowid
                       WHERE transcripts_fts MATCH ? AND t.meeting_id = ?
                       ORDER BY t.start_ms ASC LIMIT ?`
                    : `SELECT t.* FROM transcript_turns t
                       JOIN transcripts_fts f ON t.rowid = f.rowid
                       WHERE transcripts_fts MATCH ?
                       ORDER BY t.created_at DESC LIMIT ?`;
                const params = meetingId ? [query, meetingId, limit] : [query, limit];
                const rows = this.db.prepare(sql).all(...params);
                return rows.map(r => this._formatTurnRecord(r));
            } catch (_) {
                // Fallback to LIKE
                const sql = meetingId
                    ? `SELECT * FROM transcript_turns WHERE text LIKE ? AND meeting_id = ? ORDER BY start_ms ASC LIMIT ?`
                    : `SELECT * FROM transcript_turns WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`;
                const params = meetingId ? [`%${query}%`, meetingId, limit] : [`%${query}%`, limit];
                const rows = this.db.prepare(sql).all(...params);
                return rows.map(r => this._formatTurnRecord(r));
            }
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                const sql = meetingId
                    ? `SELECT * FROM transcript_turns WHERE text LIKE ? AND meeting_id = ? ORDER BY start_ms ASC LIMIT ?`
                    : `SELECT * FROM transcript_turns WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?`;
                const params = meetingId ? [`%${query}%`, meetingId, limit] : [`%${query}%`, limit];
                this.db.all(sql, params, (err, rows) => {
                    if (err) reject(err);
                    else resolve((rows || []).map(r => this._formatTurnRecord(r)));
                });
            });
        }

        // Fallback
        const q = query.toLowerCase();
        const results = [];
        for (const turn of this._fallbackData.transcriptTurns.values()) {
            if (meetingId && turn.meeting_id !== meetingId) continue;
            if (turn.text && turn.text.toLowerCase().includes(q)) {
                results.push(this._formatTurnRecord(turn));
            }
        }
        return results.slice(0, limit);
    }

    /* ------------------------------------------------------------- */
    /* ACTION ITEMS                                                 */
    /* ------------------------------------------------------------- */

    async saveActionItems(meetingId, items = []) {
        await this.initialize();
        const saved = [];

        for (const it of items) {
            const itemRecord = {
                id: it.id || crypto.randomUUID(),
                meeting_id: meetingId,
                task: it.task || it.text || '',
                owner: it.owner || 'Unassigned',
                deadline: it.deadline || null,
                status: it.status || 'pending',
                created_at: Date.now(),
            };

            if (this.driverType === 'better-sqlite3') {
                this.db.prepare(`
                    INSERT OR REPLACE INTO action_items (id, meeting_id, task, owner, deadline, status, created_at)
                    VALUES (@id, @meeting_id, @task, @owner, @deadline, @status, @created_at)
                `).run(itemRecord);
            } else if (this.driverType === 'sqlite3') {
                await new Promise(resolve => {
                    this.db.run(`
                        INSERT OR REPLACE INTO action_items (id, meeting_id, task, owner, deadline, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    `, [itemRecord.id, itemRecord.meeting_id, itemRecord.task, itemRecord.owner, itemRecord.deadline, itemRecord.status, itemRecord.created_at], resolve);
                });
            } else {
                this._fallbackData.actionItems.set(itemRecord.id, itemRecord);
            }

            saved.push(itemRecord);
        }

        if (this.driverType === 'fallback') {
            this._saveFallbackData();
        }

        return saved;
    }

    async getActionItems(meetingId) {
        await this.initialize();

        if (this.driverType === 'better-sqlite3') {
            return this.db.prepare('SELECT * FROM action_items WHERE meeting_id = ?').all(meetingId);
        }

        if (this.driverType === 'sqlite3') {
            return new Promise((resolve, reject) => {
                this.db.all('SELECT * FROM action_items WHERE meeting_id = ?', [meetingId], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                });
            });
        }

        const items = [];
        for (const it of this._fallbackData.actionItems.values()) {
            if (it.meeting_id === meetingId) items.push(it);
        }
        return items;
    }

    /* ------------------------------------------------------------- */
    /* SETTINGS & LICENSE                                           */
    /* ------------------------------------------------------------- */

    async saveSetting(key, value) {
        await this.initialize();
        const strVal = typeof value === 'string' ? value : JSON.stringify(value);
        const now = Date.now();

        if (this.driverType === 'better-sqlite3') {
            this.db.prepare(`
                INSERT OR REPLACE INTO settings (key, value, updated_at)
                VALUES (?, ?, ?)
            `).run(key, strVal, now);
            return true;
        }

        if (this.driverType === 'sqlite3') {
            return new Promise(resolve => {
                this.db.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [key, strVal, now], () => resolve(true));
            });
        }

        this._fallbackData.settings.set(key, { value: strVal, updated_at: now });
        this._saveFallbackData();
        return true;
    }

    async getSetting(key, defaultValue = null) {
        await this.initialize();

        if (this.driverType === 'better-sqlite3') {
            const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
            if (!row) return defaultValue;
            try { return JSON.parse(row.value); } catch (_) { return row.value; }
        }

        if (this.driverType === 'sqlite3') {
            return new Promise(resolve => {
                this.db.get('SELECT value FROM settings WHERE key = ?', [key], (err, row) => {
                    if (err || !row) return resolve(defaultValue);
                    try { resolve(JSON.parse(row.value)); } catch (_) { resolve(row.value); }
                });
            });
        }

        const rec = this._fallbackData.settings.get(key);
        if (!rec) return defaultValue;
        try { return JSON.parse(rec.value); } catch (_) { return rec.value; }
    }

    /* ------------------------------------------------------------- */
    /* FORMATTERS & FALLBACK HELPERS                                */
    /* ------------------------------------------------------------- */

    _formatMeetingRecord(row) {
        let actionItems = [];
        let keyDecisions = [];
        let metadata = {};

        try { actionItems = JSON.parse(row.action_items_json || '[]'); } catch (_) {}
        try { keyDecisions = JSON.parse(row.key_decisions_json || '[]'); } catch (_) {}
        try { metadata = JSON.parse(row.metadata_json || '{}'); } catch (_) {}

        return {
            id: row.id,
            title: row.title,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            durationSeconds: row.duration_seconds,
            summaryMarkdown: row.summary_markdown,
            actionItems,
            keyDecisions,
            metadata,
            createdAt: row.created_at,
        };
    }

    _formatTurnRecord(row) {
        return {
            id: row.id,
            meetingId: row.meeting_id,
            channel: row.channel,
            speaker: row.speaker,
            startMs: row.start_ms,
            endMs: row.end_ms,
            text: row.text,
            confidence: row.confidence,
            createdAt: row.created_at,
        };
    }

    _loadFallbackData() {
        if (fs.existsSync(this.fallbackFilePath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.fallbackFilePath, 'utf8'));
                if (raw.meetings) {
                    for (const m of raw.meetings) this._fallbackData.meetings.set(m.id, m);
                }
                if (raw.transcriptTurns) {
                    for (const t of raw.transcriptTurns) this._fallbackData.transcriptTurns.set(t.id, t);
                }
                if (raw.actionItems) {
                    for (const a of raw.actionItems) this._fallbackData.actionItems.set(a.id, a);
                }
                if (raw.settings) {
                    for (const [k, v] of Object.entries(raw.settings)) this._fallbackData.settings.set(k, v);
                }
            } catch (_) {}
        }
    }

    _saveFallbackData() {
        try {
            const data = {
                meetings: Array.from(this._fallbackData.meetings.values()),
                transcriptTurns: Array.from(this._fallbackData.transcriptTurns.values()),
                actionItems: Array.from(this._fallbackData.actionItems.values()),
                settings: Object.fromEntries(this._fallbackData.settings.entries()),
            };
            fs.writeFileSync(this.fallbackFilePath, JSON.stringify(data, null, 2));
        } catch (_) {}
    }

    async close() {
        if (this.db) {
            if (this.driverType === 'better-sqlite3') {
                this.db.close();
            } else if (this.driverType === 'sqlite3') {
                this.db.close();
            }
            this.db = null;
        }
        this.isInitialized = false;
    }
}

module.exports = {
    SqliteStore,
};
