# UC Order Hub

The UC lead-to-order flow (GSIP, Microsoft, Cisco, Zoom) as its own website. Countries, plans and prices come from six Excel files. Admins sign in and upload a new version of any file on the **Data files** page; everyone using the site picks it up straight away.

## What the site does

- **Order flow, coverage map, quotes**: the same page as the claude.ai prototype (`public/index.html`).
- **Excel files online**: the original files ship in `seed/`. An admin upload is stored on the server's disk and replaces the original for everyone. Every uploaded file is kept, and "Go back to the original file" restores the shipped copy.
- **Admin sign-in**: admins can upload files and download the file currently in use, edit it in Excel, and upload it again.
- **Saved quotes**: "Save as quote" stores the quote on the server, shared by everyone on the site.
- **Optional team password**: set `VIEWER_PASSWORD` and nobody can see the site or its prices without signing in.

## Settings (environment variables)

| Variable | Needed | What it does |
|---|---|---|
| `ADMIN_USERS` | yes | Admin sign-ins as `name:password`, comma separated, e.g. `rahul:long-password,priya:another-one` |
| `SESSION_SECRET` | yes | Any long random string; keeps people signed in across restarts |
| `DATA_DIR` | yes in hosting | Folder for uploads and quotes; put it on a persistent disk (`/data` in Docker) |
| `VIEWER_PASSWORD` | no | Team password for everyone who isn't an admin. Leave empty to keep the site open |
| `PORT` | no | Defaults to 3000 |

## Run it on your computer

```
npm install
ADMIN_USERS=admin:change-me SESSION_SECRET=dev npm start
```

Open http://localhost:3000 and use **Admin sign in** in the menu. `npm test` runs the API tests.

## Deploy

The site is one small Node.js server plus a folder on disk, so it runs anywhere that runs Docker.

- **Render** (simplest): connect this repo, Render reads `render.yaml`, and you fill in `ADMIN_USERS` (and `VIEWER_PASSWORD` if wanted). It needs the Starter plan for the persistent disk.
- **Azure App Service** (if company hosting is required): create a Linux Web App for Containers from this Dockerfile, add an Azure Files share mounted at `/data`, and set the variables above under Configuration.
- **Any VM**: `docker build -t uc-order-hub . && docker run -d -p 80:3000 -v ucoh-data:/data -e ADMIN_USERS=... -e SESSION_SECRET=... uc-order-hub`, behind HTTPS.

Always serve it over HTTPS; sign-in cookies are marked Secure in production.

## Updating the order flow from the prototype

The prototype keeps evolving on claude.ai. To bring a new version across, save the artifact's `index.html` and run:

```
node scripts/import-page.js path/to/artifact-index.html
```

The script swaps the two CDN libraries for the local copies in `public/vendor/` and adds `public/hosted.js`, which gives the page this server's storage, sign-in and downloads in place of the claude.ai ones. If the prototype adds a new Excel file, add it to `DATASETS` in `server.js` and put the original in `seed/json` and `seed/xlsx`.

## Layout

```
server.js           web server: datasets, sign-in, uploads, quotes
public/index.html   the order flow page (from the prototype)
public/hosted.js    connects the page to this server
public/login.html   sign-in page
public/vendor/      SheetJS 0.18.5 and ExcelJS 4.4.0
seed/json, seed/xlsx  original data files
```
