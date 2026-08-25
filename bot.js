const { Telegraf } = require('telegraf');
const path = require('path');
const database = require('./database'); // Point to your database helper
const { ADMIN_TELEGRAM_CHAT_ID } = require('./constants');

const bot = process.env.BOT_TOKEN ? new Telegraf(process.env.BOT_TOKEN) : null;

// DYNAMIC ROUTING: Prioritizes local testing tunnels over production Vercel deployment
const SERVER_URL = process.env.SERVER_URL || `https://turnless.vercel.app`;

if (bot) {
bot.command('start', async (ctx) => {
    const telegramId = String(ctx.from.id);
    const username = ctx.from.username || 'Anonymous';
    
    // EXTRACT THE DYNAMIC REFERRAL ID IF PRESENT
    const startPayload = ctx.startPayload || '';
    let uplineId = null;

    if (startPayload) {
        if (startPayload.startsWith('ref_')) {
            uplineId = startPayload.replace('ref_', '');
        } else if (/^\d+$/.test(startPayload)) {
            uplineId = startPayload;
        }
        console.log(`📡 [Bot Start] User ${telegramId} joined with upline payload: ${uplineId}`);
    }
    
    const userAppUrl = `${SERVER_URL}/auth?id=${telegramId}`;
    const inlineKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '🕹️ Open Warp Earn Hub',
                        web_app: { url: userAppUrl }
                    }
                ]
            ]
        }
    };

    try {
        // Create user profile and link upline if brand new
        let user = await database.setupUser(telegramId, username, uplineId);

        // Sync persistent native Menu Button — uses /auth without ?id= so loader.ejs shows first
        await ctx.setChatMenuButton({
            type: 'web_app',
            text: '🕹️ Open App',
            web_app: { url: `${SERVER_URL}/auth` }
        }).catch((e) => console.error("⚠️ Menu button sync issue:", e.message));

        if (user && user.onboarding_passed) {
            try {
                return await ctx.reply(
                    `🚀 Hey @${username}, welcome back!\n\nTap the button below to open the app and start earning.`,
                    inlineKeyboard
                );
            } catch (replyErr) {
                console.error("❌ Telegram refused reply dispatch:", replyErr.message);
            }
            return;
        }

        try {
            return await ctx.reply(
                `🔒 Let's get you set up...\n\nTap the button below to verify your account and access your dashboard.`,
                inlineKeyboard
            );
        } catch (replyErr) {
            console.error("❌ Telegram refused reply dispatch:", replyErr.message);
        }

    } catch (err) {
        console.error("⚠️ Serious internal start handler fault:", err);
    }
});


// --- 🌟 TELEGRAM STARS PAYMENT HANDLERS ---
bot.on('pre_checkout_query', async (ctx) => {
    try {
        const { invoice_payload, total_amount, currency } = ctx.preCheckoutQuery;
        
        // Validate currency
        if (currency !== 'XTR') {
            await ctx.answerPreCheckoutQuery(false, { error_message: "Invalid currency." });
            return;
        }

        // Parse and validate payload
        let payload;
        try {
            payload = JSON.parse(invoice_payload);
        } catch (e) {
            await ctx.answerPreCheckoutQuery(false, { error_message: "Invalid payment payload." });
            return;
        }

        const { item, amount } = payload;
        if (!item || !amount) {
            await ctx.answerPreCheckoutQuery(false, { error_message: "Invalid payment details." });
            return;
        }

        // Validate amount matches expected store price
        const redis = require('./services/redis');
        const storeConfigStr = await redis.get('admin:store_config');
        const { DEFAULT_STORE_CONFIG, DEFAULT_STARS_CONFIG } = require('./constants');
        const storeConfig = storeConfigStr ? JSON.parse(storeConfigStr) : { ...DEFAULT_STORE_CONFIG, ...DEFAULT_STARS_CONFIG };
        
        const expectedAmount = storeConfig[item];
        if (!expectedAmount || expectedAmount !== total_amount) {
            await ctx.answerPreCheckoutQuery(false, { error_message: "Price mismatch. Please try again." });
            return;
        }

        await ctx.answerPreCheckoutQuery(true);
    } catch (e) {
        console.error("❌ Pre-checkout query failed:", e);
        await ctx.answerPreCheckoutQuery(false, { error_message: "Payment verification failed." });
    }
});

bot.on('successful_payment', async (ctx) => {
    try {
        const payment = ctx.message.successful_payment;
        const payloadStr = payment.invoice_payload;
        
        console.log("💰 Successful Payment Received:", payment);
        
        if (!payloadStr) return;
        
        let payload;
        try {
            payload = JSON.parse(payloadStr);
        } catch (e) {
            console.error("❌ Failed to parse invoice payload:", payloadStr);
            return;
        }
        
        const { userId, item, amount, hasBlueTick } = payload;
        const User = require('./models/User');
        const StoreOrder = require('./models/StoreOrder');
        
        const user = await User.findOne({ telegram_id: userId });
        if (!user) return;
        
        let isPending = false;
        
        // Process the item upgrade (same logic as PTS)
        // Build a human-readable title for the order
        let orderTitle = item.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        if (item === 'x_verify') orderTitle = 'X Verification Pack';
        else if (item.startsWith('premium_tier_')) orderTitle = 'Premium Tier Upgrade';
        else if (item.startsWith('gold_tier_')) orderTitle = 'Gold Tier Upgrade';
        if (hasBlueTick && !item.includes('blue')) orderTitle += ' + Blue Tick';

        if (item.startsWith('premium_tier_')) {
            if (item.includes('blue')) {
                isPending = true;
            } else {
                user.account_tier = 'Premium';
                const expDate = new Date();
                const months = item.includes('6m') ? 6 : (item.includes('3m') ? 3 : 1);
                expDate.setMonth(expDate.getMonth() + months);
                user.tier_expiry = expDate;
            }
        } else if (item.startsWith('gold_tier_')) {
            if (item.includes('blue')) {
                isPending = true;
            } else {
                user.account_tier = 'Gold';
                user.x_blue_tick = false;
                const expDate = new Date();
                const months = item.includes('6m') ? 6 : (item.includes('3m') ? 3 : 1);
                expDate.setMonth(expDate.getMonth() + months);
                user.tier_expiry = expDate;
            }
        } else if (item === 'x_verify') {
            isPending = true;
        }

        await user.save();
        
        try {
            const redis = require('./services/redis');
            if (redis) await redis.del(`user:${userId}:profile`);
        } catch (err) {
            console.error("Cache clear failed in webhook:", err);
        }

        const order = new StoreOrder({
            telegram_id: userId,
            item_key: item,
            item_title: orderTitle,
            cost: amount,
            currency: 'stars',
            telegram_payment_charge_id: payment.telegram_payment_charge_id,
            status: isPending ? 'pending' : 'completed',
            blue_tick: hasBlueTick || false,
            resolved_at: isPending ? null : new Date()
        });
        await order.save();

        if (!user.earnings_history) user.earnings_history = [];
        user.earnings_history.unshift({
            type: isPending ? `[PENDING] Store Purchase (Stars): ${orderTitle}` : `[COMPLETED] Store Purchase (Stars): ${orderTitle}`,
            amount: 0,
            timestamp: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' • ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
        });
        await user.save();

        if (isPending) {
            try {
                const fetch = require('node-fetch');
                const tgToken = process.env.BOT_TOKEN;
                const msg = `🚨 *New Store Order via Stars (Pending)* 🚨\n\nUser: @${user.username || user.telegram_id}\nItem: ${orderTitle}\nCost: ${amount} Stars\n\nCheck the Admin Dashboard to fulfill the X Blue Tick verification and approve the upgrade.`;
                const tgUrl = `https://api.telegram.org/bot${tgToken}/sendMessage`;
                await fetch(tgUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: ADMIN_TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
                });
            } catch (err) {
                console.error("Failed to notify admin on Telegram:", err);
            }
        }

        if (isPending) {
            await ctx.reply("🛒 Payment successful! Your verification is pending review. We will notify you once it is approved.");
        } else {
            await ctx.reply("🛒 Payment successful! Your account has been upgraded.");
        }
    } catch (e) {
        console.error("❌ Successful payment processing failed:", e);
    }
});

} // end if (bot)

module.exports = bot;