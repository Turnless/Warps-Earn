const Redis = require('ioredis');
require('dotenv').config();

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

console.log(`📡 [Redis] Connecting to Redis at ${REDIS_URL}...`);

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
    tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
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

// Export both the client instance and the options (for Bull queue reuse)
module.exports = redis;
module.exports.REDIS_OPTS = REDIS_OPTS;
