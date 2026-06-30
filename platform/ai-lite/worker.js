/* idea-receipt — MINIMAL standalone AI worker (Cloudflare).
 *
 * Powers exactly the two features wired into the app today:
 *   POST /expand  { title, body }                  -> { text }
 *   POST /digest  { ideas: [{title, details, added}] } -> { digest }
 *
 * No backend, no D1, no auth — it just relays to the Anthropic API. Holds the
 * ANTHROPIC_API_KEY server-side so it never touches the browser. Deploy it the same
 * way as sync-worker.js (Cloudflare dashboard), then paste its URL into the app's
 * ⚙ settings → "AI endpoint URL".
 *
 * --- setup (Cloudflare dashboard, ~5 min, no CLI) -----------------------------
 *   1. dash.cloudflare.com → Workers & Pages → Create → Create Worker → name it
 *      "idea-receipt-ai" → Deploy → Edit code → paste THIS file → Deploy.
 *   2. Settings → Variables and Secrets:
 *        Secret   ANTHROPIC_API_KEY = your key from console.anthropic.com
 *        Variable ALLOW_ORIGIN      = https://astrojainius1-rgb.github.io   (your site)
 *        Variable MODEL (optional)  = claude-haiku-4-5-20251001  (default; or claude-sonnet-4-6)
 *   3. Copy the worker URL (https://idea-receipt-ai.<you>.workers.dev) into the app:
 *        ⚙ settings → AI endpoint URL.
 *   Done — ✨ expand and "weekly digest" now work.
 * ----------------------------------------------------------------------------- */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "worker missing ANTHROPIC_API_KEY" }, 500, cors);

    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    let bodyIn;
    try { bodyIn = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }

    try {
      if (path.endsWith("/expand")) {
        const title = String(bodyIn.title || "").slice(0, 300);
        const notes = String(bodyIn.body || "").slice(0, 2000);
        if (!title) return json({ error: "empty idea" }, 400, cors);
        const text = await claude(env,
          "You are a sharp, concise product/creative thinker. Given a rough idea, return a tight brief: a one-line framing, then 3–5 concrete next steps, then one risk or open question. Use short lines. No preamble.",
          `Idea: ${title}\n${notes ? "Notes:\n" + notes : ""}`,
          500);
        return json({ text }, 200, cors);
      }
      if (path.endsWith("/digest")) {
        const ideas = Array.isArray(bodyIn.ideas) ? bodyIn.ideas : [];
        if (!ideas.length) return json({ digest: "No ideas to summarize yet — jot a few and check back." }, 200, cors);
        const lines = ideas.slice(0, 80).map((it) => {
          const d = Array.isArray(it.details) && it.details.length ? ` (${it.details.join("; ")})` : "";
          const when = it.added ? ` [${String(it.added).slice(0, 10)}]` : "";
          return `- ${it.title || "untitled"}${d}${when}`;
        }).join("\n");
        const digest = await claude(env,
          "You are the user's idea companion writing a short weekly digest. From the idea list, write: a one-line vibe of the week, 2–3 themes you notice (group related ideas), and ONE concrete nudge. Warm, brief, concrete. No preamble, no markdown headers.",
          `Today is roughly now. The user's ideas:\n${lines}`,
          450);
        return json({ digest }, 200, cors);
      }
      return json({ error: "unknown path (use /expand or /digest)" }, 404, cors);
    } catch (e) {
      return json({ error: "ai_unavailable", detail: String(e && e.message || e) }, 502, cors);
    }
  },
};

async function claude(env, system, user, maxTokens) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.MODEL || "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error("anthropic " + res.status + " " + (await res.text()).slice(0, 200));
  const data = await res.json();
  return (data.content || []).map((c) => c.text || "").join("").trim();
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
