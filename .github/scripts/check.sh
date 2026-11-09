#!/usr/bin/env bash
# Repo checks: privacy, syntax, a real start-up smoke test. Fails the build on any problem.
set -u
fail=0
bad() { echo "::error::$*"; fail=1; }

echo "== 1. Privacy: no private addresses, hostnames, keys, emails or home paths in tracked files"
# README documents these words on purpose, so only look for actual values.
pat='ts\.net|(^|[^0-9.])(10|127\.0\.0)\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
# 127.0.0.1 (this computer) is expected and allowed; emails ending in users.noreply.github.com are allowed.
hits=$(git ls-files -z | xargs -0 grep -InE "$pat" 2>/dev/null \
  | grep -vE '127\.0\.0\.1' | grep -vE 'users\.noreply\.github\.com' | grep -vE '^\.github/scripts/check\.sh:')
if [ -n "$hits" ]; then echo "$hits"; bad "Possible private data above. Remove it, or ask the owner."; fi

echo "== 2. Images: no hidden metadata (only basic PNG chunks allowed)"
for f in $(git ls-files 'docs/*.png' '*.png'); do
  chunks=$(python3 - "$f" <<'PY'
import struct, sys
d = open(sys.argv[1], 'rb').read()
assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
i, out = 8, []
while i < len(d):
    n, t = struct.unpack('>I4s', d[i:i+8]); out.append(t.decode()); i += 12 + n
print(' '.join(out))
PY
  ) || { bad "$f is not a valid PNG"; continue; }
  for c in $chunks; do
    case "$c" in IHDR|IDAT|IEND|PLTE|tRNS) ;; *) bad "$f has extra chunk '$c' (metadata). Re-save with all metadata stripped.";; esac
  done
done

echo "== 3. Syntax"
node --check app/server.js || bad "app/server.js has a syntax error"
node --check app/calendar.js || bad "app/calendar.js has a syntax error"
bash -n app/install.sh || bad "app/install.sh has a syntax error"
bash -n start-mac.command || bad "start-mac.command has a syntax error"
node -e '
const h = require("fs").readFileSync("app/index.html", "utf8");
const m = [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!m.length) { console.error("no inline script found"); process.exit(1); }
m.forEach(x => new Function(x[1]));
' || bad "app/index.html script has a syntax error"

echo "== 3b. Calendar tests"
node --test test/*.test.js || bad "calendar tests failed"

echo "== 4. Start-up smoke test"
d=$(mktemp -d)
PORT=18788 HOST=127.0.0.1 AMIW_DATA="$d" node app/server.js >"$d/log" 2>&1 &
pid=$!
ok=0; for _ in $(seq 1 30); do curl -fs http://127.0.0.1:18788/ >/dev/null && { ok=1; break; }; sleep 0.3; done
[ $ok = 1 ] || { cat "$d/log"; bad "server did not start"; }
if [ $ok = 1 ]; then
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18788/api/state)" = 403 ] || bad "API must refuse requests without the X-AMIW header"
  curl -fs -H 'X-AMIW: 1' http://127.0.0.1:18788/api/state | grep -q '"entries"' || bad "/api/state did not return state"
  curl -fs http://127.0.0.1:18788/ | grep -qi 'Daily record' || bad "page did not load"
fi
kill $pid 2>/dev/null

[ $fail = 0 ] && echo "All checks passed." || { echo "Checks failed."; exit 1; }
