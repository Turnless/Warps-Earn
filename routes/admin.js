const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const Withdrawal = require('../models/Withdrawal');
const redis = require('../services/redis');
const { sendTelegramMessageAsync, telegramQueue, notifyQuietly } = require('../services/queue');
const { invalidateGlobalSettings } = require('../services/settings');

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
// Routes a signed payout token is allowed to unlock. The token is emailed out in
// a Telegram message, so it must not act as a general admin key.
const SIGNED_TOKEN_ALLOWED_PATHS = ['/payout'];

// --- ADMIN SESSIONS --------------------------------------------------------
// The session used to live only in Redis, which made Redis a hard dependency
// for logging in. When Redis was unreachable every command queued forever
// (maxRetriesPerRequest: null) and the login request hung with no response —
// locking the operator out of the panel exactly when they needed it.
//
// The token is now self-contained and signed, so auth works with Redis down.
// Redis is still consulted, best-effort, to honour explicit logouts.

function signPayload(payload) {
    return crypto.createHmac('sha256', ADMIN_SECRET_SIGNATURE).update(payload).digest('hex');
}

function safeEquals(a, b) {
    const bufA = Buffer.from(String(a), 'utf8');
    const bufB = Buffer.from(String(b), 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/** Creates a signed, self-contained session token. */
function createSessionToken() {
    const payload = Buffer.from(JSON.stringify({
        jti: crypto.randomBytes(12).toString('hex'),
        iat: Date.now(),
        exp: Date.now() + ADMIN_SESSION_MAX_AGE_MS
    })).toString('base64url');
    return `${payload}.${signPayload(payload)}`;
}

/** Returns the session payload if the token is authentic and unexpired. */
function verifySessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    if (!safeEquals(sig, signPayload(payload))) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!data.exp || Date.now() >= data.exp) return null;
        return data;
    } catch (e) {
        return null;
    }
}

/**
 * CSRF token derived from the session token rather than stored.
 * A signed double-submit cookie: verifiable without any shared state, so CSRF
 * protection keeps working when Redis does not.
 */
function csrfTokenFor(sessionToken) {
    return crypto.createHmac('sha256', ADMIN_SECRET_SIGNATURE)
        .update(`csrf:${sessionToken}`).digest('hex');
}

/** Reads one cookie value from the raw header (no cookie-parser in use). */
function readCookie(req, name) {
    if (!req.headers.cookie) return null;
    const match = req.headers.cookie.split(';').map(c => c.trim())
        .find(c => c.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : null;
}

const checkAdminAuth = async (req, res, next) => {
    // 1. Check for HMAC-signed payout token (from Telegram inline buttons)
    const signedToken = req.query.token;
    if (signedToken && SIGNED_TOKEN_ALLOWED_PATHS.includes(req.path)) {
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

    // 2. Check the signed session cookie
    const sessionToken = readCookie(req, 'admin_session');
    const session = verifySessionToken(sessionToken);

    if (session) {
        // Honour an explicit logout when Redis is reachable. If it is not, a
        // valid unexpired signature still gets in — being locked out of the
        // panel during an outage is worse than a revoked session living out
        // its remaining TTL.
        const revoked = await redis.safely(
            redis.get(`admin:revoked:${session.jti}`), null, 'revocation check'
        );
        if (revoked) {
            res.clearCookie('admin_session');
            return res.redirect('/admin/login');
        }

        // Issue the matching CSRF cookie if it is missing or stale
        const expectedCsrf = csrfTokenFor(sessionToken);
        if (readCookie(req, 'admin_csrf') !== expectedCsrf) {
            res.cookie('admin_csrf', expectedCsrf, {
                maxAge: ADMIN_SESSION_MAX_AGE_MS, httpOnly: false,
                sameSite: 'strict', secure: process.env.NODE_ENV === 'production'
            });
        }
        return next();
    }

    // If not authenticated, redirect to login page
    res.redirect('/admin/login');
};

// --- 🛡️ CSRF VERIFICATION MIDDLEWARE ---
const verifyCsrfToken = async (req, res, next) => {
    // Only enforce CSRF on state-changing methods
    if (req.method !== 'POST') return next();

    const sessionToken = readCookie(req, 'admin_session');
    const submitted = req.body?._csrf || req.headers['x-csrf-token'];

    if (!sessionToken || !submitted) {
        return res.status(403).type('text/plain').send("Forbidden: Missing CSRF token.");
    }

    // Derived from the session token, so this needs no storage and keeps
    // working during a Redis outage.
    if (!safeEquals(submitted, csrfTokenFor(sessionToken))) {
        return res.status(403).type('text/plain').send("Forbidden: Invalid CSRF token.");
    }

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
        redis.fireAndForget(redis.lpush('admin:audit_log', entry), 'audit log');
        redis.fireAndForget(redis.ltrim('admin:audit_log', 0, 499), 'audit log trim');
    } catch (e) {
        console.warn('[Audit Log] Failed to write:', e.message);
    }
}

// --- 🔐 LOGIN SYSTEM ---
router.get('/login', (req, res) => {
    res.render('admin_login');
});

router.post('/login', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { password } = req.body;
        const loginKey = `admin:login_attempts:${req.ip}`;

        if (!ADMIN_SECRET_SIGNATURE) {
            console.error('FATAL: ADMIN_SECRET_SIGNATURE is not set — refusing all logins.');
            return res.render('admin_login', { error: "Server is not configured. Check ADMIN_SECRET_SIGNATURE." });
        }

        // Brute-force lockout is best-effort: if the counter is unreachable the
        // password is still required, and refusing every login because a cache
        // is down would lock the operator out of their own panel.
        const attempts = await redis.safely(redis.get(loginKey), null, 'login attempt counter', 1500);
        if (attempts && parseInt(attempts, 10) >= 5) {
            return res.render('admin_login', { error: "Too many failed attempts. Try again in 15 minutes." });
        }

        if (safeEquals(password || '', ADMIN_SECRET_SIGNATURE)) {
            const sessionToken = createSessionToken();

            res.cookie('admin_session', sessionToken, {
                maxAge: ADMIN_SESSION_MAX_AGE_MS, httpOnly: true,
                sameSite: 'strict', secure: process.env.NODE_ENV === 'production'
            });
            res.cookie('admin_csrf', csrfTokenFor(sessionToken), {
                maxAge: ADMIN_SESSION_MAX_AGE_MS, httpOnly: false,
                sameSite: 'strict', secure: process.env.NODE_ENV === 'production'
            });

            // Bookkeeping only — never make the operator wait for it
            redis.fireAndForget(redis.del(loginKey), 'clear login attempts');
            logAdminAction('login', { ip: req.ip });

            return res.redirect('/admin');
        }

        // Track the failed attempt, best-effort
        const newAttempts = await redis.safely(redis.incr(loginKey), null, 'record failed login', 1500);
        if (newAttempts === 1) {
            redis.fireAndForget(redis.expire(loginKey, 900), 'set lockout window');
        }

        return res.render('admin_login', { error: "Invalid Passphrase." });
    } catch (err) {
        console.error('Admin login failed:', err);
        if (res.headersSent) return;
        return res.render('admin_login', { error: "Could not sign you in. Please try again." });
    }
});

router.get('/logout', async (req, res) => {
    const sessionToken = readCookie(req, 'admin_session');
    const session = verifySessionToken(sessionToken);

    // Record the revocation so the token cannot be reused before it expires.
    // Best-effort: with Redis down the cookie is still cleared in this browser.
    if (session && session.jti) {
        const ttlSeconds = Math.max(1, Math.ceil((session.exp - Date.now()) / 1000));
        await redis.safely(
            redis.setex(`admin:revoked:${session.jti}`, ttlSeconds, '1'),
            null, 'session revocation', 1500
        );
    }

    res.clearCookie('admin_session');
    res.clearCookie('admin_csrf');
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

        const settingsStr = await redis.safely(redis.get('global_settings'), null, 'global settings');
        const settings = settingsStr ? JSON.parse(settingsStr) : {
            maintenance: false,
            withdrawals: true,
            reward_per_ad: DEFAULT_REWARD_PER_AD,
            streak_reward: STREAK_BONUS_REWARD
        };

        const questsStr = await redis.safely(redis.get('admin:dynamic_quests'), null, 'dynamic quests');
        const dynamicQuests = questsStr ? JSON.parse(questsStr) : {};

        // Fetch Ad Telemetry Data
        const telemetryStr = await redis.safely(redis.get('admin:ad_telemetry'), null, 'ad telemetry');
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

        const storeConfigStr = await redis.safely(redis.get('admin:store_config'), null, 'store config');
        const storeConfig = storeConfigStr ? JSON.parse(storeConfigStr) : {
            ...DEFAULT_STORE_CONFIG,
            ...DEFAULT_STARS_CONFIG,
            enable_cooldown: true,
            enable_multiplier: true,
            enable_premium: true,
            enable_gold: true
        };




        // Fetch recent quest submissions
        const questSubmissionsRaw = await redis.safely(redis.lrange('admin:quest_submissions', 0, MAX_QUEST_SUBMISSIONS_LOG - 1), [], 'quest submissions') || [];
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
            dynamicQuests: dynamicQuests,
            ptsToUsd: PTS_TO_USD_RATE
        });
    } catch (e) {
        console.error(e);
        res.status(500).type('text/plain').send("Metrics Engine Failed");
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
        await redis.withTimeout(redis.set('global_settings', JSON.stringify(newSettings)));
        invalidateGlobalSettings();   // this process picks the change up immediately
        res.redirect('/admin');
    } catch (e) {
        res.status(500).type('text/plain').send("Failed to update settings");
    }
});

// --- 🛒 STORE CONFIG CONTROLLER ---
router.post('/store-config', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    try {
        // Start from what is currently stored so a blank field keeps its existing
        // value instead of snapping back to a literal, and fall back to the
        // shared defaults rather than numbers duplicated in this handler.
        const existingStr = await redis.safely(redis.get('admin:store_config'), null, 'store config');
        const existing = existingStr ? JSON.parse(existingStr) : {};
        const base = { ...DEFAULT_STORE_CONFIG, ...DEFAULT_STARS_CONFIG, ...existing };

        const PRICE_FIELDS = [
            ...Object.keys(DEFAULT_STORE_CONFIG),
            ...Object.keys(DEFAULT_STARS_CONFIG),
            // priced items the defaults intentionally leave unset
            'premium_tier_3m', 'stars_premium_3m', 'stars_gold_3m', 'stars_gold_6m'
        ];
        const TOGGLE_FIELDS = ['enable_cooldown', 'enable_multiplier', 'enable_premium', 'enable_gold'];

        const newConfig = { ...base };
        for (const field of PRICE_FIELDS) {
            const raw = req.body[field];
            if (raw === undefined || String(raw).trim() === '') continue;   // keep existing
            const parsed = parseInt(raw, 10);
            if (Number.isFinite(parsed) && parsed > 0) newConfig[field] = parsed;
        }
        for (const field of TOGGLE_FIELDS) {
            newConfig[field] = req.body[field] === 'on';
        }

        await redis.withTimeout(redis.set('admin:store_config', JSON.stringify(newConfig)));
        await logAdminAction('store_config_update', { fields: Object.keys(req.body).length });
        res.redirect('/admin');
    } catch (e) {
        console.error('Store config update failed:', e);
        res.status(500).type('text/plain').send("Failed to update store config");
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
        res.status(500).type('text/plain').send("Action Failed");
    }
});

// --- 🎯 DYNAMIC QUESTS ENGINE ---
router.post('/quests', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { action, key, title, url, pts, icon, tier_required, target_countries, is_telegram, timer, requires_comment_link, max_participants } = req.body;
        const questsStr = await redis.safely(redis.get('admin:dynamic_quests'), null, 'dynamic quests');
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

        await redis.withTimeout(redis.set('admin:dynamic_quests', JSON.stringify(quests)));
        res.redirect('/admin');
    } catch (e) {
        res.status(500).type('text/plain').send("Failed to manage quests");
    }
});

// --- 🎯 APPROVE/REJECT QUEST SUBMISSION ---
router.post('/quests/action', checkAdminAuth, verifyCsrfToken, async (req, res) => {
    try {
        const { id, action } = req.body;
        if (!id || !action) return res.status(400).type('text/plain').send("Missing parameters");

        const questSubmissionsRaw = await redis.safely(redis.lrange('admin:quest_submissions', 0, MAX_QUEST_SUBMISSIONS_LOG - 1), [], 'quest submissions') || [];
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

        if (!targetSub) return res.status(404).type('text/plain').send("Submission not found or already processed");

        const user = await User.findOne({ telegram_id: targetSub.telegram_id });
        if (!user) return res.status(404).type('text/plain').send("User not found");

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
            redis.fireAndForget(redis.del(`user:${targetSub.telegram_id}:profile`), 'cache purge');
        } catch (e) {
            console.warn("Failed to clear user cache", e);
        }

        // Remove from Redis list
        await redis.safely(redis.lrem('admin:quest_submissions', 1, questSubmissionsRaw[subIndex]), null, 'remove submission');

        res.redirect('/admin');
    } catch (e) {
        console.error(e);
        res.status(500).type('text/plain').send("Action failed");
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
        res.status(500).type('text/plain').send("Lookup failed");
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
        res.status(500).type('text/plain').send("Action failed");
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
        res.status(500).type('text/plain').send("Action failed");
    }
});

router.post('/user-delete', checkAdminAuth, verifyCsrfToken, express.urlencoded({ extended: true }), async (req, res) => {
    const { telegram_id } = req.body;
    try {
        await User.deleteOne({ telegram_id });
        redis.fireAndForget(redis.del(`user:${telegram_id}:profile`), 'cache purge');
        redis.fireAndForget(redis.del(`lock:claim:${telegram_id}`), 'cache purge');
        redis.fireAndForget(redis.del(`lock:payout:${telegram_id}`), 'cache purge');
        await logAdminAction('user_delete', { target: telegram_id });
        res.redirect('/admin');
    } catch (e) {
        res.status(500).type('text/plain').send("Action failed");
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
            redis.fireAndForget(redis.del(`user:${telegram_id}:profile`), 'cache purge');
            await logAdminAction('balance_adjustment', { target: telegram_id, amount: amt, reason: reason || 'Manual' });
        }
        res.redirect(`/admin/user-lookup?q=${telegram_id}`);
    } catch (e) {
        res.status(500).type('text/plain').send("Action failed");
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
            redis.fireAndForget(redis.del(`user:${telegram_id}:profile`), 'cache purge');
            
            // Notify user of tier upgrade
            const msg = `🎉 *Account Tier Updated* 🎉\n\nYour account has been manually reviewed and placed in the *${user.account_tier} Tier*.\nFollowers: ${user.x_followers}\nBlue Tick: ${user.x_blue_tick ? 'Yes' : 'No'}`;
            try {
                const { sendTelegramMessageAsync } = require('../services/queue');
                await notifyQuietly(telegram_id, msg, { parse_mode: 'Markdown' });
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
        res.status(500).type('text/plain').send("Action failed");
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
            redis.fireAndForget(redis.del(`user:${telegram_id}:profile`), 'cache purge');
        }
        res.redirect(`/admin/user-lookup?q=${telegram_id}`);
    } catch (e) {
        res.status(500).type('text/plain').send("Action failed");
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
        res.status(500).type('text/plain').send("Broadcast failed");
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
        res.status(500).type('text/plain').send("Wakeup Push Failed");
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
        res.status(500).type('text/plain').send("CSV Export Failed");
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
        res.status(500).type('text/plain').send("CSV Export Failed");
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
        res.status(500).type('text/plain').send("Sybil Hunter failed. Check the server logs for details.");
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
        res.status(500).type('text/plain').send("Failed to load queue statistics.");
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
            return res.status(400).type('text/plain').send("Incomplete routing parameters.");
        }

        console.log(`📡 [Admin Payout] Action: ${action} for TX ID: ${txId}`);

        // Find user that has this transaction ID
        const targetUser = await User.findOne({ "transactions.txId": txId });

        if (!targetUser) {
            return res.status(404).type('text/plain').send("Transaction trace ID not found in database.");
        }

        const targetTx = targetUser.transactions.find(t => t.txId === txId);

        if (targetTx.status !== 'Pending') {
            return res.status(400).type('text/plain').send(`This transaction has already been resolved as [${targetTx.status}].`);
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

            await notifyQuietly(PUBLIC_PAYOUT_CHANNEL_ID, proofReceiptText);

            // Message target user directly via Bull Queue
            const userNotificationText = `💰 <b>Withdrawal Successful!</b>\n\nYour withdrawal of <b>${totalDebitedPoints.toLocaleString()} PTS (${valuationStr})</b> has been processed successfully.\n\nProof of payment has been posted to ${PUBLIC_PAYOUT_CHANNEL_ID}!`;
            await notifyQuietly(targetUser.telegram_id, userNotificationText);

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
            await notifyQuietly(targetUser.telegram_id, userRejectionText);

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
        return res.status(500).type('text/plain').send("Administrative decision process crashed.");
    }
});

// --- 🎯 ADMIN BOUNTY DECISION ACTION ---
router.post('/bounty/action', checkAdminAuth, verifyCsrfToken, async (req, res) => {
    const { subId, action } = req.body;

    if (!subId || !['approve', 'reject'].includes(action)) {
        return res.status(400).type('text/plain').send("Invalid administrative payload.");
    }

    try {
        const BountySubmission = require('../models/BountySubmission');
        const Bounty = require('../models/Bounty');
        
        const submission = await BountySubmission.findById(subId);
        if (!submission) return res.status(404).type('text/plain').send("Submission trace missing.");
        if (submission.status !== 'pending') return res.status(400).type('text/plain').send("Submission already processed.");

        const targetUser = await User.findOne({ telegram_id: submission.telegram_id });
        const targetBounty = await Bounty.findById(submission.bounty_id);

        if (!targetUser || !targetBounty) {
            return res.status(404).type('text/plain').send("User or Bounty not found.");
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
            await notifyQuietly(targetUser.telegram_id, `🎉 <b>Bounty Approved!</b>\n\nYour submission for <b>${targetBounty.title}</b> was verified. <b>+${targetBounty.reward_pts} PTS</b> has been added to your balance!`);
            
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
                
            await notifyQuietly(targetUser.telegram_id, `❌ <b>Bounty Rejected</b>\n\nYour submission for <b>${targetBounty.title}</b> was marked as invalid.` + warningText);
            
            return res.redirect('/admin');
        }
        
    } catch (err) {
        console.error("Admin Bounty Action Error:", err);
        return res.status(500).type('text/plain').send("Administrative process crashed.");
    }
});



module.exports = router;