"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseICS, normalizeUrl, createStore } = require("../app/calendar.js");

const wrap = (body) => "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" + body + "END:VCALENDAR\r\n";
const ev = (lines) => "BEGIN:VEVENT\r\n" + lines.join("\r\n") + "\r\nEND:VEVENT\r\n";
const day = (from, to) => [Date.parse(from), Date.parse(to)];
function windowOf(ics, from, to) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amiw-cal-"));
  const s = createStore(dir);
  s.update("a", parseICS(ics));
  const [f, t] = day(from, to);
  return s.window(["a"], f, t);
}

test("a plain event in UTC", () => {
  const out = windowOf(wrap(ev(["UID:1", "SUMMARY:Call", "DTSTART:20261109T130000Z", "DTEND:20261109T140000Z"])), "2026-11-09T00:00:00Z", "2026-11-10T00:00:00Z");
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Call");
  assert.equal(out[0].start, "2026-11-09T13:00:00.000Z");
  assert.equal(out[0].end, "2026-11-09T14:00:00.000Z");
});

test("time zones follow daylight saving", () => {
  const ics = wrap(ev(["UID:2", "SUMMARY:Meet", "DTSTART;TZID=Europe/London:20260701T090000", "DTEND;TZID=Europe/London:20260701T100000"]) +
    ev(["UID:3", "SUMMARY:Winter", "DTSTART;TZID=Europe/London:20261201T090000", "DTEND;TZID=Europe/London:20261201T100000"]));
  const out = windowOf(ics, "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
  assert.equal(out.find((e) => e.title === "Meet").start, "2026-07-01T08:00:00.000Z"); // BST is UTC+1
  assert.equal(out.find((e) => e.title === "Winter").start, "2026-12-01T09:00:00.000Z");
});

test("weekly repeat with a skipped day and a moved one", () => {
  const ics = wrap(ev(["UID:w", "SUMMARY:Class", "DTSTART;TZID=Europe/London:20261102T100000", "DTEND;TZID=Europe/London:20261102T110000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE;TZID=Europe/London:20261111T100000"]) +
    ev(["UID:w", "SUMMARY:Class (moved)", "RECURRENCE-ID;TZID=Europe/London:20261116T100000", "DTSTART;TZID=Europe/London:20261116T150000", "DTEND;TZID=Europe/London:20261116T160000"]));
  const out = windowOf(ics, "2026-11-01T00:00:00Z", "2026-11-22T00:00:00Z");
  const days = out.map((e) => e.start.slice(0, 10) + " " + e.title);
  assert.deepEqual(days, [
    "2026-11-02T10:00:00.000Z Class", "2026-11-04T10:00:00.000Z Class",
    "2026-11-09T10:00:00.000Z Class", /* 11 Nov skipped */ "2026-11-16T15:00:00.000Z Class (moved)",
    "2026-11-18T10:00:00.000Z Class",
  ].map((s) => s.slice(0, 10) + " " + s.split("Z ")[1]));
  assert.equal(out.find((e) => e.title === "Class (moved)").start, "2026-11-16T15:00:00.000Z");
});

test("all-day events, one and several days", () => {
  const ics = wrap(ev(["UID:a1", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261125", "DTEND;VALUE=DATE:20261126"]) +
    ev(["UID:a2", "SUMMARY:Trip", "DTSTART;VALUE=DATE:20261126", "DTEND;VALUE=DATE:20261129"]));
  const out = windowOf(ics, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
  assert.equal(out.find((e) => e.title === "Holiday").days, 1);
  assert.equal(out.find((e) => e.title === "Trip").days, 3);
  assert.ok(out.every((e) => e.allDay));
});

test("monthly on the second Tuesday, and a repeat with a count", () => {
  const ics = wrap(ev(["UID:m", "SUMMARY:Review", "DTSTART:20260113T100000Z", "DTEND:20260113T110000Z", "RRULE:FREQ=MONTHLY;BYDAY=2TU"]) +
    ev(["UID:c", "SUMMARY:Three", "DTSTART:20261101T080000Z", "DTEND:20261101T090000Z", "RRULE:FREQ=DAILY;COUNT=3"]));
  const out = windowOf(ics, "2026-11-01T00:00:00Z", "2026-12-31T00:00:00Z");
  assert.deepEqual(out.filter((e) => e.title === "Review").map((e) => e.start.slice(0, 10)), ["2026-11-10", "2026-12-08"]);
  assert.equal(out.filter((e) => e.title === "Three").length, 3);
});

test("cancelled events are ignored and text is unescaped", () => {
  const ics = wrap(ev(["UID:x", "SUMMARY:Gone", "STATUS:CANCELLED", "DTSTART:20261109T130000Z"]) +
    ev(["UID:y", "SUMMARY:Lunch\\, then walk", "DESCRIPTION:Line one\\nLine two", "DTSTART:20261109T120000Z", "DTEND:20261109T130000Z"]));
  const out = windowOf(ics, "2026-11-09T00:00:00Z", "2026-11-10T00:00:00Z");
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Lunch, then walk");
  assert.equal(out[0].notes, "Line one\nLine two");
});

test("an event that vanishes from the link is kept locally but hidden", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amiw-cal-"));
  const s = createStore(dir);
  s.update("a", parseICS(wrap(ev(["UID:k", "SUMMARY:Keep me", "DTSTART:20261109T130000Z", "DTEND:20261109T140000Z"]))));
  s.update("a", parseICS(wrap("")));
  const [f, t] = day("2026-11-09T00:00:00Z", "2026-11-10T00:00:00Z");
  assert.equal(s.window(["a"], f, t).length, 0);
  assert.deepEqual([s.status("a").count, s.status("a").kept], [0, 1]);
  const again = createStore(dir); // survives a restart
  assert.equal(again.status("a").kept, 1);
});

test("links: webcal becomes https, other schemes are refused", () => {
  assert.equal(normalizeUrl("webcal://cal.invalid/a.ics"), "https://cal.invalid/a.ics");
  assert.throws(() => normalizeUrl("http://cal.invalid/a.ics"));
  assert.throws(() => normalizeUrl("file:///etc/passwd"));
  assert.throws(() => normalizeUrl("https://user:pw" + "@" + "cal.invalid/a.ics"));
  assert.throws(() => normalizeUrl("not a link"));
});

test("links to your own network are refused", async () => {
  const { fetchText } = require("../app/calendar.js");
  for (const u of ["https://localhost/a.ics", "https://printer.local/a.ics", "https://127.0.0.1/a.ics", "https://[::1]/a.ics"]) {
    await assert.rejects(fetchText(u), /own network/);
  }
});
