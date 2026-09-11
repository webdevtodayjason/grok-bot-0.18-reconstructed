// The learn-from-demonstration skill has to exist on a box that never logs in to Cursor.
//
// Managed skills are fetched from Cursor's dashboard into the sand root's managed-skills cache.
// With no login that fetch always throws, so the cache stayed empty and stop-with-save failed
// with "learning workflow is unavailable" -- teach by demonstration could not complete at all.
// The three real skills are now baked into the bundle (scripts/gen-seed-skills.mjs) and every cache
// write is the union of seeds and fetched. These cases pin the union's direction and the three
// ways a seed could have been erased: an empty-but-successful fetch, a throwing fetch, and the
// materializer's habit of deleting any skills/<id> the written list does not name.
//
// They also pin the two ways a seed used to go stale in place. The seed check matched on the id
// alone, so an edited recipe never reached a box that already held the old one, and a cache row
// or a skill file somebody rewrote stayed rewritten across every restart. cache.json is what an
// invocation inlines and skills/<id>/SKILL.md is what the agent reads, so the two disagreeing is
// the model and the agent working from different recipes.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [path.join(repoRoot, "source/host/extensions/managed-setup/managed-skills-service.ts")],
  bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  external: ["jsonc-parser"], logLevel: "silent",
});
const stage = mkdtempSync(path.join(repoRoot, "node_modules", ".managed-seed-skills-test-"));
const bundlePath = path.join(stage, "managed-skills-service.cjs");
writeFileSync(bundlePath, result.outputFiles[0].text, "utf8");
const { SandManagedSkillsService, unionWithSeedSkills, withSeedSkillsRestored } = createRequire(import.meta.url)(bundlePath);

const roots = [];
after(() => {
  rmSync(stage, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const freshCacheDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "managed-seed-skills-"));
  roots.push(root);
  return path.join(root, "managed-skills");
};
const readCache = (dir) => JSON.parse(readFileSync(path.join(dir, "cache.json"), "utf8"));
const idsIn = (dir) => readCache(dir).skills.map((skill) => skill.id).sort();
const service = (cacheDir, fetch) => new SandManagedSkillsService({ getCacheDir: () => cacheDir, fetch });

const SEEDS = unionWithSeedSkills([]).map((skill) => skill.id).sort();

const seedSourceDir = path.join(repoRoot, "source/host/extensions/managed-setup/seed-skills");
const seedDirectories = readdirSync(seedSourceDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

test("the bundle carries every seed directory in the tree, frontmatter and all", () => {
  // email joined them with MAIL-1: an agent that is handed mail needs the recipe for answering it,
  // and this box fetches nothing from a dashboard, so a skill it is not shipped is a skill it
  // never has. onboarding joined them with ONBOARD-1, for the same reason: it is the recipe Titan
  // runs on a box's very first conversation, and it has to be there before anyone can log in.
  // code joined them with CODE-1, for the same reason again: it is the recipe that tells an agent
  // when to hand real coding work to a throwaway machine, what that machine cannot do (it has no
  // internet, so no clone and no install), and that it must read the result before reporting.
  // KB-1 added five more, the handbook packs, which is why this is no longer a list of five written
  // out here: the invariant that matters is that the GENERATED bundle carries exactly what the
  // directory holds, because forgetting `node scripts/gen-seed-skills.mjs` is how old words ship
  // inside a bundle with every test green. The roster of ten is pinned in tests/handbook-seeds.test.mjs.
  assert.deepEqual(SEEDS, seedDirectories,
    "re-run scripts/gen-seed-skills.mjs: the bundle and the seed-skills directory disagree");
  for (const id of ["add-connector", "code", "email", "learn-from-demonstration", "onboarding"]) {
    assert.ok(SEEDS.includes(id), `${id} is still seeded; it predates the handbook and nothing may drop it`);
  }
  const learn = unionWithSeedSkills([]).find((skill) => skill.id === "learn-from-demonstration");
  assert.equal(learn.name, "learn-from-demonstration", "the name comes from the file's frontmatter");
  // The frontmatter folds the description onto several lines (`description: >-`), which the
  // frontmatter parser used to read as the literal string ">-". Pinning the folded text exactly
  // is what keeps that regression from coming back through the seeds.
  assert.equal(learn.description,
    "Turn a screen-recorded demonstration on your computer into a reusable skill. Use when a teach recording finishes.");
  assert.match(learn.body, /^# Learn from a demonstration/m);
  assert.match(learn.body, /Teach recording queue scope/,
    "the skill is the thing that asks for the injected queue scope; a body without it is the wrong file");
  assert.ok(!learn.body.startsWith("---"), "the body must not carry the frontmatter: it is re-serialized on top");

  // MAIL-1, rewritten by MAIL-2. The email skill is what tells an agent what its address is and
  // how to act on the mail that reaches it. Its description is folded the same way, so it is
  // pinned the same way.
  const email = unionWithSeedSkills([]).find((skill) => skill.id === "email");
  assert.equal(email.name, "email", "the name comes from the file's frontmatter");
  assert.equal(email.description,
    "Read and act on the mail that arrives at this agent's own address, and send from it where "
    + "sending is wired. Use when mail lands in this conversation, when someone asks you to email "
    + "a person, or when a task ends with something a person needs in their inbox.");
  assert.match(email.body, /^# Email/m);
  assert.match(email.body, /In-Reply-To|Message-ID/,
    "a reply that does not thread is the failure this skill exists to prevent");
  // MAIL-2 retired the name-derived address and the shell-key send recipe together. A key scoped
  // to the mail domain can send AS ANY address on it, so it is not put in a tenant's box at all,
  // and a skill that tells an agent to go looking for one teaches it to ask for a key nobody has.
  assert.match(email.body, /agent123456@/,
    "the code address is the scheme; a body teaching a name-derived one is the old file");
  assert.ok(!/RESEND_API_KEY|api\.resend\.com/.test(email.body),
    "the skill no longer sends by curling a provider with a key from its own shell");
  assert.ok(!email.body.includes("re_"), "the skill must carry no key-shaped literal");
  assert.ok(!email.body.startsWith("---"), "the body must not carry the frontmatter: it is re-serialized on top");

  // ONBOARD-1. The interview Titan runs on a box's first conversation. The console dispatches it
  // as a workflow reference to this id, so the id, the five questions and the tool it tells him to
  // call are the load-bearing parts.
  const onboarding = unionWithSeedSkills([]).find((skill) => skill.id === "onboarding");
  assert.equal(onboarding.name, "onboarding", "the name comes from the file's frontmatter");
  assert.match(onboarding.description, /^Run first-time setup as Titan/);
  assert.match(onboarding.body, /^# First-time setup/m);
  assert.match(onboarding.body, /save_onboarding_answer/,
    "the tool that captures each answer has to be named in the recipe, or nothing is captured");
  assert.match(onboarding.body, /finish_onboarding/,
    "the recipe has to name the tool that ends setup: nothing else on the box marks the record done, "
    + "so a recipe that never says to call it leaves the person in a window whose only way out says they skipped");
  assert.match(onboarding.body, /update_state/,
    "the memory write is what makes him still know the person after setup closes");
  for (const field of ["name", "location", "timeZone", "business", "ownsBusiness", "workingStyle"]) {
    assert.match(onboarding.body, new RegExp(`\`${field}\``),
      `the recipe has to name the ${field} field it saves`);
  }
  // PERSONA-1. This used to pin the words "ninety-nine more bots". The live ceiling on these
  // boxes was 100, wave C's default is 40, and a number written into a skill body is a fact
  // nothing updates -- so the assertion is now the opposite one: the recipe must NAME no count
  // and must send the agent to its standing facts, which are read off the box every turn.
  assert.ok(!/ninety-nine|twelve|\b99\b|\b12\b/i.test(onboarding.body),
    "the recipe names no bot count of its own");
  assert.match(onboarding.body, /standing facts/,
    "it sends the agent to the live ceiling instead");
  assert.ok(!onboarding.body.startsWith("---"), "the body must not carry the frontmatter: it is re-serialized on top");
});

test("a fetched skill wins over the seed of the same id, and both are kept", () => {
  const fetched = [
    { id: "learn-from-demonstration", name: "Newer copy", description: "from cursor", body: "newer body" },
    { id: "other-skill", name: "Other", description: "", body: "other body" },
  ];
  const union = unionWithSeedSkills(fetched);
  assert.deepEqual(union.map((skill) => skill.id).sort(), [...SEEDS, "other-skill"].sort());
  assert.equal(union.find((skill) => skill.id === "learn-from-demonstration").body, "newer body");
  assert.equal(union.find((skill) => skill.id === "add-connector").body.startsWith("# Add a connector"), true);
});

test("ensureSeeds writes the seeds with no network and no auth", async () => {
  const dir = freshCacheDir();
  service(dir, async () => { throw new Error("fetch must not be needed"); }).ensureSeeds();
  assert.deepEqual(idsIn(dir), SEEDS);
  assert.ok(existsSync(path.join(dir, "skills", "learn-from-demonstration", "SKILL.md")));
  const materialized = readFileSync(path.join(dir, "skills", "learn-from-demonstration", "SKILL.md"), "utf8");
  assert.match(materialized, /^---\n/, "the materialized file is re-serialized with one frontmatter block");
  assert.equal(materialized.split("\n---\n").length, 2, "exactly one frontmatter block, not a doubled one");
});

test("ensureSeeds puts back a skill file somebody deleted", () => {
  const dir = freshCacheDir();
  const managed = service(dir, async () => { throw new Error("fetch must not be needed"); });
  managed.ensureSeeds();
  const skillFile = path.join(dir, "skills", "learn-from-demonstration", "SKILL.md");
  const before = readFileSync(skillFile, "utf8");
  // cache.json still names the skill, so the seed check passed and nothing repaired the file:
  // the agent is handed a path that does not exist and no log line says why.
  rmSync(path.join(dir, "skills", "learn-from-demonstration"), { recursive: true, force: true });
  managed.ensureSeeds();
  assert.equal(readFileSync(skillFile, "utf8"), before);
  assert.deepEqual(idsIn(dir), SEEDS, "repairing the files must not drop a cached skill");
});

test("a successful but empty fetch leaves the seeds in place", async () => {
  const dir = freshCacheDir();
  const managed = service(dir, async () => []);
  await managed.refresh("startup");
  assert.deepEqual(idsIn(dir), SEEDS, "an unauthenticated dashboard answers with no skills; that must not erase them");
  assert.ok(existsSync(path.join(dir, "skills", "learn-from-demonstration", "SKILL.md")),
    "materializeManagedSkillFiles deletes any id the written list omits");
});

test("a throwing fetch leaves the seeded cache untouched", async () => {
  const dir = freshCacheDir();
  const reported = [];
  const managed = new SandManagedSkillsService({
    getCacheDir: () => dir,
    fetch: async () => { throw new TypeError("fetch failed"); },
    report: (event) => reported.push(event),
  });
  managed.ensureSeeds();
  const before = readCache(dir);
  await managed.refresh("startup");
  assert.deepEqual(readCache(dir), before, "a failed refresh must not rewrite the cache at all");
  assert.deepEqual(reported.map((event) => event.errorClass), ["TypeError"]);
});

test("ensureSkill answers true from the seeds even when the fetch throws", async () => {
  const dir = freshCacheDir();
  let fetches = 0;
  const managed = service(dir, async () => { fetches += 1; throw new Error("no cursor login on this box"); });
  assert.equal(await managed.ensureSkill("learn-from-demonstration"), true);
  assert.equal(fetches, 0, "the seed answers without a network round trip");
  assert.equal(await managed.ensureSkill("not-a-skill"), false);
  assert.equal(fetches, 1, "an unknown id still tries a refresh once");
});

test("ensureSkill leaves the dashboard's copy of a seed id alone", async () => {
  // ensureSkill is what stop-with-save awaits, mid-session, with no refresh behind it. Running the
  // full seed restore there put the bundled recipe back over the operator's fetched copy in both
  // cache.json and SKILL.md, and the learning turn dispatched a breath later ran the bundled one.
  const dir = freshCacheDir();
  const managed = service(dir, async () => [{
    id: "learn-from-demonstration", description: "from the dashboard", enabled: true,
    content: "---\nname: learn-from-demonstration\n---\nDASHBOARD RECIPE",
  }]);
  await managed.refresh("startup");
  const fetchedBody = readCache(dir).skills.find((skill) => skill.id === "learn-from-demonstration").body;
  assert.equal(fetchedBody, "DASHBOARD RECIPE");
  assert.equal(await managed.ensureSkill("learn-from-demonstration"), true);
  assert.equal(readCache(dir).skills.find((skill) => skill.id === "learn-from-demonstration").body, fetchedBody);
  assert.match(readFileSync(path.join(dir, "skills", "learn-from-demonstration", "SKILL.md"), "utf8"), /DASHBOARD RECIPE/);
  assert.deepEqual(idsIn(dir), SEEDS, "and the other seed is still there");
});

test("ensureSkill still tops up a seed the cache is missing", async () => {
  const dir = freshCacheDir();
  const managed = service(dir, async () => { throw new Error("fetch must not be needed"); });
  assert.equal(await managed.ensureSkill("learn-from-demonstration"), true);
  assert.deepEqual(idsIn(dir), SEEDS);
});

test("readManagedSkillsCache drops a row whose id would escape the skills directory", () => {
  const dir = freshCacheDir();
  const managed = service(dir, async () => { throw new Error("fetch must not be needed"); });
  managed.ensureSeeds();
  const seeded = readCache(dir);
  // cache.json is a plain file under the sand root. Before this, a row somebody wrote there was
  // read back and materialized with mkdir -p at whatever path its id named.
  writeFileSync(path.join(dir, "cache.json"), JSON.stringify({
    fetchedAt: seeded.fetchedAt,
    skills: [...seeded.skills, { id: "../../../tmp/PWNED", name: "x", description: "", body: "x" }],
  }, null, 2));
  managed.ensureSeeds();
  assert.deepEqual(idsIn(dir), SEEDS, "an unreadable cache is rewritten from the seeds, escape row and all gone");
  assert.equal(existsSync(path.join(dir, "skills", "..", "..", "..", "tmp", "PWNED")), false);
});

test("ensureSeeds keeps a fetched skill and its fetchedAt when it tops the cache up", async () => {
  const dir = freshCacheDir();
  const managed = service(dir, async () => [{ id: "other-skill", description: "d", content: "---\nname: Other\n---\nbody", enabled: true }]);
  await managed.refresh("startup");
  const first = readCache(dir);
  assert.deepEqual(first.skills.map((skill) => skill.id).sort(), [...SEEDS, "other-skill"].sort());
  // Drop one seed the way a stale cache from before the seeds existed would look.
  writeFileSync(path.join(dir, "cache.json"), JSON.stringify({
    fetchedAt: 1234, skills: first.skills.filter((skill) => skill.id !== "learn-from-demonstration"),
  }, null, 2));
  managed.ensureSeeds();
  const second = readCache(dir);
  assert.deepEqual(second.skills.map((skill) => skill.id).sort(), [...SEEDS, "other-skill"].sort());
  assert.equal(second.fetchedAt, 1234, "topping up seeds must not pretend the cache was just fetched");
});

test("ensureSeeds replaces a seed row the bundled recipe has moved on from", () => {
  const dir = freshCacheDir();
  const managed = service(dir, async () => { throw new Error("fetch must not be needed"); });
  managed.ensureSeeds();
  const seeded = readCache(dir);
  const seedBody = seeded.skills.find((skill) => skill.id === "learn-from-demonstration").body;
  // How an older box looks after the bundled SKILL.md is edited: the id is still listed and the
  // file is still there, so the old check returned early and the box kept the old recipe forever.
  writeFileSync(path.join(dir, "cache.json"), JSON.stringify({
    fetchedAt: 4321,
    skills: seeded.skills.map((skill) => skill.id === "learn-from-demonstration" ? { ...skill, body: "an older recipe" } : skill),
  }, null, 2));
  managed.ensureSeeds();
  const repaired = readCache(dir);
  assert.equal(repaired.skills.find((skill) => skill.id === "learn-from-demonstration").body, seedBody);
  assert.equal(repaired.fetchedAt, 4321, "repairing a stale row must not pretend the cache was just fetched");
  assert.match(readFileSync(path.join(dir, "skills", "learn-from-demonstration", "SKILL.md"), "utf8"),
    /^# Learn from a demonstration/m, "the file the agent reads is rewritten with the row");
});

test("ensureSeeds rewrites a skill file whose contents drifted from its cache row", () => {
  const dir = freshCacheDir();
  const managed = service(dir, async () => { throw new Error("fetch must not be needed"); });
  managed.ensureSeeds();
  const skillFile = path.join(dir, "skills", "learn-from-demonstration", "SKILL.md");
  const before = readFileSync(skillFile, "utf8");
  // Still a plausible skill file, still the right size: only comparing the contents catches it.
  writeFileSync(skillFile, `---\nname: "learn-from-demonstration"\n---\n# Not the recipe\n${"x".repeat(before.length)}\n`);
  managed.ensureSeeds();
  assert.equal(readFileSync(skillFile, "utf8"), before);
});

test("withSeedSkillsRestored leaves a non-seed skill alone and answers with the same array", () => {
  const settled = unionWithSeedSkills([{ id: "other-skill", name: "Other", description: "", body: "other body" }]);
  assert.equal(withSeedSkillsRestored(settled), settled, "nothing to repair must return the argument itself");
  const stale = settled.map((skill) => skill.id === "add-connector" ? { ...skill, body: "an older recipe" } : skill);
  const restored = withSeedSkillsRestored(stale);
  assert.notEqual(restored, stale, "a stale seed row means a rewrite");
  assert.equal(restored.find((skill) => skill.id === "add-connector").body,
    settled.find((skill) => skill.id === "add-connector").body);
  assert.equal(restored.find((skill) => skill.id === "other-skill").body, "other body",
    "a skill that is not a seed is the dashboard's business, not the bundle's");
});
