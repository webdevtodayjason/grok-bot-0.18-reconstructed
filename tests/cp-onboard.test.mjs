// ONBOARD-2. The invite as a job: the five steps, their refusals, and the one thing the sequence is
// never allowed to do.
//
// Jason, 2026-09-10 10:54: "Is the super admin panel ready in a state where I can invite a user and
// it will handle the full onboarding process, including creating the account and workspace, creating
// a Docker container for the AI agents, setting up their emails? Is the entire process ready? Is the
// welcome email sent out?"
//
// THE TEST THAT MATTERS MOST IN THIS FILE IS A NEGATIVE ONE. "the sequence reads a box and never
// prompts it" counts every call the stub box received and asserts the set is exactly listAgents and
// getOnboardingState. source/host/agent-isolation/onboarding-state.ts marks a box done:true with
// doneReason "existing-box" FOR EVER if the first read finds a prompted conversation, and
// resetOnboarding is 403 without SAND_TEST_HOOKS, so one smoke prompt from this control plane
// permanently destroys a customer's first-run interview with no error and no way back. A gate that
// only checked the happy path would pass the day somebody adds one.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ADDRESSES_NONE,
  LEDGER,
  ONBOARD_LABELS,
  TITAN_NO_MODEL,
  WELCOME_NOT_ASKED,
  WELCOME_NO_SENDER,
  createOnboarding,
  foldSteps,
  mintSignInLink,
} from "../cp/onboard.mjs";
import { verifySessionToken, tenantSessionSecret } from "../cp/session.mjs";
import { startFakeCoolify } from "./cp-support.mjs";
import {
  probeRefuses,
  probeThrough,
  startAdminOnly,
  startStubBox,
  startStubRelay,
  stubDecommission,
  stubWelcome,
} from "./helpers/onboard-fakes.mjs";

// The five labels are Jason's own words and three places render them. A change to one of them here
// is a change somebody makes on purpose.
const LABELS = [
  "Creating the workspace",
  "Building the computer",
  "Waking Titan",
  "Giving the agents their addresses",
  "Sending the welcome",
];

const TITAN = { id: "agent-titan", name: "Titan", isGroup: false };

/** A box that answers everything the sequence is allowed to ask, and nothing else. */
const freshBoxAnswers = {
  listAgents: [TITAN],
  getOnboardingState: { done: false, maxAgents: 40 },
};

/** A sequence over a seeded tenant, with every wait turned down to test speed. */
function sequenceOver(plane, { box = null, relay = null, welcome = null, provision, mail = null, ...rest } = {}) {
  return createOnboarding({
    store: plane.store,
    config: plane.config,
    probeImpl: box == null ? probeRefuses : probeThrough(box),
    healthIntervalMs: 5,
    healthBudgetMs: 200,
    addressBudgetMs: 200,
    runningBudgetMs: 120,
    deadlineMs: 5_000,
    stallMs: 60_000,
    provision: provision ?? (async () => ({ ok: true })),
    askRelay: relay == null
      ? async () => ({ ok: false, why: "no relay" })
      : async (pathname) => {
        const response = await fetch(`${relay.url}${pathname}`, { headers: { authorization: `Bearer ${relay.token}` } });
        const body = await response.json();
        return response.ok ? { ok: true, body } : { ok: false, why: `the relay answered ${response.status}`, body };
      },
    askRelayPost: relay == null
      ? async () => ({ ok: false, why: "no relay" })
      : async (pathname, payload) => {
        const response = await fetch(`${relay.url}${pathname}`, {
          method: "POST",
          headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
          body: JSON.stringify(payload ?? {}),
        });
        const body = await response.json().catch(() => ({}));
        return response.ok ? { ok: true, body } : { ok: false, why: `the relay answered ${response.status}`, body };
      },
    pointWorkspaceAt: relay == null
      ? async () => ({ ok: false, why: "no relay" })
      : async (slug, alias) => {
        const response = await fetch(`${relay.url}/admin/tenants/${encodeURIComponent(slug)}/use-included`, {
          method: "POST",
          headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: alias }),
        });
        const body = await response.json().catch(() => ({}));
        return response.ok ? { ok: true, body } : { ok: false, why: `the relay answered ${response.status}` };
      },
    mailDirectory: mail ?? (() => ({ directory: () => ({ tenants: {} }) })),
    deps: welcome == null ? {} : { welcome },
    ...rest,
  });
}

/** An address directory that answers one live row for a slug once `on` is true. */
function mailAfter(slug, { address = "agent123456@myagents.email", agentId = TITAN.id, on = () => true } = {}) {
  return () => ({
    directory: (asked) => (String(asked) === slug && on()
      ? { tenants: { [slug]: { addresses: [{ agentId, code: "123456", address, agentName: "Titan", state: "active" }] } } }
      : { tenants: {} }),
  });
}

async function withPlane(run, options = {}) {
  const plane = await startAdminOnly(options);
  try { await run(plane); } finally { await plane.dispose(); }
}

// ---- the fold, which is what the card reads ----------------------------------------------------

test("an empty ledger is five waiting steps in Jason's own words", () => {
  const folded = foldSteps([]);
  assert.deepEqual(folded.steps.map((one) => one.label), LABELS);
  assert.deepEqual(folded.steps.map((one) => one.state), ["waiting", "waiting", "waiting", "waiting", "waiting"]);
  assert.equal(folded.done, false);
  assert.equal(folded.stopped, null);
  assert.deepEqual(LABELS, ["workspace", "box", "titan", "addresses", "welcome"].map((key) => ONBOARD_LABELS[key]));
});

test("a Coolify container that is running leaves Building the computer yellow; only a real health answer makes it green", () => {
  // This is the distinction the whole step exists for. provisionTenant's own wait accepts Coolify's
  // container status, which says a container was created and says nothing about whether a host
  // booted inside it. A welcome sent on that evidence reaches a customer whose workspace cannot be
  // opened.
  const coolifyOnly = [
    { step: "start", status: "ok", detail: "{}", at: 1000 },
    { step: "ready", status: "ok", detail: JSON.stringify({ how: "coolify", waitedMs: 900 }), at: 2000 },
    { step: LEDGER.box, status: "running", detail: JSON.stringify({ why: "being built" }), at: 2000 },
  ];
  assert.equal(foldSteps(coolifyOnly, { at: 2100 }).byKey.box.state, "running");

  const answered = [...coolifyOnly, { step: LEDGER.box, status: "ok", detail: JSON.stringify({ how: "health", status: 200, waitedMs: 1792 }), at: 3000 }];
  const green = foldSteps(answered, { at: 3100 }).byKey.box;
  assert.equal(green.state, "ok");
  assert.equal(green.detail.how, "health");
});

test("a provisioning step that failed names itself on Building the computer", () => {
  const folded = foldSteps([
    { step: LEDGER.workspace, status: "ok", detail: "{}", at: 10 },
    { step: LEDGER.box, status: "running", detail: "{}", at: 20 },
    { step: "service", status: "failed", detail: JSON.stringify({ why: "Coolify said no" }), at: 30 },
    { step: LEDGER.box, status: "failed", detail: JSON.stringify({ step: "service", why: "Coolify said no" }), at: 31 },
  ], { at: 40 });
  assert.equal(folded.byKey.box.state, "failed");
  assert.equal(folded.byKey.box.detail.step, "service");
  assert.equal(folded.stopped, "box");
  assert.equal(folded.retryable, true);
});

test("a step that has written nothing down for three minutes reads as stalled with the same Retry", () => {
  const rows = [
    { step: LEDGER.workspace, status: "ok", detail: "{}", at: 0 },
    { step: LEDGER.box, status: "running", detail: "{}", at: 1000 },
  ];
  assert.equal(foldSteps(rows, { at: 2000, stallMs: 180_000 }).byKey.box.stalled, false);
  const stalled = foldSteps(rows, { at: 1000 + 180_001, stallMs: 180_000 }).byKey.box;
  assert.equal(stalled.stalled, true);
  assert.match(stalled.next, /Press Retry/);
});

test("a welcome nobody asked for reads as done with a caveat, and is not a stop", () => {
  const rows = [{ step: LEDGER.workspace, status: "ok", detail: JSON.stringify({ sendWelcome: false }), at: 0 }];
  const folded = foldSteps(rows, { at: 10, sendWelcome: false });
  assert.equal(folded.byKey.welcome.state, "amber");
  assert.equal(folded.byKey.welcome.why, WELCOME_NOT_ASKED);
  // Not green, because nothing happened.
  assert.equal(folded.done, false);
  // And NOT a stop, because "the welcome was not asked for" is not a thing anybody has to go and
  // press something about. A card saying "Stopped at Sending the welcome" would send the operator
  // looking for a fault they turned off themselves.
  assert.equal(folded.byKey.welcome.skipped, true);
  assert.equal(folded.stopped, null);
  assert.equal(folded.retryable, false);

  // A welcome that WAS asked for and has not run is a different fact: waiting, and not skipped.
  const asked = foldSteps([{ step: LEDGER.workspace, status: "ok", detail: JSON.stringify({ sendWelcome: true }), at: 0 }], { at: 10, sendWelcome: true });
  assert.equal(asked.byKey.welcome.state, "waiting");
  assert.equal(asked.byKey.welcome.skipped, false);
});

// ---- the sign-in link --------------------------------------------------------------------------

test("the sign-in link is signed with that workspace's own key and carries a 24 hour ceiling", async () => {
  await withPlane(async (plane) => {
    const seeded = plane.seedTenant({ slug: "acme" });
    const at = 1_757_000_000_000;
    const link = mintSignInLink({ account: seeded.account, tenant: seeded.tenant, config: plane.config, now: at });
    assert.match(link.url, /^https:\/\/console\.titanium\.bot\/login\?sso=/);
    const token = decodeURIComponent(new URL(link.url).searchParams.get("sso"));

    // The relay verifies it with the tenant's DERIVED key, which is the only key that tenant holds.
    const mine = verifySessionToken(token, tenantSessionSecret(plane.config.sessionSecret, "acme"), at + 1000);
    assert.equal(mine.ok, true, mine.reason);
    assert.equal(mine.payload.sub, seeded.account.id);
    assert.equal(mine.payload.exp - mine.payload.iat, 24 * 60 * 60 * 1000);

    // A different workspace's key does not open it, which is what stops a customer who can read their
    // own relay's environment from minting a link into somebody else's box.
    assert.equal(verifySessionToken(token, tenantSessionSecret(plane.config.sessionSecret, "other"), at).ok, false);
    // And it really does expire.
    assert.equal(verifySessionToken(token, tenantSessionSecret(plane.config.sessionSecret, "acme"), at + 24 * 60 * 60 * 1000 + 1).reason, "expired");
  });
});

// ---- the sequence, step by step ----------------------------------------------------------------

test("the five steps go green in order, and the sequence reads a box and never prompts it", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      const sequence = sequenceOver(plane, { box, relay, welcome, mail: mailAfter("acme") });
      sequence.start({ slug: "acme", name: "Acme", planModel: "plan-zai", ceiling: 40, sendWelcome: true, temporaryPassword: "a-temporary-password" });
      await sequence.settle("acme");

      const state = sequence.state("acme");
      assert.deepEqual(state.steps.map((one) => one.label), LABELS);
      assert.deepEqual(state.steps.map((one) => one.state), ["ok", "ok", "ok", "ok", "ok"], JSON.stringify(state.steps, null, 2));
      assert.equal(state.done, true);
      assert.equal(state.stopped, null);
      // Every step carries the moment it was written down, which is where the wall clock per step
      // comes from.
      for (const step of state.steps) assert.match(String(step.at), /^\d{4}-\d\d-\d\dT/);

      // THE NEGATIVE. Exactly two commands reached that box, and neither of them is a prompt.
      assert.deepEqual([...new Set(box.commands())].sort(), ["getOnboardingState", "listAgents"]);
      assert.equal(box.countOf("sendPrompt"), 0);
      assert.equal(box.countOf("createAgent"), 0);
      assert.equal(box.countOf("resetOnboarding"), 0);
      // And /health was really asked for, with the workspace's own bearer.
      const health = box.calls.filter((call) => call.path === "/health");
      assert.equal(health.length >= 1, true);
      assert.equal(health[0].bearer.length > 0, true);

      // The model was pushed BEFORE Titan was read, because a box nobody pointed at a model has
      // Titan awake and mute.
      const order = relay.routes();
      assert.ok(order.indexOf("POST /admin/tenants/acme/use-included") < order.indexOf("GET /admin/tenants/acme/running"), order.join(", "));
      // The sweep was asked for PER SLUG, so onboarding one customer does not reach into every
      // other customer's box.
      assert.deepEqual(relay.callsTo("POST /mail/sweep").map((call) => call.body), [{ slug: "acme" }]);

      // The welcome carried Titan's own address and a link, and carried no sender of its own.
      assert.equal(welcome.sends.length, 1);
      assert.equal(welcome.sends[0].to, "owner@acme.invalid");
      assert.equal(welcome.sends[0].titanAddress, "agent123456@myagents.email");
      assert.equal(welcome.sends[0].temporaryPassword, "a-temporary-password");
      assert.match(welcome.sends[0].mintedLink.url, /\/login\?sso=/);
      assert.equal(Object.keys(welcome.sends[0]).includes("from"), false, "the control plane handed the mail a sender");
    });
  } finally { await box.close(); await relay.close(); await welcome; }
});

test("a box that never answers leaves Building the computer amber and never reaches the welcome", async () => {
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      // No box at all: the probe refuses, which is what a container with no host listening looks
      // like from out here.
      const sequence = sequenceOver(plane, { box: null, relay, welcome, mail: mailAfter("acme") });
      sequence.start({ slug: "acme", sendWelcome: true });
      await sequence.settle("acme");

      const state = sequence.state("acme");
      assert.equal(state.byKey?.box?.state ?? state.steps[1].state, "amber");
      assert.match(state.steps[1].why, /has not answered on \/health/);
      assert.match(state.steps[1].next, /Press Retry/);
      // And nothing after it ran. A welcome on a box nobody can open is worse than no welcome.
      assert.deepEqual(state.steps.map((one) => one.state), ["ok", "amber", "waiting", "waiting", "waiting"]);
      assert.equal(welcome.sends.length, 0);
      assert.equal(state.retryable, true);
    });
  } finally { await relay.close(); }
});

test("a provisioning failure keeps the account, and Retry resumes at the step that stopped", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      let attempts = 0;
      const provision = async ({ store, slug }) => {
        attempts += 1;
        if (attempts === 1) {
          store.recordStep({ slug, step: "service", status: "failed", detail: JSON.stringify({ why: "Coolify said no" }) });
          return { ok: false, step: "service", error: "Coolify said no" };
        }
        return { ok: true };
      };
      const sequence = sequenceOver(plane, { box, relay, welcome, provision, mail: mailAfter("acme") });
      sequence.start({ slug: "acme", sendWelcome: true });
      await sequence.settle("acme");

      let state = sequence.state("acme");
      assert.equal(state.steps[1].state, "failed");
      assert.equal(state.steps[1].detail.step, "service");
      assert.equal(welcome.sends.length, 0);
      // THE ACCOUNT STAYS. A slow image pull must not cost a customer their existence.
      assert.equal(plane.store.listAccountsForTenant("acme").length, 1);

      // Retry picks up at the first step that is not ok, which is the box, and goes through.
      sequence.retry("acme");
      await sequence.settle("acme");
      state = sequence.state("acme");
      assert.deepEqual(state.steps.map((one) => one.state), ["ok", "ok", "ok", "ok", "ok"], JSON.stringify(state.steps, null, 2));
      assert.equal(attempts, 2);
      // And the plan the operator asked for survived a Retry that read it back out of the ledger.
      assert.equal(welcome.sends.length, 1);
    });
  } finally { await box.close(); await relay.close(); }
});

test("a plan model nothing reads back stops the job before the welcome, with Titan amber", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  // The push works and the read-back says the workspace names no model, which is exactly the state
  // writeBoxDefaults leaves a box in: Titan is awake and has nothing to answer with.
  const relay = await startStubRelay({ running: { read: true, model: "", modelLabel: "", pinned: false } });
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      const sequence = sequenceOver(plane, { box, relay, welcome, mail: mailAfter("acme") });
      sequence.start({ slug: "acme", planModel: "plan-zai", sendWelcome: true });
      await sequence.settle("acme");

      const state = sequence.state("acme");
      // The welcome is WAITING and not amber: it was asked for and it never ran, which is a
      // different fact from "nobody asked for one". Amber would read as done-with-a-caveat.
      assert.deepEqual(state.steps.map((one) => one.state), ["ok", "ok", "amber", "waiting", "waiting"]);
      assert.equal(state.steps[2].next, TITAN_NO_MODEL);
      assert.equal(welcome.sends.length, 0, "a mute Titan got a welcome sent about him");
      // The box was still only READ, even on the path that stops.
      assert.deepEqual([...new Set(box.commands())], []);
    });
  } finally { await box.close(); await relay.close(); }
});

test("a sweep that is already running is retried, and green waits for a live row in the directory", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  let sweeps = 0;
  const relay = await startStubRelay({
    // The relay's own words and its own status for a sweep that is already going. It is a retry in a
    // moment and never a failed onboarding.
    sweep: () => { sweeps += 1; return sweeps < 3 ? { ok: false, why: "a sweep is already running", status: 503 } : { ok: true, swept: [] }; },
  });
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      // The directory only holds a row once the sweep has actually worked, which is the signal. A
      // 200 from the sweep is not: it can answer cheerfully green over a workspace it never named.
      const sequence = sequenceOver(plane, { box, relay, welcome, mail: mailAfter("acme", { on: () => sweeps >= 3 }) });
      sequence.start({ slug: "acme", sendWelcome: true });
      await sequence.settle("acme");

      const state = sequence.state("acme");
      assert.equal(state.steps[3].state, "ok", JSON.stringify(state.steps[3]));
      assert.equal(state.steps[3].detail.sweeps >= 3, true);
      assert.equal(state.steps[3].detail.titanAddress, "agent123456@myagents.email");
      assert.equal(sweeps >= 3, true);
    });
  } finally { await box.close(); await relay.close(); }
});

test("a sweep that never mints an address leaves the step amber with a second press offered", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      const sequence = sequenceOver(plane, { box, relay, welcome, mail: () => ({ directory: () => ({ tenants: {} }) }) });
      sequence.start({ slug: "acme", sendWelcome: true });
      await sequence.settle("acme");

      const state = sequence.state("acme");
      assert.equal(state.steps[3].state, "amber");
      assert.equal(state.steps[3].next, ADDRESSES_NONE);
      assert.equal(welcome.sends.length, 0);
    });
  } finally { await box.close(); await relay.close(); }
});

test("with no welcome sender in the checkout the step says so rather than throwing", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      // No welcome dep, and cp/welcome.mjs is resolved by a dynamic import INSIDE the step, so this
      // is the shape of a control plane built before that file landed.
      const sequence = sequenceOver(plane, { box, relay, welcome: null, mail: mailAfter("acme") });
      sequence.start({ slug: "acme", sendWelcome: true });
      await sequence.settle("acme");

      const state = sequence.state("acme");
      assert.deepEqual(state.steps.map((one) => one.state).slice(0, 4), ["ok", "ok", "ok", "ok"]);
      const last = state.steps[4];
      assert.equal(["amber", "ok"].includes(last.state), true, JSON.stringify(last));
      if (last.state === "amber") assert.equal(last.why, WELCOME_NO_SENDER);
    });
  } finally { await box.close(); await relay.close(); }
});

test("a welcome sent to a different address goes THERE and to nobody else", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme", ownerEmail: "owner@acme.invalid" });
      const sequence = sequenceOver(plane, { box, relay, welcome, mail: mailAfter("acme") });
      sequence.start({ slug: "acme", sendWelcome: true, welcomeTo: "somebody@example.com" });
      await sequence.settle("acme");

      // ONE recipient. A copy to a third party would put a live sign-in link and a password for this
      // customer's workspace in somebody else's inbox until the link expires, and that link is a
      // bearer the relay never checks for revocation.
      assert.equal(welcome.sends.length, 1);
      assert.equal(welcome.sends[0].to, "somebody@example.com");
      assert.equal(welcome.sends[0].overridden, true);
      const row = sequence.state("acme").steps[4];
      assert.equal(row.detail.to, "somebody@example.com");
      assert.equal(row.detail.overridden, true);
      assert.equal(row.detail.ownerEmail, "owner@acme.invalid");
    });
  } finally { await box.close(); await relay.close(); }
});

test("no ledger row anywhere carries the password or the sign-in link", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      const sequence = sequenceOver(plane, { box, relay, welcome, mail: mailAfter("acme") });
      sequence.start({ slug: "acme", sendWelcome: true, temporaryPassword: "zzz-the-secret-zzz" });
      await sequence.settle("acme");
      const rows = JSON.stringify(plane.store.listSteps("acme"));
      assert.equal(rows.includes("zzz-the-secret-zzz"), false, "the temporary password reached the provisioning ledger");
      assert.equal(rows.includes("sso="), false, "a sign-in link reached the provisioning ledger");
    });
  } finally { await box.close(); await relay.close(); }
});

test("two presses cannot build two boxes for one company", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  try {
    await withPlane(async (plane) => {
      plane.seedTenant({ slug: "acme" });
      let builds = 0;
      const sequence = sequenceOver(plane, {
        box, relay, mail: mailAfter("acme"),
        provision: async () => { builds += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { ok: true }; },
      });
      const first = sequence.start({ slug: "acme" });
      const second = sequence.start({ slug: "acme" });
      assert.equal(first.started, true);
      assert.equal(second.started, false);
      assert.equal(second.jobId, first.jobId);
      await sequence.settle("acme");
      assert.equal(builds, 1);
    });
  } finally { await box.close(); await relay.close(); }
});

test("Send again mints a fresh link and leaves the password where it is", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      const seeded = plane.seedTenant({ slug: "acme" });
      plane.store.setAccountPassword(seeded.account.id, "the-first-password");
      const sequence = sequenceOver(plane, { box, relay, welcome, mail: mailAfter("acme") });
      sequence.start({ slug: "acme", sendWelcome: true });
      await sequence.settle("acme");
      const firstLink = welcome.sends[0].mintedLink.url;

      const again = await sequence.welcome("acme", { to: "elsewhere@example.com" });
      assert.equal(again.ok, true);
      assert.equal(welcome.sends.length, 2);
      assert.equal(welcome.sends[1].to, "elsewhere@example.com");
      assert.notEqual(welcome.sends[1].mintedLink.url, firstLink, "Send again reused a link");
      // The second send still knows Titan's address, read back out of the ledger rather than the job.
      assert.equal(welcome.sends[1].titanAddress, "agent123456@myagents.email");
      // THE PASSWORD IS UNTOUCHED. The original is a scrypt hash nobody can ask back, and changing
      // it would lock out a customer who has already signed in.
      assert.equal(plane.store.verifyAccountPassword(seeded.account.email, "the-first-password").ok, true);
    });
  } finally { await box.close(); await relay.close(); }
});

// ---- the routes --------------------------------------------------------------------------------

test("the 202 arrives in well under a second carrying the password, against a box that never comes up", async () => {
  const relay = await startStubRelay();
  try {
    await withPlane(async (plane) => {
      const started = Date.now();
      const answer = await plane.request("POST", "/v1/admin/clients", {
        body: { email: "Jane@AcmeRoofing.com", company: "Acme Roofing & Sons", name: "Jane Doe", planModel: "plan-zai", ceiling: 40, sendWelcome: true },
      });
      const took = Date.now() - started;
      assert.equal(answer.status, 202, answer.text);
      assert.equal(took < 1000, true, `the invite blocked for ${took} ms`);
      // THE PASSWORD IS IN THE FIRST ANSWER AND NOWHERE ELSE, before any waiting, so no timeout can
      // swallow it. This is the whole reason the route is a 202.
      assert.equal(String(answer.body.temporaryPassword).length, 24);
      assert.equal(answer.body.slug, "acme-roofing-sons");
      assert.equal(answer.body.jobId.length > 0, true);
      assert.deepEqual(answer.body.steps.map((one) => one.label), LABELS);
      assert.equal(answer.body.steps[0].state, "ok");
      assert.equal(answer.body.welcomeMail.asked, true);
      assert.equal(answer.body.welcomeMail.to, "jane@acmeroofing.com");
      assert.equal(answer.body.welcomeMail.replyTo, "support@titaniumcomputing.com");

      // And it really signs in with it, which is the promise the card makes.
      assert.equal(plane.store.getAccountByEmail("jane@acmeroofing.com") != null, true);
    }, { relay });
  } finally { await relay.close(); }
});

test("the poll route is a pure read and the password is in none of its answers", async () => {
  await withPlane(async (plane) => {
    const added = await plane.request("POST", "/v1/admin/clients", { body: { email: "jane@acme.com", company: "Acme" } });
    assert.equal(added.status, 202, added.text);
    const password = added.body.temporaryPassword;
    const polled = await plane.request("GET", "/v1/admin/clients/acme/onboarding");
    assert.equal(polled.status, 200, polled.text);
    assert.deepEqual(polled.body.steps.map((one) => one.label), LABELS);
    assert.equal(polled.text.includes(password), false, "the temporary password came back out of the poll route");
    const listed = await plane.request("GET", "/v1/admin/clients");
    assert.equal(listed.text.includes(password), false, "the temporary password came back out of the clients panel");
    assert.deepEqual(listed.body.clients[0].onboarding.steps.map((one) => one.label), LABELS);
    const actions = await plane.request("GET", "/v1/admin/actions");
    assert.equal(actions.text.includes(password), false, "the temporary password reached the record of who changed what");
    // A workspace nobody has heard of is a 404 and not five waiting steps.
    assert.equal((await plane.request("GET", "/v1/admin/clients/nobody/onboarding")).status, 404);
  });
});

test("the sign-in link route answers it once and writes the address, never the link", async () => {
  await withPlane(async (plane) => {
    plane.seedTenant({ slug: "acme", ownerEmail: "jane@acme.com" });
    const answer = await plane.request("POST", "/v1/admin/clients/acme/sign-in-link", { body: {} });
    assert.equal(answer.status, 200, answer.text);
    assert.match(answer.body.url, /^https:\/\/console\.titanium\.bot\/login\?sso=/);
    assert.equal(answer.body.email, "jane@acme.com");
    const actions = await plane.request("GET", "/v1/admin/actions");
    const row = actions.body.rows.find((one) => one.action === "client.sign-in-link");
    assert.equal(row.target, "acme");
    assert.equal(actions.text.includes("sso="), false, "a sign-in link reached the record of who changed what");
    assert.match(row.detail, /24 hour sign-in link/);
  });
});

test("the welcome route reaches its injected sender with the parsed arguments", async () => {
  const welcome = stubWelcome();
  await withPlane(async (plane) => {
    plane.seedTenant({ slug: "acme", ownerEmail: "jane@acme.com" });
    const answer = await plane.request("POST", "/v1/admin/clients/acme/welcome", { body: { to: "Somebody@Example.com " } });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body.sent, true);
    assert.equal(answer.body.shape, "link only", "a send with no password to carry was reported as carrying one");
    assert.equal(welcome.sends.length, 1);
    // Parsed: normalised and trimmed by the route, not by the sender.
    assert.equal(welcome.sends[0].to, "somebody@example.com");
    assert.equal(welcome.sends[0].slug, "acme");
    assert.equal(welcome.sends[0].account.email, "jane@acme.com");
    assert.match(answer.body.signIn, /\/login\?sso=/);
  }, { deps: { welcome } });
});

test("a welcome asked for with a new password resets it, shows it once and says which shape went", async () => {
  const welcome = stubWelcome();
  await withPlane(async (plane) => {
    const seeded = plane.seedTenant({ slug: "acme", ownerEmail: "jane@acme.com" });
    const before = plane.store.getAccountById(seeded.account.id).passwordHash;
    const answer = await plane.request("POST", "/v1/admin/clients/acme/welcome", { body: { withNewPassword: true } });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(String(answer.body.temporaryPassword).length, 24);
    // THE SHAPE COMES FROM THE SENDER and never from the route's guess. A Send again on a workspace
    // whose first password was never handed back carries the link alone, and a card that said
    // otherwise would describe a mail that does not exist.
    assert.equal(answer.body.shape, "link and a password");
    // Proved the way a person would meet it: the old one stops working and the new one is the one
    // on the card. No hash comes back out of this store, deliberately.
    assert.equal(plane.store.verifyAccountPassword("jane@acme.com", before).ok, false);
    assert.equal(plane.store.verifyAccountPassword("jane@acme.com", answer.body.temporaryPassword).ok, true);
    assert.equal(welcome.sends[0].temporaryPassword, answer.body.temporaryPassword);
    const actions = await plane.request("GET", "/v1/admin/actions");
    assert.equal(actions.text.includes(answer.body.temporaryPassword), false, "a welcome's new password reached the record");
  }, { deps: { welcome } });
});

test("Remove refuses a confirm that is not the workspace name and does nothing at all", async () => {
  const decommission = stubDecommission();
  await withPlane(async (plane) => {
    plane.seedTenant({ slug: "acme" });
    const wrong = await plane.request("DELETE", "/v1/admin/clients/acme", { body: { confirm: "acme-roofing", deleteData: true } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "confirm");
    assert.match(wrong.body.message, /called acme/);
    // NOTHING HAPPENED. Not a stop, not a disable, nothing.
    assert.equal(decommission.removals.length, 0);
    assert.equal(plane.store.getTenant("acme") != null, true);

    const missing = await plane.request("DELETE", "/v1/admin/clients/nobody", { body: { confirm: "nobody" } });
    assert.equal(missing.status, 404);
    assert.equal(decommission.removals.length, 0);
  }, { deps: { decommission } });
});

test("Remove reaches its injected removal with the slug, the data switch and who pressed it", async () => {
  const decommission = stubDecommission({
    answer: { ok: true, effects: [{ name: "container-gone", ok: true, detail: "docker says it is absent" }], message: "acme is gone" },
  });
  await withPlane(async (plane) => {
    plane.seedTenant({ slug: "acme" });
    const answer = await plane.request("DELETE", "/v1/admin/clients/acme", { body: { confirm: "acme", deleteData: true } });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body.dataDeleted, true);
    assert.deepEqual(answer.body.effects.map((one) => one.name), ["container-gone"]);
    assert.equal(decommission.removals.length, 1);
    assert.equal(decommission.removals[0].slug, "acme");
    assert.equal(decommission.removals[0].deleteData, true);
    assert.equal(decommission.removals[0].actor, "the operator token");
    // And the record says what it was asked to do, before it was done.
    const actions = await plane.request("GET", "/v1/admin/actions");
    const row = actions.body.rows.find((one) => one.action === "client.remove");
    assert.equal(row.target, "acme");
    assert.match(row.detail, /deleting their data/);
    assert.match(row.outcome, /^ok$/);

    // With the switch off the route says the data is kept, in the removal's own words.
    plane.seedTenant({ slug: "beta" });
    const kept = await plane.request("DELETE", "/v1/admin/clients/beta", { body: { confirm: "beta" } });
    assert.equal(kept.status, 200, kept.text);
    assert.equal(kept.body.dataDeleted, false);
    assert.equal(decommission.removals[1].deleteData, false);
  }, { deps: { decommission } });
});

test("a control plane with no removal in it touches nothing and says so", async () => {
  await withPlane(async (plane) => {
    plane.seedTenant({ slug: "acme" });
    const answer = await plane.request("DELETE", "/v1/admin/clients/acme", { body: { confirm: "acme", deleteData: true } });
    assert.equal(answer.status, 501, answer.text);
    assert.match(answer.body.message, /no removal in it/);
    assert.equal(plane.store.getTenant("acme") != null, true);
    // And the plan route says it cannot say, rather than drawing an empty list of effects, which
    // would read as "this is harmless".
    const plan = await plane.request("GET", "/v1/admin/clients/acme/removal");
    assert.equal(plan.status, 200);
    assert.equal(plan.body.read, false);
    assert.deepEqual(plan.body.effects, []);
    assert.match(plan.body.why, /no removal in it yet/);
  });
});

test("a retry while the job is still going is refused rather than run twice", async () => {
  const box = await startStubBox({ answers: freshBoxAnswers, health: "refuse" });
  const coolify = await startFakeCoolify();
  try {
    await withPlane(async (plane) => {
      const added = await plane.request("POST", "/v1/admin/clients", { body: { email: "jane@acme.com", company: "Acme" } });
      assert.equal(added.status, 202, added.text);
      const again = await plane.request("POST", "/v1/admin/clients/acme/onboard", { body: {} });
      assert.equal(again.status, 409);
      assert.equal(again.body.error, "already_running");
      assert.deepEqual(again.body.steps.map((one) => one.label), LABELS);
    }, { coolify, probeImpl: probeThrough(box), onboard: { healthBudgetMs: 3_000, healthIntervalMs: 60 } });
  } finally { await box.close(); await coolify.close(); }
});

test("the welcome record is read through a guard, so a control plane without that table still draws a row", async () => {
  await withPlane(async (plane) => {
    plane.seedTenant({ slug: "acme" });
    const answer = await plane.request("GET", "/v1/admin/clients/acme/welcome");
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.body.read, false);
    assert.deepEqual(answer.body.rows, []);
    assert.match(answer.body.why, /no record of welcome sends/);
    assert.equal(answer.body.replyTo, "support@titaniumcomputing.com");
  });
});

test("the reply-to the mail carries is a setting, with a default on a domain that already receives", async () => {
  await withPlane(async (plane) => {
    plane.seedTenant({ slug: "acme" });
    assert.equal((await plane.request("GET", "/v1/admin/clients/acme/welcome")).body.replyTo, "support@titaniumcomputing.com");
    plane.store.setSetting("mail.welcome.replyTo", "help@titanium.bot", "a test");
    assert.equal((await plane.request("GET", "/v1/admin/clients/acme/welcome")).body.replyTo, "help@titanium.bot");
  });
});

test("Coolify reporting the container running is not enough: the box step waits for the box's own health", async () => {
  // THE DISTINCTION THE STEP EXISTS FOR, driven through the real route against a real
  // provisionTenant. The fake Coolify starts the service and reports it running, so the provisioner's
  // own wait answers ready how "coolify". Nothing is listening inside it, so this step stays amber
  // and the welcome never goes. A welcome sent on Coolify's word reaches a customer whose workspace
  // cannot be opened.
  const coolify = await startFakeCoolify();
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      const added = await plane.request("POST", "/v1/admin/clients", { body: { email: "jane@acme.com", company: "Acme", sendWelcome: true } });
      assert.equal(added.status, 202, added.text);
      await plane.admin.onboarding.settle("acme");

      const steps = plane.store.listSteps("acme");
      const ready = steps.filter((one) => one.step === "ready");
      assert.equal(JSON.parse(ready[0].detail).how, "coolify", `the fake Coolify did not report the container running: ${ready[0]?.detail}`);

      const state = (await plane.request("GET", "/v1/admin/clients/acme/onboarding")).body;
      assert.equal(state.steps[1].state, "amber", JSON.stringify(state.steps[1]));
      assert.match(state.steps[1].why, /has not answered on \/health/);
      assert.equal(welcome.sends.length, 0, "a welcome went out about a box nothing is listening in");
    }, { coolify, relay, deps: { welcome }, probeImpl: probeRefuses, onboard: { healthBudgetMs: 120, healthIntervalMs: 20 } });
  } finally { await coolify.close(); await relay.close(); }
});

test("the whole invite, through the route, from one press to a welcome carrying Titan's own address", async () => {
  const coolify = await startFakeCoolify();
  const box = await startStubBox({ answers: freshBoxAnswers });
  const relay = await startStubRelay();
  const welcome = stubWelcome();
  try {
    await withPlane(async (plane) => {
      const added = await plane.request("POST", "/v1/admin/clients", {
        body: { email: "jane@acme.com", company: "Acme Roofing", name: "Jane Doe", planModel: "plan-zai", ceiling: 40, sendWelcome: true, welcomeTo: "test@titaniumcomputing.invalid" },
      });
      assert.equal(added.status, 202, added.text);
      // The override is said on the card in plain words, before anything is sent.
      assert.equal(added.body.welcomeMail.overridden, true);
      assert.match(added.body.welcomeMail.why, /will go to test@titaniumcomputing\.invalid and not to jane@acme\.com/);

      // The address the sweep would mint, minted here the way the relay's mint door mints it, so the
      // mail can tell the customer where to write to Titan.
      plane.store.mintMailCode({ tenant: "acme-roofing", agentId: TITAN.id, agentName: "Titan", domain: "myagents.email" });
      await plane.admin.onboarding.settle("acme-roofing");

      const state = (await plane.request("GET", "/v1/admin/clients/acme-roofing/onboarding")).body;
      assert.deepEqual(state.steps.map((one) => one.state), ["ok", "ok", "ok", "ok", "ok"], JSON.stringify(state.steps, null, 2));
      assert.equal(state.done, true);
      // The box was READ and never prompted, on the real route too.
      //
      // `health` is in this set and is NOT this sequence's call: provisionTenant's own waitForBox
      // probes ${gateway}/api/health, which the host does not serve, and counts the 404 as proof the
      // box is up. That is a pre-existing defect with an owner -- it is fixed in the provisioning item
      // of this same wave, which corrects the path to /health -- and it is named here rather than
      // swept under the assertion, because a gate that quietly allowed one extra command would allow
      // the next one too.
      assert.deepEqual([...new Set(box.commands())].filter((one) => one !== "health").sort(), ["getOnboardingState", "listAgents"]);
      for (const forbidden of ["sendPrompt", "createAgent", "resetOnboarding"]) assert.equal(box.countOf(forbidden), 0);
      assert.equal(welcome.sends.length, 1);
      assert.equal(welcome.sends[0].to, "test@titaniumcomputing.invalid");
      assert.match(String(welcome.sends[0].titanAddress), /^agent\d{6}@myagents\.email$/);
      // And the clients panel carries the same five steps on the customer's own row.
      const listed = (await plane.request("GET", "/v1/admin/clients")).body;
      assert.deepEqual(listed.clients[0].onboarding.steps.map((one) => one.state), ["ok", "ok", "ok", "ok", "ok"]);
    }, { coolify, relay, deps: { welcome }, probeImpl: probeThrough(box), onboard: { healthBudgetMs: 2_000, healthIntervalMs: 20, addressBudgetMs: 2_000 } });
  } finally { await coolify.close(); await box.close(); await relay.close(); }
});
