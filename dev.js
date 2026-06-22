// dev.js
const app = require('./api/index');
const PORT = process.env.PORT || 3000;

// Grab the Telegraf bot instance attached to Express settings
const bot = app.get('bot');

const server = app.listen(PORT, async () => {
    console.log(`ðŸ“¡ Local Cloudflare Dev Server running on port ${PORT}`);
    
    if (bot) {
        try {
            console.log("ðŸ¤– Launching local Telegram long-polling worker...");
            // Force delete any active production webhooks so long-polling functions locally
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            
            bot.launch();
            console.log("âœ… Bot listener is active. The event loop is locked online.");
        } catch (botError) {
            console.error("âš ï¸ Failed to boot bot long-polling daemon:", botError.message);
        }
    }
});

// Prevent process drop-offs on interrupt flags
process.once('SIGINT', () => { if(bot) bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { if(bot) bot.stop('SIGTERM'); server.close(); });