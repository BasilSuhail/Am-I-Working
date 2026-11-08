"use strict";
// Am I Working: a tiny private tracker server. No dependencies.
// Config comes from the environment, nothing personal lives in this repo:
//   HOST        address to listen on (default 127.0.0.1; set to the tailnet address on the server)
//   PORT        default 8788
//   AMIW_DATA   folder for data.json (default ~/.am-i-working, outside the repo)
//   GITHUB_TOKEN, GITHUB_LOGIN   optional, read-only token, fills the commits row
//   COMMITS_TTL_HOURS            how long to keep GitHub's answer (default 24)
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

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

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
async function commits() {
  const token = process.env.GITHUB_TOKEN, login = process.env.GITHUB_LOGIN;
  if (!token || !login) return {};
  if (Date.now() - commitCache.at < COMMITS_TTL) return commitCache.data;
  const to = new Date(), from = new Date(Date.now() - 150 * 864e5);
  const query = "query($l:String!,$f:DateTime!,$t:DateTime!){user(login:$l){contributionsCollection(from:$f,to:$t){contributionCalendar{weeks{contributionDays{date contributionCount}}}}}}";
  try {
    const r = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: "bearer " + token, "Content-Type": "application/json", "User-Agent": "am-i-working" },
      body: JSON.stringify({ query, variables: { l: login, f: from.toISOString(), t: to.toISOString() } }),
    });
    const j = await r.json();
    const out = {};
    j.data.user.contributionsCollection.contributionCalendar.weeks.forEach((w) =>
      w.contributionDays.forEach((d) => { if (d.contributionCount > 0) out[d.date] = d.contributionCount; }));
    commitCache = { at: Date.now(), data: out };
  } catch (e) { commitCache.at = Date.now() - COMMITS_TTL + 60 * 1000; }
  return commitCache.data;
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
  const url = (req.url || "/").split("?")[0];
  if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (url === "/healthz") return send(res, 200, '{"ok":true}');
  if (url.startsWith("/api/")) {
    if (req.headers["x-amiw"] !== "1") return send(res, 403, '{"error":"forbidden"}');
    if (url === "/api/state" && req.method === "GET") return send(res, 200, JSON.stringify(readState()));
    if (url === "/api/commits" && req.method === "GET") return send(res, 200, JSON.stringify(await commits()));
    if (url === "/api/state" && req.method === "PUT") {
      let size = 0; const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(c); });
      req.on("end", () => {
        try {
          const o = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!valid(o)) return send(res, 400, '{"error":"bad state"}');
          writeState(o); send(res, 200, '{"ok":true}');
        } catch (e) { send(res, 400, '{"error":"bad json"}'); }
      });
      return;
    }
  }
  send(res, 404, '{"error":"not found"}');
});
server.listen(PORT, HOST, () => console.log("am-i-working listening on " + HOST + ":" + PORT));
