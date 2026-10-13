// Hosted mode for the UC Order Hub page.
// The page was built as a claude.ai artifact and asks for its services through window.claude.use(...).
// This file provides the same services backed by this site's server, so index.html can stay identical to the artifact:
//   db        -> datasets/<key> documents become /api/datasets/<key> (admins upload the Excel file itself)
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

  // The page parses the chosen workbook itself; remember the original file so the server can keep it.
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
        async get() { const j = await api("GET", "/api/datasets/" + key); return { exists: !!j.uploaded, data: () => j }; },
        async set(d) {
          const f = picked[key];
          if (!f) throw new Error("Choose the Excel file again.");
          await api("PUT", "/api/datasets/" + key, { fileName: d.fileName || f.name, sheetsJson: d.sheetsJson, file: await base64(f) });
        },
        async delete() { await api("DELETE", "/api/datasets/" + key, {}); }
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
  // Data files page: a download link for each file in use, and wording that fits this site.
  function decorateData() {
    const v = document.getElementById("v-data"); if (!v) return;
    v.querySelectorAll("p.fine").forEach(p => {
      if (/^Only editors of this page/.test(p.textContent)) p.innerHTML = `Only admins can replace files. <a href="/login?next=${encodeURIComponent("/#data")}">Sign in as an admin</a>.`;
    });
    if (!me.admin) return;
    v.querySelectorAll(".dsa").forEach(box => {
      const inp = box.querySelector("input[type=file][data-key]");
      if (!inp || box.querySelector("[data-dl]")) return;
      box.insertAdjacentHTML("beforeend", `<a class="act" data-dl="1" href="/api/datasets/${esc(inp.dataset.key)}/file">Download the Excel file in use</a>`);
    });
  }
  document.addEventListener("DOMContentLoaded", async () => {
    await meReady;
    addSignIn();
    const v = document.getElementById("v-data");
    if (v) { new MutationObserver(decorateData).observe(v, { childList: true }); decorateData(); }
  });
})();
