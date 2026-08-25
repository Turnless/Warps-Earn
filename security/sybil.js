const crypto = require('crypto');
const User = require('../models/User');

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
            .createHash('sha256')
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
    isDeviceFingerprintFlagged
};