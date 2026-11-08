# Am I Working

A private daily tracker. One GitHub-style grid shows three signals at once: commits, Skool activity and wins. Habit boxes sit beside it.

Status: the app runs. `app/` is a dependency-free Node server plus one page: wins with notes and counts, a Skool counter, a 20-week grid, GitHub commits when a read-only token is set. Run `app/install.sh` to run it as a systemd user service on 127.0.0.1:8788. `design/` holds the earlier samples (made-up numbers).

## Rules for this repo
- Personal data never goes in Git. It lives in a local folder outside the repo.
- No hostnames, tokens or addresses in tracked files. Config comes from environment variables.
- One live branch (`feat/tracker`) and one open PR collect every push. It is not merged.

Tracking issue: #1
