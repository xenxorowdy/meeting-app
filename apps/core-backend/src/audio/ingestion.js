const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * High-performance Dual-Stream Audio Ingestion Pipeline.
 * - Zero-copy TypedArray audio ingestion
 * - High-quality 16 kHz resampler
 * - Integer sum-of-squares RMS Voice Activity Detector (VAD)
 * - Rolling pre-speech buffers (prevents word-onset clipping)
 * - Speech segmenter emitting ready-to-transcribe audio chunks
 */
class AudioIngestionPipeline extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            targetSampleRate: 16000,
            frameDurationMs: options.frameDurationMs || 100, // 100ms per VAD frame (1600 samples at 16kHz)
            vadRmsThreshold: options.vadRmsThreshold !== undefined ? options.vadRmsThreshold : 0.008, // ~ -42 dBFS
            preSpeechFramesCount: options.preSpeechFramesCount || 4, // 4 frames = 400ms pre-roll
            silenceHangoverFrames: options.silenceHangoverFrames || 10, // 10 frames = 1000ms trailing silence
            minSpeechFrames: options.minSpeechFrames || 2, // 2 frames = 200ms speech onset validation
            minSegmentDurationMs: options.minSegmentDurationMs || 600, // 600ms minimum speech length
            maxSegmentDurationMs: options.maxSegmentDurationMs || 25000, // 25s max segment cut-off
            ...options,
        };

        this.frameSampleCount = Math.floor(
            (this.options.targetSampleRate * this.options.frameDurationMs) / 1000
        );
        this.frameByteLength = this.frameSampleCount * 2;

        // Stream state maps (0: mic, 1: system)
        this.streams = new Map();
        this._initStreamState(0, 'mic', 'You');
        this._initStreamState(1, 'system', 'Speaker');
    }

    _initStreamState(streamId, channelName, defaultSpeaker) {
        this.streams.set(streamId, {
            streamId,
            channel: channelName,
            speaker: defaultSpeaker,
            isRecording: true,
            accumulatedPcm: Buffer.alloc(0),
            // Rolling pre-speech ring buffer (stores recent silence frames)
            preSpeechBuffer: [],
            // Active speech state
            isInSpeech: false,
            speechFrameCounter: 0,
            silenceFrameCounter: 0,
            currentSpeechChunks: [],
            speechStartTimestamp: null,
            speechLastTimestamp: null,
            // Stats
            totalFramesProcessed: 0,
            totalSegmentsEmitted: 0,
        });
    }

    /**
     * Resample arbitrary PCM16 linear audio buffer to 16,000 Hz Mono.
     * High-performance linear interpolation resampler.
     * @param {Buffer} pcmBuffer
     * @param {number} inputRate
     * @param {number} inputChannels
     * @returns {Buffer} 16kHz 16-bit Mono PCM buffer
     */
    resampleTo16kHz(pcmBuffer, inputRate = 16000, inputChannels = 1) {
        if (!pcmBuffer || pcmBuffer.length === 0) {
            return Buffer.alloc(0);
        }

        // If already 16kHz mono, return direct view/buffer
        if (inputRate === 16000 && inputChannels === 1) {
            return pcmBuffer;
        }

        const targetRate = this.options.targetSampleRate;
        const totalInputSamples = Math.floor(pcmBuffer.length / 2);
        const frameCount = Math.floor(totalInputSamples / inputChannels);

        // Convert input to mono Int16 array
        const monoInput = new Int16Array(frameCount);
        if (inputChannels === 1) {
            for (let i = 0; i < frameCount; i++) {
                monoInput[i] = pcmBuffer.readInt16LE(i * 2);
            }
        } else {
            // Downmix multiple channels to mono
            for (let i = 0; i < frameCount; i++) {
                let sum = 0;
                for (let c = 0; c < inputChannels; c++) {
                    sum += pcmBuffer.readInt16LE((i * inputChannels + c) * 2);
                }
                monoInput[i] = Math.floor(sum / inputChannels);
            }
        }

        if (inputRate === targetRate) {
            const outBuf = Buffer.alloc(monoInput.length * 2);
            for (let i = 0; i < monoInput.length; i++) {
                outBuf.writeInt16LE(monoInput[i], i * 2);
            }
            return outBuf;
        }

        // Resample with linear interpolation
        const ratio = inputRate / targetRate;
        const targetSampleCount = Math.floor(frameCount / ratio);
        const outBuf = Buffer.alloc(targetSampleCount * 2);

        for (let i = 0; i < targetSampleCount; i++) {
            const srcIdx = i * ratio;
            const idxFloor = Math.floor(srcIdx);
            const idxCeil = Math.min(idxFloor + 1, frameCount - 1);
            const frac = srcIdx - idxFloor;

            const sample = Math.round(
                monoInput[idxFloor] * (1 - frac) + monoInput[idxCeil] * frac
            );

            const clamped = Math.max(-32768, Math.min(32767, sample));
            outBuf.writeInt16LE(clamped, i * 2);
        }

        return outBuf;
    }

    /**
     * Compute integer sum-of-squares Root Mean Square (RMS) energy.
     * @param {Int16Array} int16Samples
     * @returns {number} Normalized RMS value (0.0 to 1.0)
     */
    static calculateRMS(int16Samples) {
        if (!int16Samples || int16Samples.length === 0) return 0;

        let sumSquares = 0;
        const len = int16Samples.length;

        for (let i = 0; i < len; i++) {
            const sample = int16Samples[i];
            sumSquares += sample * sample;
        }

        const meanSquare = sumSquares / len;
        const rms = Math.sqrt(meanSquare);
        // Normalize 16-bit integer (max amplitude 32768)
        return rms / 32768.0;
    }

    /**
     * Convert RMS to Decibels (dBFS)
     * @param {number} rms
     * @returns {number} dB value (e.g. -60 dB to 0 dB)
     */
    static rmsToDb(rms) {
        if (rms <= 0.00001) return -100;
        return Math.max(-100, Math.min(0, 20 * Math.log10(rms)));
    }

    /**
     * Ingest audio packet from native bridge or direct source.
     * @param {Object} packet
     * @param {number} packet.streamId 0 (mic) or 1 (system)
     * @param {number} packet.timestampMs Timestamp in ms
     * @param {Buffer} packet.pcmData Raw 16kHz PCM16 buffer
     */
    ingestPacket(packet) {
        const streamId = packet.streamId !== undefined ? packet.streamId : 0;
        let state = this.streams.get(streamId);
        if (!state) {
            this._initStreamState(streamId, streamId === 0 ? 'mic' : 'system', streamId === 0 ? 'You' : 'Speaker');
            state = this.streams.get(streamId);
        }

        if (!state.isRecording) return;

        const pcmData = packet.pcmData;
        if (!pcmData || pcmData.length === 0) return;

        // Append to accumulation buffer
        state.accumulatedPcm = state.accumulatedPcm.length === 0
            ? pcmData
            : Buffer.concat([state.accumulatedPcm, pcmData]);

        const timestamp = packet.timestampMs || Date.now();

        // Process discrete frames of frameByteLength
        while (state.accumulatedPcm.length >= this.frameByteLength) {
            const frameBuffer = state.accumulatedPcm.subarray(0, this.frameByteLength);
            state.accumulatedPcm = state.accumulatedPcm.subarray(this.frameByteLength);

            this._processFrame(state, frameBuffer, timestamp);
        }
    }

    /**
     * Internal frame processor with state-machine VAD and pre-speech buffer.
     * @private
     */
    _processFrame(state, frameBuffer, timestamp) {
        state.totalFramesProcessed++;

        const int16Samples = new Int16Array(
            frameBuffer.buffer,
            frameBuffer.byteOffset,
            this.frameSampleCount
        );

        const rms = AudioIngestionPipeline.calculateRMS(int16Samples);
        const db = AudioIngestionPipeline.rmsToDb(rms);
        const isFrameSpeech = rms >= this.options.vadRmsThreshold;

        // Emit audio level for UI VU meters / visualizers
        this.emit('audio_level', {
            streamId: state.streamId,
            channel: state.channel,
            rms,
            db,
            isSpeech: isFrameSpeech,
            timestampMs: timestamp,
        });

        if (isFrameSpeech) {
            state.speechFrameCounter++;
            state.silenceFrameCounter = 0;

            if (!state.isInSpeech) {
                // Speech onset check
                if (state.speechFrameCounter >= this.options.minSpeechFrames) {
                    state.isInSpeech = true;
                    state.speechStartTimestamp = timestamp - (state.preSpeechBuffer.length * this.options.frameDurationMs);
                    state.currentSpeechChunks = [...state.preSpeechBuffer, frameBuffer];
                    state.preSpeechBuffer = [];
                } else {
                    // Accumulating speech onset frames into pre-speech buffer
                    this._pushPreSpeechFrame(state, frameBuffer);
                }
            } else {
                // Ongoing speech
                state.currentSpeechChunks.push(frameBuffer);
                state.speechLastTimestamp = timestamp;

                // Max duration cut-off check
                const currentDuration = state.currentSpeechChunks.length * this.options.frameDurationMs;
                if (currentDuration >= this.options.maxSegmentDurationMs) {
                    this._emitSpeechSegment(state, timestamp);
                }
            }
        } else {
            // Silence frame
            state.speechFrameCounter = 0;

            if (state.isInSpeech) {
                state.silenceFrameCounter++;
                state.currentSpeechChunks.push(frameBuffer); // Include trailing silence for natural speech tail

                if (state.silenceFrameCounter >= this.options.silenceHangoverFrames) {
                    // Speech segment ended
                    this._emitSpeechSegment(state, timestamp);
                }
            } else {
                // In silence state, keep rolling pre-speech buffer
                this._pushPreSpeechFrame(state, frameBuffer);
            }
        }
    }

    /**
     * Push frame to rolling pre-speech ring buffer.
     * @private
     */
    _pushPreSpeechFrame(state, frameBuffer) {
        state.preSpeechBuffer.push(frameBuffer);
        if (state.preSpeechBuffer.length > this.options.preSpeechFramesCount) {
            state.preSpeechBuffer.shift();
        }
    }

    /**
     * Finalize and emit completed speech segment.
     * @private
     */
    _emitSpeechSegment(state, currentTimestamp) {
        if (!state.currentSpeechChunks || state.currentSpeechChunks.length === 0) {
            this._resetSpeechState(state);
            return;
        }

        const totalBytes = state.currentSpeechChunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const segmentAudioBuffer = Buffer.concat(state.currentSpeechChunks, totalBytes);
        const durationMs = Math.round((totalBytes / 2 / this.options.targetSampleRate) * 1000);

        if (durationMs >= this.options.minSegmentDurationMs) {
            const int16Array = new Int16Array(
                segmentAudioBuffer.buffer,
                segmentAudioBuffer.byteOffset,
                Math.floor(segmentAudioBuffer.length / 2)
            );

            const segmentRms = AudioIngestionPipeline.calculateRMS(int16Array);
            const startMs = state.speechStartTimestamp || (currentTimestamp - durationMs);
            const endMs = currentTimestamp;

            state.totalSegmentsEmitted++;

            const segment = {
                id: crypto.randomUUID(),
                streamId: state.streamId,
                channel: state.channel,
                speaker: state.speaker,
                startMs,
                endMs,
                durationMs,
                audioBuffer: segmentAudioBuffer,
                int16Array,
                rms: segmentRms,
                sampleRate: this.options.targetSampleRate,
            };

            this.emit('speech_segment', segment);
        }

        this._resetSpeechState(state);
    }

    /**
     * Reset active speech tracker.
     * @private
     */
    _resetSpeechState(state) {
        state.isInSpeech = false;
        state.speechFrameCounter = 0;
        state.silenceFrameCounter = 0;
        state.currentSpeechChunks = [];
        state.speechStartTimestamp = null;
        state.speechLastTimestamp = null;
    }

    /**
     * Flush all streams (e.g. when meeting ends or pauses).
     */
    flush() {
        for (const state of this.streams.values()) {
            if (state.isInSpeech && state.currentSpeechChunks.length > 0) {
                this._emitSpeechSegment(state, Date.now());
            }
            state.accumulatedPcm = Buffer.alloc(0);
            state.preSpeechBuffer = [];
            this._resetSpeechState(state);
        }
    }

    /**
     * Pause audio processing.
     */
    pause() {
        this.flush();
        for (const state of this.streams.values()) {
            state.isRecording = false;
        }
    }

    /**
     * Resume audio processing.
     */
    resume() {
        for (const state of this.streams.values()) {
            state.isRecording = true;
        }
    }

    /**
     * Get statistics about current audio streams.
     */
    getStats() {
        const stats = {};
        for (const [streamId, state] of this.streams.entries()) {
            stats[state.channel] = {
                streamId,
                isInSpeech: state.isInSpeech,
                totalFramesProcessed: state.totalFramesProcessed,
                totalSegmentsEmitted: state.totalSegmentsEmitted,
            };
        }
        return stats;
    }
}

module.exports = {
    AudioIngestionPipeline,
};
