# Home value

Static draft of a public home-value page for Matthew Villaflor, SERHANT. Texas (Serhant Texas, LLC, license TX 717893).

The page itself has no build step. Host the repository root as a static site (GitHub Pages, Render, Cloudflare Pages, or any other file host). The API and the worker are separate services, deployed from `api/` and `worker/`.

## Structure

- `index.html` — page
- `assets/styles.css` — layout and the SERHANT palette (`#001A72`, `#F7F7F7`, `#FFFFFF`, champagne `#D2A984`, hover `#002FCF`)
- `assets/app.js` — the `SOURCES` array, `API_BASE`, and the session poll
- `api/` — Render web service. Sessions live in memory
- `worker/` — Homebot scraper. GitHub Actions runs `worker/run-once.js`; `scrape.js` still has the unused Redfin scraper
- `render.yaml` — Render Blueprint for `api/`
- `.github/workflows/lookup.yml` — one Actions run per address
- `assets/mv-logo-black.png` — MV monogram for light backgrounds (original line art)
- `assets/mv-logo-white.png` — the same monogram, with opaque pixels recolored white and alpha left unchanged
- `assets/matthew-villaflor.png` — agent photo, 300×300
- `assets/fonts/` — self-hosted Newsreader and Outfit (SIL Open Font License)
- `.nojekyll` — skips Jekyll processing on GitHub Pages
- `.github/workflows/pages.yml` — deploys to GitHub Pages on every push to `main`

## Behavior

The source list lives in one array in `assets/app.js`. The hero index and the results grid both render from that array, and the grid wraps to however many entries it contains.

Submitting a full street address creates a session on the API and polls it for about three minutes. The page says "Waking up the server" while Render starts, then "Looking up Homebot" while GitHub Actions runs. Homebot is the only live source. Redfin, Zillow, Chase, PennyMac, Homes.com, and Rate.com stay Pending / Coming soon. If Homebot asks for an account before showing a value, the card says Unavailable. The page does not invent a dollar amount. Nothing is saved in `localStorage`. Refreshing the page clears the address and the results.

`API_BASE` in `assets/app.js` is `https://home-value-api-3mvp.onrender.com`. The Blueprint service name is still `home-value-api`; Render assigned the `-3mvp` suffix on the live URL.

Each new session asks GitHub to run `.github/workflows/lookup.yml` on `main`. The API allows 5 lookups per IP every 10 minutes and a global cap of 100 per day (`DAILY_CAP`). Those counters live in memory, so they reset when the free Render instance sleeps or restarts. Set `WORKER_URL` only if you want the API to call an HTTP worker instead of Actions.

## Deploy the API on Render

`render.yaml` is a Blueprint for a free web service named `home-value-api`, rooted at `api/`. There is no database.

1. Create the shared secret: `openssl rand -hex 32`. You will paste it in two places.
2. Create a fine-grained personal access token (GitHub → Settings → Developer settings → Fine-grained tokens):
   - Resource owner: the account that owns this repo
   - Repository access: only `mrvillaflor/home-value`
   - Repository permission: **Actions: Read and write**
   - No other repository permissions
3. In this repo, open Settings → Secrets and variables → Actions → New repository secret. Name it `WORKER_SECRET` and paste the secret from step 1.
4. In the Render dashboard, choose **New → Blueprint**, connect this GitHub repo, and apply `render.yaml`.
5. When Render asks for the secrets, set:
   - `GITHUB_TOKEN` to the fine-grained token from step 2
   - `WORKER_SECRET` to the same secret as the Actions secret
6. Leave `GITHUB_REPO` as `mrvillaflor/home-value` and `GITHUB_WORKFLOW` as `lookup.yml`. The Blueprint already sets those, plus `ALLOWED_ORIGIN` (`https://mrvillaflor.github.io`) and `DAILY_CAP` (`100`).
7. Confirm `https://home-value-api-3mvp.onrender.com/health` returns `{"ok":true}`. Render may add a suffix to the Blueprint name, so use the hostname shown on the service, not only `home-value-api.onrender.com`.

Render sets `RENDER_EXTERNAL_URL` itself. The API sends that origin plus `/callbacks` to the workflow. You do not set a callback URL by hand.

The workflow file has to be on `main` before the first dispatch will succeed. Pushes to `main` do not start a lookup; only the API does.

## GitHub Actions worker

`.github/workflows/lookup.yml` runs on `ubuntu-latest` for up to 3 minutes. It installs the worker, caches npm and the Playwright Chromium build, runs `worker/run-once.js` once, and posts the result to the callback with `Authorization: Bearer` the `WORKER_SECRET` repository secret. Lookups are not queued behind each other.

The address is passed as a workflow input. `run-once.js` registers it with Actions' log mask and does not print it. On a public repository the Actions run page can still list `workflow_dispatch` inputs, so the address may be visible there. Do not turn on Actions debug logging.

The script opens Matthew's public Homebot link, chooses the address, and reads a labeled estimate only when that number is already visible. It does not type an email, name, phone, or password, and it does not click sign up, a magic link, or the email form. If Homebot withholds the estimate until signup, the result is Unavailable with `Homebot requires a signup to show the estimate.`

`worker/scrape.js` still contains the Redfin scraper. Nothing calls it. Redfin stays Pending on the page.

To run the same command locally, without printing the address yourself:

```bash
cd worker
npm install
ADDRESS='100 Main St, Houston, TX 77002' SOURCE_ID=homebot CHROME_PATH=/usr/bin/google-chrome node run-once.js
```

Set `WORKER_URL` on the API only when you want that HTTP worker instead of Actions. The optional server is `worker/server.js`.

## Deploy the page

Pushes to `main` run the Pages workflow. `actions/configure-pages` is called with `enablement: true`, so Pages can be turned on automatically when the token is permitted to do that.

The expected site is [https://mrvillaflor.github.io/home-value/](https://mrvillaflor.github.io/home-value/).
