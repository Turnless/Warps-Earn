# Tests

```bash
npm test
```

## What this needs

- **Node 18+** (uses the built-in `node:test` runner and global `fetch`).
- **`redis-server` on PATH.** Each test file boots its own throwaway Redis on a
  random free port, so your real Upstash instance is never touched.

No MongoDB required: the Mongoose models are replaced with in-memory fakes
(`test/helpers/fake-model.js`) that implement the slice of the Mongoose API the
routes actually use. Everything else — the express app, the real routers, the
real auth middleware, the real Redis locks — is exercised for real.

Outbound Telegram calls are stubbed, so tests never hit the Bot API.

## Layout

| File | Covers |
|---|---|
| `auth.test.js` | initData signature + freshness window, IDOR id override |
| `auth-route.test.js` | `/auth` identity handling, user creation, referral linking |
| `onboarding.test.js` | `/portal/verify-sybil` auth, captcha, replay protection |
| `portal-routes.test.js` | store purchases, ad claims, adsgram cap, dashboard |
| `withdrawal.test.js` | payout rules, referral milestone payouts, tickets |
| `admin-auth.test.js` | admin session vs. scoped payout tokens |
| `store-pricing.test.js` | PTS vs. Stars price tables |
| `views.test.js` | EJS rendering: tier gates, thresholds, displayed prices |

## Notes

- Test files run serially (`--test-concurrency=1`). They each spawn a Redis
  process, and running them in parallel produced port races.
- `test.beforeEach` flushes Redis and clears the model stores, because the
  transactional rate limiter (5 req/min per user) otherwise bleeds across tests.
