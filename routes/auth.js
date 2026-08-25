const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');

// 🔑 CENTRAL TRAFFIC CHECKPOINT (Triggers when user opens any Mini App button instance)
router.get('/', async (req, res) => {
    let telegramId = req.query.id;
    let parsedUser = null;
    let rawInitData = req.query.tgWebAppInitData || req.headers['x-telegram-init-data'];

    // 💡 THE GLOBAL BUTTON FIX: If id parameter is missing from the query string
    try {
        if (rawInitData) {
            const urlParams = new URLSearchParams(rawInitData);
            const userObj = JSON.parse(urlParams.get('user'));
            if (userObj && userObj.id) {
                telegramId = String(userObj.id);
                parsedUser = userObj; // Save user context details (pfp, username, names)
            }
        }
    } catch (e) {
        console.warn("Global tracking identity evaluation skipped:", e.message);
    }

    // Fallback block if everything is completely empty (e.g. opened via t.me/bot/app direct link)
    if (!telegramId) {
        return res.render("loader");
    }

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
            const upline = req.query.startapp || null; // Capture invitation referral code if present
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
        }

        // 🔒 SECURITY CHECKPOINT: Enforce Sybil Validation
        if (!user.onboarding_passed) {
            return res.redirect(`/onboarding?id=${telegramId}&upline=${user.referrer_id || 'none'}`);
        }

        return res.redirect(`/dashboard?id=${telegramId}`);

    } catch (err) {
        console.error("Authentication mapping engine failure:", err);
        // Surface the actual error in logs and response for debugging
        const detail = err.message || 'Unknown error';
        return res.status(500).send(`Authentication engine tracking fault: ${detail}`);
    }
});

// 🛡️ SECURE CHALLENGE GATEWAY PAGE
router.get('/secure-gate', (req, res) => {
    res.send("🔒 Security Checkpoint. Please open this app inside Telegram.");
});

module.exports = router;