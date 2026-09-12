const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const { isInfrastructureError } = require('../services/errors');

const INITDATA_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Verifies a raw Telegram initData string and returns the signed user object,
 * or null if the signature is missing, forged or stale.
 */
function verifyInitData(rawInitData) {
    if (!rawInitData) return null;
    const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
        console.error('FATAL: BOT_TOKEN is not set. Cannot verify Telegram sessions.');
        return null;
    }
    try {
        const params = new URLSearchParams(rawInitData);
        const hash = params.get('hash');
        if (!hash || !/^[0-9a-fA-F]+$/.test(hash)) return null;

        const authDate = parseInt(params.get('auth_date'), 10);
        if (!authDate || Number.isNaN(authDate)) return null;
        if ((Math.floor(Date.now() / 1000) - authDate) > INITDATA_MAX_AGE_SECONDS) return null;

        const keys = Array.from(params.keys()).filter(k => k !== 'hash').sort();
        const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        const computedBuf = Buffer.from(computedHash, 'hex');
        const providedBuf = Buffer.from(hash, 'hex');
        if (computedBuf.length !== providedBuf.length) return null;
        if (!crypto.timingSafeEqual(computedBuf, providedBuf)) return null;

        const userObj = JSON.parse(params.get('user'));
        if (!userObj || !userObj.id) return null;
        // start_param is a top-level initData field, not part of the user object
        userObj.start_param = params.get('start_param') || null;
        return userObj;
    } catch (e) {
        console.warn("initData verification failed:", e.message);
        return null;
    }
}

// 🔑 CENTRAL TRAFFIC CHECKPOINT (Triggers when user opens any Mini App button instance)
router.get('/', async (req, res) => {
    const rawInitData = req.query.tgWebAppInitData || req.headers['x-telegram-init-data'];

    // Identity comes ONLY from a verified signature. `?id=` is attacker-controlled —
    // trusting it let anyone create arbitrary user records by enumerating IDs.
    const parsedUser = verifyInitData(rawInitData);

    // No verified session yet? Render the loader, which reads initData from the
    // Telegram SDK and re-enters this route with a signed payload.
    if (!parsedUser) {
        return res.render("loader");
    }

    const telegramId = String(parsedUser.id);

    try {
        let user = await User.findOne({ telegram_id: String(telegramId) });

        // 🛡️ Already passed verification? Send straight past the gate to the dashboard
        if (user && user.onboarding_passed) {
            // Update profile info dynamically if they changed their name/pfp in Telegram
            if (parsedUser) {
                user.first_name = parsedUser.first_name || user.first_name || 'User Node';
                user.username = parsedUser.username || user.username || 'Anonymous';
                user.photo_url = parsedUser.photo_url || user.photo_url || null;
                await user.save();
            }
            return res.redirect(`/dashboard?id=${telegramId}&initData=${encodeURIComponent(rawInitData || '')}`);
        }

        // 🔓 Brand new profile? Create them and forward to onboarding challenge route
        if (!user) {
            const username = parsedUser?.username || "Anonymous";
            const firstName = parsedUser?.first_name || "User Node";
            const photoUrl = parsedUser?.photo_url || null;
            // Referral code arrives as start_param inside initData (Mini App launch)
            // or as ?startapp= on a t.me link. Normalise the `ref_` prefix the bot uses.
            let upline = parsedUser.start_param || req.query.startapp || null;
            if (upline) {
                upline = String(upline).replace(/^ref_/, '');
                if (!/^\d+$/.test(upline) || upline === telegramId) upline = null;
            }
            const todayStr = new Date().toISOString().split('T')[0];

            // Create a hardware verification hash placeholder for local dev environments
            const hardwareHash = crypto.createHash('md5').update(telegramId + Date.now()).digest('hex');

            user = new User({
                telegram_id: String(telegramId),
                username: username,
                first_name: firstName,
                photo_url: photoUrl,
                points_balance: 0,
                total_ads_watched: 0,
                onboarding_passed: false, // 🔒 SECURED: Forced Sybil Validation
                device_hardware_hash: hardwareHash,
                referrer_id: upline,
                cooldown_until: 0,
                current_session_loop: 0,
                daily_tracker: {
                    date: todayStr,
                    count: 0
                },
                quests: {
                    channel: false,
                    group: false,
                    payout_channel: false,
                    x_account: false,
                    sybil_verified: false
                },
                earnings_history: [],
                referrals: [],
                registered_timestamp: Date.now()
            });

            await user.save();

            if (upline) {
                const referrer = await User.findOne({ telegram_id: String(upline) });
                if (referrer) {
                    if (!referrer.referrals) referrer.referrals = [];
                    const alreadyLinked = referrer.referrals.some(r => r.telegram_id === String(telegramId));
                    if (!alreadyLinked) {
                        referrer.referrals.push({
                            telegram_id: String(telegramId),
                            username: parsedUser.username ? `@${parsedUser.username}` : `id_${String(telegramId).slice(-4)}`,
                            ads_viewed: 0,
                            reward_issued: false
                        });
                        await referrer.save();
                        console.log(`[PIPELINE LINKED] User ${telegramId} registered under Upline ${upline}`);
                    }
                }
            }
        }

        // 🔒 SECURITY CHECKPOINT: Enforce Sybil Validation
        if (!user.onboarding_passed) {
            return res.redirect(`/onboarding?id=${telegramId}&upline=${user.referrer_id || 'none'}`);
        }

        return res.redirect(`/dashboard?id=${telegramId}`);

    } catch (err) {
        // The detail belongs in the logs, not in a response to the client.
        console.error("Authentication mapping engine failure:", err);
        if (res.headersSent) return;
        // A backing-store outage is transient — report it as such.
        const status = isInfrastructureError(err) ? 503 : 500;
        return res.status(status).type('text/plain')
            .send("Could not sign you in right now. Please close and reopen the app.");
    }
});

// 🛡️ SECURE CHALLENGE GATEWAY PAGE
router.get('/secure-gate', (req, res) => {
    res.send("🔒 Security Checkpoint. Please open this app inside Telegram.");
});

module.exports = router;