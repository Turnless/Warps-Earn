const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
    telegram_id: { type: String, required: true },
    username: { type: String, default: 'Anonymous' },
    ads_viewed: { type: Number, default: 0 },
    reward_issued: { type: Boolean, default: false },
    qualified: { type: Boolean, default: false }
}, { _id: false });

const earningsHistorySchema = new mongoose.Schema({
    type: { type: String, required: true },
    amount: { type: Number, required: true },
    timestamp: { type: String, required: true }
}, { _id: false });

const transactionSchema = new mongoose.Schema({
    txId: { type: String, required: true },
    type: { type: String, required: true },
    amount: { type: Number, required: true },
    date: { type: String, required: true },
    status: { type: String, default: 'Pending' }
}, { _id: false });

const userSchema = new mongoose.Schema({
    telegram_id: { type: String, required: true, unique: true, index: true },
    username: { type: String, default: 'Anonymous' },
    first_name: { type: String, default: 'User' },
    photo_url: { type: String, default: null },
    points_balance: { type: Number, default: 0 },
    total_ads_watched: { type: Number, default: 0 },
    onboarding_passed: { type: Boolean, default: false },
    is_banned: { type: Boolean, default: false },
    
    // Referral tracking field
    referrer_id: { type: String, default: null },
    
    cooldown_until: { type: Number, default: 0 },
    current_session_loop: { type: Number, default: 0 },
    
    earnings_history: [earningsHistorySchema],
    
    daily_tracker: {
        date: { type: String, default: null },
        count: { type: Number, default: 0 }
    },
    
    login_streak: { type: Number, default: 0 },
    last_login_date: { type: String, default: null },
    
    ad_multiplier: { type: Number, default: 1 },
    multiplier_expires_at: { type: Date, default: null },
    
    quests: {
        channel: { type: Boolean, default: false },
        group: { type: Boolean, default: false },
        payout_channel: { type: Boolean, default: false },
        x_account: { type: Boolean, default: false },
        sybil_verified: { type: Boolean, default: false }
    },
    
    // Social Bounty & Tier System Fields
    country: { type: String, default: null },
    x_handle: { type: String, default: null },
    x_followers: { type: Number, default: 0 },
    x_blue_tick: { type: Boolean, default: false },
    account_tier: { type: String, enum: ['Standard', 'Premium', 'Gold'], default: 'Standard' },
    tier_expiry: { type: Date, default: null }, // For subscription upgrades
    bounty_strikes: { type: Number, default: 0 },
    bounty_banned: { type: Boolean, default: false },
    
    referrals: [referralSchema],
    
    device_fingerprint: { type: String, default: null },
    device_hardware_hash: { type: String, default: null },
    
    withdrawals_count: { type: Number, default: 0 },
    last_withdrawal_date: { type: Date, default: null },
    daily_withdrawals: {
        date: { type: String, default: null },
        count: { type: Number, default: 0 }
    },
    
    custom_promos: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
    
    milestones_claimed: {
        tier_10: { type: Boolean, default: false },
        tier_20: { type: Boolean, default: false },
        tier_50: { type: Boolean, default: false },
        tier_100: { type: Boolean, default: false }
    },
    
    transactions: [transactionSchema],
    registered_timestamp: { type: Number, default: () => Date.now() }
}, {
    timestamps: true
});

module.exports = mongoose.model('User', userSchema);
