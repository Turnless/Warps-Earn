const redis = require('./redis');
const { REDIS_OPERATION_TIMEOUT_MS, DEFAULT_REWARD_PER_AD, STREAK_BONUS_REWARD } = require('../constants');

// Global settings change only when an admin saves them, but they are read on
// every request (globalEcosystemCheck) and on every ad claim. On a
// pay-per-request Redis that was one command per hit for data that almost never
// changes, so hold a short in-process cache.
//
// Note: each server process keeps its own copy, so an admin change takes up to
// TTL_MS to reach every instance.
const TTL_MS = 30 * 1000;

const DEFAULTS = {
    maintenance: false,
    withdrawals: true,
    reward_per_ad: DEFAULT_REWARD_PER_AD,
    streak_reward: STREAK_BONUS_REWARD
};

let cache = { value: null, expiresAt: 0 };
// Survives both TTL expiry and explicit invalidation. Once we have seen real
// settings we never flap back to defaults on a Redis outage — defaults would,
// for example, silently switch maintenance mode off.
let lastKnownGood = null;

function withTimeout(promise, timeoutMs = REDIS_OPERATION_TIMEOUT_MS) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Redis operation timed out')), timeoutMs)
        )
    ]);
}

/**
 * Returns the global settings object, served from the in-process cache when warm.
 * Falls back to defaults if Redis is unavailable so a Redis outage cannot take
 * the whole app down.
 */
async function getGlobalSettings() {
    if (cache.value && Date.now() < cache.expiresAt) return cache.value;

    try {
        const settingsStr = await withTimeout(redis.get('global_settings'));
        const settings = settingsStr ? { ...DEFAULTS, ...JSON.parse(settingsStr) } : { ...DEFAULTS };
        cache = { value: settings, expiresAt: Date.now() + TTL_MS };
        lastKnownGood = settings;
        return settings;
    } catch (err) {
        if (lastKnownGood) {
            console.error('⚠️ [Settings] Redis unavailable, serving last known settings:', err.message);
            return lastKnownGood;
        }
        console.error('⚠️ [Settings] Redis unavailable and no cached copy, using defaults:', err.message);
        return { ...DEFAULTS };
    }
}

/** Call after an admin writes new settings so this process picks them up at once. */
function invalidateGlobalSettings() {
    cache = { value: null, expiresAt: 0 };
}

module.exports = { getGlobalSettings, invalidateGlobalSettings, GLOBAL_SETTINGS_DEFAULTS: DEFAULTS };
