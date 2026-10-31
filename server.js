// UC Order Hub web server.
// Serves the order flow page, the six Excel files from the GitHub repo, admin sign-in, Excel uploads (committed to GitHub)
// and saved quotes. Saved quotes live under DATA_DIR, so mount a persistent disk there to keep them across restarts.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "storage"));
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SECURE_COOKIE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production";
const SESSION_HOURS = 12;

// "alice:pass1,bob:pass2" -> {alice:"pass1", bob:"pass2"}
const ADMINS = Object.fromEntries((process.env.ADMIN_USERS || "").split(",").map(s => s.trim()).filter(Boolean)
  .map(s => { const i = s.indexOf(":"); return [s.slice(0, i).trim(), s.slice(i + 1)]; }).filter(([u, p]) => u && p));
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || "";

// Dataset key (as the page names it) -> file stem (data/<stem>.xlsx in the repo)
const DATASETS = { plans: "tc-plans", anr: "domestic-voice-anr", pricebook: "pricebook-gsip", equipment: "equipment-skus", team: "delivery-team", pops: "tc-pops" };
const MAX_XLSX_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

function writeAtomic(file, text) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };

// ---------- sessions (signed cookie, no server state) ----------
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeToken(user, role) {
  const body = Buffer.from(JSON.stringify({ user, role, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString("base64url");
  return body + "." + sign(body);
}
function readToken(tok) {
  if (!tok || !tok.includes(".")) return null;
  const [body, mac] = tok.split(".");
  const want = sign(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const s = JSON.parse(Buffer.from(body, "base64url").toString()); return s.exp > Date.now() ? s : null; } catch { return null; }
}
const cookie = (req, name) => (req.headers.cookie || "").split(";").map(c => c.trim().split("=")).find(([k]) => k === name)?.[1];
function setSession(res, tok, maxAge) {
  res.setHeader("Set-Cookie", `ucoh=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? "; Secure" : ""}`);
}
const safeEq = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

// ---------- app ----------
const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  req.session = readToken(cookie(req, "ucoh"));
  next();
});
app.use(express.json({ limit: "12mb" }));

// State-changing calls must be JSON, which a cross-site form cannot send; together with SameSite cookies this blocks CSRF.
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && !req.is("application/json")) return res.status(415).json({ error: "Send JSON." });
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/favicon.ico", (req, res) => res.status(204).end());
// On GitHub Pages this file says the site is static; here it says there is a server.
app.get("/hosted-config.js", (req, res) => res.type("js").send('window.UCOH = { mode: "server" };\n'));

// Sign-in
const attempts = new Map();
app.post("/api/login", (req, res) => {
  const ip = req.ip, now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  if (a.length >= 10) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const { username = "", password = "" } = req.body || {};
  let role = null;
  if (username && ADMINS[username] !== undefined && safeEq(password, ADMINS[username])) role = "admin";
  else if (!username && VIEWER_PASSWORD && safeEq(password, VIEWER_PASSWORD)) role = "viewer";
  if (!role) { a.push(now); attempts.set(ip, a); return res.status(401).json({ error: "That sign-in didn't work." }); }
  attempts.delete(ip);
  setSession(res, makeToken(username || "viewer", role), SESSION_HOURS * 3600);
  res.json({ ok: true, role });
});
app.post("/api/logout", (req, res) => { setSession(res, "", 0); res.json({ ok: true }); });
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/login.css", (req, res) => res.sendFile(path.join(__dirname, "public", "login.css")));

// Optional site-wide gate: with VIEWER_PASSWORD set, nobody sees the app or its data without signing in.
app.use((req, res, next) => {
  if (!VIEWER_PASSWORD || req.session) return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/data/")) return res.status(401).json({ error: "Sign in first." });
  res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
});

const isAdmin = req => !!req.session && req.session.role === "admin";
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(403).json({ error: "Only admins can do this. Sign in as an admin." });

app.get("/api/me", (req, res) => res.json({
  signedIn: !!req.session, user: req.session?.user || null, admin: isAdmin(req),
  adminsConfigured: Object.keys(ADMINS).length > 0, gated: !!VIEWER_PASSWORD
}));

// ---------- datasets: the Excel files in the GitHub repo ----------
// The app reads data/<stem>.xlsx from GitHub and nothing else. The browser parses each workbook with the same
// SheetJS code the prototype uses. An admin upload is committed to GitHub as a new version of the file.
const GH_API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const GH_REPO = process.env.GITHUB_REPO || "Rahul-S-code/L2O";
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_DIR = (process.env.GITHUB_DATA_PATH || "data").replace(/^\/|\/$/g, "");
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
// Without a token GitHub allows 60 requests an hour, so check for changes less often.
const CHECK_MS = 1000 * (+process.env.GITHUB_CHECK_SECONDS || (GH_TOKEN ? 30 : 120));

async function gh(pathname, { method = "GET", body, raw } = {}) {
  const r = await fetch(GH_API + pathname, {
    method,
    headers: {
      Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
      "User-Agent": "uc-order-hub", "X-GitHub-Api-Version": "2022-11-28",
      ...(GH_TOKEN ? { Authorization: "Bearer " + GH_TOKEN } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = new Error(`GitHub ${method} ${pathname}: ${r.status} ${j.message || ""}`.trim()); e.status = r.status; throw e;
  }
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
const repoPath = `/repos/${GH_REPO}`;
const fileName = key => DATASETS[key] + ".xlsx";

// stem -> {sha, buf}; refreshed from one directory listing, files re-downloaded only when their sha changes.
const cache = new Map();
let checkedAt = 0, checking = null;
function refresh(force) {
  if (!force && Date.now() - checkedAt < CHECK_MS && cache.size) return Promise.resolve();
  if (checking) return checking;
  checking = (async () => {
    const list = await gh(`${repoPath}/contents/${GH_DIR}?ref=${encodeURIComponent(GH_BRANCH)}`);
    for (const key of Object.keys(DATASETS)) {
      const f = list.find(x => x.type === "file" && x.name === fileName(key));
      if (!f) { cache.delete(key); continue; }
      if (cache.get(key)?.sha === f.sha) continue;
      cache.set(key, { sha: f.sha, buf: await gh(`${repoPath}/git/blobs/${f.sha}`, { raw: true }) });
    }
    checkedAt = Date.now();
  })().catch(e => { console.error("[github]", e.message); if (!cache.size) throw e; }).finally(() => { checking = null; });
  return checking;
}

const validKey = (req, res, next) => DATASETS[req.params.key] ? next() : res.status(404).json({ error: "Unknown dataset." });
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// The page asks for data/<stem>.xlsx (hosted.js turns it into the sheets the page expects).
for (const [key, stem] of Object.entries(DATASETS)) {
  app.get(`/data/${stem}.xlsx`, async (req, res) => {
    try { await refresh(); } catch (e) { return res.status(502).json({ error: "Couldn't read the Excel files from GitHub." }); }
    const f = cache.get(key);
    if (!f) return res.status(404).json({ error: `${GH_DIR}/${stem}.xlsx isn't in ${GH_REPO} (${GH_BRANCH}).` });
    res.setHeader("Cache-Control", "no-store");
    if (req.query.download !== undefined) res.attachment(stem + ".xlsx");
    res.type(XLSX_TYPE).send(f.buf);
  });
}

// Where each file comes from and when it last changed, for the Data files page.
let historyCache = { at: 0, list: null };
app.get("/api/datasets", async (req, res) => {
  if (!historyCache.list || Date.now() - historyCache.at > 5 * 60e3) {
    historyCache = { at: Date.now(), list: await Promise.all(Object.keys(DATASETS).map(async key => {
      const p = `${GH_DIR}/${fileName(key)}`;
      const c = await gh(`${repoPath}/commits?path=${encodeURIComponent(p)}&sha=${encodeURIComponent(GH_BRANCH)}&per_page=1`).catch(() => []);
      return { key, path: p, url: `https://github.com/${GH_REPO}/blob/${GH_BRANCH}/${p}`, historyUrl: `https://github.com/${GH_REPO}/commits/${GH_BRANCH}/${p}`,
        changedAt: c[0]?.commit?.committer?.date || null, message: c[0]?.commit?.message || null };
    })) };
  }
  res.json({ repo: GH_REPO, branch: GH_BRANCH, canWrite: !!GH_TOKEN, files: historyCache.list });
});

// An admin upload becomes a commit to the file in GitHub.
app.put("/api/datasets/:key", validKey, requireAdmin, async (req, res) => {
  if (!GH_TOKEN) return res.status(503).json({ error: `Uploading needs a GitHub token on the server. For now, upload the file to ${GH_DIR}/ in ${GH_REPO} on GitHub.` });
  const key = req.params.key, buf = Buffer.from(String((req.body || {}).file || ""), "base64");
  if (!buf.length || buf.length > MAX_XLSX_BYTES) return res.status(400).json({ error: "Attach the Excel file (5 MB at most)." });
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return res.status(400).json({ error: "Save the file as .xlsx and upload it again." });
  try {
    await refresh(true);
    const p = `${GH_DIR}/${fileName(key)}`, from = String(req.body.fileName || "").replace(/[^\w .()-]+/g, "_").slice(0, 120);
    const out = await gh(`${repoPath}/contents/${p}`, { method: "PUT", body: {
      message: `Update ${fileName(key)} from the UC Order Hub (uploaded by ${req.session.user}${from ? ", file " + from : ""})`,
      content: buf.toString("base64"), branch: GH_BRANCH, ...(cache.get(key) ? { sha: cache.get(key).sha } : {})
    } });
    cache.set(key, { sha: out.content.sha, buf }); historyCache.at = 0;
    console.log(`[dataset] ${p} committed to ${GH_REPO} by ${req.session.user}`);
    res.json({ ok: true, commit: out.commit.html_url });
  } catch (e) {
    console.error("[github]", e.message);
    res.status(502).json({ error: e.status === 409 ? "The file changed in GitHub meanwhile. Reload the page and upload again." : "GitHub didn't accept the file: " + e.message });
  }
});

// ---------- saved quotes (shared by everyone using this site) ----------
const QUOTES = path.join(DATA_DIR, "quotes.json");
app.get("/api/quotes", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.json(readJSON(QUOTES, [])); });
app.put("/api/quotes/:ref", (req, res) => {
  const ref = req.params.ref, q = req.body;
  if (!/^[A-Z]-?\d{1,8}$/.test(ref) || !q || q.ref !== ref) return res.status(400).json({ error: "Bad quote reference." });
  if (JSON.stringify(q).length > 1024 * 1024) return res.status(413).json({ error: "Quote too large." });
  const all = readJSON(QUOTES, []), i = all.findIndex(x => x.ref === ref);
  q.savedBy = req.session?.user || null; q.savedAt = new Date().toISOString();
  if (i >= 0) all[i] = q; else all.unshift(q);
  writeAtomic(QUOTES, JSON.stringify(all));
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public"), { index: "index.html", extensions: ["html"] }));
app.use((err, req, res, next) => { console.error(err); res.status(err.status || 500).json({ error: err.type === "entity.too.large" ? "File too large." : "Server error." }); });

app.listen(PORT, () => {
  console.log(`UC Order Hub on port ${PORT}, storage in ${DATA_DIR}`);
  if (!Object.keys(ADMINS).length) console.warn("No ADMIN_USERS set: nobody can upload Excel files.");
  if (!process.env.SESSION_SECRET) console.warn("No SESSION_SECRET set: sign-ins end whenever the server restarts.");
  console.log(`Excel files from ${GH_REPO}@${GH_BRANCH}/${GH_DIR}` + (GH_TOKEN ? "" : " (no GITHUB_TOKEN: read-only, public repo only)"));
  refresh(true).catch(() => {});
});
