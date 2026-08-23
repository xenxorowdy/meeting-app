const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_TIMEOUT_MS = 180_000;
const DISALLOWED_TOOLS = 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit';

function candidateBinaries() {
    const home = os.homedir();
    const candidates = [
        path.join(home, '.claude', 'local', 'claude'),
        path.join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        path.join(home, '.npm-global', 'bin', 'claude'),
        path.join(home, '.volta', 'bin', 'claude'),
        path.join(home, '.bun', 'bin', 'claude'),
        path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', 'claude'),
    ];

    const nvmRoot = path.join(home, '.nvm', 'versions', 'node');
    try {
        for (const version of fs.readdirSync(nvmRoot)) {
            candidates.push(path.join(nvmRoot, version, 'bin', 'claude'));
        }
    } catch (_) {}

    return candidates;
}

function findClaudeBinary(explicitPath) {
    if (explicitPath) {
        return fs.existsSync(explicitPath) ? explicitPath : null;
    }

    const envPath = process.env.ALPHA_CLAUDE_BIN;
    if (envPath) {
        return fs.existsSync(envPath) ? envPath : null;
    }

    const binaryName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
    const separator = process.platform === 'win32' ? ';' : ':';
    for (const dir of (process.env.PATH || '').split(separator).filter(Boolean)) {
        const candidate = path.join(dir, binaryName);
        if (fs.existsSync(candidate)) return candidate;
    }

    return candidateBinaries().find(candidate => fs.existsSync(candidate)) || null;
}

class ClaudeCliClient {
    constructor(options = {}) {
        this.options = {
            binaryPath: options.binaryPath || null,
            model: options.model || process.env.ALPHA_SUMMARY_MODEL || DEFAULT_MODEL,
            timeoutMs: options.timeoutMs || Number(process.env.ALPHA_SUMMARY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
            safeMode: options.safeMode !== false,
            maxBudgetUsd: options.maxBudgetUsd || process.env.ALPHA_SUMMARY_MAX_BUDGET_USD || null,
            cwd: options.cwd || os.tmpdir(),
            spawnFn: options.spawnFn || spawn,
        };

        this.resolvedBinary = undefined;
    }

    get binary() {
        if (this.resolvedBinary === undefined) {
            this.resolvedBinary = findClaudeBinary(this.options.binaryPath);
        }
        return this.resolvedBinary;
    }

    isAvailable() {
        return Boolean(this.binary);
    }

    buildArgs({ instruction, systemPrompt, jsonSchema, model }) {
        const args = [
            '--print',
            instruction,
            '--output-format',
            'json',
            '--model',
            model || this.options.model,
            '--disallowedTools',
            DISALLOWED_TOOLS,
            '--no-session-persistence',
        ];

        if (systemPrompt) {
            args.push('--system-prompt', systemPrompt);
        }
        if (jsonSchema) {
            args.push('--json-schema', typeof jsonSchema === 'string' ? jsonSchema : JSON.stringify(jsonSchema));
        }
        if (this.options.safeMode) {
            args.push('--safe-mode');
        }
        if (this.options.maxBudgetUsd) {
            args.push('--max-budget-usd', String(this.options.maxBudgetUsd));
        }

        return args;
    }

    run({ instruction, systemPrompt = null, input = '', jsonSchema = null, model = null, timeoutMs = null } = {}) {
        const binary = this.binary;
        if (!binary) {
            return Promise.reject(new Error('Claude Code CLI not found. Install Claude Code or set ALPHA_CLAUDE_BIN.'));
        }

        const args = this.buildArgs({ instruction, systemPrompt, jsonSchema, model });
        const limit = timeoutMs || this.options.timeoutMs;

        return new Promise((resolve, reject) => {
            let child;
            try {
                child = this.options.spawnFn(binary, args, {
                    cwd: this.options.cwd,
                    env: {
                        ...process.env,
                        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                        MAX_THINKING_TOKENS: '0',
                    },
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch (err) {
                reject(new Error(`Could not start ${binary}: ${err.message}`));
                return;
            }

            let stdout = '';
            let stderr = '';
            let settled = false;

            const finish = (err, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err) reject(err);
                else resolve(value);
            };

            const timer = setTimeout(() => {
                try {
                    child.kill('SIGTERM');
                } catch (_) {}
                finish(new Error(`Claude CLI timed out after ${limit}ms`));
            }, limit);

            child.stdout.on('data', chunk => (stdout += chunk.toString()));
            child.stderr.on('data', chunk => (stderr += chunk.toString()));
            child.on('error', err => finish(new Error(`Claude CLI error: ${err.message}`)));

            child.on('close', code => {
                if (code !== 0) {
                    finish(new Error(`Claude CLI exited with ${code}: ${firstLine(stderr)}`));
                    return;
                }
                try {
                    finish(null, parseCliOutput(stdout));
                } catch (err) {
                    finish(err);
                }
            });

            if (child.stdin) {
                child.stdin.on('error', () => {});
                child.stdin.end(input);
            }
        });
    }
}

function firstLine(text) {
    const line = (text || '').trim().split('\n')[0] || 'no output';
    return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

function parseCliOutput(stdout) {
    let envelope;
    try {
        envelope = JSON.parse((stdout || '').trim());
    } catch (err) {
        throw new Error(`Claude CLI returned unparseable output: ${err.message}`);
    }

    if (envelope.is_error) {
        throw new Error(`Claude CLI reported an error: ${envelope.result || 'unknown error'}`);
    }

    const text = typeof envelope.result === 'string' ? envelope.result : '';
    const structured = envelope.structured_output && typeof envelope.structured_output === 'object' ? envelope.structured_output : null;

    if (!text && !structured) {
        throw new Error('Claude CLI returned no result');
    }

    return {
        text,
        structured,
        costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null,
    };
}

module.exports = {
    ClaudeCliClient,
    findClaudeBinary,
    DEFAULT_MODEL,
    DISALLOWED_TOOLS,
    _testing: {
        parseCliOutput,
        firstLine,
        candidateBinaries,
    },
};
