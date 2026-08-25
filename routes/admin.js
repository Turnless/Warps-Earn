const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const Withdrawal = require('../models/Withdrawal');
const redis = require('../services/redis');
const { sendTelegramMessageAsync, telegramQueue } = require('../services/queue');

// Import environment parameters securely
require('dotenv').config();

// Pull system authentication values
const ADMIN_SECRET_SIGNATURE = process.env.ADMIN_SECRET_SIGNATURE;
if (!ADMIN_SECRET_SIGNATURE) {
    console.error('FATAL: ADMIN_SECRET_SIGNATURE environment variable is not set. Admin auth will fail.');
}
const PUBLIC_PAYOUT_CHANNEL_ID = process.env.PUBLIC_PAYOUT_CHANNEL_ID || '@WarpsEarn';

// Shared business logic constants
const {
    PTS_TO_USD_RATE, USD_TO_NGN_RATE, MS_PER_DAY, QUEST_REWARD_PTS,
    DEFAULT_REWARD_PER_AD, STREAK_BONUS_REWARD, ADMIN_TELEGRAM_CHAT_ID,
    ADMIN_SESSION_MAX_AGE_MS, ADMIN_PENDING_WITHDRAWALS_LIMIT, ADMIN_LEADERBOARD_LIMIT,
    ADMIN_SYBIL_CLUSTERS_LIMIT, ADMIN_QUEUE_DEBUG_LIMIT, MAX_QUEST_SUBMISSIONS_LOG,
    DEFAULT_QUEST_TIMER_HOURS, BROADCAST_DELAY_MS_PER_USER, WAKEUP_PUSH_DELAY_MS_PER_USER,
    MAX_BOUNTY_STRIKES, DEFAULT_STORE_CONFIG, DEFAULT_STARS_CONFIG
} = require('../constants');

// 🛡️ HTML SANITIZER FOR TELEGRAM COMPATIBILITY
function escapeTelegramHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Format formatted ledger timestamps
function getFormattedDateTime() {
    const optionsDate = { month: 'short', day: 'numeric', year: 'numeric' };
    const optionsTime = { hour: '2-digit', minute: '2-digit', hour12: true };
    const dateStr = new Date().toLocaleDateString('en-US', optionsDate);
    const timeStr = new Date().toLocaleTimeString('en-US', optionsTime);
    return `${dateStr} • ${timeStr}`;
}

// --- 🛡️ AUTHENTICATION MIDDLEWARE ---
// Session-based auth: verify random token from Redis, never raw password
const checkAdminAuth = async (req, res, next) => {
    // 1. Check for HMAC-signed payout token (from Telegram inline buttons)
    const signedToken = req.query.token;
    if (signedToken) {
        try {
            const [payload, sig] = signedToken.split('.');
            const expectedSig = crypto
                .createHmac('sha256', ADMIN_SECRET_SIGNATURE)
                .update(payload)
                .digest('hex');
            const sigBuf = Buffer.from(sig, 'hex');
            const expectedBuf = Buffer.from(expectedSig, 'hex');
            if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
                const data = JSON.parse(Buffer.from(payload, 'base64').toString());
                if (data.exp && Date.now() < data.exp) {
                    req.signedPayoutAction = data;
                    return next();
                }
            }
        } catch (e) { /* fall through to session check */ }
    }

    // 2. Check session cookie (random token stored in Redis)
    let sessionToken = null;
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        const match = cookies.find(c => c.startsWith('admin_session='));
        if (match) sessionToken = match.split('=')[1];
    }
    
    if (sessionToken) {
        const sessionData = await redis.get(`admin:session:${sessionToken}`);
        if (sessionData) {
            // Generate CSRF token for this session if not exists
            let csrfCookie = null;
            if (req.headers.cookie) {
                const csrfMatch = req.headers.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('admin_csrf='));
                if (csrfMatch) csrfCookie = csrfMatch.split('=')[1];
            }
            if (!csrfCookie) {
                const csrfToken = crypto.randomBytes(32).toString('hex');
                await redis.setex(`admin:csrf:${sessionToken}`, 86400, csrfToken);
                res.cookie('admin_csrf', csrfToken, { maxAge: ADMIN_SESSION_MAX_AGE_MS, httpOnly: false, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
            }
            return next();
        }
    }
    
    // If not authenticated, redirect to login page
    res.redirect('/admin/login');
};

// --- 🛡️ CSRF VERIFICATION MIDDLEWARE ---
const verifyCsrfToken = async (req, res, next) => {
    // Only enforce CSRF on state-changing methods
    if (req.method !== 'POST') return next();

    // Parse cookies manually (no cookie-parser middleware)
    let sessionToken = null;
    if (req.headers.cookie) {
        const sessionMatch = req.headers.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('admin_session='));
        if (sessionMatch) sessionToken = sessionMatch.split('=')[1];
    }
    const csrfToken = req.body?._csrf || req.headers['x-csrf-token'];

    if (!sessionToken || !csrfToken) {
        return res.status(403).send("Forbidden: Missing CSRF token.");
    }

    const storedToken = await redis.get(`admin:csrf:${sessionToken}`);
    if (!storedToken || storedToken !== csrfToken) {
        return res.status(403).send("Forbidden: Invalid CSRF token.");
    }

    // Remove CSRF from body before processing
    delete req.body._csrf;
    next();
};

// --- 📝 ADMIN AUDIT LOGGING ---
async function logAdminAction(action, details = {}) {
    try {
        const entry = JSON.stringify({
            action,
            ...details,
            timestamp: new Date().toISOString()
        });
        await redis.lpush('admin:audit_log', entry);
        await redis.ltrim('admin:audit_log', 0, 499); // Keep last 500 entries
    } catch (e) {
        console.warn('[Audit Log] Failed to write:', e.message);
    }
}

// --- 🔐 LOGIN SYSTEM ---
router.get('/login', (req, res) => {
    res.render('admin_login');
});

router.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
    const { password } = req.body;
    const loginKey = `admin:login_attempts:${req.ip}`;

    // Check for brute force lockout (5 failed attempts → 15 min lockout)
    const attempts = await redis.get(loginKey);
    if (attempts && parseInt(attempts) >= 5) {
        return res.render('admin_login', { error: "Too many failed attempts. Try again in 15 minutes." });
    }

    if (password === ADMIN_SECRET_SIGNATURE) {
        // Clear failed attempts on successful login
        await redis.del(loginKey);
        // Generate random session token, store in Redis with 24h TTL
        const sessionToken = crypto.randomBytes(32).toString('hex');
        await redis.setex(`admin:session:${sessionToken}`, 86400, JSON.stringify({
            loginAt: new Date().toISOString(),
            ip: req.ip
        }));
        // Set session cookie (not the password!)
        res.cookie('admin_session', sessionToken, { maxAge: ADMIN_SESSION_MAX_AGE_MS, httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
        await logAdminAction('login', { ip: req.ip });
        return res.redirect('/admin');
    }

    // Track failed attempt (15 min window)
    const newAttempts = await redis.incr(loginKey);
    if (newAttempts === 1) {
        await redis.expire(loginKey, 900); // 15 min TTL
    }

    res.render('admin_login', { error: "Invalid Passphrase." });
});

router.get('/logout', async (req, res) => {
    // Invalidate session in Redis
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        const match = cookies.find(c => c.startsWith('admin_session='));
        if (match) {
            const token = match.split('=')[1];
            await redis.del(`admin:session:${token}`);
        }
    }
    res.clearCookie('admin_session');
    res.redirect('/admin/login');
});

// --- 🖥️ MAIN ADMIN DASHBOARD ---
router.get('/', checkAdminAuth, async (req, res) => {
    try {
        // Basic counts
        const totalUsers = await User.countDocuments();
        
        // Full pending list
        const pendingList = await Withdrawal.find({ status: 'Pending' }).sort({ created_at: -1 }).limit(ADMIN_PENDING_WITHDRAWALS_LIMIT).lean();
        const pendingCount = await Withdrawal.countDocuments({ status: 'Pending' });

        // Aggregate Financial Data
        const financeStats = await User.aggregate([
            {
                $group: {
                    _id: null,
                    totalCirculatingPts: { $sum: "$points_balance" },
                    totalAdsWatched: { $sum: "$total_ads_watched" }
                }
            }
        ]);

        const totalCirculating = financeStats.length > 0 ? financeStats[0].totalCirculatingPts : 0;
        const totalAdsWatched = financeStats.length > 0 ? financeStats[0].totalAdsWatched : 0;

        // Aggregate Earnings History precisely for exact breakdown
        const earningsStats = await User.aggregate([
            { $unwind: "$earnings_history" },
            {
                $group: {
                    _id: "$earnings_history.type",
                    totalAmount: { $sum: "$earnings_history.amount" }
                }
            }
        ]);

        let adEarnings = 0;
        let taskEarnings = 0;
        let referralEarnings = 0;

        earningsStats.forEach(stat => {
            const typeLower = stat._id.toLowerCase();
            if (typeLower.includes("stream reward") || typeLower.includes("ad reward") || typeLower.includes("loop")) {
                adEarnings += stat.totalAmount;
            } else if (typeLower.includes("quest") || typeLower.includes("protocol cleared") || typeLower.includes("promo") || typeLower.includes("follow")) {
                taskEarnings += stat.totalAmount;
            } else if (typeLower.includes("milestone") || typeLower.includes("referral")) {
                referralEarnings += stat.totalAmount;
            }
        });

        // Sum up total payouts that were successful
        const payoutStats = await Withdrawal.aggregate([
            { $match: { status: 'Successful' } },
            { $group: { _id: null, totalPaidOut: { $sum: "$amount_points" } } }
        ]);
        const totalPaidOut = payoutStats.length > 0 ? payoutStats[0].totalPaidOut : 0;

        // Fetch top 10 whales (Leaderboard feature)
        const topUsers = await User.find({}).sort({ points_balance: -1 }).limit(ADMIN_LEADERBOARD_LIMIT).lean();

        // 📊 NEW: Aggregate Country Stats
        const countryStatsRaw = await User.aggregate([
            { $group: { _id: "$country", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);
        
        const mergedCountryStats = {};
        countryStatsRaw.forEach(c => {
            let label = c._id;
            if (!label || label === "OTHER" || label.toLowerCase() === "unknown") {
                label = "Unknown";
            } else {
                label = label.toUpperCase();
            }
            mergedCountryStats[label] = (mergedCountryStats[label] || 0) + c.count;
        });

        const countryStats = Object.keys(mergedCountryStats)
            .map(country => ({ country, count: mergedCountryStats[country] }))
            .sort((a, b) => b.count - a.count);

        const settingsStr = await redis.get('global_settings');
        const settings = settingsStr ? JSON.parse(settingsStr) : {
            maintenance: false,
            withdrawals: true,
            reward_per_ad: DEFAULT_REWARD_PER_AD,
            streak_reward: STREAK_BONUS_REWARD
        };

        const questsStr = await redis.get('admin:dynamic_quests');
        const dynamicQuests = questsStr ? JSON.parse(questsStr) : {};

        // Fetch Ad Telemetry Data
        const telemetryStr = await redis.get('admin:ad_telemetry');
        const telemetry = telemetryStr ? JSON.parse(telemetryStr) : {};

        // Fetch pending bounty submissions
        const BountySubmission = require('../models/BountySubmission');
        const StoreOrder = require('../models/StoreOrder');
        const pendingBounties = await BountySubmission.find({ status: 'pending' }).sort({ created_at: -1 }).lean();
        const pendingStoreOrders = await StoreOrder.find({ status: 'pending' }).sort({ created_at: -1 }).lean();
        
        // Fetch pending X verifications
        const pendingXVerifications = await User.find({ x_verification_status: 'pending' }).sort({ _id: -1 }).limit(ADMIN_PENDING_WITHDRAWALS_LIMIT).lean();
        
        // Populate user details and bounty details manually for the view since it's NoSQL without direct population setup
        const Bounty = require('../models/Bounty');
        for (let sub of pendingBounties) {
            sub.user = await User.findOne({ telegram_id: sub.telegram_id }).lean() || {};
            sub.bounty = await Bounty.findById(sub.bounty_id).lean() || {};
        }

        for (let order of pendingStoreOrders) {
            order.user = await User.findOne({ telegram_id: order.telegram_id }).lean() || {};
        }

        const storeConfigStr = await redis.get('admin:store_config');
        const storeConfig = storeConfigStr ? JSON.parse(storeConfigStr) : {
            ...DEFAULT_STORE_CONFIG,
            ...DEFAULT_STARS_CONFIG,
            enable_cooldown: true,
            enable_multiplier: true,
            enable_premium: true,
            enable_gold: true
        };




        // Fetch recent quest submissions
        const questSubmissionsRaw = await redis.lrange('admin:quest_submissions', 0, MAX_QUEST_SUBMISSIONS_LOG - 1);
        const questSubmissions = questSubmissionsRaw.map(s => JSON.parse(s));

        res.render('admin_dashboard', { 
            stats: {
                users: totalUsers,
                pending: pendingCount,
                circulatingPts: totalCirculating,
                circulatingUsd: (totalCirculating * PTS_TO_USD_RATE).toFixed(2),
                adsWatched: totalAdsWatched,
                adEarnings: adEarnings,
                taskEarnings: taskEarnings,
                referralEarnings: referralEarnings,
                paidOutPts: totalPaidOut,
                paidOutUsd: (totalPaidOut * PTS_TO_USD_RATE).toFixed(2)
            },
            pendingList: pendingList,
            pendingBounties: pendingBounties,
            pendingStoreOrders: pendingStoreOrders,
            pendingXVerifications: pendingXVerifications,
            questSubmissions: questSubmissions,
            topUsers: topUsers,
            countryStats: countryStats,
            settings: settings,
            telemetry: telemetry,
            storeConfig: storeConfig,
            dynamicQuests: dynamicQuests
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("Metrics Engine Failed");
    }
});

// --- ⚙️ GLOBAL SETTINGS CONTROLLER ---
router.post('/settings', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { maintenance, withdrawals, reward_per_ad, streak_reward, auto_x_verify, x_api_key } = req.body;
        const newSettings = {
            maintenance: maintenance === 'on',
            withdrawals: withdrawals === 'on',
            auto_x_verify: auto_x_verify === 'on',
            x_api_key: x_api_key || '',
            reward_per_ad: parseInt(reward_per_ad) || DEFAULT_REWARD_PER_AD,
            streak_reward: parseInt(streak_reward) || STREAK_BONUS_REWARD
        };
        await redis.set('global_settings', JSON.stringify(newSettings));
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Failed to update settings");
    }
});

// --- 🛒 STORE CONFIG CONTROLLER ---
router.post('/store-config', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { 
            cooldown, multiplier, 
            premium_tier_1m, premium_tier_3m, premium_tier_6m, premium_tier_3m_blue, premium_tier_6m_blue, 
            gold_tier_1m, gold_tier_3m, gold_tier_6m, gold_tier_3m_blue, gold_tier_6m_blue, 
            stars_premium_1m, stars_premium_3m, stars_premium_6m, stars_premium_3m_blue, stars_premium_6m_blue,
            stars_gold_1m, stars_gold_3m, stars_gold_6m, stars_gold_3m_blue, stars_gold_6m_blue,
            stars_x_verify,
            enable_cooldown, enable_multiplier, enable_premium, enable_gold 
        } = req.body;
        const newConfig = {
            ...DEFAULT_STORE_CONFIG,
            ...DEFAULT_STARS_CONFIG,
            cooldown: parseInt(cooldown) || 500,
            multiplier: parseInt(multiplier) || 3000,
            premium_tier_1m: parseInt(premium_tier_1m) || 15000,
            premium_tier_3m: parseInt(premium_tier_3m) || 15000,
            premium_tier_6m: parseInt(premium_tier_6m) || 28000,
            premium_tier_3m_blue: parseInt(premium_tier_3m_blue) || 45000,
            premium_tier_6m_blue: parseInt(premium_tier_6m_blue) || 85000,
            gold_tier_1m: parseInt(gold_tier_1m) || 50000,
            gold_tier_3m: parseInt(gold_tier_3m) || 50000,
            gold_tier_6m: parseInt(gold_tier_6m) || 90000,
            gold_tier_3m_blue: parseInt(gold_tier_3m_blue) || 80000,
            gold_tier_6m_blue: parseInt(gold_tier_6m_blue) || 150000,
            stars_premium_1m: parseInt(stars_premium_1m) || 15,
            stars_premium_3m: parseInt(stars_premium_3m) || 25,
            stars_premium_6m: parseInt(stars_premium_6m) || 45,
            stars_premium_3m_blue: parseInt(stars_premium_3m_blue) || 50,
            stars_premium_6m_blue: parseInt(stars_premium_6m_blue) || 95,
            stars_gold_1m: parseInt(stars_gold_1m) || 50,
            stars_gold_3m: parseInt(stars_gold_3m) || 100,
            stars_gold_6m: parseInt(stars_gold_6m) || 180,
            stars_gold_3m_blue: parseInt(stars_gold_3m_blue) || 120,
            stars_gold_6m_blue: parseInt(stars_gold_6m_blue) || 220,
            stars_x_verify: parseInt(stars_x_verify) || 100,
            enable_cooldown: enable_cooldown === 'on',
            enable_multiplier: enable_multiplier === 'on',
            enable_premium: enable_premium === 'on',
            enable_gold: enable_gold === 'on'
        };
        await redis.set('admin:store_config', JSON.stringify(newConfig));
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Failed to update store config");
    }
});

// --- 🛒 STORE ORDERS CONTROLLER ---
router.post('/store-orders/action', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { order_id, action } = req.body;
        const StoreOrder = require('../models/StoreOrder');
        
        const order = await StoreOrder.findById(order_id);
        if (!order || order.status !== 'pending') return res.redirect('/admin');

        const user = await User.findOne({ telegram_id: order.telegram_id });
        if (!user) return res.redirect('/admin');

        if (action === 'approve') {
            order.status = 'completed';
            
            // Determine tier, months, and blue tick from order
            const itemKey = order.item_key;
            const isPremium = itemKey.includes('premium_tier');
            const isGold = itemKey.includes('gold_tier');
            const isXVerify = itemKey === 'x_verify';
            
            let months = 1;
            if (itemKey.includes('6m')) months = 6;
            else if (itemKey.includes('3m')) months = 3;
            
            if (isPremium || isGold) {
                user.account_tier = isPremium ? 'Premium' : 'Gold';
                const expDate = new Date();
                expDate.setMonth(expDate.getMonth() + months);
                user.tier_expiry = expDate;
                
                // Gold tier gets auto 2x multiplier
                if (isGold && (user.ad_multiplier || 1) < 2) {
                    user.ad_multiplier = 2;
                }
            }
            
            if (order.blue_tick || itemKey.includes('blue') || isXVerify) {
                user.x_blue_tick = true;
            }

            // Optional: Send Telegram DM to user letting them know it's approved
            try {
                const fetch = require('node-fetch');
                const tgToken = process.env.BOT_TOKEN;
                const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
                await fetch(tgUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: user.telegram_id, text: "🎉 Your order has been verified and approved!", parse_mode: 'Markdown' })
                });
            } catch (err) {}

        } else if (action === 'reject') {
            order.status = 'rejected';
            
            if (order.currency === 'stars' && order.telegram_payment_charge_id) {
                // Refund Telegram Stars
                try {
                    const fetch = require('node-fetch');
                    const tgToken = process.env.BOT_TOKEN;
                    const tgUrl = `https://api.telegram.org/bot${tgToken}/refundStarPayment`;
                    await fetch(tgUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_id: user.telegram_id, telegram_payment_charge_id: order.telegram_payment_charge_id })
                    });
                } catch (err) {
                    console.error("Failed to refund stars:", err);
                }
                if (!user.earnings_history) user.earnings_history = [];
                user.earnings_history.unshift({
                    type: `Refund: ${order.item_title} (Rejected)`,
                    amount: 0,
                    timestamp: getFormattedDateTime()
                });
            } else {
                // Refund user pts
                user.points_balance = (user.points_balance || 0) + order.cost;
                if (!user.earnings_history) user.earnings_history = [];
                user.earnings_history.unshift({
                    type: `Refund: ${order.item_title} (Rejected)`,
                    amount: order.cost,
                    timestamp: getFormattedDateTime()
                });
            }
            
            try {
                const fetch = require('node-fetch');
                const tgToken = process.env.BOT_TOKEN;
                const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
                await fetch(tgUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: user.telegram_id, text: "❌ Your recent order was rejected and refunded. Contact support if you have questions.", parse_mode: 'Markdown' })
                });
            } catch (err) {}
        }

        order.resolved_at = new Date();
        await order.save();
        await user.save();
        
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Action Failed");
    }
});

// --- 🎯 DYNAMIC QUESTS ENGINE ---
router.post('/quests', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { action, key, title, url, pts, icon, tier_required, target_countries, is_telegram, timer, requires_comment_link, max_participants } = req.body;
        const questsStr = await redis.get('admin:dynamic_quests');
        let quests = questsStr ? JSON.parse(questsStr) : {};

        if (action === 'create' && key && title && url && pts) {
            quests[key] = {
                title: title.trim(),
                url: url.trim(),
                pts: parseInt(pts) || 0,
                icon: (icon || "🔥").trim(),
                tier_required: tier_required || "Any",
                target_countries: target_countries ? target_countries.split(',').map(c => c.trim().toUpperCase()) : [],
                is_telegram: is_telegram === 'on',
                timer: parseInt(timer) || DEFAULT_QUEST_TIMER_HOURS,
                requires_comment_link: requires_comment_link === 'on',
                max_participants: parseInt(max_participants) || 0,
                current_participants: 0
            };
        } else if (action === 'delete' && key) {
            delete quests[key];
        }

        await redis.set('admin:dynamic_quests', JSON.stringify(quests));
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Failed to manage quests");
    }
});

// --- 🎯 APPROVE/REJECT QUEST SUBMISSION ---
router.post('/quests/action', checkAdminAuth, verifyCsrfToken, async (req, res) => {
    try {
        const { id, action } = req.body;
        if (!id || !action) return res.status(400).send("Missing parameters");

        const questSubmissionsRaw = await redis.lrange('admin:quest_submissions', 0, MAX_QUEST_SUBMISSIONS_LOG - 1);
        let targetSub = null;
        let subIndex = -1;
        
        const questSubmissions = questSubmissionsRaw.map((s, index) => {
            const parsed = JSON.parse(s);
            if (parsed.id === id) {
                targetSub = parsed;
                subIndex = index;
            }
            return parsed;
        });

        if (!targetSub) return res.status(404).send("Submission not found or already processed");

        const user = await User.findOne({ telegram_id: targetSub.telegram_id });
        if (!user) return res.status(404).send("User not found");

        if (action === 'approve') {
            user.points_balance = (user.points_balance || 0) + (targetSub.pts || 0);
            if (!user.earnings_history) user.earnings_history = [];
            user.earnings_history.unshift({
                type: user.custom_promos.get(targetSub.promoKey)?.title || targetSub.promoKey,
                amount: targetSub.pts || 0,
                timestamp: getFormattedDateTime()
            });
            user.custom_promos.set(targetSub.promoKey, { verified: true, link: targetSub.link });
            user.markModified('custom_promos');
        } else if (action === 'reject') {
            user.custom_promos.delete(targetSub.promoKey); // Let them try again
            user.markModified('custom_promos');
        }

        await user.save();
        
        // Invalidate cache so their dashboard updates instantly
        try {
            await redis.del(`user:${targetSub.telegram_id}:profile`);
        } catch (e) {
            console.warn("Failed to clear user cache", e);
        }

        // Remove from Redis list
        await redis.lrem('admin:quest_submissions', 1, questSubmissionsRaw[subIndex]);

        res.redirect('/admin');
    } catch (e) {
        console.error(e);
        res.status(500).send("Action failed");
    }
});

// --- 🔍 USER LOOKUP & BAN CONTROLLER ---
router.get('/user-lookup', checkAdminAuth, async (req, res) => {
    const rawQuery = (req.query.q || '').trim();
    if (!rawQuery) return res.redirect('/admin');

    const cleanQuery = rawQuery.replace(/^@/, ''); // Strip the @ symbol if they typed it

    // Escape special regex characters to prevent ReDoS injection
    const escapedQuery = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    try {
        // Search by Telegram ID (exact) OR Username (regex case-insensitive)
        const targetUser = await User.findOne({
            $or: [
                { telegram_id: cleanQuery },
                { username: new RegExp('^' + escapedQuery + '$', 'i') }
            ]
        }).lean();

        if (!targetUser) {
            return res.send(`<h2>User not found.</h2><a href="/admin">Back</a>`);
        }

        // Render a simple template string or you could use ejs. For speed, we'll return a basic page.
        // Or better yet, we can render admin_dashboard again but inject the targetUser
        // However, I will just return an HTML snippet for now since it's an admin panel.
        res.render('admin_user_view', { user: targetUser });
    } catch (e) {
        res.status(500).send("Lookup failed");
    }
});

router.post('/user-ban', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    const { telegram_id, action } = req.body;
    try {
        if (action === 'ban') {
            await User.updateOne({ telegram_id }, { is_banned: true });
            await logAdminAction('user_ban', { target: telegram_id });
        } else if (action === 'unban') {
            await User.updateOne({ telegram_id }, { is_banned: false });
            await logAdminAction('user_unban', { target: telegram_id });
        }
        res.redirect(`/admin/user-lookup?q=${telegram_id}`);
    } catch (e) {
        res.status(500).send("Action failed");
    }
});

router.post('/user-clear-activities', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    const { telegram_id } = req.body;
    try {
        await User.updateOne({ telegram_id }, {
            points_balance: 0,
            total_ads_watched: 0,
            withdrawals_count: 0,
            earnings_history: [],
            transactions: [],
            quests: {},
            custom_promos: {},
            referrals: []
        });
        res.redirect(`/admin/user-lookup?q=${telegram_id}`);
    } catch (e) {
        res.status(500).send("Action failed");
    }
});

router.post('/user-delete', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    const { telegram_id } = req.body;
    try {
        await User.deleteOne({ telegram_id });
        await redis.del(`user:${telegram_id}:profile`);
        await redis.del(`lock:claim:${telegram_id}`);
        await redis.del(`lock:payout:${telegram_id}`);
        await logAdminAction('user_delete', { target: telegram_id });
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Action failed");
    }
});

// --- 🛠️ DYNAMIC USER MANAGEMENT CONTROLLERS ---
router.post('/user-manage-balance', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    const { telegram_id, amount, reason } = req.body;
    try {
        const amt = parseInt(amount);
        if (isNaN(amt)) return res.redirect(`/admin/user-lookup?q=${telegram_id}`);

        const user = await User.findOne({ telegram_id });
        if (user) {
            user.points_balance = Math.max(0, (user.points_balance || 0) + amt);
            if (!user.earnings_history) user.earnings_history = [];
            user.earnings_history.unshift({
                type: `Admin Adjustment: ${reason || 'Manual'}`,
                amount: amt,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            await user.save();
            await redis.del(`user:${telegram_id}:profile`);
            await logAdminAction('balance_adjustment', { target: telegram_id, amount: amt, reason: reason || 'Manual' });
        }
        res.redirect(`/admin/user-lookup?q=${telegram_id}`);
    } catch (e) {
        res.status(500).send("Action failed");
    }
});

router.post('/user-x-verify', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    const { telegram_id, followers, blue_tick, tier } = req.body;
    try {
        const user = await User.findOne({ telegram_id });
        if (user) {
            user.x_followers = parseInt(followers) || 0;
            user.x_blue_tick = blue_tick === 'on';
            user.account_tier = tier || 'Standard';
            user.x_verification_status = 'verified';
            
            // Gold tier gets auto 2x multiplier
            if (tier === 'Gold' && (user.ad_multiplier || 1) < 2) {
                user.ad_multiplier = 2;
            }
            
            await user.save();
            await redis.del(`user:${telegram_id}:profile`);
            
            // Notify user of tier upgrade
            const msg = `🎉 *Account Tier Updated* 🎉\n\nYour account has been manually reviewed and placed in the *${user.account_tier} Tier*.\nFollowers: ${user.x_followers}\nBlue Tick: ${user.x_blue_tick ? 'Yes' : 'No'}`;
            try {
                const { sendTelegramMessageAsync } = require('../services/queue');
                await sendTelegramMessageAsync(telegram_id, msg, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error("Failed to notify user of tier change:", err);
            }
        }
        if (req.body.redirect_dashboard) {
            res.redirect('/admin');
        } else {
            res.redirect(`/admin/user-lookup?q=${telegram_id}`);
        }
    } catch (e) {
        res.status(500).send("Action failed");
    }
});

router.post('/user-reset-cooldown', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    const { telegram_id } = req.body;
    try {
        const user = await User.findOne({ telegram_id });
        if (user) {
            user.cooldown_until = 0;
            user.current_session_loop = 0;
            await user.save();
            await redis.del(`user:${telegram_id}:profile`);
        }
        res.redirect(`/admin/user-lookup?q=${telegram_id}`);
    } catch (e) {
        res.status(500).send("Action failed");
    }
});

// --- 📢 BROADCAST MESSAGE CONTROLLER ---
router.post('/broadcast', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    const { message_text } = req.body;
    try {
        if (!message_text) return res.redirect('/admin');
        const users = await User.find({}, { telegram_id: 1 }).lean();
        // Queue messages slightly spaced out to avoid Telegram API limits
        users.forEach((user, index) => {
            sendTelegramMessageAsync(user.telegram_id, message_text, {}, index * BROADCAST_DELAY_MS_PER_USER);
        });
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Broadcast failed");
    }
});

// --- ⏰ AUTOMATED WAKE-UP NOTIFICATIONS ---
router.post('/wakeup-push', checkAdminAuth, verifyCsrfToken, async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - MS_PER_DAY).toISOString().split('T')[0];
        
        // Find users who haven't logged in today or yesterday
        const inactiveUsers = await User.find({
            last_login_date: { $nin: [todayStr, yesterday, null] }
        }, { telegram_id: 1, username: 1, points_balance: 1 }).lean();

        inactiveUsers.forEach((user, index) => {
            const message = `👋 Hey @${user.username || 'there'}!\n\nIt's been a while since we saw you. You have ${user.points_balance || 0} PTS waiting for you! Come back and watch a few ads to claim your next payout! 💸`;
            sendTelegramMessageAsync(user.telegram_id, message, {}, index * WAKEUP_PUSH_DELAY_MS_PER_USER);
        });
        
        res.redirect('/admin');
    } catch (e) {
        console.error(e);
        res.status(500).send("Wakeup Push Failed");
    }
});

// --- 📄 CSV ACCOUNTING EXPORT ENDPOINTS ---
router.get('/export-users', checkAdminAuth, async (req, res) => {
    try {
        const users = await User.find({}).lean();
        
        // Define CSV Headers
        let csvContent = "Telegram ID,Username,First Name,Points Balance,Total Ads Watched,Withdrawals Count,Is Banned,Registered Date\n";
        
        users.forEach(u => {
            const dateStr = u.createdAt ? new Date(u.createdAt).toISOString() : "N/A";
            const row = `"${u.telegram_id}","${u.username}","${u.first_name || ''}",${u.points_balance},${u.total_ads_watched},${u.withdrawals_count || 0},${u.is_banned},"${dateStr}"`;
            csvContent += row + "\n";
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="warps_users_export.csv"');
        res.status(200).send(csvContent);
    } catch (err) {
        res.status(500).send("CSV Export Failed");
    }
});

router.get('/export-withdrawals', checkAdminAuth, async (req, res) => {
    try {
        const withdrawals = await Withdrawal.find({}).lean();
        
        let csvContent = "Transaction ID,Telegram ID,Username,Amount PTS,Asset,Bank Provider,Destination Details,Status,Created At\n";
        
        withdrawals.forEach(w => {
            const dateStr = w.created_at ? new Date(w.created_at).toISOString() : "N/A";
            const destClean = (w.destination_details || '').replace(/"/g, '""');
            const row = `"${w.id}","${w.telegram_id}","${w.username}",${w.amount_points},"${w.asset}","${w.bank_provider || ''}","${destClean}","${w.status}","${dateStr}"`;
            csvContent += row + "\n";
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="warps_withdrawals_export.csv"');
        res.status(200).send(csvContent);
    } catch (err) {
        res.status(500).send("CSV Export Failed");
    }
});

// --- 🕵️ SYBIL HUNTER (FRAUD & IP TRACKING ENGINE) ---
router.get('/sybil-hunter', checkAdminAuth, async (req, res) => {
    try {
        // Aggregate users by device_fingerprint to find duplicates
        const sybilClusters = await User.aggregate([
            { $match: { device_fingerprint: { $type: "string", $nin: ["", null] } } },
            { $group: {
                _id: "$device_fingerprint",
                users: { $push: { telegram_id: "$telegram_id", username: "$username", balance: "$points_balance", is_banned: "$is_banned" } },
                count: { $sum: 1 }
            }},
            { $match: { count: { $gt: 1 } } },
            { $sort: { count: -1 } },
            { $limit: ADMIN_SYBIL_CLUSTERS_LIMIT }
        ]);

        res.render('admin_sybil_hunter', {
            clusters: sybilClusters
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Sybil Hunter Failed: " + err.message);
    }
});

// --- 📈 QUEUE MONITORING ENDPOINT ---
router.get('/queues', checkAdminAuth, async (req, res) => {
    try {
        const counts = await telegramQueue.getJobCounts();
        
        // Fetch up to 10 recently failed jobs for debugging
        const failedJobs = await telegramQueue.getFailed(0, ADMIN_QUEUE_DEBUG_LIMIT);
        
        const failedList = failedJobs.map(job => ({
            id: job.id,
            failedReason: job.failedReason,
            data: job.data,
            attempts: job.attemptsMade
        }));

        res.render('admin_queues', {
            counts: counts,
            failedJobs: failedList
        });
    } catch (err) {
        res.status(500).send("Failed to load queue statistics.");
    }
});

// --- ⚡ EXCLUSIVE ADMINISTRATIVE PAYOUT DECISION CONTROL ENDPOINT ---
router.get('/payout', checkAdminAuth, async (req, res) => {
    try {
        // Extract txId and action from signed token (Telegram buttons) or query params (dashboard)
        let txId, action;
        if (req.signedPayoutAction) {
            txId = req.signedPayoutAction.txId;
            action = req.signedPayoutAction.action;
        } else {
            txId = req.query.txId;
            action = req.query.action;
        }

        if (!txId || !action) {
            return res.status(400).send("Incomplete routing parameters.");
        }

        console.log(`📡 [Admin Payout] Action: ${action} for TX ID: ${txId}`);

        // Find user that has this transaction ID
        const targetUser = await User.findOne({ "transactions.txId": txId });

        if (!targetUser) {
            return res.status(404).send("Transaction trace ID not found in database.");
        }

        const targetTx = targetUser.transactions.find(t => t.txId === txId);

        if (targetTx.status !== 'Pending') {
            return res.status(400).send(`This transaction has already been resolved as [${targetTx.status}].`);
        }

        if (action === 'approve') {
            // Update user transaction status
            targetTx.status = 'Successful';
            await targetUser.save();

            // Update global withdrawal document
            await Withdrawal.updateOne({ ticket_id: txId }, { status: 'Successful' });

            const totalDebitedPoints = targetTx.amount;
            let valuationStr = `$${(totalDebitedPoints * PTS_TO_USD_RATE).toFixed(2)} USD`;
            if (targetTx.type.includes('NAIRA')) {
                const nairaValue = totalDebitedPoints * PTS_TO_USD_RATE * USD_TO_NGN_RATE;
                valuationStr = `$${(totalDebitedPoints * PTS_TO_USD_RATE).toFixed(2)} USD (₦${nairaValue.toLocaleString('en-US', {minimumFractionDigits: 2})})`;
            }

            // --- 📢 Post direct proof to Telegram Channel via Bull Queue ---
            const proofReceiptText = `⚡ <b>WITHDRAWAL SUCCESSFUL</b> ⚡\n\n` +
                `👤 <b>User:</b> ${escapeTelegramHtml(targetUser.first_name || 'Operator')} (@${escapeTelegramHtml(targetUser.username || 'Anonymous')})\n` +
                `🧾 <b>Transaction ID:</b> <code>${escapeTelegramHtml(txId)}</code>\n` +
                `💰 <b>Amount:</b> <b>${totalDebitedPoints.toLocaleString()} PTS</b>\n` +
                `💵 <b>Value:</b> <b>${valuationStr}</b>\n` +
                `💼 <b>Method:</b> ${escapeTelegramHtml(targetTx.type.replace('Withdrawal (', '').replace(')', ''))}\n` +
                `📅 <b>Date:</b> ${getFormattedDateTime()}\n\n` +
                `💚 <i>Keep watching, keep sharing, keep stacking!</i>`;

            await sendTelegramMessageAsync(PUBLIC_PAYOUT_CHANNEL_ID, proofReceiptText);

            // Message target user directly via Bull Queue
            const userNotificationText = `💰 <b>Withdrawal Successful!</b>\n\nYour withdrawal of <b>${totalDebitedPoints.toLocaleString()} PTS (${valuationStr})</b> has been processed successfully.\n\nProof of payment has been posted to ${PUBLIC_PAYOUT_CHANNEL_ID}!`;
            await sendTelegramMessageAsync(targetUser.telegram_id, userNotificationText);

            return res.send(`
                <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #e6ddd0; text-align: center; color: #1a1a16;">
                    <div style="background: white; padding: 40px; border-radius: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width:340px;">
                        <span style="font-size: 48px;">✅</span>
                        <h2 style="margin-top:15px; font-size: 18px;">Transaction Approved!</h2>
                        <p style="color:#666; font-size:13px; line-height:1.5;">Successfully marked as <b>Successful</b>. Receipt has been published to @WarpsEarn.</p>
                    </div>
                </body>
            `);

        } else if (action === 'reject') {
            // Update user transaction status and restore points
            targetTx.status = 'Rejected';
            targetUser.points_balance = (targetUser.points_balance || 0) + targetTx.amount;
            await targetUser.save();

            // Update global withdrawal document
            await Withdrawal.updateOne({ ticket_id: txId }, { status: 'Rejected' });

            // Notify user of rejection reason via Bull Queue
            const userRejectionText = `❌ <b>Withdrawal Rejected</b>\n\nYour withdrawal request for <b>${targetTx.amount.toLocaleString()} PTS</b> was declined. Your points have been refunded to your balance.`;
            await sendTelegramMessageAsync(targetUser.telegram_id, userRejectionText);

            return res.send(`
                <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #e6ddd0; text-align: center; color: #1a1a16;">
                    <div style="background: white; padding: 40px; border-radius: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width:340px;">
                        <span style="font-size: 48px;">❌</span>
                        <h2 style="margin-top:15px; font-size: 18px;">Transaction Declined</h2>
                        <p style="color:#666; font-size:13px; line-height:1.5;">Status successfully changed to <b>Rejected</b>. Points returned to user balance.</p>
                    </div>
                </body>
            `);
        }

    } catch (err) {
        console.error("Administrative transaction decision failure:", err);
        return res.status(500).send("Administrative decision process crashed.");
    }
});

// --- 🎯 ADMIN BOUNTY DECISION ACTION ---
router.post('/bounty/action', checkAdminAuth, verifyCsrfToken, async (req, res) => {
    const { subId, action } = req.body;

    if (!subId || !['approve', 'reject'].includes(action)) {
        return res.status(400).send("Invalid administrative payload.");
    }

    try {
        const BountySubmission = require('../models/BountySubmission');
        const Bounty = require('../models/Bounty');
        
        const submission = await BountySubmission.findById(subId);
        if (!submission) return res.status(404).send("Submission trace missing.");
        if (submission.status !== 'pending') return res.status(400).send("Submission already processed.");

        const targetUser = await User.findOne({ telegram_id: submission.telegram_id });
        const targetBounty = await Bounty.findById(submission.bounty_id);

        if (!targetUser || !targetBounty) {
            return res.status(404).send("User or Bounty not found.");
        }

        if (action === 'approve') {
            submission.status = 'approved';
            submission.reviewed_at = new Date();
            
            targetBounty.completions = (targetBounty.completions || 0) + 1;
            targetBounty.current_participants = (targetBounty.current_participants || 0) + 1;
            if (targetBounty.current_participants >= targetBounty.max_participants) {
                targetBounty.status = 'completed';
            }
            
            targetUser.points_balance = (targetUser.points_balance || 0) + targetBounty.reward_pts;
            if (!targetUser.earnings_history) targetUser.earnings_history = [];
            targetUser.earnings_history.unshift({
                type: `Bounty: ${targetBounty.title}`,
                amount: targetBounty.reward_pts,
                timestamp: getFormattedDateTime()
            });

            await submission.save();
            await targetBounty.save();
            await targetUser.save();
            
            // Notify user of success
            await sendTelegramMessageAsync(targetUser.telegram_id, `🎉 <b>Bounty Approved!</b>\n\nYour submission for <b>${targetBounty.title}</b> was verified. <b>+${targetBounty.reward_pts} PTS</b> has been added to your balance!`);
            
            return res.redirect('/admin');
            
        } else if (action === 'reject') {
            submission.status = 'rejected';
            submission.reviewed_at = new Date();
            
            targetUser.bounty_strikes = (targetUser.bounty_strikes || 0) + 1;
            if (targetUser.bounty_strikes >= MAX_BOUNTY_STRIKES) {
                targetUser.bounty_banned = true;
            }
            
            await submission.save();
            await targetUser.save();
            
            // Notify user of rejection
            let warningText = targetUser.bounty_banned ? 
                "\n\n🚨 <b>ACCOUNT BANNED FROM BOUNTIES</b>\nYou have received 3 strikes for fraudulent submissions. You can no longer participate in social tasks." :
                `\n\n⚠️ <b>Strike Added (${targetUser.bounty_strikes}/${MAX_BOUNTY_STRIKES})</b>\nSubmit valid links only to avoid being banned from tasks.`;
                
            await sendTelegramMessageAsync(targetUser.telegram_id, `❌ <b>Bounty Rejected</b>\n\nYour submission for <b>${targetBounty.title}</b> was marked as invalid.` + warningText);
            
            return res.redirect('/admin');
        }
        
    } catch (err) {
        console.error("Admin Bounty Action Error:", err);
        return res.status(500).send("Administrative process crashed.");
    }
});



module.exports = router;