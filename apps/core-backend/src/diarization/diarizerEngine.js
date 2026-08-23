const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * High-Accuracy Speaker Diarization Engine.
 * 
 * 1. Channel 0 (Microphone): ALWAYS assigned to "You" (User).
 * 2. Channel 1 (System Audio): Partitioned into "Speaker 1", "Speaker 2"... via acoustic clustering.
 * 3. Chronological Timeline Interleaving: Merges dual-channel turns by monotonic timestamps.
 * 4. Conversational Name Resolution: Infers real participant names from conversational vocatives.
 */
class DiarizerEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            similarityThreshold: options.similarityThreshold || 0.75, // Cosine similarity threshold for speaker clustering
            embeddingDimensions: options.embeddingDimensions || 128, // Feature vector size
            userSpeakerLabel: options.userSpeakerLabel || 'You',
            systemSpeakerPrefix: options.systemSpeakerPrefix || 'Speaker',
            enableNameResolution: options.enableNameResolution !== undefined ? options.enableNameResolution : true,
            ...options,
        };

        // Speaker clusters for system audio: Map<speakerId, { id, name, centroid: Float32Array, segmentCount: number, totalDurationMs: number }>
        this.speakerClusters = new Map();
        // Speaker name mapping: Map<originalLabel, inferredName>
        this.speakerNameMap = new Map();
        // Chronological transcript turns
        this.timelineTurns = [];
        this.systemSpeakerCounter = 0;
    }

    /**
     * Process an incoming speech segment and its transcribed text.
     * Assigns speaker label and inserts into chronological timeline.
     * @param {Object} segment
     * @param {Object} transcriptResult
     * @returns {Object} Final diarized turn
     */
    diarizeTurn(segment, transcriptResult) {
        const text = (transcriptResult && transcriptResult.text ? transcriptResult.text : '').trim();
        if (!text) return null;

        let speaker = this.options.userSpeakerLabel;
        let speakerId = 'speaker_user';

        if (segment.channel === 'mic' || segment.streamId === 0) {
            // Physical microphone is ALWAYS user
            speaker = this.options.userSpeakerLabel;
            speakerId = 'speaker_user';
        } else {
            // System audio: extract acoustic features and cluster
            const cluster = this._clusterSystemSpeaker(segment);
            speakerId = cluster.id;
            speaker = this.speakerNameMap.get(cluster.name) || cluster.name;
        }

        const turn = {
            id: segment.id || crypto.randomUUID(),
            meetingId: segment.meetingId || null,
            channel: segment.channel || (segment.streamId === 0 ? 'mic' : 'system'),
            speakerId,
            speaker,
            startMs: segment.startMs,
            endMs: segment.endMs,
            durationMs: segment.durationMs || (segment.endMs - segment.startMs),
            text,
            confidence: transcriptResult ? (transcriptResult.confidence || 0.95) : 0.95,
            words: transcriptResult ? (transcriptResult.segments || []) : [],
            createdAt: Date.now(),
        };

        // Insert into chronological timeline maintaining order
        this._insertTurnSorted(turn);

        // Check for vocative name clues if enabled
        if (this.options.enableNameResolution) {
            this._inferNamesFromConversationalClues(turn);
        }

        this.emit('turn', turn);
        return turn;
    }

    /**
     * Acoustic clustering for system audio segments.
     * @private
     */
    _clusterSystemSpeaker(segment) {
        const embedding = this._extractAcousticEmbedding(segment.int16Array || segment.audioBuffer);
        let bestCluster = null;
        let highestSimilarity = -1;

        for (const cluster of this.speakerClusters.values()) {
            const similarity = this._cosineSimilarity(embedding, cluster.centroid);
            if (similarity > highestSimilarity) {
                highestSimilarity = similarity;
                bestCluster = cluster;
            }
        }

        if (bestCluster && highestSimilarity >= this.options.similarityThreshold) {
            // Update cluster centroid using running weighted average
            const n = bestCluster.segmentCount;
            const updatedCentroid = new Float32Array(this.options.embeddingDimensions);
            for (let i = 0; i < this.options.embeddingDimensions; i++) {
                updatedCentroid[i] = (bestCluster.centroid[i] * n + embedding[i]) / (n + 1);
            }
            this._normalizeVector(updatedCentroid);

            bestCluster.centroid = updatedCentroid;
            bestCluster.segmentCount++;
            bestCluster.totalDurationMs += (segment.durationMs || 1000);

            return bestCluster;
        }

        // Create new speaker cluster
        this.systemSpeakerCounter++;
        const speakerName = `${this.options.systemSpeakerPrefix} ${this.systemSpeakerCounter}`;
        const newClusterId = `speaker_sys_${this.systemSpeakerCounter}`;

        const newCluster = {
            id: newClusterId,
            name: speakerName,
            centroid: embedding,
            segmentCount: 1,
            totalDurationMs: segment.durationMs || 1000,
        };

        this.speakerClusters.set(newClusterId, newCluster);
        this.emit('speaker_discovered', {
            speakerId: newClusterId,
            name: speakerName,
            totalSpeakers: this.speakerClusters.size,
        });

        return newCluster;
    }

    /**
     * Extract normalized acoustic feature embedding from audio.
     * Computes multi-band spectral energy, zero-crossing rate, dynamic envelope, and pitch proxies.
     * @private
     */
    _extractAcousticEmbedding(int16OrBuffer) {
        const dims = this.options.embeddingDimensions;
        const embedding = new Float32Array(dims);

        if (!int16OrBuffer || int16OrBuffer.length === 0) {
            // Return unit vector
            embedding[0] = 1.0;
            return embedding;
        }

        const samples = int16OrBuffer instanceof Int16Array
            ? int16OrBuffer
            : new Int16Array(int16OrBuffer.buffer, int16OrBuffer.byteOffset, Math.floor(int16OrBuffer.length / 2));

        const len = samples.length;
        if (len === 0) return embedding;

        const windowSize = Math.floor(len / dims) || 1;
        let zeroCrossings = 0;
        let totalEnergy = 0;

        for (let d = 0; d < dims; d++) {
            const start = d * windowSize;
            const end = Math.min(start + windowSize, len);
            let bandSumSq = 0;
            let bandDiff = 0;

            for (let i = start; i < end; i++) {
                const s = samples[i] / 32768.0;
                bandSumSq += s * s;
                if (i > 0) {
                    const prevS = samples[i - 1] / 32768.0;
                    if ((s >= 0 && prevS < 0) || (s < 0 && prevS >= 0)) {
                        zeroCrossings++;
                    }
                    bandDiff += Math.abs(s - prevS);
                }
            }

            const count = Math.max(1, end - start);
            const bandRms = Math.sqrt(bandSumSq / count);
            const spectralSpread = bandDiff / count;

            embedding[d] = bandRms * 0.7 + spectralSpread * 0.3;
            totalEnergy += bandSumSq;
        }

        // Add harmonic spectral tilt in upper dimensions
        if (dims >= 8) {
            embedding[dims - 2] = (zeroCrossings / len) * 5.0;
            embedding[dims - 1] = Math.sqrt(totalEnergy / len);
        }

        this._normalizeVector(embedding);
        return embedding;
    }

    /**
     * Compute cosine similarity between two normalized vectors.
     * @private
     */
    _cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dot = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
        }
        return Math.max(-1.0, Math.min(1.0, dot));
    }

    /**
     * In-place L2 vector normalization.
     * @private
     */
    _normalizeVector(vec) {
        let sumSq = 0;
        for (let i = 0; i < vec.length; i++) {
            sumSq += vec[i] * vec[i];
        }
        const norm = Math.sqrt(sumSq);
        if (norm > 0.000001) {
            for (let i = 0; i < vec.length; i++) {
                vec[i] /= norm;
            }
        }
    }

    /**
     * Insert turn sorted by start timestamp.
     * @private
     */
    _insertTurnSorted(turn) {
        let i = this.timelineTurns.length;
        while (i > 0 && this.timelineTurns[i - 1].startMs > turn.startMs) {
            i--;
        }
        this.timelineTurns.splice(i, 0, turn);
    }

    /**
     * Heuristic parser for conversational vocative names.
     * Examples:
     * - "Thanks Alex" / "Hey Alex, what do you think?"
     * - "Hi everyone, I'm Sarah from design"
     * - "Dave, can you take the next item?"
     * @private
     */
    _inferNamesFromConversationalClues(currentTurn) {
        const text = currentTurn.text;

        // 1. Self-introduction pattern: "My name is <Name>", "This is <Name> from...", "I'm <Name>,"
        const selfIntroRegex = /(?:my name is|this is)\s+([A-Z][a-z]+)|(?:i'm|i am)\s+([A-Z][a-z]+)(?:\s+(?:from|at|with|here|the)|[,.!])/i;
        const selfMatch = text.match(selfIntroRegex);
        if (selfMatch) {
            const candidateName = (selfMatch[1] || selfMatch[2] || '').trim();
            if (this._isValidPersonName(candidateName)) {
                this.renameSpeaker(currentTurn.speaker, candidateName);
                return;
            }
        }

        // 2. Direct address pattern: "Thanks <Name>", "Hey <Name>,", "<Name>, what do you think"
        const vocativeRegex = /(?:thanks|thank you|hey|hi|hello|question for|thoughts,?)\s+([A-Z][a-z]+)/i;
        const vocativeMatch = text.match(vocativeRegex);
        if (vocativeMatch && vocativeMatch[1]) {
            const addressedName = vocativeMatch[1].trim();
            if (this._isValidPersonName(addressedName)) {
                // If speaker A addresses Name, and next turn starts shortly by speaker B, speaker B is likely Name
                const recentSystemTurns = this.timelineTurns.filter(t => t.channel === 'system' && t.id !== currentTurn.id);
                if (recentSystemTurns.length > 0) {
                    const candidateSpeaker = recentSystemTurns[recentSystemTurns.length - 1].speaker;
                    if (candidateSpeaker.startsWith(this.options.systemSpeakerPrefix) && candidateSpeaker !== currentTurn.speaker) {
                        this.renameSpeaker(candidateSpeaker, addressedName);
                    }
                }
            }
        }
    }

    /**
     * Validate candidate person name string.
     * @private
     */
    _isValidPersonName(name) {
        if (!name || name.length < 2 || name.length > 20) return false;
        const lower = name.toLowerCase();
        const commonWords = [
            'everyone', 'all', 'today', 'there', 'here', 'team', 'guys', 'folks', 'meeting',
            'project', 'company', 'ready', 'happy', 'sure', 'fine', 'good', 'glad', 'sorry',
            'going', 'doing', 'working', 'trying', 'thinking', 'speaking', 'talking', 'listening',
            'done', 'back', 'not', 'just', 'so', 'now', 'also', 'able', 'afraid', 'proud',
            'open', 'closed', 'late', 'early', 'new', 'old', 'excited', 'wondering', 'hoping'
        ];
        return !commonWords.includes(lower);
    }

    /**
     * Rename a speaker label across the session.
     * @param {string} oldName e.g. "Speaker 1"
     * @param {string} newName e.g. "Sarah"
     */
    renameSpeaker(oldName, newName) {
        if (!oldName || !newName || oldName === newName) return;

        this.speakerNameMap.set(oldName, newName);

        // Update existing turns
        for (const turn of this.timelineTurns) {
            if (turn.speaker === oldName) {
                turn.speaker = newName;
            }
        }

        this.emit('speaker_renamed', {
            oldName,
            newName,
            affectedTurnsCount: this.timelineTurns.filter(t => t.speaker === newName).length,
        });
    }

    /**
     * Get all chronological turns.
     */
    getTimeline() {
        return [...this.timelineTurns];
    }

    /**
     * Get unique speaker list.
     */
    getSpeakers() {
        const speakers = new Set();
        for (const turn of this.timelineTurns) {
            speakers.add(turn.speaker);
        }
        return Array.from(speakers);
    }

    /**
     * Reset diarizer state for new meeting.
     */
    reset() {
        this.speakerClusters.clear();
        this.speakerNameMap.clear();
        this.timelineTurns = [];
        this.systemSpeakerCounter = 0;
    }
}

module.exports = {
    DiarizerEngine,
};
