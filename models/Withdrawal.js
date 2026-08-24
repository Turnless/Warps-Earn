const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, index: true },
    telegram_id: { type: String, required: true, index: true },
    username: { type: String, default: 'Anonymous' },
    amount_points: { type: Number, required: true },
    asset: { type: String, required: true },
    bank_provider: { type: String, default: null },
    destination_details: { type: String, required: true },
    status: { type: String, default: 'Pending' },
    created_at: { type: Date, default: Date.now }
}, {
    timestamps: true
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
