// Proves a routine leaves a visible run record end to end: create a throwaway routine,
// Test-run it, assert the host recorded the run, then clean up. Exit 0 only on a real record.
const RELAY = "http://127.0.0.1:7777";
const call = async (m, a = {}) => {
  const res = await fetch(`${RELAY}/api/${m}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
  const t = await res.text();
  if (!res.ok) throw new Error(`${m} -> ${res.status} ${t.slice(0, 160)}`);
  return JSON.parse(t);
};
const agent = (await call("listAgents")).find((a) => !a.isGroup);
const id = agent.id, automationId = "verify-run-probe";
await call("deleteAgentAutomation", { id, automationId }).catch(() => {});
await call("createAgentAutomation", { id, spec: { name: automationId,
  prompt: "Reply with the single word TICK.", isEnabled: false,
  trigger: { type: "cron", schedule: "0 3 * * *" } } });
// runAgentAutomationNow currently 500s on a known host defect but still starts the run;
// tolerate the error and verify by the recorded run instead.
await call("runAgentAutomationNow", { id, automationId }).catch((e) => console.log("(run kickoff:", e.message.slice(0, 60) + ")"));
let record = null;
for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 4000));
  const r = (await call("getAgentAutomations", { id })).find((x) => x.id === automationId);
  const runs = r?.runs ?? [];
  if (runs.length > 0 && runs.at(-1).finishedAt != null) { record = runs.at(-1); break; }
}
await call("deleteAgentAutomation", { id, automationId }).catch(() => {});
if (record == null) { console.error("FAIL — no finished run record appeared"); process.exit(1); }
console.log(`PASS — run recorded: trigger=${record.trigger} status=${record.status} ` +
  `dur=${record.finishedAt - record.startedAt}ms`);
process.exit(0);
