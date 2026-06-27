const mongoose = require('mongoose');

const bountySchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String, required: true },
    client_name: { type: String, default: 'Web3 Client' },
    
    // Task requirements
    task_type: { type: String, enum: ['twitter_comment', 'twitter_like', 'twitter_retweet', 'discord_join', 'telegram_join', 'other'], required: true },
    platform: { type: String, default: 'Twitter' },
    action_type: { type: String, default: 'Task' },
    target_url: { type: String, required: true },
    requires_link: { type: Boolean, default: true },
    
    // Targeting & Economics
    target_countries: [{ type: String }], // If empty, available to all
    required_tier: { type: String, enum: ['Standard', 'Premium', 'Gold'], default: 'Standard' }, // Minimum tier required
    reward_pts: { type: Number, required: true },
    
    max_participants: { type: Number, required: true },
    current_participants: { type: Number, default: 0 },
    completions: { type: Number, default: 0 },
    
    // State
    status: { type: String, enum: ['active', 'completed', 'expired', 'draft'], default: 'active' },
    expires_at: { type: Date, required: true },
    
    created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Bounty', bountySchema);

