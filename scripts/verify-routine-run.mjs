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
// A probe of its own, not the first agent in the roster. This gate plants a routine and spends a
// model turn; doing that on whichever agent happens to sort first means writing to somebody's
// working agent and leaving a run in its history.
const made = await call("createAgent", { name: `probe-u2-routine-run-${Math.random().toString(36).slice(2, 7)}`, description: "", origin: "user", isKickstartRequested: false });
const agent = made?.agent ?? made;
if (agent?.id == null) { console.error("FAIL - createAgent returned no agent"); process.exit(1); }
const id = agent.id, automationId = LOCAL_ONLY ? "verify-local-schedule-probe" : "verify-run-probe";

class VerificationFailed extends Error {}
const fail = (message) => { throw new VerificationFailed(message); };
let failure = null;
let passed = null;

// Everything after the probe exists runs inside this try. The relay throws on any non-2xx answer
// and the polling below calls it for up to two and a half minutes, so a box restart mid-poll used
// to abort the script between createAgent and the cleanup. In --local-only that left behind an
// agent carrying an ENABLED every-minute routine, which the local schedule tick then fired as a
// paid model turn once a minute for as long as the box stayed up.
try {
  // --local-only proves the box fires a SCHEDULED routine by itself. Cron triggers are routed to
  // the cloud by shouldScheduleLocally, and on a self-hosted box there is no cloud, so before the
  // local schedule tick existed the countdown ran down and nothing ever ran. Nothing here presses
  // Test run: an every-minute schedule is created, enabled, and left alone.
  if (LOCAL_ONLY) {
    await call("deleteAgentAutomation", { id, automationId }).catch(() => {});
    await call("createAgentAutomation", { id, spec: { name: automationId,
      prompt: "Reply with the single word TICK.", isEnabled: true,
      trigger: { type: "cron", schedule: "* * * * *" } } });
    let fired = null;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const r = (await call("getAgentAutomations", { id })).find((x) => x.id === automationId);
      // The store returns runs newest first; reading from the end asserted on the oldest one.
      const runs = r?.runs ?? [];
      if (runs.length > 0) { fired = runs[0]; break; }
    }
    if (fired == null) fail("a scheduled routine never fired locally");
    // The label is the claim now, not an inherited one: the tick has its own entry point that
    // fires with trigger "schedule". scripts/verify-automations.mjs proves the rest of that path.
    if (fired.trigger !== "schedule")
      fail(`the clock's own fire was filed as "${fired.trigger}", not "schedule"`);
    passed = `scheduled routine fired locally with no manual trigger `
      + `(trigger=${fired.trigger} status=${fired.status})`;
  } else {
    await call("deleteAgentAutomation", { id, automationId }).catch(() => {});
    await call("createAgentAutomation", { id, spec: { name: automationId,
      prompt: "Reply with the single word TICK.", isEnabled: false,
      trigger: { type: "cron", schedule: "0 3 * * *" } } });
    // This used to answer 500 while still starting the run (an analytics call reaching for a value
    // that was not there). It answers cleanly now, so an error here is news: report it and keep
    // going, since the recorded run is what the assertion below is made of either way.
    await call("runAgentAutomationNow", { id, automationId }).catch((e) => console.log("(run kickoff:", e.message.slice(0, 60) + ")"));
    let record = null;
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 4000));
      const r = (await call("getAgentAutomations", { id })).find((x) => x.id === automationId);
      const runs = r?.runs ?? [];
      if (runs.length > 0 && runs[0].finishedAt != null) { record = runs[0]; break; }
    }
    if (record == null) fail("no finished run record appeared");
    passed = `run recorded: trigger=${record.trigger} status=${record.status} `
      + `dur=${record.finishedAt - record.startedAt}ms`;
  }
} catch (error) {
  failure = error;
} finally {
  await call("deleteAgentAutomation", { id, automationId }).catch(() => {});
  await call("deleteAgent", { id }).catch((error) =>
    console.log(`  INFO  probe agent ${id} NOT deleted: ${error.message}`));
}

if (failure != null) {
  console.error(`FAIL - ${failure instanceof VerificationFailed ? failure.message : failure.stack ?? failure}`);
  process.exit(1);
}
console.log(`PASS - ${passed}`);
process.exit(0);
