'use strict';
const test = require('node:test');
const assert = require('node:assert');
const harness = require('./helpers/harness');

let ctx, server, models, redis;
const USER = '950001';

test.before(async () => {
    ctx = await harness.setup();
    models = ctx.models;
    redis = require('../services/redis');
    server = await harness.listen(harness.buildFullApp());
});

test.after(async () => {
    if (server) await server.close();
    await harness.teardown();
});

test.beforeEach(async () => {
    ctx.queueState.shouldFail = false;
    await redis.flushall();
    for (const m of Object.values(models)) m.__clear();
    models.User.__seed({
        telegram_id: USER, username: 't', points_balance: 100000, onboarding_passed: true,
        is_banned: false, account_tier: 'Standard', ad_multiplier: 1,
        earnings_history: [], referrals: [], transactions: [], quests: {}, custom_promos: {},
        daily_tracker: { date: new Date().toISOString().split('T')[0], count: 3 },
        daily_withdrawals: { date: null, count: 0 },
        cooldown_until: 0, current_session_loop: 2, withdrawals_count: 1
    });
});

const auth = () => `WebApp ${harness.signInitData({ id: Number(USER), username: 't' })}`;
const REDIS_METHODS = ['get', 'set', 'setex', 'del', 'incr', 'expire', 'lpush', 'ltrim', 'lrange', 'lrem', 'call'];

/** Simulates the Upstash quota failure: every redis command rejects. */
function silenceExpectedLogging() {
    const realError = console.error;
    const realWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    return () => { console.error = realError; console.warn = realWarn; };
}

function breakRedis() {
    const saved = {};
    for (const m of REDIS_METHODS) {
        saved[m] = redis[m].bind(redis);
        redis[m] = async () => {
            throw new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500000');
        };
    }
    require('../services/settings').invalidateGlobalSettings();
    const unsilence = silenceExpectedLogging();
    return () => {
        unsilence();
        for (const m of REDIS_METHODS) redis[m] = saved[m];
        require('../services/settings').invalidateGlobalSettings();
    };
}

const post = (path, body) => fetch(server.url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth() },
    body: JSON.stringify(body)
});

// ---------------------------------------------------------------------------
// A redis outage should degrade the app, not blank it out
// ---------------------------------------------------------------------------

test('the dashboard still renders when redis is completely down', async () => {
    const restore = breakRedis();
    try {
        const initData = harness.signInitData({ id: Number(USER), username: 't' });
        const res = await fetch(`${server.url}/dashboard?id=${USER}&initData=${encodeURIComponent(initData)}`,
            { redirect: 'manual', headers: { Accept: 'text/html' } });

        assert.strictEqual(res.status, 200, 'users must still see their balance during an outage');
        const html = await res.text();
        assert.match(html, /100,000/, 'balance should render from mongo');
    } finally { restore(); }
});

test('ad telemetry never reports failure to the user', async () => {
    const restore = breakRedis();
    try {
        const res = await post('/portal/ad-telemetry', { network: 'monetag', status: 'success' });
        assert.strictEqual(res.status, 200, 'analytics must not look like a failed ad');
    } finally { restore(); }
});

test('money routes fail closed with an honest 503, not a generic 500', async () => {
    const restore = breakRedis();
    try {
        for (const [path, body] of [
            ['/portal/claim-ad-reward', { id: USER }],
            ['/portal/purchase-store-item', { id: USER, item: 'cooldown' }],
            ['/portal/request-payout', { id: USER, amount: 2000, asset: 'TON', destination: 'UQx' }]
        ]) {
            const res = await post(path, body);
            assert.strictEqual(res.status, 503, `${path} should report unavailable, got ${res.status}`);

            const body2 = await res.json();
            assert.match(body2.error, /temporarily unavailable/i, `${path}: unhelpful message`);
            assert.doesNotMatch(body2.error, /max requests limit|redis/i, `${path}: leaks internals`);
        }
    } finally { restore(); }
});

test('a redis outage never returns HTML', async () => {
    const restore = breakRedis();
    try {
        const res = await post('/portal/claim-ad-reward', { id: USER });
        const text = await res.text();
        assert.doesNotMatch(text, /<\s*(!doctype|html|pre)\b/i);
        assert.match(res.headers.get('content-type') || '', /application\/json/);
    } finally { restore(); }
});

// ---------------------------------------------------------------------------
// A notification failure must not undo work that already committed
// ---------------------------------------------------------------------------

test('an ad claim still succeeds when the notification queue is down', async () => {
    // The 200 is written before the cooldown notification is enqueued. A throw
    // there used to make the catch block respond a second time, which crashed
    // the process with ERR_HTTP_HEADERS_SENT.
    ctx.queueState.shouldFail = true;
    const unsilence = silenceExpectedLogging();

    const crashes = [];
    const onErr = (e) => crashes.push(e);
    process.on('uncaughtException', onErr);
    process.on('unhandledRejection', onErr);
    try {
        const res = await post('/portal/claim-ad-reward', { id: USER });
        assert.strictEqual(res.status, 200, 'the points were credited — do not report failure');

        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.loopIndex, 0, 'this claim completes a loop, triggering the notification');

        await new Promise(r => setTimeout(r, 300));
        const headerCrash = crashes.find(e => /ERR_HTTP_HEADERS_SENT/.test(e && (e.code || e.message)));
        assert.ok(!headerCrash, `responded twice: ${headerCrash && headerCrash.message}`);
    } finally {
        unsilence();
        process.off('uncaughtException', onErr);
        process.off('unhandledRejection', onErr);
    }

    const user = await models.User.findOne({ telegram_id: USER });
    assert.ok(user.points_balance > 100000, 'points must actually be credited');
});

test('a withdrawal still succeeds when the admin alert cannot be queued', async () => {
    ctx.queueState.shouldFail = true;
    const unsilence = silenceExpectedLogging();
    let res;
    try {
        res = await post('/portal/request-payout', {
            id: USER, amount: 2000, asset: 'TON', destination: 'UQxxxxxxxx'
        });
    } finally { unsilence(); }

    assert.strictEqual(res.status, 200,
        'the payout ticket was created — a failed admin alert must not report failure to the user');

    const tickets = models.Withdrawal.__all();
    assert.strictEqual(tickets.length, 1, 'the ticket should still exist');
    const user = await models.User.findOne({ telegram_id: USER });
    assert.strictEqual(user.points_balance, 98000, 'points debited exactly once');
});

// ---------------------------------------------------------------------------
// Optional config should degrade, not fail
// ---------------------------------------------------------------------------

test('corrupt config in redis falls back to defaults instead of 500ing', async () => {
    await redis.set('admin:store_config', 'this is not json{{{');
    const res = await post('/portal/purchase-store-item', { id: USER, item: 'cooldown' });
    assert.strictEqual(res.status, 200, 'a corrupt config blob must not break purchases');

    const body = await res.json();
    const { DEFAULT_STORE_CONFIG } = require('../constants');
    assert.strictEqual(body.newBalance, 100000 - DEFAULT_STORE_CONFIG.cooldown);
});

test('corrupt quest config does not break the dashboard', async () => {
    await redis.set('admin:dynamic_quests', '][not json[');
    const initData = harness.signInitData({ id: Number(USER), username: 't' });
    const res = await fetch(`${server.url}/dashboard?id=${USER}&initData=${encodeURIComponent(initData)}`,
        { redirect: 'manual', headers: { Accept: 'text/html' } });
    assert.strictEqual(res.status, 200);
});

// ---------------------------------------------------------------------------
// A database outage should read the same way a redis outage does
// ---------------------------------------------------------------------------

/** Simulates a lost Atlas connection: every query rejects. */
function breakMongo() {
    const saved = [];
    const QUERY_METHODS = ['findOne', 'find', 'findById', 'findOneAndUpdate',
                           'countDocuments', 'updateOne', 'deleteOne', 'aggregate'];
    for (const model of Object.values(models)) {
        for (const fn of QUERY_METHODS) {
            saved.push([model, fn, model[fn]]);
            model[fn] = () => {
                const e = new Error('connection <monitor> to mongodb closed');
                e.name = 'MongoNetworkError';
                throw e;
            };
        }
    }
    const unsilence = silenceExpectedLogging();
    return () => { unsilence(); for (const [m, fn, orig] of saved) m[fn] = orig; };
}

test('a database outage reports 503, not a 500 with internal jargon', async () => {
    const restore = breakMongo();
    try {
        for (const [path, body] of [
            ['/portal/claim-ad-reward', { id: USER }],
            ['/portal/purchase-store-item', { id: USER, item: 'cooldown' }],
            ['/portal/request-payout', { id: USER, amount: 2000, asset: 'TON', destination: 'UQx' }],
            ['/portal/verify-quest', { id: USER, quest: 'channel' }]
        ]) {
            const res = await post(path, body);
            assert.strictEqual(res.status, 503, `${path} returned ${res.status}`);

            const parsed = await res.json();
            assert.match(parsed.error, /temporarily unavailable/i, `${path}: ${parsed.error}`);
            assert.doesNotMatch(parsed.error, /mongo|ledger fault|processing fault/i,
                `${path} leaked internals or jargon: ${parsed.error}`);
        }
    } finally { restore(); }
});

test('a database outage never returns HTML and never leaks driver messages', async () => {
    const restore = breakMongo();
    try {
        const initData = harness.signInitData({ id: Number(USER), username: 't' });
        for (const url of [
            `${server.url}/dashboard?id=${USER}&initData=${encodeURIComponent(initData)}`,
            `${server.url}/auth?tgWebAppInitData=${encodeURIComponent(initData)}`
        ]) {
            const res = await fetch(url, { redirect: 'manual', headers: { Accept: 'text/html' } });
            const text = await res.text();
            assert.strictEqual(res.status, 503, `${url} returned ${res.status}`);
            assert.doesNotMatch(text, /<\s*(!doctype|html|pre)\b/i, 'must not be an HTML error page');
            assert.doesNotMatch(text, /MongoNetworkError|connection <monitor>/i, 'must not leak the driver error');
        }
    } finally { restore(); }
});

test('a genuine bug still reports 500, not a misleading 503', async () => {
    // Classification must not swallow real defects.
    const { isInfrastructureError } = require('../services/errors');
    assert.strictEqual(isInfrastructureError(new TypeError("x is not a function")), false);
    assert.strictEqual(isInfrastructureError(new Error("Cannot read properties of undefined")), false);

    const mongoErr = new Error('connection timed out');
    mongoErr.name = 'MongoServerSelectionError';
    assert.strictEqual(isInfrastructureError(mongoErr), true);
    assert.strictEqual(isInfrastructureError(new Error('ERR max requests limit exceeded')), true);
});
