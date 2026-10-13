// UC Order Hub web server.
// Serves the order flow page, the six Excel-driven datasets, admin sign-in, Excel uploads and saved quotes.
// Everything that changes at runtime lives under DATA_DIR, so mount a persistent disk there.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "storage"));
const SEED = path.join(__dirname, "seed");
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SECURE_COOKIE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : process.env.NODE_ENV === "production";
const SESSION_HOURS = 12;

// "alice:pass1,bob:pass2" -> {alice:"pass1", bob:"pass2"}
const ADMINS = Object.fromEntries((process.env.ADMIN_USERS || "").split(",").map(s => s.trim()).filter(Boolean)
  .map(s => { const i = s.indexOf(":"); return [s.slice(0, i).trim(), s.slice(i + 1)]; }).filter(([u, p]) => u && p));
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || "";

// Dataset key (as the page names it) -> file stem (as the page fetches it: data/<stem>.json)
const DATASETS = { plans: "tc-plans", anr: "domestic-voice-anr", pricebook: "pricebook-gsip", equipment: "equipment-skus", team: "delivery-team", pops: "tc-pops" };
const MAX_XLSX_BYTES = 5 * 1024 * 1024;
const MAX_SHEETS_JSON = 2 * 1024 * 1024;

fs.mkdirSync(path.join(DATA_DIR, "datasets"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });

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

// ---------- datasets ----------
const metaFile = key => path.join(DATA_DIR, "datasets", key + ".json");
const validKey = (req, res, next) => DATASETS[req.params.key] ? next() : res.status(404).json({ error: "Unknown dataset." });
function currentSheetsJson(key) {
  const m = readJSON(metaFile(key), null);
  return m ? m.sheetsJson : fs.readFileSync(path.join(SEED, "json", DATASETS[key] + ".json"), "utf8");
}

// The page fetches data/<stem>.json; serve the uploaded copy when there is one, else the original.
for (const [key, stem] of Object.entries(DATASETS)) {
  app.get(`/data/${stem}.json`, (req, res) => { res.setHeader("Cache-Control", "no-store"); res.type("json").send(currentSheetsJson(key)); });
}

app.get("/api/datasets", (req, res) => res.json(Object.keys(DATASETS).map(key => {
  const m = readJSON(metaFile(key), null);
  return { key, uploaded: !!m, fileName: m?.fileName || DATASETS[key] + ".xlsx", uploadedAt: m?.uploadedAt || null, uploadedBy: m?.uploadedBy || null };
})));

app.get("/api/datasets/:key", validKey, (req, res) => {
  const m = readJSON(metaFile(req.params.key), null);
  res.setHeader("Cache-Control", "no-store");
  res.json(m ? { uploaded: true, fileName: m.fileName, uploadedAt: m.uploadedAt, uploadedBy: m.uploadedBy, sheetsJson: m.sheetsJson } : { uploaded: false });
});

// Download the Excel file currently in use, so an admin can edit it and upload it again.
app.get("/api/datasets/:key/file", validKey, requireAdmin, (req, res) => {
  const key = req.params.key, m = readJSON(metaFile(key), null);
  const file = m ? path.join(DATA_DIR, "uploads", m.stored) : path.join(SEED, "xlsx", DATASETS[key] + ".xlsx");
  res.download(file, m ? m.fileName : DATASETS[key] + ".xlsx");
});

const isSheets = o => o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every(rows =>
  Array.isArray(rows) && rows.every(r => Array.isArray(r) && r.every(c => c === null || ["string", "number", "boolean"].includes(typeof c))));

// The browser reads and checks the workbook (same parser the page uses), then sends the parsed sheets plus the original file.
app.put("/api/datasets/:key", validKey, requireAdmin, (req, res) => {
  const key = req.params.key, { fileName, sheetsJson, file } = req.body || {};
  if (typeof sheetsJson !== "string" || sheetsJson.length > MAX_SHEETS_JSON) return res.status(400).json({ error: "Missing or oversized sheet data." });
  let sheets; try { sheets = JSON.parse(sheetsJson); } catch { return res.status(400).json({ error: "Sheet data isn't valid JSON." }); }
  if (!isSheets(sheets)) return res.status(400).json({ error: "Sheet data has an unexpected shape." });
  const buf = Buffer.from(String(file || ""), "base64");
  if (!buf.length || buf.length > MAX_XLSX_BYTES) return res.status(400).json({ error: "Attach the Excel file (5 MB at most)." });
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b, isOle = buf.readUInt32BE(0) === 0xd0cf11e0;
  if (!isZip && !isOle) return res.status(400).json({ error: "That doesn't look like an Excel file." });
  const name = String(fileName || DATASETS[key] + ".xlsx").replace(/[^\w .()-]+/g, "_").slice(0, 120);
  const uploadedAt = new Date().toISOString();
  // Every upload is kept, so an earlier version can be recovered from the disk.
  const stored = `${key}-${uploadedAt.replace(/[:.]/g, "-")}${isZip ? ".xlsx" : ".xls"}`;
  fs.writeFileSync(path.join(DATA_DIR, "uploads", stored), buf);
  writeAtomic(metaFile(key), JSON.stringify({ fileName: name, uploadedAt, uploadedBy: req.session.user, stored, sheetsJson }));
  console.log(`[dataset] ${key} replaced with ${name} by ${req.session.user}`);
  res.json({ ok: true, fileName: name, uploadedAt });
});

// Go back to the original file (uploaded copies stay on disk).
app.delete("/api/datasets/:key", validKey, requireAdmin, (req, res) => {
  try { fs.unlinkSync(metaFile(req.params.key)); } catch {}
  console.log(`[dataset] ${req.params.key} reset to original by ${req.session.user}`);
  res.json({ ok: true });
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
});
