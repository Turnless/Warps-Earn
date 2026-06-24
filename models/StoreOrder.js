const mongoose = require('mongoose');

const storeOrderSchema = new mongoose.Schema({
    telegram_id: { type: String, required: true },
    item_key: { type: String, required: true },
    item_title: { type: String, required: true },
    cost: { type: Number, required: true },
    blue_tick: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending' },
    created_at: { type: Date, default: Date.now },
    resolved_at: { type: Date }
});

module.exports = mongoose.model('StoreOrder', storeOrderSchema);
