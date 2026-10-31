// A stand-in for the parts of the GitHub API the server uses, backed by the Excel files in ../data.
// Run directly for browser testing: node test/fake-github.js <port>
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function fakeGitHub({ repo = "acme/l2o", branch = "main", token = "test-token" } = {}) {
  const files = new Map(), commits = [];
  const dir = path.join(__dirname, "..", "data");
  for (const n of fs.readdirSync(dir).filter(n => n.endsWith(".xlsx"))) files.set(n, fs.readFileSync(path.join(dir, n)));
  const sha = buf => crypto.createHash("sha1").update(buf).digest("hex");
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), send = (code, body, raw) => { res.writeHead(code, { "Content-Type": raw ? "application/octet-stream" : "application/json" }); res.end(raw ? body : JSON.stringify(body)); };
    const pre = `/repos/${repo}`;
    if (!u.pathname.startsWith(pre)) return send(404, { message: "Not Found" });
    const p = u.pathname.slice(pre.length);
    if (req.method === "GET" && p === "/contents/data" && u.searchParams.get("ref") === branch)
      return send(200, [...files].map(([name, buf]) => ({ type: "file", name, path: "data/" + name, sha: sha(buf) })));
    if (req.method === "GET" && p.startsWith("/git/blobs/")) {
      const hit = [...files.values()].find(b => sha(b) === p.split("/").pop());
      return hit ? send(200, hit, true) : send(404, { message: "Not Found" });
    }
    if (req.method === "GET" && p === "/commits") {
      const c = commits.filter(x => x.path === u.searchParams.get("path")).slice(-1);
      return send(200, c.map(x => ({ commit: { message: x.message, committer: { date: x.date } } })));
    }
    const m = p.match(/^\/contents\/data\/([\w.-]+\.xlsx)$/);
    if (req.method === "PUT" && m) {
      if (req.headers.authorization !== "Bearer " + token) return send(401, { message: "Bad credentials" });
      let body = ""; req.on("data", d => (body += d)); req.on("end", () => {
        const b = JSON.parse(body), cur = files.get(m[1]);
        if (b.branch !== branch) return send(422, { message: "wrong branch" });
        if (cur && b.sha !== sha(cur)) return send(409, { message: "sha does not match" });
        const buf = Buffer.from(b.content, "base64"); files.set(m[1], buf);
        commits.push({ path: "data/" + m[1], message: b.message, date: new Date().toISOString() });
        send(200, { content: { sha: sha(buf) }, commit: { html_url: `https://github.com/${repo}/commit/${commits.length}` } });
      });
      return;
    }
    send(404, { message: "Not Found" });
  });
  return { server, files, commits, repo, branch, token };
}
module.exports = { fakeGitHub };

if (require.main === module) {
  const g = fakeGitHub();
  g.server.listen(+process.argv[2] || 3999, () => console.log(`fake GitHub for ${g.repo} on port ${+process.argv[2] || 3999}, token ${g.token}`));
}
