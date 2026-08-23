const EventEmitter = require('events');

/**
 * Acoustic Echo Detection & Duplicate Mic Turn Rejection.
 * 
 * Prevents remote meeting participants' audio played through laptop speakers
 * from being falsely transcribed as microphone ("You") turns.
 */
class EchoSuppressor extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            windowDurationMs: options.windowDurationMs || 8000, // 8s history window
            echoDelayMinMs: options.echoDelayMinMs || 20, // Min acoustic delay
            echoDelayMaxMs: options.echoDelayMaxMs || 600, // Max acoustic delay
            correlationThreshold: options.correlationThreshold || 0.65, // Energy cross-correlation threshold
            similarityThreshold: options.similarityThreshold || 0.70, // Text overlap threshold
            enabled: options.enabled !== undefined ? options.enabled : true,
            ...options,
        };

        // Ring buffer of recent system audio segments & energy envelopes
        this.recentSystemSegments = [];
        // Recent recognized system transcripts
        this.recentSystemTranscripts = [];
    }

    /**
     * Register a system audio segment for echo correlation tracking.
     * @param {Object} segment
     */
    recordSystemSegment(segment) {
        if (!this.options.enabled || !segment) return;

        const now = Date.now();
        const startMs = segment.startMs || now;
        const endMs = segment.endMs || now;

        // Downsample energy profile into 20ms buckets
        const energyProfile = this._computeEnergyProfile(segment.int16Array, 20);

        this.recentSystemSegments.push({
            id: segment.id,
            startMs,
            endMs,
            durationMs: segment.durationMs || (endMs - startMs),
            rms: segment.rms || 0,
            energyProfile,
            receivedAt: now,
        });

        this._pruneOldData(now);
    }

    /**
     * Register recognized system transcript text.
     * @param {string} text
     * @param {number} timestampMs
     */
    recordSystemTranscript(text, timestampMs = Date.now()) {
        if (!text || typeof text !== 'string') return;
        const clean = text.trim().toLowerCase();
        if (!clean) return;

        this.recentSystemTranscripts.push({
            text: clean,
            tokens: this._tokenize(clean),
            timestampMs,
        });

        this._pruneOldData(Date.now());
    }

    /**
     * Check if a mic segment is an acoustic echo of recent system audio.
     * @param {Object} micSegment
     * @returns {{ isEcho: boolean, confidence: number, reason: string|null }}
     */
    filterMicSegment(micSegment) {
        if (!this.options.enabled) {
            return { isEcho: false, confidence: 0, reason: null };
        }

        if (!micSegment || !micSegment.int16Array) {
            return { isEcho: false, confidence: 0, reason: null };
        }

        const micStart = micSegment.startMs || Date.now() - (micSegment.durationMs || 0);
        const micEnd = micSegment.endMs || Date.now();
        const micRms = micSegment.rms || 0;
        const micProfile = this._computeEnergyProfile(micSegment.int16Array, 20);

        // Check against recent system segments overlapping or just preceding this window
        for (const sysSeg of this.recentSystemSegments) {
            const timeDelta = micStart - sysSeg.startMs;

            // Check if within feasible acoustic delay window
            if (timeDelta >= -100 && timeDelta <= this.options.echoDelayMaxMs + 500) {
                // If mic signal is significantly louder than system audio, user is likely actually speaking over it
                if (micRms > sysSeg.rms * 2.5 && micRms > 0.05) {
                    continue;
                }

                // Compute cross-correlation of energy envelopes
                const correlation = this._computeProfileCorrelation(micProfile, sysSeg.energyProfile);
                if (correlation >= this.options.correlationThreshold) {
                    this.emit('echo_detected', {
                        micSegmentId: micSegment.id,
                        sysSegmentId: sysSeg.id,
                        correlation,
                        timeDelta,
                    });

                    return {
                        isEcho: true,
                        confidence: Math.min(1.0, correlation),
                        reason: `Acoustic energy correlation (${Math.round(correlation * 100)}%) with system audio`,
                    };
                }
            }
        }

        return { isEcho: false, confidence: 0, reason: null };
    }

    /**
     * Check if a transcribed mic text duplicates recent system text.
     * @param {string} micText
     * @param {number} timestampMs
     * @returns {{ isDuplicate: boolean, similarity: number, matchedText: string|null }}
     */
    isDuplicateTranscript(micText, timestampMs = Date.now()) {
        if (!this.options.enabled || !micText) {
            return { isDuplicate: false, similarity: 0, matchedText: null };
        }

        const cleanMic = micText.trim().toLowerCase();
        if (!cleanMic) {
            return { isDuplicate: false, similarity: 0, matchedText: null };
        }

        const micTokens = this._tokenize(cleanMic);
        if (micTokens.length < 2) {
            return { isDuplicate: false, similarity: 0, matchedText: null };
        }

        for (const sysItem of this.recentSystemTranscripts) {
            const timeDiff = Math.abs(timestampMs - sysItem.timestampMs);
            // Must be within 10 seconds
            if (timeDiff <= 10000) {
                const similarity = this._computeJaccardSimilarity(micTokens, sysItem.tokens);
                if (similarity >= this.options.similarityThreshold) {
                    return {
                        isDuplicate: true,
                        similarity,
                        matchedText: sysItem.text,
                    };
                }
            }
        }

        return { isDuplicate: false, similarity: 0, matchedText: null };
    }

    /**
     * Compute 20ms energy profile buckets for fast cross-correlation.
     * @private
     */
    _computeEnergyProfile(int16Array, bucketDurationMs = 20) {
        if (!int16Array || int16Array.length === 0) return [];

        const samplesPerBucket = Math.floor((16000 * bucketDurationMs) / 1000);
        const numBuckets = Math.floor(int16Array.length / samplesPerBucket);
        const profile = new Float32Array(numBuckets);

        for (let b = 0; b < numBuckets; b++) {
            let sumSq = 0;
            const start = b * samplesPerBucket;
            for (let i = 0; i < samplesPerBucket; i++) {
                const sample = int16Array[start + i];
                sumSq += sample * sample;
            }
            profile[b] = Math.sqrt(sumSq / samplesPerBucket) / 32768.0;
        }

        return profile;
    }

    /**
     * Normalized cross-correlation between two energy profiles.
     * @private
     */
    _computeProfileCorrelation(profileA, profileB) {
        if (!profileA || !profileB || profileA.length === 0 || profileB.length === 0) {
            return 0;
        }

        const minLen = Math.min(profileA.length, profileB.length);
        if (minLen < 3) return 0;

        let dot = 0;
        let magA = 0;
        let magB = 0;

        for (let i = 0; i < minLen; i++) {
            dot += profileA[i] * profileB[i];
            magA += profileA[i] * profileA[i];
            magB += profileB[i] * profileB[i];
        }

        const denom = Math.sqrt(magA) * Math.sqrt(magB);
        if (denom === 0) return 0;

        return dot / denom;
    }

    /**
     * Tokenize text into words.
     * @private
     */
    _tokenize(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter(Boolean);
    }

    /**
     * Compute Jaccard similarity between two token sets.
     * @private
     */
    _computeJaccardSimilarity(tokensA, tokensB) {
        if (!tokensA.length || !tokensB.length) return 0;

        const setA = new Set(tokensA);
        const setB = new Set(tokensB);

        let intersection = 0;
        for (const token of setA) {
            if (setB.has(token)) intersection++;
        }

        const union = setA.size + setB.size - intersection;
        return union === 0 ? 0 : intersection / union;
    }

    /**
     * Prune data older than windowDurationMs.
     * @private
     */
    _pruneOldData(now) {
        const cutoff = now - this.options.windowDurationMs;
        this.recentSystemSegments = this.recentSystemSegments.filter(s => s.receivedAt > cutoff);
        this.recentSystemTranscripts = this.recentSystemTranscripts.filter(t => t.timestampMs > cutoff);
    }

    /**
     * Reset history.
     */
    reset() {
        this.recentSystemSegments = [];
        this.recentSystemTranscripts = [];
    }
}

module.exports = {
    EchoSuppressor,
};
