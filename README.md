# Idea Receipt

A tiny web page that prints your Notion ideas as a shop receipt. Open it on your
phone (Add to Home Screen for a full-screen app).

- The page reads only `data.json` and polls it every ~30s.
- **Auto-sync:** a GitHub Action (`.github/workflows/sync.yml`) runs `sync_notion.py`
  every ~15 min to rebuild `data.json` from Notion — works even when your Mac is off.
  Needs a `NOTION_TOKEN` repo secret (see [`sync-notes.md`](sync-notes.md)).
- Manual refresh is still available: say "sync my ideas" to Claude, or run the workflow
  from the **Actions** tab.
- Source Notion page: **Ideas**.

Hosted with GitHub Pages (served from the repo root on `main`).
