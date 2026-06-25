/* Cloudflare Worker — lets the receipt page add an idea straight to your Notion page.
 *
 * The Notion token NEVER touches the browser: the page POSTs { "title": "..." } here,
 * and the worker (holding the secret server-side) appends a heading_2 block to the
 * Ideas page. The block is picked up by the normal GitHub Actions sync into data.json.
 *
 * --- one-time setup (free Cloudflare account) ---------------------------------
 *   1. npm i -g wrangler   &&   wrangler login
 *   2. wrangler deploy worker.js --name idea-receipt-add
 *   3. wrangler secret put NOTION_TOKEN          # paste your Notion integration secret
 *      wrangler secret put NOTION_PAGE_ID        # 389f61b0-82dc-815e-bebd-e072a7eca965
 *      wrangler secret put ALLOW_ORIGIN          # https://astrojainius1-rgb.github.io  (or *)
 *   4. Copy the deployed https://idea-receipt-add.<you>.workers.dev URL into the app's
 *      ⚙ settings → "Add-idea sync URL".
 * ----------------------------------------------------------------------------- */
const NOTION_VERSION = "2022-06-28";

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);

    let body;
    try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }
    const title = String(body.title || "").trim().slice(0, 200);
    if (!title) return json({ error: "empty title" }, 400, cors);

    if (!env.NOTION_TOKEN || !env.NOTION_PAGE_ID) {
      return json({ error: "worker not configured (NOTION_TOKEN / NOTION_PAGE_ID)" }, 500, cors);
    }

    const res = await fetch(`https://api.notion.com/v1/blocks/${env.NOTION_PAGE_ID}/children`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        children: [{
          object: "block",
          type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: title } }] },
        }],
      }),
    });

    if (!res.ok) return json({ error: "notion " + res.status, detail: await res.text() }, 502, cors);
    return json({ ok: true, title }, 200, cors);
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
