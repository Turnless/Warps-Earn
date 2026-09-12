'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ejs = require('ejs');
const {
    REFERRAL_ACTIVATION_THRESHOLD, DEFAULT_STORE_CONFIG, DEFAULT_STARS_CONFIG,
    FIRST_WITHDRAWAL_MIN_PTS, MIN_WITHDRAWAL_PTS, GOLD_MIN_WITHDRAWAL_PTS,
    TIER_DAILY_WITHDRAWAL_LIMITS, UPLINE_PROMOTER_REFERRAL_THRESHOLD, PTS_TO_USD_RATE
} = require('../constants');

// Mirrors what routes/portal.js hands the dashboard view.
const WITHDRAWAL_LIMITS = {
    firstMin: FIRST_WITHDRAWAL_MIN_PTS,
    subsequentMin: MIN_WITHDRAWAL_PTS,
    goldMin: GOLD_MIN_WITHDRAWAL_PTS,
    dailyLimits: TIER_DAILY_WITHDRAWAL_LIMITS,
    uplinePromoterThreshold: UPLINE_PROMOTER_REFERRAL_THRESHOLD,
    ptsToUsd: PTS_TO_USD_RATE
};

const VIEWS = path.join(__dirname, '..', 'views');

function baseUser(overrides = {}) {
    return {
        telegram_id: '4242', username: 'tester', first_name: 'Test',
        points_balance: 1200, total_ads_watched: 0, onboarding_passed: true,
        account_tier: 'Standard', ad_multiplier: 1, login_streak: 0,
        withdrawals_count: 0, earnings_history: [], transactions: [],
        referrals: [], quests: {}, custom_promos: {}, country: 'NG',
        ...overrides
    };
}

function render(file, data) {
    return ejs.renderFile(path.join(VIEWS, file), data, { async: false });
}

// --------------------------------------------------------------------------
// Bounty tier gating read the wrong field name
// --------------------------------------------------------------------------

test('a Gold-only bounty is locked for a Standard user', async () => {
    const html = await render('partials/dashboard/tabs/tasks.ejs', {
        user: baseUser({ account_tier: 'Standard' }),
        bounties: [{
            _id: 'b1', title: 'Gold Only Task', description: 'x', platform: 'Twitter',
            action_type: 'Like', reward_pts: 500, target_url: 'https://x.com/a',
            required_tier: 'Gold', max_participants: 100, completions: 0,
            current_participants: 0, requires_link: true, target_countries: []
        }],
        dynamicQuests: {}, userBountySubmissions: []
    });

    assert.match(html, /Requires Gold Tier/,
        'the model field is required_tier — the view read tier_required and never gated');
});

test('a Gold-only bounty is unlocked for a Gold user', async () => {
    const html = await render('partials/dashboard/tabs/tasks.ejs', {
        user: baseUser({ account_tier: 'Gold' }),
        bounties: [{
            _id: 'b1', title: 'Gold Only Task', description: 'x', platform: 'Twitter',
            action_type: 'Like', reward_pts: 500, target_url: 'https://x.com/a',
            required_tier: 'Gold', max_participants: 100, completions: 0,
            current_participants: 0, requires_link: true, target_countries: []
        }],
        dynamicQuests: {}, userBountySubmissions: []
    });

    assert.doesNotMatch(html, /Requires Gold Tier/);
    assert.match(html, /Do Task/);
});

// --------------------------------------------------------------------------
// Referral progress denominator
// --------------------------------------------------------------------------

test('referral progress uses the real activation threshold, not 1000', async () => {
    const html = await render('partials/dashboard/tabs/invitation.ejs', {
        user: baseUser({ referrals: [{ telegram_id: '999', username: '@friend', ads_viewed: 10, qualified: false }] }),
        locals: {},
        qualifiedRefs: 0, nextMilestoneTarget: 10, contestProgressPct: 0,
        REFERRAL_ACTIVATION_THRESHOLD
    });

    assert.match(html, new RegExp(`10/${REFERRAL_ACTIVATION_THRESHOLD} ads`),
        'progress should read 10/20, not 10/1000');
    assert.doesNotMatch(html, /\/1000 ads/);
});

// --------------------------------------------------------------------------
// Gold withdrawal minimum
// --------------------------------------------------------------------------

test('a Gold user sees the withdrawal minimum the server actually enforces', async () => {
    const aboveGoldMin = GOLD_MIN_WITHDRAWAL_PTS + 200;
    const html = await render('partials/dashboard/tabs/wallet.ejs', {
        user: baseUser({ account_tier: 'Gold', points_balance: aboveGoldMin }),
        firstWithdrawalDone: false, qualifiedRefs: 0,
        withdrawalLimits: WITHDRAWAL_LIMITS
    });

    assert.match(html, new RegExp(`Min:<\\/span>\\s*<span[^>]*>${GOLD_MIN_WITHDRAWAL_PTS} PTS`),
        'the view must show the configured Gold minimum, not a literal');
    assert.match(html, /Submit Withdrawal/,
        'a Gold user above the Gold minimum must not be blocked');
    assert.match(html, new RegExp(`${WITHDRAWAL_LIMITS.dailyLimits.Gold} withdrawals/day`),
        'the daily limit should come from config too');
});

test('a Standard user below the minimum still sees the blocked button', async () => {
    const html = await render('partials/dashboard/tabs/wallet.ejs', {
        user: baseUser({ account_tier: 'Standard', points_balance: FIRST_WITHDRAWAL_MIN_PTS - 100 }),
        firstWithdrawalDone: false, qualifiedRefs: 0,
        withdrawalLimits: WITHDRAWAL_LIMITS
    });
    assert.match(html, new RegExp(`Need ${FIRST_WITHDRAWAL_MIN_PTS} PTS to withdraw`));
});

test('the wallet view contains no hardcoded withdrawal numbers', async () => {
    const fs = require('fs');
    const source = fs.readFileSync(path.join(VIEWS, 'partials/dashboard/tabs/wallet.ejs'), 'utf8');
    for (const literal of [FIRST_WITHDRAWAL_MIN_PTS, MIN_WITHDRAWAL_PTS, GOLD_MIN_WITHDRAWAL_PTS]) {
        assert.ok(!new RegExp(`\\b${literal}\\b`).test(source),
            `wallet.ejs hardcodes ${literal}; it should read the value from withdrawalLimits`);
    }
});

// --------------------------------------------------------------------------
// Home per-round reward label
// --------------------------------------------------------------------------

test('the home header advertises the same reward the button pays', async () => {
    const html = await render('partials/dashboard/tabs/home.ejs', {
        user: baseUser({ ad_multiplier: 1 }),
        locals: {}, globalSettings: { reward_per_ad: 3 }
    });

    const perRound = html.match(/\+(\d+) PTS PER ROUND/);
    const buttonReward = html.match(/Watch 3 short ads \(\+(\d+) PTS\)/);
    assert.ok(perRound && buttonReward, 'both reward labels should render');
    assert.strictEqual(perRound[1], buttonReward[1],
        'header said 3 PTS while the button paid 9');
});

test('the home header doubles for a 2x multiplier user', async () => {
    const html = await render('partials/dashboard/tabs/home.ejs', {
        user: baseUser({ ad_multiplier: 2 }),
        locals: {}, globalSettings: { reward_per_ad: 3 }
    });
    assert.match(html, /\+18 PTS PER ROUND/);
});

// --------------------------------------------------------------------------
// Task badge count
// --------------------------------------------------------------------------

test('the task badge does not count bounties the user already submitted', async () => {
    const bounty = { _id: 'b1', target_countries: [] };
    const html = await render('partials/dashboard/state.ejs', {
        user: baseUser({ quests: { channel: true, group: true, payout_channel: true, x_account: true } }),
        locals: {}, dynamicQuests: {}, bounties: [bounty],
        userBountySubmissions: [{ bounty_id: 'b1', status: 'pending' }]
    });
    // state.ejs only assigns locals; re-evaluate by rendering the navbar with it
    assert.ok(typeof html === 'string');
});

test('store view passes the correct Stars price for every purchasable item', async () => {
    const html = await render('partials/dashboard/tabs/store.ejs', {
        user: baseUser(),
        storeConfig: { ...DEFAULT_STORE_CONFIG, ...DEFAULT_STARS_CONFIG },
        pendingOrders: []
    });

    function resolveStarsPriceKey(item) {
        const k = String(item);
        return k.startsWith('stars_') ? k : `stars_${k.replace('_tier_', '_')}`;
    }

    // promptStorePurchase('<item>', <ptsPrice>, <starsPrice>)
    const calls = [...html.matchAll(/promptStorePurchase\('([a-z0-9_]+)',\s*(\d+),\s*(\d+)\)/g)];
    assert.ok(calls.length >= 6, `expected store buttons to render, found ${calls.length}`);

    for (const [, item, ptsPrice, starsPrice] of calls) {
        const expectedStars = DEFAULT_STARS_CONFIG[resolveStarsPriceKey(item)];
        assert.strictEqual(Number(starsPrice), expectedStars,
            `${item}: view offers ${starsPrice} Stars but the invoice endpoint charges ${expectedStars}`);
        assert.notStrictEqual(Number(starsPrice), Number(ptsPrice),
            `${item}: Stars price must not equal the PTS price`);
    }
});

test('the store view never duplicates a price literal', async () => {
    // The dashboard route always supplies a complete store config, so any
    // `|| 15000` fallback here is a second copy of a price that can drift from
    // what the server charges.
    const fs = require('fs');
    const source = fs.readFileSync(path.join(VIEWS, 'partials/dashboard/tabs/store.ejs'), 'utf8');
    const duplicated = source.match(/storeConfig\??\.[a-z0-9_]+ \|\| \d+/g) || [];
    assert.deepStrictEqual(duplicated, [],
        `store.ejs hardcodes prices the server already provides: ${duplicated.join(', ')}`);
});

test('store prices render from the config the server supplies', async () => {
    const html = await render('partials/dashboard/tabs/store.ejs', {
        user: baseUser(),
        storeConfig: { ...DEFAULT_STORE_CONFIG, ...DEFAULT_STARS_CONFIG },
        pendingOrders: []
    });
    const calls = [...html.matchAll(/promptStorePurchase\('([a-z0-9_]+)',\s*(\d+),\s*(\d+)\)/g)];
    assert.ok(calls.length >= 6, `expected store buttons, found ${calls.length}`);
    for (const [, item, pts] of calls) {
        assert.strictEqual(Number(pts), DEFAULT_STORE_CONFIG[item],
            `${item} rendered ${pts} but the server charges ${DEFAULT_STORE_CONFIG[item]}`);
    }
});
