const User = require('./models/User');
const redis = require('./services/redis');

// Shared business logic constants
const {
    ADS_PER_ROUND, SHORT_COOLDOWN_MS, LONG_COOLDOWN_MS, STREAK_BONUS_REWARD,
    REFERRAL_ACTIVATION_THRESHOLD, REFERRAL_ACTIVATION_REWARD, QUEST_REWARD_PTS,
    STREAK_BONUS_INTERVAL_DAYS, VIP_REFERRAL_THRESHOLD, AD_MULTIPLIER_VIP,
    DEFAULT_REWARD_PER_AD, MS_PER_DAY
} = require('./constants');

async function getUser(userId) {
    console.log(`📡 [Database] Fetching user: ${userId}`);
    return await User.findOne({ telegram_id: String(userId) }).lean();
}

async function setupUser(userId, username, uplineId = null) {
    console.log(`📡 [Database] Setting up user: ${userId} (Upline: ${uplineId})`);
    let user = await User.findOne({ telegram_id: String(userId) });
    const todayStr = new Date().toISOString().split('T')[0];

    if (!user) {
        user = new User({
            telegram_id: String(userId),
            username: username || "anonymous",
            first_name: username || "User",
            photo_url: "https://pub-c5e31b5cdafb419a864aa4d19307a0ec.r2.dev/mock-avatar.png",
            points_balance: 0,
            total_ads_watched: 0,
            onboarding_passed: false,
            referrer_id: uplineId ? String(uplineId) : null,
            cooldown_until: 0,
            current_session_loop: 0,
            earnings_history: [],
            daily_tracker: {
                date: todayStr,
                count: 0
            },
            quests: {
                channel: false,
                group: false,
                payout_channel: false,
                x_account: false,
                sybil_verified: false
            },
            referrals: [] 
        });
        
        await user.save();
        console.log(`📡 [Database] New user created successfully: ${userId}`);

        if (uplineId && String(uplineId) !== String(userId)) {
            const referrer = await User.findOne({ telegram_id: String(uplineId) });
            if (referrer) {
                if (!referrer.referrals) referrer.referrals = [];
                
                referrer.referrals.push({
                    telegram_id: String(userId),
                    username: username ? `@${username}` : `id_${String(userId).slice(-4)}`,
                    ads_viewed: 0,
                    reward_issued: false
                });
                await referrer.save();
                console.log(`[PIPELINE LINKED] User ${userId} successfully registered under Upline ${uplineId}`);
            }
        }
    }
    return user.toObject();
}

async function watchAdRound(userId) {
    console.log(`📡 [Database] watchAdRound: Processing ads loop reward for user ${userId}`);
    let user = await User.findOne({ telegram_id: String(userId) });
    
    if (!user) throw new Error("User profile not found");
    
    // --- DAILY LOGIN STREAK SYSTEM ---
    const todayStr = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - MS_PER_DAY).toISOString().split('T')[0];
    if (user.last_login_date !== todayStr) {
        if (user.last_login_date === yesterday) {
            user.login_streak = (user.login_streak || 0) + 1;
        } else {
            user.login_streak = 1; // Reset streak
        }
        user.last_login_date = todayStr;

        // Give PTS bonus for every 7 days
        if (user.login_streak > 0 && user.login_streak % STREAK_BONUS_INTERVAL_DAYS === 0) {
            const settingsStr = await redis.get('global_settings');
            const settings = settingsStr ? JSON.parse(settingsStr) : {};
            const streakReward = settings.streak_reward || STREAK_BONUS_REWARD;

            user.points_balance += streakReward;
            if (!user.earnings_history) user.earnings_history = [];
            user.earnings_history.unshift({
                type: "7-Day Login Streak Bonus",
                amount: streakReward,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            console.log(`[STREAK] User ${userId} hit a 7-day streak! Awarded ${streakReward} PTS.`);
        }
    }

    if (!user.daily_tracker || user.daily_tracker.date !== todayStr) {
        user.daily_tracker = { date: todayStr, count: 0 };
        user.current_session_loop = 0;
    }

    // --- MULTIPLIER EXPIRATION CHECK ---
    if (user.multiplier_expires_at && new Date() > new Date(user.multiplier_expires_at)) {
        user.ad_multiplier = 1;
        user.multiplier_expires_at = null;
    }

    // --- TIER EXPIRATION CHECK ---
    if (user.tier_expiry && new Date() > new Date(user.tier_expiry)) {
        console.log(`[TIER EXPIRED] User ${userId} tier ${user.account_tier} has expired. Reverting to Standard.`);
        user.account_tier = 'Standard';
        user.tier_expiry = null;
        user.x_blue_tick = false;
    }

    // --- TIERED VIP ACCOUNTS (50+ Referrals) ---
    const refCount = (user.referrals || []).length;
    if (refCount >= VIP_REFERRAL_THRESHOLD && (user.ad_multiplier || 1) < AD_MULTIPLIER_VIP) {
        user.ad_multiplier = AD_MULTIPLIER_VIP; // VIP Gold: 2x multiplier
        console.log(`[VIP] User ${userId} upgraded to Gold VIP (2x Multiplier)!`);
    } else if (!user.ad_multiplier) {
        user.ad_multiplier = 1;
    }

    // Fetch Base Reward Per Ad from Settings
    const settingsStr = await redis.get('global_settings');
    const settings = settingsStr ? JSON.parse(settingsStr) : {};
    const baseReward = settings.reward_per_ad || DEFAULT_REWARD_PER_AD;
    const adsPerRound = ADS_PER_ROUND;
    const finalReward = (baseReward * adsPerRound) * user.ad_multiplier;

    user.points_balance = (user.points_balance || 0) + finalReward;
    user.total_ads_watched = (user.total_ads_watched || 0) + ADS_PER_ROUND; 
    user.daily_tracker.count += ADS_PER_ROUND;
    user.current_session_loop = (user.current_session_loop || 0) + 1;

    let cooldownMs = SHORT_COOLDOWN_MS; 
    if (user.current_session_loop >= ADS_PER_ROUND) {
        cooldownMs = LONG_COOLDOWN_MS; 
        user.cooldown_until = Date.now() + cooldownMs;
        user.current_session_loop = 0;
    } else {
        user.cooldown_until = Date.now() + cooldownMs;
    }

    if (!user.earnings_history) user.earnings_history = [];
    user.earnings_history.unshift({
        type: `Ad Loop ${user.current_session_loop === 0 ? ADS_PER_ROUND : user.current_session_loop} Reward`,
        amount: finalReward,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    await user.save();

    const referrerProfile = await User.findOne({ 
        referrals: { $elemMatch: { telegram_id: String(userId) } }
    });

    if (referrerProfile) {
        const refEntry = referrerProfile.referrals.find(ref => ref.telegram_id === String(userId));
        if (refEntry) {
            refEntry.ads_viewed = (refEntry.ads_viewed || 0) + ADS_PER_ROUND;

            if (refEntry.ads_viewed >= REFERRAL_ACTIVATION_THRESHOLD && !refEntry.reward_issued) {
                referrerProfile.points_balance = (referrerProfile.points_balance || 0) + REFERRAL_ACTIVATION_REWARD;
                refEntry.reward_issued = true;

                if (!referrerProfile.earnings_history) referrerProfile.earnings_history = [];
                referrerProfile.earnings_history.unshift({
                    type: "Referral Activation",
                    amount: REFERRAL_ACTIVATION_REWARD,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
                console.log(`[REFERRAL BONUS ACTIVATED] Referrer ${referrerProfile.telegram_id} awarded +${REFERRAL_ACTIVATION_REWARD} PTS from invite ${userId}`);
            }
            await referrerProfile.save();
        }
    }
    
    return {
        currentBalance: user.points_balance,
        totalAds: user.total_ads_watched,
        cooldownTime: cooldownMs,
        loopIndex: user.current_session_loop
    };
}

async function verifyQuest(userId, questKey) {
    console.log(`📡 [Database] verifyQuest: Verifying quest ${questKey} for user ${userId}`);
    let user = await User.findOne({ telegram_id: String(userId) });
    
    if (!user) throw new Error("User profile not found");
    if (!user.quests) user.quests = {};
    
    if (user.quests[questKey] === true) return user.toObject();
    
    user.set(`quests.${questKey}`, true);
    user.points_balance = (user.points_balance || 0) + QUEST_REWARD_PTS;
    
    if (!user.earnings_history) user.earnings_history = [];
    user.earnings_history.unshift({
        type: `${questKey.charAt(0).toUpperCase() + questKey.slice(1)} Task Completed`,
        amount: QUEST_REWARD_PTS,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    
    await user.save();
    return user.toObject();
}

module.exports = {
    getUser,
    setupUser,
    watchAdRound,
    verifyQuest
};