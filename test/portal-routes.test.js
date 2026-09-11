'use strict';
const test = require('node:test');
const assert = require('node:assert');
const harness = require('./helpers/harness');

let ctx, app, server, models;
const USER_ID = '777001';

test.before(async () => {
    ctx = await harness.setup();
    models = ctx.models;
    app = harness.buildApp();
    server = await harness.listen(app);
});

test.after(async () => {
    if (server) await server.close();
    await harness.teardown();
});

// The transactional limiter allows 5 requests/min per telegram id and is backed
// by the shared test redis, so wipe rate-limit + lock state between tests.
test.beforeEach(async () => {
    const redis = require('../services/redis');
    await redis.flushall();
});

function auth(userId = USER_ID) {
    return `WebApp ${harness.signInitData({ id: Number(userId), username: 'tester' })}`;
}

function seedUser(overrides = {}) {
    models.User.__clear();
    models.User.__seed({
        telegram_id: USER_ID,
        username: 'tester',
        points_balance: 100000,
        account_tier: 'Standard',
        ad_multiplier: 1,
        onboarding_passed: true,
        is_banned: false,
        earnings_history: [],
        referrals: [],
        transactions: [],
        quests: {},
        custom_promos: {},
        daily_tracker: { date: null, count: 0 },
        daily_withdrawals: { date: null, count: 0 },
        withdrawals_count: 0,
        ...overrides
    });
}

async function post(path, body, userId = USER_ID) {
    return fetch(server.url + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth(userId) },
        body: JSON.stringify(body)
    });
}

// ---------------------------------------------------------------------------
// Store purchase: the lockKey-in-finally ReferenceError
// ---------------------------------------------------------------------------

test('store purchase succeeds without an unhandled rejection', async () => {
    seedUser();
    const rejections = [];
    const onRejection = (e) => rejections.push(e);
    process.on('unhandledRejection', onRejection);

    const res = await post('/portal/purchase-store-item', { id: USER_ID, item: 'cooldown' });
    const body = await res.json();

    // give the event loop a tick to surface any rejection from finally{}
    await new Promise(r => setTimeout(r, 50));
    process.off('unhandledRejection', onRejection);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.deepStrictEqual(
        rejections.map(r => r && r.message),
        [],
        'finally{} released a lock variable that was out of scope'
    );
});

test('store purchase releases its redis lock so a second buy works', async () => {
    seedUser();
    const first = await post('/portal/purchase-store-item', { id: USER_ID, item: 'cooldown' });
    assert.strictEqual(first.status, 200);

    // Previously the lock leaked (ReferenceError before del) and this 429ed.
    const second = await post('/portal/purchase-store-item', { id: USER_ID, item: 'cooldown' });
    assert.strictEqual(second.status, 200, 'lock was not released after the first purchase');
});

test('store purchase deducts exactly the configured cost', async () => {
    const { DEFAULT_STORE_CONFIG } = require('../constants');
    seedUser({ points_balance: 50000 });
    const res = await post('/portal/purchase-store-item', { id: USER_ID, item: 'multiplier' });
    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.newBalance, 50000 - DEFAULT_STORE_CONFIG.multiplier);
    assert.ok(Number.isFinite(body.newBalance), 'balance must never become NaN');
});

test('store purchase rejects an item with no configured price', async () => {
    seedUser();
    // premium_tier_3m has no price when store config is absent from redis --
    // `balance < undefined` is false, so this used to slip through to NaN.
    const redis = require('../services/redis');
    await redis.del('admin:store_config');
    await redis.set('admin:store_config', JSON.stringify({ cooldown: 500 }));

    const res = await post('/portal/purchase-store-item', { id: USER_ID, item: 'premium_tier_1m' });
    assert.strictEqual(res.status, 400);

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, 100000, 'balance must be untouched');
    await redis.del('admin:store_config');
});

test('store purchase is blocked when the balance is too low', async () => {
    seedUser({ points_balance: 10 });
    const res = await post('/portal/purchase-store-item', { id: USER_ID, item: 'multiplier' });
    assert.strictEqual(res.status, 400);
    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, 10);
});

// ---------------------------------------------------------------------------
// Adsgram faucet
// ---------------------------------------------------------------------------

test('adsgram reward can only be claimed once per day', async () => {
    seedUser({ points_balance: 0 });
    const redis = require('../services/redis');
    const today = new Date().toISOString().split('T')[0];
    await redis.del(`adsgram:claimed:${USER_ID}:${today}`);

    const first = await post('/portal/claim-adsgram-reward', { id: USER_ID });
    assert.strictEqual(first.status, 200);
    const body = await first.json();
    assert.strictEqual(body.newBalance, require('../constants').ADSGRAM_REWARD_PTS);

    const second = await post('/portal/claim-adsgram-reward', { id: USER_ID });
    assert.strictEqual(second.status, 429, 'second claim the same day must be refused');

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, require('../constants').ADSGRAM_REWARD_PTS,
        'points must only be awarded once');
});

test('adsgram reward is refused for banned users', async () => {
    seedUser({ points_balance: 0, is_banned: true });
    const redis = require('../services/redis');
    const today = new Date().toISOString().split('T')[0];
    await redis.del(`adsgram:claimed:${USER_ID}:${today}`);

    const res = await post('/portal/claim-adsgram-reward', { id: USER_ID });
    assert.strictEqual(res.status, 403);
});

// ---------------------------------------------------------------------------
// Auth enforcement on money routes
// ---------------------------------------------------------------------------

test('money routes reject requests with no initData', async () => {
    seedUser();
    for (const path of ['/portal/purchase-store-item', '/portal/claim-ad-reward', '/portal/request-payout']) {
        const res = await fetch(server.url + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: USER_ID, item: 'cooldown' })
        });
        assert.strictEqual(res.status, 401, `${path} must require a signed session`);
    }
});

test('money routes reject a stale initData signature', async () => {
    seedUser();
    const stale = harness.signInitData(
        { id: Number(USER_ID) },
        { authDate: Math.floor(Date.now() / 1000) - (25 * 60 * 60) }
    );
    const res = await fetch(server.url + '/portal/purchase-store-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `WebApp ${stale}` },
        body: JSON.stringify({ id: USER_ID, item: 'cooldown' })
    });
    assert.strictEqual(res.status, 401);
});

test('a signed user cannot spend another user\'s balance', async () => {
    // IDOR: sign as 777001 but claim to be 777002 in the body.
    models.User.__clear();
    models.User.__seed([
        { telegram_id: USER_ID, username: 'attacker', points_balance: 0, onboarding_passed: true, earnings_history: [], referrals: [], quests: {}, custom_promos: {} },
        { telegram_id: '777002', username: 'victim', points_balance: 999999, onboarding_passed: true, earnings_history: [], referrals: [], quests: {}, custom_promos: {} }
    ]);

    const res = await post('/portal/purchase-store-item', { id: '777002', item: 'multiplier' }, USER_ID);
    assert.strictEqual(res.status, 400, 'should act as the signed user (who has 0 PTS)');

    const victim = await models.User.findOne({ telegram_id: '777002' });
    assert.strictEqual(victim.points_balance, 999999, 'victim balance must be untouched');
});

// ---------------------------------------------------------------------------
// Dashboard + ad claim (exercises the full view chain and the login tracker)
// ---------------------------------------------------------------------------

test('dashboard renders for an onboarded user', async () => {
    seedUser({ points_balance: 4242 });
    const initData = harness.signInitData({ id: Number(USER_ID), username: 'tester' });

    const res = await fetch(`${server.url}/dashboard?id=${USER_ID}&initData=${encodeURIComponent(initData)}`, {
        redirect: 'manual'
    });

    assert.strictEqual(res.status, 200, 'dashboard should render');
    const html = await res.text();
    assert.match(html, /4,242/, 'balance should be shown');
    assert.doesNotMatch(html, /\/1000 ads/, 'referral denominator regression');
});

test('dashboard rejects a request with no initData', async () => {
    seedUser();
    const res = await fetch(`${server.url}/dashboard?id=${USER_ID}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 401);
});

test('dashboard does not purge the cache on a repeat visit the same day', async () => {
    const redis = require('../services/redis');
    const today = new Date().toISOString().split('T')[0];
    seedUser({ last_login_date: today, login_streak: 3 });

    const initData = harness.signInitData({ id: Number(USER_ID), username: 'tester' });
    const url = `${server.url}/dashboard?id=${USER_ID}&initData=${encodeURIComponent(initData)}`;

    await fetch(url, { redirect: 'manual' });
    const cachedAfterFirst = await redis.get(`user:${USER_ID}:profile`);
    assert.ok(cachedAfterFirst, 'first visit should populate the cache');

    await fetch(url, { redirect: 'manual' });
    const cachedAfterSecond = await redis.get(`user:${USER_ID}:profile`);
    assert.ok(cachedAfterSecond,
        'second visit must not blow the cache away — that made every load a guaranteed miss');
});

test('claiming an ad round credits points and starts a cooldown', async () => {
    const { DEFAULT_REWARD_PER_AD, ADS_PER_ROUND } = require('../constants');
    seedUser({ points_balance: 0, cooldown_until: 0, current_session_loop: 0 });

    const res = await post('/portal/claim-ad-reward', { id: USER_ID });
    const raw = await res.text();
    assert.strictEqual(res.status, 200, raw);

    const body = JSON.parse(raw);
    const expected = DEFAULT_REWARD_PER_AD * ADS_PER_ROUND * 1;
    assert.strictEqual(body.newBalance, expected);
    assert.strictEqual(body.totalAds, ADS_PER_ROUND);

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.ok(user.cooldown_until > Date.now(), 'a cooldown should be set');
    assert.strictEqual(user.daily_tracker.count, ADS_PER_ROUND);
});

test('ad claim is refused once the daily cap is reached', async () => {
    const { DAILY_AD_LIMIT } = require('../constants');
    const today = new Date().toISOString().split('T')[0];
    seedUser({ points_balance: 0, daily_tracker: { date: today, count: DAILY_AD_LIMIT } });

    const res = await post('/portal/claim-ad-reward', { id: USER_ID });
    assert.strictEqual(res.status, 400);

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, 0);
});

test('ad claim is refused for a banned user', async () => {
    seedUser({ points_balance: 0, is_banned: true });
    const res = await post('/portal/claim-ad-reward', { id: USER_ID });
    assert.strictEqual(res.status, 403);
});
