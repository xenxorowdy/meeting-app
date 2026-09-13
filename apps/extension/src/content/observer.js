(() => {
    const ROLE_WORDS = ['you', 'me', 'host', 'co-host', 'cohost', 'guest', 'presenting', 'presentation', 'organiser', 'organizer'];
    const IGNORED_NAMES = ['you', 'me', 'everyone', 'meeting host', 'presentation', 'unknown'];
    const POLL_MS = 700;
    const HEARTBEAT_MS = 2500;
    const ACTIVITY_WINDOW_MS = 700;
    const ACTIVITY_MIN_HITS = 3;

    function tidyName(raw) {
        if (typeof raw !== 'string') return '';
        let name = raw.replace(/\s+/g, ' ').trim();
        for (let pass = 0; pass < 3; pass += 1) {
            const stripped = name
                .replace(/[([]([^)\]]*)[)\]]\s*$/, (match, inside) => {
                    const roles = inside
                        .split(',')
                        .map(part => part.trim().toLowerCase())
                        .filter(Boolean);
                    return roles.length > 0 && roles.every(role => ROLE_WORDS.includes(role)) ? '' : match;
                })
                .trim();
            if (stripped === name) break;
            name = stripped;
        }
        name = name.replace(/^[\s,;:•·\-–—]+/, '').replace(/[\s,;:•·\-–—]+$/, '');
        if (!/[\p{L}\p{N}]/u.test(name)) return '';
        if (name.length > 80) return '';
        if (IGNORED_NAMES.includes(name.toLowerCase())) return '';
        return name;
    }

    function observationFrom(entries) {
        const participants = [];
        const speaking = [];
        for (const entry of entries || []) {
            const name = tidyName(entry && entry.name);
            if (!name) continue;
            if (!participants.includes(name)) participants.push(name);
            if (entry.speaking && !speaking.includes(name)) speaking.push(name);
        }
        return { participants, speaking };
    }

    function sameObservation(left, right) {
        if (!left || !right) return false;
        const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
        return same(left.participants, right.participants) && same(left.speaking, right.speaking);
    }

    class ActivityTracker {
        constructor(windowMs = ACTIVITY_WINDOW_MS) {
            this.windowMs = windowMs;
            this.hits = new Map();
        }

        record(key, at = Date.now()) {
            if (!key) return;
            const seen = this.hits.get(key) || [];
            seen.push(at);
            this.hits.set(key, seen);
        }

        active(at = Date.now(), minHits = ACTIVITY_MIN_HITS) {
            let best = null;
            let bestCount = 0;
            let runnerUp = 0;
            for (const [key, seen] of this.hits) {
                const recent = seen.filter(stamp => at - stamp <= this.windowMs);
                if (recent.length === 0) {
                    this.hits.delete(key);
                    continue;
                }
                this.hits.set(key, recent);
                if (recent.length > bestCount) {
                    runnerUp = bestCount;
                    best = key;
                    bestCount = recent.length;
                } else if (recent.length > runnerUp) {
                    runnerUp = recent.length;
                }
            }
            if (bestCount < minHits || bestCount === runnerUp) return null;
            return best;
        }
    }

    function visible(element) {
        if (!element) return false;
        if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return false;
        const box = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
        if (box && box.width === 0 && box.height === 0) return false;
        return true;
    }

    function firstText(root, selectors) {
        for (const selector of selectors) {
            let match = null;
            try {
                match = root.matches && root.matches(selector) ? root : root.querySelector(selector);
            } catch {
                match = null;
            }
            if (!match) continue;
            const text = tidyName(match.getAttribute('data-self-name') || match.textContent || '');
            if (text) return text;
        }
        return '';
    }

    function speakingIn(tile, selectors) {
        for (const selector of selectors) {
            let matches = [];
            try {
                matches = Array.from(tile.querySelectorAll(selector));
                if (tile.matches && tile.matches(selector)) matches.push(tile);
            } catch {
                matches = [];
            }
            if (matches.some(visible)) return true;
        }
        return false;
    }

    function readEntries(profile) {
        const entries = [];
        for (const selector of profile.tiles) {
            let tiles = [];
            try {
                tiles = Array.from(document.querySelectorAll(selector));
            } catch {
                tiles = [];
            }
            for (const tile of tiles) {
                const name = firstText(tile, profile.name);
                if (!name) continue;
                entries.push({ name, speaking: speakingIn(tile, profile.speaking) });
            }
        }
        return entries;
    }

    function tileNameOf(node, profile) {
        if (!node || !node.closest) return '';
        for (const selector of profile.tiles) {
            let tile = null;
            try {
                tile = node.closest(selector);
            } catch {
                tile = null;
            }
            if (tile) return firstText(tile, profile.name);
        }
        return '';
    }

    function start(profile) {
        const runtime = globalThis.chrome && chrome.runtime && chrome.runtime.id ? chrome.runtime : null;
        if (!runtime) return;

        const tracker = new ActivityTracker();
        let options = { enabled: true, activityFallback: true };
        let lastSent = null;
        let lastSentAt = 0;

        chrome.storage.local.get({ enabled: true, activityFallback: true }).then(stored => {
            options = stored;
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            for (const [key, change] of Object.entries(changes)) {
                if (key in options) options[key] = change.newValue;
            }
        });

        const mutations = new MutationObserver(records => {
            if (!options.activityFallback) return;
            const at = Date.now();
            for (const record of records) {
                const target = record.target && record.target.nodeType === 1 ? record.target : record.target && record.target.parentElement;
                const name = tileNameOf(target, profile);
                if (name) tracker.record(name, at);
            }
        });
        mutations.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'aria-label', 'width', 'height'],
        });

        setInterval(() => {
            if (!options.enabled) return;
            const observation = observationFrom(readEntries(profile));
            if (observation.participants.length === 0) return;

            let method = observation.speaking.length > 0 ? 'indicator' : 'none';
            if (observation.speaking.length === 0 && options.activityFallback) {
                const active = tracker.active();
                if (active && observation.participants.includes(active)) {
                    observation.speaking = [active];
                    method = 'activity';
                }
            }

            const now = Date.now();
            if (sameObservation(observation, lastSent) && now - lastSentAt < HEARTBEAT_MS) return;
            lastSent = observation;
            lastSentAt = now;

            try {
                runtime.sendMessage({
                    type: 'alpha:observation',
                    payload: {
                        source: profile.source,
                        url: location.href,
                        method,
                        self: profile.self ? tidyName(profile.self()) : '',
                        participants: observation.participants,
                        speaking: observation.speaking,
                    },
                });
            } catch {
                mutations.disconnect();
            }
        }, POLL_MS);
    }

    const api = { tidyName, observationFrom, sameObservation, ActivityTracker, start };
    globalThis.AlphaNames = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
