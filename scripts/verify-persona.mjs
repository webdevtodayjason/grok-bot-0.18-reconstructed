// PERSONA-1. Does an agent tell the truth about itself and this workspace?
//
// The report this exists for, from one conversation between 22:49 on 2026-09-08 and 06:11 on
// 2026-09-09: the operator's lead agent said it had no email capability, that the workspace held
// "up to 12 more agents", that repository work goes to a cloud agent on the dead upstream, that
// the product was called something it is not, and that there is no first-run interview. Four of
// the five were live facts the box could have answered correctly; the fifth was a tool the same
// turn's toolset was withholding.
//
// So this gate does not check the prompt text. It asks a real agent the five questions, one at a
// time, and checks each ANSWER against what the box says about itself in the same run:
//
//   do you have email          -> getAgentMail's row for this agent (or its absence)
//   how many can we have       -> getAgentCapacity's maxAgents
//   where does coding go       -> names no outside vendor and says this box
//   what is this called        -> the literal Titanium Bot
//   did onboarding run         -> getOnboardingState's doneReason, and the retrigger phrase
//
// then says the retrigger phrase once and checks the interview actually starts. A phrase the
// prompt promises and nothing acts on is the same bug class as a fact being wrong.
//
// It mints its own scratch agent and deletes it pass or fail, so it never speaks for somebody's
// real bot. It asserts only the facts block: this box has 22 bots and no recorded lead, so the
// lead paragraph is not expected and its absence is not a failure.
//
//   timeout 300 node scripts/verify-persona.mjs --box grok-bot-local-vm
//
// It takes the shared box lock itself (scripts/on-box.sh) unless it is already inside one.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] != null ? argv[at + 1] : fallback;
};
const BOX = argOf("--box", process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm");
const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";

// ---------------------------------------------------------------- the shared box lock
// Gates share this box, its login throttle and its display, so they run one at a time. Re-exec
// under scripts/on-box.sh rather than making every caller remember, and mark the environment so
// the child does not do it again.
if (process.env.VERIFY_PERSONA_LOCKED !== "1") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(
    path.join(here, "on-box.sh"),
    [process.execPath, fileURLToPath(import.meta.url), ...argv],
    { stdio: "inherit", env: { ...process.env, VERIFY_PERSONA_LOCKED: "1" } },
  );
  child.on("exit", (code, signal) => process.exit(signal != null ? 1 : code ?? 1));
} else {
  await main();
}

async function main() {

// The whole run has to fit the 300s warden ceiling with the cleanup still inside it, so every
// wait is clamped against one budget rather than given its own.
const TOTAL_BUDGET_MS = 235_000;
const QUESTION_TIMEOUT_MS = 60_000;

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

// The box is shared with the other gates, and one of them restarting it mid-run turned a socket
// error into a raw stack trace with the scratch agent still on the roster. A dropped connection is
// retried a few times, and a box that stays down is said in one line rather than thrown.
const raw = async (method, args = {}, attempts = 4) => {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(`${GATEWAY}/api/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      const text = await res.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { ok: res.ok, status: res.status, body, text };
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }
  return { ok: false, status: 0, body: null, unreachable: true,
    text: `${GATEWAY} did not answer ${method}: ${String(last?.message ?? last)}` };
};
const call = async (method, args = {}) => {
  const answer = await raw(method, args);
  if (!answer.ok) throw new Error(`${method} -> ${answer.status} ${answer.text.slice(0, 300)}`);
  return answer.body;
};

const docker = (args, timeoutMs = 60_000) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20, timeout: timeoutMs }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(String(out)))));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class VerificationFailed extends Error {}
const startedAt = Date.now();
const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
const remaining = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);
const deadlineFor = (ms) => Date.now() + Math.max(0, Math.min(ms, remaining()));

let failures = 0;
const check = (ok, what, detail = "") => {
  if (ok) console.log(`  PASS  ${what}`);
  else { failures += 1; console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`); }
  return ok;
};

// ------------------------------------------------------------------- has this shipped?
// `getAgentMail` lands in the same commit as the persona section, so an older bundle answering
// "unknown gateway method" means the wave has not reached this box. That is a wave that has not
// shipped, not a product that is broken, and the exit code says so.
const mailProbe = await raw("getAgentMail");
if (mailProbe.unreachable === true) {
  console.log(`SKIP - ${BOX}'s gateway is not answering, so nothing was measured.`);
  console.log(`  ${mailProbe.text}`);
  process.exit(3);
}
if (!mailProbe.ok && /unknown/i.test(mailProbe.text)) {
  console.log(`SKIP - ${BOX} is on a bundle without getAgentMail, so the standing persona is not`
    + " on this box yet. Swap the host bundle, then run this again.");
  console.log(`  gateway answered: ${mailProbe.status} ${mailProbe.text.slice(0, 160)}`);
  process.exit(3);
}

// ---------------------------------------------------- what the box says about itself
const capacity = await call("getAgentCapacity");
const onboarding = await call("getOnboardingState");
const mail = mailProbe.ok ? mailProbe.body : null;
const boxVersion = (await docker(["exec", BOX, "sh", "-c",
  "cat /home/box/sand-host/version 2>/dev/null || echo unknown"]).catch(() => "unknown")).trim();

console.log(`box ${BOX} (bundle ${boxVersion || "unknown"}) at ${new Date().toISOString()}`);
console.log(`  getAgentCapacity: maxAgents=${capacity.maxAgents} bots=${capacity.bots}`);
console.log(`  getOnboardingState: done=${onboarding.done} doneReason=${onboarding.doneReason ?? "(none)"}`);
console.log(`  getAgentMail: ${mail == null ? "no directory on this box" : `domain=${mail.domain} canSend=${mail.canSend} addresses=${Object.keys(mail.addresses ?? {}).length}`}`);

// -------------------------------------------------------------------- the scratch agent
const said = (transcript) => (Array.isArray(transcript) ? transcript : transcript?.entries ?? [])
  .filter((entry) => entry.kind === "send-message");
const textOf = (entry) => String(entry.kind === "send-message" ? entry.message?.content ?? "" : entry.content ?? "");
const isRunning = async (agentId) =>
  (await call("listAgents").catch(() => [])).find((agent) => agent.id === agentId)?.isRunning === true;

// One question, and the WHOLE turn it produces.
//
// Two things make "the newest message" the wrong thing to read, both measured here on 2026-09-09.
// The product's own first rule is reply first and work second, so the acknowledgement arrives as
// one message and the substance as the next: asked to run first-time setup, the agent said "On
// it — starting the setup interview now." and asked its first question a beat later. And this box
// is shared, so an unrelated message can land mid-question: a mail gate's probe delivery arrived
// between the question and its answer and was read as the answer to it.
//
// So: wait for idle first (a freshly opened agent greets on its own), send, wait for the first new
// message, then drain until the agent goes idle again, and hand back everything the turn said.
const ask = async (agentId, prompt, label) => {
  const idleBy = deadlineFor(QUESTION_TIMEOUT_MS);
  while (Date.now() < idleBy && await isRunning(agentId)) await sleep(2500);
  const before = said(await call("getAgentTranscript", { id: agentId })).length;
  await call("sendPrompt", { agentId, prompt });
  const by = deadlineFor(QUESTION_TIMEOUT_MS);
  let replies = [];
  while (Date.now() < by) {
    await sleep(2500);
    const answers = said(await call("getAgentTranscript", { id: agentId }));
    if (answers.length > before) {
      replies = answers.slice(before);
      // The rest of the turn, but on a clamp: the drain must never eat the cleanup.
      const drainBy = Math.min(Date.now() + 15_000, by);
      while (Date.now() < drainBy && await isRunning(agentId)) {
        await sleep(2500);
        replies = said(await call("getAgentTranscript", { id: agentId })).slice(before);
      }
      const said_ = replies.map((entry) => textOf(entry).replace(/\s+/g, " ").trim())
        .filter(Boolean);
      console.log(`\n[${label}] ${said_.map((line) => JSON.stringify(line.slice(0, 320))).join("\n         ")}`);
      return said_.join(" ‖ ");
    }
  }
  throw new VerificationFailed(`${label}: no answer within the budget (${elapsed()})`);
};

let probe = null;
// The address list as this box held it before the gate touched it, so the box goes back to it.
const mailBefore = mail == null ? null : {
  domain: String(mail.domain ?? ""),
  canSend: mail.canSend === true,
  addresses: Object.entries(mail.addresses ?? {})
    .map(([agentId, row]) => ({ agentId, code: String(row?.code ?? ""), address: String(row?.address ?? "") }))
    .filter((row) => row.code.length > 0 && row.address.length > 0),
};
let pushedMail = false;
try {
  const created = await call("createAgent", {
    name: `probe-persona-${Math.random().toString(36).slice(2, 8)}`,
    description: "", origin: "user", isKickstartRequested: false,
  });
  probe = created?.agent ?? created;
  if (probe?.id == null) throw new VerificationFailed("createAgent returned no agent");
  console.log(`\nscratch agent ${probe.id}`);

  // THE SENTENCE THE ITEM IS FOR. A scratch agent minted seconds ago holds no row in the directory
  // -- the relay sweeps every five minutes and the control plane mints from that sweep -- so left
  // alone this gate can only ever measure the "I have none yet" branch, which is not the sentence
  // Jason's or Richard's Titan will say. Measured 2026-09-09: that was the only answer either
  // machine had ever produced for this question.
  //
  // So the gate gives itself a row. setAgentMail writes the file whole, which is why the box's own
  // list is read first, this one row added to it, and the original written back in cleanup: a gate
  // that leaves a box's addresses different from how it found them is a gate that breaks mail.
  let own = null;
  if (mailBefore != null && mailBefore.domain.length > 0) {
    const taken = new Set(mailBefore.addresses.map((row) => row.code));
    let code = "";
    do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (taken.has(code));
    own = { agentId: probe.id, code, address: `agent${code}@${mailBefore.domain}` };
    const push = await call("setAgentMail", {
      domain: mailBefore.domain, canSend: mailBefore.canSend,
      addresses: [...mailBefore.addresses, own],
    });
    pushedMail = true;
    console.log(`  gave the scratch agent ${own.address} (${push?.written ?? "?"} addresses on the box)`);
  } else {
    console.log("  this box holds no address directory, so the no-address answer is the one measured");
  }

  // 1. Do you have email?
  const email = await ask(probe.id,
    "Do you have an email address of your own? Answer in one or two sentences. If you have one, say it exactly.",
    "email");
  if (own == null) {
    check(/\b(no|not|don'?t|do not)\b/i.test(email) && !/@/.test(email),
      "with no address in the directory it says it has none",
      `expected a plain no, got ${JSON.stringify(email.slice(0, 160))}`);
    check(!/cannot (do|send|read) email|no email capability|not able to (use|do) email/i.test(email),
      "and it does not claim it cannot do email at all",
      "having no address yet is not the same as having no mail plane");
  } else {
    check(email.includes(own.address), `it states its own address ${own.address}`,
      `got ${JSON.stringify(email.slice(0, 160))}`);
    const others = mailBefore.addresses.filter((row) => row.agentId !== probe.id).map((row) => row.address);
    check(!others.some((address) => email.includes(address)),
      `and no other bot's address (${others.length} other(s) on this box)`);
  }

  // 2. How many agents can we have? Against the live ceiling, never a remembered number.
  const ceiling = await ask(probe.id,
    "How many bots can this workspace hold in total, including you? Answer with the number and nothing else.",
    "ceiling");
  const numbers = [...ceiling.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
  check(numbers.includes(capacity.maxAgents),
    `it names the live ceiling ${capacity.maxAgents}`,
    `getAgentCapacity says ${capacity.maxAgents}, the answer said ${JSON.stringify(numbers)}`);
  check(!numbers.includes(12) || capacity.maxAgents === 12,
    "and not the stale twelve from the old profile text");

  // 3. Where does coding go? No vendor name, and this box.
  const coding = await ask(probe.id,
    "If I ask you to fix a bug in one of my repositories, where does that work actually happen? One or two sentences.",
    "coding");
  const vendors = ["Cursor", "cursor.com", "cloud agent", "CloudAgent", "Devin", "Copilot"];
  const named = vendors.filter((vendor) => new RegExp(vendor, "i").test(coding));
  check(named.length === 0, "it names no outside vendor for repository work",
    named.length === 0 ? "" : `named ${named.join(", ")}`);
  check(/\b(this box|my box|here|my (own )?(computer|workspace|machine)|workspace)\b/i.test(coding),
    "and says the work happens here",
    `got ${JSON.stringify(coding.slice(0, 200))}`);

  // 4. What is this product called?
  const product = await ask(probe.id,
    "What is this product called? Answer with the name and nothing else.",
    "product");
  check(/titanium\s*bot/i.test(product), "it names the product Titanium Bot",
    `got ${JSON.stringify(product.slice(0, 120))}`);
  check(!/grok\s*bot|titanbot/i.test(product), "and neither of the old names");

  // 5. Did onboarding run, and how do I retrigger it?
  const setup = await ask(probe.id,
    "Did first-time setup ever run in this workspace, and how would I run it again? Two sentences.",
    "onboarding");
  const ran = onboarding.done === true && onboarding.doneReason !== "existing-box";
  check(
    ran
      ? /\b(ran|finished|completed|has run|did run)\b/i.test(setup) && !/never ran/i.test(setup)
      : /\b(never|has not|hasn'?t|no)\b/i.test(setup),
    `its answer matches the box's record (done=${onboarding.done}, reason=${onboarding.doneReason ?? "none"})`,
    `got ${JSON.stringify(setup.slice(0, 200))}`);
  check(/run first-time setup/i.test(setup), "and it gives the exact retrigger phrase",
    `got ${JSON.stringify(setup.slice(0, 200))}`);

  // The phrase has to DO something. This is the half that would have caught a promise with no
  // wiring behind it.
  const retriggered = await ask(probe.id, "run first-time setup", "retrigger");
  check(/\?/.test(retriggered), "the phrase actually starts the interview (it asks a question)",
    `got ${JSON.stringify(retriggered.slice(0, 200))}`);
  check(!/(can'?t|cannot|unable|not able|no way) .{0,40}(setup|interview|run that)/i.test(retriggered),
    "and it does not refuse");

  // This box has no recorded lead, so nothing should claim to lead the crew.
  check(!/lead of the crew/i.test([email, ceiling, coding, product, setup].join(" ")),
    "a scratch agent on a box with no recorded lead never claims to be the lead");
} catch (error) {
  failures += 1;
  console.log(`\n  FAIL  ${error instanceof VerificationFailed ? error.message : String(error?.message ?? error)}`);
} finally {
  // The addresses first: a box left holding a gate's synthetic row would route a code that belongs
  // to a bot that no longer exists.
  if (pushedMail && mailBefore != null) {
    await call("setAgentMail", { domain: mailBefore.domain, canSend: mailBefore.canSend, addresses: mailBefore.addresses })
      .then(() => console.log(`\nthe box's address list is back to the ${mailBefore.addresses.length} it held`))
      .catch((error) => console.log(`\ncould not put the address list back: ${error.message}`));
  }
  if (probe?.id != null) {
    // Pass or fail, the roster goes back to what it was. A gate that leaves bots behind is the
    // roster-growth bug it is supposed to catch.
    await call("deleteAgent", { id: probe.id })
      .then(() => console.log(`\nscratch agent ${probe.id} deleted`))
      .catch((error) => console.log(`\ncould not delete ${probe.id}: ${error.message}`));
  }
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`} on ${BOX} in ${elapsed()}`);
process.exit(failures === 0 ? 0 : 1);
}
