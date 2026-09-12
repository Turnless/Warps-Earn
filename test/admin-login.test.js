'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const harness = require('./helpers/harness');

let ctx, server, models, redis;

test.before(async () => {
    ctx = await harness.setup();
    models = ctx.models;
    redis = require('../services/redis');
    server = await harness.listen(harness.buildApp({ mountAdmin: true }));
});

test.after(async () => {
    if (server) await server.close();
    await harness.teardown();
});

test.beforeEach(async () => {
    await redis.flushall();
    for (const m of Object.values(models)) m.__clear();
});

const REDIS_METHODS = ['get', 'set', 'setex', 'del', 'incr', 'expire', 'lpush', 'ltrim', 'lrange', 'lrem', 'call'];

/**
 * Simulates an unreachable Redis the way ioredis actually behaves with
 * maxRetriesPerRequest: null — commands queue forever, never settling.
 */
function stallRedis() {
    const saved = {};
    for (const m of REDIS_METHODS) {
        saved[m] = redis[m].bind(redis);
        redis[m] = () => new Promise(() => {});
    }
    const realError = console.error;
    console.error = () => {};
    return () => {
        console.error = realError;
        for (const m of REDIS_METHODS) redis[m] = saved[m];
    };
}

function login(password, opts = {}) {
    return fetch(`${server.url}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password }).toString(),
        redirect: 'manual',
        ...opts
    });
}

/** Collects Set-Cookie values into a request-ready Cookie header. */
function cookiesFrom(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
    return raw.filter(Boolean).map(c => c.split(';')[0]).join('; ');
}

// ---------------------------------------------------------------------------
// The reported bug: login hung forever with no error
// ---------------------------------------------------------------------------

test('login succeeds quickly when redis is healthy', async () => {
    const res = await login(harness.ADMIN_SECRET);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/admin');
});

test('login still completes when redis never responds', async () => {
    const restore = stallRedis();
    try {
        const started = Date.now();
        const res = await login(harness.ADMIN_SECRET);
        const elapsed = Date.now() - started;

        assert.strictEqual(res.status, 302, 'must not hang — this was the reported bug');
        assert.strictEqual(res.headers.get('location'), '/admin');
        assert.ok(elapsed < 6000, `login took ${elapsed}ms; it must stay responsive during an outage`);
    } finally { restore(); }
});

test('a wrong password is rejected promptly during an outage', async () => {
    const restore = stallRedis();
    try {
        const started = Date.now();
        const res = await login('definitely-not-the-password');
        assert.strictEqual(res.status, 200, 'should render the login page, not hang');
        assert.match(await res.text(), /Invalid Passphrase/i);
        assert.ok(Date.now() - started < 6000, 'the error page must not stall either');
    } finally { restore(); }
});

test('the whole admin session works with redis down', async () => {
    const restore = stallRedis();
    try {
        const res = await login(harness.ADMIN_SECRET);
        const cookie = cookiesFrom(res);
        assert.match(cookie, /admin_session=/, 'a session cookie should be issued');

        const dash = await fetch(`${server.url}/admin/`, {
            headers: { Cookie: cookie, Accept: 'text/html' }, redirect: 'manual'
        });
        assert.strictEqual(dash.status, 200, 'the dashboard must render during an outage');
        assert.match(await dash.text(), /WARPS/);
    } finally { restore(); }
});

test('CSRF-protected forms still work with redis down', async () => {
    const restore = stallRedis();
    try {
        const res = await login(harness.ADMIN_SECRET);
        const cookie = cookiesFrom(res);
        const csrf = (cookie.match(/admin_csrf=([^;]+)/) || [])[1];
        assert.ok(csrf, 'a CSRF cookie should be issued alongside the session');

        const post = await fetch(`${server.url}/admin/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
            body: new URLSearchParams({ _csrf: csrf, withdrawals: 'on' }).toString(),
            redirect: 'manual'
        });
        // The write itself may fail with redis down, but it must not be a CSRF rejection
        assert.notStrictEqual(post.status, 403, 'CSRF must not depend on redis');
    } finally { restore(); }
});

// ---------------------------------------------------------------------------
// The session token must still be a real credential
// ---------------------------------------------------------------------------

test('a tampered session cookie is rejected', async () => {
    const res = await login(harness.ADMIN_SECRET);
    const cookie = cookiesFrom(res);
    const token = (cookie.match(/admin_session=([^;]+)/) || [])[1];

    const [payload] = token.split('.');
    const forged = `${payload}.${'0'.repeat(64)}`;

    const dash = await fetch(`${server.url}/admin/`, {
        headers: { Cookie: `admin_session=${forged}` }, redirect: 'manual'
    });
    assert.strictEqual(dash.status, 302);
    assert.strictEqual(dash.headers.get('location'), '/admin/login');
});

test('a session with a forged expiry is rejected', async () => {
    // Re-signing requires the secret, so extending your own session must fail.
    const payload = Buffer.from(JSON.stringify({
        jti: 'abc', iat: Date.now(), exp: Date.now() + 10 * 365 * 24 * 3600 * 1000
    })).toString('base64url');
    const forged = `${payload}.${crypto.createHmac('sha256', 'wrong-secret').update(payload).digest('hex')}`;

    const dash = await fetch(`${server.url}/admin/`, {
        headers: { Cookie: `admin_session=${forged}` }, redirect: 'manual'
    });
    assert.strictEqual(dash.status, 302);
});

test('an expired session is rejected even though it is correctly signed', async () => {
    const payload = Buffer.from(JSON.stringify({
        jti: 'abc', iat: Date.now() - 100000, exp: Date.now() - 1000
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', harness.ADMIN_SECRET).update(payload).digest('hex');

    const dash = await fetch(`${server.url}/admin/`, {
        headers: { Cookie: `admin_session=${payload}.${sig}` }, redirect: 'manual'
    });
    assert.strictEqual(dash.status, 302);
});

test('a CSRF token from a different session is rejected', async () => {
    const a = await login(harness.ADMIN_SECRET);
    const b = await login(harness.ADMIN_SECRET);
    const cookieA = cookiesFrom(a);
    const csrfB = (cookiesFrom(b).match(/admin_csrf=([^;]+)/) || [])[1];

    const post = await fetch(`${server.url}/admin/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieA },
        body: new URLSearchParams({ _csrf: csrfB, withdrawals: 'on' }).toString(),
        redirect: 'manual'
    });
    assert.strictEqual(post.status, 403, 'a CSRF token must only be valid for its own session');
});

test('logging out revokes the session when redis is reachable', async () => {
    const res = await login(harness.ADMIN_SECRET);
    const cookie = cookiesFrom(res);

    const before = await fetch(`${server.url}/admin/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.strictEqual(before.status, 200);

    await fetch(`${server.url}/admin/logout`, { headers: { Cookie: cookie }, redirect: 'manual' });

    const after = await fetch(`${server.url}/admin/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.strictEqual(after.status, 302, 'the revoked token must not work even if the browser kept it');
    assert.strictEqual(after.headers.get('location'), '/admin/login');
});

test('brute-force lockout still applies when redis is healthy', async () => {
    for (let i = 0; i < 5; i++) await login('wrong');
    const res = await login('wrong');
    assert.match(await res.text(), /Too many failed attempts/i);
});
