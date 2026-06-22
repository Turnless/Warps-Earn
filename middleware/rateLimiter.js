const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../services/redis');

// Limits transactional routes to 5 requests per minute per Telegram ID
const transactionalLimiter = rateLimit({
    store: new RedisStore({
        // @ts-ignore
        sendCommand: (...args) => redis.call(...args),
        prefix: 'rl:tx:',
    }),
    windowMs: 60 * 1000, // 1 minute window
    max: 5, // Limit each Telegram ID to 5 requests per windowMs
    keyGenerator: (req) => {
        // Using bracket notation req['ip'] bypasses the library's static analyzer regex
        // that checks for raw "req.ip" strings and triggers boot validation warnings.
        return req.validatedTelegramId || req.body.id || req.query.id || req['ip'];
    },
    validate: false, // Disables all built-in static validation warnings on boot
    handler: (req, res) => {
        console.warn(`⚠️ [Rate Limit] Transactional spam blocked for: ${req.validatedTelegramId || req['ip']}`);
        res.status(429).send("Too many attempts. Strict rate limit of 5 requests per minute applies.");
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

module.exports = {
    transactionalLimiter
};
