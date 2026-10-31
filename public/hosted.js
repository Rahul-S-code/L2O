// Hosted mode for the UC Order Hub page.
// The page was built as a claude.ai artifact and asks for its services through window.claude.use(...).
// This file provides the same services backed by this site's server, so index.html can stay identical to the artifact:
//   fetch     -> the page's data/<name>.json requests read data/<name>.xlsx (the Excel files in the GitHub repo)
//                and parse them with the same SheetJS call the page uses
//   db        -> an admin upload is committed to the Excel file in GitHub
//   user      -> canEdit() is true for a signed-in admin
//   downloads -> save() downloads the file in the browser
// Saved quotes (localStorage "ucoh.quotes.v3" in the artifact) are kept on the server and shared by everyone.
(function () {
  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  }
  let me = { admin: false };
  const meReady = api("GET", "/api/me").then(j => (me = j)).catch(() => me);

  // ---------- Excel files from GitHub ----------
  const KEYS = ["plans", "anr", "pricebook", "equipment", "team", "pops"]; // same order as DATASETS in the page
  const STEM = /(?:^|\/)data\/(tc-plans|domestic-voice-anr|pricebook-gsip|equipment-skus|delivery-team|tc-pops)\.json$/;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const m = String(typeof input === "string" ? input : input && input.url).match(STEM);
    if (!m) return realFetch(input, init);
    const r = await realFetch(`data/${m[1]}.xlsx`, { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) return r;
    const wb = XLSX.read(await r.arrayBuffer()), sheets = {};
    wb.SheetNames.forEach(n => { sheets[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: false }); });
    return new Response(JSON.stringify(sheets), { headers: { "Content-Type": "application/json" } });
  };
  let gh = null;
  const savedTo = {};
  const loadGh = () => api("GET", "/api/datasets").then(j => { gh = j; decorateData(); }).catch(() => {});

  // The page parses the chosen workbook itself; remember the original file so it can be committed to GitHub.
  const picked = {};
  document.addEventListener("change", e => {
    const i = e.target;
    if (i && i.type === "file" && i.dataset && i.dataset.key && i.files && i.files[0]) picked[i.dataset.key] = i.files[0];
  }, true);
  async function base64(file) {
    const b = new Uint8Array(await file.arrayBuffer());
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  const db = {
    doc(p) {
      const key = String(p).split("/")[1];
      return {
        // GitHub is the only copy, so there is never a separate "uploaded" version to read.
        async get() { return { exists: false, data: () => ({}) }; },
        async set(d) {
          const f = picked[key];
          if (!f) throw new Error("Choose the Excel file again.");
          await api("PUT", "/api/datasets/" + key, { fileName: d.fileName || f.name, file: await base64(f) });
          await loadGh();
          savedTo[key] = true;
        },
        async delete() { throw new Error("To go back to an earlier version, restore it from the file's history in GitHub."); }
      };
    }
  };
  const user = { async canEdit() { await meReady; return !!me.admin; } };
  const downloads = {
    async save({ filename, data }) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      a.download = filename || "download";
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  };
  window.claude = { use: async name => ({ db, user, downloads })[name] || null };

  // ---------- saved quotes on the server ----------
  const QK = "ucoh.quotes.v3";
  let quotes = [], pulledAt = 0;
  function pull() {
    // Synchronous on purpose: the page reads saved quotes synchronously. Refreshed at most every 2 seconds.
    if (Date.now() - pulledAt < 2000) return;
    try {
      const x = new XMLHttpRequest();
      x.open("GET", "/api/quotes", false); x.send();
      if (x.status === 200) { quotes = JSON.parse(x.responseText); pulledAt = Date.now(); }
    } catch (e) { console.warn("Couldn't load saved quotes", e); }
  }
  const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem;
  let local = null; try { local = window.localStorage; } catch (e) {}
  Storage.prototype.getItem = function (k) {
    if (this === local && k === QK) { pull(); return JSON.stringify(quotes); }
    return getItem.call(this, k);
  };
  Storage.prototype.setItem = function (k, v) {
    if (this === local && k === QK) {
      const next = JSON.parse(v), before = new Map(quotes.map(q => [q.ref, JSON.stringify(q)]));
      quotes = next;
      next.forEach(q => {
        if (before.get(q.ref) !== JSON.stringify(q))
          api("PUT", "/api/quotes/" + encodeURIComponent(q.ref), q).catch(e => alert("The quote couldn't be saved to the server: " + e.message));
      });
      return;
    }
    return setItem.call(this, k, v);
  };

  // ---------- small additions to the page ----------
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function addSignIn() {
    const menu = document.getElementById("menu"); if (!menu) return;
    const a = document.createElement("a");
    if (me.admin) {
      a.href = "#"; a.textContent = `Sign out (${me.user})`;
      a.onclick = async e => { e.preventDefault(); await api("POST", "/api/logout", {}); location.reload(); };
    } else {
      a.href = "/login?next=" + encodeURIComponent("/" + location.hash); a.textContent = "Admin sign in";
    }
    a.dataset.hosted = "1";
    menu.insertBefore(a, menu.querySelector("a.btn"));
  }
  // Data files page: show that each file is read from GitHub, with download and history links.
  function decorateData() {
    const v = document.getElementById("v-data"); if (!v) return;
    v.querySelectorAll("p.fine").forEach(p => {
      if (/^Only editors of this page/.test(p.textContent)) p.innerHTML = `Only admins can replace files. <a href="/login?next=${encodeURIComponent("/#data")}">Sign in as an admin</a>.`;
      if (/^Uploading is unavailable/.test(p.textContent)) p.remove();
    });
    v.querySelectorAll("[data-reset]").forEach(b => b.remove());
    if (!gh) return;
    v.querySelectorAll(".panel.ds").forEach((panel, i) => {
      const f = gh.files.find(x => x.key === KEYS[i]); if (!f) return;
      const pill = panel.querySelector(".dsh .pill");
      if (pill) { pill.className = "pill ok"; pill.textContent = "In GitHub"; }
      const using = [...panel.querySelectorAll("p.fine")].find(p => /^(Using|Sheets:)/.test(p.textContent.trim()));
      if (using && !using.dataset.gh) {
        const sheets = (using.textContent.match(/Sheets:.*$/) || [""])[0];
        const when = f.changedAt ? `, last changed ${new Date(f.changedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : "";
        using.innerHTML = `Read from <a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.path)}</a> in ${esc(gh.repo)}${when}. ${esc(sheets)}`;
        using.dataset.gh = "1";
      }
      const msg = panel.querySelector(".dsmsg.ok");
      if (msg && savedTo[f.key] && /^Updated from/.test(msg.textContent) && !/GitHub/.test(msg.textContent)) msg.textContent += " Saved to GitHub as a new version.";
      let box = panel.querySelector(".dsa");
      if (!box) { panel.querySelector(".dsmsg").insertAdjacentHTML("beforebegin", '<div class="dsa"></div>'); box = panel.querySelector(".dsa"); }
      if (me.admin && !gh.canWrite) box.querySelectorAll("label.up").forEach(l => l.remove());
      if (!box.querySelector("[data-dl]")) box.insertAdjacentHTML("beforeend",
        `<a class="act" data-dl="1" href="/${esc(f.path.replace(/^.*\//, "data/"))}?download">Download the Excel file</a>` +
        `<a class="act" href="${esc(f.historyUrl)}" target="_blank" rel="noopener">Version history in GitHub</a>`);
    });
    const lede = v.querySelector(".lede");
    if (lede && !lede.dataset.gh) {
      lede.dataset.gh = "1";
      lede.textContent = `The order flow reads its countries, plans and prices from these Excel files in the ${gh.repo} GitHub repository. To change a price or add a country, edit the file and upload it here${gh.canWrite ? "" : " or in GitHub"}; it's saved to GitHub as a new version. Keep the same sheet names and column headings.`;
    }
  }
  document.addEventListener("DOMContentLoaded", async () => {
    await meReady;
    addSignIn();
    loadGh();
    const v = document.getElementById("v-data");
    if (v) { new MutationObserver(decorateData).observe(v, { childList: true }); decorateData(); }
  });
})();
