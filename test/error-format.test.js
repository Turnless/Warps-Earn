'use strict';
const test = require('node:test');
const assert = require('node:assert');
const harness = require('./helpers/harness');

let ctx, server, models;
const USER = '920001';

test.before(async () => {
    ctx = await harness.setup();
    models = ctx.models;
    server = await harness.listen(harness.buildFullApp());
});

test.after(async () => {
    if (server) await server.close();
    await harness.teardown();
});

test.beforeEach(async () => {
    await require('../services/redis').flushall();
    for (const m of Object.values(models)) m.__clear();
    models.User.__seed({
        telegram_id: USER, username: 't', points_balance: 10, onboarding_passed: true,
        is_banned: false, account_tier: 'Standard', ad_multiplier: 1,
        earnings_history: [], referrals: [], transactions: [], quests: {}, custom_promos: {},
        daily_tracker: { date: null, count: 0 }, daily_withdrawals: { date: null, count: 0 }
    });
});

const auth = () => `WebApp ${harness.signInitData({ id: Number(USER), username: 't' })}`;
const LOOKS_LIKE_HTML = /<\s*(!doctype|html|body|head|pre|div|span|script)\b/i;

async function inspect(path, opts = {}) {
    const res = await fetch(server.url + path, opts);
    const body = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', body };
}

function assertNotHtml(r, label) {
    assert.ok(!LOOKS_LIKE_HTML.test(r.body), `${label}: body is HTML -> ${r.body.slice(0, 80)}`);
    assert.ok(!/text\/html/i.test(r.type), `${label}: content-type is ${r.type}`);
}

function assertJsonError(r, label) {
    assertNotHtml(r, label);
    assert.match(r.type, /application\/json/, `${label}: expected JSON, got ${r.type}`);
    const parsed = JSON.parse(r.body);
    assert.strictEqual(typeof parsed.error, 'string', `${label}: missing {error} string`);
    assert.ok(parsed.error.length > 0, `${label}: empty error message`);
}

// --- the exact cases that produced <!DOCTYPE html> in a toast -----------------

test('a POST to a route that does not exist returns JSON, not an HTML page', async () => {
    const r = await inspect('/portal/does-not-exist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth() },
        body: '{}'
    });
    assert.strictEqual(r.status, 404);
    assertJsonError(r, '404');
});

test('a malformed JSON body returns JSON, not an HTML stack-trace page', async () => {
    const r = await inspect('/portal/claim-ad-reward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth() },
        body: '{not valid json'
    });
    assert.strictEqual(r.status, 400);
    assertJsonError(r, 'bad json');
    assert.doesNotMatch(r.body, /at \w+ \(/, 'must not leak a stack trace');
});

test('an unknown GET page returns plain text, not an HTML error page', async () => {
    const r = await inspect('/totally-unknown-page', { headers: { Accept: 'text/html' } });
    assert.strictEqual(r.status, 404);
    assertNotHtml(r, 'unknown page');
});

// --- every authenticated API failure mode ------------------------------------

test('auth failures return JSON', async () => {
    const cases = [
        ['no header', {}],
        ['garbage header', { Authorization: 'WebApp not-real-data' }],
        ['stale signature', {
            Authorization: `WebApp ${harness.signInitData({ id: Number(USER) },
                { authDate: Math.floor(Date.now() / 1000) - 90000 })}`
        }]
    ];
    for (const [label, headers] of cases) {
        const r = await inspect('/portal/claim-ad-reward', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ id: USER })
        });
        assert.ok(r.status === 401 || r.status === 403, `${label}: got ${r.status}`);
        assertJsonError(r, label);
    }
});

test('business-rule rejections return JSON', async () => {
    const cases = [
        ['insufficient balance', '/portal/purchase-store-item', { id: USER, item: 'multiplier' }],
        ['unknown store item',   '/portal/purchase-store-item', { id: USER, item: 'not_a_real_item' }],
        ['bad quest key',        '/portal/verify-quest',        { id: USER, quest: 'nope' }],
        ['incomplete payout',    '/portal/request-payout',      { id: USER }],
        ['bad bounty payload',   '/portal/submit-bounty',       { id: USER }]
    ];
    for (const [label, path, body] of cases) {
        const r = await inspect(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth() },
            body: JSON.stringify(body)
        });
        assert.ok(r.status >= 400, `${label}: expected a failure, got ${r.status}`);
        assertJsonError(r, label);
    }
});

test('the rate limiter returns JSON when it kicks in', async () => {
    let limited = null;
    for (let i = 0; i < 12 && !limited; i++) {
        const r = await inspect('/portal/purchase-store-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: auth() },
            body: JSON.stringify({ id: USER, item: 'multiplier' })
        });
        if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'rate limiter should trigger within 12 requests');
    assertJsonError(limited, 'rate limited');
});

test('a dashboard request without a token returns JSON, not markup', async () => {
    const r = await inspect(`/dashboard?id=${USER}`);
    assert.strictEqual(r.status, 401);
    assertNotHtml(r, 'dashboard auth');
});

// --- deliberate full-page states must still render -----------------------------

test('maintenance mode still renders a real page for browser navigations', async () => {
    const redis = require('../services/redis');
    await redis.set('global_settings', JSON.stringify({ maintenance: true, withdrawals: true }));
    require('../services/settings').invalidateGlobalSettings();

    const initData = harness.signInitData({ id: Number(USER), username: 't' });
    const r = await inspect(`/dashboard?id=${USER}&initData=${encodeURIComponent(initData)}`,
        { headers: { Accept: 'text/html' } });

    assert.match(r.body, /System Upgrade/, 'the maintenance page is a UI state, not an error message');

    // ...but the same state on an API call is a JSON error
    const api = await inspect('/portal/claim-ad-reward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth() },
        body: JSON.stringify({ id: USER })
    });
    assert.strictEqual(api.status, 503);
    assertJsonError(api, 'maintenance API');

    await redis.del('global_settings');
    require('../services/settings').invalidateGlobalSettings();
});
