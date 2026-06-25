#!/usr/bin/env python3
"""Regenerate data.json from the Notion "Ideas" page.

Runs in GitHub Actions (see .github/workflows/sync.yml). Uses only the Python
standard library so no `pip install` is needed.

Parsing rule (mirrors sync-notes.md):
- A heading block (heading_1/2/3) starts a new receipt item; its text is the `title`.
- Bullets (bulleted/numbered list items) become that item's `details`. Bullets may be
  siblings after the heading, or — for toggle headings — children of the heading block.
- Everything else (the intro paragraph, images, dividers, empty blocks) is ignored.

Env:
  NOTION_TOKEN    Notion internal-integration secret (required).
  NOTION_PAGE_ID  The Ideas page id (defaults to the known page).
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

NOTION_VERSION = "2022-06-28"
API = "https://api.notion.com/v1"

TOKEN = os.environ.get("NOTION_TOKEN")
PAGE_ID = os.environ.get("NOTION_PAGE_ID", "389f61b0-82dc-815e-bebd-e072a7eca965")
PAGE_URL = "https://app.notion.com/p/" + PAGE_ID.replace("-", "")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")


def api_get(path):
    req = urllib.request.Request(
        API + path,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Notion-Version": NOTION_VERSION,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def plain_text(rich):
    return "".join(rt.get("plain_text", "") for rt in (rich or [])).strip()


def children(block_id):
    """All child blocks of a page/block, following pagination."""
    out, cursor = [], None
    while True:
        path = f"/blocks/{block_id}/children?page_size=100"
        if cursor:
            path += f"&start_cursor={cursor}"
        data = api_get(path)
        out.extend(data.get("results", []))
        if not data.get("has_more"):
            break
        cursor = data.get("next_start_cursor")
    return out


def bullets_from(blocks):
    details = []
    for b in blocks:
        t = b.get("type")
        if t in ("bulleted_list_item", "numbered_list_item"):
            txt = plain_text(b[t].get("rich_text"))
            if txt:
                details.append(txt)
    return details


def page_title():
    try:
        page = api_get(f"/pages/{PAGE_ID}")
        for prop in page.get("properties", {}).values():
            if prop.get("type") == "title":
                return plain_text(prop.get("title")) or "Ideas"
    except Exception:
        pass
    return "Ideas"


def build_items():
    items = []
    blocks = children(PAGE_ID)
    current = None
    for b in blocks:
        t = b.get("type", "")
        if t.startswith("heading_"):
            raw = plain_text(b[t].get("rich_text")).rstrip(":").strip()
            if not raw:
                current = None  # skip empty/placeholder headings
                continue
            # pull #hashtags out of the heading -> tags; the rest is the title
            tags = re.findall(r"#(\w[\w-]*)", raw)
            title = re.sub(r"\s*#\w[\w-]*", "", raw).strip() or raw
            current = {"title": title, "details": [], "added": b.get("created_time")}
            if tags:
                current["tags"] = tags
            items.append(current)
            # toggle headings nest their bullets as children
            if b.get("has_children"):
                current["details"].extend(bullets_from(children(b["id"])))
        elif t in ("bulleted_list_item", "numbered_list_item") and current is not None:
            txt = plain_text(b[t].get("rich_text"))
            if txt:
                current["details"].append(txt)
    return items


def main():
    if not TOKEN:
        sys.exit("NOTION_TOKEN is not set")
    items = build_items()
    data = {
        "docTitle": page_title(),
        "docUrl": PAGE_URL,
        "syncedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(items),
        "items": items,
    }
    with open(OUT, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {len(items)} item(s) to {OUT}")


if __name__ == "__main__":
    main()
