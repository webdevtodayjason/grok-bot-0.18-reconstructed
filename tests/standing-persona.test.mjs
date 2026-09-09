// PERSONA-1. The contradiction test: it fails when a sentence in the prompt disagrees with a
// setting the box is actually holding.
//
// Between 22:49 on 2026-09-08 and 06:11 on 2026-09-09 the operator's lead agent told him, in one
// conversation, that it had no email (it does), that the workspace held "up to 12 more agents"
// (SAND_MAX_AGENTS said 100), that repository work goes to a cloud agent on the dead upstream
// (that tool is withheld from the same turn's toolset), that the product is called something it is
// not, and that there is no first-run interview (there is). Every one of those was a sentence
// written down once against a fact that moves.
//
// So the assertions here are all of the same shape: write a fact into a fake sand root, render the
// section out of the tree the way tests/local-machine-prompt.test.mjs renders the base prompt, and
// check the rendered words against the fact rather than against a golden string. A number that
// appears in the prompt and not in the settings file is the bug this suite exists to catch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Staged inside the repo, not in os.tmpdir(), so `require` resolves the three native modules the
// bundle leaves external from this checkout's node_modules.
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".standing-persona-test-"));
after(() => rmSync(stage, { recursive: true, force: true }));
const require_ = createRequire(import.meta.url);
const bundle = async (entry, name) => {
  const result = await build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
    external: ["jsonc-parser", "better-sqlite3", "node-pty"], logLevel: "silent",
  });
  const bundlePath = path.join(stage, name);
  writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
  return require_(bundlePath);
};

const persona = await bundle("source/host/runner/standing-persona.ts", "standing-persona.cjs");
const promptMod = await bundle("source/host/runner/system-prompt.ts", "system-prompt.cjs");
const docs = await bundle("source/host/runner/box-reference-docs.ts", "box-reference-docs.cjs");

// ------------------------------------------------------------------ a fake box on disk

let boxes = 0;
/**
 * A sand root with exactly the files the section reads: the operator switches, the settings
 * document that carries the onboarding record, the mail file, and the lead marker. Anything the
 * caller leaves out is a box that does not have it, which is a case in its own right.
 */
function fakeBox({ settings, onboarding, mail, lead } = {}) {
  const root = path.join(stage, `box-${boxes += 1}`);
  mkdirSync(root, { recursive: true });
  if (settings !== undefined) {
    writeFileSync(path.join(root, "sand-host-settings.json"), JSON.stringify(settings), "utf8");
  }
  if (onboarding !== undefined) {
    // The shape SandSettingsStore parses: version-stamped, with the record held opaque under
    // `onboarding`. A wrong version is dropped whole, which would silently make every onboarding
    // case pass for the wrong reason.
    writeFileSync(path.join(root, "settings.json"), JSON.stringify({
      version: 1, mcpBoxServers: [], settingsMigrations: [], onboarding,
    }), "utf8");
  }
  if (mail !== undefined) {
    writeFileSync(path.join(root, "agent-mail.json"), JSON.stringify(mail), "utf8");
  }
  if (lead !== undefined) {
    writeFileSync(path.join(root, "lead-agent.json"), JSON.stringify({ agentId: lead }), "utf8");
  }
  return root;
}

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/**
 * The section as one agent sees it. SAND_DATA_ROOT is repointed per call because every reader in
 * the section resolves the sand root through getSandRootDir(), and the mtime caches inside those
 * readers key on the path, so two boxes never read each other's answers.
 */
function render({ agentId = AGENT, agents = [], root }) {
  const previous = process.env.SAND_DATA_ROOT;
  process.env.SAND_DATA_ROOT = root;
  try { return persona.renderStandingPersonaSection({ agentId, agents, sandRoot: root }); }
  finally {
    if (previous === undefined) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previous;
  }
}

// Set on this process by nothing else, but the ceiling reader prefers the environment over the
// file, so a stray value in the shell would quietly make every ceiling case pass.
delete process.env.SAND_MAX_AGENTS;

// ------------------------------------------------------------------------- the ceiling

test("the ceiling in the prompt is the ceiling in the settings file, never a literal", () => {
  const text = render({ root: fakeBox({ settings: { SAND_MAX_AGENTS: "40" } }) });
  assert.ok(text.includes("up to 40 bots"), `the live ceiling is stated: ${text}`);
  assert.ok(!/\btwelve\b/i.test(text), "the word twelve is nowhere in it");
  assert.ok(!/\b12\b/.test(text), "the number 12 is nowhere in it");
  assert.ok(!/ninety-nine|\b99\b/i.test(text), "no other remembered ceiling either");
});

test("with no setting the prompt renders the product default and no hardcoded number", async () => {
  const agents = await bundle("source/shared/agents/agents.ts", "agents.cjs");
  const text = render({ root: fakeBox({}) });
  assert.ok(
    text.includes(`up to ${agents.SAND_DEFAULT_MAX_AGENTS} bots`),
    `the default ceiling is stated: ${text}`,
  );
  // Every number in the section has to come from somewhere live. The only two are the ceiling and
  // the count of bots that exist, and with no roster that count is 1. Filesystem paths are struck
  // out first: the fake sand root is named box-<n>, and a digit inside a path is not a claim.
  const prose = text.replace(/\S*\/\S*/g, " ");
  const numbers = [...prose.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
  assert.deepEqual(
    [...new Set(numbers)].sort((a, b) => a - b),
    [1, agents.SAND_DEFAULT_MAX_AGENTS].sort((a, b) => a - b),
    "no number in the section that is not the live ceiling or the live count",
  );
});

test("the count of bots is the roster the assembly holds, plus this agent", () => {
  const root = fakeBox({ settings: { SAND_MAX_AGENTS: "40" } });
  const text = render({ root, agents: [{ id: OTHER }, { id: "c" }, { id: "d" }] });
  assert.ok(text.includes("4 exist today"), `four bots on this box: ${text}`);
  const alone = render({ root, agents: [] });
  assert.ok(alone.includes("1 exists today"), `one bot on this box: ${alone}`);
});

// ---------------------------------------------------------------------------- the mail

test("the address in the prompt is this agent's row, and absence is said rather than guessed", () => {
  const withMail = fakeBox({
    mail: {
      domain: "myagents.email", canSend: false, updatedAt: 1,
      addresses: {
        [AGENT]: { code: "418264", address: "agent418264@myagents.email" },
        [OTHER]: { code: "903117", address: "agent903117@myagents.email" },
      },
    },
  });
  const text = render({ root: withMail });
  assert.ok(text.includes("agent418264@myagents.email"), `my own address: ${text}`);
  assert.ok(!text.includes("agent903117@myagents.email"), "never another bot's address");
  assert.ok(/receive mail but not send/.test(text), "canSend false is stated, not hidden");

  const none = render({ root: fakeBox({}) });
  assert.ok(/do not have an email address of my own yet/.test(none), `no address: ${none}`);
  assert.ok(!/@/.test(none.split("\n").find((line) => line.includes("email address")) ?? ""),
    "and no guess at one");
});

test("mail is stated as built in, never as a connector to install", () => {
  const text = render({ root: fakeBox({}) });
  assert.ok(/built into this product/.test(text), "mail is a built-in");
  assert.ok(!/connect(ing)? (your|their) mail/i.test(text), "not a connector to wire up first");
});

test("a wired send route is stated as one", () => {
  const text = render({ root: fakeBox({ mail: {
    domain: "myagents.email", canSend: true, updatedAt: 1,
    addresses: { [AGENT]: { code: "418264", address: "agent418264@myagents.email" } },
  } }) });
  assert.ok(/can send from that address/.test(text), `canSend true is stated: ${text}`);
});

// ---------------------------------------------------------------------- the onboarding

test("an existing-box record says the interview never ran, and never that it finished", () => {
  const text = render({ root: fakeBox({
    onboarding: { done: true, doneReason: "existing-box", answers: {} },
  }) });
  assert.ok(/never ran here/.test(text), `the migration wording: ${text}`);
  assert.ok(!/ran here and finished/.test(text), "it does not claim the interview happened");
  assert.ok(text.includes('"run first-time setup"'), "and it carries the retrigger phrase");
});

test("a completed record says it finished, and still carries the retrigger phrase", () => {
  const text = render({ root: fakeBox({
    onboarding: { done: true, doneReason: "completed", answers: { name: "Jason" } },
  }) });
  assert.ok(/ran here and finished/.test(text), `the completed wording: ${text}`);
  assert.ok(!/never ran here/.test(text), "it does not claim the opposite too");
  assert.ok(text.includes('"run first-time setup"'), "the retrigger phrase is there");
});

test("the retrigger phrase is wired to a real file, not just promised", () => {
  const root = fakeBox({});
  const text = render({ root });
  // Promising a phrase that does nothing is the same bug class as the facts being wrong, so the
  // section has to say what happens when it is heard.
  //
  // Measured on grok-bot-local-vm at 12:53 UTC on 2026-09-09: told only to open the skill BY NAME,
  // the agent answered "On it — starting the setup interview now." and then went silent, because
  // the workflows section points at <sandRoot>/workflows and the managed seed skills are written
  // to <sandRoot>/managed-skills/skills/<id>/. So the exact path is pinned here, and it is the
  // path the managed-skills cache actually writes.
  assert.ok(text.includes(`${root}/managed-skills/skills/onboarding/SKILL.md`),
    `it names the skill's real path: ${text}`);
  // Measured twice: "acknowledge, then read the file, then ask" is a turn the model satisfies by
  // acknowledging alone. The first question therefore has to be IN the prompt and in the same
  // message, so nothing has to be fetched before the interview can start.
  assert.ok(text.includes('"What should I call you?"'),
    "the first question is spelled out, so no read stands between the phrase and the interview");
  assert.ok(/in the same message as any acknowledgement/.test(text),
    "and it must not arrive as a message of its own after an acknowledgement");
  assert.ok(/does not reopen the setup window/.test(text),
    "and says the one thing it cannot do, rather than over-promising");
});

// --------------------------------------------------------------------- the lead block

test("only the recorded lead gets the lead paragraph", () => {
  const root = fakeBox({ lead: AGENT });
  assert.ok(/lead of the crew/.test(render({ root, agentId: AGENT })),
    "the lead is told it is the lead");
  assert.ok(!/lead of the crew/.test(render({ root, agentId: OTHER })),
    "and nobody else is");
});

test("with no lead recorded, nobody claims to be one", () => {
  const text = render({ root: fakeBox({}) });
  assert.ok(!/lead of the crew/.test(text), "no marker means no lead paragraph");
  assert.ok(text.length > 0, "the facts block still renders");
});

test("the lead marker is written once and never moved", () => {
  const root = fakeBox({});
  assert.equal(persona.writeLeadAgentId(AGENT, root), AGENT, "the first write takes");
  assert.equal(persona.writeLeadAgentId(OTHER, root), AGENT, "a second write keeps the first");
  assert.equal(persona.readLeadAgentId(root), AGENT);
});

test("a runner with no agent identity renders no section at all", () => {
  assert.equal(render({ agentId: null, root: fakeBox({}) }), null);
  assert.equal(render({ agentId: "   ", root: fakeBox({}) }), null);
});

// ------------------------------------------------------- the facts outrank what is stored

test("the section says in words that it outranks the profile and the memory", () => {
  const text = render({ root: fakeBox({}) });
  assert.ok(/profile description/.test(text) && /stored memory/.test(text),
    `both are named: ${text}`);
  assert.ok(/the facts above are the live ones/.test(text), "and which one wins is stated");
});

// ----------------------------------------------------- the dead upstream, and the name

const assembled = [
  promptMod.DEFAULT_SAND_SYSTEM_PROMPT,
  promptMod.buildSandBaseSystemPrompt({ localMachineConnected: false }),
  promptMod.buildSandSubagentSystemPrompt({ subagentType: "generalPurpose" }),
  promptMod.SAND_SUBAGENT_SAFETY_PROMPT_SECTION,
].join("\n\n");

test("no assembled prompt names the dead upstream or the wrong product", () => {
  for (const word of ["Cursor", "cloud agent", "CloudAgent", "Grok Bot", "Titanbot"]) {
    assert.ok(!assembled.includes(word), `the prompt does not say ${word}`);
  }
  assert.ok(assembled.includes("Titanium Bot"), "it does say the product's real name");
});

test("the generated box reference docs name the product and describe the console", () => {
  for (const doc of [docs.SAND_APP_UI_REFERENCE_DOC, docs.SAND_BOX_DEBUGGING_REFERENCE_DOC]) {
    for (const word of ["Cursor", "cloud agent", "Grok Bot", "Titanbot"]) {
      assert.ok(!doc.includes(word), `the reference doc does not say ${word}`);
    }
    assert.ok(doc.includes("Titanium Bot"), "the reference doc names the product");
  }
  // The paragraphs that described an Electron app which does not exist on this deployment.
  for (const phrase of ["Cmd+,", "five tabs", "Sign In", "Preferences", "'s Computer"]) {
    assert.ok(!docs.SAND_APP_UI_REFERENCE_DOC.includes(phrase),
      `the app-ui doc no longer claims: ${phrase}`);
  }
});

test("the attached-files note points at this box, not at the user's computer", () => {
  const note = promptMod.buildAttachedFilesNote(
    ["/home/box/sand-data/agents/a/attachments/abc.png"], new Map(), new Map(),
  );
  assert.ok(note.includes("on this box"), `it says where the files are: ${note}`);
  for (const name of ["ExternalRead", "CopyToBox", "the user's computer"]) {
    assert.ok(!note.includes(name), `it no longer says ${name}`);
  }
  assert.ok(note.includes("/home/box/sand-data/agents/a/attachments/abc.png"), "the path is named");
});

// ------------------------------------------------------------------- the seed skills

const seedDir = path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills");
const generated = readFileSync(
  path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills.gen.ts"), "utf8",
);

test("no seed skill hardcodes a bot count, on disk or in the generated bundle", () => {
  // A number in a skill body is a fact nothing updates: onboarding/SKILL.md said "ninety-nine"
  // against a live ceiling of 100, and would have said it against wave C's 40 too.
  for (const id of ["onboarding", "email"]) {
    const body = readFileSync(path.join(seedDir, id, "SKILL.md"), "utf8");
    assert.ok(!/ninety-nine|twelve|\b99\b|\b12\b/i.test(body),
      `${id}/SKILL.md names no bot count`);
    // The generated module has to agree with the file, or a swap ships the old words. The
    // generator writes each body as a template literal, so the comparison escapes it the same
    // way (scripts/gen-seed-skills.mjs), backslashes first or the escapes escape each other.
    const asTemplateLiteral = body
      .replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    assert.ok(generated.includes(asTemplateLiteral),
      `${id}/SKILL.md is what seed-skills.gen.ts carries — re-run scripts/gen-seed-skills.mjs`);
  }
});

test("the email skill teaches the code address and no name-derived one", () => {
  const body = readFileSync(path.join(seedDir, "email", "SKILL.md"), "utf8");
  assert.ok(body.includes("agent123456@"), "the shape of a real address is shown");
  assert.ok(/not derived from your name/.test(body), "and the retired scheme is refused");
  // The shell recipe whose precondition was measurably absent on both boxes checked.
  for (const phrase of ["RESEND_API_KEY", "api.resend.com"]) {
    assert.ok(!body.includes(phrase), `the skill no longer tells the agent to use ${phrase}`);
  }
});

test("the onboarding skill tells the agent to read the live ceiling", () => {
  const body = readFileSync(path.join(seedDir, "onboarding", "SKILL.md"), "utf8");
  assert.ok(/standing facts/.test(body), "it points at the standing facts for the number");
  assert.ok(/built into the product|built into this product/.test(body),
    "and frames mail as a built-in rather than a connector");
});
