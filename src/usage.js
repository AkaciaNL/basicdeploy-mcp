// Fire-and-forget per-tool call counter.
//
// Batches tool-call counts in memory and periodically flushes them to the
// backend's internal usage endpoint. EVERY path here is wrapped so it can never
// throw into a tool call — analytics must not break the product. When the
// internal endpoint isn't configured (stdio / local npx), it's a silent no-op,
// so the published npm package behaves exactly as before.
const INTERNAL_URL = (process.env.BASICDEPLOY_INTERNAL_URL || "").replace(/\/+$/, "");
const INTERNAL_SECRET = process.env.MCP_INTERNAL_SECRET || "";
const ENABLED = Boolean(INTERNAL_URL && INTERNAL_SECRET);

// Keyed by tool name; bounded by the tool count (~14), so this never grows large.
const counts = new Map();

/** Record one invocation of a tool. Safe to call from anywhere; never throws. */
export function recordToolCall(name) {
  try {
    if (!ENABLED || !name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  } catch {
    /* analytics must never break a tool call */
  }
}

async function flush() {
  if (!ENABLED || counts.size === 0) return;
  let calls;
  try {
    calls = Object.fromEntries(counts);
    counts.clear();
  } catch {
    return;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(`${INTERNAL_URL}/api/internal/usage/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": INTERNAL_SECRET },
      body: JSON.stringify({ calls }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`usage flush HTTP ${resp.status}`);
  } catch {
    // Transient failure: re-queue the counts so nothing is lost. Bounded by the
    // small, fixed set of tool names.
    try {
      for (const [k, v] of Object.entries(calls)) {
        counts.set(k, (counts.get(k) || 0) + v);
      }
    } catch {
      /* give up silently */
    }
  }
}

if (ENABLED) {
  const timer = setInterval(flush, 15000);
  if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive
  const onExit = () => { flush(); };
  process.once("SIGTERM", onExit);
  process.once("SIGINT", onExit);
  process.once("beforeExit", onExit);
}
