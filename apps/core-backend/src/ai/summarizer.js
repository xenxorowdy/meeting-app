const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { ClaudeCliClient } = require('./claudeCliClient');
const {
    SUMMARIZATION_SYSTEM_PROMPT,
    NAME_RESOLUTION_SYSTEM_PROMPT,
    ACTION_ITEM_EXTRACTION_PROMPT,
    QUICK_INSIGHT_PROMPT,
    buildSummarizationUserPrompt,
    buildNameResolutionUserPrompt,
} = require('./promptTemplates');

/**
 * AI Summarization & Note Generation Engine.
 * Supports the Claude Code CLI (no API key needed), the Anthropic API, OpenAI GPT-4o,
 * Local Ollama, and an offline rule-based heuristic fallback.
 */
class MeetingSummarizer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            provider: options.provider || 'auto', // 'auto' | 'claude-cli' | 'claude' | 'openai' | 'ollama' | 'offline'
            anthropicApiKey: options.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null,
            anthropicModel: options.anthropicModel || 'claude-3-5-sonnet-20241022',
            openaiApiKey: options.openaiApiKey || process.env.OPENAI_API_KEY || null,
            openaiModel: options.openaiModel || 'gpt-4o',
            ollamaEndpoint: options.ollamaEndpoint || 'http://localhost:11434',
            ollamaModel: options.ollamaModel || 'llama3:latest',
            claudeCliModel: options.claudeCliModel || process.env.ALPHA_SUMMARY_MODEL || 'sonnet',
            claudeCliBinary: options.claudeCliBinary || null,
            claudeCliTimeoutMs: options.claudeCliTimeoutMs || null,
            ...options,
        };

        this.claudeCli =
            options.claudeCliClient ||
            new ClaudeCliClient({
                binaryPath: this.options.claudeCliBinary,
                model: this.options.claudeCliModel,
                timeoutMs: this.options.claudeCliTimeoutMs || undefined,
            });
    }

    /**
     * Generate complete post-meeting summary, decisions, action items, and follow-up email.
     * @param {Object} meeting
     * @param {Array} transcriptTurns
     * @param {Object} [overrideOptions]
     * @returns {Promise<{ executiveSummary: string, keyDecisions: string[], actionItems: Array, followUpEmail: Object, topics: string[], rawMarkdown: string, provider: string }>}
     */
    async generateSummary(meeting = {}, transcriptTurns = [], overrideOptions = {}) {
        const opts = { ...this.options, ...overrideOptions };
        const provider = this._resolveProvider(opts);
        const userPrompt = buildSummarizationUserPrompt(meeting, transcriptTurns);

        this.emit('summarization_started', { provider, turnCount: transcriptTurns.length });

        try {
            let responseText = '';

            if (provider === 'claude-cli') {
                responseText = await this._callClaudeCli(SUMMARIZATION_SYSTEM_PROMPT, userPrompt, opts);
            } else if (provider === 'claude') {
                responseText = await this._callClaude(SUMMARIZATION_SYSTEM_PROMPT, userPrompt, opts);
            } else if (provider === 'openai') {
                responseText = await this._callOpenAI(SUMMARIZATION_SYSTEM_PROMPT, userPrompt, opts);
            } else if (provider === 'ollama') {
                responseText = await this._callOllama(SUMMARIZATION_SYSTEM_PROMPT, userPrompt, opts);
            } else {
                // Offline heuristic fallback
                return this._generateOfflineSummary(meeting, transcriptTurns);
            }

            const parsed = this._extractStructuredData(responseText, meeting, transcriptTurns, provider);
            this.emit('summarization_completed', { provider, summary: parsed });
            return parsed;
        } catch (err) {
            this.emit('warning', {
                message: `Provider ${provider} summarization failed: ${err.message}. Using offline heuristic fallback.`,
            });
            return this._generateOfflineSummary(meeting, transcriptTurns);
        }
    }

    /**
     * Resolve generic speaker tags ("Speaker 1") to real names using LLM.
     * @param {Array} transcriptTurns
     * @param {Array} currentSpeakers
     * @param {Object} [overrideOptions]
     * @returns {Promise<Object>} Map of { "Speaker 1": "Sarah" }
     */
    async resolveSpeakerNames(transcriptTurns = [], currentSpeakers = [], overrideOptions = {}) {
        if (!transcriptTurns || transcriptTurns.length === 0 || currentSpeakers.length === 0) {
            return {};
        }

        const opts = { ...this.options, ...overrideOptions };
        const provider = this._resolveProvider(opts);
        const userPrompt = buildNameResolutionUserPrompt(transcriptTurns, currentSpeakers);

        try {
            let responseText = '';
            if (provider === 'claude-cli') {
                responseText = await this._callClaudeCli(NAME_RESOLUTION_SYSTEM_PROMPT, userPrompt, opts);
            } else if (provider === 'claude') {
                responseText = await this._callClaude(NAME_RESOLUTION_SYSTEM_PROMPT, userPrompt, opts);
            } else if (provider === 'openai') {
                responseText = await this._callOpenAI(NAME_RESOLUTION_SYSTEM_PROMPT, userPrompt, opts);
            } else if (provider === 'ollama') {
                responseText = await this._callOllama(NAME_RESOLUTION_SYSTEM_PROMPT, userPrompt, opts);
            } else {
                return {};
            }

            // Parse JSON block from response
            const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return {};
        } catch (_) {
            return {};
        }
    }

    /**
     * Resolve active AI provider based on configuration & available API keys.
     * @private
     */
    _resolveProvider(opts) {
        if (opts.provider && opts.provider !== 'auto') {
            return opts.provider;
        }

        if (opts.anthropicApiKey) return 'claude';
        if (opts.openaiApiKey) return 'openai';
        if (this.claudeCli && this.claudeCli.isAvailable()) return 'claude-cli';
        return 'offline';
    }

    async _callClaudeCli(systemPrompt, userPrompt, opts = {}) {
        const result = await this.claudeCli.run({
            instruction: userPrompt,
            systemPrompt,
            model: opts.claudeCliModel || null,
            timeoutMs: opts.claudeCliTimeoutMs || null,
        });
        return result.text;
    }

    /**
     * Call Anthropic Claude API.
     * @private
     */
    async _callClaude(systemPrompt, userPrompt, opts) {
        const apiKey = opts.anthropicApiKey || this.options.anthropicApiKey;
        const model = opts.anthropicModel || 'claude-3-5-sonnet-20241022';

        const payload = JSON.stringify({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
        });

        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: 'api.anthropic.com',
                    port: 443,
                    path: '/v1/messages',
                    method: 'POST',
                    headers: {
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                },
                res => {
                    let data = '';
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                const parsed = JSON.parse(data);
                                const text = parsed.content && parsed.content[0] ? parsed.content[0].text : '';
                                resolve(text);
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new Error(`Claude API Error ${res.statusCode}: ${data}`));
                        }
                    });
                }
            );

            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    /**
     * Call OpenAI Chat Completion API.
     * @private
     */
    async _callOpenAI(systemPrompt, userPrompt, opts) {
        const apiKey = opts.openaiApiKey || this.options.openaiApiKey;
        const model = opts.openaiModel || 'gpt-4o';

        const payload = JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
        });

        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: 'api.openai.com',
                    port: 443,
                    path: '/v1/chat/completions',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                },
                res => {
                    let data = '';
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                const parsed = JSON.parse(data);
                                const text = parsed.choices && parsed.choices[0] ? parsed.choices[0].message.content : '';
                                resolve(text);
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new Error(`OpenAI API Error ${res.statusCode}: ${data}`));
                        }
                    });
                }
            );

            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    /**
     * Call Local Ollama instance.
     * @private
     */
    async _callOllama(systemPrompt, userPrompt, opts) {
        const endpoint = new URL(opts.ollamaEndpoint || this.options.ollamaEndpoint);
        const model = opts.ollamaModel || 'llama3:latest';

        const payload = JSON.stringify({
            model,
            prompt: `${systemPrompt}\n\n${userPrompt}`,
            stream: false,
        });

        return new Promise((resolve, reject) => {
            const client = endpoint.protocol === 'https:' ? https : http;
            const req = client.request(
                {
                    hostname: endpoint.hostname,
                    port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 11434),
                    path: '/api/generate',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                },
                res => {
                    let data = '';
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                const parsed = JSON.parse(data);
                                resolve(parsed.response || '');
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new Error(`Ollama Error ${res.statusCode}: ${data}`));
                        }
                    });
                }
            );

            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    /**
     * Parse structured JSON and Markdown from LLM output.
     * @private
     */
    _extractStructuredData(rawMarkdown, meeting, transcriptTurns, provider) {
        let jsonBlock = null;
        const jsonMatch = rawMarkdown.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) {
            try {
                jsonBlock = JSON.parse(jsonMatch[1]);
            } catch (_) {}
        }

        const executiveSummary =
            jsonBlock && jsonBlock.executiveSummary
                ? jsonBlock.executiveSummary
                : this._extractSection(rawMarkdown, 'Executive Summary') || 'Meeting completed successfully.';

        const keyDecisions =
            jsonBlock && Array.isArray(jsonBlock.keyDecisions) ? jsonBlock.keyDecisions : this._extractBulletItems(rawMarkdown, 'Key Decisions');

        const actionItems =
            jsonBlock && Array.isArray(jsonBlock.actionItems) ? jsonBlock.actionItems : this._extractActionItemsFromMarkdown(rawMarkdown);

        const followUpEmail =
            jsonBlock && jsonBlock.followUpEmail
                ? jsonBlock.followUpEmail
                : {
                      subject: `Follow-up: ${meeting.title || 'Meeting Summary'}`,
                      body: `Hi team,\n\nHere is a summary of our meeting discussion and next steps.\n\nBest regards,\n${meeting.author || 'Alpha Assistant'}`,
                  };

        const topics =
            jsonBlock && Array.isArray(jsonBlock.topics)
                ? jsonBlock.topics
                : this._extractBulletItems(rawMarkdown, 'Key Discussion Topics & Insights');

        return {
            executiveSummary,
            keyDecisions,
            actionItems,
            followUpEmail,
            topics,
            rawMarkdown,
            provider: provider || this.options.provider || 'claude',
        };
    }

    /**
     * Offline Heuristic Rule-Based Summarizer.
     * Generates summaries using pattern extraction when no cloud API is available.
     * @private
     */
    _generateOfflineSummary(meeting, transcriptTurns) {
        const actionItems = [];
        const keyDecisions = [];
        const sentences = [];

        for (const turn of transcriptTurns) {
            const text = turn.text;
            if (!text) continue;

            sentences.push(text);

            // Action item patterns
            const actionRegexes = [
                /(?:i will|i'll|i can|i shall)\s+([^.!?]+)/gi,
                /(?:let's|let us|we should|we need to|we will)\s+([^.!?]+)/gi,
                /(?:please|can you|could you)\s+([^.!?]+)/gi,
                /(?:action item:?|to-do:?)\s*([^.!?]+)/gi,
            ];

            for (const rx of actionRegexes) {
                let match;
                while ((match = rx.exec(text)) !== null) {
                    const task = match[1].trim();
                    if (task.length > 5 && task.length < 120) {
                        actionItems.push({
                            task: task.charAt(0).toUpperCase() + task.slice(1),
                            owner: turn.speaker || 'You',
                            deadline: 'Next Sync',
                            priority: 'Medium',
                        });
                    }
                }
            }

            // Decision patterns
            const decisionRegexes = [
                /(?:we decided|agreed to|decided to|consensus was|confirmed that)\s+([^.!?]+)/gi,
                /(?:let's go with|moving forward with)\s+([^.!?]+)/gi,
            ];

            for (const rx of decisionRegexes) {
                let match;
                while ((match = rx.exec(text)) !== null) {
                    const dec = match[1].trim();
                    if (dec.length > 5 && dec.length < 150) {
                        keyDecisions.push(dec.charAt(0).toUpperCase() + dec.slice(1));
                    }
                }
            }
        }

        // Deduplicate action items
        const uniqueActions = [];
        const seenTasks = new Set();
        for (const item of actionItems) {
            const key = item.task.toLowerCase();
            if (!seenTasks.has(key)) {
                seenTasks.add(key);
                uniqueActions.push(item);
            }
        }

        // Executive summary from top sentences
        const summaryLead =
            sentences.length > 0
                ? sentences.slice(0, Math.min(3, sentences.length)).join(' ')
                : 'Meeting concluded with all primary topics reviewed.';

        const executiveSummary = `During this session, participants reviewed core progress and aligned on key deliverables. ${summaryLead}`;

        if (keyDecisions.length === 0) {
            keyDecisions.push('Aligned on active project objectives and timeline milestones.');
        }

        const title = meeting.title || 'Team Meeting';
        const rawMarkdown = `# ${title} Summary\n\n## 📌 Executive Summary\n${executiveSummary}\n\n## 🎯 Key Decisions\n${keyDecisions.map(d => `- ${d}`).join('\n')}\n\n## ✅ Action Items & Owners\n| Task | Owner | Deadline | Priority |\n| :--- | :--- | :--- | :--- |\n${uniqueActions.map(a => `| ${a.task} | **${a.owner}** | ${a.deadline} | ${a.priority} |`).join('\n')}\n`;

        return {
            executiveSummary,
            keyDecisions,
            actionItems: uniqueActions,
            followUpEmail: {
                subject: `Recap & Next Steps: ${title}`,
                body: `Hi everyone,\n\nThanks for a productive meeting today. Here is the recap of our decisions and next steps:\n\n${uniqueActions.map(a => `• ${a.task} (${a.owner})`).join('\n')}\n\nBest regards,\nAlpha Team`,
            },
            topics: ['Project Roadmap', 'Technical Sync', 'Action Planning'],
            rawMarkdown,
            provider: 'offline_heuristic',
        };
    }

    _extractSection(markdown, headerName) {
        const rx = new RegExp(`##\\s*[^\\n]*${headerName}[^\\n]*\\n([\\s\\S]*?)(?:\\n##|$)`, 'i');
        const match = markdown.match(rx);
        return match && match[1] ? match[1].trim() : null;
    }

    _extractBulletItems(markdown, headerName) {
        const section = this._extractSection(markdown, headerName);
        if (!section) return [];
        return section
            .split('\n')
            .map(line => line.replace(/^[\s*-•\d.]+\s*/, '').trim())
            .filter(Boolean);
    }

    _extractActionItemsFromMarkdown(markdown) {
        const section = this._extractSection(markdown, 'Action Items');
        if (!section) return [];

        const items = [];
        const lines = section.split('\n');

        for (const line of lines) {
            if (line.includes('|') && !line.includes('---') && !line.toLowerCase().includes('task')) {
                const parts = line
                    .split('|')
                    .map(s => s.trim())
                    .filter(Boolean);
                if (parts.length >= 2) {
                    items.push({
                        task: parts[0],
                        owner: parts[1] || 'Unassigned',
                        deadline: parts[2] || 'TBD',
                        priority: parts[3] || 'Medium',
                    });
                }
            }
        }
        return items;
    }
}

module.exports = {
    MeetingSummarizer,
};
