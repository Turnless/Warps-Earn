require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ad-earn-bot";
console.log("📡 [Database] Connecting to MongoDB at " + MONGODB_URI);
mongoose.connect(MONGODB_URI)
  .then(() => console.log("📡 [Database] MongoDB connection established successfully."))
  .catch(err => console.error("❌ [Database] MongoDB connection error:", err.message));


// Use process.cwd() to dynamically locate modular dependencies safely
const bot = require(path.join(process.cwd(), "bot"));
const sybil = require(path.join(process.cwd(), "security", "sybil")); // Resolved to security folder
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "views"));
app.set("bot", bot);

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
const { telegramQueue } = require(path.join(process.cwd(), 'services', 'queue'));

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
            return res.status(400).send("Missing mandatory Telegram user identity identifier criteria.");
        }

        const db = require(path.join(process.cwd(), 'database')); 
        
        const userProfile = await db.getUser(id);
        if (!userProfile) {
            return res.status(404).send("Target record node does not exist inside system memory maps.");
        }

        if (userProfile.cooldown_until && userProfile.cooldown_until > Date.now()) {
            const structuralRemainingSecs = Math.ceil((userProfile.cooldown_until - Date.now()) / 1000);
            return res.status(429).send(`Cooling constraint parameters active. Please wait ${structuralRemainingSecs} seconds.`);
        }

        const operationResult = await db.watchAdRound(id);

        return res.status(200).json({
            success: true,
            meta: operationResult
        });

    } catch (serverRouteError) {
        console.error("Critical error clearing ad asset verification route execution:", serverRouteError);
        return res.status(500).send("Internal server router calculation node fault.");
    }
});

// 🛡️ CLIENT-TO-SERVER SYBIL DETECTION HANDSHAKE PROCESSOR
app.post("/portal/verify-sybil", async (req, res) => {
    const { id, fingerprint, solution, expectedCaptcha } = req.body;
    if (!id || !fingerprint) {
        return res.status(400).json({ error: "Missing identity credentials or browser footprint metadata." });
    }

    // Securely validate the CAPTCHA solution matching check on the backend
    if (!solution || solution.trim().toUpperCase() !== expectedCaptcha.trim().toUpperCase()) {
        return res.status(400).json({ error: "Invalid security token mismatch. Please try again." });
    }

    try {
        // Run advanced hardware signature checks via our security file
        const isFlagged = await sybil.isDeviceFingerprintFlagged(req, id, fingerprint);
        if (isFlagged) {
            return res.status(403).json({ error: "Clone signature detected. Access denied." });
        }

        const User = require(path.join(process.cwd(), 'models', 'User'));
        const user = await User.findOne({ telegram_id: String(id) });

        if (!user) {
            return res.status(404).json({ error: "User account profile not found." });
        }

        // Apply onboarding updates, award initial verification points, and lock fingerprint to account
        user.onboarding_passed = true;
        user.device_fingerprint = fingerprint;
        user.device_hardware_hash = req.validatedHardwareHash || "legacy-hash";
        user.points_balance = (user.points_balance || 0) + 100; // +100 PTS onboarding reward
        
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
        return res.status(200).json({ success: true });

    } catch (err) {
        console.error("Onboarding verification endpoint handler exception:", err);
        return res.status(500).json({ error: "Internal security engine calculation fault." });
    }
});


module.exports = app;