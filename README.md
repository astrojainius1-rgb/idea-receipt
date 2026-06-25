# Idea Receipt

A tiny web page that prints your Notion ideas as a shop receipt. Open it on your
phone (Add to Home Screen for a full-screen app).

- The page reads only `data.json` and polls it every ~30s.
- **Auto-sync:** a GitHub Action (`.github/workflows/sync.yml`) runs `sync_notion.py`
  every ~10 min to rebuild `data.json` from Notion — works even when your Mac is off.
  Needs a `NOTION_TOKEN` repo secret (see [`sync-notes.md`](sync-notes.md)).
- Manual refresh is still available: say "sync my ideas" to Claude, or run the workflow
  from the **Actions** tab.
- Source Notion page: **Ideas**.

Hosted with GitHub Pages (served from the repo root on `main`).

## Features

Tap the **⚙ gear** (top-right) for settings. Everything is stored on the device.

- **Tap an idea** to cross it off (line-through; remembered locally).
- **Market pricing** — each idea trades at a stable per-title rate around the 55¢ list
  price, shown with a ▲/▼ marker.
- **Sort** ideas by Notion order / newest / priciest / A→Z.
- **Seasonal skins** — the paper subtly retints near holidays (auto by date; toggleable).
- **Coupon** — a daily tear-off coupon at the bottom (toggleable).
- **Theme** — auto / light / dark.
- **Save / Notion** buttons — save the receipt as a PNG (share sheet on mobile), or jump
  to the source Notion page.
- **New-idea alerts** — opt-in local notification when a fresh idea syncs. (Delivery while
  the app is fully closed needs a push backend; foreground/recent works today.)
- **Offline** — a service worker caches the shell + last receipt.

## Add an idea from the page (optional)

The page can append an idea straight to Notion via a tiny **Cloudflare Worker** that holds
the Notion token server-side (never in the browser). Deploy [`worker.js`](worker.js)
(setup steps are in its header comment), then paste the worker URL into
**⚙ settings → Add-idea sync URL**. New ideas show as "pending" until the next sync prints
them for real. Leave the URL blank to disable adding from the page.
