'use strict';
/**
 * Test harness: boots a throwaway redis-server, stubs the Mongoose models with
 * in-memory fakes (via require.cache), and mounts the real routers on a real
 * express app so tests exercise the actual middleware chain.
 */
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const express = require('express');
const { createModel } = require('./fake-model');

const ROOT = path.join(__dirname, '..', '..');
const BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS';
const ADMIN_SECRET = 'test-admin-secret';

function hasRedisServer() {
    return spawnSync('which', ['redis-server']).status === 0;
}

let redisProc = null;
let redisPort = null;

async function startRedis() {
    // Test files run in parallel processes. If two pick the same port the second
    // redis-server exits on bind failure and silently shares the first one's
    // data, so verify we actually own the server we started.
    for (let attempt = 0; attempt < 12; attempt++) {
        const port = 6300 + Math.floor(Math.random() * 600);
        const proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], {
            stdio: 'ignore'
        });

        let ready = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            if (proc.exitCode !== null) break;      // failed to bind — port taken
            const ping = spawnSync('redis-cli', ['-p', String(port), 'ping'], { encoding: 'utf8' });
            if ((ping.stdout || '').trim() === 'PONG') { ready = true; break; }
            await new Promise(r => setTimeout(r, 100));
        }

        if (ready && proc.exitCode === null) {
            redisProc = proc;
            redisPort = port;
            return port;
        }
        try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
    }
    throw new Error('could not start an exclusive redis-server for tests');
}

function stopRedis() {
    if (redisProc) { redisProc.kill('SIGKILL'); redisProc = null; }
}

/** Builds a valid Telegram initData string signed with the test bot token. */
function signInitData(user, { authDate = Math.floor(Date.now() / 1000), startParam = null } = {}) {
    const params = new URLSearchParams();
    params.set('auth_date', String(authDate));
    params.set('user', JSON.stringify(user));
    if (startParam) params.set('start_param', startParam);

    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    params.set('hash', hash);
    return params.toString();
}

// `subdocs` mirrors the required fields on embedded schemas in models/User.js
// (earningsHistorySchema / transactionSchema), which Mongoose validates on save.
const MODEL_SPECS = {
    User: {
        file: 'models/User.js',
        required: ['telegram_id'],
        subdocs: {
            earnings_history: ['type', 'amount', 'timestamp'],
            transactions: ['txId', 'type', 'amount', 'date']
        }
    },
    Withdrawal: { file: 'models/Withdrawal.js', required: ['ticket_id', 'telegram_id', 'amount_points', 'asset', 'destination_details'] },
    StoreOrder: { file: 'models/StoreOrder.js', required: ['telegram_id', 'item_key', 'item_title', 'cost'] },
    BountySubmission: { file: 'models/BountySubmission.js', required: ['bounty_id', 'telegram_id'] },
    Bounty: { file: 'models/Bounty.js', required: ['title', 'reward_pts'] }
};

/**
 * Installs env + module stubs. Must run before any app module is required.
 * @returns {{models: object, redisPort: number}}
 */
async function setup() {
    if (!hasRedisServer()) throw new Error('redis-server binary not found — cannot run integration tests');
    const port = await startRedis();

    process.env.BOT_TOKEN = BOT_TOKEN;
    process.env.ADMIN_SECRET_SIGNATURE = ADMIN_SECRET;
    process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
    process.env.PUBLIC_PAYOUT_CHANNEL_ID = '@TestChannel';
    process.env.NODE_ENV = 'test';

    // Stub the models before anything requires them
    const models = {};
    for (const [name, spec] of Object.entries(MODEL_SPECS)) {
        const model = createModel(name, spec.required, spec.subdocs || {});
        models[name] = model;
        require.cache[require.resolve(path.join(ROOT, spec.file))] = {
            id: require.resolve(path.join(ROOT, spec.file)),
            filename: require.resolve(path.join(ROOT, spec.file)),
            loaded: true,
            exports: model
        };
    }

    // Stub the Bull queue so tests never hit the Telegram API.
    // Routes destructure sendTelegramMessageAsync at require time, so failure is
    // toggled through a mutable flag the stub reads on each call.
    const sentMessages = [];
    const queueState = { shouldFail: false };
    const queuePath = require.resolve(path.join(ROOT, 'services/queue.js'));
    require.cache[queuePath] = {
        id: queuePath, filename: queuePath, loaded: true,
        exports: {
            telegramQueue: { on() {}, add: async () => ({ id: 'job' }), getJobCounts: async () => ({}), getFailed: async () => [] },
            sendTelegramMessageAsync: async (chatId, text, opts, delay) => {
                if (queueState.shouldFail) throw new Error('queue unavailable');
                sentMessages.push({ chatId, text, opts, delay });
                return { id: 'job' };
            },
            notifyQuietly: async (chatId, text, opts, delay) => {
                try {
                    if (queueState.shouldFail) throw new Error('queue unavailable');
                    sentMessages.push({ chatId, text, opts, delay });
                    return { id: 'job' };
                } catch (e) { return null; }
            }
        }
    };

    // Bull Board validates that it was handed a real Bull queue, so stub it out
    // for tests that mount the full api/index.js app.
    const stub = (mod, exports) => {
        const resolved = require.resolve(mod);
        require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    };
    try {
        stub('@bull-board/api', { createBullBoard: () => ({}) });
        stub('@bull-board/api/bullAdapter', { BullAdapter: class { constructor() {} } });
        stub('@bull-board/express', {
            ExpressAdapter: class {
                setBasePath() {}
                getRouter() { return (req, res) => res.status(200).send('queues'); }
            }
        });
    } catch (e) { /* optional dependency */ }

    // Never make real outbound HTTP calls from routes
    const fetchPath = require.resolve('node-fetch');
    const fetchCalls = [];
    require.cache[fetchPath] = {
        id: fetchPath, filename: fetchPath, loaded: true,
        exports: async (url, opts) => {
            fetchCalls.push({ url, opts });
            return { json: async () => ({ ok: true, result: { status: 'member' } }) };
        }
    };

    return { models, redisPort: port, sentMessages, fetchCalls, queueState };
}

/** Mounts the real portal router on a fresh express app. */
function buildApp({ mountAdmin = false } = {}) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.set('view engine', 'ejs');
    app.set('views', path.join(ROOT, 'views'));

    app.use('/auth', require(path.join(ROOT, 'routes/auth')));
    if (mountAdmin) app.use('/admin', require(path.join(ROOT, 'routes/admin')));
    app.use('/', require(path.join(ROOT, 'routes/portal')));
    return app;
}

/**
 * Requires the real api/index.js app (routes defined inline there, e.g.
 * /portal/verify-sybil). Stubs mongoose so no connection is attempted.
 */
function buildFullApp() {
    const mongoosePath = require.resolve('mongoose');
    require.cache[mongoosePath] = {
        id: mongoosePath, filename: mongoosePath, loaded: true,
        exports: {
            connect: async () => {},
            connection: { readyState: 1 },
            Schema: class {},
            model: () => {}
        }
    };
    return require(path.join(ROOT, 'api', 'index.js'));
}

/** Starts the app on an ephemeral port and returns {url, close}. */
function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise(r => server.close(r))
            });
        });
    });
}

async function teardown() {
    // Disconnect the client before killing the server, otherwise ioredis keeps
    // retrying against a dead socket and holds the process open.
    try {
        const redis = require(path.join(ROOT, 'services/redis'));
        if (redis) {
            redis.removeAllListeners('error');
            if (typeof redis.quit === 'function') {
                await Promise.race([redis.quit(), new Promise(r => setTimeout(r, 1000))]);
            }
            if (typeof redis.disconnect === 'function') redis.disconnect();
        }
    } catch (e) { /* not loaded or already closed */ }
    stopRedis();
}

module.exports = { setup, teardown, buildApp, buildFullApp, listen, signInitData, BOT_TOKEN, ADMIN_SECRET, ROOT };
