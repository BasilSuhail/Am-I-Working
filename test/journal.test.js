"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amiw-j-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [path.join(__dirname, "../app/server.js")], { env: { ...process.env, AMIW_DATA: dir, PORT: String(port), HOST: "127.0.0.1" }, stdio: "ignore" });
  const call = (m, u, b) => fetch("http://127.0.0.1:" + port + u, { method: m, headers: { "x-amiw": "1", "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ s: r.status, j: await r.json() }));
  const ready = (async () => { for (let i = 0; i < 50; i++) { try { await fetch("http://127.0.0.1:" + port + "/healthz"); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } } throw new Error("server did not start"); })();
  return { dir, p, call, ready };
}

test("journal: write, list, read, history, and bad paths", async () => {
  const t = start(); await t.ready;
  try {
    for (const bad of ["../x.md", "/etc/x.md", "a/../../x.md", ".hidden/x.md", "x.txt", "a\\b.md"]) {
      const r = await t.call("PUT", "/api/journal/file", { path: bad, content: "no" });
      assert.equal(r.s, 400, bad);
    }
    const a = await t.call("PUT", "/api/journal/file", { path: "daily/2026-11-12.md", content: "# one\n", createOnly: true });
    assert.equal(a.s, 200);
    const list = await t.call("GET", "/api/journal/files");
    assert.deepEqual(list.j.files.map((f) => f.path), ["daily/2026-11-12.md"]);
    const got = await t.call("GET", "/api/journal/file?p=daily%2F2026-11-12.md");
    assert.equal(got.j.content, "# one\n");
    const b = await t.call("PUT", "/api/journal/file", { path: "daily/2026-11-12.md", content: "# two\n", base: got.j.mtime });
    assert.equal(b.s, 200);
    assert.ok(fs.readdirSync(path.join(t.dir, "journal", ".history", "daily")).length >= 1, "old text kept in .history");
    fs.writeFileSync(path.join(t.dir, "journal", "daily", "2026-11-12.md"), "# edited elsewhere\n");
    fs.utimesSync(path.join(t.dir, "journal", "daily", "2026-11-12.md"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const c = await t.call("PUT", "/api/journal/file", { path: "daily/2026-11-12.md", content: "# mine\n", base: b.j.mtime });
    assert.equal(c.s, 409, "a change made elsewhere is not overwritten");
  } finally { t.p.kill(); }
});
