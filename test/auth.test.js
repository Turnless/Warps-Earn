'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const BOT_TOKEN = '123456:TEST-BOT-TOKEN-FOR-UNIT-TESTS';
process.env.BOT_TOKEN = BOT_TOKEN;

const verifyTelegramWebAppData = require('../middleware/auth');

function sign(user, authDate) {
    const params = new URLSearchParams();
    params.set('auth_date', String(authDate));
    params.set('user', JSON.stringify(user));
    const keys = Array.from(params.keys()).sort();
    const dcs = keys.map(k => `${k}=${params.get(k)}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return params.toString();
}

function run(initData, body = {}) {
    const req = { headers: { authorization: `WebApp ${initData}` }, body };
    let statusCode = null, sent = null, nexted = false, contentType = null;
    const res = {
        status(c) { statusCode = c; return res; },
        send(b) { sent = b; return res; },
        // errors are JSON now — record the message and the fact it was JSON
        json(b) { contentType = 'application/json'; sent = (b && b.error) || b; return res; },
        type(t) { contentType = t; return res; }
    };
    verifyTelegramWebAppData(req, res, () => { nexted = true; });
    return { req, statusCode, sent, nexted, contentType };
}

const NOW = () => Math.floor(Date.now() / 1000);

test('accepts a freshly signed initData', () => {
    const r = run(sign({ id: 555 }, NOW()));
    assert.strictEqual(r.nexted, true, 'should call next()');
    assert.strictEqual(r.req.validatedTelegramId, '555');
});

test('rejects initData older than the 24h freshness window', () => {
    const stale = NOW() - (25 * 60 * 60);
    const r = run(sign({ id: 555 }, stale));
    assert.strictEqual(r.nexted, false, 'stale session must not pass');
    assert.strictEqual(r.statusCode, 401);
    assert.match(r.sent, /expired/i);
    assert.strictEqual(r.contentType, 'application/json', 'errors must not be HTML');
});

test('accepts initData just inside the freshness window', () => {
    const r = run(sign({ id: 555 }, NOW() - (23 * 60 * 60)));
    assert.strictEqual(r.nexted, true);
});

test('rejects initData with no auth_date at all', () => {
    // A signature with no auth_date would otherwise be valid forever.
    const params = new URLSearchParams();
    params.set('user', JSON.stringify({ id: 555 }));
    const dcs = ['user=' + JSON.stringify({ id: 555 })].join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));

    const r = run(params.toString());
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(r.statusCode, 401);
});

test('rejects a forged signature', () => {
    const good = sign({ id: 555 }, NOW());
    const forged = good.replace(/hash=[0-9a-f]+/, 'hash=' + 'a'.repeat(64));
    const r = run(forged);
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(r.statusCode, 403);
});

test('rejects a non-hex hash without throwing', () => {
    const good = sign({ id: 555 }, NOW());
    const bad = good.replace(/hash=[0-9a-f]+/, 'hash=not-hex-at-all');
    assert.doesNotThrow(() => {
        const r = run(bad);
        assert.strictEqual(r.nexted, false);
        assert.strictEqual(r.statusCode, 403);
    });
});

test('overrides client-supplied ids with the verified identity', () => {
    // IDOR guard: body says 999, signature says 555 -> 555 wins.
    const r = run(sign({ id: 555 }, NOW()), { id: '999', telegram_id: '999' });
    assert.strictEqual(r.nexted, true);
    assert.strictEqual(r.req.body.id, '555');
    assert.strictEqual(r.req.body.telegram_id, '555');
});
