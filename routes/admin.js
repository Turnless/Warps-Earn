const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Withdrawal = require('../models/Withdrawal');
const redis = require('../services/redis');
const { sendTelegramMessageAsync, telegramQueue } = require('../services/queue');

// Import environment parameters securely
require('dotenv').config();

// Pull system authentication values
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

// Format formatted ledger timestamps
function getFormattedDateTime() {
    const optionsDate = { month: 'short', day: 'numeric', year: 'numeric' };
    const optionsTime = { hour: '2-digit', minute: '2-digit', hour12: true };
    const dateStr = new Date().toLocaleDateString('en-US', optionsDate);
    const timeStr = new Date().toLocaleTimeString('en-US', optionsTime);
    return `${dateStr} • ${timeStr}`;
}

// --- 🛡️ AUTHENTICATION MIDDLEWARE ---
const checkAdminAuth = (req, res, next) => {
    // Support legacy secret query strings (like from the Telegram inline buttons) OR session cookies
    const secret = req.query.secret || req.headers['x-admin-secret'];
    let cookieSecret = null;
    
    if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        const match = cookies.find(c => c.startsWith('admin_token='));
        if (match) cookieSecret = match.split('=')[1];
    }
    
    if (secret === ADMIN_SECRET_SIGNATURE || cookieSecret === ADMIN_SECRET_SIGNATURE) {
        return next();
    }
    
    // If not authenticated, redirect to login page
    res.redirect('/admin/login');
};

// --- 🔐 LOGIN SYSTEM ---
router.get('/login', (req, res) => {
    res.render('admin_login');
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_SECRET_SIGNATURE) {
        // Set an authentication cookie valid for 24 hours
        res.cookie('admin_token', password, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true });
        return res.redirect('/admin');
    }
    res.render('admin_login', { error: "Invalid Passphrase." });
});

router.get('/logout', (req, res) => {
    res.clearCookie('admin_token');
    res.redirect('/admin/login');
});

// --- 🖥️ MAIN ADMIN DASHBOARD ---
router.get('/', checkAdminAuth, async (req, res) => {
    try {
        // Basic counts
        const totalUsers = await User.countDocuments();
        
        // Full pending list
        const pendingList = await Withdrawal.find({ status: 'Pending' }).sort({ created_at: -1 }).limit(50).lean();
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
        const topUsers = await User.find({}).sort({ points_balance: -1 }).limit(10).lean();

        // Fetch Global Settings from Redis
        let globalSettingsStr = await redis.get('global_settings');
        let globalSettings = globalSettingsStr ? JSON.parse(globalSettingsStr) : {
            maintenance: false,
            withdrawals: true,
            reward_per_ad: 3
        };

        const questsStr = await redis.get('admin:dynamic_quests');
        globalSettings.dynamicQuests = questsStr || '{}';

        // Fetch Ad Telemetry Data
        const telemetryStr = await redis.get('admin:ad_telemetry');
        const telemetryData = telemetryStr ? JSON.parse(telemetryStr) : {};

        res.render('admin_dashboard', { 
            secret: ADMIN_SECRET_SIGNATURE,
            stats: {
                users: totalUsers,
                pending: pendingCount,
                circulatingPts: totalCirculating,
                circulatingUsd: (totalCirculating * 0.0008).toFixed(2),
                adsWatched: totalAdsWatched,
                adEarnings: adEarnings,
                taskEarnings: taskEarnings,
                referralEarnings: referralEarnings,
                paidOutPts: totalPaidOut,
                paidOutUsd: (totalPaidOut * 0.0008).toFixed(2)
            },
            pendingList: pendingList,
            topUsers: topUsers,
            settings: globalSettings,
            telemetry: telemetryData
        });
    } catch (e) {
        console.error(e);
        res.status(500).send("Metrics Engine Failed");
    }
});

// --- ⚙️ GLOBAL SETTINGS CONTROLLER ---
router.post('/settings', checkAdminAuth, express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { maintenance, withdrawals, reward_per_ad, streak_reward } = req.body;
        const newSettings = {
            maintenance: maintenance === 'on',
            withdrawals: withdrawals === 'on',
            reward_per_ad: parseInt(reward_per_ad) || 3,
            streak_reward: parseInt(streak_reward) || 500
        };
        await redis.set('global_settings', JSON.stringify(newSettings));
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Failed to update settings");
    }
});

// --- 🎯 DYNAMIC QUESTS ENGINE ---
router.post('/quests', checkAdminAuth, express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const { action, key, title, url, pts, icon } = req.body;
        const questsStr = await redis.get('admin:dynamic_quests');
        let quests = questsStr ? JSON.parse(questsStr) : {};

        if (action === 'create' && key && title && url && pts) {
            quests[key] = {
                title: title.trim(),
                url: url.trim(),
                pts: parseInt(pts) || 0,
                icon: (icon || "🔥").trim()
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

// --- 🔍 USER LOOKUP & BAN CONTROLLER ---
router.get('/user-lookup', checkAdminAuth, async (req, res) => {
    const rawQuery = (req.query.q || '').trim();
    if (!rawQuery) return res.redirect('/admin');

    const cleanQuery = rawQuery.replace(/^@/, ''); // Strip the @ symbol if they typed it

    try {
        // Search by Telegram ID (exact) OR Username (regex case-insensitive)
        const targetUser = await User.findOne({
            $or: [
                { telegram_id: cleanQuery },
                { username: new RegExp('^' + cleanQuery + '$', 'i') }
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

router.post('/user-ban', checkAdminAuth, express.urlencoded({ extended: true }), async (req, res) => {
    const { telegram_id, action } = req.body;
    try {
        if (action === 'ban') {
            await User.updateOne({ telegram_id }, { is_banned: true });
        } else if (action === 'unban') {
            await User.updateOne({ telegram_id }, { is_banned: false });
        }
        res.redirect(`/admin/user-lookup?q=${telegram_id}`);
    } catch (e) {
        res.status(500).send("Action failed");
    }
});

// --- 🛠️ DYNAMIC USER MANAGEMENT CONTROLLERS ---
router.post('/user-manage-balance', checkAdminAuth, express.urlencoded({ extended: true }), async (req, res) => {
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
        }
        res.redirect(`/admin/user-lookup?q=${telegram_id}`);
    } catch (e) {
        res.status(500).send("Action failed");
    }
});

router.post('/user-reset-cooldown', checkAdminAuth, express.urlencoded({ extended: true }), async (req, res) => {
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
router.post('/broadcast', checkAdminAuth, express.urlencoded({ extended: true }), async (req, res) => {
    const { message_text } = req.body;
    try {
        if (!message_text) return res.redirect('/admin');
        const users = await User.find({}, { telegram_id: 1 }).lean();
        // Queue messages slightly spaced out to avoid Telegram API limits
        users.forEach((user, index) => {
            sendTelegramMessageAsync(user.telegram_id, message_text, {}, index * 50);
        });
        res.redirect('/admin');
    } catch (e) {
        res.status(500).send("Broadcast failed");
    }
});

// --- ⏰ AUTOMATED WAKE-UP NOTIFICATIONS ---
router.post('/wakeup-push', checkAdminAuth, async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        
        // Find users who haven't logged in today or yesterday
        const inactiveUsers = await User.find({
            last_login_date: { $nin: [todayStr, yesterday, null] }
        }, { telegram_id: 1, username: 1, points_balance: 1 }).lean();

        inactiveUsers.forEach((user, index) => {
            const message = `👋 Hey @${user.username || 'there'}!\n\nIt's been a while since we saw you. You have ${user.points_balance || 0} PTS waiting for you! Come back and watch a few ads to claim your next payout! 💸`;
            sendTelegramMessageAsync(user.telegram_id, message, {}, index * 100);
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
            { $limit: 50 }
        ]);

        res.render('admin_sybil_hunter', {
            secret: ADMIN_SECRET_SIGNATURE,
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
        const failedJobs = await telegramQueue.getFailed(0, 10);
        
        const failedList = failedJobs.map(job => ({
            id: job.id,
            failedReason: job.failedReason,
            data: job.data,
            attempts: job.attemptsMade
        }));

        res.render('admin_queues', {
            secret: ADMIN_SECRET_SIGNATURE,
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
        const { txId, action, secret } = req.query;

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
            await Withdrawal.updateOne({ id: txId }, { status: 'Successful' });

            const totalDebitedPoints = targetTx.amount;
            let valuationStr = `$${(totalDebitedPoints * 0.0008).toFixed(2)} USD`;
            if (targetTx.type.includes('NAIRA')) {
                const nairaValue = totalDebitedPoints * 0.0008 * 1600;
                valuationStr = `$${(totalDebitedPoints * 0.0008).toFixed(2)} USD (₦${nairaValue.toLocaleString('en-US', {minimumFractionDigits: 2})})`;
            }

            // --- 📢 Post direct proof to Telegram Channel via Bull Queue ---
            const proofReceiptText = `⚡ <b>WARPS EARN DISBURSEMENT COMPLETED</b> ⚡\n\n` +
                `👤 <b>Recipient:</b> ${escapeTelegramHtml(targetUser.first_name || 'Operator')} (@${escapeTelegramHtml(targetUser.username || 'Anonymous')})\n` +
                `🧾 <b>Transaction ID:</b> <code>${escapeTelegramHtml(txId)}</code>\n` +
                `💰 <b>Amount Disbursed:</b> <b>${totalDebitedPoints.toLocaleString()} PTS</b>\n` +
                `💵 <b>Total Valuation:</b> <b>${valuationStr}</b>\n` +
                `💼 <b>Network Asset:</b> ${escapeTelegramHtml(targetTx.type.replace('Withdrawal (', '').replace(')', ''))}\n` +
                `📅 <b>Settlement Timestamp:</b> ${getFormattedDateTime()}\n\n` +
                `💚 <i>Keep watching, keep sharing, keep stacking!</i>`;

            await sendTelegramMessageAsync(PUBLIC_PAYOUT_CHANNEL_ID, proofReceiptText);

            // Message target user directly via Bull Queue
            const userNotificationText = `💰 <b>Payout Successful!</b>\n\nYour withdrawal of <b>${totalDebitedPoints.toLocaleString()} PTS (${valuationStr})</b> has been processed successfully.\n\nReceipt proofs have been published to ${PUBLIC_PAYOUT_CHANNEL_ID}!`;
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
            await Withdrawal.updateOne({ id: txId }, { status: 'Rejected' });

            // Notify user of rejection reason via Bull Queue
            const userRejectionText = `❌ <b>Payout Request Rejected</b>\n\nYour withdrawal request for <b>${targetTx.amount.toLocaleString()} PTS</b> was declined by the administrator. Points have been fully restored to your balance.`;
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

// --- ⚡ EXCLUSIVE ADMINISTRATIVE DATA WIPE ENDPOINT ---
router.get('/delete-user', checkAdminAuth, async (req, res) => {
    const { id } = req.query;

    if (!id) {
        return res.status(400).send("Please provide an 'id' parameter (Telegram ID or 'all').");
    }

    try {
        if (id.toLowerCase() === 'all') {
            await User.deleteMany({});
            await redis.flushall();
            return res.send(`
                <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #e6ddd0; color: #1a1a16;">
                    <div style="background: white; padding: 40px; border-radius: 24px; text-align: center;">
                        <span style="font-size: 48px;">🗑️</span>
                        <h2>Global Database Wiped</h2>
                        <p>All users and cached sessions have been completely removed from production.</p>
                    </div>
                </body>
            `);
        } else {
            const result = await User.deleteOne({ telegram_id: String(id) });
            await redis.del(`user:${id}:profile`);
            await redis.del(`lock:claim:${id}`);
            await redis.del(`lock:payout:${id}`);
            
            const message = result.deletedCount > 0 
                ? `Successfully removed user <b>${id}</b> from database and cache.`
                : `User <b>${id}</b> was not found in the database, but their cache was cleared.`;

            return res.send(`
                <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #e6ddd0; color: #1a1a16;">
                    <div style="background: white; padding: 40px; border-radius: 24px; text-align: center;">
                        <span style="font-size: 48px;">✅</span>
                        <h2>User Data Cleared</h2>
                        <p>${message}</p>
                    </div>
                </body>
            `);
        }
    } catch (err) {
        console.error("Data wipe failure:", err);
        return res.status(500).send("Wipe operation failed.");
    }
});

module.exports = router;