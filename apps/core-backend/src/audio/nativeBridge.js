const EventEmitter = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * 16-byte Binary Packet Protocol Header:
 * ┌─────────────────┬───────────────────┬──────────────────┬────────────────────┐
 * │  Stream ID (4B) │ Timestamp ms (8B) │ Payload Len (4B) │ PCM16 Data (N B)   │
 * │  0=Mic, 1=Sys   │ Monotonic Epoch   │ Little Endian    │ 16kHz Little-Endian│
 * └─────────────────┴───────────────────┴──────────────────┴────────────────────┘
 */
const HEADER_SIZE = 16;
const STREAM_MIC = 0;
const STREAM_SYSTEM = 1;

class NativeAudioBridge extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            helperPath: options.helperPath || null,
            platform: options.platform || process.platform,
            autoRestart: options.autoRestart || false,
            sampleRate: options.sampleRate || 16000,
            channels: options.channels || 1,
            ...options,
        };

        this.process = null;
        this.isRunning = false;
        this.accumulatedBuffer = Buffer.alloc(0);
        this.totalPacketsReceived = 0;
        this.totalBytesReceived = 0;
    }

    /**
     * Encode raw PCM audio buffer into standard 16-byte header protocol packet.
     * @param {number} streamId 0 for mic, 1 for system
     * @param {number|BigInt} timestampMs Epoch ms timestamp
     * @param {Buffer} pcmBuffer Raw PCM16 audio bytes
     * @returns {Buffer} Complete binary packet
     */
    static encodePacket(streamId, timestampMs, pcmBuffer) {
        const payloadLength = pcmBuffer ? pcmBuffer.length : 0;
        const packet = Buffer.alloc(HEADER_SIZE + payloadLength);

        // Stream ID (4 bytes, UInt32LE)
        packet.writeUInt32LE(streamId, 0);

        // Timestamp (8 bytes, BigUInt64LE)
        const tsBigInt = typeof timestampMs === 'bigint' ? timestampMs : BigInt(Math.floor(Number(timestampMs)));
        packet.writeBigUInt64LE(tsBigInt, 4);

        // Payload Length (4 bytes, UInt32LE)
        packet.writeUInt32LE(payloadLength, 12);

        // PCM Data Payload
        if (payloadLength > 0 && pcmBuffer) {
            pcmBuffer.copy(packet, HEADER_SIZE);
        }

        return packet;
    }

    /**
     * Start capturing native audio by spawning helper process or attaching to custom stream.
     * @param {Object} overrideOptions
     */
    start(overrideOptions = {}) {
        if (this.isRunning) {
            return this;
        }

        const opts = { ...this.options, ...overrideOptions };
        const helperExecutable = this._resolveHelperPath(opts.helperPath);

        if (!helperExecutable || !fs.existsSync(helperExecutable)) {
            // If executable not found on disk, emit warning and provide mock fallback capability
            this.emit('warning', {
                message: `Native helper not found at path: ${helperExecutable}. Falling back to virtual bridge mode.`,
                platform: opts.platform,
            });
            this.isRunning = true;
            this.emit('start', { mode: 'virtual', path: null });
            return this;
        }

        try {
            const args = opts.args || [];
            this.process = spawn(helperExecutable, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });

            this.isRunning = true;
            this.emit('start', { mode: 'native', path: helperExecutable, pid: this.process.pid });

            this.process.stdout.on('data', chunk => {
                this.feedChunk(chunk);
            });

            this.process.stderr.on('data', data => {
                const text = data.toString('utf8').trim();
                if (text) {
                    this.emit('helper_log', text);
                }
            });

            this.process.on('error', err => {
                this.emit('error', new Error(`Native helper error: ${err.message}`));
            });

            this.process.on('close', (code, signal) => {
                const wasRunning = this.isRunning;
                this.isRunning = false;
                this.process = null;
                this.emit('stop', { code, signal });

                if (wasRunning && opts.autoRestart && code !== 0) {
                    this.emit('restarting', { delayMs: 1000 });
                    setTimeout(() => {
                        if (!this.isRunning) this.start(opts);
                    }, 1000);
                }
            });
        } catch (err) {
            this.isRunning = false;
            this.emit('error', new Error(`Failed to spawn audio helper: ${err.message}`));
        }

        return this;
    }

    /**
     * Attach a readable stream (e.g. stdout from another process or mock stream).
     * @param {ReadableStream} readableStream
     */
    attachStream(readableStream) {
        this.isRunning = true;
        readableStream.on('data', chunk => {
            this.feedChunk(chunk);
        });
        readableStream.on('end', () => {
            this.stop();
        });
        readableStream.on('error', err => {
            this.emit('error', err);
        });
        this.emit('start', { mode: 'stream_attached' });
        return this;
    }

    /**
     * Feed incoming binary data chunk into the packet stream parser.
     * Efficiently buffers and slices full 16-byte header frames.
     * @param {Buffer} chunk
     */
    feedChunk(chunk) {
        if (!chunk || chunk.length === 0) return;

        this.totalBytesReceived += chunk.length;

        // Fast concatenation with current buffer
        if (this.accumulatedBuffer.length === 0) {
            this.accumulatedBuffer = chunk;
        } else {
            this.accumulatedBuffer = Buffer.concat([this.accumulatedBuffer, chunk]);
        }

        let offset = 0;
        const totalLen = this.accumulatedBuffer.length;

        while (offset + HEADER_SIZE <= totalLen) {
            // Read 16-byte Header
            const streamId = this.accumulatedBuffer.readUInt32LE(offset);
            const timestampMs = Number(this.accumulatedBuffer.readBigUInt64LE(offset + 4));
            const payloadLength = this.accumulatedBuffer.readUInt32LE(offset + 12);

            // Sanity check payload length to avoid memory corruption / sync loss
            if (payloadLength > 1024 * 1024 * 10) {
                // > 10MB packet indicates corrupted stream or sync loss
                this.emit('warning', { message: 'Corrupt packet length detected. Resyncing stream.' });
                // Advance 1 byte to seek next valid header
                offset += 1;
                continue;
            }

            const fullPacketSize = HEADER_SIZE + payloadLength;
            if (offset + fullPacketSize > totalLen) {
                // Not enough bytes yet for payload, wait for next chunk
                break;
            }

            // Extract PCM16 payload
            const payloadStart = offset + HEADER_SIZE;
            const payloadEnd = payloadStart + payloadLength;
            const pcmData = this.accumulatedBuffer.subarray(payloadStart, payloadEnd);

            // Alignment-safe Int16Array view
            const samplesCount = Math.floor(payloadLength / 2);
            const int16Data = new Int16Array(
                pcmData.buffer,
                pcmData.byteOffset,
                samplesCount
            );

            this.totalPacketsReceived++;

            const streamType = streamId === STREAM_MIC ? 'mic' : 'system';

            this.emit('packet', {
                streamId,
                streamType,
                timestampMs: timestampMs || Date.now(),
                payloadLength,
                pcmData,
                int16Data,
                samplesCount,
            });

            offset += fullPacketSize;
        }

        // Keep remaining partial buffer
        if (offset > 0) {
            this.accumulatedBuffer = this.accumulatedBuffer.subarray(offset);
        }
    }

    /**
     * Stop helper process and clean up resources.
     */
    stop() {
        this.isRunning = false;
        if (this.process) {
            try {
                this.process.kill('SIGTERM');
                // Force kill if it does not exit within 500ms
                const procRef = this.process;
                setTimeout(() => {
                    if (procRef && !procRef.killed) {
                        try {
                            procRef.kill('SIGKILL');
                        } catch (_) {}
                    }
                }, 500);
            } catch (_) {}
            this.process = null;
        }
        this.accumulatedBuffer = Buffer.alloc(0);
        this.emit('stop', { code: 0, signal: 'MANUAL_STOP' });
    }

    /**
     * Generate synthetic packet for testing or simulation.
     * @param {number} streamId 0 for mic, 1 for system
     * @param {number} durationMs Duration in ms
     * @param {number} frequency Frequency of sine wave in Hz (0 for silence)
     * @param {number} amplitude Volume amplitude (0.0 to 1.0)
     */
    generateSyntheticPacket(streamId = 0, durationMs = 100, frequency = 440, amplitude = 0.5) {
        const sampleRate = this.options.sampleRate;
        const numSamples = Math.floor((sampleRate * durationMs) / 1000);
        const pcmBuffer = Buffer.alloc(numSamples * 2);

        for (let i = 0; i < numSamples; i++) {
            let sample = 0;
            if (frequency > 0) {
                sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * 32767;
            }
            pcmBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(sample))), i * 2);
        }

        const packet = NativeAudioBridge.encodePacket(streamId, Date.now(), pcmBuffer);
        return { packet, pcmBuffer, numSamples };
    }

    /**
     * Resolve the absolute path to native capture helper executable.
     * @private
     */
    _resolveHelperPath(customPath) {
        if (customPath && fs.existsSync(customPath)) {
            return customPath;
        }

        const platform = this.options.platform;
        const possiblePaths = [];

        if (platform === 'darwin') {
            // macOS ScreenCaptureKit binary
            possiblePaths.push(
                path.join(__dirname, '../../../../src/assets/SystemAudioDump'),
                path.join(__dirname, '../../../assets/SystemAudioDump'),
                path.join(process.cwd(), 'src/assets/SystemAudioDump'),
                path.join(process.cwd(), 'assets/SystemAudioDump')
            );
            if (process.resourcesPath) {
                possiblePaths.unshift(path.join(process.resourcesPath, 'SystemAudioDump'));
            }
        } else if (platform === 'win32') {
            // Windows WASAPI binary
            possiblePaths.push(
                path.join(__dirname, '../../../../src/assets/SystemAudioDump.exe'),
                path.join(__dirname, '../../../assets/SystemAudioDump.exe'),
                path.join(process.cwd(), 'src/assets/SystemAudioDump.exe'),
                path.join(process.cwd(), 'assets/AudioCaptureHelper.exe')
            );
            if (process.resourcesPath) {
                possiblePaths.unshift(path.join(process.resourcesPath, 'SystemAudioDump.exe'));
            }
        }

        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                return p;
            }
        }

        return null;
    }
}

module.exports = {
    NativeAudioBridge,
    HEADER_SIZE,
    STREAM_MIC,
    STREAM_SYSTEM,
};
