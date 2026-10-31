// Starts the server on a spare port, pointed at a stand-in GitHub, and exercises the API.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fakeGitHub } = require("./fake-github");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ucoh-"));
let srv;
const GH = fakeGitHub(), GH_PORT = PORT + 100;

before(async () => {
  await new Promise(r => GH.server.listen(GH_PORT, "127.0.0.1", r));
  srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT, DATA_DIR: DIR, ADMIN_USERS: "admin:s3cret", SESSION_SECRET: "test",
      GITHUB_API_URL: `http://127.0.0.1:${GH_PORT}`, GITHUB_REPO: GH.repo, GITHUB_TOKEN: GH.token, GITHUB_CHECK_SECONDS: "1" }, stdio: "ignore"
  });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/healthz"); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error("server didn't start");
});
after(() => { srv.kill(); GH.server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

const json = (method, body, cookie) => ({ method, headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
async function login() {
  const r = await fetch(BASE + "/api/login", json("POST", { username: "admin", password: "s3cret" }));
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}

const plansXlsx = () => fs.readFileSync(path.join(__dirname, "..", "data", "tc-plans.xlsx"));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test("serves the page and the Excel files from GitHub", async () => {
  const page = await (await fetch(BASE + "/")).text();
  assert.match(page, /hosted\.js/);
  const r = await fetch(BASE + "/data/tc-plans.xlsx");
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(plansXlsx()));
  assert.equal((await fetch(BASE + "/data/tc-plans.json")).status, 404); // no JSON copies any more
  assert.equal((await fetch(BASE + "/data/world-map.json")).status, 200);
  const info = await (await fetch(BASE + "/api/datasets")).json();
  assert.equal(info.repo, GH.repo); assert.equal(info.files.length, 6); assert.equal(info.canWrite, true);
});

test("a change made directly in GitHub reaches the app", async () => {
  const changed = Buffer.concat([plansXlsx(), Buffer.from("x")]);
  GH.files.set("tc-pops.xlsx", changed);
  await sleep(1200);
  assert.ok(Buffer.from(await (await fetch(BASE + "/data/tc-pops.xlsx")).arrayBuffer()).equals(changed));
});

test("wrong password is refused and non-admins can't upload", async () => {
  assert.equal((await fetch(BASE + "/api/login", json("POST", { username: "admin", password: "nope" }))).status, 401);
  assert.equal((await fetch(BASE + "/api/datasets/plans", json("PUT", { file: "UEs=" }))).status, 403);
  assert.deepEqual(await (await fetch(BASE + "/api/me")).json(), { signedIn: false, user: null, admin: false, adminsConfigured: true, gated: false });
});

test("an admin upload is committed to GitHub and served from there", async () => {
  const c = await login();
  const v2 = Buffer.concat([plansXlsx(), Buffer.from("v2")]);
  let r = await fetch(BASE + "/api/datasets/plans", json("PUT", { fileName: "plans v2.xlsx", file: v2.toString("base64") }, c));
  assert.equal(r.status, 200, await r.text());
  assert.ok(GH.files.get("tc-plans.xlsx").equals(v2));
  assert.match(GH.commits.at(-1).message, /tc-plans\.xlsx.*uploaded by admin.*plans v2\.xlsx/);
  assert.ok(Buffer.from(await (await fetch(BASE + "/data/tc-plans.xlsx")).arrayBuffer()).equals(v2));
  // not an Excel file
  r = await fetch(BASE + "/api/datasets/plans", json("PUT", { file: Buffer.from("hello").toString("base64") }, c));
  assert.equal(r.status, 400);
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
