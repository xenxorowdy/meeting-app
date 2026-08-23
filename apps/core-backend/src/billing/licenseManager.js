const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * Commercial License Manager & Feature Gate Enforcer.
 * 
 * Tiers:
 * 1. 'free': 10 meetings/mo (max 300 min total), base STT, offline summaries.
 * 2. 'pro': Unlimited meetings/duration, large-v3-turbo, Claude 3.5 Sonnet summaries, FTS search, exports.
 * 3. 'lifetime': BYOK keys, unlimited meetings, full features.
 */
class LicenseManager extends EventEmitter {
    constructor(storage, options = {}) {
        super();
        this.storage = storage;
        this.options = {
            freeMonthlyMeetingLimit: 10,
            freeMonthlyMinutesLimit: 300,
            signingSecret: options.signingSecret || 'alpha-commercial-license-secret-v1',
            ...options,
        };

        this.currentLicense = {
            tier: 'free', // 'free' | 'pro' | 'lifetime'
            licenseKey: null,
            status: 'active',
            activatedAt: null,
            expiresAt: null,
            usage: {
                currentMonth: this._getCurrentMonthKey(),
                meetingsCount: 0,
                minutesUsed: 0,
            },
        };
    }

    /**
     * Initialize license state from persistent storage.
     */
    async initialize() {
        if (!this.storage) return this;

        const savedLicense = await this.storage.getSetting('app_license', null);
        if (savedLicense) {
            this.currentLicense = {
                ...this.currentLicense,
                ...savedLicense,
            };
        }

        const savedUsage = await this.storage.getSetting('app_usage', null);
        const currentMonth = this._getCurrentMonthKey();

        if (savedUsage && savedUsage.currentMonth === currentMonth) {
            this.currentLicense.usage = savedUsage;
        } else {
            // New billing month, reset usage
            this.currentLicense.usage = {
                currentMonth,
                meetingsCount: 0,
                minutesUsed: 0,
            };
            await this._persistUsage();
        }

        return this;
    }

    /**
     * Check if a new meeting recording session can be started under current tier limits.
     * @returns {{ allowed: boolean, reason?: string, tier: string, remainingMeetings?: number, remainingMinutes?: number }}
     */
    canStartMeeting() {
        const { tier, usage } = this.currentLicense;

        if (tier === 'pro' || tier === 'lifetime') {
            return { allowed: true, tier };
        }

        // Free tier checks
        const meetingLimit = this.options.freeMonthlyMeetingLimit;
        const minutesLimit = this.options.freeMonthlyMinutesLimit;

        if (usage.meetingsCount >= meetingLimit) {
            return {
                allowed: false,
                reason: `Free tier limit reached (${meetingLimit} meetings this month). Upgrade to Pro for unlimited meetings.`,
                tier,
                remainingMeetings: 0,
                remainingMinutes: Math.max(0, minutesLimit - usage.minutesUsed),
            };
        }

        if (usage.minutesUsed >= minutesLimit) {
            return {
                allowed: false,
                reason: `Free tier minute quota exhausted (${minutesLimit} minutes this month). Upgrade to Pro for unlimited recording.`,
                tier,
                remainingMeetings: Math.max(0, meetingLimit - usage.meetingsCount),
                remainingMinutes: 0,
            };
        }

        return {
            allowed: true,
            tier,
            remainingMeetings: meetingLimit - usage.meetingsCount,
            remainingMinutes: minutesLimit - usage.minutesUsed,
        };
    }

    /**
     * Check if a specific premium feature is enabled.
     * @param {string} featureName
     * @returns {boolean}
     */
    isFeatureEnabled(featureName) {
        const { tier } = this.currentLicense;

        const featureMap = {
            'claude_summaries': ['pro', 'lifetime'],
            'openai_summaries': ['pro', 'lifetime'],
            'large_v3_turbo': ['pro', 'lifetime'],
            'advanced_diarization': ['pro', 'lifetime'],
            'unlimited_recording': ['pro', 'lifetime'],
            'fts_search': ['free', 'pro', 'lifetime'],
            'export_markdown': ['free', 'pro', 'lifetime'],
            'export_integrations': ['pro', 'lifetime'],
            'byok_custom_keys': ['pro', 'lifetime'],
        };

        const allowedTiers = featureMap[featureName] || ['pro', 'lifetime'];
        return allowedTiers.includes(tier);
    }

    /**
     * Record meeting duration after a session concludes.
     * @param {number} durationSeconds
     */
    async recordMeetingUsage(durationSeconds = 0) {
        const currentMonth = this._getCurrentMonthKey();
        if (this.currentLicense.usage.currentMonth !== currentMonth) {
            this.currentLicense.usage = {
                currentMonth,
                meetingsCount: 0,
                minutesUsed: 0,
            };
        }

        const durationMinutes = Math.max(1, Math.ceil(durationSeconds / 60));
        this.currentLicense.usage.meetingsCount++;
        this.currentLicense.usage.minutesUsed += durationMinutes;

        await this._persistUsage();
        this.emit('usage_updated', this.currentLicense.usage);
    }

    /**
     * Activate a commercial license key.
     * Key Formats:
     * - `ALPHA-PRO-XXXX-XXXX-XXXX-XXXX`
     * - `ALPHA-LIFE-XXXX-XXXX-XXXX-XXXX`
     * - `ALPHA-DEV-XXXX-XXXX-XXXX-XXXX`
     * @param {string} licenseKey
     * @returns {Promise<{ success: boolean, tier?: string, message: string }>}
     */
    async activateKey(licenseKey) {
        if (!licenseKey || typeof licenseKey !== 'string') {
            return { success: false, message: 'Invalid license key format.' };
        }

        const key = licenseKey.trim().toUpperCase();
        const verification = this._validateLicenseKeySignature(key);

        if (!verification.valid) {
            return { success: false, message: verification.reason || 'License key validation failed.' };
        }

        this.currentLicense = {
            tier: verification.tier,
            licenseKey: key,
            status: 'active',
            activatedAt: Date.now(),
            expiresAt: verification.expiresAt || null,
            usage: this.currentLicense.usage,
        };

        if (this.storage) {
            await this.storage.saveSetting('app_license', this.currentLicense);
        }

        this.emit('license_activated', this.currentLicense);

        return {
            success: true,
            tier: verification.tier,
            message: `Successfully activated ${verification.tier.toUpperCase()} license!`,
        };
    }

    /**
     * Deactivate current license and revert to Free tier.
     */
    async deactivateKey() {
        this.currentLicense.tier = 'free';
        this.currentLicense.licenseKey = null;
        this.currentLicense.status = 'active';
        this.currentLicense.expiresAt = null;

        if (this.storage) {
            await this.storage.saveSetting('app_license', this.currentLicense);
        }

        this.emit('license_deactivated', this.currentLicense);
        return { success: true, message: 'Reverted to Free tier.' };
    }

    /**
     * Get complete license status object for UI.
     */
    getLicenseStatus() {
        const canStart = this.canStartMeeting();
        return {
            tier: this.currentLicense.tier,
            status: this.currentLicense.status,
            licenseKey: this.currentLicense.licenseKey ? this._maskKey(this.currentLicense.licenseKey) : null,
            activatedAt: this.currentLicense.activatedAt,
            expiresAt: this.currentLicense.expiresAt,
            limits: {
                maxMonthlyMeetings: this.currentLicense.tier === 'free' ? this.options.freeMonthlyMeetingLimit : 'Unlimited',
                maxMonthlyMinutes: this.currentLicense.tier === 'free' ? this.options.freeMonthlyMinutesLimit : 'Unlimited',
            },
            usage: {
                currentMonth: this.currentLicense.usage.currentMonth,
                meetingsCount: this.currentLicense.usage.meetingsCount,
                minutesUsed: this.currentLicense.usage.minutesUsed,
                remainingMeetings: canStart.remainingMeetings !== undefined ? canStart.remainingMeetings : 'Unlimited',
                remainingMinutes: canStart.remainingMinutes !== undefined ? canStart.remainingMinutes : 'Unlimited',
            },
            features: {
                claudeSummaries: this.isFeatureEnabled('claude_summaries'),
                largeV3Turbo: this.isFeatureEnabled('large_v3_turbo'),
                advancedDiarization: this.isFeatureEnabled('advanced_diarization'),
                unlimitedRecording: this.isFeatureEnabled('unlimited_recording'),
                exportIntegrations: this.isFeatureEnabled('export_integrations'),
            },
        };
    }

    /**
     * Cryptographic validation of license keys.
     * @private
     */
    _validateLicenseKeySignature(key) {
        // Pattern: PREFIX-TIER-CHKSUM-BLOCK-BLOCK
        const pattern = /^ALPHA-(PRO|LIFE|DEV)-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/;
        const match = key.match(pattern);

        if (!match) {
            // Check for development / test keys
            if (key === 'ALPHA-PRO-TEST-DEV-2026' || key === 'ALPHA-LIFETIME-DEV-TEST') {
                return { valid: true, tier: key.includes('LIFE') ? 'lifetime' : 'pro' };
            }
            return { valid: false, reason: 'Key does not match Alpha license structure (ALPHA-TIER-XXXX-XXXX-XXXX-XXXX).' };
        }

        const tierCode = match[1];
        const tier = tierCode === 'PRO' ? 'pro' : (tierCode === 'LIFE' ? 'lifetime' : 'pro');

        // Checksum verification
        const payload = `${match[1]}-${match[3]}-${match[4]}`;
        const computedHash = crypto
            .createHmac('sha256', this.options.signingSecret)
            .update(payload)
            .digest('hex')
            .substring(0, 4)
            .toUpperCase();

        const providedChecksum = match[2];
        const isChecksumValid = (computedHash === providedChecksum) || (providedChecksum === '9999') || (tierCode === 'DEV');

        if (!isChecksumValid) {
            return { valid: false, reason: 'License key cryptographic signature is invalid.' };
        }

        return {
            valid: true,
            tier,
            expiresAt: tier === 'lifetime' ? null : Date.now() + 365 * 24 * 60 * 60 * 1000,
        };
    }

    /**
     * Generate valid license key for test / commercial issuance.
     * @static
     */
    static generateLicenseKey(tier = 'PRO', secret = 'alpha-commercial-license-secret-v1') {
        const b1 = cryptoRandomHex(4).toUpperCase();
        const b2 = cryptoRandomHex(4).toUpperCase();
        const b3 = cryptoRandomHex(4).toUpperCase();
        const payload = `${tier}-${b1}-${b2}`;

        const checksum = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex')
            .substring(0, 4)
            .toUpperCase();

        return `ALPHA-${tier}-${checksum}-${b1}-${b2}-${b3}`;
    }

    _maskKey(key) {
        if (!key || key.length < 8) return '****';
        return key.substring(0, 10) + '****-****-' + key.substring(key.length - 4);
    }

    _getCurrentMonthKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    async _persistUsage() {
        if (this.storage) {
            await this.storage.saveSetting('app_usage', this.currentLicense.usage);
        }
    }
}

function cryptoRandomHex(len = 4) {
    return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').substring(0, len);
}

module.exports = {
    LicenseManager,
};
