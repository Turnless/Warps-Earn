const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const db = require('../database');
const User = require('../models/User');
const Withdrawal = require('../models/Withdrawal');
const redis = require('../services/redis');
const { sendTelegramMessageAsync } = require('../services/queue');

// Import the cryptographic verification middleware securely
const verifyTelegramWebAppData = require('../middleware/auth');
const { transactionalLimiter } = require('../middleware/rateLimiter');

// Load environment variables from .env file
require('dotenv').config();

// Pull sensitive secrets securely from system memory instead of hardcoding
const ADMIN_SECRET_SIGNATURE = process.env.ADMIN_SECRET_SIGNATURE || 'fallback_secret_for_dev';
const PUBLIC_PAYOUT_CHANNEL_ID = process.env.PUBLIC_PAYOUT_CHANNEL_ID || '@WarpsEarn';

// 🛡️ HTML SANITIZER FOR TELEGRAM COMPATIBILITY
function escapeTelegramHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Helper to generate beautifully formatted timestamps: e.g. "Jun 20, 2026 • 02:53 PM"
function getFormattedDateTime() {
    const optionsDate = { month: 'short', day: 'numeric', year: 'numeric' };
    const optionsTime = { hour: '2-digit', minute: '2-digit', hour12: true };
    const dateStr = new Date().toLocaleDateString('en-US', optionsDate);
    const timeStr = new Date().toLocaleTimeString('en-US', optionsTime);
    return `${dateStr} • ${timeStr}`;
}

// Cache helper to purge stale Redis state when database state updates
async function invalidateUserCache(userId) {
    try {
        console.log(`📡 [Redis Cache] Purging cache key for user: ${userId}`);
        await redisWithTimeout(redis.del(`user:${userId}:profile`));
    } catch (err) {
        console.error("⚠️ Redis cache purge failed:", err.message);
    }
}

// Timeout wrapper for Redis operations to prevent infinite hangs
// when Redis is in a broken/reconnecting state (EPIPE, ECONNRESET).
function redisWithTimeout(promise, timeoutMs = 3000) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Redis operation timed out')), timeoutMs)
        )
    ]);
}

// 🛡️ GLOBAL ECOSYSTEM & BAN CHECK MIDDLEWARE
const globalEcosystemCheck = async (req, res, next) => {
    try {
        let settingsStr = await redisWithTimeout(redis.get('global_settings'));
        req.globalSettings = settingsStr ? JSON.parse(settingsStr) : { maintenance: false, withdrawals: true };

        if (req.globalSettings.maintenance) {
            if (req.method === 'GET') {
                return res.send(`<body style="background:#1a1a16; color:#e6ddd0; display:flex; justify-content:center; align-items:center; height:100vh; font-family:sans-serif; text-align:center;"><div style="padding:40px;"><span style="font-size:48px;">🛠️</span><h1 style="margin-top:20px;">System Upgrade</h1><p style="color:#999; margin-top:10px;">The Warps Earn platform is currently undergoing scheduled maintenance.<br>Please check back shortly.</p></div></body>`);
            } else {
                return res.status(503).send("Platform is in maintenance mode.");
            }
        }
        next();
    } catch (e) {
        req.globalSettings = { maintenance: false, withdrawals: true };
        next();
    }
};

// --- 📊 CORE DASHBOARD CONTROLLER ---
router.get('/dashboard', globalEcosystemCheck, async (req, res) => {
    const userId = String(req.query.id || "");

    try {
        if (!userId) {
            return res.status(400).send("Missing identity context parameter.");
        }

        const redisKey = `user:${userId}:profile`;
        let user = null;

        try {
            const cachedUser = await redisWithTimeout(redis.get(redisKey));
            if (cachedUser) {
                console.log(`📡 [Redis Cache] Cache HIT for user dashboard: ${userId}`);
                user = JSON.parse(cachedUser);
            }
        } catch (redisError) {
            console.error("⚠️ Redis cache read failure:", redisError.message);
        }

        if (!user) {
            console.log(`📡 [Database] Cache MISS. Querying MongoDB for user dashboard: ${userId}`);
            user = await User.findOne({ telegram_id: userId }).lean();

            if (user) {
                try {
                    await redisWithTimeout(redis.setex(redisKey, 300, JSON.stringify(user)));
                } catch (redisError) {
                    console.error("⚠️ Redis cache write failure:", redisError.message);
                }
            }
        }

        if (!user) {
            return res.redirect(`/auth?id=${userId}`);
        }

        if (user.is_banned) {
            return res.send(`<body style="background:#1a1a16; color:#e6ddd0; display:flex; justify-content:center; align-items:center; height:100vh; font-family:sans-serif; text-align:center;"><div style="padding:40px;"><span style="font-size:48px;">🚫</span><h1 style="margin-top:20px;">Account Suspended</h1><p style="color:#999; margin-top:10px;">Your account has been banned for violating our terms.</p></div></body>`);
        }

        if (!user.onboarding_passed) {
            return res.redirect(`/onboarding?id=${userId}`);
        }

        const questsStr = await redis.get('admin:dynamic_quests');
        const dynamicQuests = questsStr ? JSON.parse(questsStr) : {};

        const Bounty = require('../models/Bounty');
        const bounties = await Bounty.find({ status: 'active', expires_at: { $gt: new Date() } }).sort({ created_at: -1 }).lean();

        const storeConfigStr = await redis.get('admin:store_config');
        const storeConfig = storeConfigStr ? JSON.parse(storeConfigStr) : {
            cooldown: 500,
            multiplier: 3000,
            premium_tier_1m: 15000,
            premium_tier_3m: 15000,
            premium_tier_6m: 28000,
            premium_tier_3m_blue: 45000,
            premium_tier_6m_blue: 85000,
            gold_tier_1m: 50000,
            gold_tier_3m: 50000,
            gold_tier_6m: 90000,
            gold_tier_3m_blue: 80000,
            gold_tier_6m_blue: 150000,
            stars_premium_3m: 25,
            stars_premium_6m: 45,
            stars_premium_3m_blue: 50,
            stars_premium_6m_blue: 95,
            stars_gold_3m: 100,
            stars_gold_6m: 180,
            stars_gold_3m_blue: 120,
            stars_gold_6m_blue: 220,
            stars_x_verify: 100,
            enable_cooldown: true,
            enable_multiplier: true,
            enable_premium: true,
            enable_gold: true
        };

        const StoreOrder = require('../models/StoreOrder');
        const pendingOrders = await StoreOrder.find({ telegram_id: userId, status: 'pending' }).lean();

        const BountySubmission = require('../models/BountySubmission');
        const userBountySubmissions = await BountySubmission.find({ telegram_id: userId }).lean();

        res.render('dashboard', { user: user, dynamicQuests: dynamicQuests, bounties: bounties, storeConfig: storeConfig, pendingOrders: pendingOrders, userBountySubmissions: userBountySubmissions, globalSettings: req.globalSettings });

    } catch (e) {
        console.error("Dashboard view routing error:", e);
        res.status(500).send("Internal server error loading dashboard.");
    }
});

// --- 📺 AD GATEWAY INTERFACE CONTROLLER ---
router.get('/watch-ads', globalEcosystemCheck, async (req, res) => {
    const userId = String(req.query.id || "");
    if (!userId) return res.status(400).send("Identity validation parameter missing.");

    try {
        // Fetch user from MongoDB
        const user = await User.findOne({ telegram_id: userId });
        if (!user) return res.status(404).send("User profile not found.");
        
        if (user.is_banned) return res.status(403).send("Account suspended.");

        const todayStr = new Date().toISOString().split('T')[0];
        const now = Date.now();

        if (!user.daily_tracker || user.daily_tracker.date !== todayStr) {
            user.daily_tracker = { date: todayStr, count: 0 };
            user.current_session_loop = 0;
            await user.save();
            await invalidateUserCache(userId);
        }

        if (user.daily_tracker.count >= 100) {
            return res.send(`
                <body style="background-color: #e6ddd0; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; padding: 20px; color: #1a1a16;">
                    <div style="background: white; padding: 30px; border-radius: 24px; max-width: 340px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                        <span style="font-size: 40px;">🛑</span>
                        <h2 style="margin-top: 10px; font-size: 18px;">Daily Limit Reached</h2>
                        <p style="font-size: 13px; color: #666; line-height: 1.5;">You have completed your 100 ads for today. Come back tomorrow!</p>
                        <button onclick="location.href='/dashboard?id=${userId}'" style="background: #1a1a16; color: #e6ddd0; border: none; padding: 12px 24px; border-radius: 12px; font-weight: bold; font-size: 13px; cursor: pointer; width: 100%; margin-top: 10px;">Return to Dashboard</button>
                    </div>
                </body>
            `);
        }

        if (user.cooldown_until && now < user.cooldown_until) {
            const secondsLeft = Math.ceil((user.cooldown_until - now) / 1000);
            const minutes = Math.floor(secondsLeft / 60);
            const seconds = secondsLeft % 60;
            const timeString = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

            const isMacro = secondsLeft > 60; 
            const statusTitle = isMacro ? "Cooling Down" : "Quick Break";
            const statusDesc = isMacro 
                ? "Please wait a moment before watching more ads." 
                : "Great job! Let your screen rest for 45 seconds before the next ad.";

            return res.send(`
                <body style="background-color: #e6ddd0; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; padding: 20px; color: #1a1a16;">
                    <div style="background: white; padding: 30px; border-radius: 24px; max-width: 340px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                        <span style="font-size: 40px;">${isMacro ? '⏳' : '⚡'}</span>
                        <h2 style="margin-top: 10px; font-size: 18px;">${statusTitle}</h2>
                        <p style="font-size: 13px; color: #666; line-height: 1.5;">${statusDesc}</p>
                        <div style="font-size: 32px; font-weight: bold; color: #1a1a16; margin: 15px 0; font-family: monospace;">${timeString}</div>
                        ${isMacro ? '<p style="font-size: 11px; color: #999; margin-bottom: 15px;">We will notify you via the bot when you can watch more ads!</p>' : ''}
                        <button onclick="location.href='/dashboard?id=${userId}'" style="background: #1a1a16; color: #e6ddd0; border: none; padding: 12px 24px; border-radius: 12px; font-weight: bold; font-size: 13px; cursor: pointer; width: 100%;">Return Home</button>
                    </div>
                    <script>
                        setTimeout(() => { window.location.reload(); }, ${secondsLeft * 1000});
                    </script>
                </body>
            `);
        }

        const loopDisplay = (user.current_session_loop || 0) + 1;
        res.render('ads', { 
            userId: userId, 
            adsRemaining: 100 - user.daily_tracker.count,
            loopDisplay: loopDisplay > 3 ? 3 : loopDisplay
        });

    } catch (e) {
        console.error("Error launching ad view gateway:", e);
        res.status(500).send("Connection error. Try again.");
    }
});

// --- 📺 CLAIM COMPLETED AD LOOP REWARD (PROTECTED + RATE-LIMITED) ---
router.post(['/claim-ad-reward', '/portal/claim-ad-reward'], verifyTelegramWebAppData, globalEcosystemCheck, transactionalLimiter, async (req, res) => {
    const userId = String(req.body.id || "");

    try {
        if (!userId) {
            return res.status(400).send("Invalid request.");
        }

        // 🛡️ Redis Mutex Lock to block concurrent reward farming race conditions
        const lockKey = `lock:claim:${userId}`;
        const isLocked = await redisWithTimeout(redis.set(lockKey, "1", "NX", "EX", 5));
        if (!isLocked) {
            console.log(`⚠️ [Rate Limit] Rejected concurrent ad claim attempt for user: ${userId}`);
            return res.status(429).send("Too many concurrent requests. Please wait.");
        }

        const user = await User.findOne({ telegram_id: userId });
        if (!user) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(404).send("User profile not found.");
        }

        if (user.is_banned) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(403).send("Account suspended.");
        }

        const todayStr = new Date().toISOString().split('T')[0];
        if (user.daily_tracker && user.daily_tracker.date === todayStr && user.daily_tracker.count >= 100) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(400).send("Daily limit exceeded.");
        }

        const result = await db.watchAdRound(userId);
        await invalidateUserCache(userId);
        await redisWithTimeout(redis.del(lockKey));

        res.status(200).json({
            success: true,
            newBalance: result.currentBalance,
            totalAds: result.totalAds,
            loopIndex: result.loopIndex
        });

        // If loop completes (reaches 3 loops, resulting in reset to index 0), enqueue cooldown restock message
        if (result.loopIndex === 0) { 
            const cooldownMs = result.cooldownTime; 
            
            await sendTelegramMessageAsync(
                userId,
                "⚡ <b>Ad Loops Restocked!</b>\n\nYour break is over. Open the app now to watch more ads and earn points!",
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "🚀 Launch App", web_app: { url: `https://${req.get('host')}/dashboard?id=${userId}` } }
                        ]]
                    }
                },
                cooldownMs
            );
        }

    } catch (e) {
        console.error("Ad point processing crash:", e);
        res.status(500).send("Internal processing fault.");
    }
});

// --- 📋 QUEST VERIFICATION ROUTER (PROTECTED + QUEUED) ---
router.post(['/verify-quest', '/portal/verify-quest'], verifyTelegramWebAppData, transactionalLimiter, async (req, res) => {
    const userId = String(req.body.id || "");
    const questKey = String(req.body.quest || "");
    const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

    const rewardMap = {
        channel: 100,
        group: 100,
        payout_channel: 100,
        x_account: 100
    };

    const telegramChatMap = {
        channel: "@Warpsgit",
        group: "@warpscommunity"
    };

    try {
        if (!userId || !questKey || !rewardMap.hasOwnProperty(questKey)) {
            console.warn(`⚠️ [Quest Warn] Rejected verification call.`);
            return res.status(400).send("Invalid verification parameters.");
        }

        const user = await User.findOne({ telegram_id: userId });
        if (!user) return res.status(404).send("User profile not found.");

        if (!user.quests) {
            user.quests = { channel: false, group: false, payout_channel: false, x_account: false, sybil_verified: false };
        }

        if (user.quests[questKey] === true) {
            return res.status(400).send("Quest assignment already verified completed.");
        }

        if (telegramChatMap[questKey]) {
            const targetChat = telegramChatMap[questKey];
            const tgApiUrl = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${targetChat}&user_id=${userId}`;
            
            try {
                const tgRes = await fetch(tgApiUrl);
                const tgData = await tgRes.json();

                if (!tgData.ok) {
                    return res.status(400).send(`Could not verify channel membership. Reason: ${tgData.description}`);
                }

                const status = tgData.result.status;
                const isMember = ['creator', 'administrator', 'member'].includes(status);

                if (!isMember) {
                    return res.status(403).send("Verification failed. You must join the group/channel first.");
                }
            } catch (apiErr) {
                console.error("External validation network error:", apiErr.message);
                return res.status(500).send("External network validation failure.");
            }
        }

        const payoutPoints = rewardMap[questKey];
        user.points_balance = (user.points_balance || 0) + payoutPoints;
        user.set(`quests.${questKey}`, true);

        if (!user.earnings_history) user.earnings_history = [];
        
        let questLabel = "X Follow";
        if (questKey === 'channel') questLabel = "Warps Channel";
        if (questKey === 'group') questLabel = "Warps Group";
        if (questKey === 'payout_channel') questLabel = "WarpsEarn Payouts";

        user.earnings_history.unshift({
            type: `${questLabel} Quest`,
            amount: payoutPoints,
            timestamp: getFormattedDateTime()
        });

        await user.save();
        await invalidateUserCache(userId);
        res.sendStatus(200);

    } catch (e) {
        console.error("❌ [Quest Critical Error] Quest verification processor exception:", e);
        res.status(500).send("Internal processing fault.");
    }
});

// --- ✅ CLAIM ADSGRAM REWARD (SECURE) ---
router.post(['/claim-adsgram-reward', '/portal/claim-adsgram-reward'], verifyTelegramWebAppData, async (req, res) => {
    const userId = String(req.body.id || "");
    const rewardAmount = 50; // Fixed amount, cannot be exploited
    const rewardType = "Adsgram Sponsored Task";

    try {
        if (!userId) return res.status(400).send("Invalid account parameters.");

        // 🛡️ Redis Mutex Lock to block concurrent reward farming race conditions
        const lockKey = `lock:adsgram:${userId}`;
        const isLocked = await redisWithTimeout(redis.set(lockKey, "1", "NX", "EX", 5));
        if (!isLocked) {
            return res.status(429).send("Too many requests.");
        }

        const user = await User.findOne({ telegram_id: userId });
        if (!user) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(404).send("User profile not found.");
        }

        user.points_balance = (user.points_balance || 0) + rewardAmount;

        if (!user.earnings_history) user.earnings_history = [];
        user.earnings_history.unshift({
            type: rewardType,
            amount: rewardAmount,
            timestamp: getFormattedDateTime()
        });

        await user.save();
        await invalidateUserCache(userId);
        await redisWithTimeout(redis.del(lockKey));
        
        res.status(200).json({ success: true, newBalance: user.points_balance });
    } catch (e) {
        console.error("Adsgram reward allocation error:", e);
        res.status(500).send("Connection error. Try again.");
    }
});

// --- ✅ VERIFY CUSTOM PROMO TASK (PROTECTED) ---
router.post(['/verify-custom-promo', '/portal/verify-custom-promo'], verifyTelegramWebAppData, async (req, res) => {
    const userId = String(req.body.id || "");
    const promoKey = String(req.body.promoKey || "");

    const promoMapStr = await redis.get('admin:dynamic_quests');
    const promoMap = promoMapStr ? JSON.parse(promoMapStr) : {};

    try {
        if (!userId || !promoKey || !promoMap[promoKey]) return res.status(400).send("Invalid payload.");

        const user = await User.findOne({ telegram_id: userId });
        if (!user) return res.status(404).send("User not found.");

        if (!user.custom_promos) user.custom_promos = new Map();
        
        // If already verified and we have a truthy value, reject (unless it's an object with verified: true)
        const currentPromo = user.custom_promos.get(promoKey);
        if (currentPromo === true || (currentPromo && currentPromo.verified)) {
            return res.status(400).send("Already verified.");
        }

        const campaign = promoMap[promoKey];

        // Tier Check
        if (campaign.tier_required === 'Premium' && user.account_tier === 'Standard') return res.status(403).send("Requires Premium");
        if (campaign.tier_required === 'Gold' && user.account_tier !== 'Gold') return res.status(403).send("Requires Gold");

        // Geo Check
        if (campaign.target_countries && campaign.target_countries.length > 0 && !campaign.target_countries.includes(user.country)) {
            return res.status(403).send("Not available in your region.");
        }

        // Telegram API Authentication Check
        if (campaign.is_telegram) {
            let channelUsername = campaign.url;
            if (channelUsername.includes('t.me/')) {
                channelUsername = "@" + channelUsername.split('t.me/')[1].split('/')[0].split('?')[0];
            } else if (!channelUsername.startsWith('@')) {
                channelUsername = "@" + channelUsername;
            }
            
            try {
                const fetch = require('node-fetch');
                const tgToken = process.env.BOT_TOKEN;
                const tgUrl = `https://api.telegram.org/bot${tgToken}/getChatMember?chat_id=${channelUsername}&user_id=${userId}`;
                const resp = await fetch(tgUrl);
                const data = await resp.json();
                
                if (!data.ok || !['member', 'administrator', 'creator'].includes(data.result.status)) {
                    return res.status(400).send("Please join the Telegram group/channel first.");
                }
            } catch (err) {
                console.error("Telegram API verify error:", err);
                // Fail-safe pass if Telegram API is down or if it's a private join link
                // But ideally we strict block. Let's block for now to strictly authenticate.
                return res.status(400).send("Authentication failed. Make sure you joined.");
            }
        }

        const rewardPts = campaign.pts || 0;
        const submittedLink = String(req.body.commentLink || "").trim();
        
        if (campaign.requires_comment_link && !submittedLink) {
            return res.status(400).send("A valid comment link is required.");
        }

        if (submittedLink) {
            user.custom_promos.set(promoKey, { verified: false, status: 'pending', link: submittedLink, pts: rewardPts, title: campaign.title });
            try {
                const subId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
                await redis.lpush('admin:quest_submissions', JSON.stringify({
                    id: subId,
                    telegram_id: user.telegram_id,
                    username: user.username,
                    promoKey: promoKey,
                    link: submittedLink,
                    pts: rewardPts,
                    timestamp: new Date().toISOString()
                }));
                await redis.ltrim('admin:quest_submissions', 0, 199); // keep last 200
            } catch(e) { console.warn("Redis log fail", e); }
        } else {
            user.points_balance = (user.points_balance || 0) + rewardPts;
            if (!user.earnings_history) user.earnings_history = [];
            user.earnings_history.unshift({
                type: campaign.title,
                amount: campaign.pts,
                timestamp: getFormattedDateTime()
            });
            user.custom_promos.set(promoKey, true);
        }

        await user.save();
        await invalidateUserCache(userId);

        if (campaign.max_participants > 0) {
            campaign.current_participants = (campaign.current_participants || 0) + 1;
            promoMap[promoKey] = campaign;
            try {
                await redis.set('admin:dynamic_quests', JSON.stringify(promoMap));
            } catch (e) {
                console.error("Failed to update dynamic quest limits", e);
            }
        }

        res.sendStatus(200);
    } catch (e) {
        console.error("Custom Promo Error:", e);
        res.status(500).send("Internal error.");
    }
});

const Bounty = require('../models/Bounty');
const StoreOrder = require('../models/StoreOrder');

// --- 🛒 PURCHASE STORE ITEM ---
router.post(['/purchase-store-item', '/portal/purchase-store-item'], verifyTelegramWebAppData, async (req, res) => {
    const userId = String(req.body.id || "");
    const item = String(req.body.item || "");
    const hasBlueTick = req.body.blue_tick === true;

    const items = {
        cooldown: { key: 'cooldown', title: "Instant Cooldown Reset" },
        multiplier: { key: 'multiplier', title: "2x Yield Multiplier (1 Month)" },
        premium_tier_1m: { key: 'premium_tier_1m', title: "Premium Tier (1 Month)" },
        premium_tier_3m: { key: 'premium_tier_3m', title: "Premium Tier (3 Months)" },
        premium_tier_6m: { key: 'premium_tier_6m', title: "Premium Tier (6 Months)" },
        premium_tier_3m_blue: { key: 'premium_tier_3m_blue', title: "Premium Tier (3 Months) + Blue Tick" },
        premium_tier_6m_blue: { key: 'premium_tier_6m_blue', title: "Premium Tier (6 Months) + Blue Tick" },
        gold_tier_1m: { key: 'gold_tier_1m', title: "Gold Tier (1 Month)" },
        gold_tier_3m: { key: 'gold_tier_3m', title: "Gold Tier (3 Months)" },
        gold_tier_6m: { key: 'gold_tier_6m', title: "Gold Tier (6 Months)" },
        gold_tier_3m_blue: { key: 'gold_tier_3m_blue', title: "Gold Tier (3 Months) + Blue Tick" },
        gold_tier_6m_blue: { key: 'gold_tier_6m_blue', title: "Gold Tier (6 Months) + Blue Tick" }
    };

    try {
        if (!userId || !item || !items[item]) return res.status(400).send("Invalid item payload.");

        const storeConfigStr = await redis.get('admin:store_config');
        const storeConfig = storeConfigStr ? JSON.parse(storeConfigStr) : {
            cooldown: 500,
            multiplier: 3000,
            premium_tier: 15000,
            gold_tier_1m: 50000,
            gold_tier_3m: 50000,
            gold_tier_6m: 90000,
            gold_tier_3m_blue: 80000,
            gold_tier_6m_blue: 150000
        };

        const user = await User.findOne({ telegram_id: userId });
        if (!user) return res.status(404).send("User not found.");

        let cost = storeConfig[item];
        let title = items[item].title;

        if (item === 'gold_tier_3m' && hasBlueTick) {
            cost = storeConfig.gold_tier_3m_blue;
            title += " + Blue Tick";
        } else if (item === 'gold_tier_6m' && hasBlueTick) {
            cost = storeConfig.gold_tier_6m_blue;
            title += " + Blue Tick";
        } else if (item === 'premium_tier_3m' && hasBlueTick) {
            cost = storeConfig.premium_tier_3m_blue;
            title += " + Blue Tick";
        } else if (item === 'premium_tier_6m' && hasBlueTick) {
            cost = storeConfig.premium_tier_6m_blue;
            title += " + Blue Tick";
        }

        // Block multiplier re-purchase while still active (check before deducting)
        if (item === 'multiplier' && user.ad_multiplier === 2 && user.multiplier_expires_at && new Date(user.multiplier_expires_at) > new Date()) {
            const daysLeft = Math.ceil((new Date(user.multiplier_expires_at) - new Date()) / (1000 * 60 * 60 * 24));
            return res.status(400).send(`Multiplier already active. ${daysLeft} day(s) remaining.`);
        }

        if ((user.points_balance || 0) < cost) {
            return res.status(400).send(`Insufficient balance. You need ${cost.toLocaleString()} PTS.`);
        }

        user.points_balance -= cost;

        let isPending = false;

        if (item === 'cooldown') {
            user.cooldown_until = 0;
            user.current_session_loop = 0;
        } else if (item === 'multiplier') {
            user.ad_multiplier = 2;
            const expDate = new Date();
            expDate.setMonth(expDate.getMonth() + 1);
            user.multiplier_expires_at = expDate;
        
        } else if (item === 'premium_tier_1m') {
            user.account_tier = 'Premium';
            const expDate = new Date();
            expDate.setMonth(expDate.getMonth() + 1);
            user.tier_expiry = expDate;
        } else if (item === 'gold_tier_1m') {
            user.account_tier = 'Gold';
            const expDate = new Date();
            expDate.setMonth(expDate.getMonth() + 1);
            user.tier_expiry = expDate;
        } else if (item === 'premium_tier_3m_blue') {
            isPending = true;
        } else if (item === 'premium_tier_6m_blue') {
            isPending = true;
        } else if (item === 'gold_tier_3m_blue') {
            isPending = true;
        } else if (item === 'gold_tier_6m_blue') {
            isPending = true;
        } else if (item === 'premium_tier_3m') {
            if (hasBlueTick) {
                isPending = true;
            } else {
                user.account_tier = 'Premium';
                const expDate = new Date();
                expDate.setMonth(expDate.getMonth() + 3);
                user.tier_expiry = expDate;
            }
        } else if (item === 'premium_tier_6m') {
            if (hasBlueTick) {
                isPending = true;
            } else {
                user.account_tier = 'Premium';
                const expDate = new Date();
                expDate.setMonth(expDate.getMonth() + 6);
                user.tier_expiry = expDate;
            }
        } else if (item === 'gold_tier_3m') {
            if (hasBlueTick) {
                isPending = true;
            } else {
                user.account_tier = 'Gold';
                user.x_blue_tick = false;
                const expDate = new Date();
                expDate.setMonth(expDate.getMonth() + 3);
                user.tier_expiry = expDate;
            }
        } else if (item === 'gold_tier_6m') {
            if (hasBlueTick) {
                isPending = true;
            } else {
                user.account_tier = 'Gold';
                user.x_blue_tick = false;
                const expDate = new Date();
                expDate.setMonth(expDate.getMonth() + 6);
                user.tier_expiry = expDate;
            }
        }

        // Save to Store Orders
        const newOrder = new StoreOrder({
            telegram_id: user.telegram_id,
            item_key: item,
            item_title: title,
            cost: cost,
            blue_tick: hasBlueTick,
            status: isPending ? 'pending' : 'completed',
            resolved_at: isPending ? null : new Date()
        });
        await newOrder.save();

        if (!user.earnings_history) user.earnings_history = [];
        user.earnings_history.unshift({
            type: isPending ? `[PENDING] Store Purchase: ${title}` : `[COMPLETED] Store Purchase: ${title}`,
            amount: -cost,
            timestamp: getFormattedDateTime()
        });

        await user.save();
        await invalidateUserCache(userId);

        // Notify Admin via Telegram if it's a Blue Tick request
        if (isPending) {
            try {
                const fetch = require('node-fetch');
                const tgToken = process.env.BOT_TOKEN;
                const msg = `🚨 *New Gold Tier + Blue Tick Request* 🚨\n\nUser: @${user.username || user.telegram_id}\nItem: ${title}\nCost: ${cost.toLocaleString()} PTS\n\nCheck the Admin Dashboard to fulfill the X Blue Tick verification and approve the upgrade.`;
                const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
                await fetch(tgUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: '6314427516', text: msg, parse_mode: 'Markdown' })
                });
            } catch (err) {
                console.error("Failed to notify admin on Telegram:", err);
            }
        }

        return res.json({ success: true, newBalance: user.points_balance, isPending });
    } catch (e) {
        console.error("Store error:", e);
        return res.status(500).send("Purchase failed.");
    }
});

// --- 🌟 GENERATE INVOICE FOR TELEGRAM STARS ---
router.post(['/generate-invoice', '/portal/generate-invoice'], verifyTelegramWebAppData, async (req, res) => {
    const userId = String(req.body.id || "");
    const item = String(req.body.item || "");
    const amount = parseInt(req.body.amount || 0);
    const hasBlueTick = Boolean(req.body.hasBlueTick || false);

    if (!userId || !item || amount <= 0) {
        return res.status(400).send("Invalid invoice payload.");
    }

    try {
        const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
        const fetch = require('node-fetch');
        
        const payload = JSON.stringify({ userId, item, amount, hasBlueTick });
        
        let title = "Store Purchase";
        if (item === 'premium_tier') title = "Premium Tier Upgrade";
        else if (item === 'gold_tier') title = "Gold Tier Upgrade";
        else if (item === 'x_verify') title = "X Verification Pack";

        const tgUrl = `https://api.telegram.org/bot${botToken}/createInvoiceLink`;
        const invoiceData = {
            title: title,
            description: `Payment for ${title} using Telegram Stars`,
            payload: payload,
            provider_token: "", // Empty string for Stars
            currency: "XTR",
            prices: [{ label: title, amount: amount }]
        };

        const response = await fetch(tgUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(invoiceData)
        });

        const data = await response.json();
        
        if (data.ok && data.result) {
            return res.json({ success: true, invoiceUrl: data.result });
        } else {
            console.error("Failed to generate invoice:", data);
            return res.status(500).json({ success: false, error: data.description });
        }
    } catch (e) {
        console.error("Invoice generation error:", e);
        return res.status(500).send("Invoice generation failed.");
    }
});

// --- 📊 AD TELEMETRY REPORTING ---
router.post(['/ad-telemetry', '/portal/ad-telemetry'], verifyTelegramWebAppData, async (req, res) => {
    try {
        const { network, status, errorMsg } = req.body;
        if (!network || !status) return res.status(400).send("Invalid payload");

        const key = 'admin:ad_telemetry';
        let telemetryStr = await redis.get(key);
        let telemetry = telemetryStr ? JSON.parse(telemetryStr) : {};

        if (!telemetry[network]) {
            telemetry[network] = { success: 0, fail: 0, lastError: null, lastUpdate: null };
        }

        if (status === 'success') {
            telemetry[network].success += 1;
        } else if (status === 'fail') {
            telemetry[network].fail += 1;
            telemetry[network].lastError = errorMsg || "Unknown error";
        }

        telemetry[network].lastUpdate = new Date().toISOString();

        await redis.set(key, JSON.stringify(telemetry));
        res.status(200).send("OK");
    } catch (e) {
        console.error("Telemetry Error:", e);
        res.status(500).send("Error");
    }
});

// --- 💸 SECURE TRANSACTIONAL PAYOUT ROUTE (PROTECTED + MUTEX + QUEUED) ---
router.post(['/request-payout', '/portal/request-payout'], verifyTelegramWebAppData, globalEcosystemCheck, transactionalLimiter, async (req, res) => {
    const userId = String(req.body.id || "");
    const destination = String(req.body.destination || "");
    const chosenAsset = String(req.body.asset || "");
    const requestedAmount = parseInt(req.body.amount) || 0;

    try {
        if (!req.globalSettings.withdrawals) {
            return res.status(403).send("Withdrawals are temporarily disabled by the administrator.");
        }

        if (!userId || !destination || !chosenAsset || requestedAmount <= 0) {
            return res.status(400).send("Incomplete payload specifications.");
        }

        // 🛡️ Redis Mutex Lock to block payout double spending / parallel clicks
        const lockKey = `lock:payout:${userId}`;
        const isLocked = await redisWithTimeout(redis.set(lockKey, "1", "NX", "EX", 10));
        if (!isLocked) {
            console.log(`⚠️ [Rate Limit] Rejected concurrent payout request for user: ${userId}`);
            return res.status(429).send("A transaction is already in progress. Please wait.");
        }

        const user = await User.findOne({ telegram_id: userId });
        if (!user) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(404).send("User profile signature missing.");
        }

        if (user.is_banned) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(403).send("Account suspended. Withdrawals blocked.");
        }

        if (requestedAmount > (user.points_balance || 0)) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(400).send("Insufficient points balance.");
        }

        if (chosenAsset === 'NAIRA' && !/^\d{10}$/.test(destination)) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(400).send("Naira bank transfers require a precise 10-digit account details profile.");
        }

        const todayStr = new Date().toISOString().split('T')[0];
        if (!user.daily_withdrawals || user.daily_withdrawals.date !== todayStr) {
            user.daily_withdrawals = { date: todayStr, count: 0 };
        }

        if (user.daily_withdrawals.count >= 2) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(403).send("Daily Limit Reached: You can only withdraw up to 2 times per day.");
        }

        const withdrawalsMade = user.withdrawals_count || 0;
        const qualifiedCount = (user.referrals || []).filter(r => r.qualified).length;
        const isUplinePromoter = (qualifiedCount >= 10);

        const thresholdLimit = (withdrawalsMade === 0) ? 1500 : 1250;

        if (!isUplinePromoter && requestedAmount < thresholdLimit) {
            await redisWithTimeout(redis.del(lockKey));
            return res.status(403).send(`Minimum withdrawal is ${thresholdLimit} PTS.`);
        }

        const uniqueTxId = `TX-${Date.now().toString().slice(-6)}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

        const debitedPoints = requestedAmount;
        user.points_balance = (user.points_balance || 0) - debitedPoints;
        user.withdrawals_count = withdrawalsMade + 1;
        user.last_withdrawal_date = new Date();
        user.daily_withdrawals.count += 1;

        const formattedTimestamp = getFormattedDateTime();

        if (!user.transactions) user.transactions = [];
        user.transactions.unshift({
            txId: uniqueTxId,
            type: `Withdrawal (${chosenAsset})`,
            amount: debitedPoints,
            date: formattedTimestamp,
            status: "Pending"
        });

        // Handle referral updates if this is the user's first withdrawal
        const referrerTelegramId = user.referrer_id || user.referred_by || user.upline;
        if (withdrawalsMade === 0 && referrerTelegramId && referrerTelegramId !== userId) {
            const referrer = await User.findOne({ telegram_id: referrerTelegramId });
            if (referrer) {
                if (!referrer.referrals) referrer.referrals = [];
                const refEntry = referrer.referrals.find(r => r.telegram_id === userId);
                if (refEntry) refEntry.qualified = true;

                const referrerQualifiedCount = referrer.referrals.filter(r => r.qualified).length;

                const milestones = [
                    { n: 10, pts: 6250, label: "Contest Milestone Tier 1 (10 Refs)" },
                    { n: 20, pts: 6250, label: "Contest Milestone Tier 2 (20 Refs)" },
                    { n: 50, pts: 18750, label: "Contest Milestone Tier 3 (50 Refs)" },
                    { n: 100, pts: 31250, label: "Contest Milestone Tier 4 (100 Refs)" }
                ];

                if (!referrer.milestones_claimed) {
                    referrer.milestones_claimed = { tier_10: false, tier_20: false, tier_50: false, tier_100: false };
                }

                let referrerNeedsSave = false;
                for (const m of milestones) {
                    const claimKey = `tier_${m.n}`;
                    if (referrerQualifiedCount >= m.n && !referrer.milestones_claimed[claimKey]) {
                        referrer.points_balance = (referrer.points_balance || 0) + m.pts;
                        referrer.milestones_claimed[claimKey] = true;
                        
                        if (!referrer.earnings_history) referrer.earnings_history = [];
                        referrer.earnings_history.unshift({
                            type: m.label,
                            amount: m.pts,
                            timestamp: formattedTimestamp
                        });
                        referrerNeedsSave = true;

                        // Enqueue milestone reached message to referrer via Bull Queue
                        const milestoneMsg = `🎉 <b>Referral Milestone Reached!</b>\n\nYou have successfully unlocked <b>${m.label}</b> with ${referrerQualifiedCount} qualified referrals.\n\n⚡ <b>+${m.pts.toLocaleString()} PTS ($${(m.pts * 0.0008).toFixed(2)} USD)</b> has been added to your balance!`;
                        await sendTelegramMessageAsync(referrer.telegram_id, milestoneMsg);
                    }
                }
                if (referrerNeedsSave) {
                    await referrer.save();
                    await invalidateUserCache(referrer.telegram_id);
                }
            }
        }

        await user.save();

        // 3. Create structural Withdrawal database ticket entry for administrative logging
        const ticket = new Withdrawal({
            id: uniqueTxId,
            telegram_id: String(userId),
            username: user.username,
            amount_points: debitedPoints,
            asset: chosenAsset,
            bank_provider: req.body.bank || null,
            destination_details: destination,
            status: "Pending",
            created_at: new Date()
        });
        await ticket.save();

        await invalidateUserCache(userId);
        await redisWithTimeout(redis.del(lockKey)); // releaseMutex

        const adminChatId = "6314427516";
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        
        let valuationString = `$${(debitedPoints * 0.0008).toFixed(2)} USD`;
        if (chosenAsset === 'NAIRA') {
            const nairaValue = debitedPoints * 0.0008 * 1600;
            valuationString = `$${(debitedPoints * 0.0008).toFixed(2)} USD (₦${nairaValue.toLocaleString('en-US', {minimumFractionDigits: 2})})`;
        }

        const approvalUrl = `${hostUrl}/admin/payout?txId=${uniqueTxId}&action=approve&secret=${ADMIN_SECRET_SIGNATURE}`;
        const rejectionUrl = `${hostUrl}/admin/payout?txId=${uniqueTxId}&action=reject&secret=${ADMIN_SECRET_SIGNATURE}`;

        const adminMessageText = `🚨 <b>NEW WITHDRAWAL REQUEST</b> 🚨\n\n` +
            `👤 <b>User:</b> ${escapeTelegramHtml(user.first_name || 'N/A')} (@${escapeTelegramHtml(user.username || 'Anonymous')})\n` +
            `🆔 <b>Telegram ID:</b> <code>${escapeTelegramHtml(userId)}</code>\n` +
            `🧾 <b>TX ID:</b> <code>${escapeTelegramHtml(uniqueTxId)}</code>\n\n` +
            `💰 <b>Amount:</b> <b>${debitedPoints.toLocaleString()} PTS</b>\n` +
            `💵 <b>Value:</b> <b>${valuationString}</b>\n` +
            `⚡ <b>Network Selected:</b> ${escapeTelegramHtml(chosenAsset)}\n` +
            `🏦 <b>Financial Provider:</b> ${escapeTelegramHtml(req.body.bank || 'None (Crypto/Stars)')}\n` +
            `📥 <b>Destination:</b>\n<code>${escapeTelegramHtml(destination)}</code>\n\n` +
            `📅 <b>Date:</b> ${formattedTimestamp}\n\n` +
            `👇 <b>ACTIONS:</b>\n` +
            `✅ <a href="${approvalUrl}">Approve and Post to Channel</a>\n\n` +
            `❌ <a href="${rejectionUrl}">Reject and Refund Points</a>`;

        // Enqueue alert to admin via Bull Queue
        await sendTelegramMessageAsync(adminChatId, adminMessageText, { disable_web_page_preview: true });

        return res.sendStatus(200);

    } catch (err) {
        console.error("Financial router allocation engine failure:", err);
        return res.status(500).send("Internal accounting ledger fault.");
    }
});

// --- 🎯 BOUNTY SUBMISSION ---
router.post(['/submit-bounty', '/portal/submit-bounty'], verifyTelegramWebAppData, async (req, res) => {
    const userId = String(req.body.id || "");
    const bountyId = String(req.body.bounty_id || "");
    let proofUrl = String(req.body.proof_url || "").trim();

    try {
        if (!userId || !bountyId) return res.status(400).send("Invalid payload.");

        const user = await User.findOne({ telegram_id: userId });
        if (!user) return res.status(404).send("User not found.");

        const Bounty = require('../models/Bounty');
        const bounty = await Bounty.findById(bountyId);
        if (!bounty || bounty.status !== 'active') return res.status(404).send("Bounty not available.");

        // Check tier limits
        if (bounty.tier_required === 'Premium' && user.account_tier === 'Standard') return res.status(403).send("Requires Premium tier.");
        if (bounty.tier_required === 'Gold' && user.account_tier !== 'Gold') return res.status(403).send("Requires Gold tier.");

        // Check geo
        if (bounty.target_countries && bounty.target_countries.length > 0 && !bounty.target_countries.includes(user.country)) {
            return res.status(403).send("Bounty not available in your region.");
        }

        if (bounty.requires_link !== false && !proofUrl) {
            return res.status(400).send("A proof link is required for this task.");
        }
        
        // Prevent duplicate
        const existing = await BountySubmission.findOne({ bounty_id: bountyId, telegram_id: userId });
        if (existing) return res.status(400).send("You have already submitted proof for this task.");

        const isAutoApprove = (bounty.requires_link === false);

        const submission = new BountySubmission({
            bounty_id: bountyId,
            telegram_id: userId,
            proof_url: proofUrl || "N/A",
            status: isAutoApprove ? 'approved' : 'pending'
        });
        await submission.save();
        if (isAutoApprove) {
            bounty.current_participants += 1;
            bounty.completions = (bounty.completions || 0) + 1;
            if (bounty.current_participants >= bounty.max_participants) {
                bounty.status = 'completed';
            }
            await bounty.save();

            user.points_balance = (user.points_balance || 0) + bounty.reward_pts;
            if (!user.earnings_history) user.earnings_history = [];
            user.earnings_history.unshift({
                type: `Bounty: ${bounty.title}`,
                amount: bounty.reward_pts,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            await user.save();
        }

        try {
            const redis = require('../services/redis');
            if (redis) await redis.del(`user:${userId}:profile`);
        } catch (e) {}

        if (isAutoApprove) {
            return res.status(200).send("Verified successfully!");
        } else {
            return res.status(200).send("Submission received! Pending admin verification.");
        }
    } catch (e) {
        console.error("Bounty submission error:", e);
        res.status(500).send("Internal error processing submission.");
    }
});

module.exports = router;