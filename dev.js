// dev.js
const app = require('./api/index');
const PORT = process.env.PORT || 3000;

// Grab the Telegraf bot instance attached to Express settings
const bot = app.get('bot');

// Safety net: prevent ANY unhandled promise rejection from crashing the server
process.on('unhandledRejection', (err) => {
    console.error('⚠️ [Process] Unhandled promise rejection (caught):', err.message || err);
});

const server = app.listen(PORT, async () => {
    console.log(`📡 Server running on port ${PORT}`);
    
    if (bot) {
        try {
            console.log("🤖 Launching Telegram long-polling worker...");
            // Force delete any active production webhooks so long-polling works
            await bot.telegram.deleteWebhook({ drop_pending_updates: true });
            
            // CRITICAL: bot.launch() returns a Promise. Must .catch() it or a 409
            // Conflict (another instance polling) will crash the entire process.
            bot.launch().catch((botErr) => {
                console.error("⚠️ Bot long-polling stopped:", botErr.message);
                console.log("📡 HTTP server remains online. Web app is still functional.");
            });
            console.log("✅ Bot listener is active. The event loop is locked online.");
        } catch (botError) {
            console.error("⚠️ Failed to boot bot long-polling daemon:", botError.message);
            console.log("📡 HTTP server remains online. Web app is still functional.");
        }
    }
});

// Prevent process drop-offs on interrupt flags
process.once('SIGINT', () => { if(bot) bot.stop('SIGINT'); server.close(); });
process.once('SIGTERM', () => { if(bot) bot.stop('SIGTERM'); server.close(); });