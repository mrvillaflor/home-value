# Home value

Static draft of a public home-value page for Matthew Villaflor, SERHANT. Texas (Serhant Texas, LLC, license TX 717893).

There is no build step. Host this repository root as a static site (GitHub Pages, Render, Cloudflare Pages, or any other file host).

## Structure

- `index.html` — page
- `assets/styles.css` — layout and the SERHANT palette (`#001A72`, `#F7F7F7`, `#FFFFFF`, champagne `#D2A984`, hover `#002FCF`)
- `assets/app.js` — the `SOURCES` array and the `fetchEstimates(address)` stub
- `assets/mv-logo-black.png` — MV monogram for light backgrounds (original line art)
- `assets/mv-logo-white.png` — the same monogram, with opaque pixels recolored white and alpha left unchanged
- `assets/matthew-villaflor.png` — agent photo, 300×300
- `assets/fonts/` — self-hosted Newsreader and Outfit (SIL Open Font License)
- `.nojekyll` — skips Jekyll processing on GitHub Pages
- `.github/workflows/pages.yml` — deploys to GitHub Pages on every push to `main`

## Behavior

The source list lives in one array in `assets/app.js`. The hero index and the results grid both render from that array, and the grid wraps to however many entries it contains.

Submitting a full street address shows a loading state, then a Pending / Coming soon placeholder on every source. The page does not display dollar amounts. Nothing is saved in `localStorage`. Refreshing the page clears the address and the results.

`fetchEstimates(address)` is where a future Render service plugs in: create a session, then poll that session for each source. Until then the function resolves placeholders and does not call the network.

## Deploy

Pushes to `main` run the Pages workflow. `actions/configure-pages` is called with `enablement: true`, so Pages can be turned on automatically when the token is permitted to do that.

The expected site is [https://mrvillaflor.github.io/home-value/](https://mrvillaflor.github.io/home-value/).
