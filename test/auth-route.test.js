'use strict';
const test = require('node:test');
const assert = require('node:assert');
const harness = require('./helpers/harness');

let ctx, app, server, models;

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

test.beforeEach(async () => {
    await require('../services/redis').flushall();
    for (const model of Object.values(models)) model.__clear();
});

test('GET /auth?id= creates no user without a valid signature', async () => {
    // Anyone could previously mint user records by enumerating telegram ids.
    const res = await fetch(server.url + '/auth?id=123456789');
    assert.strictEqual(res.status, 200);

    const body = await res.text();
    assert.match(body, /Warps Earn/, 'should fall back to the loader page');
    assert.strictEqual(models.User.__all().length, 0, 'no user record may be created');
});

test('GET /auth with a forged signature creates no user', async () => {
    const good = harness.signInitData({ id: 123456789, username: 'attacker' });
    const forged = good.replace(/hash=[0-9a-f]+/, 'hash=' + 'b'.repeat(64));
    const res = await fetch(server.url + '/auth?tgWebAppInitData=' + encodeURIComponent(forged));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(models.User.__all().length, 0);
});

test('GET /auth with a stale signature creates no user', async () => {
    const stale = harness.signInitData(
        { id: 123456789 },
        { authDate: Math.floor(Date.now() / 1000) - (48 * 60 * 60) }
    );
    const res = await fetch(server.url + '/auth?tgWebAppInitData=' + encodeURIComponent(stale));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(models.User.__all().length, 0);
});

test('GET /auth with a valid signature creates the user and redirects to onboarding', async () => {
    const initData = harness.signInitData({ id: 5551234, username: 'realuser', first_name: 'Real' });
    const res = await fetch(server.url + '/auth?tgWebAppInitData=' + encodeURIComponent(initData), {
        redirect: 'manual'
    });

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.get('location'), /^\/onboarding\?id=5551234/);

    const users = models.User.__all();
    assert.strictEqual(users.length, 1);
    assert.strictEqual(users[0].telegram_id, '5551234');
    assert.strictEqual(users[0].onboarding_passed, false);
});

test('a referral start_param links the new user into the referrer\'s list', async () => {
    // Entering via the Mini App only set referrer_id, so the referrer's
    // referrals[] entry (which drives the activation bonus) never existed.
    models.User.__seed({
        telegram_id: '7001', username: 'promoter', points_balance: 0,
        onboarding_passed: true, referrals: [], earnings_history: [], quests: {}, custom_promos: {}
    });

    const initData = harness.signInitData(
        { id: 7002, username: 'invitee' },
        { startParam: 'ref_7001' }
    );
    await fetch(server.url + '/auth?tgWebAppInitData=' + encodeURIComponent(initData), { redirect: 'manual' });

    const invitee = await models.User.findOne({ telegram_id: '7002' });
    assert.strictEqual(invitee.referrer_id, '7001', 'referrer_id must be recorded');

    const promoter = await models.User.findOne({ telegram_id: '7001' });
    assert.strictEqual(promoter.referrals.length, 1, 'referrer must have a referrals[] entry');
    assert.strictEqual(promoter.referrals[0].telegram_id, '7002');
    assert.strictEqual(promoter.referrals[0].reward_issued, false);
    assert.strictEqual(promoter.referrals[0].ads_viewed, 0);
});

test('a self-referral is ignored', async () => {
    const initData = harness.signInitData({ id: 7003, username: 'selfref' }, { startParam: 'ref_7003' });
    await fetch(server.url + '/auth?tgWebAppInitData=' + encodeURIComponent(initData), { redirect: 'manual' });

    const user = await models.User.findOne({ telegram_id: '7003' });
    assert.strictEqual(user.referrer_id, null);
});

test('a non-numeric referral payload is ignored', async () => {
    const initData = harness.signInitData({ id: 7004 }, { startParam: 'ref_notanid' });
    await fetch(server.url + '/auth?tgWebAppInitData=' + encodeURIComponent(initData), { redirect: 'manual' });

    const user = await models.User.findOne({ telegram_id: '7004' });
    assert.strictEqual(user.referrer_id, null);
});

test('an already-onboarded user is sent straight to the dashboard', async () => {
    models.User.__seed({
        telegram_id: '7005', username: 'veteran', onboarding_passed: true,
        points_balance: 500, referrals: [], earnings_history: [], quests: {}, custom_promos: {}
    });

    const initData = harness.signInitData({ id: 7005, username: 'veteran' });
    const res = await fetch(server.url + '/auth?tgWebAppInitData=' + encodeURIComponent(initData), {
        redirect: 'manual'
    });

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.get('location'), /^\/dashboard\?id=7005/);
    assert.match(res.headers.get('location'), /initData=/, 'must forward initData so the dashboard can verify');
});
