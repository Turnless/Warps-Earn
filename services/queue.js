const Queue = require('bull');
const fetch = require('node-fetch');
const Redis = require('ioredis');
require('dotenv').config();

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "8631881085:AAHTPWtPuA6x64z7rj4rMwiX5NCZe5uW1VY";
const { REDIS_OPTS } = require('./redis');

console.log(`📡 [Queue] Initializing Telegram notification queue on Redis...`);

// Bull creates 3 internal Redis connections. Use createClient so they all
// inherit the Upstash-compatible options (maxRetriesPerRequest: null, etc.)
const telegramQueue = new Queue('telegramNotifications', {
    createClient(type) {
        return new Redis(REDIS_URL, REDIS_OPTS);
    }
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
            removeOnFail: false
        }
    );
}

module.exports = {
    telegramQueue,
    sendTelegramMessageAsync
};
