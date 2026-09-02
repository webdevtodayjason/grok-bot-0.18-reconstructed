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
const LOCAL_ONLY = process.argv.includes("--local-only");
const agent = (await call("listAgents")).find((a) => !a.isGroup && !String(a.name ?? "").startsWith("verify-"));
const id = agent.id, automationId = LOCAL_ONLY ? "verify-local-schedule-probe" : "verify-run-probe";

// --local-only proves the box fires a SCHEDULED routine by itself. Cron triggers are routed to the
// cloud by shouldScheduleLocally, and on a self-hosted box there is no cloud -- so before the local
// schedule tick existed, the countdown ran down and nothing ever ran. Nothing here presses Test run:
// an every-minute schedule is created, enabled, and left alone.
if (LOCAL_ONLY) {
  await call("deleteAgentAutomation", { id, automationId }).catch(() => {});
  await call("createAgentAutomation", { id, spec: { name: automationId,
    prompt: "Reply with the single word TICK.", isEnabled: true,
    trigger: { type: "cron", schedule: "* * * * *" } } });
  let fired = null;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = (await call("getAgentAutomations", { id })).find((x) => x.id === automationId);
    const runs = r?.runs ?? [];
    if (runs.length > 0) { fired = runs.at(-1); break; }
  }
  await call("deleteAgentAutomation", { id, automationId }).catch(() => {});
  if (fired == null) {
    console.error("FAIL — a scheduled routine never fired locally");
    process.exit(1);
  }
  // The run is labelled `manual` because the tick reuses runAgentAutomationNow, the same path the
  // Test-run button uses. Nothing in this branch pressed it: the fire came from the clock. The label
  // is inherited, not evidence of a manual trigger.
  console.log(`PASS — scheduled routine fired locally with no manual trigger `
    + `(run label "${fired.trigger}" is inherited from the shared fire path; status=${fired.status})`);
  process.exit(0);
}

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
