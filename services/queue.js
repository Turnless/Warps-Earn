const Queue = require('bull');
const fetch = require('node-fetch');
const Redis = require('ioredis');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const { REDIS_OPTS, REDIS_URL } = require('./redis');

// Upper bound on failed jobs retained in Redis for debugging.
const MAX_RETAINED_FAILED_JOBS = 500;

console.log(`📡 [Queue] Initializing Telegram notification queue on Redis...`);

// Bull creates 3 internal Redis connections. Use createClient so they all
// inherit the Upstash-compatible options (maxRetriesPerRequest: null, etc.)
// Bull polls Redis continuously even with an empty queue. On a pay-per-request
// Redis (Upstash) the defaults cost ~89,000 commands/day with zero users, which
// exhausts a 500k/month quota in under 6 days. These intervals cut that by ~98%
// without delaying jobs: Bull still sets a precise timer for the next delayed
// job, and a blocking BRPOPLPUSH still wakes the instant a job is pushed.
const QUEUE_SETTINGS = {
    guardInterval: 300000,    // delayed-set safety sweep (default 5000)
    stalledInterval: 300000,  // stalled-job check (default 30000)
    drainDelay: 60            // blocking pop timeout in seconds (default 5)
};

const telegramQueue = new Queue('telegramNotifications', {
    createClient(type) {
        return new Redis(REDIS_URL, REDIS_OPTS);
    },
    settings: QUEUE_SETTINGS
});

// Register error listener to prevent unhandled Redis connection reset crashes
telegramQueue.on('error', (err) => {
    if (!err.message.includes('ECONNRESET')) {
        console.error('⚠️ [Queue] Bull queue connection error:', err.message);
    }
});


// Worker processor to handle outbound notifications
telegramQueue.process(async (job) => {
    const { type, payload } = job.data;
    console.log(`📡 [Queue Worker] Processing job ${job.id} of type: ${type}`);

    const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    try {
        if (type === 'sendMessage') {
            const response = await fetch(telegramUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (!result.ok) {
                throw new Error(`Telegram API Error: ${result.description}`);
            }
            console.log(`✅ [Queue Worker] Message sent successfully to ${payload.chat_id}`);
            return result;
        } else {
            throw new Error(`Unknown job type: ${type}`);
        }
    } catch (error) {
        console.error(`❌ [Queue Worker] Job failed (Attempt ${job.attemptsMade + 1}):`, error.message);
        throw error;
    }
});

// Helper function to enqueue Telegram messages
async function sendTelegramMessageAsync(chatId, text, options = {}, delayMs = 0) {
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: options.parse_mode || "HTML",
        ...options
    };

    console.log(`📡 [Queue] Enqueuing Telegram message to ${chatId} (delay: ${delayMs}ms)`);
    return await telegramQueue.add(
        { type: 'sendMessage', payload },
        {
            delay: delayMs,
            attempts: 5,
            backoff: {
                type: 'exponential',
                delay: 5000
            },
            removeOnComplete: true,
            // Failed jobs were retained forever. Every user who blocks the bot
            // leaves a permanent job in Redis, which is what fills Upstash.
            // Keep a bounded window for debugging instead.
            removeOnFail: MAX_RETAINED_FAILED_JOBS
        }
    );
}

module.exports = {
    telegramQueue,
    sendTelegramMessageAsync
};
