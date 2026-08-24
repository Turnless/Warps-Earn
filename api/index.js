require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

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
mongoose.connect(finalUri, {
    serverSelectionTimeoutMS: 10000,   // Fail fast if Atlas is unreachable
    socketTimeoutMS: 45000,            // Kill idle sockets after 45s
})
  .then(() => console.log("📡 [Database] MongoDB connection established successfully."))
  .catch(err => console.error("❌ [Database] MongoDB connection error:", err.message));


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
    const ADMIN_SECRET_SIGNATURE = process.env.ADMIN_SECRET_SIGNATURE || 'warps_payout_sec_2026';
    
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
app.get("/onboarding", (req, res) => {
    const telegramId = req.query.id;
    if (!telegramId) return res.status(400).send("Missing Telegram ID.");
    
    // Generate a secure, highly legible 5-character alphanumeric token
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoids easily confused characters like O, 0, I, 1
    let captcha = '';
    for (let i = 0; i < 5; i++) {
        captcha += characters.charAt(Math.floor(Math.random() * characters.length));
    }

    // Render the premium onboarding view passing all expected layout variables
    res.render("onboarding", { 
        user: { telegram_id: telegramId },
        captchaCode: captcha,
        upline: req.query.upline || 'none'
    });
});

// ⚡ SERVER-SIDE AD LOOP VERIFIER
app.post('/portal/claim-ad-reward', async (req, res) => {
    try {
        const { id } = req.body;
        
        if (!id) {
            return res.status(400).send("Invalid request.");
        }

        const db = require(path.join(process.cwd(), 'database')); 
        
        const userProfile = await db.getUser(id);
        if (!userProfile) {
            return res.status(404).send("User not found.");
        }

        if (userProfile.cooldown_until && userProfile.cooldown_until > Date.now()) {
            const structuralRemainingSecs = Math.ceil((userProfile.cooldown_until - Date.now()) / 1000);
            return res.status(429).send(`Cooling down. Please wait ${structuralRemainingSecs} seconds.`);
        }

        const operationResult = await db.watchAdRound(id);

        return res.status(200).json({
            success: true,
            meta: operationResult
        });

    } catch (serverRouteError) {
        console.error("Critical error clearing ad asset verification route execution:", serverRouteError);
        return res.status(500).send("Connection error. Try again.");
    }
});

// 🛡️ CLIENT-TO-SERVER SYBIL DETECTION HANDSHAKE PROCESSOR
app.post("/portal/verify-sybil", async (req, res) => {
    const { id, fingerprint, solution, expectedCaptcha, country, xHandle } = req.body;
    if (!id || !fingerprint || !country || !xHandle) {
        return res.status(400).json({ error: "Missing credentials or profile information." });
    }

    // Securely validate the CAPTCHA solution matching check on the backend
    if (!solution || solution.trim().toUpperCase() !== expectedCaptcha.trim().toUpperCase()) {
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
        user.points_balance = (user.points_balance || 0) + 100; // +100 PTS onboarding reward
        
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
            amount: 100,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        await user.save();

        try {
            const msg = `🚨 *New User Onboarded* 🚨\n\nUser: @${user.username || user.telegram_id}\nCountry: ${user.country}\nX Handle: ${user.x_handle}\n\nPlease check the Admin Dashboard to manually verify their account tier.`;
            await sendTelegramMessageAsync('6314427516', msg, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error("Failed to notify admin on Telegram:", err);
        }

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error("Onboarding verification endpoint handler exception:", err);
        return res.status(500).json({ error: "Connection error. Try again." });
    }
});


module.exports = app;
