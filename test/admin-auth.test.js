'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const harness = require('./helpers/harness');

let ctx, app, server, models;

test.before(async () => {
    ctx = await harness.setup();
    models = ctx.models;
    app = harness.buildApp({ mountAdmin: true });
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

/** Mints the same HMAC payout token routes/portal.js sends to Telegram. */
function payoutToken(txId, action, exp = Date.now() + 3600000) {
    const payload = Buffer.from(JSON.stringify({ txId, action, exp })).toString('base64');
    const sig = crypto.createHmac('sha256', harness.ADMIN_SECRET).update(payload).digest('hex');
    return `${payload}.${sig}`;
}

test('a payout token is accepted on the payout route', async () => {
    models.User.__seed({
        telegram_id: '9001', username: 'payee', points_balance: 0,
        transactions: [{ txId: 'TX-1', type: 'Withdrawal (TON)', amount: 2000, date: 'now', status: 'Pending' }],
        earnings_history: [], referrals: [], quests: {}, custom_promos: {}
    });

    const res = await fetch(`${server.url}/admin/payout?token=${encodeURIComponent(payoutToken('TX-1', 'approve'))}`, {
        redirect: 'manual'
    });

    assert.strictEqual(res.status, 200, 'token must unlock the payout route');
    assert.match(await res.text(), /Approved/i);
});

test('a payout token does NOT unlock other admin routes', async () => {
    // The token travels in a Telegram message. Before scoping it granted access
    // to every /admin route — broadcast, ban, CSV export, balance edits.
    const token = encodeURIComponent(payoutToken('TX-1', 'approve'));

    for (const path of ['/admin/export-users', '/admin/sybil-hunter', '/admin/', '/admin/queues']) {
        const res = await fetch(`${server.url}${path}?token=${token}`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302, `${path} should not be unlocked by a payout token`);
        assert.strictEqual(res.headers.get('location'), '/admin/login');
    }
});

test('a forged payout token is rejected', async () => {
    const payload = Buffer.from(JSON.stringify({ txId: 'TX-1', action: 'approve', exp: Date.now() + 3600000 })).toString('base64');
    const forged = `${payload}.${'0'.repeat(64)}`;

    const res = await fetch(`${server.url}/admin/payout?token=${encodeURIComponent(forged)}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/admin/login');
});

test('an expired payout token is rejected', async () => {
    const expired = payoutToken('TX-1', 'approve', Date.now() - 1000);
    const res = await fetch(`${server.url}/admin/payout?token=${encodeURIComponent(expired)}`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/admin/login');
});

test('admin routes require auth when no token is supplied', async () => {
    const res = await fetch(`${server.url}/admin/export-users`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/admin/login');
});

test('rejecting a payout refunds the user', async () => {
    models.User.__seed({
        telegram_id: '9002', username: 'payee', points_balance: 100,
        transactions: [{ txId: 'TX-2', type: 'Withdrawal (TON)', amount: 2000, date: 'now', status: 'Pending' }],
        earnings_history: [], referrals: [], quests: {}, custom_promos: {}
    });

    const res = await fetch(`${server.url}/admin/payout?token=${encodeURIComponent(payoutToken('TX-2', 'reject'))}`, {
        redirect: 'manual'
    });
    assert.strictEqual(res.status, 200);

    const user = await models.User.findOne({ telegram_id: '9002' });
    assert.strictEqual(user.points_balance, 2100, 'points must be refunded');
    assert.strictEqual(user.transactions[0].status, 'Rejected');
});

test('a payout cannot be resolved twice', async () => {
    models.User.__seed({
        telegram_id: '9003', username: 'payee', points_balance: 0,
        transactions: [{ txId: 'TX-3', type: 'Withdrawal (TON)', amount: 2000, date: 'now', status: 'Successful' }],
        earnings_history: [], referrals: [], quests: {}, custom_promos: {}
    });

    const res = await fetch(`${server.url}/admin/payout?token=${encodeURIComponent(payoutToken('TX-3', 'approve'))}`, {
        redirect: 'manual'
    });
    assert.strictEqual(res.status, 400);
    assert.match(await res.text(), /already been resolved/i);
});

// ---------------------------------------------------------------------------
// Store config: blank fields must preserve existing values, not reset to literals
// ---------------------------------------------------------------------------

async function adminSession() {
    const redis = require('../services/redis');
    const crypto = require('crypto');
    const token = crypto.randomBytes(16).toString('hex');
    const csrf = crypto.randomBytes(16).toString('hex');
    await redis.setex(`admin:session:${token}`, 300, JSON.stringify({ loginAt: 'now' }));
    await redis.setex(`admin:csrf:${token}`, 300, csrf);
    return { cookie: `admin_session=${token}; admin_csrf=${csrf}`, csrf };
}

test('submitting the store form with blank fields keeps the current prices', async () => {
    const redis = require('../services/redis');
    const { DEFAULT_STORE_CONFIG } = require('../constants');

    // An admin previously set a custom price
    await redis.set('admin:store_config', JSON.stringify({ cooldown: 777, gold_tier_1m: 42000 }));

    const { cookie, csrf } = await adminSession();
    const res = await fetch(`${server.url}/admin/store-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ _csrf: csrf, cooldown: '', gold_tier_1m: '' }).toString(),
        redirect: 'manual'
    });
    assert.strictEqual(res.status, 302);

    const saved = JSON.parse(await redis.get('admin:store_config'));
    assert.strictEqual(saved.cooldown, 777, 'a blank field must not reset the stored price');
    assert.strictEqual(saved.gold_tier_1m, 42000, 'a blank field must not reset the stored price');
    assert.strictEqual(saved.multiplier, DEFAULT_STORE_CONFIG.multiplier,
        'unset fields fall back to the shared defaults');
});

test('submitting a new price updates it and leaves the rest alone', async () => {
    const redis = require('../services/redis');
    await redis.set('admin:store_config', JSON.stringify({ cooldown: 777, gold_tier_1m: 42000 }));

    const { cookie, csrf } = await adminSession();
    await fetch(`${server.url}/admin/store-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ _csrf: csrf, cooldown: '999' }).toString(),
        redirect: 'manual'
    });

    const saved = JSON.parse(await redis.get('admin:store_config'));
    assert.strictEqual(saved.cooldown, 999, 'the submitted price should be applied');
    assert.strictEqual(saved.gold_tier_1m, 42000, 'other prices must be untouched');
});

test('a junk or negative price is ignored rather than stored', async () => {
    const redis = require('../services/redis');
    await redis.set('admin:store_config', JSON.stringify({ cooldown: 777 }));

    const { cookie, csrf } = await adminSession();
    await fetch(`${server.url}/admin/store-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ _csrf: csrf, cooldown: 'free', gold_tier_1m: '-5' }).toString(),
        redirect: 'manual'
    });

    const saved = JSON.parse(await redis.get('admin:store_config'));
    assert.strictEqual(saved.cooldown, 777, 'junk input must not overwrite a real price');
    assert.ok(saved.gold_tier_1m > 0, 'a negative price must never be stored');
});
