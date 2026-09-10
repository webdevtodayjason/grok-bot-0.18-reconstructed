// cp/onboard.mjs -- the invite, as a job with five named steps an operator can watch.
//
// ONBOARD-2. Jason, 2026-09-10 10:54: "Is the super admin panel ready in a state where I can invite
// a user and it will handle the full onboarding process, including creating the account and
// workspace, creating a Docker container for the AI agents, setting up their emails? Is the entire
// process ready? Is the welcome email sent out?"
//
// It was not. ADMIN-2 built Add a client and it built it as ONE SYNCHRONOUS REQUEST, which is the
// shape this file exists to replace.
//
// WHY THE INVITE CANNOT BE ONE REQUEST. api.titanium.bot is behind Cloudflare (measured 2026-09-10:
// server cloudflare, cf-ray a38fb0ce0e2ec476-AUS), which cuts a proxied request at about 100
// seconds. POST /v1/admin/clients already blocked for up to CP_BOX_READY_TIMEOUT_MS (90 s on the
// R750) plus the Coolify calls plus two relay round trips. Adding a wait for Titan, an address sweep
// and a mail send to that guarantees a 524 with a half-built tenant behind it AND THE TEMPORARY
// PASSWORD LOST WITH THE RESPONSE, on the one screen where losing it costs a customer their account.
//
// So the route answers 202 the moment the two rows exist, carrying the password, and this file runs
// the rest as a job the card polls.
//
// WHERE THE STATE LIVES: the EXISTING provisioning ledger (store.recordStep / store.listSteps),
// which takes any step name and any status. Nothing here holds job state in memory that matters. A
// control plane restart mid-onboarding loses the runner and loses nothing else: the poll route is a
// pure read of that ledger, a page reload rejoins, and Retry resumes at the first step that is not
// ok. The in-process Map below holds ONE thing, "is a runner already going for this slug", so two
// presses cannot build two boxes.
//
// THE ONE RULE THAT IS NOT NEGOTIABLE: THIS FILE NEVER PROMPTS A BOX.
//
// source/host/agent-isolation/onboarding-state.ts marks a box done:true with doneReason
// "existing-box" FOR EVER if, at the FIRST read, it holds more than one bot or any agent with a
// prompted conversation. One smoke prompt from the control plane permanently destroys the
// customer's first-run interview, with no error and no way back (resetOnboarding is 403 without
// SAND_TEST_HOOKS). So every box read here is listAgents and getOnboardingState and nothing else:
// never sendPrompt, never createAgent, never a probe agent, never a smoke turn. The inverse is
// protective and is why step 3 reads early on purpose -- a getOnboardingState read on a fresh box
// WRITES done:false and locks the first run in.

import { randomUUID } from "node:crypto";

import {
  boxContainerName,
  provisionTenant,
  readGatewayToken,
} from "./provision.mjs";
import { mintSessionToken, tenantSessionSecret } from "./session.mjs";

// ---- the five steps, in Jason's own words -----------------------------------------------------
//
// These strings are what the card draws. They are here rather than in the page because the CLI and
// the route answer them too, and three copies of five labels is three chances to disagree about
// which step a customer's onboarding stopped at.

export const ONBOARD_STEP_KEYS = ["workspace", "box", "titan", "addresses", "welcome"];

export const ONBOARD_LABELS = {
  workspace: "Creating the workspace",
  box: "Building the computer",
  titan: "Waking Titan",
  addresses: "Giving the agents their addresses",
  welcome: "Sending the welcome",
};

// The ledger step names this file writes, beside provisionTenant's own eight.
//
// `plan-model` and not `plan`: provisionTenant's dry run already writes a step called `plan`
// (cp/provision.mjs, the dryRun branch), so a slug that was dry-run before it was built would have
// this file reading a rendering report as a model push. One character of prefix, and the two facts
// stay two facts.
export const LEDGER = {
  workspace: "workspace",
  box: "box-ready",
  plan: "plan-model",
  titan: "titan",
  addresses: "addresses",
  welcome: "welcome",
};

// provisionTenant's eight, in its own order. Read here for one purpose: when the box step is not
// green, WHICH of the eight stopped is the only thing an operator can act on.
const PROVISION_STEPS = ["directories", "secrets", "compose", "service", "envs", "proxy-key", "start", "ready"];

// ---- the sentences ----------------------------------------------------------------------------
//
// Named constants for the same reason cp/signup.mjs names its refusals: these are read by a person
// deciding what to press, they are asserted by tests, and a copy of one of them in the page would
// be a second explanation of the same stop.

export const TITAN_NO_MODEL =
  "Titan is up but has no model yet, so he would not answer. Fix the model on this row, then press Send the welcome.";
// THE SAME STOP WITH A DIFFERENT THING TO GO AND DO, and the difference is why this constant exists.
// On the R750 at 19:31:27Z on 2026-09-10 the model was right, the plan was right and the key was
// minted: the relay refused the push because its own registry had read the box's container name a
// few seconds before the container existed. TITAN_NO_MODEL sent the operator to fix a row that had
// nothing wrong with it. When the refusal came from the relay, say so and say the wait.
export const TITAN_MODEL_REFUSED =
  "The model could not be pushed into that workspace yet, so Titan has nothing to answer with. Press Retry: a box that has only just come up clears this by itself within a minute.";
export const ADDRESSES_NONE =
  "Their bots have no addresses yet, so the welcome cannot tell them where to write to Titan. Press Retry, or send the welcome anyway.";
export const WELCOME_NOT_ASKED =
  "No welcome was asked for, so nothing was sent. The temporary password is on the card above.";
export const WELCOME_NO_SENDER =
  "This control plane has no welcome sender in it, so nothing was sent. The temporary password is on the card above.";
export const STALLED =
  "This step has not written anything down for three minutes. Press Retry.";

// ---- the tunables -----------------------------------------------------------------------------
//
// Read from the environment at CALL time rather than at import, so a gate can set one without a
// module cache getting in the way, and so the defaults are the numbers a production box runs.
//
// The health budget is ten minutes and not ninety seconds on purpose. A cold box on a server that
// has never pulled the image has never been measured end to end, and CP_BOX_READY_TIMEOUT_MS is the
// PROVISIONER's ceiling, after which it answers ok:true boxReady:false and carries on. That answer
// means keep waiting. It has never meant ready to mail.
const TUNABLES = {
  deadlineMs: ["CP_ONBOARD_DEADLINE_MS", 600_000],
  healthBudgetMs: ["CP_ONBOARD_HEALTH_BUDGET_MS", 600_000],
  healthIntervalMs: ["CP_ONBOARD_HEALTH_INTERVAL_MS", 3_000],
  healthProbeTimeoutMs: ["CP_ONBOARD_HEALTH_PROBE_MS", 5_000],
  addressBudgetMs: ["CP_ONBOARD_ADDRESS_BUDGET_MS", 180_000],
  // 150 s and not 60 s, which is arithmetic and not padding: the relay's tenant registry refreshes
  // on a 60 second timer (ui/tenant-registry.mjs), and the read loop below is what keeps pushing the
  // plan model while that clock comes round. A 60 second budget loses a race with a 60 second timer
  // about half the time, which is what it did on the R750 on 2026-09-10. This outlasts one full
  // cycle even on a relay that never got the out-of-schedule refresh.
  runningBudgetMs: ["CP_ONBOARD_RUNNING_BUDGET_MS", 150_000],
  boxCallTimeoutMs: ["CP_ONBOARD_BOX_CALL_MS", 20_000],
  stallMs: ["CP_ONBOARD_STALL_MS", 180_000],
};

function tuned(name, given, env = process.env) {
  if (Number.isFinite(Number(given)) && Number(given) > 0) return Number(given);
  const [key, fallback] = TUNABLES[name];
  const read = Number(env?.[key]);
  return Number.isFinite(read) && read > 0 ? read : fallback;
}

const notMeasured = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 300);
const parse = (detail) => { try { return JSON.parse(String(detail ?? "")); } catch { return {}; } };

/** The last row written for a step name, or null. listSteps comes back ordered by id. */
function lastOf(rows, step) {
  let held = null;
  for (const row of rows) if (row.step === step) held = row;
  return held;
}

// ---- the fold: a ledger into five card steps --------------------------------------------------
//
// A PURE FUNCTION over the rows, exported so a test can drive every state without a job, and so the
// poll route is a read with no side effect at all.
//
// Five states and no sixth:
//   waiting  nothing has started this yet
//   running  it is going, and the ledger says when it last wrote something down
//   ok       green
//   amber    it is DONE and there is a named caveat on it, or it stopped for a reason a person can
//            act on. An amber on Waking Titan or on the addresses stops the job before the welcome.
//   failed   it stopped and nothing after it ran
//
// A running step whose last ledger write is older than the stall window reads as stalled, which the
// card draws with the same Retry a failure gets. That is what a control plane restart mid-job looks
// like from the outside, and it has to look like something.
export function foldSteps(rows, { at = Date.now(), stallMs = 180_000, sendWelcome = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const last = new Map();
  for (const row of list) last.set(row.step, row);

  const from = (name, { amberOn = [], defaultState = "waiting" } = {}) => {
    const row = last.get(name);
    if (row == null) return { state: defaultState, detail: {}, at: 0 };
    const detail = parse(row.detail);
    const status = String(row.status);
    let state = defaultState;
    if (status === "ok") state = "ok";
    else if (status === "failed") state = "failed";
    else if (status === "running") state = "running";
    else if (status === "amber" || amberOn.includes(status)) state = "amber";
    else state = "amber";
    return { state, detail, at: Number(row.at ?? 0) };
  };

  const steps = [];
  const push = (key, read, extra = {}) => {
    const step = {
      key,
      label: ONBOARD_LABELS[key],
      state: read.state,
      at: read.at,
      why: String(read.detail?.why ?? ""),
      next: String(read.detail?.next ?? ""),
      detail: read.detail ?? {},
      stalled: false,
      // A step the operator deliberately turned off. It is amber rather than green, because nothing
      // happened, and it is NOT counted as a stop, because "the welcome was not asked for" is not a
      // thing anybody has to go and press something about.
      skipped: false,
      ...extra,
    };
    if (step.state === "running" && step.at > 0 && at - step.at > stallMs) {
      step.stalled = true;
      step.next = step.next || STALLED;
    }
    steps.push(step);
    return step;
  };

  // 1. Creating the workspace. Done inside the 202, so its row is written by whoever started the
  //    job. Every refusal happens before it and creates nothing at all.
  push("workspace", from(LEDGER.workspace));

  // 2. Building the computer. The provisioner's eight steps, then this file's own /health answer.
  //    A Coolify container status of running is NOT accepted here: a created container is not a
  //    booted host, and the whole point of the wait is the difference.
  const boxRead = from(LEDGER.box, { amberOn: ["waiting"] });
  if (boxRead.state !== "ok") {
    const broken = PROVISION_STEPS.map((name) => last.get(name)).filter((row) => row != null && row.status === "failed");
    const stopped = broken[broken.length - 1];
    if (stopped != null && boxRead.state !== "running") {
      boxRead.state = "failed";
      boxRead.detail = { ...boxRead.detail, step: stopped.step, why: boxRead.detail?.why || parse(stopped.detail)?.why || String(stopped.detail ?? "") };
    }
  }
  push("box", boxRead);

  // 3. Waking Titan. The plan model FIRST and Titan read second, and that order is not cosmetic:
  //    writeBoxDefaults writes gates.json and {"SAND_BACKEND_URL":""}, so a box nobody pointed at a
  //    model has Titan awake and mute.
  const titanRow = last.get(LEDGER.titan);
  const titanRead = titanRow != null
    ? from(LEDGER.titan)
    : (() => {
      const planRead = from(LEDGER.plan);
      // The model landed and the box has not been read yet: that is this step still going.
      if (planRead.state === "ok") return { ...planRead, state: "running" };
      return planRead;
    })();
  push("titan", titanRead);

  // 4. Giving the agents their addresses.
  push("addresses", from(LEDGER.addresses));

  // 5. Sending the welcome.
  const welcomeRead = from(LEDGER.welcome);
  const skipped = welcomeRead.state === "waiting" && sendWelcome === false;
  if (skipped) {
    welcomeRead.state = "amber";
    welcomeRead.detail = { why: WELCOME_NOT_ASKED };
  }
  push("welcome", welcomeRead, { skipped });

  const byKey = Object.fromEntries(steps.map((step) => [step.key, step]));
  const stopped = steps.find((step) => step.skipped !== true && (step.state === "failed" || step.state === "amber" || step.stalled)) ?? null;
  return {
    steps,
    byKey,
    // Green means all five, and nothing is ever half-green: a step that is amber is a step somebody
    // has to look at, even when the thing after it could have run.
    done: steps.every((step) => step.state === "ok"),
    stopped: stopped == null ? null : stopped.key,
    retryable: stopped != null,
  };
}

/**
 * The sign-in link for an account, minted here. Good for 24 hours, and NOT one-time.
 *
 * UNDERSTAND WHAT THIS IS. A stateless bearer credential in a URL. The relay verifies it with that
 * tenant's derived key (ui/server.mjs's handleSso) and NEVER checks it for revocation, so it works
 * as many times as it is clicked until it expires and cannot be cancelled short of rotating
 * CP_SESSION_SECRET, which signs the whole fleet out. Therefore:
 *
 *   24 hours is a CEILING and not a target.
 *   The link is never written to a send row, an audit row, a log line, a screenshot or a report.
 *   Click tracking is off for titanium.bot so a scanner does not fetch it.
 *
 * It is filed as ONBOARD-5. Every one of the seven claims ui/session-token.mjs requires exists on
 * the rows this makes, so that file is not touched.
 */
export const SIGN_IN_LINK_TTL_MS = 24 * 60 * 60 * 1000;

export function mintSignInLink({ account, tenant, config, now = Date.now(), ttlMs = SIGN_IN_LINK_TTL_MS }) {
  const host = String(tenant?.host ?? "");
  if (host.length === 0) throw new Error("that workspace has no host on its row, so there is nothing to sign in at");
  const at = Number(now);
  const { token, payload } = mintSessionToken({
    sub: String(account?.id ?? ""),
    email: String(account?.email ?? ""),
    tenant: String(tenant?.slug ?? ""),
    host,
    iat: at,
    exp: at + Math.max(60_000, Number(ttlMs)),
    jti: randomUUID(),
  }, tenantSessionSecret(config.sessionSecret, String(tenant?.slug ?? "")), at);
  return { url: `https://${host}/login?sso=${encodeURIComponent(token)}`, expiresAt: new Date(payload.exp).toISOString() };
}

/**
 * The sequencer.
 *
 * Everything it touches is handed in, including provisionTenant, so a test drives the whole of
 * section 1 with no Coolify, no relay, no box and no clock.
 */
export function createOnboarding(options = {}) {
  const {
    store,
    config,
    fetchImpl = globalThis.fetch,
    // The thing that talks to a BOX. Separate from fetchImpl for the reason waitForBox separates
    // them: a test process has no docker network, so a probe of titanbot-box-svc-1:1340 is a name
    // lookup that means nothing. In production they are the same fetch, because the control plane is
    // on titanbot-net for exactly this.
    probeImpl = fetchImpl,
    now = () => Date.now(),
    // UNREF'D, on cp/server.mjs's own peer-timer discipline: an invite that is still waiting for a
    // cold box must never hold a shutdown open, and a test process must never hang on one.
    sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
    askRelay = async () => ({ ok: false, why: "no relay was handed to the onboarding sequence" }),
    askRelayPost = async () => ({ ok: false, why: "no relay was handed to the onboarding sequence" }),
    pointWorkspaceAt = async () => ({ ok: false, why: "no relay was handed to the onboarding sequence" }),
    mailDirectory = () => ({ directory: () => ({ tenants: {} }) }),
    provision = provisionTenant,
    // The two cross-item calls, injectable and defaulted by a dynamic import INSIDE the step that
    // uses them. That is what lets this file parse, run and pass on its own before cp/welcome.mjs
    // exists, and it is the pattern ui/server.mjs already uses for the same reason.
    deps = {},
    log = () => {},
    onCeilingApplied = () => {},
  } = options;

  const ms = {
    deadline: tuned("deadlineMs", options.deadlineMs),
    healthBudget: tuned("healthBudgetMs", options.healthBudgetMs),
    healthInterval: tuned("healthIntervalMs", options.healthIntervalMs),
    healthProbe: tuned("healthProbeTimeoutMs", options.healthProbeTimeoutMs),
    addressBudget: tuned("addressBudgetMs", options.addressBudgetMs),
    runningBudget: tuned("runningBudgetMs", options.runningBudgetMs),
    boxCall: tuned("boxCallTimeoutMs", options.boxCallTimeoutMs),
    stall: tuned("stallMs", options.stallMs),
  };

  // One runner per slug. This Map holds no state a restart would miss: it exists so two presses of
  // Add cannot build two boxes for one company.
  const jobs = new Map();

  const step = (slug, name, status, detail = {}) => {
    store.recordStep({ slug, step: name, status, detail: JSON.stringify(detail) });
    return { ok: status === "ok", status, detail };
  };
  const stop = (slug, name, status, detail) => {
    step(slug, name, status, detail);
    return { ok: false, status, step: name, detail };
  };

  /** What the operator asked for when the job was started, read back out of the ledger. */
  function storedPlan(slug) {
    const row = lastOf(store.listSteps(slug), LEDGER.workspace);
    const held = parse(row?.detail);
    return {
      planModel: String(held.planModel ?? ""),
      ceiling: Number.isFinite(Number(held.ceiling)) ? Number(held.ceiling) : null,
      sendWelcome: held.sendWelcome === true,
      welcomeTo: String(held.welcomeTo ?? ""),
      actor: String(held.actor ?? ""),
      name: String(held.name ?? ""),
      jobId: String(held.jobId ?? ""),
    };
  }

  /** The card's whole answer, as a pure read. */
  function state(slug) {
    const key = String(slug ?? "");
    const tenant = store.getTenant(key);
    const rows = store.listSteps(key);
    const plan = storedPlan(key);
    const folded = foldSteps(rows, { at: now(), stallMs: ms.stall, sendWelcome: rows.some((row) => row.step === LEDGER.workspace) ? plan.sendWelcome : null });
    const held = jobs.get(key);
    return {
      slug: key,
      jobId: held?.jobId || plan.jobId,
      running: held != null,
      tenant: tenant == null ? null : { slug: tenant.slug, name: tenant.name, status: tenant.status, boxReady: tenant.boxReady === true },
      steps: folded.steps.map((one) => ({
        key: one.key,
        // THE SAME TWO FACTS UNDER BOTH NAMES, and this is not tidiness. cp/admin/admin.js reads
        // `key` and `state`; cp/cli.mjs's `signup add` printer and scripts/verify-onboard.mjs both
        // read `name` and `status`. On the merged tip the CLI printed "undefined" for every step and
        // collapsed all five into one line, and the gate's step-order leg read five undefineds. One
        // of the two spellings had to win or both had to be carried; carrying both is the change
        // that breaks no reader.
        name: one.key,
        label: one.label,
        state: one.state,
        status: one.state,
        // ISO, because this is what the card renders and what the R750 measurement reads the wall
        // clock of each step out of.
        at: one.at > 0 ? new Date(one.at).toISOString() : null,
        why: one.why,
        next: one.next,
        stalled: one.stalled,
        detail: one.detail,
      })),
      done: folded.done,
      stopped: folded.stopped,
      retryable: folded.retryable && held == null,
      measuredAt: new Date(now()).toISOString(),
    };
  }

  // ---- step 2: Building the computer ----------------------------------------------------------

  async function buildBox(record) {
    const { slug, plan } = record;
    step(slug, LEDGER.box, "running", { why: "the workspace's computer is being built, then asked for its own health" });

    let built;
    try {
      built = await provision({ store, config, slug, name: plan.name || store.getTenant(slug)?.name || slug, fetchImpl, probeImpl });
    } catch (error) {
      return stop(slug, LEDGER.box, "failed", { step: "provision", why: notMeasured(error), next: "Press Retry. Nothing was lost: the account and the workspace name are still theirs." });
    }
    if (built?.ok !== true) {
      return stop(slug, LEDGER.box, "failed", {
        step: String(built?.step ?? ""),
        why: String(built?.error ?? "the build stopped and said nothing"),
        next: "Press Retry, which picks up at the step that stopped rather than building a second box beside the first.",
      });
    }

    // Which way the provisioner's own wait answered, kept beside ours. `coolify` means a container
    // exists; it does not mean a host booted, which is what the probe below is for.
    const provisionerHow = String(parse(lastOf(store.listSteps(slug), "ready")?.detail)?.how ?? "");

    const tenant = store.getTenant(slug);
    const container = String(tenant?.boxContainer ?? "") || (tenant?.coolifyServiceUuid ? boxContainerName(tenant.coolifyServiceUuid) : "");
    if (container.length === 0) {
      return stop(slug, LEDGER.box, "failed", { why: "this workspace has no container name on its row, so there is nothing to ask for its health", next: "Press Provision on this row." });
    }
    const gateway = boxBase(container);
    const token = readGatewayToken(slug, config) ?? "";

    // WHY ANY ANSWER ON 1340 IS THE PROOF. source/host/main.ts awaits host.start() before it binds
    // the gateway port, so anything answering there -- a 200, a 401, a 404 -- means the host booted
    // and Titan exists. A connection error is the only no.
    const started = now();
    const budget = Math.min(started + ms.healthBudget, record.startedAt + ms.deadline);
    let why = "nothing has answered on that box's port yet";
    for (;;) {
      try {
        const answer = await probeImpl(`${gateway}/health`, {
          headers: token.length > 0 ? { authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(ms.healthProbe),
        });
        const status = Number(answer?.status ?? 0);
        const waitedMs = now() - started;
        step(slug, LEDGER.box, "ok", { how: "health", url: "/health", status, waitedMs, provisioner: provisionerHow });
        // Written back onto the provisioner's own step so a later re-provision does not sit through
        // the wait again for a box this file has already heard answer.
        store.recordStep({
          slug, step: "ready", status: "ok",
          detail: JSON.stringify({ how: "gateway", status, waitedMs, by: "the onboarding sequence's own /health probe" }),
        });
        store.updateTenant(slug, { status: "running", boxReady: true, lastError: null });
        return { ok: true };
      } catch (error) {
        why = `the box has not answered on /health yet (${notMeasured(error)})`;
      }
      if (now() + ms.healthInterval >= budget) break;
      await sleep(ms.healthInterval);
    }
    return stop(slug, LEDGER.box, "waiting", {
      why,
      waitedMs: now() - started,
      next: "Press Retry. A server that has never pulled the image takes longer than this wait, and nothing is lost by waiting again.",
    });
  }

  /**
   * Where a box answers. `http://titanbot-box-<uuid>:1340` on the docker bridge, which is why this
   * control plane is on titanbot-net at all.
   *
   * config.boxUrlOverride (CP_BOX_URL_OVERRIDE) exists for ONE reason: a gate running a real
   * control-plane process cannot reach a container name, and scripts/verify-onboard.mjs has to point
   * these reads at a stub box to measure the sequence at all. It is never set on the R750 and the
   * control-plane install does not write it. A production value here would send every box read for
   * every customer to one address, which the health step would report as the wrong box answering
   * rather than as nothing answering.
   */
  function boxBase(container) {
    const override = String(config?.boxUrlOverride ?? "").trim().replace(/\/+$/, "");
    return override.length > 0 ? override : `http://${container}:1340`;
  }

  // ---- one call into a box, and the two commands this file is allowed to make -------------------

  async function boxCall(slug, command, args = {}) {
    const tenant = store.getTenant(slug);
    const container = String(tenant?.boxContainer ?? "");
    if (container.length === 0) return { ok: false, why: "this workspace has no container name on its row" };
    const token = readGatewayToken(slug, config) ?? "";
    if (token.length === 0) return { ok: false, why: "this workspace's gateway token could not be read, so its box cannot be asked anything" };
    try {
      const answer = await probeImpl(`${boxBase(container)}/api/${command}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(ms.boxCall),
      });
      const text = await answer.text();
      if (Number(answer.status) !== 200) return { ok: false, why: `${command} answered HTTP ${answer.status}` };
      try { return { ok: true, body: text.length > 0 ? JSON.parse(text) : {} }; }
      catch { return { ok: false, why: `${command} answered something that is not json` }; }
    } catch (error) {
      return { ok: false, why: `${command} did not answer (${notMeasured(error)})` };
    }
  }

  // ---- step 3: Waking Titan ---------------------------------------------------------------------

  async function wakeTitan(record) {
    const { slug, plan } = record;
    step(slug, LEDGER.plan, "running", { why: "the plan model and the bot ceiling are being pushed, then Titan is read" });

    // ---- the plan model, pushed and PUSHED AGAIN ------------------------------------------------
    //
    // THE ONE PUSH WAS THE FAULT. This used to push once, at the instant the box first answered
    // /health, and write a refusal down as a note. Measured on the R750 2026-09-10: the push landed
    // 7 s after the container started, the relay's registry had read that workspace's row while the
    // container did not exist yet, so use-included answered 404 "not available" and the box never
    // got a model at all. The read loop below then watched an empty model for 58 s and wrote an
    // amber naming the symptom. A push that can be a moment early has to be retried, inside the
    // budget the read loop already holds, and the refusal has to reach the card.
    //
    // `pinned` is NOT retried. A container whose environment pins its model refuses every push for
    // the same reason for ever, and asking again twenty times is twenty pointless calls into a
    // customer's box.
    const notes = [];
    let applied = null;
    let refusal = "";
    let pushes = 0;
    let pinned = false;
    const pushPlanModel = async () => {
      if (plan.planModel.length === 0 || pinned) return;
      pushes += 1;
      const answer = await pointWorkspaceAt(slug, plan.planModel);
      if (!answer.ok) {
        applied = false;
        refusal = String(answer.why ?? "the relay did not answer");
      } else if (answer.body?.pinned === true) {
        applied = false;
        pinned = true;
        refusal = `this workspace's container environment pins its model (${String(answer.body?.pinnedBy ?? "SAND_OPENAI_COMPATIBLE_* is set on the container")}), so nothing pushed here takes effect there until that is gone`;
      } else {
        applied = true;
        refusal = "";
      }
      if (refusal.length > 0 && !notes.includes(refusal)) notes.push(refusal);
    };
    await pushPlanModel();

    let ceiling = null;
    if (plan.ceiling != null) {
      const answer = await askRelayPost(`/admin/tenants/${encodeURIComponent(slug)}/ceiling`, { maxAgents: plan.ceiling });
      const read = answer.ok && answer.body?.read === true;
      ceiling = {
        asked: plan.ceiling,
        applied: read && answer.body?.pinned !== true,
        // What the BOX read back, never the number that was sent.
        maxAgents: read && Number.isFinite(Number(answer.body?.maxAgents)) ? Number(answer.body.maxAgents) : null,
        why: answer.ok
          ? (answer.body?.pinned === true
            ? `this workspace's container environment pins its ceiling (${String(answer.body?.pinnedBy ?? "SAND_MAX_AGENTS")})`
            : (read ? "" : `the box did not report a ceiling back. ${String(answer.body?.why ?? "")}`.trim()))
          : String(answer.why ?? ""),
      };
      try { onCeilingApplied(slug); } catch { /* a cache that would not clear is not a failed onboarding */ }
    }

    // THE READ-BACK, and it is doing two jobs. It says whether this workspace has a model at all,
    // and it goes through the relay's contextOf, which asks the registry for an out-of-schedule
    // refresh when the workspace it names is unknown OR known and unreachable. So a box that came up
    // after the last refresh is seen on the call after this one rather than a minute later, and the
    // loop below is what turns that into a model: every pass that reads an empty model pushes again.
    let model = "";
    let label = "";
    let modelWhy = "";
    const readStarted = now();
    for (;;) {
      const answer = await askRelay(`/admin/tenants/${encodeURIComponent(slug)}/running`, "");
      if (answer.ok && answer.body?.read === true) {
        model = String(answer.body.model ?? "");
        label = String(answer.body.modelLabel ?? "");
        modelWhy = "";
        if (model.length > 0 || label.length > 0) break;
        modelWhy = "that workspace's own settings name no model";
      } else {
        modelWhy = String(answer.why ?? answer.body?.why ?? "the relay did not answer");
      }
      if (now() + ms.healthInterval >= Math.min(readStarted + ms.runningBudget, record.startedAt + ms.deadline)) break;
      await sleep(ms.healthInterval);
      // AND ASK AGAIN. Only when the push itself was refused: a workspace whose push went through
      // and still reads no model is a different fault, and pushing the same alias at it every three
      // seconds would hide it.
      if (applied === false) await pushPlanModel();
    }

    if (model.length === 0 && label.length === 0) {
      return stop(slug, LEDGER.plan, "amber", {
        model: plan.planModel, applied: applied === true, ceiling, notes, pushes,
        // THE CAUSE AND NOT ONLY THE SYMPTOM. When the relay refused the push, its words are what a
        // person needs; the symptom ("that workspace's own settings name no model") is what they
        // would have gone and tried to fix.
        why: refusal.length > 0
          ? `${modelWhy || "nothing could be read back about what this workspace runs on"}, and the model push was refused: ${refusal}`
          : (modelWhy || "nothing could be read back about what this workspace runs on"),
        next: refusal.length > 0 ? TITAN_MODEL_REFUSED : TITAN_NO_MODEL,
      });
    }
    // `model` and `label` are WHAT THE BOX READ BACK and never the alias that was sent, which is the
    // one field on this row worth trusting. `pushes` above one says the first push was refused and a
    // later one landed, which is the proof the retry is doing something.
    step(slug, LEDGER.plan, "ok", { asked: plan.planModel, applied: applied === true, model, label, ceiling, notes, pushes });

    // ---- and only now, the box itself, READ ONLY -------------------------------------------------
    step(slug, LEDGER.titan, "running", { why: "the box's own roster and first-run state are being read" });

    const roster = await boxCall(slug, "listAgents", {});
    if (!roster.ok) {
      return stop(slug, LEDGER.titan, "amber", { why: roster.why, next: "Press Retry. The box answered its health check, so this is usually a moment early rather than a fault." });
    }
    // listAgents answers a BARE ARRAY (measured on grok-bot-local-vm 2026-09-10). The wrapper form
    // is read too, because a wrapper is exactly the kind of thing a later host adds and a silently
    // empty roster here would send a welcome for a workspace with nobody in it.
    const body = roster.body;
    const agents = Array.isArray(body) ? body : (Array.isArray(body?.agents) ? body.agents : []);
    const titan = agents.find((agent) => String(agent?.name ?? "").trim().toLowerCase() === "titan") ?? null;
    if (agents.length === 0) {
      return stop(slug, LEDGER.titan, "amber", { why: "that box holds no bots yet", next: "Press Retry." });
    }

    const first = await boxCall(slug, "getOnboardingState", {});
    if (!first.ok) {
      return stop(slug, LEDGER.titan, "amber", { why: first.why, next: "Press Retry." });
    }
    const done = first.body?.done === true;

    step(slug, LEDGER.titan, done ? "amber" : "ok", {
      agents: agents.length,
      titanId: String(titan?.id ?? ""),
      titanName: String(titan?.name ?? ""),
      onboardingDone: done,
      model, label,
      ...(titan == null ? { why: "no bot on that box is called Titan, so the welcome cannot introduce him by name" } : {}),
      ...(done ? { why: "this box's first run is already spent, so the customer will not get the introduction", next: "Send the welcome anyway if this is a box that was already in use." } : {}),
    });
    record.titanId = String(titan?.id ?? "");
    return { ok: !done, status: done ? "amber" : "ok", step: LEDGER.titan };
  }

  // ---- step 4: Giving the agents their addresses -------------------------------------------------

  async function giveAddresses(record) {
    const { slug } = record;
    step(slug, LEDGER.addresses, "running", { why: "the relay is being asked to mint this workspace's bot addresses" });

    const started = now();
    const budget = Math.min(started + ms.addressBudget, record.startedAt + ms.deadline);
    let why = "the sweep has not run yet";
    let tries = 0;
    // A Retry after a control plane restart has no job memory, so Titan's id comes back out of the
    // ledger. Without this the mail would name whichever bot happens to be first in the directory.
    if (String(record.titanId ?? "").length === 0) {
      record.titanId = String(parse(lastOf(store.listSteps(slug), LEDGER.titan)?.detail)?.titanId ?? "");
    }
    for (;;) {
      tries += 1;
      // PER SLUG. mailMintSweep with no slug walks registry.all() and makes a listAgents and a
      // setAgentMail call into EVERY other customer's box, so onboarding one client reaches into
      // Richard's and Jason's and the cost grows with the fleet. An older relay ignores the field
      // and does the fleet, which is today's behaviour and is not wrong, only expensive.
      const answer = await askRelayPost("/mail/sweep", { slug });
      if (!answer.ok) why = String(answer.why ?? "the relay did not answer the sweep");

      // THE 200 IS NOT THE SIGNAL. A sweep can answer cheerfully green over a workspace it never
      // named. What counts is this control plane's own directory holding a live row for this slug.
      const rows = mailDirectory().directory(slug)?.tenants?.[slug]?.addresses ?? [];
      const active = rows.filter((row) => String(row?.state) === "active");
      if (active.length > 0) {
        const titanRow = active.find((row) => String(row.agentId) === String(record.titanId ?? "")) ?? active[0];
        step(slug, LEDGER.addresses, "ok", {
          addresses: active.length,
          titanAddress: String(titanRow?.address ?? ""),
          titanName: String(titanRow?.agentName ?? ""),
          sweeps: tries,
        });
        record.titanAddress = String(titanRow?.address ?? "");
        return { ok: true };
      }
      if (now() + ms.healthInterval >= budget) break;
      await sleep(ms.healthInterval);
    }
    return stop(slug, LEDGER.addresses, "amber", { why, sweeps: tries, next: ADDRESSES_NONE });
  }

  // ---- step 5: Sending the welcome ---------------------------------------------------------------

  async function sendWelcome(record, { force = false } = {}) {
    const { slug, plan } = record;
    if (!plan.sendWelcome && !force) {
      return { ok: true, status: "amber", step: LEDGER.welcome, skipped: true };
    }
    step(slug, LEDGER.welcome, "running", { why: "the welcome is being sent" });

    let sender = deps.welcome ?? null;
    if (sender == null) {
      // Imported HERE and not at the top of the file, so this module parses and every step above it
      // runs in a checkout where cp/welcome.mjs does not exist yet.
      try { sender = await import("./welcome.mjs"); }
      catch { sender = null; }
    }
    // TWO SHAPES ARE ACCEPTED HERE, and the reason is worth reading. cp/welcome.mjs ships a
    // FACTORY, createWelcome({store, config, fetchImpl, askRelayPost, now}), whose send() takes the
    // owner's address as `email` and hands the fresh link back as `signInUrl`. A test double, and
    // any later sender, may instead be a flat sendWelcome(asked). Both are wired below rather than
    // one of them being made to look like the other, because a translation layer that exists in
    // only one direction is how an integration passes its own tests and mails nobody.
    const send = typeof sender?.createWelcome === "function"
      ? async (asked) => {
        const built = sender.createWelcome({
          store: asked.store, config: asked.config, fetchImpl: asked.fetchImpl,
          askRelayPost: asked.askRelayPost, now: asked.now,
        });
        const answer = await built.send({
          slug: asked.slug,
          // The OWNER'S address, which is what the mail greets and what the override is measured
          // against. It is not the recipient: `to` is, and on the R750 run they are different.
          email: String(asked.account?.email ?? asked.tenant?.ownerEmail ?? ""),
          name: String(asked.name ?? ""),
          company: String(asked.tenant?.name ?? ""),
          host: String(asked.tenant?.host ?? ""),
          to: asked.to,
          temporaryPassword: asked.temporaryPassword,
          titanAddress: asked.titanAddress,
          actor: asked.actor,
          account: asked.account,
          tenant: asked.tenant,
        });
        // The link comes back under its own name and is handed on under this file's. It is read
        // once here and written to no row, no log and no ledger detail.
        return { ...answer, signIn: String(answer?.signInUrl ?? answer?.signIn ?? "") };
      }
      : (typeof sender?.sendWelcome === "function" ? sender.sendWelcome : (typeof sender?.default === "function" ? sender.default : null));
    if (send == null) {
      return stop(slug, LEDGER.welcome, "amber", { why: WELCOME_NO_SENDER, next: "Copy the welcome note from the card and send it the way you would send any password." });
    }

    const tenant = store.getTenant(slug);
    const accounts = store.listAccountsForTenant(slug);
    const owner = accounts.find((one) => String(one.email) === String(tenant?.ownerEmail ?? "")) ?? accounts[0] ?? null;
    if (owner == null) {
      return stop(slug, LEDGER.welcome, "failed", { why: "that workspace has nobody to write to", next: "Add a person to this workspace first." });
    }

    let answer;
    try {
      answer = await send({
        store, config, fetchImpl, now,
        slug,
        tenant,
        account: owner,
        // THE PERSON'S NAME, off the account row, and deliberately not plan.name: that one is the
        // COMPANY (the route passes `name: company` when it starts the job, and it is the workspace's
        // display name everywhere else in this file). Greeting a new customer "Hi Acme," on the first
        // line of the first thing the product ever sends them is the kind of wrong that gets noticed
        // and never reported. cp/welcome.mjs falls back to the local part of the address when an
        // account has no name at all.
        name: String(owner.name ?? ""),
        // The override, said in plain words on the card and in the row: ONE recipient, never a bcc.
        // A copy to a third party would put a live sign-in link and a password for a customer's
        // workspace in somebody else's inbox until it expires, and the link is a bearer the relay
        // never checks for revocation.
        to: plan.welcomeTo.length > 0 ? plan.welcomeTo : String(owner.email),
        overridden: plan.welcomeTo.length > 0,
        temporaryPassword: record.temporaryPassword ?? "",
        titanAddress: record.titanAddress ?? "",
        askRelayPost,
        // Handed in rather than left for the sender to work out, so there is one mint in the tree.
        // A sender that mints its own is free to ignore this.
        signInLink: () => mintSignInLink({ account: owner, tenant, config, now: now() }),
        actor: plan.actor,
      });
    } catch (error) {
      return stop(slug, LEDGER.welcome, "failed", { why: notMeasured(error), next: "Press Send again on this row." });
    }

    if (answer?.ok !== true) {
      return stop(slug, LEDGER.welcome, "failed", {
        why: String(answer?.why ?? "the welcome did not go and nothing said why"),
        to: String(answer?.to ?? (plan.welcomeTo.length > 0 ? plan.welcomeTo : owner.email)),
        next: "Press Send again on this row, or copy the note from the card.",
      });
    }
    // THE ROW HOLDS WHO, WHOM, WHEN, THE OUTCOME AND THE PROVIDER ID. Never the password, never the
    // link, never the body.
    step(slug, LEDGER.welcome, "ok", {
      to: String(answer.to ?? ""),
      resendId: String(answer.resendId ?? ""),
      shape: String(answer.shape ?? ""),
      overridden: plan.welcomeTo.length > 0,
      ownerEmail: String(owner.email),
    });
    // Handed back to the caller ONCE and stored nowhere: this is what lets the card offer
    // "Copy a sign-in link" for a customer whose mail bounced.
    record.signIn = String(answer.signIn ?? "");
    return { ok: true, signIn: record.signIn, shape: String(answer.shape ?? ""), to: String(answer.to ?? "") };
  }

  // ---- the runner --------------------------------------------------------------------------------

  // WHICH STOP STOPS WHAT, written down because guessing it wrong cost a customer their welcome.
  //
  // On the R750 at 19:31:27Z on 2026-09-10 Waking Titan went amber because the relay was a minute
  // behind with a model. This runner was a straight chain, so the addresses sweep and the welcome
  // never ran at all and the card left them reading "waiting" for ever. Six red lines on the gate,
  // one line of control flow.
  //
  //   box        STOPS EVERYTHING after it. There is no host to read a roster from, no Titan to
  //              introduce and no address to mint: every step after this one would fail for the same
  //              reason and write three more rows saying so.
  //   titan      STOPS NOTHING. The sweep needs the box up and a roster, which it reads through the
  //              relay. The welcome needs an owner row, a host and a sender. NEITHER NEEDS A MODEL,
  //              and the welcome must never wait on one: it carries the temporary password, and a
  //              customer whose mail was held back by a model setting has no way in at all.
  //   addresses  STOPS NOTHING. Without Titan's address the welcome says a little less and still
  //              carries the password and the sign-in link, which is the part that cannot wait.
  //
  // The card stays honest either way. foldSteps counts ANY amber as a stop and `done` needs all five
  // green, so a titan amber with a green welcome draws an amber card with Retry on it, which is
  // exactly what happened: something needs a look, and the customer was not left in the dark while
  // it waits.
  async function run(record) {
    const { slug } = record;
    const need = (key) => foldSteps(store.listSteps(slug), { at: now(), stallMs: ms.stall }).byKey[key]?.state !== "ok";
    try {
      if (need("box")) { const verdict = await buildBox(record); if (!verdict.ok) return verdict; }
      // The first stop that was not a stop for everything, carried to the caller so `settle` and the
      // CLI still learn what went amber, while the steps that do not depend on it run anyway.
      let carried = null;
      if (need("titan")) { const verdict = await wakeTitan(record); if (!verdict.ok) carried ??= verdict; }
      if (need("addresses")) { const verdict = await giveAddresses(record); if (!verdict.ok) carried ??= verdict; }
      if (need("welcome")) { const verdict = await sendWelcome(record); if (!verdict.ok) carried ??= verdict; }
      return carried ?? { ok: true };
    } catch (error) {
      // A throw in here is a bug in this file and not a broken tenant. It is written down where the
      // operator will see it, with the one thing to press.
      log(`onboard ${slug}: the sequence threw (${notMeasured(error)})`);
      return stop(slug, LEDGER.welcome, "failed", { why: notMeasured(error), next: "Press Retry." });
    }
  }

  function launch(record) {
    jobs.set(record.slug, record);
    record.running = run(record).catch((error) => {
      log(`onboard ${record.slug}: ${notMeasured(error)}`);
      return { ok: false };
    }).finally(() => { jobs.delete(record.slug); });
    return record;
  }

  return {
    ONBOARD_LABELS,
    state,
    storedPlan,
    mintSignInLink: (slug, { ttlMs } = {}) => {
      const tenant = store.getTenant(slug);
      if (tenant == null) return null;
      const accounts = store.listAccountsForTenant(slug);
      const owner = accounts.find((one) => String(one.email) === String(tenant.ownerEmail ?? "")) ?? accounts[0] ?? null;
      if (owner == null) return null;
      return { ...mintSignInLink({ account: owner, tenant, config, now: now(), ...(ttlMs ? { ttlMs } : {}) }), email: String(owner.email) };
    },

    /** Two presses cannot build two boxes: a slug already running answers with the job it has. */
    start(wanted = {}) {
      const slug = String(wanted.slug ?? "");
      const held = jobs.get(slug);
      if (held != null) return { jobId: held.jobId, started: false, ...state(slug) };
      const plan = {
        planModel: String(wanted.planModel ?? "").trim(),
        ceiling: Number.isFinite(Number(wanted.ceiling)) ? Number(wanted.ceiling) : null,
        sendWelcome: wanted.sendWelcome === true,
        welcomeTo: String(wanted.welcomeTo ?? "").trim().toLowerCase(),
        actor: String(wanted.actor ?? ""),
        name: String(wanted.name ?? store.getTenant(slug)?.name ?? ""),
      };
      const jobId = `onboard-${slug}-${randomUUID().slice(0, 8)}`;
      // The plan goes into the ledger, so a Retry after a control plane restart knows what was
      // asked for. There is no secret in it: the password is never here, and the address the
      // welcome goes to is the same address the row already carries.
      step(slug, LEDGER.workspace, "ok", { jobId, ...plan });
      const record = { jobId, slug, plan, startedAt: now(), temporaryPassword: String(wanted.temporaryPassword ?? "") };
      launch(record);
      return { jobId, started: true, ...state(slug) };
    },

    /** Resume at the first step that is not ok. */
    retry(slug) {
      const key = String(slug ?? "");
      const held = jobs.get(key);
      if (held != null) return { jobId: held.jobId, started: false, ...state(key) };
      if (store.getTenant(key) == null) return null;
      const plan = storedPlan(key);
      const jobId = plan.jobId || `onboard-${key}-${randomUUID().slice(0, 8)}`;
      const record = { jobId, slug: key, plan, startedAt: now(), temporaryPassword: "" };
      launch(record);
      return { jobId, started: true, ...state(key) };
    },

    /**
     * Send again, on its own, with no job around it. It mints a FRESH link and leaves the password
     * alone: the original is a scrypt hash nobody can ask back, and changing it would lock out a
     * customer who has already signed in.
     */
    async welcome(slug, { to = "", temporaryPassword = "", actor = "" } = {}) {
      const key = String(slug ?? "");
      if (store.getTenant(key) == null) return null;
      const plan = storedPlan(key);
      const rows = store.listSteps(key);
      const record = {
        jobId: plan.jobId,
        slug: key,
        plan: { ...plan, sendWelcome: true, welcomeTo: String(to ?? "").trim().toLowerCase() || plan.welcomeTo, actor: actor || plan.actor },
        startedAt: now(),
        temporaryPassword: String(temporaryPassword ?? ""),
        titanAddress: String(parse(lastOf(rows, LEDGER.addresses)?.detail)?.titanAddress ?? ""),
        titanId: String(parse(lastOf(rows, LEDGER.titan)?.detail)?.titanId ?? ""),
      };
      const verdict = await sendWelcome(record, { force: true });
      return { ...verdict, signIn: record.signIn ?? "", steps: state(key).steps };
    },

    /** For a shutdown, and for a test that wants the job settled before it asserts. */
    async settle(slug = null) {
      const waiting = slug == null ? [...jobs.values()] : [jobs.get(String(slug))].filter(Boolean);
      await Promise.all(waiting.map((record) => record.running));
    },
    running: (slug) => jobs.has(String(slug ?? "")),
  };
}
