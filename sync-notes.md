# How syncing works

The web page (`index.html` + `app.js`) only ever reads **`data.json`** — it cannot talk
to Notion directly. Something has to regenerate `data.json` from the Notion doc and push
it; the open page polls `data.json` every ~30s and re-prints.

## Source
- Notion page: **Ideas** — `https://app.notion.com/p/389f61b082dc815ebebde072a7eca965`
  (id `389f61b0-82dc-815e-bebd-e072a7eca965`).

## Auto-sync (primary) — GitHub Actions
`.github/workflows/sync.yml` runs `sync_notion.py` on a schedule (every ~15 min) and on
manual dispatch. It works even when your Mac is off. Setup (one-time):
1. Create a Notion **internal integration** at <https://www.notion.so/profile/integrations>
   and copy its **Internal Integration Secret**.
2. On the **Ideas** page: `•••` → **Connections** → connect the integration (so it can
   read the page).
3. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository
   secret**, name `NOTION_TOKEN`, value = the secret from step 1.

`sync_notion.py` (stdlib only) fetches the page's blocks via the Notion API, parses them
(see rule below), writes `data.json`, and the workflow commits & pushes only when it
changed. GitHub Pages redeploys within ~1 min and the phone page polls & re-prints.

## Manual sync (fallback) — "sync my ideas"
If you'd rather refresh on demand (or before the scheduled run), say **"sync my ideas"**:
`notion-fetch` the page → parse → overwrite `data.json` → `git commit && git push`.
You can also trigger the Action by hand from the repo's **Actions** tab → *Sync ideas
from Notion* → **Run workflow**.

## Parsing rule (used by both paths)
- A heading (`#`/`##`/`###`, or a `heading_1/2/3` block) starts a **new item**; its text
  is the `title` (strip `#`, `**`, `<br>`, `{toggle="true"}`, trailing `:`; trim).
- Bullets (`-`/`*`/`•`, or `bulleted/numbered_list_item` blocks) until the next heading
  become that item's `details`. For **toggle** headings the bullets are nested *children*
  of the heading block — `sync_notion.py` handles both cases.
- Ignore the intro paragraph above the first heading, images, dividers, and empty blocks.

## `data.json` shape (keep exactly — `app.js` depends on it)
```json
{
  "docTitle": "Ideas",
  "docUrl": "https://app.notion.com/p/389f61b082dc815ebebde072a7eca965",
  "syncedAt": "<ISO-8601 UTC>",
  "count": <n>,
  "items": [ { "title": "...", "details": ["...", "..."] } ]
}
```
`docUrl` is unused by the page (the "Open in Notion" button was removed); kept for reference.
