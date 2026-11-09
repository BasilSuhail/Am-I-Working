"use strict";
// Calendar support for Am I Working. No dependencies.
// Reads calendar links (.ics / webcal), keeps a local copy of every event it has ever seen
// (including ones later deleted upstream), and works out which events fall on which day.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const dns = require("node:dns").promises;

// ---------- reading .ics ----------
function unfold(t) { return t.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, ""); }
function unescapeText(s) { return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1"); }

function parseLine(l) {
  let inq = false, idx = -1;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '"') inq = !inq;
    else if (c === ":" && !inq) { idx = i; break; }
  }
  if (idx < 0) return null;
  const parts = l.slice(0, idx).split(";");
  const params = {};
  parts.slice(1).forEach((p) => { const k = p.indexOf("="); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ""); });
  return { name: parts[0].toUpperCase(), params, value: l.slice(idx + 1) };
}

function validZone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch (e) { return false; }
}
function zoneOffset(tz, ms) {
  const s = Math.floor(ms / 1000) * 1000;
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(s)).reduce((a, x) => { a[x.type] = Number(x.value); return a; }, {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - s;
}
// wall-clock time in a zone -> real instant
function wallToUtc(w, tz) {
  if (!tz) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  let r = guess - zoneOffset(tz, guess);
  const off2 = zoneOffset(tz, r);
  if (guess - off2 !== r) r = guess - off2;
  return r;
}

// Returns { allDay:true, date:"YYYY-MM-DD" } or { allDay:false, ms, wall, tz }
function parseDT(value, params) {
  const v = String(value || "").trim();
  if ((params && params.VALUE === "DATE") || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
    return m ? { allDay: true, date: m[1] + "-" + m[2] + "-" + m[3] } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const w = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  if (m[7]) return { allDay: false, ms: Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s), wall: w, tz: "UTC" };
  const tz = params && validZone(params.TZID) ? params.TZID : null; // unknown zone names fall back to this computer's time
  return { allDay: false, ms: wallToUtc(w, tz), wall: w, tz };
}

const WD = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
function parseRule(raw, params) {
  const r = { freq: "", interval: 1, count: 0, until: null, byday: [], bymonthday: [] };
  String(raw).split(";").forEach((kv) => {
    const i = kv.indexOf("="); if (i < 0) return;
    const k = kv.slice(0, i).toUpperCase(), v = kv.slice(i + 1);
    if (k === "FREQ") r.freq = v.toUpperCase();
    else if (k === "INTERVAL") r.interval = Math.max(1, Math.min(1000, parseInt(v, 10) || 1));
    else if (k === "COUNT") r.count = Math.max(0, parseInt(v, 10) || 0);
    else if (k === "UNTIL") r.until = parseDT(v, params);
    else if (k === "BYDAY") v.split(",").forEach((x) => { const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(x.trim()); if (m) r.byday.push({ n: m[1] ? parseInt(m[1], 10) : 0, wd: WD[m[2].toUpperCase()] }); });
    else if (k === "BYMONTHDAY") v.split(",").forEach((x) => { const n = parseInt(x, 10); if (n) r.bymonthday.push(n); });
  });
  return ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.freq) ? r : null;
}

function keyOf(dt) { return dt.allDay ? dt.date : String(dt.ms); }

function parseICS(text) {
  const lines = unfold(String(text)).split("\n");
  const events = [];
  let cur = null, depth = 0;
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^BEGIN:VEVENT$/i.test(l)) { cur = { ex: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (/^BEGIN:/i.test(l)) { depth++; continue; }       // VALARM and friends
    if (/^END:VEVENT$/i.test(l)) {
      if (cur.start) {
        if (!cur.uid) cur.uid = "x" + keyOf(cur.start) + "-" + (cur.summary || "");
        events.push(cur);
      }
      cur = null; continue;
    }
    if (/^END:/i.test(l)) { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    const p = parseLine(l); if (!p) continue;
    if (p.name === "UID") cur.uid = p.value.trim().slice(0, 300);
    else if (p.name === "SUMMARY") cur.summary = unescapeText(p.value).slice(0, 300);
    else if (p.name === "LOCATION") cur.location = unescapeText(p.value).slice(0, 300);
    else if (p.name === "DESCRIPTION") cur.description = unescapeText(p.value).slice(0, 2000);
    else if (p.name === "STATUS") cur.status = p.value.trim().toUpperCase();
    else if (p.name === "DTSTART") cur.start = parseDT(p.value, p.params);
    else if (p.name === "DTEND") cur.end = parseDT(p.value, p.params);
    else if (p.name === "DURATION") cur.duration = p.value.trim();
    else if (p.name === "RRULE") cur.rrule = parseRule(p.value, p.params);
    else if (p.name === "EXDATE") p.value.split(",").forEach((x) => { const d = parseDT(x, p.params); if (d) cur.ex.push(keyOf(d)); });
    else if (p.name === "RECURRENCE-ID") { const d = parseDT(p.value, p.params); if (d) cur.recKey = keyOf(d); }
  }
  return events.filter((e) => e.status !== "CANCELLED").map(finish);
}

function durationMs(s) {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(s || "");
  if (!m) return 0;
  const v = ((+m[2] || 0) * 7 + (+m[3] || 0)) * 864e5 + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1e3;
  return m[1] ? -v : v;
}
// plain, storable form of an event
function finish(e) {
  const out = { uid: e.uid, title: e.summary || "(no title)", loc: e.location || "", notes: e.description || "", rec: e.recKey || "", rule: e.rrule || null, ex: e.ex || [] };
  if (e.start.allDay) {
    out.allDay = true; out.date = e.start.date;
    const endDate = e.end && e.end.allDay ? e.end.date : null;
    const days = endDate ? Math.max(1, Math.round((Date.parse(endDate) - Date.parse(e.start.date)) / 864e5)) : 1;
    out.days = days;
  } else {
    out.allDay = false; out.ms = e.start.ms; out.wall = e.start.wall; out.tz = e.start.tz;
    let dur = e.end && !e.end.allDay ? e.end.ms - e.start.ms : e.duration ? durationMs(e.duration) : 0;
    if (!(dur >= 0)) dur = 0;
    out.dur = dur;
  }
  return out;
}

// ---------- which events land in a window ----------
const DAY = 864e5;
function dateStr(dayNum) { return new Date(dayNum * DAY).toISOString().slice(0, 10); }
function matches(rule, dn, b0, w0, y, mo, d) {
  const wd = (dn + 3) % 7, wk = Math.floor((dn + 3) / 7), wk0 = Math.floor((b0 + 3) / 7);
  if (rule.freq === "DAILY") return (dn - b0) % rule.interval === 0;
  if (rule.freq === "WEEKLY") {
    const days = rule.byday.length ? rule.byday.map((x) => x.wd) : [(b0 + 3) % 7];
    return (wk - wk0) % rule.interval === 0 && days.includes(wd);
  }
  if (rule.freq === "MONTHLY") {
    if (((y - w0.y) * 12 + (mo - w0.mo)) % rule.interval !== 0) return false;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (rule.bymonthday.length) return rule.bymonthday.some((n) => (n > 0 ? n === d : dim + n + 1 === d));
    if (rule.byday.length) return rule.byday.some((x) => x.wd === wd && (!x.n || (x.n > 0 ? Math.floor((d - 1) / 7) + 1 === x.n : Math.floor((dim - d) / 7) + 1 === -x.n)));
    return d === w0.d;
  }
  return mo === w0.mo && d === w0.d && (y - w0.y) % rule.interval === 0; // YEARLY
}

// Returns instances that overlap [fromMs, toMs): { startMs,endMs } or { allDay:true, date, days }
function expand(ev, fromMs, toMs, overrides) {
  const out = [];
  const add = (inst) => {
    if (ev.allDay) {
      const s = Date.parse(inst.date), e = s + inst.days * DAY;
      if (e > fromMs - 14 * 3600e3 && s < toMs + 14 * 3600e3) out.push(inst);
    } else if (inst.endMs > fromMs && inst.startMs < toMs || (inst.startMs >= fromMs && inst.startMs < toMs)) out.push(inst);
  };
  if (!ev.rule) {
    add(ev.allDay ? { date: ev.date, days: ev.days, allDay: true } : { startMs: ev.ms, endMs: ev.ms + ev.dur });
    return out;
  }
  const w0 = ev.allDay ? { y: +ev.date.slice(0, 4), mo: +ev.date.slice(5, 7), d: +ev.date.slice(8, 10), h: 0, mi: 0, s: 0 } : ev.wall;
  const b0 = Math.floor(Date.UTC(w0.y, w0.mo - 1, w0.d) / DAY);
  const last = Math.ceil(toMs / DAY) + 2;
  let untilKey = null;
  if (ev.rule.until) untilKey = ev.rule.until.allDay ? Date.parse(ev.rule.until.date) + DAY : ev.rule.until.ms;
  let n = 0;
  for (let dn = b0, steps = 0; dn <= last && steps < 366 * 60; dn++, steps++) {
    const dt = new Date(dn * DAY), y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    if (!matches(ev.rule, dn, b0, w0, y, mo, d)) continue;
    let startMs = null, key;
    if (ev.allDay) key = dateStr(dn);
    else { startMs = wallToUtc({ y, mo, d, h: w0.h, mi: w0.mi, s: w0.s }, ev.tz === "UTC" ? "UTC" : ev.tz); key = String(startMs); }
    if (untilKey !== null && (ev.allDay ? dn * DAY >= untilKey : startMs > untilKey)) break;
    n++;
    if (ev.rule.count && n > ev.rule.count) break;
    if (ev.ex.includes(key)) continue;
    const o = overrides && overrides[key];
    if (o) { expand({ ...o, rule: null, ex: [] }, fromMs, toMs).forEach((i) => out.push({ ...i, over: o })); continue; }
    add(ev.allDay ? { date: key, days: ev.days, allDay: true } : { startMs, endMs: startMs + ev.dur });
  }
  return out;
}

// ---------- fetching a link ----------
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v);
}
async function assertSafeHost(host, allowPrivate) {
  if (allowPrivate) return;
  host = host.replace(/^\[|\]$/g, ""); // IPv6 literals arrive in brackets
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error("That address is on your own network, not a public calendar link.");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new Error("That address is on your own network, not a public calendar link.");
}
function normalizeUrl(u) {
  let s = String(u || "").trim();
  if (/^webcals?:\/\//i.test(s)) s = s.replace(/^webcals?:\/\//i, "https://");
  let url;
  try { url = new URL(s); } catch (e) { throw new Error("That is not a valid link."); }
  if (url.protocol !== "https:" && !(process.env.AMIW_ALLOW_HTTP === "1" && url.protocol === "http:")) throw new Error("The link must start with https:// or webcal://");
  if (url.username || url.password) throw new Error("Remove the username and password from the link.");
  return url.toString();
}
async function fetchText(link, opts) {
  const o = opts || {}, allowPrivate = process.env.AMIW_ALLOW_PRIVATE === "1";
  let url = normalizeUrl(link);
  for (let hop = 0; hop < 4; hop++) {
    await assertSafeHost(new URL(url).hostname, allowPrivate);
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(o.timeout || 20000), headers: { "User-Agent": "am-i-working", Accept: "text/calendar, text/plain, */*" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = normalizeUrl(new URL(r.headers.get("location"), url).toString()); continue; }
    if (!r.ok) throw new Error("The calendar answered with an error (" + r.status + ").");
    const max = 25 * 1024 * 1024, chunks = []; let size = 0;
    for await (const c of r.body) { size += c.length; if (size > max) throw new Error("The calendar file is too big."); chunks.push(c); }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That link did not return a calendar.");
    return text;
  }
  throw new Error("Too many redirects.");
}

// ---------- local copy ----------
function createStore(dir) {
  const file = path.join(dir, "calendar.json");
  let db = { sources: {} };
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  if (!db.sources) db.sources = {};
  function save() {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    try { fs.copyFileSync(file, file + ".bak"); } catch (e) {}
    fs.renameSync(tmp, file);
  }
  function srcOf(id) { return db.sources[id] || (db.sources[id] = { items: {}, at: 0, ok: null, error: "" }); }
  const idOf = (e) => e.uid + "|" + (e.rec || "");
  return {
    // Replace what we know with the newest copy, but keep anything that vanished (marked deleted).
    update(id, events) {
      const s = srcOf(id), now = Date.now(), seen = new Set();
      events.forEach((e) => {
        const k = idOf(e); seen.add(k);
        const old = s.items[k];
        s.items[k] = { ev: e, first: old ? old.first : now, last: now };
      });
      Object.keys(s.items).forEach((k) => { if (!seen.has(k) && !s.items[k].gone) s.items[k].gone = now; });
      s.at = now; s.ok = true; s.error = ""; save();
    },
    fail(id, message) { const s = srcOf(id); s.at = Date.now(); s.ok = false; s.error = String(message).slice(0, 300); save(); },
    status(id) {
      const s = db.sources[id]; if (!s) return { at: 0, ok: null, error: "", count: 0, kept: 0 };
      const all = Object.values(s.items);
      return { at: s.at, ok: s.ok, error: s.error, count: all.filter((x) => !x.gone).length, kept: all.length };
    },
    drop(id) { /* the local copy is kept on purpose, even when a link is removed */ },
    // events of every source that touch [fromMs, toMs)
    window(ids, fromMs, toMs) {
      const out = [];
      ids.forEach((id) => {
        const s = db.sources[id]; if (!s) return;
        const live = Object.values(s.items).filter((x) => !x.gone).map((x) => x.ev);
        const over = {};
        live.forEach((e) => { if (e.rec) (over[e.uid] = over[e.uid] || {})[e.rec] = e; });
        live.forEach((e) => {
          if (e.rec) { if (!live.some((m) => m.uid === e.uid && !m.rec && m.rule)) expand({ ...e, rule: null, ex: [] }, fromMs, toMs).forEach((i) => push(out, id, e, i)); return; }
          expand(e, fromMs, toMs, over[e.uid]).forEach((i) => push(out, id, i.over || e, i));
        });
      });
      return out.sort((a, b) => (a.allDay === b.allDay ? String(a.start).localeCompare(String(b.start)) : a.allDay ? -1 : 1));
    },
  };
}
function push(out, cal, e, i) {
  if (i.allDay) out.push({ id: e.uid + "@" + i.date, cal, title: e.title, loc: e.loc, notes: e.notes, rep: !!e.rule || !!e.rec, allDay: true, start: i.date, days: i.days });
  else out.push({ id: e.uid + "@" + i.startMs, cal, title: e.title, loc: e.loc, notes: e.notes, rep: !!e.rule || !!e.rec, allDay: false, start: new Date(i.startMs).toISOString(), end: new Date(i.endMs).toISOString() });
}

module.exports = { parseICS, expand, fetchText, normalizeUrl, createStore, wallToUtc };
