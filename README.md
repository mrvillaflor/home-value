# Home value

Static draft of a public home-value page for Matthew Villaflor, SERHANT. Texas (Serhant Texas, LLC, license TX 717893).

The page itself has no build step. Host the repository root as a static site (GitHub Pages, Render, Cloudflare Pages, or any other file host). The API and the worker are separate services, deployed from `api/` and `worker/`.

## Structure

- `index.html` — page
- `assets/styles.css` — layout and the SERHANT palette (`#001A72`, `#F7F7F7`, `#FFFFFF`, champagne `#D2A984`, hover `#002FCF`)
- `assets/app.js` — the `SOURCES` array, `API_BASE`, and the session poll
- `api/` — Render web service. Sessions live in memory
- `worker/` — portable Playwright service. Homebot is the live lookup; `scrape.js` still has the unused Redfin scraper
- `render.yaml` — Render Blueprint for `api/`
- `assets/mv-logo-black.png` — MV monogram for light backgrounds (original line art)
- `assets/mv-logo-white.png` — the same monogram, with opaque pixels recolored white and alpha left unchanged
- `assets/matthew-villaflor.png` — agent photo, 300×300
- `assets/fonts/` — self-hosted Newsreader and Outfit (SIL Open Font License)
- `.nojekyll` — skips Jekyll processing on GitHub Pages
- `.github/workflows/pages.yml` — deploys to GitHub Pages on every push to `main`

## Behavior

The source list lives in one array in `assets/app.js`. The hero index and the results grid both render from that array, and the grid wraps to however many entries it contains.

Submitting a full street address creates a session on the API and polls it. Homebot is the only live source. Its card shows the estimate when a labeled Homebot value is already on the page. Redfin, Zillow, Chase, PennyMac, Homes.com, and Rate.com stay Pending / Coming soon. If Homebot asks for an account before showing a value, the card says Unavailable. The page does not invent a dollar amount. Nothing is saved in `localStorage`. Refreshing the page clears the address and the results.

`API_BASE` in `assets/app.js` defaults to `https://home-value-api.onrender.com`. Change that one constant if the Render URL is different.

## Deploy the API on Render

`render.yaml` is a Blueprint for a free web service named `home-value-api`, rooted at `api/`. There is no database.

1. Generate a shared secret: `openssl rand -hex 32`
2. In the Render dashboard, choose **New → Blueprint** and connect this GitHub repo.
3. When Render prompts for the empty environment variables, set:
   - `WORKER_URL` to the origin where the worker is running, with no trailing slash
   - `WORKER_SECRET` to the secret from step 1
4. Apply the Blueprint. Render runs `npm install` and `npm start` in `api/`.
5. Confirm `https://home-value-api.onrender.com/health` returns `{"ok":true}`.

Render sets `RENDER_EXTERNAL_URL` itself. The API uses it as the worker callback base, so you do not set that variable. The free instance sleeps when it is idle. The page says it is waking the server; the first request after sleep can take about a minute.

You can apply the Blueprint before the worker has a public URL, then set `WORKER_URL` on the Render service once the worker is reachable.

## Run the worker

The worker is a portable Node and Playwright service. It is not deployed, and it is not tied to a host. Run it anywhere you can give the API an HTTPS `WORKER_URL`. Chromium needs more than Render's 512MB web service, so keep this process separate from the API.

From `worker/`, with Node and Chrome already installed:

```bash
cd worker
npm install
WORKER_SECRET='the-same-secret-you-set-on-render' CHROME_PATH=/usr/bin/google-chrome PORT=8080 npm start
```

Or with Docker, from `worker/`:

```bash
docker build -t home-value-worker .
docker run --rm -p 8080:8080 -e WORKER_SECRET='the-same-secret-you-set-on-render' -e PORT=8080 home-value-worker
```

`GET /health` returns `{"ok":true}`. `POST /jobs` requires `Authorization: Bearer` that same secret and `sourceId` set to `homebot`. Any other `sourceId` is rejected.

The worker opens Matthew's public Homebot link, chooses the address, and reads a labeled estimate only when that number is already visible. It does not type an email, name, phone, or password, and it does not click sign up, a magic link, or the email form. If Homebot withholds the estimate until signup, the result is Unavailable with `Homebot requires a signup to show the estimate.`

`worker/scrape.js` still contains the Redfin scraper. The server does not call it. Redfin stays Pending on the page.

## Deploy the page

Pushes to `main` run the Pages workflow. `actions/configure-pages` is called with `enablement: true`, so Pages can be turned on automatically when the token is permitted to do that.

The expected site is [https://mrvillaflor.github.io/home-value/](https://mrvillaflor.github.io/home-value/).
