---
name: deploy
description: Build and publish Hedgeways to surge.sh, handling the known CDN cache gotcha and verifying the live URL responds. Use when the user wants to deploy, publish, ship, or push the game live.
---

# Deploy Hedgeways to surge

Live target: **https://hedgeways.surge.sh**

## Steps

1. Build + publish in one go:
   ```bash
   pnpm run deploy
   ```
   - Runs `tsc --noEmit && vite build`, copies `index.html`→`200.html` (SPA fallback), then `surge ./dist hedgeways.surge.sh`.
   - **Must be `pnpm run deploy`** — `pnpm deploy` is a reserved pnpm command and errors with `ERR_PNPM_CANNOT_DEPLOY`.
   - Surge is already authenticated (creds in `~/.netrc`).

2. Verify — surge's CDN caches aggressively and a cold-start 504/404 can get cached:
   ```bash
   for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code}\n" "https://hedgeways.surge.sh/?cb=$RANDOM"; sleep 2; done
   ```
   - If `/` returns 504/404 while assets are 200, re-run `npx surge ./dist hedgeways.surge.sh` and re-verify with a `?cb=` cache-buster.

3. Report the live URL and final HTTP status.

Do NOT change the surge domain without asking the user first (deploying to a new domain is publicly visible).
