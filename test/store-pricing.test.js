'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_STORE_CONFIG, DEFAULT_STARS_CONFIG, REFERRAL_MILESTONES } = require('../constants');

// Mirrors resolveStarsPriceKey() in routes/portal.js and the equivalent in bot.js
function resolveStarsPriceKey(item) {
    const key = String(item);
    if (key.startsWith('stars_')) return key;
    return `stars_${key.replace('_tier_', '_')}`;
}

// Every item the store UI can actually launch a purchase for.
const UI_PTS_ITEMS = [
    'cooldown', 'multiplier',
    'premium_tier_1m', 'premium_tier_3m_blue', 'premium_tier_6m_blue',
    'gold_tier_1m', 'gold_tier_3m_blue', 'gold_tier_6m_blue'
];
const UI_STARS_ITEMS = [...UI_PTS_ITEMS, 'x_verify'];

// Every item routes/portal.js accepts in its `items` map.
const SERVER_ITEMS = [
    'cooldown', 'multiplier',
    'premium_tier_1m', 'premium_tier_3m', 'premium_tier_6m',
    'premium_tier_3m_blue', 'premium_tier_6m_blue',
    'gold_tier_1m', 'gold_tier_3m', 'gold_tier_6m',
    'gold_tier_3m_blue', 'gold_tier_6m_blue'
];

test('every purchasable item has a PTS price', () => {
    for (const item of SERVER_ITEMS) {
        const price = DEFAULT_STORE_CONFIG[item];
        assert.ok(typeof price === 'number' && price > 0,
            `${item} has no PTS price (was undefined -> NaN balance)`);
    }
});

test('every Stars-purchasable item resolves to a Stars price', () => {
    for (const item of UI_STARS_ITEMS) {
        const key = resolveStarsPriceKey(item);
        const price = DEFAULT_STARS_CONFIG[key];
        assert.ok(typeof price === 'number' && price > 0,
            `${item} -> ${key} has no Stars price`);
    }
});

test('Stars prices are never the PTS price (the 1000x overcharge regression)', () => {
    for (const item of UI_PTS_ITEMS) {
        const ptsPrice = DEFAULT_STORE_CONFIG[item];
        const starsPrice = DEFAULT_STARS_CONFIG[resolveStarsPriceKey(item)];
        assert.notStrictEqual(starsPrice, ptsPrice,
            `${item}: Stars price equals the PTS price — invoice would overcharge`);
        assert.ok(starsPrice < ptsPrice,
            `${item}: Stars price ${starsPrice} should be far below the PTS price ${ptsPrice}`);
    }
});

test('x_verify resolves to stars_x_verify (previously 400ed)', () => {
    assert.strictEqual(resolveStarsPriceKey('x_verify'), 'stars_x_verify');
    assert.ok(DEFAULT_STARS_CONFIG.stars_x_verify > 0);
});

test('premium_tier_1m invoices ~15 Stars, not 15000', () => {
    const stars = DEFAULT_STARS_CONFIG[resolveStarsPriceKey('premium_tier_1m')];
    assert.strictEqual(stars, 15);
    assert.strictEqual(DEFAULT_STORE_CONFIG.premium_tier_1m, 15000);
});

test('every referral milestone has a label', () => {
    // A missing label wrote `type: undefined` into earnings_history, which is a
    // required field -> validation error -> the whole withdrawal 500ed.
    for (const m of REFERRAL_MILESTONES) {
        assert.ok(typeof m.label === 'string' && m.label.length > 0,
            `milestone n=${m.n} has no label`);
        assert.ok(typeof m.pts === 'number' && m.pts > 0);
    }
});

test('milestone payouts still match the advertised $50 pool', () => {
    const { PTS_TO_USD_RATE } = require('../constants');
    const total = REFERRAL_MILESTONES.reduce((s, m) => s + m.pts, 0);
    assert.strictEqual(Number((total * PTS_TO_USD_RATE).toFixed(2)), 50.00);
});
