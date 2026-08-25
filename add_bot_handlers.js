const fs = require('fs');
const file = './bot.js';
let content = fs.readFileSync(file, 'utf-8');

const paymentHandlers = `
// --- 🌟 TELEGRAM STARS PAYMENT HANDLERS ---
bot.on('pre_checkout_query', async (ctx) => {
    try {
        // Always approve the pre-checkout query so the user can pay
        await ctx.answerPreCheckoutQuery(true);
    } catch (e) {
        console.error("❌ Pre-checkout query failed:", e);
    }
});

bot.on('successful_payment', async (ctx) => {
    try {
        const payment = ctx.message.successful_payment;
        const payloadStr = payment.invoice_payload;
        
        console.log("💰 Successful Payment Received:", payment);
        
        if (!payloadStr) return;
        
        let payload;
        try {
            payload = JSON.parse(payloadStr);
        } catch (e) {
            console.error("❌ Failed to parse invoice payload:", payloadStr);
            return;
        }
        
        const { userId, item, amount, hasBlueTick } = payload;
        const User = require('./models/User');
        const StoreOrder = require('./models/StoreOrder');
        
        const user = await User.findOne({ telegram_id: userId });
        if (!user) return;
        
        let isPending = false;
        
        // Process the item upgrade (same logic as PTS)
        if (item.startsWith('premium_tier_')) {
            if (hasBlueTick) {
                isPending = true;
            } else {
                user.account_tier = 'Premium';
                const expDate = new Date();
                const months = item.includes('6m') ? 6 : (item.includes('3m') ? 3 : 1);
                expDate.setMonth(expDate.getMonth() + months);
                user.tier_expiry = expDate;
            }
        } else if (item.startsWith('gold_tier_')) {
            if (hasBlueTick) {
                isPending = true;
            } else {
                user.account_tier = 'Gold';
                user.x_blue_tick = false;
                user.ad_multiplier = 2; // Gold gets auto 2x
                const expDate = new Date();
                const months = item.includes('6m') ? 6 : (item.includes('3m') ? 3 : 1);
                expDate.setMonth(expDate.getMonth() + months);
                user.tier_expiry = expDate;
            }
        } else if (item === 'x_verify') {
            isPending = true;
        }

        await user.save();

        const order = new StoreOrder({
            telegram_id: userId,
            item_key: item,
            cost: amount,
            currency: 'stars',
            status: isPending ? 'pending' : 'completed',
            has_blue_tick: hasBlueTick || false
        });
        await order.save();

        if (isPending) {
            await ctx.reply("🛒 Payment successful! Your verification is pending review. We will notify you once it is approved.");
        } else {
            await ctx.reply("🛒 Payment successful! Your account has been upgraded.");
        }
    } catch (e) {
        console.error("❌ Successful payment processing failed:", e);
    }
});
`;

if (!content.includes('successful_payment')) {
    content = content.replace('module.exports = bot;', paymentHandlers + '\nmodule.exports = bot;');
    fs.writeFileSync(file, content);
    console.log('Bot handlers added');
} else {
    console.log('Handlers already present');
}
