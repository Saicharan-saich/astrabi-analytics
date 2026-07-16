# Deployment & release safety

## Current flow

- **Frontend** builds with Vite and is served as static assets.
- **Backend** (`backend/server.js`, Express + Postgres) runs on Railway at
  `api.quickinsight.co.uk`.
- Pushing to `main` **auto-deploys to production** on Railway.

## CI quality gate (this repo)

`.github/workflows/ci.yml` runs on every push and on PRs into `main`:

1. **unit** — `npm ci`, `npm run build`, `npx vitest run`
2. **e2e** — installs Chromium and runs the Playwright smoke net (`npm run test:e2e`)

This catches build breaks, failing unit tests, and white-screen/boot regressions
**before** they reach production. Treat a red CI run as a blocker to merging.

## Recommended: add a staging environment

Because `main` deploys straight to production, a bad change is live for everyone
until reverted. To close that gap (needs the Railway dashboard — not code):

1. Create a second Railway environment (e.g. **staging**) for the backend, with
   its own database, tracking a `staging` branch or PR previews.
2. Point a staging frontend build at the staging API (`VITE_API_URL`).
3. Merge feature branches into `staging` first, verify, then fast-forward `main`.
4. Optionally enable Railway PR preview environments so every PR gets an
   ephemeral URL to click through before merge.

Until then, the CI gate above is the primary automated safety net, and the
Playwright smoke net is the fastest way to confirm the app still boots and
renders after a change:

```bash
npm run test:e2e     # build + serve + smoke test in a real browser
```
