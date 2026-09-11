'use strict';
const test = require('node:test');
const assert = require('node:assert');
const harness = require('./helpers/harness');
const { FIRST_WITHDRAWAL_MIN_PTS, REFERRAL_MILESTONES } = require('../constants');

let ctx, app, server, models;
const USER_ID = '888001';
const REFERRER_ID = '888999';

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
    ctx.sentMessages.length = 0;
    for (const model of Object.values(models)) model.__clear();
});

/** Referrer sits one qualified referral short of the 10-referral milestone. */
function seedReferralChain() {
    models.User.__clear();
    const qualified = [];
    for (let i = 0; i < 9; i++) {
        qualified.push({ telegram_id: `9000${i}`, username: `u${i}`, ads_viewed: 100, reward_issued: true, qualified: true });
    }
    qualified.push({ telegram_id: USER_ID, username: 'newbie', ads_viewed: 100, reward_issued: true, qualified: false });

    models.User.__seed([
        {
            telegram_id: USER_ID, username: 'newbie', points_balance: 5000,
            account_tier: 'Standard', onboarding_passed: true, is_banned: false,
            referrer_id: REFERRER_ID, withdrawals_count: 0,
            earnings_history: [], referrals: [], transactions: [],
            daily_withdrawals: { date: null, count: 0 }, quests: {}, custom_promos: {}
        },
        {
            telegram_id: REFERRER_ID, username: 'promoter', points_balance: 1000,
            account_tier: 'Standard', onboarding_passed: true, is_banned: false,
            earnings_history: [], referrals: qualified, transactions: [],
            milestones_claimed: { tier_10: false, tier_20: false, tier_50: false, tier_100: false },
            daily_withdrawals: { date: null, count: 0 }, quests: {}, custom_promos: {}
        }
    ]);
}

async function requestPayout(body) {
    return fetch(server.url + '/portal/request-payout', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `WebApp ${harness.signInitData({ id: Number(USER_ID), username: 'newbie' })}`
        },
        body: JSON.stringify(body)
    });
}

test('first withdrawal succeeds when it triggers a referrer milestone', async () => {
    // REFERRAL_MILESTONES entries had no `label`, so the referrer's earnings entry
    // was written with `type: undefined` -> required-field validation error ->
    // the whole withdrawal 500ed and the user's points were never saved.
    seedReferralChain();

    const res = await requestPayout({
        id: USER_ID, amount: FIRST_WITHDRAWAL_MIN_PTS, asset: 'TON', destination: 'UQxxxxxxxxxxxxxxxx'
    });

    assert.strictEqual(res.status, 200, `withdrawal failed: ${await res.text()}`);

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, 5000 - FIRST_WITHDRAWAL_MIN_PTS);
    assert.strictEqual(user.withdrawals_count, 1);
    assert.strictEqual(user.transactions.length, 1);
    assert.strictEqual(user.transactions[0].status, 'Pending');
});

test('the referrer is paid and credited for the milestone', async () => {
    seedReferralChain();
    await requestPayout({ id: USER_ID, amount: FIRST_WITHDRAWAL_MIN_PTS, asset: 'TON', destination: 'UQxxxxxxxxxxxxxxxx' });

    const referrer = await models.User.findOne({ telegram_id: REFERRER_ID });
    const tier10 = REFERRAL_MILESTONES.find(m => m.n === 10);

    assert.strictEqual(referrer.milestones_claimed.tier_10, true, 'milestone must be marked claimed');
    assert.strictEqual(referrer.points_balance, 1000 + tier10.pts);

    const entry = referrer.earnings_history[0];
    assert.ok(entry, 'referrer should have an earnings entry');
    assert.strictEqual(typeof entry.type, 'string');
    assert.ok(entry.type.length > 0, 'earnings entry type must not be undefined');
    assert.strictEqual(entry.amount, tier10.pts);
});

test('a withdrawal ticket is created for the admin queue', async () => {
    seedReferralChain();
    await requestPayout({ id: USER_ID, amount: FIRST_WITHDRAWAL_MIN_PTS, asset: 'TON', destination: 'UQxxxxxxxxxxxxxxxx' });

    const tickets = models.Withdrawal.__all();
    assert.strictEqual(tickets.length, 1);
    assert.strictEqual(tickets[0].telegram_id, USER_ID);
    assert.strictEqual(tickets[0].amount_points, FIRST_WITHDRAWAL_MIN_PTS);
    assert.strictEqual(tickets[0].status, 'Pending');
});

test('withdrawal below the first-time minimum is refused', async () => {
    seedReferralChain();
    const res = await requestPayout({ id: USER_ID, amount: 100, asset: 'TON', destination: 'UQxxx' });
    assert.strictEqual(res.status, 403);

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, 5000, 'balance must be untouched');
});

test('withdrawal above the available balance is refused', async () => {
    seedReferralChain();
    const res = await requestPayout({ id: USER_ID, amount: 999999, asset: 'TON', destination: 'UQxxx' });
    assert.strictEqual(res.status, 400);
    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, 5000);
});

test('naira withdrawal requires a 10-digit account number', async () => {
    seedReferralChain();
    const res = await requestPayout({
        id: USER_ID, amount: FIRST_WITHDRAWAL_MIN_PTS, asset: 'NAIRA', destination: '123', bank: 'OPAY'
    });
    assert.strictEqual(res.status, 400);
});
