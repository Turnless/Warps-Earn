const Redis = require('ioredis');
require('dotenv').config();

let REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// 🔒 Force TLS for Upstash Serverless Redis
// Upstash requires a secure connection, but Render often provides the string starting with "redis://"
if (REDIS_URL.includes('upstash.io') && REDIS_URL.startsWith('redis://')) {
    REDIS_URL = REDIS_URL.replace('redis://', 'rediss://');
}

// Mask password in Redis URL for safe logging
const maskedUrl = REDIS_URL.replace(/:([^@]+)@/, ':***@');
console.log(`📡 [Redis] Connecting to Redis at ${maskedUrl}...`);

// Upstash-compatible connection options
const REDIS_OPTS = {
    maxRetriesPerRequest: null,   // Required by Bull queue workers
    enableReadyCheck: false,       // Upstash serverless doesn't support CLIENT INFO
    family: 0,                     // Dual-stack DNS (IPv4 + IPv6)
    retryStrategy(times) {
        // Exponential backoff capped at 3 seconds
        return Math.min(times * 200, 3000);
    },
    reconnectOnError(err) {
        // Auto-reconnect on transient socket resets (Upstash idles connections)
        return err.message.includes('ECONNRESET');
    },
    tls: REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
};

const redis = new Redis(REDIS_URL, REDIS_OPTS);

let hasLoggedConnect = false;
redis.on('connect', () => {
    if (!hasLoggedConnect) {
        console.log('📡 [Redis] Connected successfully.');
        hasLoggedConnect = true;
    }
});

redis.on('error', (err) => {
    // Only log non-transient errors to avoid flooding logs
    if (!err.message.includes('ECONNRESET')) {
        console.error('❌ [Redis] Connection error:', err.message);
    }
});

/**
 * Wraps a redis command so it can never hang a request.
 *
 * REDIS_OPTS sets maxRetriesPerRequest: null because Bull requires it. The side
 * effect is that when the connection is down ioredis queues commands
 * indefinitely — they never resolve and never reject — so an awaited command
 * silently stalls the HTTP request forever. Always go through this.
 */
function withTimeout(promise, timeoutMs = 3000) {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Redis operation timed out')), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

/** Runs a redis command, returning `fallback` instead of throwing or hanging. */
async function safely(promise, fallback = null, label = 'redis', timeoutMs = 3000) {
    try {
        return await withTimeout(promise, timeoutMs);
    } catch (err) {
        console.error(`⚠️ [Redis] ${label} unavailable:`, err.message);
        return fallback;
    }
}

/**
 * Runs a redis command without making the caller wait for it.
 * For bookkeeping — audit entries, cache purges, counters — where the user's
 * response should not be delayed by a slow or dead cache.
 */
function fireAndForget(promise, label = 'redis') {
    safely(promise, null, label, 2000).catch(() => {});
}

// Export both the client instance, options, and secure URL (for Bull queue reuse)
module.exports = redis;
module.exports.REDIS_OPTS = REDIS_OPTS;
module.exports.REDIS_URL = REDIS_URL;
module.exports.withTimeout = withTimeout;
module.exports.safely = safely;
module.exports.fireAndForget = fireAndForget;
