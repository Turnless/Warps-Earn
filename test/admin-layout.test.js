'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const { PTS_TO_USD_RATE, DEFAULT_STORE_CONFIG, DEFAULT_STARS_CONFIG, DEFAULT_REWARD_PER_AD, STREAK_BONUS_REWARD } = require('../constants');

const VIEWS = path.join(__dirname, '..', 'views');

/** Mirrors the locals routes/admin.js passes to the dashboard. */
function adminLocals(overrides = {}) {
    return {
        stats: {
            users: 1234, pending: 3, circulatingPts: 5000000, circulatingUsd: '4000.00',
            adsWatched: 90000, adEarnings: 400000, taskEarnings: 90000,
            referralEarnings: 25000, paidOutPts: 120000, paidOutUsd: '96.00'
        },
        pendingList: [{
            ticket_id: 'TX-1', telegram_id: '1', username: 'u', amount_points: 2000,
            asset: 'TON', bank_provider: null, destination_details: 'UQx',
            status: 'Pending', created_at: new Date()
        }],
        // Every queue holds one item, so each loop (and its forms) actually renders.
        pendingBounties: [{
            _id: 'sub1', telegram_id: '11', status: 'pending', proof_url: 'https://x.com/p/1',
            created_at: new Date(), user: { username: 'alice', telegram_id: '11' },
            bounty: { title: 'Retweet launch', reward_pts: 500 }
        }],
        pendingStoreOrders: [{
            _id: 'ord1', telegram_id: '12', item_title: 'Gold Tier (1 Month)', cost: 50000,
            currency: 'pts', blue_tick: false, created_at: new Date(),
            user: { username: 'bob', telegram_id: '12' }
        }],
        pendingXVerifications: [{
            telegram_id: '13', username: 'carol', x_handle: 'https://x.com/carol',
            x_followers: 1200, x_blue_tick: false, account_tier: 'Standard'
        }],
        questSubmissions: [{
            id: 'qs1', telegram_id: '14', username: 'dan', promoKey: 'promo1',
            link: 'https://x.com/dan/1', pts: 150, timestamp: new Date().toISOString()
        }],
        topUsers: [{ telegram_id: '15', username: 'eve', points_balance: 90000 }],
        countryStats: [{ country: 'NG', count: 900 }],
        settings: { maintenance: false, withdrawals: true, reward_per_ad: DEFAULT_REWARD_PER_AD, streak_reward: STREAK_BONUS_REWARD },
        telemetry: {}, storeConfig: { ...DEFAULT_STORE_CONFIG, ...DEFAULT_STARS_CONFIG },
        dynamicQuests: {}, ptsToUsd: PTS_TO_USD_RATE,
        ...overrides
    };
}

const render = (data) => ejs.renderFile(path.join(VIEWS, 'admin_dashboard.ejs'), data, { async: false });

const SECTIONS = ['overview', 'payouts', 'review', 'users', 'content', 'economy', 'messaging', 'system'];

test('the dashboard renders without an EJS error', async () => {
    const html = await render(adminLocals());
    assert.ok(html.length > 5000, 'expected a full page');
});

test('every nav item has a section, and every section has a nav item', async () => {
    const html = await render(adminLocals());
    for (const name of SECTIONS) {
        assert.ok(html.includes(`id="tab-${name}"`), `missing section tab-${name}`);
        assert.ok(html.includes(`id="nav-${name}"`), `missing nav item nav-${name}`);
        assert.ok(html.includes(`switchTab('tab-${name}')`), `nav-${name} does not switch to its section`);
    }

    const sectionIds = [...html.matchAll(/<section id="tab-([a-z]+)"/g)].map(m => m[1]).sort();
    assert.deepStrictEqual(sectionIds, [...SECTIONS].sort(), 'section list drifted from the nav');
});

test('exactly one section is visible on load', async () => {
    const html = await render(adminLocals());
    const visible = [...html.matchAll(/<section id="tab-([a-z]+)" class="([^"]*)"/g)]
        .filter(m => !m[2].includes('hide-section'))
        .map(m => m[1]);
    assert.deepStrictEqual(visible, ['overview'], `expected only overview visible, got ${visible.join(', ')}`);
});

test('no admin action was lost in the reorganisation', async () => {
    // Every form endpoint routes/admin.js exposes must still be reachable.
    const html = await render(adminLocals());
    const REQUIRED_ACTIONS = [
        '/admin/settings', '/admin/store-config', '/admin/quests', '/admin/quests/action',
        '/admin/bounty/action', '/admin/store-orders/action', '/admin/user-x-verify',
        '/admin/user-lookup', '/admin/broadcast', '/admin/wakeup-push'
    ];
    for (const action of REQUIRED_ACTIONS) {
        assert.ok(html.includes(`action="${action}"`), `form for ${action} disappeared`);
    }
});

test('previously unreachable pages are now linked from the nav', async () => {
    const html = await render(adminLocals());
    for (const href of ['/admin/queues', '/admin/sybil-hunter', '/admin/export-users', '/admin/export-withdrawals']) {
        assert.ok(html.includes(`href="${href}"`), `${href} is still not linked anywhere`);
    }
});

test('no duplicate element ids across the merged sections', async () => {
    const html = await render(adminLocals());
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    const seen = new Set();
    const dupes = new Set();
    for (const id of ids) {
        if (seen.has(id)) dupes.add(id);
        seen.add(id);
    }
    assert.deepStrictEqual([...dupes], [], `duplicate ids would break the page: ${[...dupes].join(', ')}`);
});

test('every state-changing form carries a CSRF field', async () => {
    const html = await render(adminLocals());
    const forms = [...html.matchAll(/<form[^>]*method="POST"[^>]*>([\s\S]*?)<\/form>/gi)];
    assert.ok(forms.length >= 8, `expected several POST forms, found ${forms.length}`);
    for (const [full, body] of forms) {
        const action = (full.match(/action="([^"]+)"/) || [])[1] || '(none)';
        assert.ok(/name="_csrf"/.test(body), `POST form for ${action} has no _csrf field`);
    }
});

test('queue counts drive the nav badges', async () => {
    const withWork = await render(adminLocals({
        stats: { ...adminLocals().stats, pending: 7 },
        pendingBounties: [{ _id: 'b', telegram_id: '1', status: 'pending', user: {}, bounty: {} }],
        pendingStoreOrders: [], pendingXVerifications: [], questSubmissions: []
    }));
    const navBlock = withWork.slice(withWork.indexOf('id="nav-payouts"'), withWork.indexOf('id="nav-review"'));
    assert.match(navBlock, />\s*7\s*</, `payout badge should show the pending count; got: ${navBlock.slice(-300)}`);

    const idle = await render(adminLocals({ stats: { ...adminLocals().stats, pending: 0 } }));
    const payoutNav = idle.slice(idle.indexOf('id="nav-payouts"'), idle.indexOf('id="nav-review"'));
    assert.doesNotMatch(payoutNav, /rounded text-\[10px\] font-mono font-bold/, 'no badge when nothing is pending');
});

test('maintenance and withdrawal warnings surface in the sidebar', async () => {
    const normal = await render(adminLocals());
    assert.doesNotMatch(normal, /Maintenance mode is ON/);

    const degraded = await render(adminLocals({
        settings: { maintenance: true, withdrawals: false }
    }));
    assert.match(degraded, /Maintenance mode is ON/, 'maintenance should be visible from any tab');
    assert.match(degraded, /Withdrawals are OFF/, 'withdrawals-off should be visible from any tab');
});

test('the admin page contains no hardcoded conversion rate', async () => {
    const source = fs.readFileSync(path.join(VIEWS, 'admin_dashboard.ejs'), 'utf8');
    assert.doesNotMatch(source, /CONVERSION_RATE\s*=\s*0\.\d+/,
        'the rate should come from the server, not a literal');

    const html = await render(adminLocals());
    assert.ok(html.includes(`CONVERSION_RATE = ${PTS_TO_USD_RATE}`),
        'the rendered rate should match constants.js');
});
