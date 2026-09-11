'use strict';
const test = require('node:test');
const assert = require('node:assert');
const harness = require('./helpers/harness');
const { ONBOARDING_REWARD_PTS } = require('../constants');

let ctx, app, server, models;
const USER_ID = '660001';

test.before(async () => {
    ctx = await harness.setup();
    models = ctx.models;
    app = harness.buildFullApp();
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

function seedUser(id = USER_ID, overrides = {}) {
    models.User.__seed({
        telegram_id: id, username: 'newbie', points_balance: 0,
        onboarding_passed: false, earnings_history: [], referrals: [],
        quests: {}, custom_promos: {}, ...overrides
    });
}

/** Fetches the onboarding page and pulls the server-issued CAPTCHA out of it. */
async function getCaptcha(id) {
    const res = await fetch(`${server.url}/onboarding?id=${id}`);
    const html = await res.text();
    const m = html.match(/class="captcha-display">([A-Z0-9]+)</);
    assert.ok(m, 'captcha should be rendered');
    return m[1];
}

function verifyBody(captcha, overrides = {}) {
    return {
        fingerprint: 'fp_test_device_1',
        solution: captcha,
        country: 'NG',
        xHandle: '@tester',
        ...overrides
    };
}

async function postVerify(body, signAsId = USER_ID) {
    return fetch(server.url + '/portal/verify-sybil', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `WebApp ${harness.signInitData({ id: Number(signAsId), username: 'tester' })}`
        },
        body: JSON.stringify(body)
    });
}

test('onboarding requires a signed session', async () => {
    seedUser();
    const captcha = await getCaptcha(USER_ID);

    const res = await fetch(server.url + '/portal/verify-sybil', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: USER_ID, ...verifyBody(captcha) })
    });

    assert.strictEqual(res.status, 401, 'route was previously unauthenticated');
    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.onboarding_passed, false);
    assert.strictEqual(user.points_balance, 0);
});

test('a valid onboarding awards the reward exactly once', async () => {
    seedUser();
    const captcha = await getCaptcha(USER_ID);

    const first = await postVerify(verifyBody(captcha));
    assert.strictEqual(first.status, 200, await first.text());

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.onboarding_passed, true);
    assert.strictEqual(user.points_balance, ONBOARDING_REWARD_PTS);
    assert.strictEqual(user.country, 'NG');
    assert.strictEqual(user.x_handle, 'https://x.com/tester');
});

test('onboarding cannot be replayed for repeat rewards', async () => {
    seedUser();
    const first = await postVerify(verifyBody(await getCaptcha(USER_ID)));
    assert.strictEqual(first.status, 200);

    // Re-fetch a fresh captcha and replay: this used to add another 100 PTS
    // every time, with no cap.
    const second = await postVerify(verifyBody(await getCaptcha(USER_ID)));
    assert.strictEqual(second.status, 409, 'replay must be refused');

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, ONBOARDING_REWARD_PTS,
        'reward must not be granted twice');
});

test('a signed user cannot onboard someone else\'s account', async () => {
    // Attacker signs as 660002 but targets 660001 in the body.
    seedUser('660001');
    seedUser('660002');
    const victimCaptcha = await getCaptcha('660001');

    const res = await postVerify({ id: '660001', ...verifyBody(victimCaptcha) }, '660002');

    // Acts as the signer, whose own captcha was never issued -> refused.
    assert.notStrictEqual(res.status, 200);

    const victim = await models.User.findOne({ telegram_id: '660001' });
    assert.strictEqual(victim.onboarding_passed, false, 'victim must be untouched');
    assert.strictEqual(victim.points_balance, 0);
    assert.strictEqual(victim.device_fingerprint, undefined);
});

test('a wrong captcha answer is refused', async () => {
    seedUser();
    await getCaptcha(USER_ID);
    const res = await postVerify(verifyBody('WRONG'));
    assert.strictEqual(res.status, 400);

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, 0);
});

test('a captcha is single-use', async () => {
    seedUser();
    const captcha = await getCaptcha(USER_ID);
    await postVerify(verifyBody(captcha, { solution: 'WRONG' }));

    // first attempt consumed it
    const res = await postVerify(verifyBody(captcha));
    assert.strictEqual(res.status, 400);
});
