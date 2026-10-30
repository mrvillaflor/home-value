# Home value

Static draft of a public home-value page for Matthew Villaflor, SERHANT. Texas (Serhant Texas, LLC, license TX 717893).

The page itself has no build step. Host the repository root as a static site (GitHub Pages, Render, Cloudflare Pages, or any other file host). The API and the worker are separate services, deployed from `api/` and `worker/`.

## Structure

- `index.html` — page
- `assets/styles.css` — layout and the SERHANT palette (`#001A72`, `#F7F7F7`, `#FFFFFF`, champagne `#D2A984`, hover `#002FCF`)
- `assets/app.js` — the `SOURCES` array, `API_BASE`, and the session poll
- `api/` — Render web service. Sessions live in memory
- `worker/` — Fly Playwright service that looks up Redfin
- `render.yaml` — Render Blueprint for `api/`
- `assets/mv-logo-black.png` — MV monogram for light backgrounds (original line art)
- `assets/mv-logo-white.png` — the same monogram, with opaque pixels recolored white and alpha left unchanged
- `assets/matthew-villaflor.png` — agent photo, 300×300
- `assets/fonts/` — self-hosted Newsreader and Outfit (SIL Open Font License)
- `.nojekyll` — skips Jekyll processing on GitHub Pages
- `.github/workflows/pages.yml` — deploys to GitHub Pages on every push to `main`

## Behavior

The source list lives in one array in `assets/app.js`. The hero index and the results grid both render from that array, and the grid wraps to however many entries it contains.

Submitting a full street address creates a session on the API and polls it. Redfin is the only live source. Its card shows the estimate and range when Redfin returns them. Homebot, Zillow, Chase, PennyMac, Homes.com, and Rate.com stay Pending / Coming soon. A blocked lookup says Unavailable. The page does not invent a dollar amount. Nothing is saved in `localStorage`. Refreshing the page clears the address and the results.

`API_BASE` in `assets/app.js` defaults to `https://home-value-api.onrender.com`. Change that one constant if the Render URL is different.

## Deploy the API on Render

`render.yaml` is a Blueprint for a free web service named `home-value-api`, rooted at `api/`. There is no database.

1. Generate a shared secret: `openssl rand -hex 32`
2. In the Render dashboard, choose **New → Blueprint** and connect this GitHub repo.
3. When Render prompts for the empty environment variables, set:
   - `WORKER_URL` to the Fly URL, such as `https://home-value-worker.fly.dev` (no trailing slash)
   - `WORKER_SECRET` to the secret from step 1
4. Apply the Blueprint. Render runs `npm install` and `npm start` in `api/`.
5. Confirm `https://home-value-api.onrender.com/health` returns `{"ok":true}`.

Render sets `RENDER_EXTERNAL_URL` itself. The API uses it as the worker callback base, so you do not set that variable. The free instance sleeps when it is idle. The page says it is waking the server; the first request after sleep can take about a minute.

Deploy the Fly worker first if you want the first Blueprint apply to have a real `WORKER_URL`. You can also add the URL afterward in the Render service's environment.

## Deploy the worker on Fly

The worker is a Playwright/Chromium app. `worker/fly.toml` asks for a `shared-cpu-1x` machine with 1GB of RAM, stops the machine when it is idle, and starts it on the next request. The suggested app name is `home-value-worker`.

From `worker/`:

```bash
cd worker
fly launch --no-deploy --copy-config --name home-value-worker --region dfw
fly secrets set WORKER_SECRET='the-same-secret-you-set-on-render'
fly deploy
```

`fly launch --no-deploy` creates the app without shipping an image yet. `--copy-config` keeps this `fly.toml`. Then set the secret and deploy.

Check `https://home-value-worker.fly.dev/health`.

Only Redfin is scraped, and only through Redfin's public pages. The worker does not sign in or submit a lead form. A captcha or block comes back as Unavailable.

Plain HTTP from this kind of network does not return a Redfin or Zillow estimate (both respond with a block). The browser worker is required; it is not a fit for Render's 512MB web service.

## Deploy the page

Pushes to `main` run the Pages workflow. `actions/configure-pages` is called with `enablement: true`, so Pages can be turned on automatically when the token is permitted to do that.

The expected site is [https://mrvillaflor.github.io/home-value/](https://mrvillaflor.github.io/home-value/).
