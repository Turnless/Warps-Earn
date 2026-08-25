// Business logic constants — single source of truth
// Used across portal.js, admin.js, database.js, api/index.js, bot.js

// --- Ad system ---
const DAILY_AD_LIMIT = 100;
const ADS_PER_ROUND = 3;
const SHORT_COOLDOWN_MS = 45 * 1000;
const LONG_COOLDOWN_MS = 15 * 60 * 1000;
const SHORT_COOLDOWN_SECONDS_THRESHOLD = 60;
const AD_CLAIM_LOCK_TTL_SECONDS = 5;
const ADSGRAM_REWARD_PTS = 50;
const DEFAULT_REWARD_PER_AD = 3;

// --- Rewards ---
const QUEST_REWARD_PTS = 100;
const ONBOARDING_REWARD_PTS = 100;
const STREAK_BONUS_REWARD = 500;
const STREAK_BONUS_INTERVAL_DAYS = 7;

// --- Referrals ---
const REFERRAL_ACTIVATION_REWARD = 200;
const REFERRAL_ACTIVATION_THRESHOLD = 20;
const VIP_REFERRAL_THRESHOLD = 50;
const UPLINE_PROMOTER_REFERRAL_THRESHOLD = 10;
const REFERRAL_MILESTONES = [
    { n: 10, pts: 6250 },
    { n: 20, pts: 6250 },
    { n: 50, pts: 18750 },
    { n: 100, pts: 31250 }
];

// --- Withdrawals ---
const FIRST_WITHDRAWAL_MIN_PTS = 1500;
const MIN_WITHDRAWAL_PTS = 1250;
const MAX_DAILY_WITHDRAWALS = 2;
const PAYOUT_LOCK_TTL_SECONDS = 10;
const NAIRA_ACCOUNT_NUMBER_LENGTH = 10;

// --- Economy ---
const PTS_TO_USD_RATE = 0.0008;
const USD_TO_NGN_RATE = 1600;
const MS_PER_DAY = 86400000;

// --- Premium / Store ---
const AD_MULTIPLIER_PREMIUM = 2;
const AD_MULTIPLIER_VIP = 2;

// --- Redis ---
const REDIS_OPERATION_TIMEOUT_MS = 3000;
const USER_CACHE_TTL_SECONDS = 300;

// --- Quests ---
const MAX_QUEST_SUBMISSIONS_LOG = 200;
const DEFAULT_QUEST_TIMER_HOURS = 8;

// --- Admin ---
const ADMIN_TELEGRAM_CHAT_ID = '6314427516';
const ADMIN_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADMIN_PENDING_WITHDRAWALS_LIMIT = 50;
const ADMIN_LEADERBOARD_LIMIT = 10;
const ADMIN_SYBIL_CLUSTERS_LIMIT = 50;
const ADMIN_QUEUE_DEBUG_LIMIT = 10;
const BROADCAST_DELAY_MS_PER_USER = 50;
const WAKEUP_PUSH_DELAY_MS_PER_USER = 100;
const MAX_BOUNTY_STRIKES = 3;

// --- Onboarding ---
const CAPTCHA_LENGTH = 5;

// --- Store config defaults ---
const DEFAULT_STORE_CONFIG = {
    cooldown: 500,
    multiplier: 3000,
    premium_tier_1m: 15000,
    premium_tier_6m: 28000,
    premium_tier_3m_blue: 45000,
    premium_tier_6m_blue: 85000,
    gold_tier_1m: 50000,
    gold_tier_3m: 50000,
    gold_tier_6m: 90000,
    gold_tier_3m_blue: 80000,
    gold_tier_6m_blue: 150000
};

const DEFAULT_STARS_CONFIG = {
    stars_premium_3m: 25,
    stars_premium_6m: 40,
    stars_premium_1m_blue: 50,
    stars_premium_3m_blue: 100,
    stars_premium_6m_blue: 150,
    stars_gold_1m: 50,
    stars_gold_3m: 100,
    stars_gold_6m: 150,
    stars_gold_1m_blue: 120,
    stars_gold_3m_blue: 180,
    stars_gold_6m_blue: 220,
    stars_cooldown: 10,
    stars_multiplier: 50,
    stars_x_verify: 100
};

module.exports = {
    DAILY_AD_LIMIT,
    ADS_PER_ROUND,
    SHORT_COOLDOWN_MS,
    LONG_COOLDOWN_MS,
    SHORT_COOLDOWN_SECONDS_THRESHOLD,
    AD_CLAIM_LOCK_TTL_SECONDS,
    ADSGRAM_REWARD_PTS,
    DEFAULT_REWARD_PER_AD,
    QUEST_REWARD_PTS,
    ONBOARDING_REWARD_PTS,
    STREAK_BONUS_REWARD,
    STREAK_BONUS_INTERVAL_DAYS,
    REFERRAL_ACTIVATION_REWARD,
    REFERRAL_ACTIVATION_THRESHOLD,
    VIP_REFERRAL_THRESHOLD,
    UPLINE_PROMOTER_REFERRAL_THRESHOLD,
    REFERRAL_MILESTONES,
    FIRST_WITHDRAWAL_MIN_PTS,
    MIN_WITHDRAWAL_PTS,
    MAX_DAILY_WITHDRAWALS,
    PAYOUT_LOCK_TTL_SECONDS,
    NAIRA_ACCOUNT_NUMBER_LENGTH,
    PTS_TO_USD_RATE,
    USD_TO_NGN_RATE,
    MS_PER_DAY,
    AD_MULTIPLIER_PREMIUM,
    AD_MULTIPLIER_VIP,
    REDIS_OPERATION_TIMEOUT_MS,
    USER_CACHE_TTL_SECONDS,
    MAX_QUEST_SUBMISSIONS_LOG,
    DEFAULT_QUEST_TIMER_HOURS,
    ADMIN_TELEGRAM_CHAT_ID,
    ADMIN_SESSION_MAX_AGE_MS,
    ADMIN_PENDING_WITHDRAWALS_LIMIT,
    ADMIN_LEADERBOARD_LIMIT,
    ADMIN_SYBIL_CLUSTERS_LIMIT,
    ADMIN_QUEUE_DEBUG_LIMIT,
    BROADCAST_DELAY_MS_PER_USER,
    WAKEUP_PUSH_DELAY_MS_PER_USER,
    MAX_BOUNTY_STRIKES,
    CAPTCHA_LENGTH,
    DEFAULT_STORE_CONFIG,
    DEFAULT_STARS_CONFIG
};
