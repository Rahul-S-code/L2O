// Starts the server on a spare port with a throwaway storage folder and exercises the API.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ucoh-"));
let srv;

before(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT, DATA_DIR: DIR, ADMIN_USERS: "admin:s3cret", SESSION_SECRET: "test" }, stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/healthz"); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error("server didn't start");
});
after(() => { srv.kill(); fs.rmSync(DIR, { recursive: true, force: true }); });

const json = (method, body, cookie) => ({ method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
async function login() {
  const r = await fetch(BASE + "/api/login", json("POST", { username: "admin", password: "s3cret" }));
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}

test("serves the page and the original datasets", async () => {
  const page = await (await fetch(BASE + "/")).text();
  assert.match(page, /hosted\.js/);
  const plans = await (await fetch(BASE + "/data/tc-plans.json")).json();
  assert.ok(plans.Microsoft && plans.CISCO);
  assert.equal((await fetch(BASE + "/data/world-map.json")).status, 200);
});

test("wrong password is refused and non-admins can't upload", async () => {
  assert.equal((await fetch(BASE + "/api/login", json("POST", { username: "admin", password: "nope" }))).status, 401);
  assert.equal((await fetch(BASE + "/api/datasets/plans", json("PUT", { sheetsJson: "{}", file: "UEs=" }))).status, 403);
  assert.equal((await fetch(BASE + "/api/datasets/plans/file")).status, 403);
  assert.deepEqual(await (await fetch(BASE + "/api/me")).json(), { signedIn: false, user: null, admin: false, adminsConfigured: true, gated: false });
});

test("admin uploads a file, the page data follows, and reset restores the original", async () => {
  const c = await login();
  assert.equal((await (await fetch(BASE + "/api/me", { headers: { cookie: c } })).json()).admin, true);
  const xlsx = fs.readFileSync(path.join(__dirname, "..", "seed", "xlsx", "tc-plans.xlsx"));
  const sheets = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seed", "json", "tc-plans.json"), "utf8"));
  sheets.Microsoft[12][1] = 9.99;
  let r = await fetch(BASE + "/api/datasets/plans", json("PUT", { fileName: "plans v2.xlsx", sheetsJson: JSON.stringify(sheets), file: xlsx.toString("base64") }, c));
  assert.equal(r.status, 200, await r.text());
  assert.equal((await (await fetch(BASE + "/data/tc-plans.json")).json()).Microsoft[12][1], 9.99);
  const meta = await (await fetch(BASE + "/api/datasets/plans")).json();
  assert.equal(meta.uploaded, true); assert.equal(meta.fileName, "plans v2.xlsx"); assert.equal(meta.uploadedBy, "admin");
  const dl = await fetch(BASE + "/api/datasets/plans/file", { headers: { cookie: c } });
  assert.equal(Buffer.from(await dl.arrayBuffer()).equals(xlsx), true);
  // not an Excel file
  r = await fetch(BASE + "/api/datasets/plans", json("PUT", { sheetsJson: JSON.stringify(sheets), file: Buffer.from("hello").toString("base64") }, c));
  assert.equal(r.status, 400);
  r = await fetch(BASE + "/api/datasets/plans", json("DELETE", {}, c));
  assert.equal(r.status, 200);
  assert.equal((await (await fetch(BASE + "/data/tc-plans.json")).json()).Microsoft[12][1], 1.5);
});

test("quotes are saved on the server", async () => {
  const q = { ref: "Q-10501", status: "Draft", sol: "ms", countries: ["GB"], step: 2, updated: "2026-10-13" };
  assert.equal((await fetch(BASE + "/api/quotes/Q-10501", json("PUT", q))).status, 200);
  const all = await (await fetch(BASE + "/api/quotes")).json();
  assert.equal(all.length, 1); assert.equal(all[0].sol, "ms");
  assert.equal((await fetch(BASE + "/api/quotes/../x", json("PUT", q))).status, 404);
});

test("state-changing calls must be JSON", async () => {
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "username=admin&password=s3cret" });
  assert.equal(r.status, 415);
});
