// What the model is actually offered, measured rather than inferred.
//
// Until this existed, the only way to read the offered toolset was a temporary tap inside the
// inference client plus a bundle rebuild (docs/audit-wave3-wire.md), so "34 tools" was a claim
// nobody could re-check. The host now writes one `[sand][toolset]` line per tool build and a
// report of which sections the assembled system prompt carried, both behind the operator switch
// SAND_TOOL_TRACE (read per call from a host settings file, so no recreate and no restart). It turns
// that switch on, drives one real turn, reads the line back out of the box, and asserts.
//
// The switch file is /home/box/sand-data/sand-host-settings.json, NOT box-secrets.json: `SAND_`
// is a reserved box-secret prefix, and one reserved key in box-secrets.json makes the applier
// drop every real secret at host start.
//
//   node scripts/verify-toolset.mjs              chief: the pair is offered, prompt has its sections
//   node scripts/verify-toolset.mjs --connector  a real CallMcpTool round trip, stamped evidenced
//   node scripts/verify-toolset.mjs --subagent   a computerUse subagent is offered 3 tools
//
// Integration check, not a unit test: needs the box up and a provider configured.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const SETTINGS = "/home/box/sand-data/sand-host-settings.json";
const PROMPT_REPORTS = "/home/box/sand-data";
const MODE = process.argv.includes("--connector")
  ? "connector"
  : process.argv.includes("--subagent") ? "subagent" : "chief";
const flag = (name, fallback) => (process.argv.includes(name)
  ? process.argv[process.argv.indexOf(name) + 1]
  : fallback);
const DEFAULT_TIMEOUT_MS = MODE === "chief" ? 180000 : 420000;
const requestedTimeoutMs = Number.parseInt(flag("--timeout-ms", String(DEFAULT_TIMEOUT_MS)), 10);
if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
  console.warn(`--timeout-ms was not a positive number; using the ${MODE} default of ${DEFAULT_TIMEOUT_MS}ms`);
}
const TIMEOUT_MS = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
  ? requestedTimeoutMs
  : DEFAULT_TIMEOUT_MS;
const KEEP = process.argv.includes("--keep");

function token() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {}
  }
  throw new Error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS");
}

const TOKEN = token();
const call = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};

const docker = (args) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(out))));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The switch is a host setting file, not container env, precisely so it can be flipped on a
// running box. Flip it, and put it back the way it was on the way out. The file need not exist:
// a missing or unparseable one means "no overrides", and the write creates it.
const readTrace = async () => {
  const raw = await docker(["exec", BOX, "sh", "-c", `cat ${SETTINGS} 2>/dev/null || echo '{}'`]);
  try { return JSON.parse(raw).SAND_TOOL_TRACE; } catch { return undefined; }
};
const writeTrace = async (value) => {
  const mutate = value == null
    ? `delete d.SAND_TOOL_TRACE;`
    : `d.SAND_TOOL_TRACE=${JSON.stringify(value)};`;
  await docker(["exec", BOX, "node", "-e",
    `const fs=require('fs');const p=${JSON.stringify(SETTINGS)};`
    + `let d={};try{const parsed=JSON.parse(fs.readFileSync(p,'utf8'));`
    + `if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))d=parsed;}catch{}`
    + `${mutate}fs.writeFileSync(p,JSON.stringify(d),{mode:0o600});`]);
};

const hostLogLines = async () =>
  Number.parseInt((await docker(["exec", BOX, "sh", "-c", "wc -l < /tmp/sand-host.log"])).trim(), 10);

// Every toolset line the host wrote after `from`, newest last.
const traceLinesSince = async (from) => {
  const out = await docker(["exec", BOX, "sh", "-c",
    `tail -n +${from + 1} /tmp/sand-host.log | grep -F '[sand][toolset]' || true`]);
  return out.split("\n").flatMap((line) => {
    const at = line.indexOf("[sand][toolset] ");
    if (at < 0) return [];
    try { return [JSON.parse(line.slice(at + "[sand][toolset] ".length))]; } catch { return []; }
  });
};

const spoken = (entries) => entries.filter((entry) => entry.kind === "send-message");

const freshAgent = async (name) => {
  const made = await call("createAgent", {
    name, description: "", origin: "user", isKickstartRequested: false,
  });
  const agent = made?.agent ?? made;
  if (agent?.id == null) throw new Error("createAgent returned no agent");
  return agent;
};

const cleanUp = async (agentId) => {
  if (KEEP || agentId == null) return;
  await call("deleteAgent", { id: agentId }).catch(() => {});
};

// Throw rather than exit: the finally below still has to delete the probe agent and put the
// operator's SAND_TOOL_TRACE back the way it found it, and process.exit skips finally blocks.
class VerificationFailed extends Error {}
const fail = (message) => { throw new VerificationFailed(message); };

const previousTrace = await readTrace();
if (previousTrace !== "1") await writeTrace("1");
let agent;
try {
  if (MODE === "chief" || MODE === "subagent") {
    const wantSubagent = MODE === "subagent";
    agent = await freshAgent(`verify-toolset-${Math.random().toString(36).slice(2, 8)}`);
    const from = await hostLogLines();
    await call("sendPrompt", {
      agentId: agent.id,
      prompt: wantSubagent
        ? "Dispatch one computerUse subagent whose only job is to take a single screenshot of "
          + "your box desktop and report what it sees. Do not do it yourself."
        : "Reply with the single word READY.",
    });

    const deadline = Date.now() + TIMEOUT_MS;
    let chief;
    let boxScoped;
    while (Date.now() < deadline) {
      await sleep(4000);
      const lines = await traceLinesSince(from);
      chief = lines.find((line) => line.conversationId === agent.id && !line.isSubagentRunner);
      boxScoped = lines.find((line) => line.isBoxScopedSubagent && line.isComputerUseSubagent);
      if (chief != null && (!wantSubagent || boxScoped != null)) break;
    }
    if (chief == null) fail("no [sand][toolset] line for the chief; is SAND_TOOL_TRACE readable in the box?");

    console.log(`chief offered ${chief.count} tools:`);
    console.log(`  ${chief.tools.join(", ")}`);
    console.log(`Task subagent types: ${chief.subagentTypes.join(", ") || "(none)"}`);
    const missing = ["GetMcpTools", "CallMcpTool"].filter((name) => !chief.tools.includes(name));
    if (missing.length > 0) fail(`the MCP meta pair is still withheld: missing ${missing.join(", ")}`);

    // The host never writes the prompt itself out (it carries the user's memory, and every
    // agent on this box shares a filesystem) -- it reports which sections it carried.
    const readPromptReport = async (id) => {
      const raw = await docker(["exec", BOX, "sh", "-c",
        `cat ${PROMPT_REPORTS}/sand-system-prompt-${id}.json 2>/dev/null || true`]);
      try { return JSON.parse(raw); } catch { return null; }
    };
    const report = await readPromptReport(agent.id);
    if (report == null) fail("no assembled system prompt report was written for this agent");
    const present = Object.entries(report.sections ?? {})
      .filter(([, has]) => has === true).map(([name]) => name);
    console.log(`assembled system prompt: ${report.length} chars; sections present: `
      + `${present.join(", ") || "(none)"}`);
    const absent = ["memory", "routines"].filter((name) => report.sections?.[name] !== true);
    if (absent.length > 0) {
      fail(`the assembled prompt is still missing the ${absent.join(" and ")} section(s)`);
    }

    if (wantSubagent) {
      if (boxScoped == null) fail("no box-scoped computerUse toolset line; the dispatch never ran");
      console.log(`computerUse subagent offered ${boxScoped.count} tools: ${boxScoped.tools.join(", ")}`);
      if (boxScoped.count !== 3) fail(`computerUse subagent offered ${boxScoped.count} tools, expected 3`);
      // A box-scoped subagent must get a box-scoped PROMPT too, not the chief's: the time-zone
      // section is the marker getTimeZoneSection() suppresses for exactly this runner.
      const childReport = boxScoped.conversationId == null
        ? null
        : await readPromptReport(boxScoped.conversationId);
      if (childReport == null) {
        console.log("computerUse subagent prompt report: not written before the poll ended");
      } else {
        console.log(`computerUse subagent prompt: ${childReport.length} chars; sections present: `
          + `${Object.entries(childReport.sections ?? {}).filter(([, has]) => has === true)
            .map(([name]) => name).join(", ") || "(none)"}`);
        if (childReport.sections?.timeZone === true) {
          fail("the box-scoped subagent was handed the chief's prompt (time-zone section present)");
        }
      }
    }
    console.log(`PASS — ${MODE}`);
  }

  if (MODE === "connector") {
    const servers = await call("listRoutedMcpTools").catch(() => []);
    const names = [...new Set(servers.map((tool) => tool.providerIdentifier))];
    console.log(`routed connector tools: ${servers.length} across ${names.join(", ") || "(none)"}`);
    if (servers.length === 0) fail("no connector tools are routed; nothing to prove");

    agent = await freshAgent(`verify-mcp-${Math.random().toString(36).slice(2, 8)}`);
    // "verbatim" is test hygiene, not a thumb on the scale: the evidence rule is literal
    // containment (docs/EVIDENCE-CONTRACT.md), so a reply that helpfully rewrites
    // `proof-123.txt` as `/workspace/proof-123.txt` is stamped `unsupported` for a token the
    // tool never returned. Asking for the names as the tool gave them tests the plumbing
    // rather than the model's formatting taste. The receipt assertion below is unaffected.
    await call("sendPrompt", {
      agentId: agent.id,
      prompt: "Use your MCP tools to list the files under /workspace and tell me how many there "
        + "are. Give the entry names exactly as the tool returned them, with no path prefix added.",
    });

    // CallMcpTool's outline row is named for the generated tool call, `mcpToolCall`; the
    // discovery half shows up as `getMcpToolsToolCall`. Both must be the real pair, so the row
    // also has to name a connector server in its arguments.
    const deadline = Date.now() + TIMEOUT_MS;
    let reply;
    let mcpRow;
    while (Date.now() < deadline) {
      await sleep(6000);
      const outline = await call("getConversationOutline", { id: agent.id }).catch(() => []);
      mcpRow = (Array.isArray(outline) ? outline : []).find((row) =>
        row.kind === "tool-call"
        && /^(mcpToolCall|callMcpToolToolCall)$/i.test(String(row.name ?? ""))
        && names.some((server) => String(row.summary ?? "").includes(server)));
      const running = (await call("listAgents")).find((a) => a.id === agent.id)?.isRunning === true;
      reply = spoken(await call("getAgentTranscript", { id: agent.id })).at(-1);
      if (mcpRow != null && reply != null && !running) break;
    }
    if (mcpRow == null) fail("no CallMcpTool row in the conversation outline; the model never reached the connector");
    console.log(`CallMcpTool receipt: ${mcpRow.name} status=${mcpRow.status} ${String(mcpRow.summary ?? "").slice(0, 160)}`);
    if (reply == null) fail("the agent called the connector but never delivered a reply");
    console.log(`reply: ${String(reply.message?.content ?? "").slice(0, 200)}`);
    const verdict = reply.evidence?.verdict;
    console.log(`evidence verdict: ${verdict ?? "no stamp"}`);
    if (verdict !== "evidenced") {
      fail(`reply verdict is ${verdict ?? "absent"}, expected evidenced`
        + `${reply.evidence?.missing?.length ? ` (missing ${reply.evidence.missing.slice(0, 3).join(", ")})` : ""}`);
    }
    console.log("PASS — connector");
  }
} catch (error) {
  if (!(error instanceof VerificationFailed)) throw error;
  console.error(`FAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanUp(agent?.id);
  if (previousTrace !== "1") await writeTrace(previousTrace).catch(() => {});
}
