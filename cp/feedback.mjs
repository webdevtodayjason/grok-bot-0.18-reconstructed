// cp/feedback.mjs -- the shape of a problem report, and what the control plane does with one.
// FEEDBACK-1.
//
// Jason, 2026-09-07: "Titan tried to cover up failure. We need to instill in the agents that
// failure must be reported." What this file holds is the half of that which lives on the control
// plane: the payload's validation, the issue body, the GitHub call, and the digest.
//
// TWO GATES, AND NEITHER IS A CHECK IN HERE. The workspace operator sees every report and can
// edit, add to or drop it before it leaves the box; the super admin sees what was sent and decides
// whether it becomes an issue. That is topology rather than policy: the agent's tool writes a
// PENDING report inside its own box and returns a sentence, the console (already signed in as the
// tenant) is the only thing that posts, and the relay stamps the workspace. Nothing in this file
// can be reached by a box, and nothing in it takes a workspace name from a body.
//
// SO EVERY VALUE HERE ARRIVES FROM A CUSTOMER'S BROWSER AND IS TREATED AS SUCH. normalizeReport
// keeps the fields it knows, checks every one of them against its limit, and drops the rest. An
// unknown key is not an error and is not stored: a report is evidence, not a document somebody gets
// to design. A field over its limit is REFUSED with a sentence naming it, never cut down to fit.
//
// The limits are also a contract with the console. cp/server.mjs reads a feedback body up to
// INTAKE_BYTES below and refuses anything larger before this file ever sees it, so a console that
// mints inside the limits below always lands and one that does not is refused by the intake rather
// than truncated into a report that reads as complete and is not. docs/FEEDBACK.md carries the
// numbers.

/**
 * How large a feedback body may be on the wire. Larger than every other route on this service, and
 * deliberately: a report carries the same evidence twice -- once as the block of text the person
 * read and edited, and once in structured form -- so the ordinary maximum is around 68 KB where
 * every other body here is a form. The relay's own reader in ui/server.mjs carries the same number.
 */
export const INTAKE_BYTES = 96 * 1024;

/**
 * The three tiers, from Titan's own design (2026-09-09). They change how loudly a report is shown,
 * how it filters and how the digest batches it, and NOTHING ELSE: all three pass through both
 * gates. A tier is never a way around the operator.
 */
export const FEEDBACK_TIERS = ["critical", "quality", "observation"];

/** What each tier means, in the words the panel and the docs both print. */
export const TIER_ROUTING = {
  critical: "blocks work. It is counted on the panel the moment it arrives and the operator is told at once.",
  quality: "a rough edge that did not stop the work. It is batched into a digest.",
  observation: "something worth knowing later. It sits in the backlog until somebody reads it.",
};

/**
 * Every clamp, in one place, because these numbers are a contract with three separate minters (the
 * agent's tool, the console's automatic offer, and the self-test) and with the 64 KB intake.
 *
 * EVERY NUMBER HERE IS THE CONSOLE'S OWN MAXIMUM OR LARGER, and that is the whole point of the
 * list. They used to be smaller than what the console mints: an ordinary shell-failure report was
 * 15,296 characters of description, the intake kept 8,000 of them, dropped two of the twelve calls
 * and cut each call's output from 1,200 characters to 800 -- and answered 201, so nothing on any
 * screen said a word about it. The card promises that what you read is what is sent, and a report
 * quietly cut in half sends whoever reads it looking for a step that was never written down.
 *
 * ui/machine-room/app.js mints at most: a body of the description plus twelve calls (400-character
 * summary, 1,200-character output) and six messages of 800; the description below leaves room for
 * all of that plus the agent's own words, which on its own comes to 24,211 characters measured on
 * this Mac. A report at every limit at once is measured by the test in tests/cp-feedback.test.mjs
 * and has to fit INTAKE_BYTES with room for the envelope. Raising any of these means running that
 * test again.
 */
export const LIMITS = {
  title: 200,
  category: 60,
  description: 32000,
  steps: 12,
  step: 400,
  tools: 10,
  toolName: 120,
  toolError: 300,
  calls: 12,
  callSummary: 400,
  callOutput: 1200,
  messages: 6,
  messageText: 800,
  field: 200,
};

const oneLine = (value, limit) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
const flatten = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
const block = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * A report from a console, kept, checked, and stripped of everything this file does not know.
 *
 * Answers {ok, report} or {ok: false, why} with a sentence a person reads. Two hard refusals, and
 * neither of them cuts anything down to size:
 *
 *  - A TIER THAT IS NOT ONE OF THE THREE. A report filed under a tier nobody filters on is a report
 *    nobody sees, and guessing one for the caller would hide that.
 *  - ANYTHING OVER ITS LIMIT. The evidence -- the description, the steps, each tool's answer, the
 *    calls and the last things said -- is refused with the number, never truncated, because a
 *    report cut in half reads as a whole one. The card shows the sentence and the person can trim
 *    it; editing the text drops the structured copies and on its own usually does it.
 *
 * The cosmetic one-liners are the exception and are still clamped: a title, a category, a tool's
 * name, an agent id. Those name a report rather than carry its evidence, and the person cannot edit
 * a title on the card -- refusing one would leave them with a report they had no way to send.
 */
export function normalizeReport(raw, { at = Date.now() } = {}) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, why: "a report has to be an object with a tier, a title and a description." };
  }
  const tier = String(raw.tier ?? "").trim().toLowerCase();
  if (!FEEDBACK_TIERS.includes(tier)) {
    return { ok: false, why: `the tier has to be one of ${FEEDBACK_TIERS.join(", ")}, and this one said ${tier.length > 0 ? `"${oneLine(tier, 40)}"` : "nothing"}.` };
  }
  const title = oneLine(raw.title, LIMITS.title);
  if (title.length === 0) return { ok: false, why: "a report needs a title, which is the one line the panel lists it by." };

  // What is over, named one by one, so the sentence says which part to trim rather than "too big".
  const over = [];
  const fits = (value, limit, what) => {
    if (String(value ?? "").length > limit) over.push(`${what} is ${String(value).length} characters and at most ${limit} are carried`);
    return value;
  };
  const holds = (list, limit, what) => {
    if (list.length > limit) over.push(`there are ${list.length} ${what} and at most ${limit} are carried`);
    return list;
  };

  const description = fits(block(raw.description), LIMITS.description, "the description");
  if (description.length === 0) return { ok: false, why: "a report needs a description saying what happened." };

  const steps = holds(listOf(raw.steps).map((one) => flatten(one)).filter((one) => one.length > 0), LIMITS.steps, "steps");
  steps.forEach((step, index) => fits(step, LIMITS.step, `step ${index + 1}`));

  const tools = holds(listOf(raw.tools).map((one) => ({
    name: oneLine(one?.name, LIMITS.toolName),
    status: oneLine(one?.status, 40),
    error: flatten(one?.error),
  })).filter((one) => one.name.length > 0), LIMITS.tools, "tools");
  tools.forEach((tool) => fits(tool.error, LIMITS.toolError, `what ${tool.name} answered`));

  const evidenceIn = raw.evidence !== null && typeof raw.evidence === "object" && !Array.isArray(raw.evidence) ? raw.evidence : {};
  const calls = holds(listOf(evidenceIn.calls).map((one) => ({
    name: oneLine(one?.name, LIMITS.toolName),
    status: oneLine(one?.status, 40),
    summary: block(one?.summary),
    output: block(one?.output),
  })).filter((one) => one.name.length > 0), LIMITS.calls, "recorded calls");
  calls.forEach((call) => {
    fits(call.summary, LIMITS.callSummary, `the line recorded for ${call.name}`);
    fits(call.output, LIMITS.callOutput, `what ${call.name} printed`);
  });

  const messages = holds(listOf(evidenceIn.messages).map((one) => ({
    role: oneLine(one?.role, 40),
    text: block(one?.text),
  })).filter((one) => one.text.length > 0), LIMITS.messages, "recorded messages");
  messages.forEach((message, index) => fits(message.text, LIMITS.messageText, `message ${index + 1}`));

  if (over.length > 0) {
    return {
      ok: false,
      why: `this report is larger than a report is carried at: ${over.slice(0, 3).join("; ")}${over.length > 3 ? `, and ${over.length - 3} more` : ""}.`
        + " Nothing was stored, because a report cut down to fit reads as a whole one. Shorten it and send it again.",
    };
  }

  const report = {
    version: 1,
    tier,
    category: oneLine(raw.category, LIMITS.category),
    title,
    description,
    steps,
    tools,
    evidence: {
      // NOT taken from the body. The relay stamps the workspace from its own registry and the
      // intake writes it over whatever arrived, so a box cannot file as its neighbour. It is left
      // empty here on purpose rather than read, so there is nothing to forget to overwrite.
      workspace: "",
      agent: oneLine(evidenceIn.agent, LIMITS.field),
      agentName: oneLine(evidenceIn.agentName, LIMITS.field),
      conversation: oneLine(evidenceIn.conversation, LIMITS.field),
      hostVersion: oneLine(evidenceIn.hostVersion, LIMITS.field),
      consoleVersion: oneLine(evidenceIn.consoleVersion, LIMITS.field),
      calls,
      messages,
    },
    at: Number.isFinite(Number(raw.at)) && Number(raw.at) > 0 ? Number(raw.at) : at,
  };
  return { ok: true, report };
}

const fence = (text) => "```\n" + String(text ?? "").replace(/```/g, "` ` `") + "\n```";

/**
 * The report as a GitHub issue body.
 *
 * Markdown rather than JSON, because the person who reads it is a developer at 7am with a customer
 * waiting, and a wall of escaped JSON is a thing nobody reads. The evidence is fenced so a stack
 * trace does not become a heading. What is NOT in here is anything this control plane holds: no
 * token, no tenant credential, no key. The payload it renders came from a console and carries only
 * what the conversation carried.
 */
export function buildIssueBody(report, { workspace = "", id = 0 } = {}) {
  const r = report ?? {};
  const evidence = r.evidence ?? {};
  const lines = [];
  lines.push(`**${TIER_ROUTING[r.tier] ? String(r.tier) : "unknown tier"}** report from the ${workspace || evidence.workspace || "unnamed"} workspace.`);
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| Workspace | ${workspace || evidence.workspace || "not reported"} |`);
  lines.push(`| Agent | ${evidence.agentName || evidence.agent || "not reported"} |`);
  lines.push(`| Tier | ${r.tier ?? "not reported"} |`);
  lines.push(`| Category | ${r.category || "not reported"} |`);
  lines.push(`| Host | ${evidence.hostVersion || "not reported"} |`);
  lines.push(`| Console | ${evidence.consoleVersion || "not reported"} |`);
  lines.push(`| Reported | ${new Date(Number(r.at) || Date.now()).toISOString()} |`);
  if (Number(id) > 0) lines.push(`| Feedback id | ${Number(id)} |`);
  lines.push("");
  lines.push("## What happened");
  lines.push("");
  lines.push(String(r.description ?? ""));
  if ((r.steps ?? []).length > 0) {
    lines.push("");
    lines.push("## Steps");
    lines.push("");
    (r.steps ?? []).forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  if ((r.tools ?? []).length > 0) {
    lines.push("");
    lines.push("## Tools involved");
    lines.push("");
    lines.push("| Tool | Status | What it said |");
    lines.push("|---|---|---|");
    for (const tool of r.tools ?? []) {
      lines.push(`| ${tool.name} | ${tool.status || "not reported"} | ${String(tool.error ?? "").replace(/\|/g, "\\|") || "nothing"} |`);
    }
  }
  if ((evidence.calls ?? []).length > 0) {
    lines.push("");
    lines.push("## The calls that failed");
    for (const call of evidence.calls ?? []) {
      lines.push("");
      lines.push(`**${call.name}** answered ${call.status || "nothing"}`);
      if (String(call.summary ?? "").length > 0) lines.push(String(call.summary));
      if (String(call.output ?? "").length > 0) lines.push(fence(call.output));
    }
  }
  if ((evidence.messages ?? []).length > 0) {
    lines.push("");
    lines.push("## The last thing said");
    for (const message of evidence.messages ?? []) {
      lines.push("");
      lines.push(`**${message.role || "unknown"}**`);
      lines.push(fence(message.text));
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("Filed from the Titanium Bot admin console. The workspace operator saw this report and"
    + " sent it; the super admin read it and filed it. Nothing here was taken from a file, an"
    + " environment or a stored secret: it is the conversation and the version numbers.");
  return lines.join("\n");
}

/** owner/name, or null. Anything else is a typo, and a typo must not become a request. */
export function parseRepo(value) {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(value ?? "").trim());
  return match == null ? null : { owner: match[1], name: match[2], full: `${match[1]}/${match[2]}` };
}

const GITHUB_TIMEOUT_MS = 15_000;

/**
 * Where GitHub is. Overridable so a gate can stand a fake one up in its own process rather than
 * firing a real issue at a real repository every time somebody runs it, and so an operator on
 * GitHub Enterprise can point this at their own host. cp/admin.mjs reads CP_GITHUB_API_URL for it.
 */
export const GITHUB_API = "https://api.github.com";

/**
 * Whether GitHub will take this token for this repository, asked before the token is stored.
 *
 * Copied from the provider-key door and for the same reason: a mistyped or expired value used to
 * be live on the next request with the operator told nothing. It also checks has_issues, because a
 * token that reads a repository with issues turned off files nothing and the failure would land on
 * whoever pressed Create GitHub issue weeks later.
 *
 * NEVER THROWS, and never puts the token in a return value or in a message.
 */
export async function proveRepoToken({ token, repo, fetchImpl = globalThis.fetch, apiBase = GITHUB_API } = {}) {
  const parsed = parseRepo(repo);
  if (parsed == null) return { ok: false, why: "name the repository as owner/name." };
  if (String(token ?? "").length < 8) return { ok: false, why: "paste the token." };
  let response;
  try {
    response = await fetchImpl(`${apiBase}/repos/${parsed.owner}/${parsed.name}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "titanium-bot-admin",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, why: error?.name === "TimeoutError" ? "GitHub did not answer in time." : "GitHub did not answer." };
  }
  if (response.status === 401) return { ok: false, why: "GitHub refused the token itself." };
  if (response.status === 403) return { ok: false, why: "GitHub accepted the token and refused it access to that repository." };
  if (response.status === 404) return { ok: false, why: "GitHub has no such repository, or this token cannot see it." };
  if (!response.ok) return { ok: false, why: `GitHub answered ${response.status}.` };
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (body?.has_issues === false) {
    return { ok: false, why: `${parsed.full} has its issues turned off, so nothing could ever be filed there.` };
  }
  return { ok: true, repo: parsed.full, how: `GET ${apiBase}/repos/${parsed.full}` };
}

/**
 * One report, filed. Answers {ok, url, why} and never throws.
 *
 * The token is a parameter and it leaves this function in exactly one place: the authorization
 * header of one request. It is in no return value, no message and no log line.
 */
export async function fileIssue({ token, repo, title, body, labels = [], fetchImpl = globalThis.fetch, apiBase = GITHUB_API } = {}) {
  const parsed = parseRepo(repo);
  if (parsed == null) return { ok: false, why: "there is no repository configured to file against." };
  if (String(token ?? "").length < 8) return { ok: false, why: "there is no repository token stored." };
  let response;
  try {
    response = await fetchImpl(`${apiBase}/repos/${parsed.owner}/${parsed.name}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "titanium-bot-admin",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ title: String(title ?? "").slice(0, 250), body: String(body ?? ""), ...(labels.length > 0 ? { labels } : {}) }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, why: error?.name === "TimeoutError" ? "GitHub did not answer in time, so nothing was filed." : "GitHub did not answer, so nothing was filed." };
  }
  let answer = null;
  try { answer = await response.json(); } catch { answer = null; }
  if (!response.ok) {
    const said = String(answer?.message ?? "").split("\n")[0].slice(0, 160);
    return { ok: false, why: `GitHub answered ${response.status}${said ? `: ${said}` : ""}, so nothing was filed.` };
  }
  const url = String(answer?.html_url ?? "");
  if (url.length === 0) return { ok: false, why: "GitHub accepted the issue and did not say where it is, so nothing was recorded." };
  return { ok: true, url, number: Number(answer?.number ?? 0) };
}

/**
 * The batched digest, as plain text for the CLI.
 *
 * A timer sends this later; today it is a command an operator runs, which is deliberate: a digest
 * nobody has read once is not a thing to put on a schedule.
 */
export function buildDigest(rows, { tier = "quality", since = 0, now = Date.now() } = {}) {
  const wanted = (Array.isArray(rows) ? rows : []).filter((row) => (tier.length === 0 || String(row.tier) === tier)
    && Number(row.at) >= Number(since || 0));
  const lines = [];
  const window = Number(since) > 0 ? `since ${new Date(Number(since)).toISOString()}` : "over everything on record";
  lines.push(`Titanium Bot feedback digest, ${tier.length > 0 ? `${tier} tier` : "every tier"}, ${window}.`);
  lines.push(`Made ${new Date(now).toISOString()}.`);
  lines.push("");
  if (wanted.length === 0) {
    lines.push("Nothing in this window. That is a real answer and not an empty page: no workspace reported anything of this kind.");
    return lines.join("\n");
  }
  const byWorkspace = new Map();
  for (const row of wanted) {
    const key = String(row.tenant ?? "") || "unnamed";
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push(row);
  }
  lines.push(`${wanted.length} report${wanted.length === 1 ? "" : "s"} from ${byWorkspace.size} workspace${byWorkspace.size === 1 ? "" : "s"}.`);
  for (const [workspace, list] of [...byWorkspace.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push("");
    lines.push(`${workspace} -- ${list.length}`);
    for (const row of list) {
      lines.push(`  #${row.id}  ${new Date(Number(row.at)).toISOString()}  ${String(row.state ?? "new").padEnd(10)}${row.title}`);
      if (String(row.issueUrl ?? "").length > 0) lines.push(`         ${row.issueUrl}`);
    }
  }
  return lines.join("\n");
}
