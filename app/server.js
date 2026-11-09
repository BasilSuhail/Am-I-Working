"use strict";
// Am I Working: a tiny private tracker server. No dependencies.
// Config comes from the environment, nothing personal lives in this repo:
//   HOST        address to listen on (default 127.0.0.1; set to the tailnet address on the server)
//   PORT        default 8788
//   AMIW_DATA   folder for data.json (default ~/.am-i-working, outside the repo)
//   GITHUB_TOKEN, GITHUB_LOGIN   optional, read-only token, fills the commits row
//                                (you can also set these inside the app, under the gear)
//   COMMITS_TTL_HOURS            how long to keep GitHub's answer (default 24)
//   CALENDAR_SYNC_MINUTES        how often calendar links are re-read (default 5)
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.AMIW_DATA || path.join(os.homedir(), ".am-i-working");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const PAGE = fs.readFileSync(path.join(__dirname, "index.html"));
const MAX_BODY = 2 * 1024 * 1024;
const cal = require("./calendar.js");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const store = cal.createStore(DATA_DIR);

// Settings (GitHub login and token, calendar links) live next to your data, never in the repo.
// The page is only ever told "saved", never the secret itself.
function readSettings() {
  try { const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); return { github: s.github || {}, calendars: Array.isArray(s.calendars) ? s.calendars : [] }; }
  catch (e) { return { github: {}, calendars: [] }; }
}
function writeSettings(s) {
  const tmp = SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
}
function github() {
  const g = readSettings().github;
  return { login: g.login || process.env.GITHUB_LOGIN || "", token: g.token || process.env.GITHUB_TOKEN || "" };
}
function hint(url) { try { const u = new URL(url.replace(/^webcals?:\/\//i, "https://")); return u.hostname + "/…" + url.slice(-4); } catch (e) { return ""; } }
function publicSettings() {
  const s = readSettings(), g = github();
  return {
    github: { login: g.login, hasToken: !!g.token, fromEnv: !s.github.token && !!process.env.GITHUB_TOKEN, ok: ghStatus.ok, at: ghStatus.at, error: ghStatus.error },
    calendars: s.calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, hint: hint(c.url), ...store.status(c.id) })),
  };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { return { v: 1, entries: [], skool: {}, nid: 1 }; }
}
function writeState(obj) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  try { fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak"); } catch (e) {}
  fs.renameSync(tmp, DATA_FILE);
}
function valid(o) {
  return o && typeof o === "object" && o.v === 1 && Array.isArray(o.entries) && o.entries.length < 20000 &&
    o.skool && typeof o.skool === "object" && !Array.isArray(o.skool) &&
    (o.lists == null || (Array.isArray(o.lists) && o.lists.length < 500)) &&
    o.entries.every((e) => e && typeof e === "object" && typeof e.text === "string" && Number.isInteger(e.id) && typeof e.date === "string");
}

const COMMITS_TTL = Math.max(0.05, Number(process.env.COMMITS_TTL_HOURS || 24)) * 3600 * 1000;
let commitCache = { at: 0, data: {} };
let ghStatus = { ok: null, at: 0, error: "" };
async function commits(force) {
  const { token, login } = github();
  if (!token || !login) return {};
  const age = Date.now() - commitCache.at;
  if (age < (force ? 30 * 1000 : COMMITS_TTL)) return commitCache.data;
  const to = new Date(), from = new Date(Date.now() - 150 * 864e5);
  const query = "query($l:String!,$f:DateTime!,$t:DateTime!){user(login:$l){contributionsCollection(from:$f,to:$t){contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}";
  try {
    const r = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: "bearer " + token, "Content-Type": "application/json", "User-Agent": "am-i-working" },
      body: JSON.stringify({ query, variables: { l: login, f: from.toISOString(), t: to.toISOString() } }),
    });
    const j = await r.json();
    if (!j.data || !j.data.user) throw new Error((j.message || (j.errors && j.errors[0] && j.errors[0].message) || "GitHub did not accept the login or token."));
    const out = {};
    j.data.user.contributionsCollection.contributionCalendar.weeks.forEach((w) =>
      w.contributionDays.forEach((d) => { if (d.contributionCount > 0) out[d.date] = d.contributionCount; }));
    commitCache = { at: Date.now(), data: out };
    ghStatus = { ok: true, at: Date.now(), error: "" };
  } catch (e) { commitCache.at = Date.now() - COMMITS_TTL + 60 * 1000; ghStatus = { ok: false, at: Date.now(), error: String(e.message || e).slice(0, 200) }; }
  return commitCache.data;
}

const colors = ["#4285f4", "#e8554e", "#1baf7a", "#f5a623", "#9b59d0", "#16a2b8", "#e6628f", "#8a8f98"];
let syncing = null;
async function syncAll(force) {
  if (syncing) return syncing;
  syncing = (async () => {
    const results = [];
    for (const c of readSettings().calendars) {
      try { store.update(c.id, cal.parseICS(await cal.fetchText(c.url))); results.push({ id: c.id, ok: true }); }
      catch (e) { store.fail(c.id, e.message || e); results.push({ id: c.id, ok: false, error: String(e.message || e) }); }
    }
    let gh = null;
    if (github().token && github().login) { await commits(force); gh = { ok: ghStatus.ok, error: ghStatus.error }; }
    return { ok: results.every((r) => r.ok) && (!gh || gh.ok), at: Date.now(), results, github: gh };
  })().finally(() => { syncing = null; });
  return syncing;
}
function readBody(req, res, cb) {
  let size = 0; const chunks = [];
  req.on("data", (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
  req.on("end", () => { try { cb(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { send(res, 400, '{"error":"bad json"}'); } });
}
function applySettings(o) {
  const cur = readSettings(), next = { github: { ...cur.github }, calendars: [] };
  if (o.github && typeof o.github === "object") {
    if (typeof o.github.login === "string") next.github.login = o.github.login.trim().slice(0, 100);
    if (typeof o.github.token === "string" && o.github.token.trim()) next.github.token = o.github.token.trim().slice(0, 300);
    if (o.github.clearToken === true) delete next.github.token;
  }
  if (Array.isArray(o.calendars)) {
    if (o.calendars.length > 20) throw new Error("Too many calendars.");
    o.calendars.forEach((c) => {
      if (!c || typeof c !== "object") return;
      const old = cur.calendars.find((x) => x.id === c.id);
      const url = typeof c.url === "string" && c.url.trim() ? cal.normalizeUrl(c.url) : old && old.url;
      if (!url) throw new Error("Each calendar needs a link.");
      const color = /^#[0-9a-f]{6}$/i.test(c.color || "") ? c.color : (old && old.color) || colors[next.calendars.length % colors.length];
      next.calendars.push({ id: old ? old.id : "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(c.name || (old && old.name) || "Calendar").trim().slice(0, 60) || "Calendar", url, color });
    });
  } else next.calendars = cur.calendars;
  writeSettings(next);
  return next;
}

function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const full = req.url || "/", url = full.split("?")[0], force = /[?&]refresh=1(&|$)/.test(full);
  if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (url === "/healthz") return send(res, 200, '{"ok":true}');
  if (url.startsWith("/api/")) {
    if (req.headers["x-amiw"] !== "1") return send(res, 403, '{"error":"forbidden"}');
    if (url === "/api/settings" && req.method === "GET") return send(res, 200, JSON.stringify(publicSettings()));
    if (url === "/api/settings" && req.method === "PUT") {
      return readBody(req, res, async (o) => {
        try {
          const before = readSettings(), next = applySettings(o);
          const added = next.calendars.filter((c) => !before.calendars.some((x) => x.id === c.id && x.url === c.url));
          const ghChanged = JSON.stringify(before.github) !== JSON.stringify(next.github);
          if (ghChanged) commitCache.at = 0;
          if (added.length || ghChanged) await syncAll(true);
          send(res, 200, JSON.stringify(publicSettings()));
        } catch (e) { send(res, 400, JSON.stringify({ error: String(e.message || e) })); }
      });
    }
    if (url === "/api/sync" && req.method === "POST") return send(res, 200, JSON.stringify({ ...(await syncAll(true)), settings: publicSettings() }));
    if (url === "/api/calendar" && req.method === "GET") {
      const q = new URL(full, "http://x").searchParams, f = Date.parse(q.get("from") + "T00:00:00Z"), t = Date.parse(q.get("to") + "T00:00:00Z");
      if (!(f < t) || t - f > 400 * 864e5) return send(res, 400, '{"error":"bad range"}');
      const pad = 864e5; // events are matched in UTC, the page sorts them into local days
      return send(res, 200, JSON.stringify({ events: store.window(readSettings().calendars.map((c) => c.id), f - pad, t + pad), settings: publicSettings() }));
    }
    if (url === "/api/state" && req.method === "GET") return send(res, 200, JSON.stringify(readState()));
    if (url === "/api/commits" && req.method === "GET") return send(res, 200, JSON.stringify(await commits(force)));
    if (url === "/api/state" && req.method === "PUT") {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(c); });
      req.on("end", () => {
        try {
          const o = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!valid(o)) return send(res, 400, '{"error":"bad state"}');
          // A save must be based on the latest version, or it could wipe a newer one from another device.
          const cur = readState(), rev = Number(cur.rev) || 0;
          if (Number(o.base) !== rev) return send(res, 409, JSON.stringify({ error: "stale", state: cur }));
          delete o.base; o.rev = rev + 1;
          writeState(o); send(res, 200, JSON.stringify({ ok: true, rev: o.rev }));
        } catch (e) { send(res, 400, '{"error":"bad json"}'); }
      });
      return;
    }
  }
  send(res, 404, '{"error":"not found"}');
});
server.listen(PORT, HOST, () => {
  console.log("am-i-working listening on " + HOST + ":" + PORT);
  const every = Math.max(1, Number(process.env.CALENDAR_SYNC_MINUTES || 5)) * 60 * 1000;
  setTimeout(() => syncAll(false).catch(() => {}), 1500);
  setInterval(() => syncAll(false).catch(() => {}), every).unref();
});
