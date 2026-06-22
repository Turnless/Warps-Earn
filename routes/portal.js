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

// --- 📊 CORE DASHBOARD CONTROLLER ---
router.get('/dashboard', async (req, res) => {
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

        if (!user.onboarding_passed) {
            return res.redirect(`/onboarding?id=${userId}`);
        }

        res.render('dashboard', { user: user });

    } catch (e) {
        console.error("Dashboard view routing error:", e);
        res.status(500).send("Internal server error loading dashboard.");
    }
});

// --- 📺 AD GATEWAY INTERFACE CONTROLLER ---
router.get('/watch-ads', async (req, res) => {
    const userId = String(req.query.id || "");
    if (!userId) return res.status(400).send("Identity validation parameter missing.");

    try {
        // Fetch user from MongoDB
        const user = await User.findOne({ telegram_id: userId });
        if (!user) return res.status(404).send("User profile not found.");

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
                        <h2 style="margin-top: 10px; font-size: 18px;">Daily Cap Reached</h2>
                        <p style="font-size: 13px; color: #666; line-height: 1.5;">You have completed your 100 allocations for today. See you tomorrow!</p>
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
            const statusTitle = isMacro ? "System Recharging..." : "Taking a Quick Break";
            const statusDesc = isMacro 
                ? "To keep your account safe, please wait before your next block of loops." 
                : "Great job! Let your screen rest for 45 seconds before launching the next loop.";

            return res.send(`
                <body style="background-color: #e6ddd0; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; padding: 20px; color: #1a1a16;">
                    <div style="background: white; padding: 30px; border-radius: 24px; max-width: 340px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                        <span style="font-size: 40px;">${isMacro ? '⏳' : '⚡'}</span>
                        <h2 style="margin-top: 10px; font-size: 18px;">${statusTitle}</h2>
                        <p style="font-size: 13px; color: #666; line-height: 1.5;">${statusDesc}</p>
                        <div style="font-size: 32px; font-weight: bold; color: #1a1a16; margin: 15px 0; font-family: monospace;">${timeString}</div>
                        ${isMacro ? '<p style="font-size: 11px; color: #999; margin-bottom: 15px;">We will ping you via our bot when the loop block unlocks!</p>' : ''}
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
        res.status(500).send("Internal gateway fault.");
    }
});

// --- 📺 CLAIM COMPLETED AD LOOP REWARD (PROTECTED + RATE-LIMITED) ---
router.post(['/claim-ad-reward', '/portal/claim-ad-reward'], verifyTelegramWebAppData, transactionalLimiter, async (req, res) => {
    const userId = String(req.body.id || "");

    try {
        if (!userId) {
            return res.status(400).send("Invalid account parameters.");
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
            totalAds: result.totalAds
        });

        // If loop completes (reaches 3 loops, resulting in reset to index 0), enqueue cooldown restock message
        if (result.loopIndex === 0) { 
            const cooldownMs = result.cooldownTime; 
            
            await sendTelegramMessageAsync(
                userId,
                "⚡ <b>Ad Loops Restocked!</b>\n\nYour 15-minute verification break has completed. Open the Mini App now to burn through your next 3-loop block and stack more points!",
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
    const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "8631881085:AAHTPWtPuA6x64z7rj4rMwiX5NCZe5uW1VY";

    const rewardMap = {
        channel: 100,
        group: 100,
        payout_channel: 100,
        x_account: 100
    };

    const telegramChatMap = {
        channel: "@Warpsgit",
        group: "@warpscommunity",
        payout_channel: "@WarpsEarn"
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

// --- ✅ CLAIM CUSTOM AD/TASK REWARD (PROTECTED) ---
router.post(['/claim-custom-reward', '/portal/claim-custom-reward'], verifyTelegramWebAppData, async (req, res) => {
    const userId = String(req.body.id || "");
    const rewardAmount = parseInt(req.body.amount) || 1;
    const rewardType = String(req.body.type || "Custom Ad Reward");

    try {
        if (!userId) return res.status(400).send("Invalid account parameters.");

        const user = await User.findOne({ telegram_id: userId });
        if (!user) return res.status(404).send("User profile not found.");

        user.points_balance = (user.points_balance || 0) + rewardAmount;

        if (!user.earnings_history) user.earnings_history = [];
        user.earnings_history.unshift({
            type: rewardType,
            amount: rewardAmount,
            timestamp: getFormattedDateTime()
        });

        await user.save();
        await invalidateUserCache(userId);
        res.status(200).json({ success: true, newBalance: user.points_balance });

    } catch (e) {
        console.error("Custom reward allocation error:", e);
        res.status(500).send("Internal processing fault.");
    }
});

// --- ✅ VERIFY CUSTOM PROMO TASK (PROTECTED) ---
router.post(['/verify-custom-promo', '/portal/verify-custom-promo'], verifyTelegramWebAppData, async (req, res) => {
    const userId = String(req.body.id || "");
    const promoKey = String(req.body.promoKey || "");

    const promoMap = {
        promo1: { pts: 150, title: "Turnless Ecosystem Promo" }
    };

    try {
        if (!userId || !promoKey || !promoMap[promoKey]) return res.status(400).send("Invalid payload.");

        const user = await User.findOne({ telegram_id: userId });
        if (!user) return res.status(404).send("User not found.");

        if (!user.custom_promos) user.custom_promos = new Map();
        if (user.custom_promos.get(promoKey) === true) return res.status(400).send("Already verified.");

        const campaign = promoMap[promoKey];
        user.points_balance = (user.points_balance || 0) + campaign.pts;
        user.custom_promos.set(promoKey, true);

        if (!user.earnings_history) user.earnings_history = [];
        user.earnings_history.unshift({
            type: campaign.title,
            amount: campaign.pts,
            timestamp: getFormattedDateTime()
        });

        await user.save();
        await invalidateUserCache(userId);
        res.sendStatus(200);
    } catch (e) {
        console.error("Custom Promo Error:", e);
        res.status(500).send("Internal error.");
    }
});

// --- 💸 SECURE TRANSACTIONAL PAYOUT ROUTE (PROTECTED + MUTEX + QUEUED) ---
router.post(['/request-payout', '/portal/request-payout'], verifyTelegramWebAppData, transactionalLimiter, async (req, res) => {
    const userId = String(req.body.id || "");
    const destination = String(req.body.destination || "");
    const chosenAsset = String(req.body.asset || "");
    const requestedAmount = parseInt(req.body.amount) || 0;

    try {
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
                        const milestoneMsg = `🎉 <b>Contest Milestone Reached!</b>\n\nYou have successfully unlocked <b>${m.label}</b> with ${referrerQualifiedCount} qualified downlines.\n\n⚡ <b>+${m.pts.toLocaleString()} PTS ($${(m.pts * 0.0008).toFixed(2)} USD)</b> has been instantly added to your balance!`;
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
            status: "PENDING_AUDIT",
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

        const adminMessageText = `🚨 <b>NEW PAYOUT TRANSACTION</b> 🚨\n\n` +
            `👤 <b>User:</b> ${escapeTelegramHtml(user.first_name || 'N/A')} (@${escapeTelegramHtml(user.username || 'Anonymous')})\n` +
            `🆔 <b>Telegram ID:</b> <code>${escapeTelegramHtml(userId)}</code>\n` +
            `🧾 <b>TX ID:</b> <code>${escapeTelegramHtml(uniqueTxId)}</code>\n\n` +
            `💰 <b>Points Debited:</b> <b>${debitedPoints.toLocaleString()} PTS</b>\n` +
            `💵 <b>USD Valuation:</b> <b>${valuationString}</b>\n` +
            `⚡ <b>Network Selected:</b> ${escapeTelegramHtml(chosenAsset)}\n` +
            `🏦 <b>Financial Provider:</b> ${escapeTelegramHtml(req.body.bank || 'None (Crypto/Stars)')}\n` +
            `📥 <b>Target Details Address:</b>\n<code>${escapeTelegramHtml(destination)}</code>\n\n` +
            `📅 <b>Initialized Timestamp:</b> ${formattedTimestamp}\n\n` +
            `👇 <b>MANUAL PROCESSOR CONTROLS:</b>\n` +
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

module.exports = router;