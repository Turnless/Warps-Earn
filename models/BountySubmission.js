const mongoose = require('mongoose');

const bountySubmissionSchema = new mongoose.Schema({
    bounty_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Bounty', required: true },
    telegram_id: { type: String, required: true },
    
    proof_url: { type: String, required: true }, // The link to the comment/retweet
    
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    rejection_reason: { type: String, default: null }, // e.g., "Invalid link", "Did not comment"
    
    reviewed_at: { type: Date, default: null },
    created_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('BountySubmission', bountySubmissionSchema);
