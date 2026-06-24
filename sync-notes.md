# How the sync works (manual — run on request)

The web page (`index.html` + `app.js`) only ever reads **`data.json`**. It cannot talk
to Notion directly. There is **no scheduled task** — syncing is on demand: when the user
says **"sync my ideas"**, regenerate `data.json` from the Notion doc and push it. The
open page polls `data.json` every ~30s (and on refocus) and re-prints.

## Source
- Notion page: **Ideas** — `https://app.notion.com/p/389f61b082dc815ebebde072a7eca965`
  (id `389f61b0-82dc-815e-bebd-e072a7eca965`).

## Sync steps (what to do on each "sync my ideas" request)
1. Fetch the page with the Notion connector (`notion-fetch` with the id/URL above).
2. Parse the returned enhanced-markdown into receipt line items:
   - A line starting with `#`, `##`, or `###` starts a **new item**. The `title` is that
     line with these stripped: leading `#`s, `**` bold markers, `<br>`, and the
     `{toggle="true"}` suffix. Trim whitespace and trailing `:`.
   - Subsequent lines that are bullets (`-`, `*`, `•`) — until the next heading — become
     that item's `details` (strip the bullet marker, `**` bold, and `` ` `` backticks; trim).
   - Ignore the intro paragraph above the first heading, `<empty-block/>`, raw image
     URLs/markdown images, and blank lines.
3. `count` = number of items.
4. Overwrite `data.json` with:
   ```json
   {
     "docTitle": "Ideas",
     "docUrl": "https://app.notion.com/p/389f61b082dc815ebebde072a7eca965",
     "syncedAt": "<current ISO-8601 UTC timestamp>",
     "count": <n>,
     "items": [ { "title": "...", "details": ["...", "..."] } ]
   }
   ```
5. Deploy: from `idea-receipt/`, push the updated `data.json` to the GitHub Pages repo
   (via the GitHub connector, or `git add data.json && git commit -m "sync ideas" && git push`).
   Pages serves the new file within ~1 min; the phone page polls and re-prints.

## Notes
- Keep the JSON shape exactly as above — `app.js` depends on it. `docUrl` is unused by
  the page (the "Open in Notion" button was removed) but is kept for reference.
- The receipt store name is `docTitle` upper-cased ("IDEAS").
