# LedgerLine

Stock research from SEC filings. Site on Cloudflare Pages (`ledgerline`), API on a Cloudflare Worker (`sec-proxy`), data in D1 (`ledgerline`).

## Layout
| Path | What |
|---|---|
| `app-src/Stockings.html` | the app source (single file) |
| `tools/build_site.py` | builds `site/app/index.html` from the app source |
| `tools/features/` | builds `site/features.html` |
| `site/` | everything published to Pages (home, features, terms, privacy, app) |
| `worker/src/index.js` | the sec-proxy worker; `worker/wrangler.jsonc` its config |
| `tests/` | Playwright tests on mock data; `npm test` runs them all |

## How a change goes live
1. Change `app-src/`, `site/`, `tools/` or `worker/`, commit, push to `main`.
2. GitHub Actions builds the site and runs every test (each tab, phone and desktop, light and dark; any page error or sideways scroll fails the run).
3. Only if every test passes does it deploy the worker, then the site, then check the live worker reports the new version.
4. Roll back: Cloudflare dashboard → Workers → sec-proxy → Deployments (or Pages → ledgerline → Deployments) → pick the previous one.

## Secrets
Never in this repo. Worker secrets (`MARKETSTACK_KEY`, `USAGE_KEY`, Stripe keys, …) live in Cloudflare. GitHub holds one secret, `CLOUDFLARE_API_TOKEN`, used only to deploy.

## Local
```
npm ci && npx playwright install chromium
npm run build && npm test
```
