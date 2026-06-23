require('dotenv').config();
const mongoose = require('mongoose');
const redis = require('./services/redis'); // Make sure this path is correct
const User = require('./models/User');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ad-earn-bot";

async function deleteUser(telegramId) {
    if (!telegramId) {
        console.error("❌ Please provide a Telegram ID.");
        console.log("Usage: node clear-user.js <TELEGRAM_ID>  OR  node clear-user.js all");
        process.exit(1);
    }

    try {
        // Connect to MongoDB
        await mongoose.connect(MONGODB_URI);
        console.log("📡 Connected to MongoDB.");

        if (telegramId.toLowerCase() === 'all') {
            // DANGER: DELETE ALL USERS
            console.log("⚠️ Deleting ALL users from MongoDB...");
            await User.deleteMany({});
            
            console.log("⚠️ Flushing ALL cache from Redis...");
            await redis.flushall();
            
            console.log("✅ Completely wiped all user data.");
        } else {
            // DELETE A SPECIFIC USER
            console.log(`⚠️ Deleting user ${telegramId} from MongoDB...`);
            const result = await User.deleteOne({ telegram_id: String(telegramId) });
            
            if (result.deletedCount > 0) {
                console.log(`✅ User ${telegramId} removed from database.`);
            } else {
                console.log(`⚠️ User ${telegramId} not found in database.`);
            }

            console.log(`⚠️ Removing user ${telegramId} cache from Redis...`);
            await redis.del(`user:${telegramId}:profile`);
            await redis.del(`lock:claim:${telegramId}`);
            await redis.del(`lock:payout:${telegramId}`);
            
            console.log(`✅ Cleared Redis cache blocks for ${telegramId}.`);
        }

    } catch (err) {
        console.error("❌ Error deleting user data:", err);
    } finally {
        await mongoose.disconnect();
        redis.disconnect(); // Or redis.quit() depending on your redis setup
        console.log("🔌 Disconnected.");
        process.exit(0);
    }
}

const targetId = process.argv[2];
deleteUser(targetId);
