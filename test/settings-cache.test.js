'use strict';
const test = require('node:test');
const assert = require('node:assert');
const harness = require('./helpers/harness');

let ctx, settings, redis;   // settings is re-required by the cold-start test

test.before(async () => {
    ctx = await harness.setup();
    redis = require('../services/redis');
    settings = require('../services/settings');
});

test.after(async () => { await harness.teardown(); });

test.beforeEach(async () => {
    await redis.flushall();
    settings.invalidateGlobalSettings();
});

/** Counts how many times the module actually reaches Redis. */
function countingRedis() {
    const original = redis.get.bind(redis);
    let calls = 0;
    redis.get = async (...args) => { calls++; return original(...args); };
    return {
        get calls() { return calls; },
        restore() { redis.get = original; }
    };
}

test('repeated reads inside the TTL cost a single redis command', async () => {
    await redis.set('global_settings', JSON.stringify({ maintenance: false, withdrawals: true, reward_per_ad: 7 }));
    settings.invalidateGlobalSettings();

    const counter = countingRedis();
    try {
        for (let i = 0; i < 25; i++) {
            const s = await settings.getGlobalSettings();
            assert.strictEqual(s.reward_per_ad, 7);
        }
        assert.strictEqual(counter.calls, 1,
            `25 reads should hit redis once, hit it ${counter.calls} times`);
    } finally {
        counter.restore();
    }
});

test('invalidating forces a fresh read', async () => {
    await redis.set('global_settings', JSON.stringify({ reward_per_ad: 3 }));
    settings.invalidateGlobalSettings();
    assert.strictEqual((await settings.getGlobalSettings()).reward_per_ad, 3);

    // An admin saves new settings
    await redis.set('global_settings', JSON.stringify({ reward_per_ad: 9 }));
    settings.invalidateGlobalSettings();

    assert.strictEqual((await settings.getGlobalSettings()).reward_per_ad, 9,
        'must re-read after invalidation');
});

test('stored settings are merged over the defaults', async () => {
    const { DEFAULT_REWARD_PER_AD } = require('../constants');
    await redis.set('global_settings', JSON.stringify({ maintenance: true }));
    settings.invalidateGlobalSettings();

    const s = await settings.getGlobalSettings();
    assert.strictEqual(s.maintenance, true, 'stored value wins');
    assert.strictEqual(s.reward_per_ad, DEFAULT_REWARD_PER_AD, 'unset keys fall back to defaults');
});

test('an empty redis yields safe defaults, not maintenance mode', async () => {
    settings.invalidateGlobalSettings();
    const s = await settings.getGlobalSettings();
    assert.strictEqual(s.maintenance, false, 'must not lock users out when unset');
    assert.strictEqual(s.withdrawals, true);
});

test('a redis failure serves the last known settings instead of defaults', async () => {
    // This is the Upstash quota-exhaustion case: every command starts erroring.
    // Falling back to DEFAULTS would silently turn maintenance mode off.
    await redis.set('global_settings', JSON.stringify({ maintenance: true, reward_per_ad: 5 }));
    settings.invalidateGlobalSettings();
    await settings.getGlobalSettings();          // warm the cache

    const original = redis.get.bind(redis);
    redis.get = async () => { throw new Error('ERR max requests limit exceeded'); };
    try {
        settings.invalidateGlobalSettings();      // force it to try redis again
        const s = await settings.getGlobalSettings();
        assert.strictEqual(s.reward_per_ad, 5, 'should serve the last known copy');
        assert.strictEqual(s.maintenance, true, 'must not silently leave maintenance mode');
    } finally {
        redis.get = original;
    }
});

test('a redis failure on a cold start still returns usable defaults', async () => {
    // A fresh process that has never seen settings: drop the module so
    // lastKnownGood is genuinely empty, then make every redis read fail.
    const modulePath = require.resolve('../services/settings');
    delete require.cache[modulePath];

    const original = redis.get.bind(redis);
    redis.get = async () => { throw new Error('ERR max requests limit exceeded'); };
    try {
        const freshSettings = require('../services/settings');
        const s = await freshSettings.getGlobalSettings();
        assert.strictEqual(s.maintenance, false, 'a cold start must not lock everyone out');
        assert.strictEqual(s.withdrawals, true);
        assert.strictEqual(typeof s.reward_per_ad, 'number');
    } finally {
        redis.get = original;
        delete require.cache[modulePath];
        settings = require('../services/settings');
    }
});
