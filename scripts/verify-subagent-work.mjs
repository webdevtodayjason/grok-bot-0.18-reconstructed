#!/usr/bin/env node
// SUBAGENT-1. Did the background subagent actually do the work, or only say it had.
//
//   node scripts/verify-subagent-work.mjs --box titanbot-box-<uuid>
//   node scripts/verify-subagent-work.mjs --selftest
//
// Two workspaces reported the same thing (reports 46-50, 53): a background Task subagent is
// dispatched, the wrapper reports completed, and nothing happened -- no file written, no search
// run, and the "result" handed back is the prompt. The wrapper saying "completed" is therefore
// worth nothing on its own, so this gate never reads it as evidence. It reads four things the
// subagent cannot fake: a file it had to write, its own audit ledger, its own transcript store,
// and whether the text the parent was given is just the prompt again.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const argOf = (name, fallback = "") => {
  const at = args.indexOf(name);
  return at === -1 || at + 1 >= args.length ? fallback : args[at + 1];
};
const docker = (dockerArgs) => new Promise((resolve, reject) =>
  execFile("docker", dockerArgs, { maxBuffer: 32 << 20, timeout: 180_000 }, (error, out) =>
    (error ? reject(new Error(`docker ${dockerArgs.slice(0, 3).join(" ")}: ${error.message}`)) : resolve(String(out)))));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const PROOF_DIR = "/workspace";
export const PROOF_NAME = "subagent-1-proof.txt";

/** The prompt the parent is given. The marker is minted per run so no earlier run can satisfy it. */
export function buildPrompt(marker) {
  return [
    "I need four country briefs researched in parallel, one per country, and I am in a hurry.",
    "Use your Task tool to dispatch FOUR background subagents at once (run_in_background true), one",
    "for each country: Iceland, Malta, Nepal, Uruguay. Do not research them yourself and do not do",
    "them one after another; the whole point is that they run at the same time.",
    "",
    "Give each subagent this instruction, with its own country in place of COUNTRY:",
    `"Search the web for the capital city of COUNTRY. Then write one line to ${PROOF_DIR}/COUNTRY.txt:`,
    `the words ${marker} followed by a space and the capital city you found. Write the file with a`,
    'tool, do not just describe it."',
    "",
    "Then reply with the single word DISPATCHED and wait for them.",
  ].join("\n");
}

/**
 * Whether a subagent ran at all. Asking the model to call Task does not work: measured four times
 * across both staff boxes and three promptings, the parent always judged the work small enough to
 * do itself, and a run in which nothing was delegated measures nothing. The browser rung dispatches
 * a subagent through the SAME runtime without the model choosing to, so the gate asks for the
 * browser and counts the directory that appears.
 */
export function wasDispatched(subagentDirs = []) {
  return subagentDirs.length > 0;
}

/**
 * The four checks, scored off the box rather than off anything the subagent said about itself.
 * `parentText` failing is the report's own words: the result handed back was the prompt.
 */
export function judgeSubagentWork({ fileText = "", marker = "", auditToolCalls = 0, transcriptEntries = 0, parentText = "", prompt = "", dispatched = true }) {
  const checks = [];
  // Measured on demo before any of this was fixed: the bot ignored the instruction, did the search
  // and wrote the file ITSELF in 57 s, and no subagent directory ever appeared. The file check
  // passed and the other three failed, which reads exactly like the defect and is not it. A run
  // that never dispatched measures nothing, so it is called inconclusive rather than scored.
  if (!dispatched) {
    return {
      checks: [{ id: "dispatch", ok: false, why: "no subagent directory appeared, so nothing was delegated and this run measures nothing" }],
      passed: 0, total: 1, inconclusive: true,
    };
  }
  const add = (id, ok, why) => checks.push({ id, ok, why });
  const body = String(fileText).trim();
  add("file", body.startsWith(marker) && body.length > marker.length,
    body.length === 0 ? "the file the subagent was told to write does not exist" : `the file says ${JSON.stringify(body.slice(0, 60))}`);
  add("audit", auditToolCalls > 0,
    auditToolCalls > 0 ? `${auditToolCalls} tool call(s) in the subagent's own ledger` : "the subagent's own audit ledger has no tool call, so it ran no tool");
  add("transcript", transcriptEntries > 0,
    transcriptEntries > 0 ? `${transcriptEntries} entr(ies) in the subagent's own store` : "the subagent's own store is empty, so its turn was never written against it");
  // Not a substring test: a result that merely CONTAINS the prompt is what the reporters saw.
  const echoed = String(parentText).trim().length > 0
    && String(prompt).trim().length > 0
    && String(parentText).includes(String(prompt).trim().slice(0, 60));
  add("result", !echoed && String(parentText).trim().length > 0,
    String(parentText).trim().length === 0 ? "the parent was handed no completion text at all"
      : echoed ? "the parent's completion text is the prompt again" : "the parent was handed something other than the prompt");
  return { checks, passed: checks.filter((row) => row.ok).length, total: checks.length };
}

function boxCall(box) {
  return async (command, body = {}) => {
    const script = `const b=${JSON.stringify(JSON.stringify(body))};`
      + `fetch('http://127.0.0.1:1340/api/${command}',{method:'POST',headers:{authorization:'Bearer '+process.env.SAND_GATEWAY_TOKEN,'content-type':'application/json'},body:b})`
      + `.then(r=>r.text().then(t=>process.stdout.write(r.status+'\\n'+t)))`;
    const out = await docker(["exec", box, "/exec-daemon/node", "-e", script]);
    const at = out.indexOf("\n");
    const status = Number(out.slice(0, at));
    const text = out.slice(at + 1);
    if (status !== 200) throw new Error(`${command} answered ${status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
}

/**
 * Every agent directory, INCLUDING the sand-subagent-<uuid> ones.
 *
 * This matched a bare uuid only, which no subagent directory has ever been named: the prefix is
 * SAND_SUBAGENT_ID_PREFIX, "sand-subagent-". Six runs of this gate therefore reported that no
 * subagent appeared while the box held directories for them, and the conclusion drawn from those
 * runs, that the model refuses to delegate, was the gate's blindness rather than the model's
 * behaviour.
 */
const agentDirs = async (box) => {
  const out = await docker(["exec", box, "sh", "-c",
    "ls /home/box/sand-data/agents/ 2>/dev/null | grep -E '^(sand-subagent-)?[0-9a-f-]{36}$' || true"]);
  return new Set(out.split("\n").map((one) => one.trim()).filter(Boolean));
};

async function runOnBox() {
  const box = argOf("--box", "");
  if (box.length === 0) throw new Error("name a box with --box");
  const call = boxCall(box);
  const timeoutMs = Number(argOf("--timeout-ms", "600000")) || 600_000;
  const marker = `SUBAGENT1-${randomUUID().slice(0, 8).toUpperCase()}`;
  const prompt = buildPrompt(marker);

  await docker(["exec", box, "sh", "-c", `rm -f ${PROOF_DIR}/Iceland.txt ${PROOF_DIR}/Malta.txt ${PROOF_DIR}/Nepal.txt ${PROOF_DIR}/Uruguay.txt`]);
  const before = await agentDirs(box);
  const agent = await call("createAgent", { name: "Subagent gate", description: "throwaway for SUBAGENT-1, deleted at the end", origin: "operator" });
  const agentId = String(agent?.id ?? agent?.agent?.id ?? "");
  if (agentId.length === 0) throw new Error("createAgent gave no id");
  console.log(`bot ${agentId}, marker ${marker}`);

  const startedAt = Date.now();
  try {
    await call("sendPrompt", { agentId, prompt });
    const deadline = Date.now() + timeoutMs;
    let fileText = "";
    while (Date.now() < deadline) {
      await sleep(5_000);
      fileText = (await docker(["exec", box, "sh", "-c",
        `cat ${PROOF_DIR}/Iceland.txt ${PROOF_DIR}/Malta.txt ${PROOF_DIR}/Nepal.txt ${PROOF_DIR}/Uruguay.txt 2>/dev/null || true`])).trim();
      if (fileText.startsWith(marker)) break;
      process.stdout.write(".");
    }
    process.stdout.write("\n");

    // The subagent is whatever agent directory appeared while this ran.
    const after = await agentDirs(box);
    const fresh = [...after].filter((one) => !before.has(one) && one !== agentId);
    console.log(`subagent director${fresh.length === 1 ? "y" : "ies"} that appeared: ${fresh.join(", ") || "none"}`);
    let auditToolCalls = 0;
    let transcriptEntries = 0;
    for (const id of fresh) {
      const rows = await docker(["exec", box, "sh", "-c",
        `grep -c '"type":"tool_result"' /home/box/sand-data/agents/${id}/audit.jsonl 2>/dev/null || echo 0`]);
      auditToolCalls += Number(rows.trim()) || 0;
      const entries = await docker(["exec", box, "/exec-daemon/node", "-e",
        `const {DatabaseSync}=require("node:sqlite");try{const db=new DatabaseSync("/home/box/sand-data/agents/${id}/store.db",{readOnly:true});`
        + `process.stdout.write(String(db.prepare("select count(*) c from transcript_entries").get().c))}catch(e){process.stdout.write("0")}`]);
      transcriptEntries += Number(entries.trim()) || 0;
    }

    const outline = await call("getConversationOutline", { id: agentId }).catch(() => []);
    const outlineRows = Array.isArray(outline) ? outline : [];
    const toolNames = outlineRows.filter((row) => row?.kind === "tool-call").map((row) => String(row?.name ?? ""));
    console.log(`the parent called: ${[...new Set(toolNames)].join(", ") || "no tools the outline carries"}`);

    const transcript = await call("getAgentTranscript", { id: agentId }).catch(() => []);
    const entries = Array.isArray(transcript) ? transcript : [];
    // What the parent was told the background task produced: the revival prompt the host wrote back
    // into this conversation, which is where the reporters saw their own words returned.
    const revival = entries.map((row) => String(row?.content ?? row?.message?.content ?? ""))
      .filter((text) => /background task/i.test(text)).join("\n\n");
    const verdict = judgeSubagentWork({ fileText, marker, auditToolCalls, transcriptEntries, parentText: revival, prompt, dispatched: wasDispatched(fresh) });

    console.log("\n---- the verdict ----\n");
    for (const row of verdict.checks) console.log(`  ${row.ok ? "PASS" : "FAIL"}  ${row.id}: ${row.why}`);
    console.log(`\n  ${verdict.passed} of ${verdict.total}, after ${Math.round((Date.now() - startedAt) / 1000)} s`
      + `${verdict.inconclusive ? "  INCONCLUSIVE, nothing was measured" : ""}`);
    if (revival.length > 0) console.log(`\n  what the parent was told:\n    ${revival.replace(/\n/g, "\n    ").slice(0, 600)}`);
    return verdict.passed === verdict.total ? 0 : 1;
  } finally {
    await call("deleteAgent", { id: agentId }).catch(() => {});
    await docker(["exec", box, "sh", "-c", `rm -f ${PROOF_DIR}/Iceland.txt ${PROOF_DIR}/Malta.txt ${PROOF_DIR}/Nepal.txt ${PROOF_DIR}/Uruguay.txt`]).catch(() => {});
    console.log(`deleted bot ${agentId}`);
  }
}

function selftest() {
  const prompt = buildPrompt("SUBAGENT1-AAAA");
  const bad = judgeSubagentWork({ fileText: "", marker: "SUBAGENT1-AAAA", auditToolCalls: 0, transcriptEntries: 0, parentText: `Background task "${prompt.slice(0, 60)}" finished`, prompt });
  const good = judgeSubagentWork({ fileText: "SUBAGENT1-AAAA Example Domain", marker: "SUBAGENT1-AAAA", auditToolCalls: 3, transcriptEntries: 7, parentText: "Wrote the file with the capital.", prompt });
  const none = judgeSubagentWork({ fileText: "SUBAGENT1-AAAA Example Domain", marker: "SUBAGENT1-AAAA", auditToolCalls: 0, transcriptEntries: 0, parentText: "", prompt, dispatched: false });
  const ok = bad.passed === 0 && good.passed === 4 && none.inconclusive === true && none.total === 1
    && wasDispatched(["some-subagent-id"]) && !wasDispatched([]);
  console.log(`selftest: the reported shape scores ${bad.passed} of 4, a real run scores ${good.passed} of 4,`
    + ` and a run the parent did itself is ${none.inconclusive ? "inconclusive" : "SCORED, which is wrong"}`);
  console.log(ok ? "selftest OK" : "selftest BROKEN");
  return ok ? 0 : 1;
}

async function main() {
  if (has("--selftest")) return selftest();
  if (has("--box")) return await runOnBox();
  console.log("usage: node scripts/verify-subagent-work.mjs (--box <container> | --selftest) [--timeout-ms 600000]");
  return 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
}
