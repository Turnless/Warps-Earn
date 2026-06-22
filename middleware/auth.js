/* STREAMING_CHUNK: Building cryptographic validation check for Telegram signatures */
const crypto = require('crypto');
require('dotenv').config();

/**
 * Express Middleware to validate Telegram WebApp initData signatures.
 * Prevents endpoint spoofing, IDOR, and unauthorized point farming.
 */
function verifyTelegramWebAppData(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('WebApp ')) {
        return res.status(401).send("Unauthorized: Missing secure session handshake header.");
    }

    // Extract the raw query string from the authorization header
    const initData = authHeader.substring(7); 
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if (!hash) {
        return res.status(401).send("Unauthorized: Invalid cryptographic parameters.");
    }

    // 1. Sort all key-value parameters alphabetically (excluding 'hash')
    const keys = Array.from(params.keys()).filter(key => key !== 'hash').sort();
    const dataCheckString = keys.map(key => `${key}=${params.get(key)}`).join('\n');

    // 2. Derive secret key by hashing the Bot Token using "WebAppData" constant salt
    const botToken = process.env.TELEGRAM_BOT_TOKEN || "8631881085:AAHTPWtPuA6x64z7rj4rMwiX5NCZe5uW1VY";
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

    // 3. Compute expected hash signature
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // 4. Compare calculated hash signature with the client's provided hash
    if (computedHash !== hash) {
        return res.status(403).send("Forbidden: Cryptographic signature mismatch. Session tampered.");
    }

    // 5. Parse the user object safely from the data string
    try {
        const userObj = JSON.parse(params.get('user'));
        // Bind the validated user identity permanently to the request context
        req.validatedTelegramId = String(userObj.id);
        
        // CRITICAL SECURITY ENFORCEMENT: Override body parameters with verified values
        if (req.body && req.body.id) {
            req.body.id = req.validatedTelegramId; 
        }
        if (req.body && req.body.telegram_id) {
            req.body.telegram_id = req.validatedTelegramId;
        }
    } catch (err) {
        return res.status(400).send("Bad Request: Malformed session payload.");
    }

    // Handover control to endpoint route controller
    next();
}

module.exports = verifyTelegramWebAppData;
