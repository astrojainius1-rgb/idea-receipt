/* Cloudflare Worker — reliably triggers the GitHub "Sync ideas from Notion" workflow.
 *
 * GitHub's own scheduled Actions are best-effort and frequently skip; Cloudflare's cron
 * triggers are dependable. This worker fires on a cron (see wrangler.toml) and calls
 * GitHub's workflow_dispatch API so the sync runs on time. The GitHub token lives as a
 * Worker secret — never in the app or the repo.
 *
 * It can also be triggered over HTTP (e.g. when you open the app) — gated by a shared key
 * so the endpoint can't be abused to burn your Actions minutes.
 *
 * --- one-time setup -----------------------------------------------------------
 *   1. Create a GitHub fine-grained token (https://github.com/settings/personal-access-tokens):
 *        Resource owner: astrojainius1-rgb · Only select repos: idea-receipt
 *        Repository permissions → Actions: Read and write  → Generate, copy the token.
 *   2. npm i -g wrangler   &&   wrangler login
 *   3. From this folder:   wrangler deploy        (uses wrangler.toml: name, cron, vars)
 *   4. wrangler secret put GH_TOKEN               # paste the token from step 1
 *      wrangler secret put TRIGGER_KEY            # any random string (only if you want the
 *                                                 #   HTTP trigger; can skip for cron-only)
 *   Done — Cloudflare now fires the sync every 10 min. Check it with:
 *      wrangler tail        (live logs)   or the worker's URL: https://<name>.<you>.workers.dev/?key=...
 * ----------------------------------------------------------------------------- */

export default {
  // reliable cron trigger (schedule defined in wrangler.toml)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },

  // optional HTTP trigger (e.g. the app can ping this on open) — requires ?key=TRIGGER_KEY
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*" };
    const url = new URL(req.url);
    if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY) {
      return json({ error: "unauthorized" }, 401, cors);
    }
    const res = await dispatch(env);
    return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502, cors);
  },
};

async function dispatch(env) {
  const owner = env.GH_OWNER, repo = env.GH_REPO, wf = env.GH_WORKFLOW || "sync.yml";
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${wf}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "idea-receipt-sync-worker",
      },
      body: JSON.stringify({ ref: env.GH_REF || "main" }),
    }
  );
  if (!res.ok) console.log("dispatch failed:", res.status, await res.text());
  return res;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
