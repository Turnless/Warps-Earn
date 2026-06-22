const { Telegraf } = require('telegraf');
const path = require('path');
const database = require('./database'); // Point to your database helper

const bot = new Telegraf(process.env.BOT_TOKEN);

// DYNAMIC ROUTING: Prioritizes local testing tunnels over production Vercel deployment
const SERVER_URL = process.env.SERVER_URL || `https://turnless.vercel.app`;

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

        // Sync persistent native Menu Button
        await ctx.setChatMenuButton({
            type: 'web_app',
            text: '🕹️ Open App',
            web_app: { url: userAppUrl }
        }).catch((e) => console.error("⚠️ Menu button sync issue:", e.message));

        if (user && user.onboarding_passed) {
            try {
                return await ctx.reply(
                    `🚀 Hey @${username}, your profile is verified and active!\n\nTap the button below or the permanent "🕹️ Open App" button in the bottom-left menu corner to launch your dashboard.`,
                    inlineKeyboard
                );
            } catch (replyErr) {
                console.error("❌ Telegram refused reply dispatch:", replyErr.message);
            }
            return;
        }

        try {
            return await ctx.reply(
                `🔒 Just one quick security stop...\n\nTap the button below to verify your device structure and access your dashboard.`,
                inlineKeyboard
            );
        } catch (replyErr) {
            console.error("❌ Telegram refused reply dispatch:", replyErr.message);
        }

    } catch (err) {
        console.error("⚠️ Serious internal start handler fault:", err);
    }
});

module.exports = bot;