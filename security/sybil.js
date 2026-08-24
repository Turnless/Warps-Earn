const crypto = require('crypto');
const User = require('../models/User');

function verifyTelegramSignature(initDataString, botToken) {
    if (!initDataString) return false;
    try {
        const urlParams = new URLSearchParams(initDataString);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        const dataCheckArr = [];
        for (const [key, value] of urlParams.entries()) {
            dataCheckArr.push(`${key}=${value}`);
        }
        dataCheckArr.sort();
        const dataCheckString = dataCheckArr.join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const localHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        // Constant-time comparison to prevent timing attacks
        const localBuf = Buffer.from(localHash, 'hex');
        const providedBuf = Buffer.from(hash, 'hex');
        return localBuf.length === providedBuf.length && crypto.timingSafeEqual(localBuf, providedBuf);
    } catch (e) {
        return false;
    }
}

/**
 * Advanced Multi-Account Device Interceptor:
 * Evaluates hardware profiles, incoming hashes, and database entries to stop double registration.
 */
async function isDeviceFingerprintFlagged(req, telegramId, browserFingerprint) {
    try {
        // Gather background device traits provided by Express headers
        const userAgent = req.headers['user-agent'] || 'unknown-device';
        const acceptLanguage = req.headers['accept-language'] || 'unknown-lang';
        
        // Build a deterministic hardware device signature cluster hash
        const hardwareSignatureHash = crypto
            .createHash('md5')
            .update(`${userAgent}_${acceptLanguage}`)
            .digest('hex');

        console.log(`[Sybil Check] Examining Hardware Signature: ${hardwareSignatureHash} for ID: ${telegramId}`);

        // 1. DATABASE CHECK: Look for matching hardware configuration records already stored
        const deviceMatchInDb = await User.findOne({ 
            device_hardware_hash: hardwareSignatureHash,
            telegram_id: { $ne: String(telegramId) }
        });
        if (deviceMatchInDb) {
            console.log(`⚠️ Sybil Warning: Device signature matches existing database profile ${deviceMatchInDb.telegram_id}. Permitting access to avoid false positives on identical device models.`);
            // Removed strict return true; to avoid false positives on identical phone models
        }

        // 2. BROWSER FINGERPRINT STORAGE CHECK (If it survived account switching)
        // Checks the persistent localStorage token from the client
        if (browserFingerprint && browserFingerprint.startsWith('fp_')) {
            const fingerprintExists = await User.findOne({
                device_fingerprint: browserFingerprint,
                telegram_id: { $ne: String(telegramId) }
            });
            if (fingerprintExists) {
                console.log(`❌ Sybil Blocked: Browser fingerprint matches profile ${fingerprintExists.telegram_id}`);
                return true;
            }
        }

        // Save this validated hardware pattern to request metadata so auth.js can record it
        req.validatedHardwareHash = hardwareSignatureHash;
        return false;
    } catch (e) {
        console.error("Sybil layer validation processing exception:", e);
        return false;
    }
}

module.exports = {
    verifyTelegramSignature,
    isDeviceFingerprintFlagged
};