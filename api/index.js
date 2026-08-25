require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const { ONBOARDING_REWARD_PTS, ADMIN_TELEGRAM_CHAT_ID, CAPTCHA_LENGTH } = require('../constants');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ad-earn-bot";

// Ensure the connection string includes a database name.
// Atlas URIs often end with "...mongodb.net:27017/?ssl=..." (no db name) which
// causes Mongoose to default to the "test" database silently.
function ensureDbName(uri) {
    // Match the pattern: ...port/  immediately followed by ? (no db name)
    // e.g. :27017/?ssl=true  →  :27017/ad-earn-bot?ssl=true
    if (/:\d+\/\?/.test(uri)) {
        return uri.replace(/:\d+\/\?/, (match) => match.replace('/?', '/ad-earn-bot?'));
    }
    // If no query string at all: ...port/  →  ...port/ad-earn-bot
    if (/:\d+\/?$/.test(uri)) {
        return uri.replace(/\/?$/, '/ad-earn-bot');
    }
    return uri;
}

const finalUri = ensureDbName(MONGODB_URI);
console.log("📡 [Database] Connecting to MongoDB...");

// Track connection state so middleware can block requests until ready
let mongoConnected = false;
let mongoConnectionError = null;

const mongoReady = mongoose.connect(finalUri, {
    serverSelectionTimeoutMS: 10000,   // Fail fast if Atlas is unreachable
    socketTimeoutMS: 45000,            // Kill idle sockets after 45s
})
  .then(() => {
      mongoConnected = true;
      console.log("📡 [Database] MongoDB connection established successfully.");
  })
  .catch(err => {
      mongoConnectionError = err.message;
      console.error("❌ [Database] MongoDB connection error:", err.message);
  });

// Expose connection state for dev.js (attached to app after it's created)


// 🔄 AUTO-DETECT PREVIEW vs PRODUCTION
// Render sets RENDER_GIT_BRANCH on PR preview services (e.g. "features-branches")
// Production services have RENDER_GIT_BRANCH = "main" or it's not set
const isPreview = process.env.RENDER_GIT_BRANCH && process.env.RENDER_GIT_BRANCH !== 'main';
if (isPreview) {
    console.log(`🔬 [Preview Mode] Detected PR preview on branch: ${process.env.RENDER_GIT_BRANCH}`);
    if (process.env.PREVIEW_BOT_TOKEN) {
        process.env.BOT_TOKEN = process.env.PREVIEW_BOT_TOKEN;
        console.log("🔬 [Preview Mode] Using PREVIEW_BOT_TOKEN for test bot");
    } else {
        console.warn("⚠️ [Preview Mode] PREVIEW_BOT_TOKEN not set — bot will not start");
    }
}

// Use process.cwd() to dynamically locate modular dependencies safely
const bot = require(path.join(process.cwd(), "bot"));
const sybil = require(path.join(process.cwd(), "security", "sybil")); // Resolved to security folder
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));
app.set("bot", bot);

// Serve static assets (images, css, etc.) from the public folder
app.use("/public", express.static(path.join(process.cwd(), "public")));

// ==========================================
// 🛡️ DATABASE READINESS GATEWAY
// ==========================================
// Block all requests until MongoDB is connected.
// Prevents "Authentication engine tracking fault" caused by querying a disconnected database.
app.use(async (req, res, next) => {
    // Allow static assets and webhook through without waiting
    if (req.path.startsWith('/public') || req.path.startsWith('/static') || req.path === '/api/webhook' || req.path === '/favicon.ico') {
        return next();
    }

    if (mongoConnected) return next();

    // Wait up to 15 seconds for the initial connection
    try {
        await Promise.race([
            mongoReady,
            new Promise((_, reject) => setTimeout(() => reject(new Error('MongoDB connection timed out')), 15000))
        ]);
        next();
    } catch (err) {
        console.error("❌ [Gateway] MongoDB not available:", err.message);
        res.status(503).send("Database is connecting. Please refresh in a moment.");
    }
});

// ==========================================
// 🛡️ LOOP-PROOF ROUTE EXEMPTION MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
    const publicExemptions = [
        '/onboarding',
        '/portal/verify-sybil',
        '/api/webhook',
        '/favicon.ico'
    ];

    if (publicExemptions.includes(req.path) || req.path.startsWith('/public') || req.path.startsWith('/static')) {
        return next();
    }
    
    next();
});

// Mounted Routes
const authRouter = require(path.join(process.cwd(), "routes", "auth"));
const portalRouter = require(path.join(process.cwd(), "routes", "portal"));
const adminRouter = require(path.join(process.cwd(), "routes", "admin"));

app.use("/auth", authRouter);
app.use("/", portalRouter);
app.use("/admin", adminRouter);

// --- 📊 BULL BOARD QUEUE MONITORING BOARD (ADMIN-PROTECTED) ---
const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { telegramQueue, sendTelegramMessageAsync } = require(path.join(process.cwd(), 'services', 'queue'));

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
    queues: [new BullAdapter(telegramQueue)],
    serverAdapter: serverAdapter,
});

app.use('/admin/queues', (req, res, next) => {
    const secret = req.query.secret || req.headers['x-admin-secret'];
    const ADMIN_SECRET_SIGNATURE = process.env.ADMIN_SECRET_SIGNATURE;
    if (!ADMIN_SECRET_SIGNATURE) {
        console.error('FATAL: ADMIN_SECRET_SIGNATURE environment variable is not set.');
    }
    
    if (secret !== ADMIN_SECRET_SIGNATURE) {
        console.warn(`⚠️ [Security Alert] Unauthorized access attempt to Bull Board Dashboard.`);
        return res.status(403).send("Forbidden: Unauthorized queues dashboard access.");
    }
    next();
}, serverAdapter.getRouter());


// 🛡️ Webhook Endpoint Handler for live traffic
app.post("/api/webhook", async (req, res) => {
    console.log("📨 INBOUND TRAFFIC CAPTURED!");
    console.log("📝 Message Content:", req.body?.message?.text || "Non-text update");
    
    try {
        await bot.handleUpdate(req.body, res);
        console.log("✅ Telegraf processed message perfectly.");
    } catch (err) {
        console.error("❌ Webhook processing error:", err.message);
        res.status(500).send("Error");
    }
});

app.get("/", (req, res) => res.redirect("/auth"));

// 🔒 ONBOARDING SECURITY GATEWAY VIEW
app.get("/onboarding", async (req, res) => {
    const telegramId = req.query.id;
    if (!telegramId) return res.status(400).send("Missing Telegram ID.");
    
    // Generate a secure, highly legible 5-character alphanumeric token
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoids easily confused characters like O, 0, I, 1
    let captcha = '';
    for (let i = 0; i < CAPTCHA_LENGTH; i++) {
        captcha += characters.charAt(Math.floor(Math.random() * characters.length));
    }

    // Store CAPTCHA server-side in Redis (5 min TTL) — never trust client-sent answers
    const redis = require('../services/redis');
    await redis.setex(`captcha:${telegramId}`, 300, captcha.toUpperCase());

    // Render the premium onboarding view passing all expected layout variables
    res.render("onboarding", { 
        user: { telegram_id: telegramId },
        captchaCode: captcha,
        upline: req.query.upline || 'none'
    });
});

// 🛡️ CLIENT-TO-SERVER SYBIL DETECTION HANDSHAKE PROCESSOR
app.post("/portal/verify-sybil", async (req, res) => {
    const redis = require('../services/redis');
    // Rate limit: 5 attempts per IP per 15 minutes
    const rateLimitKey = `rl:sybil:${req.ip}`;
    const attempts = await redis.incr(rateLimitKey);
    if (attempts === 1) await redis.expire(rateLimitKey, 900);
    if (attempts > 5) {
        return res.status(429).json({ error: "Too many verification attempts. Try again later." });
    }

    const { id, fingerprint, solution, country, xHandle } = req.body;
    if (!id || !fingerprint || !country || !xHandle) {
        return res.status(400).json({ error: "Missing credentials or profile information." });
    }

    // Verify CAPTCHA against server-side stored answer (never trust client-sent expectedCaptcha)
    const storedCaptcha = await redis.get(`captcha:${id}`);
    if (!storedCaptcha) {
        return res.status(400).json({ error: "CAPTCHA expired. Please refresh the page and try again." });
    }
    // Delete after use (one-time attempt)
    await redis.del(`captcha:${id}`);

    if (!solution || solution.trim().toUpperCase() !== storedCaptcha.trim().toUpperCase()) {
        return res.status(400).json({ error: "Invalid code. Please try again." });
    }

    try {
        // Run advanced hardware signature checks via our security file
        const isFlagged = await sybil.isDeviceFingerprintFlagged(req, id, fingerprint);
        if (isFlagged) {
            return res.status(403).json({ error: "Multiple accounts detected. Access denied." });
        }

        const User = require(path.join(process.cwd(), 'models', 'User'));
        const user = await User.findOne({ telegram_id: String(id) });

        if (!user) {
            return res.status(404).json({ error: "User not found." });
        }

        // Apply onboarding updates, award initial verification points, and lock fingerprint to account
        user.onboarding_passed = true;
        user.device_fingerprint = fingerprint;
        user.device_hardware_hash = req.validatedHardwareHash || "legacy-hash";
        user.points_balance = (user.points_balance || 0) + ONBOARDING_REWARD_PTS; // +PTS onboarding reward
        
        user.country = country;
        
        // Auto-Format X Handle to full URL
        let formattedXHandle = xHandle.trim();
        if (!formattedXHandle.startsWith('http')) {
            // Remove @ if present
            if (formattedXHandle.startsWith('@')) {
                formattedXHandle = formattedXHandle.substring(1);
            }
            // Add base url
            formattedXHandle = `https://x.com/${formattedXHandle}`;
        }
        user.x_handle = formattedXHandle;
        user.x_verification_status = 'pending';
        
        // Push transactions to ledger
        if (!user.earnings_history) {
            user.earnings_history = [];
        }
        user.earnings_history.unshift({
            type: "Sybil Protection Reward",
            amount: ONBOARDING_REWARD_PTS,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        await user.save();

        try {
            const msg = `🚨 *New User Onboarded* 🚨\n\nUser: @${user.username || user.telegram_id}\nCountry: ${user.country}\nX Handle: ${user.x_handle}\n\nPlease check the Admin Dashboard to manually verify their account tier.`;
            await sendTelegramMessageAsync(ADMIN_TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error("Failed to notify admin on Telegram:", err);
        }

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error("Onboarding verification endpoint handler exception:", err);
        return res.status(500).json({ error: "Connection error. Try again." });
    }
});


// Attach MongoDB connection state to the app for dev.js to await
app.mongoReady = mongoReady;

module.exports = app;
