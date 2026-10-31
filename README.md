# UC Order Hub

**Live site: https://rahul-s-code.github.io/L2O/**

The UC lead-to-order flow (GSIP, Microsoft, Cisco, Zoom) as its own website. Countries, plans and prices come from the six Excel files in [`data/`](data) in this repository, and the app reads them from GitHub only. Change a file here (edit and commit, or upload it on GitHub) and the site picks it up within a couple of minutes. Admins can also upload a new version on the site's **Data files** page, which commits it to this repository.

## What the site does

- **Order flow, coverage map, quotes**: the same page as the claude.ai prototype (`public/index.html`).
- **Excel files in GitHub**: `data/*.xlsx` in this repository is the only source. The server checks GitHub for changes (every 30 seconds with a token, every 2 minutes without) and the browser reads each workbook with the same SheetJS code as the prototype.
- **Admin uploads go to GitHub**: an upload on the Data files page becomes a commit to the file in `data/`, so GitHub keeps the full history. To go back to an earlier version, restore it from the file's history in GitHub.
- **Admin sign-in**: admins sign in to upload. Anyone can download the file in use and open its history in GitHub.
- **Saved quotes**: "Save as quote" stores the quote on the server, shared by everyone on the site.
- **Optional team password**: set `VIEWER_PASSWORD` and nobody can see the site or its prices without signing in.

## The free website (GitHub Pages)

Every push to `main` publishes the site to GitHub Pages (`.github/workflows/pages.yml`), at https://rahul-s-code.github.io/L2O/. It's the same order flow, coverage map and Excel quote download, reading the Excel files in `data/` from that commit. It has no server, so:

- Change prices by editing an Excel file in `data/` on GitHub and committing it; the site updates a minute or two later.
- There's no admin sign-in or upload page.
- Saved quotes stay in each person's own browser.

One-time setup: **Settings > Pages > Build and deployment > Source: GitHub Actions**.

The server version below adds sign-in, uploads from the site and shared quotes, for when you want those.

## Settings (environment variables)

| Variable | Needed | What it does |
|---|---|---|
| `ADMIN_USERS` | yes | Admin sign-ins as `name:password`, comma separated, e.g. `rahul:long-password,priya:another-one` |
| `SESSION_SECRET` | yes | Any long random string; keeps people signed in across restarts |
| `GITHUB_REPO` | no | Repository holding the Excel files. Defaults to `Rahul-S-code/L2O` |
| `GITHUB_BRANCH` | no | Defaults to `main` |
| `GITHUB_DATA_PATH` | no | Folder in the repository. Defaults to `data` |
| `GITHUB_TOKEN` | for uploads, or if the repo is private | Fine-grained token for this repository only, with **Contents: read and write**. Without it the site reads a public repo and admins upload in GitHub instead |
| `DATA_DIR` | yes in hosting | Folder for saved quotes; put it on a persistent disk (`/data` in Docker) |
| `VIEWER_PASSWORD` | no | Team password for everyone who isn't an admin. Leave empty to keep the site open |
| `PORT` | no | Defaults to 3000 |

## Run it on your computer

```
npm install
ADMIN_USERS=admin:change-me SESSION_SECRET=dev npm start
```

Open http://localhost:3000 and use **Admin sign in** in the menu. Add `GITHUB_TOKEN=...` to try uploads. `npm test` runs the API tests against a stand-in GitHub (`test/fake-github.js`).

## Deploy

The site is one small Node.js server plus a folder on disk, so it runs anywhere that runs Docker.

- **Render** (simplest): connect this repo, Render reads `render.yaml`, and you fill in `ADMIN_USERS`, `GITHUB_TOKEN` (and `VIEWER_PASSWORD` if wanted). It needs the Starter plan for the persistent disk that keeps saved quotes.
- **Azure App Service** (if company hosting is required): create a Linux Web App for Containers from this Dockerfile, add an Azure Files share mounted at `/data`, and set the variables above under Configuration.
- **Any VM**: `docker build -t uc-order-hub . && docker run -d -p 80:3000 -v ucoh-data:/data -e ADMIN_USERS=... -e SESSION_SECRET=... uc-order-hub`, behind HTTPS.

Always serve it over HTTPS; sign-in cookies are marked Secure in production.

## Updating the order flow from the prototype

The prototype keeps evolving on claude.ai. To bring a new version across, save the artifact's `index.html` and run:

```
node scripts/import-page.js path/to/artifact-index.html
```

The script swaps the two CDN libraries for the local copies in `public/vendor/` and adds `public/hosted.js`, which reads the Excel files from GitHub and gives the page this server's sign-in, uploads and downloads in place of the claude.ai ones. If the prototype adds a new Excel file, add the file to `data/`, its name to `DATASETS` in `server.js`, and its stem to `STEM` and `KEYS` in `public/hosted.js`.

## Layout

```
data/*.xlsx         the Excel files the app reads (from GitHub)
server.js           web server: Excel files from GitHub, sign-in, uploads, quotes
public/index.html   the order flow page (from the prototype)
public/hosted.js    connects the page to this server (or runs it static on Pages) and parses the Excel files
.github/workflows/  publishes the static site to GitHub Pages
public/login.html   sign-in page
public/vendor/      SheetJS 0.18.5 and ExcelJS 4.4.0
test/               API tests and a stand-in GitHub
```
