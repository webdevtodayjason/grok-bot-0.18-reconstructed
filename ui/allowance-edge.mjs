// Small, testable policy seam used by the relay before it starts model-backed work.

export const MODEL_START_COMMANDS = new Set([
  "sendPrompt", "runAgentWorkflowNow", "runAgentAutomationNow", "kickstartAgent",
]);

export function allowanceRefusal(answer) {
  return {
    error: "allowance",
    resetsAt: answer?.cycle?.endsAt ?? null,
    daysLeft: answer?.cycle?.daysLeft ?? null,
  };
}

export function createAllowanceReader({ cpUrl = "", relayToken = "", fetchImpl = globalThis.fetch, now = () => Date.now(), cacheMs = 60_000 } = {}) {
  const cache = new Map();
  return async function readAllowance(slug) {
    if (!cpUrl || !relayToken) return null;
    const hit = cache.get(slug);
    if (hit != null && now() - hit.at < cacheMs) return hit.answer;
    try {
      const response = await fetchImpl(`${cpUrl}/v1/tenants/${encodeURIComponent(slug)}/allowance`, {
        headers: { authorization: `Bearer ${relayToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      const answer = await response.json();
      cache.set(slug, { at: now(), answer });
      return answer;
    } catch { return null; }
  };
}
