const User = require('./models/User');
const Withdrawal = require('./models/Withdrawal');

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
            upline: uplineId ? String(uplineId) : null,
            referred_by: uplineId ? String(uplineId) : null,
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
    
    const todayStr = new Date().toISOString().split('T')[0];

    if (!user.daily_tracker || user.daily_tracker.date !== todayStr) {
        user.daily_tracker = { date: todayStr, count: 0 };
        user.current_session_loop = 0;
    }

    user.points_balance = (user.points_balance || 0) + 3;
    user.total_ads_watched = (user.total_ads_watched || 0) + 3; 
    user.daily_tracker.count += 3;
    user.current_session_loop = (user.current_session_loop || 0) + 1;

    let cooldownMs = 45 * 1000; 
    if (user.current_session_loop >= 3) {
        cooldownMs = 15 * 60 * 1000; 
        user.cooldown_until = Date.now() + cooldownMs;
        user.current_session_loop = 0;
    } else {
        user.cooldown_until = Date.now() + cooldownMs;
    }

    if (!user.earnings_history) user.earnings_history = [];
    user.earnings_history.unshift({
        type: `Loop ${user.current_session_loop === 0 ? 3 : user.current_session_loop} Stream Reward`,
        amount: 3,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    await user.save();

    const referrerProfile = await User.findOne({ 
        referrals: { $elemMatch: { telegram_id: String(userId) } }
    });

    if (referrerProfile) {
        const refEntry = referrerProfile.referrals.find(ref => ref.telegram_id === String(userId));
        if (refEntry) {
            refEntry.ads_viewed = (refEntry.ads_viewed || 0) + 3;

            if (refEntry.ads_viewed >= 20 && !refEntry.reward_issued) {
                referrerProfile.points_balance = (referrerProfile.points_balance || 0) + 200;
                refEntry.reward_issued = true;

                if (!referrerProfile.earnings_history) referrerProfile.earnings_history = [];
                referrerProfile.earnings_history.unshift({
                    type: "Referral Activation",
                    amount: 200,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
                console.log(`[REFERRAL BONUS ACTIVATED] Referrer ${referrerProfile.telegram_id} awarded +200 PTS from invite ${userId}`);
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
    user.points_balance = (user.points_balance || 0) + 100;
    
    if (!user.earnings_history) user.earnings_history = [];
    user.earnings_history.unshift({
        type: `${questKey.charAt(0).toUpperCase() + questKey.slice(1)} Protocol Cleared`,
        amount: 100,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    
    await user.save();
    return user.toObject();
}

async function createWithdrawal(userId, destination, asset, bank = null) {
    console.log(`📡 [Database] createWithdrawal: Creating withdrawal request for user ${userId}`);
    let user = await User.findOne({ telegram_id: String(userId) });
    
    if (!user) throw new Error("User profile not found");
    
    const personalThreshold = (user.withdrawals_count && user.withdrawals_count > 0) ? 1000 : 5000;
    if ((user.points_balance || 0) < personalThreshold) {
        throw new Error("Insufficient point balance threshold clearance.");
    }
    
    const payoutAmount = user.points_balance;
    user.points_balance = 0;
    user.withdrawals_count = (user.withdrawals_count || 0) + 1;
    
    if (!user.earnings_history) user.earnings_history = [];
    user.earnings_history.unshift({
        type: `Payout Requested (${asset})`,
        amount: -payoutAmount,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    
    await user.save();
    
    const ticketId = `TX-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const ticket = new Withdrawal({
        id: ticketId,
        telegram_id: String(userId),
        username: user.username,
        amount_points: payoutAmount,
        asset: asset,
        bank_provider: bank,
        destination_details: destination,
        status: "PENDING_AUDIT",
        created_at: new Date()
    });
    
    await ticket.save();
    return ticket.toObject();
}

module.exports = {
    getUser,
    setupUser,
    watchAdRound,
    verifyQuest,
    createWithdrawal
};