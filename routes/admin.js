const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Withdrawal = require('../models/Withdrawal');
const { sendTelegramMessageAsync } = require('../services/queue');

// Import environment parameters securely
require('dotenv').config();

// Pull system authentication values
const ADMIN_SECRET_SIGNATURE = process.env.ADMIN_SECRET_SIGNATURE || 'fallback_secret_for_dev';
const PUBLIC_PAYOUT_CHANNEL_ID = process.env.PUBLIC_PAYOUT_CHANNEL_ID || '@WarpsEarn';

// 🛡️ HTML SANITIZER FOR TELEGRAM COMPATIBILITY
function escapeTelegramHtml(text) {
    if (!text) return '';
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Format formatted ledger timestamps
function getFormattedDateTime() {
    const optionsDate = { month: 'short', day: 'numeric', year: 'numeric' };
    const optionsTime = { hour: '2-digit', minute: '2-digit', hour12: true };
    const dateStr = new Date().toLocaleDateString('en-US', optionsDate);
    const timeStr = new Date().toLocaleTimeString('en-US', optionsTime);
    return `${dateStr} • ${timeStr}`;
}

// --- ⚡ EXCLUSIVE ADMINISTRATIVE PAYOUT DECISION CONTROL ENDPOINT ---
router.get('/payout', async (req, res) => {
    const { txId, action, secret } = req.query;

    try {
        // Enforce strong secret check
        if (secret !== ADMIN_SECRET_SIGNATURE) {
            return res.status(403).send("Unauthorized administrative transaction sequence.");
        }

        if (!txId || !action) {
            return res.status(400).send("Incomplete routing parameters.");
        }

        console.log(`📡 [Admin Payout] Action: ${action} for TX ID: ${txId}`);

        // Find user that has this transaction ID
        const targetUser = await User.findOne({ "transactions.txId": txId });

        if (!targetUser) {
            return res.status(404).send("Transaction trace ID not found in database.");
        }

        const targetTx = targetUser.transactions.find(t => t.txId === txId);

        if (targetTx.status !== 'Pending') {
            return res.status(400).send(`This transaction has already been resolved as [${targetTx.status}].`);
        }

        if (action === 'approve') {
            // Update user transaction status
            targetTx.status = 'Successful';
            await targetUser.save();

            // Update global withdrawal document
            await Withdrawal.updateOne({ id: txId }, { status: 'Successful' });

            const totalDebitedPoints = targetTx.amount;
            let valuationStr = `$${(totalDebitedPoints * 0.0008).toFixed(2)} USD`;
            if (targetTx.type.includes('NAIRA')) {
                const nairaValue = totalDebitedPoints * 0.0008 * 1600;
                valuationStr = `$${(totalDebitedPoints * 0.0008).toFixed(2)} USD (₦${nairaValue.toLocaleString('en-US', {minimumFractionDigits: 2})})`;
            }

            // --- 📢 Post direct proof to Telegram Channel via Bull Queue ---
            const proofReceiptText = `⚡ <b>WARPS EARN DISBURSEMENT COMPLETED</b> ⚡\n\n` +
                `👤 <b>Recipient:</b> ${escapeTelegramHtml(targetUser.first_name || 'Operator')} (@${escapeTelegramHtml(targetUser.username || 'Anonymous')})\n` +
                `🧾 <b>Transaction ID:</b> <code>${escapeTelegramHtml(txId)}</code>\n` +
                `💰 <b>Amount Disbursed:</b> <b>${totalDebitedPoints.toLocaleString()} PTS</b>\n` +
                `💵 <b>Total Valuation:</b> <b>${valuationStr}</b>\n` +
                `💼 <b>Network Asset:</b> ${escapeTelegramHtml(targetTx.type.replace('Withdrawal (', '').replace(')', ''))}\n` +
                `📅 <b>Settlement Timestamp:</b> ${getFormattedDateTime()}\n\n` +
                `💚 <i>Keep watching, keep sharing, keep stacking!</i>`;

            await sendTelegramMessageAsync(PUBLIC_PAYOUT_CHANNEL_ID, proofReceiptText);

            // Message target user directly via Bull Queue
            const userNotificationText = `💰 <b>Payout Successful!</b>\n\nYour withdrawal of <b>${totalDebitedPoints.toLocaleString()} PTS (${valuationStr})</b> has been processed successfully.\n\nReceipt proofs have been published to ${PUBLIC_PAYOUT_CHANNEL_ID}!`;
            await sendTelegramMessageAsync(targetUser.telegram_id, userNotificationText);

            return res.send(`
                <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #e6ddd0; text-align: center; color: #1a1a16;">
                    <div style="background: white; padding: 40px; border-radius: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width:340px;">
                        <span style="font-size: 48px;">✅</span>
                        <h2 style="margin-top:15px; font-size: 18px;">Transaction Approved!</h2>
                        <p style="color:#666; font-size:13px; line-height:1.5;">Successfully marked as <b>Successful</b>. Receipt has been published to @WarpsEarn.</p>
                    </div>
                </body>
            `);

        } else if (action === 'reject') {
            // Update user transaction status and restore points
            targetTx.status = 'Rejected';
            targetUser.points_balance = (targetUser.points_balance || 0) + targetTx.amount;
            await targetUser.save();

            // Update global withdrawal document
            await Withdrawal.updateOne({ id: txId }, { status: 'Rejected' });

            // Notify user of rejection reason via Bull Queue
            const userRejectionText = `❌ <b>Payout Request Rejected</b>\n\nYour withdrawal request for <b>${targetTx.amount.toLocaleString()} PTS</b> was declined by the administrator. Points have been fully restored to your balance.`;
            await sendTelegramMessageAsync(targetUser.telegram_id, userRejectionText);

            return res.send(`
                <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #e6ddd0; text-align: center; color: #1a1a16;">
                    <div style="background: white; padding: 40px; border-radius: 24px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); max-width:340px;">
                        <span style="font-size: 48px;">❌</span>
                        <h2 style="margin-top:15px; font-size: 18px;">Transaction Declined</h2>
                        <p style="color:#666; font-size:13px; line-height:1.5;">Status successfully changed to <b>Rejected</b>. Points returned to user balance.</p>
                    </div>
                </body>
            `);
        }

    } catch (err) {
        console.error("Administrative transaction decision failure:", err);
        return res.status(500).send("Administrative decision process crashed.");
    }
});

module.exports = router;