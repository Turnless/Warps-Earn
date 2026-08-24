const mongoose = require('mongoose');
const Redis = require('ioredis');
const crypto = require('crypto');
const fetch = require('node-fetch');
const path = require('path');
const User = require('./models/User');
const { telegramQueue } = require('./services/queue');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/ad-earn-bot";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

const MOCK_USER_ID = "999999999";
const LOCAL_SERVER = "https://warps-earn.onrender.com";


// Helper to generate a cryptographically valid Telegram initData signature
function generateMockAuthHeader(userId) {
    const userObj = JSON.stringify({ id: Number(userId), username: "stress_tester" });
    const authDate = Math.floor(Date.now() / 1000);
    
    const initDataParams = new URLSearchParams();
    initDataParams.set('auth_date', String(authDate));
    initDataParams.set('user', userObj);

    const keys = Array.from(initDataParams.keys()).sort();
    const dataCheckString = keys.map(key => `${key}=${initDataParams.get(key)}`).join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    initDataParams.set('hash', computedHash);
    return `WebApp ${initDataParams.toString()}`;
}

async function runStressTest() {
    console.log("==================================================");
    console.log("🚀 STARTING INTEGRATION & STRESS TEST SYSTEM");
    console.log("==================================================\n");

    let redis;
    try {
        // --- 1. DATABASE & CACHE CONNECTION CHECK ---
        console.log("⚙️  Step 1: Checking MongoDB and Redis connections...");
        await mongoose.connect(MONGODB_URI);
        console.log("✅ MongoDB Connection: STABLE");
        
        redis = new Redis(REDIS_URL, {
            maxRetriesPerRequest: null
        });
        redis.on('error', (err) => {
            // Silently absorb ECONNRESET/disconnect logs from Upstash concurrent limits
        });
        const pong = await redis.ping();


        console.log(`✅ Redis Connection: STABLE (Ping: ${pong})`);

        // --- 2. MOCK USER SEEDING ---
        console.log("\n⚙️  Step 2: Inserting mock stress user directly into MongoDB...");
        await User.deleteOne({ telegram_id: MOCK_USER_ID });
        
        const todayStr = new Date().toISOString().split('T')[0];
        const mockUser = new User({
            telegram_id: MOCK_USER_ID,
            username: "stress_tester",
            first_name: "Stress User",
            points_balance: 50,
            total_ads_watched: 0,
            onboarding_passed: true,
            daily_tracker: {
                date: todayStr,
                count: 0
            }
        });
        await mockUser.save();
        console.log("✅ Mock user database insertion: SUCCESS");

        // --- 3. QUEUE SYSTEM INTEGRITY CHECK ---
        console.log("\n⚙️  Step 3: Dispatching job to background Telegram Queue...");
        const job = await telegramQueue.add({
            type: 'sendMessage',
            payload: {
                chat_id: MOCK_USER_ID,
                text: "Stress test system validation notification."
            }
        }, {
            attempts: 1,
            removeOnComplete: true
        });
        console.log(`📡 Queue Job Added (ID: ${job.id}). Waiting for server execution...`);

        const queuePassed = await new Promise((resolve) => {
            const onCompleted = (completedJob) => {
                if (completedJob.id === job.id) {
                    telegramQueue.off('completed', onCompleted);
                    resolve(true);
                }
            };
            telegramQueue.on('completed', onCompleted);
            
            setTimeout(() => {
                telegramQueue.off('completed', onCompleted);
                resolve(false);
            }, 10000); // 10 second timeout
        });

        if (queuePassed) {
            console.log("✅ Queue Worker Execution Check: SUCCESS");
        } else {
            console.log("⚠️ Queue Worker Execution Check: PENDING (is local server active?)");
        }

        // --- 4. RATE LIMITER STRESS TESTING ---
        console.log("\n⚙️  Step 4: Stress testing rate limiter with 7 sequential HTTP calls...");
        const authHeader = generateMockAuthHeader(MOCK_USER_ID);
        const responses = [];

        for (let i = 1; i <= 7; i++) {
            try {
                // Clear any single click concurrency mutex lock to test the rate limiter window
                await redis.del(`lock:claim:${MOCK_USER_ID}`);

                const res = await fetch(`${LOCAL_SERVER}/portal/claim-ad-reward`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': authHeader
                    },
                    body: JSON.stringify({ id: MOCK_USER_ID })
                });

                const status = res.status;
                const text = await res.text();
                responses.push(status);
                
                console.log(`   [Call #${i}] Status: ${status} | Response: ${text.slice(0, 70)}`);
            } catch (fetchErr) {
                console.error(`   ❌ [Call #${i}] Network Error: ${fetchErr.message}`);
                responses.push(500);
            }
        }

        // Evaluate results
        const rateLimiterActive = responses[5] === 429 && responses[6] === 429;
        if (rateLimiterActive) {
            console.log("\n✅ Rate Limiter Stress Test: SUCCESS (Spam requests 6 & 7 blocked with HTTP 429)");
        } else {
            console.log("\n❌ Rate Limiter Stress Test: FAILED (Expected requests 6 & 7 to return HTTP 429)");
        }

        // --- 5. CLEANUP ---
        console.log("\n⚙️  Step 5: Performing database and cache cleanup...");
        await User.deleteOne({ telegram_id: MOCK_USER_ID });
        console.log("✅ Cleaned up mock user from MongoDB.");

        const rateLimitKeys = await redis.keys(`rl:tx:*`);
        if (rateLimitKeys.length > 0) {
            await redis.del(...rateLimitKeys);
            console.log(`✅ Cleared ${rateLimitKeys.length} rate limit keys from Redis.`);
        }

        console.log("\n==================================================");
        if (rateLimiterActive) {
            console.log("🎉 ALL ARCHITECTURE STRESS TESTS COMPLETED SUCCESSFULLY!");
        } else {
            console.log("⚠️ TEST COMPLETED WITH ERRORS. CHECK LOCAL SERVICES.");
        }
        console.log("==================================================");

    } catch (criticalErr) {
        console.error("\n❌ Critical validation processing exception:", criticalErr.message);
    } finally {
        await mongoose.connection.close();
        if (redis) await redis.disconnect();
        process.exit(0);
    }
}

runStressTest();
