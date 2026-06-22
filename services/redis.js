const Redis = require('ioredis');
require('dotenv').config();

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

console.log(`📡 [Redis] Connecting to Redis at ${REDIS_URL}...`);

// maxRetriesPerRequest is set to null because it is required by Bull queue workers
const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null
});

redis.on('connect', () => {
    console.log('📡 [Redis] Connected successfully.');
});

redis.on('error', (err) => {
    console.error('❌ [Redis] Connection error:', err.message);
});

module.exports = redis;
