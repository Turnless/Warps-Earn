const mongoose = require('mongoose');
const User = require('./models/User');
const Withdrawal = require('./models/Withdrawal');
const fetch = require('node-fetch');
require('dotenv').config();

const LOCAL_SERVER = 'http://localhost:3000';
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ad-earn-bot";

// Target test identities
const REFERRER_ID = "6314427516"; // Your profile telegram ID in database
const DOWNLINE_ID = "999999999";  // Temporary mock downline ID

async function setupReferralSandbox() {
    console.log("--------------------------------------------------");
    console.log("⚙️  STEP 1: Preparing database test sandboxing...");
    console.log("--------------------------------------------------");

    try {
        await mongoose.connect(MONGODB_URI);
        console.log("📡 Connected to MongoDB successfully.");
    } catch (dbErr) {
        console.error("❌ Failed to connect to MongoDB:", dbErr.message);
        process.exit(1);
    }

    // Clean old test entries
    await User.deleteMany({ telegram_id: { $in: [REFERRER_ID, DOWNLINE_ID] } });
    await Withdrawal.deleteMany({ telegram_id: { $in: [REFERRER_ID, DOWNLINE_ID] } });

    // 1. Create Referrer Profile
    const referrals = [];
    for (let i = 1; i <= 9; i++) {
        referrals.push({
            telegram_id: `mock_ref_${i}`,
            username: `mock_promoter_${i}`,
            ads_viewed: 1000,
            qualified: true
        });
    }
    // Append our 10th (unqualified) testing downline
    referrals.push({
        telegram_id: DOWNLINE_ID,
        username: "test_downline_active",
        ads_viewed: 0,
        qualified: false
    });

    const referrer = new User({
        telegram_id: REFERRER_ID,
        username: "turn_less",
        first_name: "Abdulsalam",
        points_balance: 0,
        withdrawals_count: 0,
        referrals: referrals,
        milestones_claimed: { tier_10: false, tier_20: false, tier_50: false, tier_100: false },
        earnings_history: [],
        daily_tracker: { date: new Date().toISOString().split('T')[0], count: 0 }
    });

    await referrer.save();

    // 2. Create active Downline Profile
    const downline = new User({
        telegram_id: DOWNLINE_ID,
        username: "test_downline_active",
        first_name: "Active Downline Tester",
        points_balance: 1500, // Meets First Withdrawal target limit
        withdrawals_count: 0, // Triggers qualified status logic gate on first withdrawal
        referrer_id: REFERRER_ID,
        onboarding_passed: true,
        quests: { channel: true, group: true, payout_channel: true, x_account: true },
        transactions: [],
        earnings_history: [],
        daily_tracker: { date: new Date().toISOString().split('T')[0], count: 0 }
    });

    await downline.save();
    console.log("✅ Database sandbox initialized in MongoDB!");
}

async function simulateDownlinePayout() {
    console.log("\n--------------------------------------------------");
    console.log("🚀 STEP 2: Running local HTTP transaction call...");
    console.log("--------------------------------------------------");

    console.log(`Sending first-withdrawal payload on behalf of Downline User ID: ${DOWNLINE_ID}...`);

    const payoutPayload = {
        id: DOWNLINE_ID,
        amount: 1500,
        destination: "0xTestDestinationAddressForReferralSystemValidation",
        asset: "TON",
        bank: null
    };

    try {
        const response = await fetch(`${LOCAL_SERVER}/portal/request-payout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payoutPayload)
        });

        if (response.status === 404) {
            console.log("⚠️ Server root returned 404 on portal endpoint. Re-routing fallback call to local root path...");
            const fallbackResponse = await fetch(`${LOCAL_SERVER}/request-payout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payoutPayload)
            });
            return fallbackResponse.status;
        }

        return response.status;
    } catch (err) {
        console.error("❌ Transaction failed! Is your node application running locally? Run 'node dev.js' or 'node index.js' first.");
        process.exit(1);
    }
}

async function verifyLedgerResults() {
    console.log("\n--------------------------------------------------");
    console.log("📊 STEP 3: Evaluating point distributions & states...");
    console.log("--------------------------------------------------");

    // Wait slightly to let async DB updates flush
    await new Promise(resolve => setTimeout(resolve, 2000));

    const referrer = await User.findOne({ telegram_id: REFERRER_ID });
    const downline = await User.findOne({ telegram_id: DOWNLINE_ID });

    if (!referrer || !downline) {
        console.error("❌ Verification failed. One of the target test accounts was purged during the cycle.");
        await mongoose.connection.close();
        return;
    }

    console.log("Checking active Downline Account State:");
    console.log(`- Points Balance: ${downline.points_balance} PTS (Expected: 0 PTS)`);
    console.log(`- Total Cashouts: ${downline.withdrawals_count} (Expected: 1)`);
    console.log(`- Transaction History: ${downline.transactions[0]?.status} (Expected: Pending)\n`);

    const qualifiedDownlinesCount = referrer.referrals.filter(r => r.qualified).length;

    console.log("Checking Referrer Account State:");
    console.log(`- Qualified Downlines: ${qualifiedDownlinesCount} (Expected: 10)`);
    console.log(`- Milestone claimed (Tier 10): ${referrer.milestones_claimed.tier_10} (Expected: true)`);
    console.log(`- Updated Points Balance: ${referrer.points_balance.toLocaleString()} PTS (Expected: +6,250 PTS milestone reward added)`);
    
    // Check if the earnings ledger matches
    const milestoneLog = referrer.earnings_history.find(e => e.type.includes("Contest Milestone Tier 1"));
    console.log(`- Milestone Ledger Entry: ${milestoneLog ? "✓ Unlocked log found: +" + milestoneLog.amount + " PTS" : "❌ No rewards log entry"}`);

    console.log("\n--------------------------------------------------");
    if (qualifiedDownlinesCount === 10 && referrer.milestones_claimed.tier_10 === true && referrer.points_balance >= 6250) {
        console.log("🎉 SUCCESS! The referral, activation gate, and 4-Stage Milestone engine is working flawlessly!");
    } else {
        console.log("⚠️ Verification issues found. Please review server output or database logs.");
    }
    console.log("--------------------------------------------------\n");

    await mongoose.connection.close();
    console.log("🔌 Database connection closed.");
}

async function runTest() {
    await setupReferralSandbox();
    const statusCode = await simulateDownlinePayout();
    
    if (statusCode === 200 || statusCode === 201) {
        console.log("📡 Server responded with HTTP status: 200 OK!");
        await verifyLedgerResults();
    } else {
        console.error(`❌ Server rejected request with status code: ${statusCode}`);
        await mongoose.connection.close();
    }
}

runTest();