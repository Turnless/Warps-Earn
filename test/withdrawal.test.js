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

// ---------------------------------------------------------------------------
// Atomicity: a failure after the debit must not strand the user's points
// ---------------------------------------------------------------------------

/** Simulates the ticket write failing after the debit has committed. */
function breakTicketSave() {
    models.Withdrawal.__failSave = true;
    models.Withdrawal.__failSaveMessage = 'connection <monitor> to mongodb closed';
    const realError = console.error;
    console.error = () => {};
    return () => {
        console.error = realError;
        models.Withdrawal.__failSave = false;
        models.Withdrawal.__failSaveMessage = null;
    };
}

test('a failed ticket write refunds the user instead of stranding their points', async () => {
    seedReferralChain();

    const restore = breakTicketSave();
    let res;
    try {
        res = await requestPayout({
            id: USER_ID, amount: FIRST_WITHDRAWAL_MIN_PTS, asset: 'TON', destination: 'UQxxxxxxxx'
        });
    } finally { restore(); }

    assert.ok(res.status >= 400, `should report failure, got ${res.status}`);

    const user = await models.User.findOne({ telegram_id: USER_ID });
    assert.strictEqual(user.points_balance, 5000,
        'points must be refunded when the ticket could not be written');
    assert.strictEqual(user.withdrawals_count, 0, 'the withdrawal counter must be rolled back');
    assert.strictEqual((user.transactions || []).length, 0,
        'the pending transaction entry must be removed');
    assert.strictEqual(user.daily_withdrawals.count, 0, 'the daily counter must be rolled back');
});

test('the referrer is not paid when the withdrawal itself fails', async () => {
    seedReferralChain();

    const restore = breakTicketSave();
    try {
        await requestPayout({ id: USER_ID, amount: FIRST_WITHDRAWAL_MIN_PTS, asset: 'TON', destination: 'UQx' });
    } finally { restore(); }

    const referrer = await models.User.findOne({ telegram_id: REFERRER_ID });
    assert.strictEqual(referrer.points_balance, 1000,
        'the referrer must not be paid a milestone for a withdrawal that never happened');
    assert.notStrictEqual(referrer.milestones_claimed.tier_10, true,
        'the milestone must not be marked claimed');
});

test('the debit is guarded against a balance that changed underneath it', async () => {
    seedReferralChain();

    // Simulate a concurrent withdrawal landing between the read and the debit by
    // bumping withdrawals_count (the optimistic-concurrency token) *after* the
    // route's read resolves — mutating before it would just be read back.
    const realFindOne = models.User.findOne.bind(models.User);
    let firstRead = true;
    models.User.findOne = function (query) {
        const q = realFindOne(query);
        if (firstRead && query && query.telegram_id === USER_ID) {
            firstRead = false;
            const originalThen = q.then.bind(q);
            q.then = (onOk, onErr) => originalThen((doc) => {
                const stored = models.User.__all().find(u => u.telegram_id === USER_ID);
                if (stored) stored.withdrawals_count = 5;   // someone else withdrew
                return onOk(doc);
            }, onErr);
        }
        return q;
    };

    let res;
    try {
        res = await requestPayout({
            id: USER_ID, amount: FIRST_WITHDRAWAL_MIN_PTS, asset: 'TON', destination: 'UQx'
        });
    } finally {
        models.User.findOne = realFindOne;
    }

    assert.strictEqual(res.status, 409, 'a changed balance must be refused, not double-debited');
    const parsed = await res.json();
    assert.match(parsed.error, /changed|try again/i);
    assert.strictEqual(models.Withdrawal.__all().length, 0, 'no ticket should be created');
});

test('withdrawal limits and minimums come from constants, not inline literals', async () => {
    const {
        TIER_DAILY_WITHDRAWAL_LIMITS, GOLD_MIN_WITHDRAWAL_PTS,
        FIRST_WITHDRAWAL_MIN_PTS: FIRST, MIN_WITHDRAWAL_PTS: SUBSEQUENT
    } = require('../constants');

    // Gold's lower minimum is honoured by the server
    seedReferralChain();
    const stored = models.User.__all().find(u => u.telegram_id === USER_ID);
    stored.account_tier = 'Gold';

    const res = await requestPayout({
        id: USER_ID, amount: GOLD_MIN_WITHDRAWAL_PTS, asset: 'TON', destination: 'UQx'
    });
    assert.strictEqual(res.status, 200,
        `Gold should be able to withdraw the configured minimum of ${GOLD_MIN_WITHDRAWAL_PTS}`);

    // and the tier limits exist for every tier the schema allows
    for (const tier of ['Standard', 'Premium', 'Gold']) {
        assert.ok(typeof TIER_DAILY_WITHDRAWAL_LIMITS[tier] === 'number',
            `no daily withdrawal limit configured for ${tier}`);
    }
    assert.ok(FIRST > SUBSEQUENT, 'first withdrawal minimum should exceed the subsequent one');
});
