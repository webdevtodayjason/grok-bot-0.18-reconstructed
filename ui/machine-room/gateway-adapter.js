/*
 * Gateway-backed adapter for the Machine Room frontend.
 * ----------------------------------------------------
 * The handoff README asks that the DOM and event layer stay unchanged and that only the adapter
 * be replaced. So this file loads after adapter.js and takes over the factory app.js already
 * calls. adapter.js is still byte-identical to the handoff; app.js is not -- docs/DASHBOARD-
 * CONTRACT.md permits edits to it, and the wave that made these modals tell the truth needed
 * some (the room ••• menu, the plugin card, the agent panel, the evidence pill). The demo
 * factory is kept as createDemoAdapterOffline so the console still runs with no gateway.
 *
 * Two rules this file holds to, because the alternative is a UI that lies:
 *   - A method with no backend behind it yet says so, on screen. It never reports success, and
 *     a control that cannot work is not drawn at all (see connectable below).
 *   - submitSecret now really does store: it POSTs to the relay's /subscriptions/adopt and
 *     resolves with what the re-scan says happened, and the form says where the value went.
 *     Telling someone a credential was stored when it was not is worse than any missing feature,
 *     and so is telling them it was discarded when it was kept.
 */
(function attachGatewayAdapter(global) {
  "use strict";

  const demoFactory = global.createDemoAdapter;
  global.createDemoAdapterOffline = demoFactory;

  // The relay now has a login, so a 401 means the session expired or was never established.
  // Every relay call in this file goes through here, because the alternative is what the page
  // used to do with any error: toast it, keep the 15s heartbeat running, and toast it again
  // forever. One bounce to /login, once, and the flag makes sure concurrent calls do not each
  // start their own navigation.
  let bouncing = false;
  function bounceToLogin() {
    if (bouncing) return;
    bouncing = true;
    const here = `${global.location.pathname}${global.location.search}`;
    global.location.assign(`/login?next=${encodeURIComponent(here)}`);
  }
  // Only the relay's OWN refusal is a signed-out session, and it says so with this header. A 401
  // that came from the gateway instead means the relay's bearer is stale, which no password fixes:
  // bouncing on that would send an operator who signed in correctly back to the login every time,
  // with nothing on screen to say the fault is upstream. Those fall through and are reported.
  async function relayFetch(input, init) {
    const response = await fetch(input, init);
    const ours = response.headers?.get?.("x-relay-auth") === "required";
    if (response.status === 401 && ours) { bounceToLogin(); throw new Error("signed out"); }
    return response;
  }

  // ---- COST-1: the data diet ---------------------------------------------------------------------
  //
  // MEASURED on grok-bot-local-vm at 390x844 on 2026-09-09, real Chrome, CDP capture, against a
  // relay spawned from this worktree: boot is 268 requests and 4,029.7 KiB, of which /api is 47
  // calls and 548.7 KiB with the 93-message conversation the console lands on, and 1,683.7 KiB more
  // the moment the 1,578-item agent is selected. Sixty seconds untouched costs 4 ticks, 40 /api
  // calls and 646.7 KiB, of which getAgentWorkflows alone is 452.2 KiB -- the same 86-skill
  // catalogue, whole, four times, for a panel that is not open.
  //
  // THE CEILINGS, written down so a regression fails rather than accumulates: 250 KiB of decoded
  // /api on first paint, 100 KiB per idle minute, 600 KiB per WORKING minute. scripts/verify-cost.mjs
  // measures all three. The third exists because the worst traffic in the product is invisible to an
  // idle gate: with the open agent working, OUTLINE_WORKING_MAX_AGE_MS re-reads the whole outline
  // every five seconds.
  //
  // THREE MECHANISMS, IN THE ORDER THEY PAY OFF.
  //
  //   1. THE UNCHANGED-ANSWER PROTOCOL, which is what actually holds the idle ceiling at any
  //      cadence. The relay hands back `x-titan-digest` on every /api answer it shaped; this side
  //      keeps the last answer per method-and-arguments key and sends that digest as
  //      `x-titan-if-digest` on the next read. Identical bytes and the relay answers
  //      {"__unchanged":true} -- 20 bytes -- and the held copy is reparsed and returned. The relay
  //      ALWAYS asks the box, so this can never answer something the box no longer says, and there
  //      is no invalidation to get wrong. A relay without ui/api-diet.mjs sends no digest header, so
  //      nothing is ever remembered and nothing changes: the absent-module case is the no-op case.
  //
  //   2. A PROJECTION REQUEST on the two answers the console mostly throws away.
  //      getConversationOutline is 1,239,452 bytes of which the renderer uses 40,707, and
  //      getAgentWorkflows is 114,012 bytes of which 70,826 is skill markdown nothing on the
  //      conversation screen draws. `x-titan-projection: lean` asks for the smaller shape; the
  //      skills panel's own read asks for `full`, because that is the one place a body is shown.
  //
  //   3. SINGLE FLIGHT, and single flight ONLY: two callers asking the same question while the
  //      answer is still on its way share the one round trip. This was a 1.5-second freshness window
  //      in the first draft and the unit suite caught it immediately -- "the hand-back control
  //      follows the host's status" and "a transcript read that fails does not swallow the roster's
  //      own answer" both drive two refreshes back to back against a host whose answer changed in
  //      between, which is exactly what a 900 ms debounce does on a live box after a stream frame
  //      says something moved. A memo that outlives the call is a memo that can be wrong; an
  //      unsettled promise is the freshest answer there is. So the bytes are saved by the digest,
  //      which asks the box every time, and the round trips by single flight, which never guesses.
  const IDEMPOTENT_READS = new Set([
    "listAgents", "countAgents", "getTrays", "getHostStatus", "getAgentAvatar", "getAgentTranscriptTail",
    "getAgentAutomations", "getAgentWorkflows", "getAgentChannels", "getForeverBoxStatus",
    "getConversationOutline", "listProblemReports", "listConnectorSecretFields", "listMcpServerTools",
  ]);
  // The two answers ui/api-diet.mjs knows how to shrink. Asked lean by default and full only where a
  // body is actually drawn, so there is one place to look for "why is this field empty".
  const PROJECTED_READS = new Set(["getConversationOutline", "getAgentWorkflows"]);
  const UNCHANGED_ANSWER = '{"__unchanged":true}';
  // 64 entries and 8 MiB, whichever comes first, oldest out. The bytes bound matters because an
  // unprojected outline is 1.2 MB: sixty-four of those is not a memo, it is a leak.
  const MEMO_MAX_ENTRIES = 64;
  const MEMO_MAX_BYTES = 8 * 1024 * 1024;
  // One key for both maps. The separator is spelled as an escape, never typed as a literal
  // control byte: a raw NUL in a source file makes git call the whole file binary and every diff
  // on it unreadable, which is a worse bug than the one it would be solving.
  const memoKey = (method, args, projection) => `${method}\u0000${JSON.stringify(args ?? {})}\u0000${projection ?? ""}`;
  const answers = new Map();
  let answerBytes = 0;
  const inFlight = new Map();

  function rememberAnswer(key, text, digest) {
    const held = answers.get(key);
    if (held != null) { answerBytes -= held.text.length; answers.delete(key); }
    answers.set(key, { text, digest });
    answerBytes += text.length;
    while (answers.size > MEMO_MAX_ENTRIES || (answerBytes > MEMO_MAX_BYTES && answers.size > 1)) {
      const oldest = answers.keys().next().value;
      answerBytes -= answers.get(oldest).text.length;
      answers.delete(oldest);
    }
  }

  // The raw text of one answer. Held copies are kept as TEXT and reparsed per caller rather than
  // handed out as one shared object: a caller that mutates what it was given must not be able to
  // edit what the next tick compares against.
  async function callText(method, args, projection, allowReplay = true) {
    const key = memoKey(method, args, projection);
    const held = allowReplay ? answers.get(key) : null;
    const headers = { "content-type": "application/json" };
    if (projection != null) headers["x-titan-projection"] = projection;
    if (held?.digest != null) headers["x-titan-if-digest"] = held.digest;
    const r = await relayFetch(`/api/${method}`, { method: "POST", headers, body: JSON.stringify(args) });
    const text = await r.text();
    if (!r.ok) {
      let body; try { body = JSON.parse(text); } catch { body = text; }
      throw new Error(body?.error ?? `${method} failed (${r.status})`);
    }
    if (text === UNCHANGED_ANSWER) {
      if (held != null) return held.text;
      // Nothing held and the relay still said unchanged. That cannot happen -- the header it answers
      // to was never sent -- so it is a bug somewhere, not a state to guess at: ask again plainly
      // rather than hand the page a sentinel it would render.
      return await callText(method, args, projection, false);
    }
    const digest = r.headers?.get?.("x-titan-digest") ?? null;
    if (digest != null && IDEMPOTENT_READS.has(method)) rememberAnswer(key, text, digest);
    return text;
  }

  async function call(method, args = {}, options = {}) {
    const projection = options.projection === undefined
      ? (PROJECTED_READS.has(method) ? "lean" : null)
      : options.projection;
    const parse = (text) => { try { return JSON.parse(text); } catch { return text; } };
    if (!IDEMPOTENT_READS.has(method)) return parse(await callText(method, args, projection));
    const key = memoKey(method, args, projection);
    const joined = inFlight.get(key);
    // Joined, not remembered. The entry goes the moment the promise settles, so the next caller always
    // talks to the host and nothing here can hand back an answer the host has already replaced.
    if (joined != null) return parse(await joined);
    const text = callText(method, args, projection);
    inFlight.set(key, text);
    try { return parse(await text); }
    finally { inFlight.delete(key); }
  }

  // Wave D1 lands its host half separately, so every command below may or may not exist on the
  // box this page is talking to. The gateway answers an absent command with
  // {"error":"unknown gateway method: <name>"} and nothing else does, so that one string is the
  // difference between "this host cannot do it yet" (null, and the caller degrades to the
  // read-only Wave B state) and "the host refused" (throw, and the caller says so out loud).
  // Missing commands are remembered so a card does not re-ask on every tick.
  const UNKNOWN_COMMAND = /unknown gateway method/i;
  const unknownCommands = new Set();
  const commandMissing = (method) => unknownCommands.has(method);
  async function tryCall(method, args = {}) {
    if (unknownCommands.has(method)) return null;
    try {
      return await call(method, args);
    } catch (error) {
      if (UNKNOWN_COMMAND.test(String(error?.message ?? ""))) { unknownCommands.add(method); return null; }
      throw error;
    }
  }

  // JOBBUS-3: one POST to a relay job-bus route, answered as {accepted, message, token?}. The
  // token comes back exactly once, from the generate route, and is handed straight to the caller
  // so it is never held here and never reaches state, an event or a log.
  async function jobBusWrite(route, body) {
    const r = await relayFetch(route, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const answer = await r.json().catch(() => ({}));
    if (!r.ok) return { accepted: false, message: answer?.error ?? `the relay answered ${r.status}` };
    return { accepted: true, message: answer?.message ?? null, token: answer?.token ?? null };
  }

  // docs/JOB-BUS.md §10.7: the bus is off until the operator turns it on, and setting or
  // generating a bearer IS turning it on -- nobody pastes a token at a bus they want shut. A host
  // too old to carry jobBusSetSettings leaves the answer alone rather than failing a token write
  // that did land.
  //
  // §10.9: this is no longer the only place it happens. The relay arms the bus on the same two
  // routes and on its own start when TITAN_JOB_TOKEN is in the environment, because arming that
  // lived only here meant the env deploy path in §8 armed nothing at all. Doing it twice is one
  // idempotent write.
  async function armJobBusOnToken(answer) {
    if (answer?.accepted === true) {
      try { await tryCall("jobBusSetSettings", { enabled: true }); } catch { /* the token still landed */ }
    }
    return answer;
  }

  const AVATARS = [
    "assets/avatar-chief.svg", "assets/avatar-atera.svg", "assets/avatar-marketing.svg",
    "assets/avatar-clientsync.svg", "assets/avatar-coro.svg",
  ];
  const ACCENTS = ["#8b69ea", "#31b6b8", "#e25e96", "#e7a23c", "#6ea8fe"];
  // Stable per agent id, so a worker keeps its face and colour across reloads.
  const pick = (list, id) => list[[...String(id)].reduce((n, c) => n + c.charCodeAt(0), 0) % list.length];

  const timeOf = (ms) => Number.isFinite(ms)
    ? new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(ms))
    : "";

  // The transcript carries two kinds. "send-message" is the agent speaking, and is the agent's
  // only voice; "message" with role "user" is the operator. Everything else is machinery.
  // An approval, a local-tool permission ask and a widget question all arrive as send-message
  // entries whose message carries no .content. They read as text:"" and were dropped by the filter
  // below -- so an agent could sit blocked forever with nothing on screen to answer. This box runs
  // with autoReviewInstructions armed and localToolPermission "ask", so this is not a rare path:
  // "send that email" produces one every time.
  function cardOf(entry) {
    const m = entry.message ?? {};
    if (m.type === "auto-review-approval" && m.approval) return {
      kind: "auto-review",
      requestId: m.approval.requestId,
      status: m.approval.status ?? "pending",
      title: m.approval.summary || "This action needs your review",
      detail: [m.approval.reason, m.approval.command].filter(Boolean).join(" — "),
      // COMMAND-CARD-1: the reason and the command carried separately as well as joined. `detail`
      // stays for anything still reading it; the card draws the reason as its own grey line and the
      // command inside a disclosure, and one joined string can be neither. `surface` is the host's
      // own token (host_shell, box_shell, mcp, computer, browser, automation_write, cloud_agent,
      // subagent) and decides both the card's title and whose computer the grey line names.
      command: m.approval.command ?? null,
      reason: m.approval.reason ?? null,
      surface: m.approval.surface ?? null,
      rule: m.approval.proposedRule ?? null,
      options: [],
    };
    if (m.type === "local-tool-permission" && m.ask) return {
      kind: "local-tool",
      requestId: m.ask.requestId,
      status: m.ask.status ?? "pending",
      title: `${m.ask.action ?? "Run"} · ${m.ask.target ?? "a local tool"}`,
      detail: m.ask.description || "This runs on the box itself, not in a sandbox.",
      rule: null,
      options: [],
    };
    // The host stamps the entry, not the message: respondedValue once respondToWidget took an
    // answer, widgetDismissed once dismissWidget closed it (widget-responses.ts). Reading neither
    // left every answered question drawn with live buttons for the life of the transcript.
    if (m.type === "widget" && m.widget) return {
      kind: "widget", requestId: null,
      status: entry.widgetDismissed === true ? "dismissed" : entry.respondedValue != null ? "answered" : "pending",
      answer: entry.respondedValue ?? null,
      title: m.widget.prompt || "The agent asked you a question",
      detail: "", rule: null,
      options: Array.isArray(m.widget.options) ? m.widget.options : [],
    };
    // The host's reserved connector name (shell-secret-field.ts SHELL_SECRET_CONNECTOR), matched
    // the way the host matches it, so the card's copy splits on the same rule routeSecret does.
    const isShellSecretPlatform = (name) => typeof name === "string" && name.trim().toLowerCase() === "shell";
    // CP-10 item 2: the masked secret request. The host asks by entry id and resumes the agent
    // once submitSecret { entryId, value, agentId } has stored the value (widget-responses.ts
    // submitSecret -> routeSecret -> storeConnectorCredential, then resumeWithHiddenPrompt), so
    // the entry id has to travel with the card. `secretProvided` is the host's own stamp on the
    // entry, which is why an answered request stops offering the input.
    if (m.type === "secret-request") {
      const request = m.secretRequest ?? m.secret ?? {};
      const target = request.target ?? {};
      const field = target.field ?? request.field ?? "credential";
      const platform = target.platform ?? request.connector ?? null;
      return {
        kind: "secret", requestId: null, entryId: entry.id,
        status: entry.secretProvided === true ? "provided" : "pending",
        field, platform,
        title: request.label ? `The agent asked for ${request.label}` : "The agent asked for a credential",
        // Where the value goes, in the host's own terms, and that is not one sentence for every
        // destination. A connector or chat credential lands in somebody else's process and the model
        // only ever learns that it landed. SECRET-1's reserved "shell" connector is the opposite by
        // construction: the value becomes an environment variable of the shell this agent runs its
        // commands in, so the agent CAN read it back. This fallback is the copy the operator sees
        // whenever the model supplied no description of its own, so on the shell route it has to say
        // that rather than promise a custody the host is not keeping.
        detail: request.description
          || (isShellSecretPlatform(platform)
            ? `The value goes straight to the host's credential store and becomes $${field} in this agent's own box shell. It is never written into this conversation, and every command the agent runs from then on can read it.`
            : `The value goes straight to the host's credential store${platform ? ` for ${platform}` : ""} as ${field}. It is never written into this conversation and never reaches the model.`),
        rule: null, options: [],
      };
    }
    return null;
  }

  // HANDBACK-1. request_box_help parks the agent and the host writes the instruction as an ordinary
  // send-message, stamping the SAME entry with boxRequestId + boxInstruction and, when the hand-off
  // ends, boxResolution. So the durable half of a hand-off is one transcript entry, and this is the
  // only place that reads it. `handoff` in this file already means the operator-supplied Machine
  // Room frontend handoff (see the header), so every symbol this wave adds is prefixed boxHandoff.
  //
  // Resolution vocabulary: the host writes handed_back and dismissed from now on. Rows already on
  // disk carry completed and cancelled from the path that wrote a skip and a done identically, so
  // both are aliased read-side rather than rewritten -- a migration is risk for no gain.
  function boxHandoffOf(entry) {
    const requestId = entry?.boxRequestId;
    if (typeof requestId !== "string" || requestId === "") return null;
    return {
      requestId,
      instruction: typeof entry.boxInstruction === "string" ? entry.boxInstruction : "",
      resolution: typeof entry.boxResolution === "string" && entry.boxResolution !== "" ? entry.boxResolution : null,
    };
  }

  // The transcript never records tool calls; the conversation outline (the model's own turn state,
  // no timestamps, rewritten by compaction) does. Weave the outline's tool rows into the durable
  // transcript so a claim sits next to its receipt, the way the upstream desktop shows it. A row is
  // placed before the next transcript entry the outline also contains; rows after the last shared
  // entry go at the end, which is what "worked and never reported" looks like.
  // FEEDBACK-1. The reporting tool rides the protocol's `reportBugToolCall` case, so that is the
  // name its outline row carries. It gets an entry here for one reason: a row whose name is not in
  // this table is headlined with the raw name itself, and the rule for this tool is that the person
  // never sees a tool name at all. The row's own sentence is below, in toolRowText.
  const PROBLEM_REPORT_TOOL_CALL = "reportBugToolCall";
  const PROBLEM_REPORT_ROW_TEXT = "Reported a problem to the developers";
  // MAIL-3. The bot's own send rides `sendToUserToolCall`, whose args are a single string. It gets
  // a TOOL_LABELS entry for the same reason the row above does: a name that is not in this table is
  // headlined with the raw proto name, and a person must never read a tool name on their own
  // screen. That one string is the RECIPIENT, and on a refusal the recipient behind
  // MAIL_SEND_FAILED_PREFIX -- the outline carries no result this page can read (a non-shell row is
  // {kind, id, name, status, summary}), so without the marker a mail the relay REFUSED would have
  // drawn "Sent an email to ..." over a send that never happened.
  const MAIL_SEND_TOOL_CALL = "sendToUserToolCall";
  const MAIL_SEND_FAILED_PREFIX = "not sent: ";
  // TITAN-CATALOG-1. The three catalog tools ride three proto cases nothing else in this product
  // builds (source/host/runner/tools/sand-catalog-tools.ts says why), so these are the names their
  // outline rows carry. They get entries here for the same reason the two above do: a row whose
  // name is not in this table is headlined with the raw proto name, and a person must never read a
  // tool name on their own screen. All three draw one fixed sentence with an EMPTY detail, because
  // what the model read back is a catalog listing or a whole template row, not a receipt of work
  // anybody wants to expand. The one readable part is the template's NAME, and it reaches the page
  // only through the call's own args, the way mailSendRowText takes the recipient out of `message`.
  const CATALOG_LIST_TOOL_CALL = "getAgentStatusToolCall";
  const CATALOG_READ_TOOL_CALL = "readAgentTranscriptToolCall";
  const CATALOG_SETUP_TOOL_CALL = "createAgentToolCall";
  const CATALOG_LIST_ROW_TEXT = "Looked at the catalog";
  const CATALOG_READ_ROW_TEXT = "Read a template";
  // CODE-1. The coding sandbox rides `sendFinalSummaryToolCall`, whose args are a single string, and
  // it gets an entry here for the same reason the rows above do: a name that is not in this table is
  // headlined with the raw proto name, and a person must never read a tool name on their own screen.
  // That one string is the VERB and the TITLE -- never the instructions, which are the customer's own
  // job description and which the outline would serialize whole onto this page. On a refusal the
  // marker sits in front of it, because the outline carries no result this page can read (a non-shell
  // row is {kind, id, name, status, summary}), so without it a task the relay REFUSED would have
  // drawn "Started a coding task" over a job that never began.
  const CODE_TASK_TOOL_CALL = "sendFinalSummaryToolCall";
  const CODE_TASK_FAILED_PREFIX = "not done: ";
  const TOOL_LABELS = { shellToolCall: "Shell", readToolCall: "Read", communicateUpdateToolCall: "Update", computerUseToolCall: "Computer", Task: "Task", [PROBLEM_REPORT_TOOL_CALL]: "Report", [MAIL_SEND_TOOL_CALL]: "Email", [CATALOG_LIST_TOOL_CALL]: "Catalog", [CATALOG_READ_TOOL_CALL]: "Catalog", [CATALOG_SETUP_TOOL_CALL]: "Catalog", [CODE_TASK_TOOL_CALL]: "Coding" };
  const oneLine = (value, max) => {
    const text = String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" · ");
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  // SHOT-4: a receipt row is read by the owner of the business, not by the engineer who wrote the
  // command. A heredoc, a redirect and a set of Unix permission bits are the machine's spelling of
  // "wrote a file", so a shell row that is plainly one of the few things an agent does all day is
  // headlined in words. Nothing is dropped: the exact command and the exact output ride along as
  // the row's detail, which the conversation renders behind an expand affordance.
  const baseName = (path) => String(path).split("/").filter(Boolean).pop() || String(path);
  function shellHeadline(command, output) {
    const cmd = String(command ?? "").trim();
    if (!cmd) return null;
    // A write: `cat > PATH << 'EOF'`, `printf … > PATH`, `echo … >> PATH`, `… | tee PATH`.
    // The run of text before the redirect may not cross a separator or a newline, or `echo x; ls
    // 2>/dev/null` reads as a write to /dev/null; a digit before the arrow is a file-descriptor
    // redirect for the same reason, and /dev is not a file anyone wrote.
    const write = cmd.match(/(?:^|[\n|;&]\s*)(?:cat|printf|echo)\b[^>\n;|&]*(?<![0-9&])>>?\s*['"]?([^\s'";|&>]+)/)
      ?? cmd.match(/\|\s*tee\s+(?:-a\s+)?['"]?([^\s'";|&]+)/);
    if (write && !/^\/dev\//.test(write[1])) {
      // `ls -l` on the file it just wrote is the usual confirmation, and its fifth field is the
      // size in bytes. When the agent asked for something else, the row simply says what it wrote.
      const size = String(output ?? "").match(/^[-drwxsStT]{10}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s/m);
      return `Wrote ${baseName(write[1])}${size ? ` · ${size[1]} bytes` : ""} · ${write[1]}`;
    }
    const host = (url) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };
    const open = cmd.match(/box-chrome\s+['"]?(https?:\/\/[^\s'"]+)/);
    if (open) return `Opened ${host(open[1])}`;
    // A fetch, however it is piped afterwards: the page it went to is the part worth reading.
    const fetched = cmd.match(/\b(?:curl|wget|http)\b[^|;&]*?['"]?(https?:\/\/[^\s'"]+)/);
    if (fetched) return `Fetched ${host(fetched[1])}`;
    return null;
  }
  // A read row's summary is the tool's arguments as JSON. The path in it is the only part of that
  // a person reads, so the row says which file was read and keeps the JSON in its detail.
  function readHeadline(summary) {
    const path = String(summary ?? "").match(/"(?:path|file_path|filePath)"\s*:\s*"([^"]+)"/);
    return path ? `Read ${baseName(path[1])} · ${path[1]}` : null;
  }
  // The recipient, out of the args JSON, the way readHeadline takes a path out of one. An address
  // cannot hold a double quote, so the cheap match is the safe one; anything unparseable falls back
  // to a sentence with no address in it rather than to the proto name.
  function mailSendRowText(item) {
    const found = String(item?.summary ?? "").match(/"message"\s*:\s*"([^"]*)"/);
    const value = found ? found[1].trim() : "";
    const failed = value.startsWith(MAIL_SEND_FAILED_PREFIX) || item?.status === "failed";
    const to = value.startsWith(MAIL_SEND_FAILED_PREFIX)
      ? value.slice(MAIL_SEND_FAILED_PREFIX.length).trim()
      : value;
    if (item?.status === "pending") return to ? `Sending an email to ${to}` : "Sending an email";
    if (failed) return to ? `Tried to email ${to} · it did not send` : "An email did not send";
    return to ? `Sent an email to ${to}` : "Sent an email";
  }
  // TITAN-CATALOG-1. The bot's own name for the template it set up, out of the args JSON, the way
  // mailSendRowText takes an address out of one. An unparseable row falls back to a sentence with
  // no name in it rather than to the proto name.
  function catalogSetupRowText(item) {
    const found = String(item?.summary ?? "").match(/"name"\s*:\s*"([^"]*)"/);
    const name = found ? found[1].trim() : "";
    if (item?.status === "pending") return name ? `Setting up ${name} from the catalog` : "Setting up a bot from the catalog";
    if (item?.status === "failed") return name ? `Tried to set up ${name} from the catalog · it did not finish` : "A setup from the catalog did not finish";
    return name ? `Set up ${name} from the catalog` : "Set up a bot from the catalog";
  }
  // CODE-1. The verb and the title out of the args JSON, the way mailSendRowText takes an address out
  // of one. An unparseable row falls back to a sentence with no title in it rather than to the proto
  // name, and an EMPTY verb does the same: neither is ever allowed to become "Coding" on its own.
  function codeRowText(item) {
    const found = String(item?.summary ?? "").match(/"finalSummary"\s*:\s*"([^"]*)"/);
    const raw = found ? found[1].trim() : "";
    // The marker is matched WITHOUT its trailing space, because serializeError mints it alone: the
    // args of a tool call that threw are exactly "not done: ", the trim above takes the space off,
    // and a startsWith on the full marker would have missed it and headlined the row "Started a
    // coding task" over a call that never ran -- which is the one thing the marker exists to stop.
    const marker = CODE_TASK_FAILED_PREFIX.trim();
    const failed = raw === marker || raw.startsWith(CODE_TASK_FAILED_PREFIX);
    const value = failed ? raw.slice(marker.length).trim() : raw;
    const split = value.indexOf(" · ");
    const verb = (split === -1 ? value : value.slice(0, split)).trim();
    const title = split === -1 ? "" : value.slice(split + 3).trim();
    const detail = title;
    const say = (text) => ({ text, detail });
    if (item?.status === "pending") {
      if (verb === "status") return say("Checking on the coding task");
      if (verb === "stop") return say("Stopping the coding task");
      if (verb === "result") return say("Reading what the coding task did");
      return say("Starting a coding task");
    }
    if (failed || item?.status === "failed") {
      if (verb === "status") return say("Could not check the coding task");
      if (verb === "stop") return say("Could not stop the coding task");
      if (verb === "result") return say("The coding task's result is not ready");
      return say("A coding task did not start");
    }
    if (verb === "status") return say("Checked on the coding task");
    if (verb === "stop") return say("Stopped the coding task");
    if (verb === "result") return say("Coding task finished");
    return say("Started a coding task");
  }
  function toolRowText(item) {
    const label = TOOL_LABELS[item.name] ?? String(item.name ?? "Tool").replace(/ToolCall$/, "");
    // FEEDBACK-1. The one row in this table that is not a receipt of work done for the person, and
    // the only one whose arguments must never reach the page: they are the agent's own account of a
    // fault, which the person is about to read in full on the card and edit before it goes
    // anywhere. One fixed sentence in plain words, and an EMPTY detail so app.js draws a muted
    // bubble rather than an expandable receipt with the payload inside it.
    if (item.name === PROBLEM_REPORT_TOOL_CALL) return { text: PROBLEM_REPORT_ROW_TEXT, detail: "", kind: label };
    // MAIL-3. The same shape and for a related reason: one plain sentence, and an EMPTY detail so
    // app.js draws a muted bubble instead of an expandable receipt. The subject and the body are
    // the person's own words going out under their business's name; the chip says a mail went and
    // to whom, and the readable copy lives on the workspace's own Mail card, not in an expander.
    if (item.name === MAIL_SEND_TOOL_CALL) return { text: mailSendRowText(item), detail: "", kind: label };
    // TITAN-CATALOG-1. Three more of the same shape. What the model read back is the whole catalog
    // or a whole template row; putting that behind an expander would be a wall of ids and cron
    // expressions under a sentence that already says what happened.
    if (item.name === CATALOG_LIST_TOOL_CALL) return { text: CATALOG_LIST_ROW_TEXT, detail: "", kind: label };
    if (item.name === CATALOG_READ_TOOL_CALL) return { text: CATALOG_READ_ROW_TEXT, detail: "", kind: label };
    if (item.name === CATALOG_SETUP_TOOL_CALL) return { text: catalogSetupRowText(item), detail: "", kind: label };
    // CODE-1. One plain sentence, and the TITLE as its detail -- which is the one difference from the
    // rows above. The title is the agent's own short name for the job, written for the person and
    // already shown on the Coding strip, so it is the one part of a coding task that belongs on screen.
    // The instructions and the log never reach here; see codeRowText.
    if (item.name === CODE_TASK_TOOL_CALL) {
      const row = codeRowText(item);
      return { text: row.text, detail: row.detail, kind: label };
    }
    const headline = item.name === "shellToolCall" ? shellHeadline(item.summary, item.output)
      : item.name === "readToolCall" ? readHeadline(item.summary)
      : null;
    let text = headline ?? label;
    if (!headline && item.summary) text += ` · ${oneLine(item.summary, 120)}`;
    if (item.status === "pending") text += " · running";
    if (item.status === "failed") text += " · failed";
    if (!headline) {
      if (item.output) text += ` → ${oneLine(item.output, 200)}`;
      else if (typeof item.exitCode === "number") text += ` → exit ${item.exitCode}`;
    }
    // The receipt itself, verbatim, for the row that summarised it. Only a summarised row carries
    // one: a row that already prints its command in full has nothing to hide behind an expander.
    const detail = headline
      ? [`${label} · ${String(item.summary ?? "").trim()}`, String(item.output ?? "").trim(), typeof item.exitCode === "number" ? `exit ${item.exitCode}` : ""].filter(Boolean).join("\n\n")
      : "";
    // CONSOLE-4: `kind` is the step's own word, so the badge can say "shell 6, browser 3, read 5"
    // without re-parsing `text`. It comes straight off the TOOL_LABELS table above -- the same
    // table the row is headlined from -- because a summary that reads the headline back would go
    // wrong the moment shellHeadline turns "Shell · cat > notes.md" into "Wrote notes.md".
    return { text, detail, kind: label };
  }
  const messageKey = (message) => (message?.type === "text" ? `a:${String(message.content ?? "").trim()}` : `a:${JSON.stringify(message ?? null)}`);
  const userText = (e) => (typeof e.content === "string" ? e.content : e.content?.map?.((c) => c.text ?? "").join("") ?? "");
  function entryKey(e) {
    if (e.kind === "send-message") return messageKey(e.message);
    if (e.kind === "message" && e.role === "user") return `u:${userText(e).trim()}`;
    return null;
  }
  // COST-1. A projected outline (ui/api-diet.mjs, asked for with `x-titan-projection: lean`) has
  // already done this and hands the answer over as `k`. The key it carries is HASHED, because an
  // outline key IS the message text and carrying keys verbatim carries the whole conversation back a
  // second time -- measured on the 1,578-item agent, 1,239,452 bytes become 416,598 with verbatim
  // keys and 40,707 with hashed ones. So this prefers the key it is handed and falls back to
  // computing its own, which is what lets a projected and an unprojected answer draw the same page.
  function outlineKey(item) {
    // A projected anchor is exactly { k } and carries no kind, which is what makes this unambiguous:
    // if the host ever grows a `k` field of its own on a real outline item, that item still has a kind
    // and the key is still computed here.
    if (typeof item?.k === "string" && item.kind === undefined) return item.k;
    if (item.kind === "send-message") return messageKey(item.message);
    if (item.kind === "user") return `u:${String(item.text ?? "").trim()}`;
    return null;
  }
  // cyrb64, byte for byte ui/api-diet.mjs's hashOutlineKey. Math.imul over UTF-16 code units, so
  // node and every browser agree with no encoding step to disagree about and no crypto.subtle
  // (which is absent on a plain-http LAN origin). The cost of this function is that one hash has two
  // implementations; tests/api-diet.test.mjs weaves the real captured payload both ways and compares
  // the rows, so drift fails a test rather than moving a tool row in front of a customer.
  function hashOutlineKey(value) {
    const s = String(value);
    let h1 = 0xdeadbeef ^ s.length;
    let h2 = 0x41c6ce57 ^ s.length;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }
  // Rows are receipts of work. Progress updates, state edits and agent-to-agent sends are not
  // work, and their arguments are internal JSON nobody should read in a conversation.
  const NOT_A_RECEIPT = /communicate|update_state|todo|send.?to.?agent|react.?to.?message|sleep|wait|getmcptools/i;
  // `partial` says the transcript is a tail window, not the whole history. The outline still
  // starts at the beginning of the conversation, so rows that precede an outline entry the window
  // does not hold belong to history that is off screen; carrying them forward would dump every
  // tool call the agent ever made at the top of the window.
  function weaveToolRows(transcript, outline, partial = false) {
    const entries = [...(transcript ?? [])];
    const items = (Array.isArray(outline) ? outline : []).filter((i) => !(i?.kind === "tool-call" && NOT_A_RECEIPT.test(String(i.name ?? ""))));
    if (!items.some((item) => item?.kind === "tool-call")) return entries;
    // COST-1. When the outline arrived projected, its anchors carry hashed keys, so this side hashes
    // the transcript's keys too and the comparison happens in the same space. An unprojected answer
    // compares verbatim exactly as it always did.
    const projected = items.some((item) => typeof item?.k === "string" && item.kind === undefined);
    const keyOfEntry = projected
      ? (e) => { const k = entryKey(e); return k == null ? null : hashOutlineKey(k); }
      : entryKey;
    const inserts = new Map();
    let cursor = 0;
    let pending = [];
    for (const item of items) {
      // `toolKind` and not `kind`: `kind` on a woven entry is already "tool-row", the entry's own
      // shape. messagesOf lifts this one onto the message as `kind`, which is where the badge
      // reads it (CONSOLE-4).
      if (item?.kind === "tool-call") { const row = toolRowText(item); pending.push({ kind: "tool-row", id: `tool-${item.id}`, text: row.text, detail: row.detail, toolKind: row.kind }); continue; }
      const key = item ? outlineKey(item) : null;
      if (key == null) continue;
      let at = -1;
      for (let j = cursor; j < entries.length; j += 1) if (keyOfEntry(entries[j]) === key) { at = j; break; }
      if (at < 0) { if (partial && cursor === 0) pending = []; continue; }
      if (pending.length) { inserts.set(at, [...(inserts.get(at) ?? []), ...pending]); pending = []; }
      cursor = at + 1;
    }
    const woven = [];
    entries.forEach((e, j) => { if (inserts.has(j)) woven.push(...inserts.get(j)); woven.push(e); });
    woven.push(...pending);
    return woven;
  }

  // Agent-to-agent traffic carries fromAgent (inbound) or toAgent (outbound) on the entry. The
  // host stores it in the same transcript, but it is not this conversation: it is shown as the
  // product does, one blurb per run ("2 messages with Chief of staff"), never as a bubble from you.
  const peerOf = (e) => e.fromAgent?.name ?? e.toAgent?.name ?? null;
  function collapseAgentExchanges(entries, selfName) {
    const out = [];
    for (const e of entries) {
      const peer = e.kind === "message" ? peerOf(e) : null;
      if (peer == null) { out.push(e); continue; }
      const item = { from: e.fromAgent ? e.fromAgent.name : selfName, peer: Boolean(e.fromAgent), text: userText(e).trim(), time: timeOf(Number(e.timestampMs) || Date.now()) };
      const last = out.at(-1);
      if (last?.kind === "agent-exchange" && last.peer === peer) { last.count += 1; last.timestampMs = e.timestampMs ?? last.timestampMs; last.exchange.push(item); continue; }
      out.push({ kind: "agent-exchange", id: `exchange-${e.id}`, peer, self: selfName, count: 1, timestampMs: e.timestampMs, exchange: [item] });
    }
    return out;
  }
  // A file in the transcript (GW-09). The operator's upload lands as a user-attachment entry
  // carrying file_path; the agent's own SendMessage {type:"attachment"} carries a url, which is
  // a file:// URL when a tool saved the image to disk (mcp-image-assets.ts tells the model to
  // pass exactly that). readAttachmentImage and readAttachmentText both take the bare path, so
  // the URL form is unwrapped here and nowhere else. The kind is decided by extension, the same
  // table the host serves images from (media-extensions.ts IMAGE_MIME_FROM_EXTENSION).
  const IMAGE_EXT = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp|heic|heif)$/i;
  function localPathOf(urlOrPath) {
    const s = String(urlOrPath ?? "");
    if (!/^file:\/\//i.test(s)) return s;
    try { return decodeURIComponent(new URL(s).pathname); } catch { return s.replace(/^file:\/\//i, ""); }
  }
  function attachmentOf(urlOrPath, fileName) {
    const path = localPathOf(urlOrPath);
    if (!path) return null;
    const name = fileName || path.split("/").pop();
    return { path, name, kind: IMAGE_EXT.test(name) || IMAGE_EXT.test(path) ? "image" : "file" };
  }
  // CONSOLE-4: the OTHER carrier. `{type:"text", images:[{url, alt}]}` is what SendMessage's own
  // schema tells the model to use for a file it wants to show alongside a sentence, and it is how
  // ten of Titan's eleven transcript files actually arrive -- `{type:"attachment"}` accounted for
  // one of them. Nothing in the console read `.images` anywhere, which is why the Files list showed
  // one file where there were eleven.
  const imagesOf = (e) => (e.kind === "send-message" && Array.isArray(e.message?.images) ? e.message.images.filter((i) => i && i.url) : []);
  const isAttachmentEntry = (e) => e.kind === "user-attachment" || (e.kind === "send-message" && e.message?.type === "attachment") || imagesOf(e).length > 0;
  function messagesOf(transcript, fallbackName, outline, partial = false) {
    return collapseAgentExchanges(weaveToolRows(transcript, outline, partial), fallbackName)
      // UX-ERR-1. turn-failed is in this list because a filter that drops an entry kind it does
      // not know is how a failed turn came to show nothing at all: the host wrote the line and the
      // console threw it away one function before the renderer.
      .filter((e) => e.kind === "send-message" || e.kind === "tool-row" || e.kind === "agent-exchange" || e.kind === "user-attachment" || e.kind === "turn-failed" || (e.kind === "message" && e.role === "user"))
      .map((e, i) => {
        if (e.kind === "tool-row") return { id: e.id, type: "system", text: e.text, detail: e.detail ?? "", kind: e.toolKind ?? "" };
        // The host owns this sentence. It knows the agent's name and what actually went wrong, and
        // one copy of the wording is the only way the words on the page and the words in the gate
        // stay the same words. No detail field: there is no stack to open.
        if (e.kind === "turn-failed") return { id: e.id, type: "turn-failed", text: String(e.text ?? ""), cause: String(e.cause ?? ""), time: timeOf(Number(e.timestampMs) || Date.now()) };
        if (e.kind === "agent-exchange") return { id: e.id, type: "system", text: `${e.count} message${e.count === 1 ? "" : "s"} with ${e.peer}`, peer: e.peer, self: e.self, exchange: e.exchange };
        const mine = e.kind !== "send-message";
        const card = mine ? null : cardOf(e);
        // HANDBACK-1: the instruction IS this entry's own send-message text. Drawing the card and
        // the text bubble both is the person reading the same sentence twice, so a box entry gets
        // the card and no text. The agent's own lead-in ("handing you the computer now") is a
        // different entry and is untouched.
        const boxHandoff = mine || card ? null : boxHandoffOf(e);
        // CONSOLE-4: an images carrier is a LIST, and it keeps its own sentence. Both are handed
        // to the view: `attachment` stays the first one so nothing that reads it has to change,
        // and `attachments` carries all of them for the renderer that draws every figure.
        const images = imagesOf(e);
        const attachments = images.length
          ? images.map((i) => attachmentOf(i.url, undefined)).filter(Boolean)
          : (isAttachmentEntry(e)
            ? [attachmentOf(e.kind === "user-attachment" ? e.file_path : (e.message.url ?? e.message.file_path), e.kind === "user-attachment" ? e.file_name : e.message.file_name)].filter(Boolean)
            : []);
        const attachment = attachments[0] ?? null;
        // A {type:"attachment"} entry carries its words in `alt`; an images carrier keeps its own
        // `content`, which is the sentence the agent wrote around the file and must not be dropped.
        const text = attachment ? (images.length ? String(e.message?.content ?? "") : (e.kind === "send-message" ? e.message.alt ?? "" : ""))
          : e.kind === "send-message"
          ? (typeof e.message?.content === "string" ? e.message.content : "")
          : (typeof e.content === "string" ? e.content : e.content?.map?.((c) => c.text ?? "").join("") ?? "");
        return {
          id: e.id ?? `entry-${i}`,
          authorId: mine ? "you" : (e.author?.id ?? "agent"),
          authorName: mine ? "You" : (e.author?.name ?? fallbackName),
          type: card ? "decision" : boxHandoff ? "handoff" : attachment ? "attachment" : "text",
          ...(card ? { card } : {}),
          ...(boxHandoff ? { handoff: boxHandoff } : {}),
          ...(attachment ? { attachment, attachments } : {}),
          text: boxHandoff ? "" : String(text).trim(),
          time: timeOf(Number(e.timestampMs ?? e.createdAt)),
          // CONSOLE-4: the raw milliseconds beside the minute-resolution string. The badge needs a
          // span ("Worked for 2 min") and `time` is already formatted for a person, so it cannot
          // be subtracted. No tool row carries a timestamp at all, which is why a badge can only
          // give a duration where BOTH bounding chat entries exist.
          timestampMs: Number(e.timestampMs ?? e.createdAt) || 0,
          ...(e.evidence ? { evidence: e.evidence } : {}),
          // VOICE-1: the row was said out loud, not typed. It rides the send's own clientNonce, which
          // the host round-trips verbatim onto the durable user entry, so the chip survives a reload
          // and a wholesale repaint -- which page-local state in voice.js could not.
          ...(typeof e.clientNonce === "string" && e.clientNonce.startsWith("voice:") ? { spoken: true } : {}),
        };
      })
      // Claim provenance (docs/EVIDENCE-CONTRACT.md): the host stamps every text reply with a verdict
      // it computed from the tool results of that attempt. The stamp rides on the reply itself and
      // the view draws it as a chip inside that reply's row. It used to be synthesized here as a
      // separate system line reading "Evidence: unsupported · <url> in no tool result this attempt",
      // which an operator read as an error under a reply that had in fact been delivered.
      // A hand-off card carries no text by construction (above), so the trailing filter has to
      // keep it or the only row that says a person is needed would be dropped on the floor.
      .filter((m) => m.text || m.card || m.attachment || m.handoff);
  }

  // Agents the host is currently raising an error tray for. Rebuilt each pass, never accumulated:
  // a tray the operator cleared has to stop colouring the roster.
  const attentionIds = new Set();

  // Send acceptance (GW-03). The ledger's account slot for the host's own sends is the literal
  // "host" (shared/send-acceptance.ts HOST_ACCOUNT_SLOT); the nonce is ours. The ledger answers
  // found/not-found/unknown-durability, and a found record is accepted, pending or rejected with
  // a rejectionCode. A send that threw has its record cleared, so "no record" after a send the
  // gateway answered is itself a finding, not a shrug.
  const HOST_ACCOUNT_SLOT = "host";
  const nonce = () => (global.crypto?.randomUUID ? global.crypto.randomUUID() : `mr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  function describeAcceptance(answer) {
    const status = answer?.outcome === "found" ? answer.record?.status : null;
    if (status === "accepted") return { state: "accepted", text: "Accepted by the host" };
    if (status === "rejected") return { state: "not-accepted", text: `Not accepted — ${answer.record?.rejectionCode ?? "the host gave no reason"}` };
    if (status === "pending") return { state: "not-accepted", text: "Not accepted yet — the host still lists this send as pending" };
    if (answer?.outcome === "unknown-durability") return { state: "not-accepted", text: "Not accepted — the host's acceptance ledger is degraded and cannot say whether it took this" };
    if (answer?.outcome === "error") return { state: "not-accepted", text: `Not accepted — the acceptance check failed: ${answer.error}` };
    return { state: "not-accepted", text: "Not accepted — the host holds no record of this send" };
  }
  // What an import answered, against the list read back afterwards. The host reports imported
  // and skipped explicitly; a skipped row carries the reason, and that reason is the message.
  function importOutcome(answer, skills) {
    const imported = (Array.isArray(answer?.result?.imported) ? answer.result.imported : []).map((w) => (typeof w === "string" ? w : w?.name ?? w?.id ?? "")).filter(Boolean);
    const skipped = (Array.isArray(answer?.result?.skipped) ? answer.result.skipped : []).map((s) => ({ source: String(s?.source ?? ""), reason: String(s?.reason ?? "no reason given") }));
    const present = imported.filter((name) => skills.some((s) => s.name === name));
    return { imported: present, skipped, missing: imported.filter((name) => !present.includes(name)), skills };
  }

  // Files that passed through this agent's conversation. The gateway has read-by-path but no
  // directory listing of any kind, and there is no per-worker directory to list either -- every
  // worker's Shell runs in one shared /workspace (EXEC_DAEMON_CWD). So this is scoped by
  // construction: it comes out of that agent's own transcript, which is the only per-agent file
  // record the host actually keeps. The UI says as much, because "files" implying a private
  // working directory would be the same lie in a new place.
  //
  // CONSOLE-4 changed two things here, both of which Jason could see. It read only
  // `{type:"attachment"}`, and ten of the eleven files in Titan's conversation ride the
  // `{type:"text", images:[…]}` carrier instead -- so the list showed one file where there were
  // eleven. And it stored the raw `file://` URL, for which the host answers null (four bytes on
  // the wire) while the bare path answers the file: every path returned goes through localPathOf
  // now, the same unwrap the transcript's own attachments have always used.
  function filesOf(transcript) {
    const seen = new Set();
    return (transcript ?? []).flatMap((e) => {
      if (e.kind === "user-attachment" && e.file_path) {
        const path = localPathOf(e.file_path);
        return [{ name: e.file_name || path.split("/").pop(), path, from: "you", at: Number(e.timestampMs) || 0, bytes: Number(e.byteSize) || 0 }];
      }
      if (e.kind === "send-message" && e.message?.type === "attachment") {
        const path = localPathOf(e.message.url ?? e.message.file_path);
        if (path) return [{ name: e.message.file_name || path.split("/").pop(), path, from: "the worker", at: Number(e.timestampMs) || 0, bytes: Number(e.message.byteSize) || 0 }];
      }
      const images = imagesOf(e);
      if (images.length) {
        return images.map((image) => {
          const path = localPathOf(image.url);
          return { name: path.split("/").pop() || path, path, from: "the worker", at: Number(e.timestampMs) || 0, bytes: 0 };
        }).filter((f) => f.path);
      }
      return [];
    })
      .filter((f) => (seen.has(f.path) ? false : seen.add(f.path)))
      .sort((a, b) => b.at - a.at)
      .map((f) => ({
        ...f,
        meta: [
          `from ${f.from}`,
          f.bytes ? (f.bytes < 1024 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(1)} KB`) : null,
          f.at ? new Date(f.at).toLocaleDateString() : null,
        ].filter(Boolean).join(" · "),
      }));
  }

  // ---- BOX-6b: a conversation store that needs repair -------------------------------------------
  // Measured on the demo tenant's box 2026-09-09: one agent had failed EVERY turn since 2026-09-07
  // with `TranscriptJournalCorruptionError: transcript checkpoint must recover before preparing`,
  // and all the person reading its conversation was told was "could not finish that one. Ask
  // again". Asking again fails the same way for ever, so that sentence sends someone to retry a
  // thing that cannot work.
  //
  // ONE predicate, published on the global so app.js reads this one rather than a copy of it. The
  // sentence has to reach BOTH surfaces: the line reloadTrays pushes into the conversation, and the
  // card app.js builds in drainFailedTurnOffers. UX-ERR-3 measured that the host's own turn-failed
  // row often never lands, and the card is the part that survives the next transcript read, so a
  // clause on only one of them is a clause most people never read.
  const TRANSCRIPT_REPAIR_SENTENCE =
    "This agent's conversation store needs repair. Repair it from the agent's details panel.";
  // Both damage shapes the host can hit. The journal wording is the demo Titan's, measured; the
  // sqlite wordings are BOX-6's, which the host's own turn-failed classifier already names.
  const TRANSCRIPT_REPAIR_SIGNS =
    /transcript checkpoint must recover|transcriptjournalcorruption|conversation store needs repair|database disk image is malformed|sqlite_corrupt|file is not a database|malformed database schema/i;
  /** Did anything the box said about this failure name a store that needs repairing? */
  function transcriptRepairWordsSeen(...parts) {
    return parts.some((part) => part != null && TRANSCRIPT_REPAIR_SIGNS.test(String(part)));
  }
  /**
   * Agents a failed turn on THIS page named, kept because the state outlives the tray. `attentionIds`
   * beside it is cleared and rebuilt on every reloadTrays, and the tray is dismissed as it is read,
   * so attention lasts one tick -- right for a one-off failure and wrong for this one, which lasts
   * until somebody repairs it. Cleared only by a repair the host stood behind, and overruled either
   * way by the host's own flag on the next roster read.
   */
  const repairIds = new Set();
  /**
   * The host's own verdict, when it has one. `transcriptNeedsRepair` reaches the roster record from
   * session-summaries' buildSummary as either `true` or an object carrying the reason; both mean
   * "this agent will fail every turn until somebody repairs it". A box on an older bundle sends
   * neither, and then only the words above and the set above can say so.
   */
  function repairFlagOf(agent) {
    const flag = agent?.transcriptNeedsRepair;
    if (flag === true) return { needsRepair: true, needsRepairReason: "" };
    if (flag != null && typeof flag === "object") {
      const reason = typeof flag.reason === "string" ? flag.reason.trim() : "";
      return { needsRepair: true, needsRepairReason: reason };
    }
    if (agent?.id != null && repairIds.has(agent.id)) return { needsRepair: true, needsRepairReason: "" };
    return { needsRepair: false, needsRepairReason: "" };
  }
  /**
   * Did the host stand behind the repair? ONE judge, here, used by the panel's wording and by the
   * clearing above, because a console whose button says "Repaired" while its pill still says "Needs
   * repair" has told the person two different things about one press.
   *
   * MEASURED against the host on grok-bot-local-vm, 2026-09-09: a repair with nothing to do answers
   * `{before: 0, after: 0, quarantined: [], outcome: "already-healthy", reason: "this conversation
   * store had nothing to repair"}`. Two things follow, and the first draft of this file got both
   * wrong. `reason` is an explanation, NOT a refusal -- the host sends one on a success as well, so
   * a judge that read a non-empty reason as failure would report every clean repair as broken. And
   * an empty `quarantined` arrives as `[]`, not as null or a missing key.
   *
   * So the judgement is the outcome word alone. The host's vocabulary for this verb is
   * `already-healthy`, `recovered`, `reset` and `refused`; `repaired`, `rebuilt` and `ok` ride along
   * because they are unambiguous and cost nothing. Anything else is printed as the host said it and
   * is never translated into success.
   */
  const REPAIR_WORKED = /^(repaired|recovered|rebuilt|reset|already-healthy|healthy|ok|done)$/i;
  function repairWorked(answer) {
    if (answer == null) return false;
    const outcome = String(answer.outcome ?? "");
    return REPAIR_WORKED.test(outcome) || (outcome === "" && Number.isFinite(answer.after));
  }
  /**
   * `cleared` is the host's word for "the only thing I could do was turn the stuck state off".
   * Deliberately NOT in REPAIR_WORKED: nothing was repaired, no count was kept, and telling the
   * person "Repaired, 0 entries kept" after a press that did none of that is the false success the
   * review measured. The stuck state IS gone, so the pill and the control go with it -- and the
   * words the panel prints say to send one message and watch.
   */
  function repairCleared(answer) {
    return answer != null && String(answer.outcome ?? "").toLowerCase() === "cleared";
  }
  global.__transcriptRepair = {
    SENTENCE: TRANSCRIPT_REPAIR_SENTENCE,
    wordsSeen: transcriptRepairWordsSeen,
    flagOf: repairFlagOf,
    worked: repairWorked,
    cleared: repairCleared,
    remember: (id) => { if (id != null) repairIds.add(id); },
    forget: (id) => { repairIds.delete(id); },
  };
  // ---- end BOX-6b -------------------------------------------------------------------------------

  function statusOf(agent) {
    // BOX-6b rides alongside the status rather than inside it: a store that needs repair is true of
    // an agent that is idle, working or blocked, and it must not move the status word or inflate
    // the "N need you" count, which is a count of people-shaped jobs.
    const repair = repairFlagOf(agent);
    if (agent.isRunning) return { status: "working", statusText: "Working now", needsYou: false, needsYouReason: "", ...repair };
    // The third real state the old operator UI has and this one discarded: blocked on you.
    if (agent.awaitingUserResponse || attentionIds.has(agent.id)) {
      // QOL-NEEDS-YOU: "attention" covers two different things -- the host says this agent is
      // waiting on the operator, or its last turn errored. Only the first is a job for a person,
      // so it gets its own flag: the amber pill and the "N need you" count read this, not the
      // status, and a failed turn no longer inflates the count.
      const awaiting = agent.awaitingUserResponse;
      return {
        status: "attention",
        statusText: awaiting ? "Waiting on you" : repair.needsRepair ? "Its conversation store needs repair" : "The last turn failed",
        needsYou: Boolean(awaiting),
        needsYouReason: awaiting && typeof awaiting.reason === "string" ? awaiting.reason : "",
        ...repair,
      };
    }
    // The description is what the agent is for; it lives on the profile and the details panel. As
    // the idle status line it ran the whole persona across the sidebar card, the header and the
    // status pill (MR-28), so the status line says the state and nothing else.
    return { status: "ready", statusText: "Ready for the next task", needsYou: false, needsYouReason: "", ...repair };
  }

  // The automation record carries triggerDescription, schedule, isEnabled, lastRunAt and a runs[]
  // array that is NEWEST FIRST. Reading runs[length - 1] reports the oldest run as the latest, and
  // the status vocabulary is "ok", not the demo's "passed".
  const RUN_OK = new Set(["ok", "success", "completed", "passed"]);
  // The host's word for a run that failed is "error" (automation.ts: AutomationRunStatus is
  // "running" | "ok" | "error"); the card's word is "failed". Nothing mapped between them, so a
  // failed run fell through to the card's "outcome not reported" line -- and since a background
  // failure deliberately raises no tray error (automation-runtime.ts runLocalScheduledAutomation),
  // that line was the whole of what the console said about a scheduled run that failed.
  const RUN_FAILED = new Set(["error", "failed", "failure"]);

  function lastRunOf(automation) {
    const runs = Array.isArray(automation.runs) ? automation.runs : [];
    if (runs.length === 0) return null;
    const newest = runs.reduce((best, run) =>
      (run.startedAt ?? 0) > (best.startedAt ?? 0) ? run : best, runs[0]);
    const ms = Number(newest.finishedAt) - Number(newest.startedAt);
    return {
      // Report the host's own word when it is not one we recognise, rather than mapping an unknown
      // outcome onto "passed" and telling the operator a run succeeded.
      status: RUN_OK.has(newest.status) ? "passed"
        : RUN_FAILED.has(newest.status) ? "failed"
        : (newest.status ?? "unknown"),
      // A real measured duration: the host stamps both ends of the run.
      duration: Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : "",
      at: newest.finishedAt ?? newest.startedAt ?? null,
      trigger: newest.trigger ?? null,
      // finishRunDefinition stores the failure reason on the run row. It is the only place the
      // operator can read why a scheduled run failed, so it comes up with the status.
      detail: typeof newest.detail === "string" && newest.detail.trim() ? newest.detail.trim() : null,
    };
  }

  function routinesOf(list, scope) {
    return (list ?? []).map((a) => {
    const lastRun = lastRunOf(a);
    return {
      id: `${scope.id}::${a.id}`,
      name: a.name ?? a.id,
      scope,
      // The gateway has no coordinator or delegate on an automation. This was the agent you
      // happened to have open, rendered as "coordinates · <name>" -- a routing fact nobody set.
      coordinatorId: null,
      delegatedToId: null,
      trigger: a.triggerDescription ?? a.trigger?.summary ?? a.summary ?? "On a schedule",
      // The sentence above is the host's rendering of the trigger; this is the trigger. The
      // editor needs the stored shape back or a re-save rewrites it as whatever it could parse
      // out of the prose.
      triggerSpec: a.trigger ?? null,
      instruction: a.prompt ?? a.instruction ?? "",
      // "running" is the host's own word for a run it has started and not finished
      // (sand-automation-fire-consumer.ts reads run.status === "running"), so the Now island's
      // running branch is reachable from the record rather than only from a click in this tab.
      status: a.isEnabled === false ? "paused" : lastRun?.status === "running" ? "running" : "ready",
      nextRunAt: a.nextRunAt ?? null,
      // The host stamps this; the island had nothing else to say but "moments ago".
      lastRunAt: a.lastRunAt ?? null,
      lastRun,
    };
    });
  }

  // Routine ids are namespaced by scope so two workers can hold the same automation name; the
  // gateway wants the bare id back.
  const splitRoutineId = (routineId) => String(routineId).split("::");

  // The host keeps a trigger's members in the order it was handed them and drops the ones it
  // cannot parse (automation-trigger.ts parseMembers), rewriting values -- a cron string -- but
  // never a type. So the list of member types is the one thing a write can be checked against
  // without re-implementing the host's normalisation here.
  const memberTypes = (trigger) => (trigger == null ? []
    : trigger.type === "group" ? (trigger.listeners ?? [])
    : [trigger]).map((m) => m.type).join(",");

  // Integrations are the closest real thing to the prototype's plugin cards. A listener is a
  // chat platform the host binds to, not a toolset: getListenerIntegrations reports the platform
  // and its connection state and nothing else, so the card says that rather than showing an
  // empty Tools list that reads as "this connector has no tools".
  const LISTENER_TOOLS_NOTE = "A listener is a chat platform the host binds to, not a toolset. This gateway reports its platform and connection state only — the tools an agent holds come from the Connectors below and from its own built-ins.";
  function pluginsOf(raw) {
    const list = Array.isArray(raw) ? raw
      : Array.isArray(raw?.platforms) ? raw.platforms
      : Array.isArray(raw?.connections) ? raw.connections
      : Array.isArray(raw?.integrations) ? raw.integrations : [];
    return list.map((p) => {
      const name = p.name ?? p.platform ?? p.id ?? "Connector";
      const connected = Boolean(p.isConnected ?? p.connected);
      return {
        id: String(p.id ?? p.platform ?? name).toLowerCase(),
        name: name[0].toUpperCase() + name.slice(1),
        icon: name[0].toUpperCase(),
        // The host reports platform, isConnected, state and neededByCount -- nothing else. Any
        // category or blurb beyond that would be invented, and a plausible sentence is exactly
        // what makes fixture data read as fact.
        category: connected ? "Connected" : "Not connected",
        description: p.description
          ?? `Reported by the host as ${p.state ?? (connected ? "connected" : "idle")}.`
          + (p.neededByCount ? ` ${p.neededByCount} agent(s) want it.` : ""),
        status: connected ? "connected" : "available",
        account: p.account ?? null,
        // Connecting a listener is not wired to this UI, so there is no field to fill in.
        secretField: null,
        group: "Listeners",
        tools: [], toolsNote: LISTENER_TOOLS_NOTE,
        skills: [], skillsNote: null,
      };
    });
  }

  // The connectors that actually run inside the box. connectors.json is the only list of their
  // ids on this relay and listBoxMcpServers needs them by id; listRoutedMcpTools carries the
  // discovered tools, keyed by the same identifier. Both commands answer today, so these cards
  // carry real rows instead of the hardcoded empty arrays the Tools section used to render.
  const CONNECTOR_TOOLS_NOTE = "The box reports this server as attached but discovered no tools from it.";
  // Why the switches are absent rather than inert: the host stores per-tool disables in
  // mcpDisabledToolsByServerId, and its normaliser drops every key that is not a positive
  // integer (sand-settings-store.ts normalizeDisabledToolsByServerId). A local stdio server's id
  // is its name, so a write for it is accepted and silently discarded. Read-only until the host
  // has stable numeric ids for local servers.
  const CONNECTOR_TOOLS_READONLY = "Read-only here: the host keys per-tool disables by numeric server id and a local stdio server's id is its name, so a switch would be accepted and dropped.";
  // Two different reasons a switch is absent, and they used to share one sentence. A card that
  // carries the host's numeric id can be keyed; what it may still be missing is the write itself.
  const CONNECTOR_TOOLS_NO_COMMAND = "Read-only here: this host has no toggleMcpToolDisabled command yet, so a switch would have nowhere to write.";
  const CONNECTOR_CONFIG_NOTE = "Configured on the box in connectors.json. The box runs the process and the host discovers its tools; this page holds no credential in that file and does not show the ones it may carry.";
  // TENANT-2: an instance rendered without the docker socket cannot reach connectors.json at all
  // and answers 409 {error: "not_available", detail}. Keep the detail so the card says the sentence
  // written for an owner instead of the generic "could not be read from the box".
  let connectorsNote = null;
  const connectorConfig = () => relayFetch("/connectors").then(async (r) => {
    const body = await r.json();
    connectorsNote = r.ok ? null : (typeof body?.detail === "string" ? body.detail : null);
    return r.ok ? body : null;
  }).catch(() => null);

  // CONNECT-4's rule in one place: an env key whose value in the entry is the EMPTY string is a
  // credential the host is waiting for; one that carries a value is configuration and is never
  // offered as a place to paste a key. Read from the entry only -- the values themselves never
  // leave this function, and connectors.json is the 0600 plaintext file.
  const credentialEnvNames = (spec) => Object.entries(spec?.env ?? {})
    .filter(([, value]) => value === "")
    .map(([name]) => name);

  // CONNECT-3: the one connector entry an operator should not have to type out. TinyFish's MCP
  // endpoint refuses X-API-Key and takes the key as an Authorization bearer (TinyFish's own CLI
  // docs, npm @tiny-fish/cli, "Connect Grok"); mcp-remote is the local stdio bridge that carries
  // that header, and it expands ${NAME} inside a --header value from its OWN environment at
  // start. So the literal text ${TINYFISH_API_KEY} is what lands in connectors.json and the key
  // itself stays in the host's secret store. No space after the colon: that is the form
  // mcp-remote's README asks for from clients that mangle spaces inside an argument, and it trims
  // the value itself.
  //
  // The connectors wave turned that one recipe into a catalog. Every `entry` below after TinyFish
  // is the JSON from section 2 of that service's primary-source report in docs/connectors/,
  // character for character; tests/connector-preset-catalog.test.mjs parses those reports and
  // fails if a report and this list drift apart, so neither can be edited alone. `hints` is one
  // line per credential field, taken from the report's Credentials section: what the value is,
  // where it is created, and the least it needs to work. CodeRabbit has a report and no entry
  // here on purpose -- it ships a CLI, not an MCP server, so there is nothing to spawn.
  const PRESET_CREDENTIAL_NOTE = "The credential goes in the key form on this connector's own card once it is added, never in this form: connectors.json is plaintext on the box.";
  const CONNECTOR_PRESETS = [{
    id: "tinyfish",
    label: "TinyFish (API key)",
    name: "tinyfish",
    entry: {
      command: "npx",
      args: ["-y", "mcp-remote", "https://agent.tinyfish.ai/mcp", "--transport", "http-only", "--header", "Authorization:Bearer ${TINYFISH_API_KEY}"],
      env: { TINYFISH_API_KEY: "" },
    },
    hints: {
      TINYFISH_API_KEY: "Your TinyFish account's API key, carried to https://agent.tinyfish.ai/mcp as an Authorization bearer — X-API-Key is the REST-side name and this endpoint refuses it. The key is account-wide; it carries no separate scopes. If web search and page fetch are included with your plan you need no key here at all: your box is given one of its own and this card stays empty.",
    },
    // A box wants one TinyFish, so filling this over an entry already called tinyfish -- the OAuth
    // recipe in docs/CONNECTORS-TINYFISH.md -- replaces it instead of being refused as a duplicate.
    replaces: true,
    note: "The key goes in the credential card on the tinyfish card once this is added, never in this form: connectors.json is plaintext on the box.",
  }, {
    id: "github",
    label: "GitHub (PAT, read-only)",
    name: "github",
    // docs/connectors/github.md §2. The toolset and read-only headers are part of the entry: they
    // are what keeps this connector to repository, issue and PR reads plus the identity tool.
    entry: {
      command: "npx",
      args: [
        "-y",
        "mcp-remote@0.8.3",
        "https://api.githubcopilot.com/mcp/",
        "--transport",
        "http-only",
        "--header",
        "Authorization:Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}",
        "--header",
        "X-MCP-Toolsets:repos,issues,pull_requests",
        "--header",
        "X-MCP-Tools:get_me",
        "--header",
        "X-MCP-Readonly:true",
      ],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    },
    hints: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "A GitHub fine-grained personal access token. Create one under Settings → Developer settings → Personal access tokens → Fine-grained tokens (github.com/settings/personal-access-tokens/new); the least this entry needs is Contents: read, Issues: read and Pull requests: read, plus the Metadata: read it includes automatically.",
    },
    note: PRESET_CREDENTIAL_NOTE,
  }, {
    id: "slack",
    label: "Slack (user token)",
    name: "slack",
    // docs/connectors/slack.md §2. A local stdio server rather than a bridge, and posting stays
    // off: that is the server's own default, not a header this entry sets.
    entry: {
      command: "npx",
      args: ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"],
      env: { SLACK_MCP_XOXP_TOKEN: "" },
    },
    hints: {
      SLACK_MCP_XOXP_TOKEN: "A Slack user OAuth token (xoxp-), acting as the installing user. Create the app at api.slack.com/apps, add User Token Scopes, Install to Workspace and copy the User OAuth Token; channels:read alone lists public channels, and reading plus search also wants channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history, users:read and search:read.",
    },
    note: PRESET_CREDENTIAL_NOTE,
  }, {
    id: "linear",
    label: "Linear (API key)",
    name: "linear",
    // docs/connectors/linear.md §2. Same bridge and same bearer as GitHub, against Linear's
    // Streamable HTTP endpoint; without the header mcp-remote falls through to a browser OAuth
    // flow, which this box cannot finish.
    entry: {
      command: "npx",
      args: [
        "-y",
        "mcp-remote@0.8.3",
        "https://mcp.linear.app/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:Bearer ${LINEAR_API_KEY}",
      ],
      env: { LINEAR_API_KEY: "" },
    },
    hints: {
      LINEAR_API_KEY: "A Linear personal API key. Create one under Settings → Account → Security & Access → Personal API keys (linear.app/settings/account/security) and copy it once; Read is the only permission the read tools need, and Linear's own MCP FAQ recommends a Read-only key.",
    },
    note: PRESET_CREDENTIAL_NOTE,
  }, {
    id: "google",
    label: "Google Workspace (OAuth refresh token)",
    name: "google",
    // docs/connectors/google.md §2. Three credential fields, not one: the server mints access
    // tokens at runtime from the client pair plus the refresh token, so consent is done once in
    // Google's OAuth Playground and nothing here needs a browser afterwards.
    entry: {
      command: "npx",
      args: ["-y", "google-workspace-mcp-server@1.4.3"],
      env: { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GOOGLE_REFRESH_TOKEN: "" },
    },
    hints: {
      GOOGLE_CLIENT_ID: "The client ID of an OAuth Web application client. Create it in Google Cloud under APIs & Services → Credentials with https://developers.google.com/oauthplayground as an authorized redirect URI, on a project with the Gmail, Google Docs and Google Drive APIs enabled.",
      GOOGLE_CLIENT_SECRET: "The secret shown beside that same OAuth client under APIs & Services → Credentials. It is half of the client pair, not a scope of its own, and it is what the Playground is given to mint the refresh token.",
      GOOGLE_REFRESH_TOKEN: "The refresh token from the OAuth 2.0 Playground exchange (gear → Use your own OAuth credentials → Authorize APIs → Exchange authorization code for tokens), not the access token; authorize gmail.readonly for Gmail reads, gmail.compose for drafts, documents for Docs read and write, and drive.file plus drive.readonly for the Docs file IDs.",
    },
    note: PRESET_CREDENTIAL_NOTE,
  }];

  // One line per credential field, keyed by env name, so a card drawn from connectors.json can say
  // what the field is without knowing which preset put it there. Env names are unique across the
  // catalog; a connector added by hand under a different name still gets the hint for the value it
  // declares, which is the point -- the hint is about the credential, not about the entry.
  // MARKET-6. The five above are a PINNED COPY, not the source: they exist so this console still
  // says what a credential is with no gateway behind it, and so docs/connectors/ stays held to
  // them character for character. Everything else comes from the catalog the host already served
  // and this adapter already cached -- because the catalog grew from ten rows to twenty-two, and
  // under the old rule every new row needed its preset and its hint restated here by hand. A row
  // added to the catalog alone used to draw a masked box with no sentence under it, which is the
  // one thing CONNECT-4 was about.
  //
  // A catalog row declares its credentials one of two ways. `credentials` is the MARKET-5 shape --
  // one field, one hint, and the list of processes that field feeds -- and `credentialHints` is
  // the older env-name-to-line map. Both are read, the newer one first, so this works on a host
  // whose bundle is either side of that change.
  const catalogPluginCredentials = (item) => {
    const declared = Array.isArray(item?.credentials) ? item.credentials : [];
    if (declared.length) {
      return declared.map((credential) => ({
        field: String(credential?.field ?? ""),
        label: String(credential?.label ?? credential?.field ?? ""),
        hint: String(credential?.hint ?? ""),
        consumers: Array.isArray(credential?.consumers) ? credential.consumers : [],
      })).filter((credential) => credential.field.length > 0);
    }
    return Object.entries(item?.credentialHints ?? {}).map(([field, hint]) => ({
      field: String(field),
      label: String(field),
      hint: String(hint ?? ""),
      // The old shape says nothing about where a value goes, and a guess here would be the same
      // lie MARKET-5 exists to remove. An empty list means "this page does not know", and the
      // credential card says nothing rather than something wrong.
      consumers: [],
    }));
  };
  const PINNED_CREDENTIAL_HINTS = Object.fromEntries(CONNECTOR_PRESETS.flatMap((p) => Object.entries(p.hints ?? {})));
  function credentialHintMap() {
    const hints = {};
    for (const item of marketplaceCatalogCache?.plugins ?? []) {
      for (const credential of catalogPluginCredentials(item)) {
        if (credential.hint) hints[credential.field] = credential.hint;
      }
    }
    // The pinned copy wins, so a hint the existing suites hold cannot be moved by a catalog edit.
    return { ...hints, ...PINNED_CREDENTIAL_HINTS };
  }
  const credentialHintsFor = (fields) => {
    const hints = credentialHintMap();
    return Object.fromEntries(fields.flatMap((f) => (hints[f] ? [[f, hints[f]]] : [])));
  };

  // The editor's preset row, from the same place. A catalog row with a stdio entry of its own is a
  // preset: clicking it fills the form with that entry and its hints, exactly as the five pinned
  // ones do. A row with no command (a remote server, or the Add-your-own card itself) is not --
  // there is nothing to fill four fields with, and its Add is the card on the Marketplace.
  function catalogConnectorPresets() {
    const rows = [];
    for (const item of marketplaceCatalogCache?.plugins ?? []) {
      if (item?.kind === "shell-tool" || item?.opensEditor === true) continue;
      const entry = item?.install;
      if (entry == null || typeof entry !== "object" || typeof entry.command !== "string" || entry.command.length === 0) continue;
      const name = String(item.connectorName ?? item.id ?? "");
      if (!name || name.toLowerCase() === "shell") continue;
      rows.push({
        id: String(item.id ?? name),
        label: String(item.name ?? name),
        name,
        entry: { command: entry.command, args: Array.isArray(entry.args) ? [...entry.args] : [], env: { ...(entry.env ?? {}) } },
        hints: Object.fromEntries(catalogPluginCredentials(item).flatMap((c) => (c.hint ? [[c.field, c.hint]] : []))),
        replaces: item?.replaces === true,
        note: PRESET_CREDENTIAL_NOTE,
      });
    }
    return rows;
  }
  // The pinned five, then everything the catalog adds that they do not already cover. Pinned wins
  // on id AND on connector name: two buttons that write the same entry under the same name is a
  // way to make an operator wonder which one is real.
  function connectorPresetCatalog() {
    const pinned = CONNECTOR_PRESETS.map((preset) => ({ ...preset }));
    const ids = new Set(pinned.map((p) => p.id));
    const names = new Set(pinned.map((p) => p.name));
    return [...pinned, ...catalogConnectorPresets().filter((p) => !ids.has(p.id) && !names.has(p.name))];
  }

  // A header argument carries a space ("Authorization:Bearer ${TINYFISH_API_KEY}") and the
  // editor's argument field is one line of text that used to be split on whitespace alone -- so
  // that entry could not be expressed in this console at all: the header arrived as two arguments
  // and was lost. Quotes group; everything outside them splits exactly as it did before.
  function splitConnectorArgs(text) {
    const out = [];
    let current = "", quote = null, started = false;
    for (const ch of String(text ?? "")) {
      if (quote !== null) { if (ch === quote) quote = null; else current += ch; continue; }
      if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
      if (/\s/.test(ch)) { if (started) out.push(current); current = ""; started = false; continue; }
      current += ch; started = true;
    }
    if (started) out.push(current);
    return out;
  }
  // The inverse, for filling that field from a preset: only an argument that would be split needs
  // quoting, so everything that could be typed before still reads exactly as it did.
  const joinConnectorArgs = (args) => args
    .map((a) => (!/\s/.test(a) ? a : a.includes('"') ? `'${a}'` : `"${a}"`))
    .join(" ");

  // The catalog as data, on the page. scripts/verify-dashboard.mjs reads it in a real browser and
  // clicks its way through it, and tests/connector-preset-catalog.test.mjs reads the same array
  // through the stub window it loads this file with -- so neither has to restate an entry that
  // docs/connectors/ already fixes. argsText is here rather than derived twice: it is the exact
  // text the editor's one-line argument field carries for that entry.
  global.__connectorPresets = CONNECTOR_PRESETS.map((preset) => ({ ...preset, argsText: joinConnectorArgs(preset.entry.args) }));


  // ------------------------------------------------------------------- MARKET-6: add your own
  // Three doors onto one entry, because that is how a person actually arrives: with a LINK a
  // vendor published, with a PROGRAM a README says to run, or with a CONFIG BLOCK they copied out
  // of a docs page. The old editor offered the middle one alone, so a hosted server -- which is
  // most of them now -- could not be added from this console at all.
  //
  // What this half decides is nothing about transport. It builds a SPEC and hands it to the host,
  // which materialises the entry in one place (connectorEntryFromSpec): whether a remote server is
  // reached natively or through a bridge is a property of the box, it changes, and a form that
  // baked it in would go stale silently. What this half DOES decide is the refusals, because they
  // have to arrive before the operator has typed a key, not sixty seconds later as a stack trace.
  //
  // No value ever enters a spec. A header the operator ticks as secret carries an env NAME and an
  // empty value; the value goes through the masked card on the plugin page afterwards, into the
  // host's 0600 store. That is the same promise the connector key form has always made, extended
  // to the one field that used to have no home.
  const BYO_REFUSAL = {
    reservedName: '"shell" is reserved for the agent\'s own box shell environment, so a connector cannot use that name. Rename it (for example shell-mcp) and add it again.',
    insecure: "Give the address as https. Over plain http the key would travel in the clear, so this box will not open one.",
    privateHost: "That address is inside this box's own network, where its gateway and its tool daemons listen. Give the server's address on the internet instead.",
    credentialInUrl: "That address carries the key inside it. Take the key out of the address and add it as a header below, where it is stored instead of written down.",
    // MARKET-18. The old sentence told the operator to sign in on the box's desktop and add the
    // server again, and that could never work: there is no OAuth path on either the native remote
    // or the bridge, so the second add returned the same sentence forever. This is the true one,
    // and it is the SAME string the host answers with when it reads the far end's own challenge
    // (OAUTH_REMOTE_REFUSAL in remote-oauth-probe.ts) -- one door, one wording.
    oauth: "That server asks people to sign in through a browser, and this box has no browser sign-in to give it, so it would never finish connecting. If the server also takes an API key, add it again with that key in a header; otherwise it cannot be added here yet.",
  };

  // Loopback, the private ranges, link-local, and the names that resolve to them. A bridge pointed
  // at one of these runs beside the gateway on 127.0.0.1:1340 and the exec daemons on 1337/1338,
  // so this is not tidiness: it is the one address family a connector must never be aimed at.
  // An address, not the text somebody typed. `[::ffff:127.0.0.1]` is 127.0.0.1 and `[::]` is this
  // box, and the prefix tests below were handed `::ffff:7f00:1` and `::` and said neither was
  // private -- measured on this Mac against the shipped function on 8 September 2026, and the same
  // hole was open on the host's door. Brackets and a zone id come off, a v4-mapped or v4-compatible
  // address becomes its dotted quad, and any other v6 literal becomes its full eight-group form so
  // a prefix test means what it says.
  function byoNormalHost(host) {
    const name = String(host ?? "").replace(/^\[/, "").replace(/\]$/, "").split("%")[0].toLowerCase();
    if (!name.includes(":")) return name;
    let text = name;
    const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
    if (dotted) {
      const quad = dotted[1].split(".").map(Number);
      if (quad.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return name;
      text = `${text.slice(0, dotted.index)}:${(((quad[0] << 8) | quad[1]) >>> 0).toString(16)}:${(((quad[2] << 8) | quad[3]) >>> 0).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return name;
    const head = halves[0] === "" ? [] : halves[0].split(":");
    const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return name;
    const groups = [...head, ...Array(missing).fill("0"), ...tail].map((group) => parseInt(group, 16));
    if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return name;
    const canonical = groups.map((group) => group.toString(16)).join(":");
    if (canonical === "0:0:0:0:0:0:0:1" || canonical === "0:0:0:0:0:0:0:0") return canonical;
    const mapped = groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0);
    if (!mapped) return canonical;
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }

  function byoPrivateHost(host) {
    const name = byoNormalHost(host);
    if (!name) return true;
    if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal") || name.endsWith(".home.arpa")) return true;
    if (name === "0:0:0:0:0:0:0:1" || name === "0:0:0:0:0:0:0:0") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(name) || /^fe[89ab][0-9a-f]:/.test(name)) return true;
    const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
    if (!parts) return false;
    const [a, b] = parts.slice(1, 3).map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // A query parameter named like a credential means the LINK ITSELF is the key: it would sit in
  // connectors.json in plaintext, in the box's process list, and in anything that ever logs a URL.
  // There is no way to store that value separately, so the door refuses it rather than pretending.
  const BYO_CREDENTIAL_PARAM = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth|authorization|secret|password|passwd|pwd|sig|signature|session|sessionid|credential)$/i;
  const BYO_NOT_AN_ADDRESS = "That is not an address this box can open. Paste the whole address, starting with https://.";
  function byoUrlProblem(raw) {
    let url;
    try { url = new URL(String(raw ?? "").trim()); } catch { return BYO_NOT_AN_ADDRESS; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return BYO_NOT_AN_ADDRESS;
    if (url.protocol !== "https:") return BYO_REFUSAL.insecure;
    if (byoPrivateHost(url.hostname)) return BYO_REFUSAL.privateHost;
    if (url.username || url.password) return BYO_REFUSAL.credentialInUrl;
    for (const name of url.searchParams.keys()) if (BYO_CREDENTIAL_PARAM.test(name)) return BYO_REFUSAL.credentialInUrl;
    return null;
  }

  // The env name a secret header is stored under: the vendor out of the address, then what the
  // header is for. mcp.notion.com + Authorization -> NOTION_TOKEN; api.exa.ai + x-api-key ->
  // EXA_API_KEY. Derived rather than asked for, because the operator is here to paste a link, not
  // to name a variable -- and editable, because a derivation is a guess and this one is on screen.
  const BYO_HOST_NOISE = new Set(["www", "mcp", "api", "docs", "app", "server", "gateway", "remote", "cloud", "com", "net", "org", "io", "ai", "dev", "co", "uk", "so", "sh"]);
  function byoVendorFromUrl(raw) {
    let host = "";
    try { host = new URL(String(raw ?? "")).hostname; } catch { host = ""; }
    const labels = host.split(".").filter(Boolean);
    const meaningful = labels.filter((label) => !BYO_HOST_NOISE.has(label.toLowerCase()));
    const pick = meaningful.length ? meaningful[meaningful.length - 1] : (labels[0] ?? "server");
    return String(pick).replace(/[^a-z0-9]+/gi, "_").toUpperCase() || "SERVER";
  }
  const byoHeaderSuffix = (header) => {
    const name = String(header ?? "").trim();
    if (/^authorization$/i.test(name)) return "TOKEN";
    const cleaned = name.replace(/^x[-_]/i, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase();
    return cleaned || "TOKEN";
  };
  function byoEnvNameFor(url, header, taken = []) {
    const base = `${byoVendorFromUrl(url)}_${byoHeaderSuffix(header)}`;
    if (!taken.includes(base)) return base;
    for (let n = 2; n < 50; n += 1) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
    return base;
  }

  // A connector name out of the address, for the same reason: the operator did not come here to
  // invent one. Lowercased, and never the reserved word -- that refusal exists for a name someone
  // typed on purpose, not for one this function handed them.
  function byoNameFromUrl(url) {
    const vendor = byoVendorFromUrl(url).toLowerCase().replace(/_/g, "-");
    return vendor === "shell" ? "shell-mcp" : (vendor || "mcp-server");
  }

  const BYO_TRANSPORTS = [
    { id: "http", label: "Streamable HTTP (what almost every server uses)" },
    { id: "sse", label: "SSE (older; only if the server's docs say so)" },
  ];

  // A header value that came off a docs page is a placeholder far more often than a key -- and on
  // the occasion it IS a key, keeping it would write it into connectors.json, which is the one
  // thing this whole plane exists to stop. So a pasted value is never carried: the header becomes
  // a secret with a minted env name and the card says the value was not kept.
  const BYO_PLACEHOLDER = /^(\$\{[^}]*\}|\$[A-Z0-9_]+|<[^>]*>|your[-_ ].*|xxx+|\.\.\.|.*(api[-_]?key|token|secret|password)\s*(here)?)$/i;
  const byoLooksLikeSecretHeader = (name, value) => /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|auth|x-[\w-]*-key|x-[\w-]*-token)$/i.test(String(name ?? "").trim())
    || BYO_PLACEHOLDER.test(String(value ?? "").trim());

  // The spec, from what the LINK door holds. `headers` arrives as rows the form drew:
  // { name, secret, env?, value? }. A secret row keeps its NAME and its env name and drops any
  // value it was given; a plain row keeps a literal, which is what an "X-MCP-Readonly: true" is.
  // How a secret header's value is written into the entry. Every catalog row that authenticates
  // with `Authorization` writes `Bearer ${FIELD}`, and every row that uses a vendor's own header
  // (x-api-key, X-Browser-Use-API-Key) writes the placeholder bare -- because that is what those
  // servers ask for. The Add-your-own door wrote it bare in BOTH cases, so a person adding any
  // ordinary bearer server through the form got `Authorization: <key>` with no scheme, a 401 from
  // the far end, and a health line telling them the server refused their key. There was no way to
  // reach a working bearer header through the form at all.
  const byoHeaderPlaceholder = (header, env) =>
    (/^authorization$/i.test(String(header ?? "").trim()) ? `Bearer \${${env}}` : `\${${env}}`);

  function byoRemoteSpec(input) {
    const name = String(input?.name ?? "").trim();
    const url = String(input?.url ?? "").trim();
    const transport = BYO_TRANSPORTS.some((t) => t.id === input?.transport) ? String(input.transport) : "http";
    const rows = Array.isArray(input?.headers) ? input.headers : [];
    const taken = [];
    const headers = rows
      .map((row) => ({ name: String(row?.name ?? "").trim(), secret: row?.secret === true, env: String(row?.env ?? "").trim(), value: String(row?.value ?? "") }))
      .filter((row) => row.name.length > 0)
      .map((row) => {
        // `secret` is stated on every row, both ways round. A reader that had to treat an absent
        // key as false would treat a typo as false too, and the false case is the one that puts a
        // literal in a file.
        if (!row.secret) return { name: row.name, secret: false, value: row.value };
        const env = row.env || byoEnvNameFor(url, row.name, taken);
        taken.push(env);
        return { name: row.name, secret: true, env };
      });
    return {
      name: name || byoNameFromUrl(url),
      shape: "remote",
      url,
      transport,
      headers,
      // The names, restated where a caller that only reads env can find them. Every value is
      // empty: that emptiness is what CONNECT-4 reads to know a field is a credential.
      envNames: headers.filter((h) => h.secret === true).map((h) => h.env),
      auth: input?.auth === "oauth" ? "oauth" : "header",
    };
  }

  function byoProgramSpec(input) {
    const args = Array.isArray(input?.args) ? input.args.map((a) => String(a)) : splitConnectorArgs(input?.argsText ?? "");
    return {
      name: String(input?.name ?? "").trim(),
      shape: "program",
      command: String(input?.command ?? "").trim(),
      args,
      envNames: (Array.isArray(input?.envNames) ? input.envNames : String(input?.envNames ?? "").split(","))
        .map((n) => String(n).trim()).filter(Boolean),
    };
  }

  // Every refusal the door makes, in the order an operator meets them, as ONE sentence each. A
  // caller renders whatever comes back verbatim: the words are the contract, not a class name.
  function byoRefusal(spec) {
    const name = String(spec?.name ?? "").trim();
    if (!name) return "Give this server a name. It is the name the box files it under and the name the agent will see.";
    if (name.toLowerCase() === "shell") return BYO_REFUSAL.reservedName;
    if (spec?.shape === "remote") {
      if (spec?.auth === "oauth") return BYO_REFUSAL.oauth;
      return byoUrlProblem(spec?.url);
    }
    if (!String(spec?.command ?? "").trim()) return "Give the command the box should run. Without one there is nothing to start.";
    return null;
  }

  // The PASTE door. A vendor's docs page carries { "mcpServers": { "<name>": { ... } } }, and that
  // block is what a person has in their clipboard when they arrive. Accepted in the three shapes
  // it comes in -- the wrapper, a bare name-to-entry map, and a single entry -- and resolved into
  // whichever of the other two doors it actually is, so what happens next is the form they can
  // read rather than a write they cannot.
  const BYO_NOT_A_BLOCK = 'That is not the config block. Copy the whole { "mcpServers": { … } } object from the server\'s own page, braces included.';
  function byoParsePasted(text) {
    let parsed;
    try { parsed = JSON.parse(String(text ?? "").trim()); } catch { return { ok: false, message: BYO_NOT_A_BLOCK }; }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, message: BYO_NOT_A_BLOCK };
    const isEntry = (value) => value != null && typeof value === "object" && !Array.isArray(value)
      && (value.command != null || value.url != null || value.serverUrl != null || value.httpUrl != null);
    const map = parsed.mcpServers ?? parsed.servers ?? parsed;
    let name = "";
    let entry = null;
    if (map && typeof map === "object" && !Array.isArray(map)) {
      const named = Object.keys(map).filter((key) => isEntry(map[key]));
      if (named.length > 1) return { ok: false, message: `That block holds ${named.length} servers. Paste one at a time, so you can read what each will do before it is added.` };
      if (named.length === 1) { name = named[0]; entry = map[named[0]]; }
    }
    if (!entry && isEntry(parsed)) entry = parsed;
    if (!entry) return { ok: false, message: "That block names no server this box can start: an entry needs either a command to run or an address to open." };
    const dropped = (pairs) => pairs
      .filter(([key, value]) => byoLooksLikeSecretHeader(key, value) && String(value ?? "").trim().length > 0)
      .map(([key]) => key);
    // Said out loud, because a value silently discarded is worse than one refused: the operator
    // would press Add believing the key came along.
    const droppedNote = (names) => (names.length
      ? `The value on ${names.join(" and ")} was not kept. Nothing typed into this form is stored, so put it in the key box on this server's page once it is added.`
      : null);
    const url = String(entry.url ?? entry.serverUrl ?? entry.httpUrl ?? "").trim();
    if (url) {
      const declared = String(entry.type ?? entry.transport ?? "").toLowerCase();
      const pairs = Object.entries(entry.headers ?? {});
      const rows = pairs.map(([header, value]) => ({
        name: header,
        secret: byoLooksLikeSecretHeader(header, value),
        value: byoLooksLikeSecretHeader(header, value) ? "" : String(value ?? ""),
      }));
      const spec = byoRemoteSpec({
        name: name || byoNameFromUrl(url),
        url,
        transport: declared.includes("sse") ? "sse" : "http",
        headers: rows,
        auth: entry.auth === "oauth" ? "oauth" : "header",
      });
      return { ok: true, door: "link", spec, note: droppedNote(dropped(pairs)) };
    }
    const envPairs = Object.entries(entry.env ?? {});
    const spec = byoProgramSpec({
      name: name || String(entry.command ?? "server"),
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args : [],
      envNames: Object.keys(entry.env ?? {}),
    });
    return { ok: true, door: "program", spec, note: droppedNote(envPairs.filter(([, value]) => String(value ?? "").trim().length > 0).map(([key]) => key)) };
  }

  // What the operator reads before pressing Add. The host owns the entry, so where it can be asked
  // (previewLocalConnector) this is the host's own answer; where it cannot, it is the spec in the
  // words that were typed, and the line under it says the box decides how it opens the address.
  // Either way the operator sees the whole of what is about to be written, and never a key.
  async function byoPreview(spec) {
    const asked = await tryCall("previewLocalConnector", { spec }).catch(() => null);
    if (asked && typeof asked === "object" && asked.entry) {
      return { entry: asked.entry, fromHost: true, note: typeof asked.note === "string" ? asked.note : null };
    }
    if (spec?.shape === "remote") {
      const headers = {};
      for (const header of spec.headers ?? []) {
        headers[header.name] = header.secret === true
          // Shown the way it will be written, scheme included, so the preview and the entry agree.
          ? (/^authorization$/i.test(String(header.name ?? "").trim()) ? `Bearer (stored under ${header.env})` : `(stored under ${header.env})`)
          : String(header.value ?? "");
      }
      return {
        entry: { type: spec.transport === "sse" ? "sse" : "http", url: spec.url, headers, env: Object.fromEntries((spec.envNames ?? []).map((n) => [n, ""])) },
        fromHost: false,
        note: "The box decides how it opens this address when it is added. Whichever way it does, the key stays in the host's own store.",
      };
    }
    return {
      entry: { command: spec?.command ?? "", args: spec?.args ?? [], env: Object.fromEntries((spec?.envNames ?? []).map((n) => [n, ""])) },
      fromHost: false,
      note: null,
    };
  }

  // The old editor's four fields, as a spec. Every caller that used to build {name, command, args,
  // envNames} keeps working and goes through the same one writer as the new doors.
  const byoSpecFromFields = (spec) => ({
    name: String(spec?.name ?? "").trim(),
    shape: "program",
    command: String(spec?.command ?? "").trim(),
    args: Array.isArray(spec?.args) ? spec.args.map(String) : [],
    envNames: (Array.isArray(spec?.envNames) ? spec.envNames : []).map((n) => String(n).trim()).filter(Boolean),
    replace: spec?.replace === true,
  });

  // ui/server.mjs readConnectors answers { mcpServers: {} } for BOTH an empty file and a box it
  // could not `docker exec cat` into (the catch on a null read), so an empty map is ambiguous --
  // and a write derived from it during a box restart replaces every connector on the box with the
  // one entry being added. Only an empty read is ambiguous, so only an empty read pays for a
  // liveness probe: a gateway that answers means the file really is empty and the first connector
  // can be written; a gateway that does not means the read was a failure wearing an empty object,
  // and this returns null so the caller writes nothing at all.
  const serversOf = (config) => {
    const servers = config?.mcpServers;
    return servers != null && typeof servers === "object" && !Array.isArray(servers) ? servers : null;
  };
  async function readableConnectorServers() {
    const servers = serversOf(await connectorConfig());
    if (servers == null) return null;
    if (Object.keys(servers).length > 0) return servers;
    const alive = await call("getHostStatus", {}).then(() => true).catch(() => false);
    return alive ? servers : null;
  }
  const CONNECTORS_UNREADABLE = "connectors.json could not be read from the box; nothing was written.";

  // CP-03: the connector cards the host itself installs. listInstalledMcpServers answers rows
  // with a NUMERIC id -- the id mcpDisabledToolsByServerId is keyed by -- so the tool rows on
  // these cards carry a real switch. listMcpServerTools { serverId } is the per-server tool list
  // with its enabled flag, and listConnectorSecretFields { server } names the env values the host
  // stores for it. All three may be absent on a host that has not landed them yet; connectorCards
  // below is the Wave B read-only path they fall back to.
  async function installedConnectorPlugins(installed, config) {
    const canToggle = !commandMissing("toggleMcpToolDisabled");
    return Promise.all(installed.map(async (server) => {
      const name = String(server.name ?? server.id ?? "");
      const serverId = server.id;
      const numeric = typeof serverId === "number" || /^[1-9]\d*$/.test(String(serverId ?? ""));
      // These two .catch(() => null) are not the mistake they look like: both commands genuinely
      // throw for a server that is installed but not in connectors.json (an account server has no
      // stdio spec and no secret fields), and a card that cannot list its tools is still a card
      // worth drawing. The one that must NOT be swallowed is listInstalledMcpServers below --
      // that is the difference between "no host half yet" and "the host refused".
      const [tools, fields] = await Promise.all([
        tryCall("listMcpServerTools", { serverId }).catch(() => null),
        tryCall("listConnectorSecretFields", { server: name }).catch(() => null),
      ]);
      const rows = Array.isArray(tools) ? tools : [];
      // { server, serverId, fields, stored } on this host; an array is accepted too, so a host
      // that answers the bare list does not silently lose the form. The two lists answer two
      // different questions and must not be read for each other: `fields` is the union of the
      // stored names and the env keys the entry leaves EMPTY (CONNECT-4), while `stored` is the
      // names the host's 0600 store actually holds a value for.
      const fieldNames = (list) => (Array.isArray(list) ? list : []).map((f) => String(f?.name ?? f)).filter(Boolean);
      const offeredFields = fieldNames(Array.isArray(fields) ? fields : fields?.fields);
      // Only a name the host reports HOLDING may make the card say so. Read off `fields`, a
      // freshly added tinyfish entry -- empty env value, empty store -- came up captioned "The
      // host holds a value", on the very card the TinyFish preset exists to get a key into. A
      // host that answers no `stored` list holds nothing this page can vouch for, so it says
      // "Enter securely" rather than claiming a value nobody has seen.
      const storedFields = fieldNames(fields?.stored);
      const spec = config?.mcpServers?.[name] ?? null;
      const status = server.status ?? "unknown";
      const transport = server.transport ?? (spec?.command ? "stdio" : "mcp");
      // The executable only, never its argv: connectors.json is the 0600 file ui/server.mjs calls
      // out as carrying connector tokens in plaintext, and a stdio server is routinely launched
      // with --api-key= in argv. The count says the file holds more without printing it.
      const command = spec?.command ? String(spec.command) : null;
      const argCount = Array.isArray(spec?.args) ? spec.args.length : 0;
      const toolCount = Number.isFinite(Number(server.toolCount)) ? Number(server.toolCount) : rows.length;
      const secretFields = [...new Set([...credentialEnvNames(spec), ...offeredFields])];
      return {
        id: `mcp:${name}`, name, icon: (name[0] ?? "?").toUpperCase(),
        group: "Connectors", serverId,
        // The box's own word for this server, kept beside the card's connected/available so the
        // settle poll below can tell a card that is still connecting from one that has landed.
        boxStatus: status,
        category: `${transport} · ${status}`,
        description: [
          `The box reports this server as ${status} — host id ${serverId}, ${transport}.`,
          `${toolCount} tool(s) discovered.`,
          command ? `Runs in the box as ${command} (${argCount} argument(s), configured in connectors.json).` : null,
        ].filter(Boolean).join(" "),
        status: status === "connected" ? "connected" : "available",
        account: null,
        // A connector is not a chat platform: getListenerConnectUrl has nothing to offer it. What
        // it can take is its env values, and that is the key form below, not a connect button.
        connectable: false,
        connectNote: "This connector is launched from connectors.json on the box. Add or remove one with the editor below; its credentials go in the key form on this card.",
        connectedNote: CONNECTOR_CONFIG_NOTE,
        removable: spec != null,
        tools: rows.map((t) => ({
          id: `${name}::${t.name}`, name: t.name,
          description: oneLine(t.description ?? "", 160) || "No description from the server.",
          enabled: t.enabled !== false,
          togglable: canToggle && numeric,
        })),
        toolsNote: CONNECTOR_TOOLS_NOTE,
        toolsReadOnlyNote: numeric ? (canToggle ? null : CONNECTOR_TOOLS_NO_COMMAND) : CONNECTOR_TOOLS_READONLY,
        // CP-10 item 1: one masked input per environment value this connector wants. The host
        // answers { server, serverId, fields, stored } and its `fields` are the credential fields
        // it will accept a value for -- so the form is drawn from the env names connectors.json
        // declares WITH NO VALUE as well, for the moment before the host has answered at all.
        // Only keys are read from that file; values stay off it.
        // CONNECT-4: only the EMPTY-valued env keys. MCP_REMOTE_CONFIG_DIR is a path, it was
        // offered here as somewhere to "Enter securely", and a pasted key went into it. The host
        // is the authority -- listConnectorSecretFields answers the same union of stored fields
        // and empty-valued env keys -- and this is that rule mirrored for the moment the card is
        // drawn before the host has answered.
        secretFields,
        storedFields,
        // What each of those fields IS, one line, from the same catalog the editor's presets come
        // from. An operator who reaches this card without the credential in hand needs to be told
        // where it is made and what it must be allowed to do, and this is the only place on the
        // page that knows -- the host answers names, not what they mean.
        secretHints: credentialHintsFor(secretFields),
        secretHint: `Stored by the host for ${name} in its own 0600 store and merged into the connector's environment when the box launches it. It never enters connectors.json, chat, model context or this page's markup.`,
        // MARKET-6. What an operator saw when a connector failed was several hundred characters of
        // Node stack. The host maps its own {status, statusDetail} to ONE plain sentence and this
        // carries it through untouched: the console renders it and never parses a statusDetail,
        // because the day it starts matching on that string is the day it starts guessing. The raw
        // text rides along for the disclosure under it, and a host with no sentence yet leaves the
        // card exactly as it was.
        statusSentence: typeof server.statusSentence === "string" && server.statusSentence.length > 0 ? server.statusSentence : null,
        statusDetail: typeof server.statusDetail === "string" && server.statusDetail.length > 0 ? server.statusDetail : null,
        skills: [], skillsNote: null,
      };
    }));
  }

  // CONNECT-5: a shell tool is a CLI the agent runs from its own shell, with its credential in the
  // environment. CodeRabbit ships no MCP server at all, so it can never be a connector card; the
  // operator's cli-anything-tinyfish is the same shape. These cards sit in their own group under
  // Connectors and reuse the connector credential card component, because the promise a credential
  // card makes -- the host holds it, this page never did -- is the same one.
  const SHELL_TOOL_TOOLS_NOTE = "A shell tool has no MCP tools to list: the agent runs its command itself. What it adds is the command on this card.";
  async function shellToolPlugins() {
    const catalog = await tryCall("listShellTools", {}).catch(() => null);
    if (!Array.isArray(catalog) || catalog.length === 0) return [];
    // The catalog answer already carries `stored` per tool; the field list is read too so a
    // credential stored under a name the catalog no longer claims still appears somewhere.
    const secrets = await tryCall("listShellSecretFields", {}).catch(() => null);
    const stored = new Set(Array.isArray(secrets?.stored) ? secrets.stored.map(String) : []);
    return catalog.map((tool) => {
      const id = String(tool?.id ?? "");
      const field = String(tool?.field ?? "");
      const held = stored.has(field) || tool?.stored === true;
      const skillUrl = typeof tool?.skillUrl === "string" && tool.skillUrl.length > 0 ? tool.skillUrl : null;
      return {
        id: `shell:${id}`, name: String(tool?.name ?? id), icon: (String(tool?.name ?? id)[0] ?? "?").toUpperCase(),
        group: "Shell tools",
        category: `shell CLI · ${held ? "key stored" : "no key yet"}`,
        description: `A command-line tool the agent runs in the box. It reads ${field} from the shell environment; the host holds the value and hands it to the box.`,
        status: held ? "connected" : "available",
        account: null,
        connectable: false,
        connectNote: `${String(tool?.name ?? id)} is not connected, it is installed. Install it in the box below, then store ${field} in the credential card.`,
        connectedNote: `The host holds ${field} and merges it into the environment of the box shell the agent runs commands in. This page never received it.`,
        removable: false,
        tools: [], toolsNote: SHELL_TOOL_TOOLS_NOTE, toolsReadOnlyNote: null,
        secretFields: field ? [field] : [],
        storedFields: held && field ? [field] : [],
        secretHint: `${String(tool?.credentialNote ?? "")} The host stores it in its own 0600 store and merges it into the box shell's environment. It never enters connectors.json, chat, model context or this page's markup. Removing it empties ${field} rather than removing it: the name stays in the running box shell with an empty value until the box restarts.`,
        skills: [], skillsNote: null,
        shellTool: {
          id, field,
          // MARKET-1: whether the CLI itself is in the box. The host answers that with
          // `command -v <binary>` in the box's own shell, which is the only true signal --
          // nothing records a shell-tool install. `held` is the fallback for an older host, and
          // it is a weaker claim: a stored key is not a program.
          installed: typeof tool?.installed === "boolean" ? tool.installed : held,
          install: String(tool?.install ?? ""),
          usage: String(tool?.usage ?? ""),
          teachable: skillUrl != null,
          skillUrl,
        },
      };
    });
  }

  // onError is the transcript's `failed` where there is a conversation to say it in. tryCall
  // already answers null for a host that has never heard of the command; anything it THROWS is a
  // host that has the command and refused, and swallowing that rendered a 500 as though the
  // command did not exist. The card still degrades to the Wave B read-only one -- there is nothing
  // else to draw -- but the reason is said out loud instead of disappearing.
  async function connectorPlugins(onError) {
    const config = await connectorConfig();
    const shellTools = await shellToolPlugins().catch(() => []);
    let installed = null;
    try {
      installed = await tryCall("listInstalledMcpServers", {});
    } catch (error) {
      if (typeof onError === "function") onError(`The host could not list its connectors: ${error.message}`);
      return [...await connectorCards(config), ...shellTools];
    }
    // A host that answers the command but reports nothing installed still has connectors.json,
    // so the Wave B card is the honest fallback rather than an empty Connectors group.
    const connectors = Array.isArray(installed) && installed.length > 0
      ? await installedConnectorPlugins(installed, config)
      : await connectorCards(config);
    return [...connectors, ...shellTools];
  }

  async function connectorCards(config) {
    const tools = await call("listRoutedMcpTools").catch(() => null);
    const rows = Array.isArray(tools) ? tools : [];
    const ids = [...new Set([...Object.keys(config?.mcpServers ?? {}), ...rows.map((t) => t.providerIdentifier)])]
      .filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length === 0) return [];
    const answer = await call("listBoxMcpServers", { serverIdentifiers: ids }).catch(() => null);
    const byId = new Map((Array.isArray(answer?.servers) ? answer.servers : []).map((s) => [s.serverIdentifier, s]));
    return ids.map((id) => {
      const server = byId.get(id) ?? null;
      const spec = config?.mcpServers?.[id] ?? null;
      const mine = rows.filter((t) => t.providerIdentifier === id);
      const status = server?.status ?? "unknown";
      // The executable only, never its argv. ui/server.mjs's own note on connectors.json is
      // "0600: this file carries connector tokens in plaintext", and a stdio MCP server is
      // routinely launched with `--api-key=...` or `--header "Authorization: Bearer ..."` in
      // argv. This description is painted straight into the dashboard DOM, so joining the args
      // in would put those on screen. The count is enough to say the file has more in it.
      const command = spec?.command ? String(spec.command) : null;
      const argCount = Array.isArray(spec?.args) ? spec.args.length : 0;
      return {
        id: `mcp:${id}`, name: id, icon: id[0].toUpperCase(),
        group: "Connectors", boxStatus: status,
        category: `${command ? "stdio" : "mcp"} · ${status}`,
        description: [
          `The box reports this server as ${status}${server?.statusDetail ? ` — ${server.statusDetail}` : ""}.`,
          `${server?.toolCount ?? mine.length} tool(s) discovered.`,
          command ? `Runs in the box as ${command} (${argCount} argument(s), configured in connectors.json).` : null,
        ].filter(Boolean).join(" "),
        status: status === "connected" ? "connected" : "available",
        account: null, secretField: null,
        // getListenerConnectUrl is a chat-platform command; an MCP server is not one, and there is
        // no gateway command that installs one from here. connectors.json is where it is edited.
        connectable: false,
        connectNote: "This connector is configured on the box in connectors.json. Add or remove one with the editor below; this host has no per-connector credential command yet.",
        // "no credential here" means this page, not the box: connectors.json can carry env and
        // argv credentials, which is exactly why neither is echoed onto this card.
        connectedNote: "Configured on the box in connectors.json. The box runs the process and the host discovers its tools; this page holds no credential for it and does not show the ones connectors.json may carry.",
        removable: spec != null,
        secretFields: [],
        tools: mine.map((t) => ({
          id: `${id}::${t.toolName}`,
          name: t.toolName ?? t.name,
          description: oneLine(t.description ?? "", 160) || "No description from the server.",
          enabled: true,
          togglable: false,
        })),
        toolsNote: CONNECTOR_TOOLS_NOTE,
        toolsReadOnlyNote: CONNECTOR_TOOLS_READONLY,
        skills: [], skillsNote: null,
      };
    });
  }

  // ------------------------------------------------------------------ MARKET-1: the marketplace
  // One catalog, in the repo at source/shared/marketplace/catalog.ts, bundled into the host and
  // served by two gateway commands. The console reads it ONLY through the gateway, never from a
  // static JSON beside this file, so the agents' own plugin tools and this page see the same rows.
  // A host that has not landed the commands answers "unknown gateway method", tryCall turns that
  // into null, and the panel says the catalog is not on this host rather than drawing an empty one.
  let marketplaceCatalogCache = null;
  // BOTS-4. The read IN FLIGHT, not only the settled answer. Measured on grok-bot-local-vm
  // 2026-09-09: opening Marketplace fetched listMarketplace TWICE -- 221,128 B on a box serving
  // seven bots -- because the Plugins half and the Bots half both ask on the same tick and a cache
  // that only holds settled answers is still empty when the second one arrives. With 72 bots in the
  // catalog that is the difference between one body and two on a relay that buffers each one whole.
  // Two builders wrote this fix independently; this is the one that keeps a forced read out of the
  // shared slot, so a deliberate refresh cannot be handed to a caller that asked for the cache.
  let marketplaceCatalogInFlight = null;
  function marketplaceCatalog(force) {
    if (marketplaceCatalogCache && force !== true) return Promise.resolve(marketplaceCatalogCache);
    if (marketplaceCatalogInFlight && force !== true) return marketplaceCatalogInFlight;
    const pending = fetchMarketplaceCatalog().finally(() => {
      if (marketplaceCatalogInFlight === pending) marketplaceCatalogInFlight = null;
    });
    if (force !== true) marketplaceCatalogInFlight = pending;
    return pending;
  }
  async function fetchMarketplaceCatalog() {
    const answer = await tryCall("listMarketplace", {});
    if (answer == null) return null;
    marketplaceCatalogCache = {
      plugins: Array.isArray(answer.plugins) ? answer.plugins : [],
      bots: Array.isArray(answer.bots) ? answer.bots : [],
      // The host serves categories as { plugins, bots } (source/shared/marketplace/catalog.ts) and
      // THAT SHAPE IS KEPT, which it was not before.
      //
      // MEASURED ON SCREEN, 2026-09-09: this line flattened the host's answer to its PLUGIN
      // categories alone, and the Bots tab -- which reads the same cached answer through this
      // adapter -- drew "Development", "Code review" and "Shell tools" as its chips. Bot categories
      // exist and are a different list ("From Titanbot team", "Engineering", "Sales"); the flatten
      // is the only reason nobody ever saw them. marketplace-bots.js has always accepted either
      // shape and prefers `.bots` when it is given one, so keeping the object is the whole fix, and
      // `categories.plugins` below is what the Plugins tab reads.
      //
      // A host older than the split answers a flat array, which is normalised into the same object
      // rather than passed through, so one shape reaches every reader.
      categories: Array.isArray(answer.categories)
        ? { plugins: answer.categories.map(String), bots: [] }
        : {
          plugins: (answer.categories?.plugins ?? []).map(String),
          bots: (answer.categories?.bots ?? []).map(String),
        },
    };
    return marketplaceCatalogCache;
  }

  // The catalog row for an id, out of the cache alone. Used where a caller has an id and needs the
  // row's declaration -- its credentials and their consumers -- and a network read would be a
  // second source of truth for something already on the page.
  const marketplaceItemFromCache = (id) => (marketplaceCatalogCache?.plugins ?? [])
    .find((item) => String(item?.id ?? "") === String(id ?? "")) ?? null;

  // Which card on this page a catalog plugin is: a connector is its entry's name in
  // connectors.json (the catalog's own id, unless it carries a connectorName of its own), a shell
  // tool is the shell-tool id its `install` names.
  const marketplaceConnectorName = (item) => String(item?.connectorName ?? item?.id ?? "");
  const marketplaceShellToolId = (item) => String(typeof item?.install === "string" ? item.install : item?.shellToolId ?? item?.id ?? "");
  const marketplaceCardId = (item) => (item?.kind === "shell-tool"
    ? `shell:${marketplaceShellToolId(item)}`
    : `mcp:${marketplaceConnectorName(item)}`);

  // The contract's three states, derived from the cards this adapter already builds -- never from
  // a second read of the box:
  //   INSTALLED  the connector's name is in connectors.json (`removable` is this adapter's own
  //              word for exactly that), or the shell tool is installed in the box.
  //   NEEDS AUTH installed, and a credential field the entry declares has no stored value. The
  //              card carries both lists already: `secretFields` is what may hold a value and
  //              `storedFields` is what the host's 0600 store actually holds one for.
  //   READY      installed, nothing left to authenticate, and the box reports it connected.
  // Anything installed that is neither is CONNECTING: the box has the entry and has not finished
  // launching it, which is a real state and must not be painted as ready.
  // MARKET-6: a plugin can now install MORE THAN ONE THING. TinyFish is a connector and a CLI,
  // GitHub is a connector and a CLI, and folding them into one row was the point of MARKET-5 --
  // one page, one key box. So the state is computed per COMPONENT and then rolled up, rather than
  // per plugin: without the roll-up a folded plugin appears twice in the installed strip and its
  // page draws two of everything, which is exactly the complaint.
  //
  // A row that declares no components is one component, from its own kind and install, so a host
  // serving the older catalog shape lands in the same code with the same answers.
  const marketplaceComponents = (item) => {
    const declared = Array.isArray(item?.components) ? item.components : [];
    if (declared.length) {
      return declared.map((component) => ({
        kind: component?.kind === "shell-tool" ? "shell-tool" : "connector",
        connectorName: component?.kind === "shell-tool" ? "" : String(component?.connectorName ?? component?.name ?? marketplaceConnectorName(item)),
        shellToolId: component?.kind === "shell-tool" ? String(component?.shellToolId ?? component?.install ?? component?.id ?? "") : "",
        install: component?.install ?? null,
      }));
    }
    const kind = item?.kind === "shell-tool" ? "shell-tool" : "connector";
    return [{
      kind,
      connectorName: kind === "connector" ? marketplaceConnectorName(item) : "",
      shellToolId: kind === "shell-tool" ? marketplaceShellToolId(item) : "",
      install: item?.install ?? null,
    }];
  };
  const marketplaceComponentCardId = (component) => (component.kind === "shell-tool"
    ? `shell:${component.shellToolId}`
    : `mcp:${component.connectorName}`);

  function marketplaceInstallState(items, cards) {
    const byId = new Map((Array.isArray(cards) ? cards : []).map((card) => [card.id, card]));
    return (Array.isArray(items) ? items : []).map((item) => {
      const components = marketplaceComponents(item).map((component) => {
        const cardId = marketplaceComponentCardId(component);
        const card = byId.get(cardId) ?? null;
        const installed = card != null && (component.kind === "shell-tool"
          ? card.shellTool?.installed === true
          : card.removable === true);
        const stored = new Set(Array.isArray(card?.storedFields) ? card.storedFields.map(String) : []);
        const missing = (Array.isArray(card?.secretFields) ? card.secretFields.map(String) : []).filter((field) => !stored.has(field));
        const needsAuth = installed && missing.length > 0;
        const ready = installed && !needsAuth && (card?.boxStatus === "connected" || card?.status === "connected");
        return {
          ...component,
          cardId,
          installed,
          needsAuth,
          ready,
          missingCredentials: missing,
          storedCredentials: [...stored],
          // C's one plain sentence for whatever state the box reports, rendered verbatim. The
          // console must never parse a statusDetail: what it holds is a Node stack.
          statusSentence: typeof card?.statusSentence === "string" ? card.statusSentence : null,
          statusDetail: typeof card?.statusDetail === "string" ? card.statusDetail : null,
        };
      });
      // PROXY-7's shape, and only its shape: where the box carries this provider on its plan the
      // row comes back with no credential fields at all and the page draws no key box. Whether the
      // proxy actually carries it is the host's answer, not a guess made here.
      const includedWithPlan = item?.includedWithPlan === true;
      const connector = components.find((component) => component.kind === "connector") ?? null;
      // Installed means EVERY component this plugin installs is on the box: a page that said
      // "Added" with half of itself missing is what sent an operator looking for a tool that was
      // never installed. Needs auth and ready roll up the same way.
      const installed = components.length > 0 && components.every((component) => component.installed);
      const partly = components.some((component) => component.installed);
      const needsAuth = installed && components.some((component) => component.needsAuth);
      const ready = installed && !needsAuth && components.every((component) => component.ready);
      const missing = [...new Set(components.flatMap((component) => component.missingCredentials))];
      const storedCredentials = [...new Set(components.flatMap((component) => component.storedCredentials))];
      return {
        id: String(item?.id ?? ""),
        name: String(item?.name ?? item?.id ?? ""),
        // The plugin's own kind stays what it always was, so a caller that switches on it is
        // unchanged; `components` is the new, fuller answer beside it.
        kind: item?.kind === "shell-tool" ? "shell-tool" : "connector",
        connectorName: connector ? connector.connectorName : "",
        shellToolId: components.find((component) => component.kind === "shell-tool")?.shellToolId ?? "",
        // The card the installed strip draws this plugin ONCE under: its connector where it has
        // one, its shell tool otherwise.
        cardId: connector ? connector.cardId : (components[0]?.cardId ?? marketplaceCardId(item)),
        cardIds: components.map((component) => component.cardId),
        components,
        includedWithPlan,
        installed, needsAuth, ready,
        missingCredentials: includedWithPlan ? [] : missing,
        storedCredentials,
        label: includedWithPlan && !installed ? "Included with your plan"
          : !installed ? (partly ? "Half installed" : "Not installed")
          : needsAuth ? "Needs auth" : ready ? "Ready" : "Connecting",
      };
    });
  }

  // Subscriptions already authenticated on this Mac (docs/SUBSCRIPTIONS-CONTRACT.md), shown as
  // plugin cards. A key provider that is not yet adopted renders as "installed", which is the one
  // state the handoff app draws with a secure input; the value goes to the relay's 0600 store and
  // never through chat. Codex and MiniMax adopt from their CLI stores on a typed "adopt".
  const SUB_CATEGORY = { key: "Provider · paste a key", endpoint: "Provider · CLI login", runtime: "Provider · next contract", none: "Provider · not usable here" };

  // MODELS-1. The model picker for one provider card, and where its list came from.
  //
  // Two sources, never merged and never silently swapped. The LIVE list is what that provider
  // answered when the relay last probed it: ui/server.mjs's probe() fetches `<baseUrl>/models` on
  // every catalog row and puts the ids on `health.models`, and until this wave nothing read them.
  // The CURATED list is what ui/subscriptions.mjs ships for that provider, and it is the only
  // answer for a provider with no list to read -- Codex is transport "responses" and is never
  // probed at all. The card says which of the two it is showing, in one plain line, because "this
  // is what your provider says it has" and "this is the list we shipped" are different claims.
  //
  // The curated row is also where the FACTS about a model live: a context window we have actually
  // measured, and whether it takes an image. A live list is names and only names -- measured on
  // grok-bot-local-vm 2026-09-08, the Z.AI coding plan endpoint answers ten ids carrying id,
  // object, created and owned_by and nothing else -- so a live option is drawn with whatever the
  // curated row for the same id knows, and with nothing where there is no such row.
  function modelChoices(sub, catalog) {
    if (!sub || sub.endpointId == null) return null;
    const curated = (Array.isArray(sub.models) ? sub.models : []).map((row) => ({
      id: String(row?.id ?? ""), label: String(row?.label ?? row?.id ?? ""),
      contextWindow: Number.isFinite(row?.contextWindow) ? row.contextWindow : null,
      vision: row?.vision === true ? true : row?.vision === false ? false : null,
    })).filter((row) => row.id.length > 0);
    const catalogRow = (Array.isArray(catalog?.endpoints) ? catalog.endpoints : [])
      .find((row) => row?.id === sub.endpointId) ?? null;
    const health = catalogRow?.health ?? null;
    // Codex answers no model list and is reported as "verified on use" rather than probed, so it
    // has no live answer to prefer and must never be described as though it had one.
    const probed = catalogRow != null && catalogRow.transport !== "responses";
    const live = Array.isArray(health?.models) ? health.models.map(String).filter((id) => id.length > 0) : [];
    const factsFor = (id) => curated.find((row) => row.id === id) ?? null;
    const useLive = probed && live.length > 0;
    const options = useLive
      ? live.map((id) => ({ id, ...(factsFor(id) ?? { label: id, contextWindow: null, vision: null }) }))
      : curated;
    const current = String(sub.model ?? sub.defaultModel ?? "").trim();
    // The model the box is on is always in the list, even when the provider stopped listing it.
    // A picker that silently reads back a model the box is NOT running is the failure this whole
    // wave is about.
    const rows = current.length > 0 && !options.some((row) => row.id === current)
      ? [{ ...(factsFor(current) ?? { contextWindow: null, vision: null }), id: current, label: `${current} (in use)` }, ...options]
      : options;
    if (rows.length === 0) return null;
    const source = useLive ? "live" : "curated";
    const sourceNote = useLive
      ? `This is ${sub.name}'s own list, read when this page last checked the endpoint.`
      : !probed
        ? `${sub.name} publishes no model list, so this is the list we ship for it.`
        : `${sub.name}'s own list could not be read just now, so this is the list we ship for it.`;
    const chosen = rows.find((row) => row.id === current) ?? null;
    return {
      source, sourceNote, current, options: rows,
      // PROXY-10 in one sentence on the card. A text-only model is not a slower box, it is a box
      // that answers 400 on the first real turn, because Titan sends screenshots on most of them.
      warning: chosen?.vision === false
        ? "This one does not take screenshots. Titan sends them on most turns, so pick one that does if you can."
        : "",
    };
  }

  function subscriptionPlugins(rows, liveEndpointId, catalog) {
    return (Array.isArray(rows) ? rows : []).map((sub) => {
      const facts = [sub.identity, sub.expiresAt ? `expires ${new Date(sub.expiresAt).toLocaleDateString()}` : null, sub.note].filter(Boolean).join(" · ");
      const status = sub.adopted ? "connected" : sub.route === "key" || (sub.route === "endpoint" && sub.usable) ? "installed" : "available";
      return {
        id: `sub:${sub.id}`, name: sub.name, icon: sub.name[0].toUpperCase(),
        category: SUB_CATEGORY[sub.route] ?? "Subscription",
        description: `${facts ? `${facts}. ` : ""}${sub.posture}${sub.adopted ? " Adopted: the secret sits in the 0600 store on this Mac; pick the endpoint in a worker's model menu to use it." : ""}`,
        status, account: sub.identity ?? null,
        secretField: sub.route === "key" ? "API key" : sub.route === "endpoint" ? "Type adopt to confirm" : null,
        // Where the value actually goes. The form used to say the opposite of the truth.
        secretHint: sub.route === "key"
          ? "Stored by the relay in its 0600 store on this Mac and used as this endpoint's key. It never enters chat or model context."
          : "Nothing is read from this box: the relay copies the credential the provider's own CLI already stored on this Mac into its 0600 store. It never enters chat or model context.",
        group: "Providers", route: sub.route ?? null,
        endpointId: sub.endpointId ?? null, live: sub.endpointId != null && sub.endpointId === liveEndpointId,
        // MODELS-1: null on a card with no endpoint to point at, which is what the runtime and
        // not-usable providers are. The panel draws nothing for null rather than an empty picker.
        modelChoices: modelChoices(sub, catalog),
        // Only a card that can be adopted RIGHT NOW gets a button. A key card always can (the
        // form is the adoption). A CLI-login card can only when the provider's own CLI already
        // holds a usable login on this Mac for the relay to copy -- route alone is not enough:
        // MiniMax is route "endpoint" with no CLI login here, and clicking Connect on it opened
        // getListenerConnectUrl{platform:"sub:minimax"}, which does not error but answers with an
        // unrelated Cursor dashboard URL. A resolved lie is worse than a rejected one.
        connectable: sub.route === "key" || (sub.route === "endpoint" && sub.usable === true),
        connectedNote: "Adopted: the value sits in the relay's 0600 store on this Mac and is used as this endpoint's key. It never enters chat or model context.",
        connectNote: sub.route === "runtime"
          ? "Not adoptable here: this is a subscription runtime, not an API endpoint. Reaching it needs the OpenClaw 2.0 line in docs/SUBSCRIPTIONS-CONTRACT.md, not a connect flow."
          : sub.route === "endpoint"
            ? `Nothing to adopt yet: ${sub.name}'s own CLI holds no usable login on this Mac${sub.source ? ` (${sub.source})` : ""}, and this page never asks for the credential itself. Sign in with that CLI and the card turns into an adopt.`
            : "Not usable on this box: this provider exposes no endpoint this host can route to.",
        tools: [], toolsNote: "A provider is an inference endpoint, not a toolset. The tools an agent holds come from its own built-ins and from the Connectors below.",
        skills: [], skillsNote: null,
      };
    });
  }
  // PROXY-1. What a plan already includes, as cards of their own.
  //
  // These are NOT providers a customer connects, and the whole card is shaped by that: no secret
  // field, no Connect form, no account to name. There is nothing to paste, because the credential
  // behind them is minted per box by the control plane and never reaches a browser -- GET
  // /endpoints answers the literal word "included" where a key would be. What is left is a name, a
  // model, one plain line and one action.
  //
  // Dollars are deliberately absent. A customer sees what their plan includes in words; the money
  // is in the admin console and nowhere else.
  function includedUsageLine(row) {
    return row.enforced
      ? "Included with your plan. When you have used everything it includes this month, Titan will say so and you can add your own key."
      : "Included with your plan. There is no key to paste and nothing to set up.";
  }
  function includedPlugins(rows, liveEndpointId) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      // Prefixed so this card cannot collide with a connector or a subscription card, the same way
      // "sub:" and "mcp:" already keep those apart. The ENDPOINT id underneath stays bare, because
      // that is the string the relay resolves and the model menu carries.
      id: `plan:${row.id}`,
      name: row.name,
      icon: String(row.servedBy || row.name || "?").trim().charAt(0).toUpperCase() || "?",
      category: "Included with your plan",
      // The LABEL, never the routing alias. `plan-zai` is a string that exists so the proxy can
      // pick a pool; printing it here hands a customer a fact about our plumbing and calls it the
      // name of their model. Falls back to the model for a row the control plane sent no label
      // for, which is exactly what this line did before the label existed.
      description: `${row.modelLabel || row.model}${row.contextWindow ? ` · ${Math.round(row.contextWindow / 1000)}k context` : ""}. Part of what you already pay for.`,
      // "connected" is the state that draws the plain line and the switch, and it is the truthful
      // one: this is reachable right now with no action from anybody.
      status: "connected",
      account: "Included with your plan",
      // No secret field, no secretFields: pluginSecretsMarkup draws nothing, and a form promising a
      // credential nobody can supply is worse than no form.
      secretField: null, secretHint: null, secretFields: [],
      group: "Plan", route: null,
      endpointId: row.id, live: row.id === liveEndpointId,
      connectable: false,
      connectedNote: includedUsageLine(row),
      connectNote: null,
      health: row.health ?? null,
      tools: [], toolsNote: "A model is an inference endpoint, not a toolset. The tools an agent holds come from its own built-ins and from the Connectors below.",
      skills: [], skillsNote: null,
    }));
  }

  // Every endpoint in the catalog, adopted subscriptions included, as a model-menu entry. The
  // switch is box-wide; the app's per-worker menu is the only affordance it offers for it.
  function endpointModels(live, catalog) {
    const rows = Array.isArray(catalog?.endpoints) ? catalog.endpoints : [];
    // PROXY-1: the plan's rows belong in this menu too. They are computed by the relay per request
    // and are deliberately NOT in catalog.endpoints, so a menu built from that array alone showed a
    // box pointed at the plan as an unknown extra row wearing the model id -- two things on one
    // screen disagreeing about the same fact, which is what this function exists to stop.
    const included = Array.isArray(catalog?.included) ? catalog.included : [];
    // The same label rule as the plan card, and it matters more here: this entry's `name` is what
    // app.js prints on the always-visible agent context card and in the agent profile panel, so
    // `e.model` put "plan-zai" on the customer's screen without them opening Settings at all. A
    // catalog row carries no modelLabel and falls through to its own model, unchanged.
    const entry = (e, provider) => ({ id: e.id, name: `${e.name} · ${e.modelLabel || e.model}`, provider, context: e.contextWindow ? `${Math.round(e.contextWindow / 1000)}k` : "" });
    const available = [
      ...included.map((e) => entry(e, "plan")),
      ...rows.map((e) => entry(e, e.subscription ? "subscription" : e.baseUrl)),
    ];
    const current = [...included, ...rows].find((e) => e.baseUrl === catalog?.live?.baseUrl && e.model === catalog?.live?.model);
    if (live?.model && !current) available.unshift({ id: live.model, name: live.model, provider: live.endpoint ?? "box", context: "" });
    return { default: current?.id ?? live?.model ?? "default", available };
  }

  // Skills are the host's workflows: the "how" beside the routines' "when" (box-reference-docs.ts
  // describes them as name, description and instructions with a per-agent enable). A routine
  // created on the Routines panel is also listed by getAgentWorkflows, as source "automation";
  // it is left to that panel rather than drawn twice with two sets of controls.
  function skillsOf(list) {
    return (Array.isArray(list) ? list : []).filter((w) => w && w.source !== "automation").map((w) => ({
      id: w.id, name: w.name ?? w.id, description: w.description ?? "", body: w.body ?? "",
      enabled: w.isEnabledForAgent !== false,
      source: w.source ?? "workflow", sourceRef: w.sourceRef ?? null,
      // Ownership (shared/workflow-model.ts): null is a global skill, in every agent's library
      // the way every skill used to be; an agent id is a skill that agent wrote for itself and
      // that the host offers to nobody else. The host has already filtered the list, so an id
      // here is always the agent whose panel asked.
      ownerAgentId: typeof w.ownerAgentId === "string" && w.ownerAgentId ? w.ownerAgentId : null,
      // A skill imported with trigger frontmatter is also scheduled; the host fires it by agent
      // id through the automation runtime, which is the path runAgentWorkflowNow takes for it.
      scheduled: w.trigger != null, schedule: w.trigger?.schedule ?? null,
      // The schedule's own switch, separate from the per-agent enable: an edit must send it back
      // as it is, or saving a typo fix on a paused schedule re-arms it.
      triggerEnabled: w.trigger?.isEnabled !== false,
      scheduleDescription: w.scheduleDescription ?? null,
      lastRunAt: w.lastRunAt ?? null, helperScripts: Array.isArray(w.helperScripts) ? w.helperScripts : [],
    }));
  }

  // getAgentChannels answers { manifests: [{ platform }], connections: [{ platform, ... }] }: the
  // platforms a chat listener can bind to and the ones this agent holds a token for. A listener
  // card is global; this is the per-agent half of its state, read for the agent on screen.
  function channelsOf(answer) {
    const connections = Array.isArray(answer?.connections) ? answer.connections : [];
    const platforms = (Array.isArray(answer?.manifests) ? answer.manifests : []).map((m) => m?.platform).filter(Boolean);
    return platforms.map((platform) => {
      const live = connections.find((c) => c?.platform === platform) ?? null;
      return { platform, connected: live != null, detail: live ? String(live.name ?? live.workspace ?? live.channel ?? live.label ?? "") : "" };
    });
  }

  // The transcript is read as a bounded tail and grown backwards on demand, never as the whole
  // history on every refresh (GW-03). One window per agent: the entries on screen, oldest first,
  // and the host's cursor for the page before them. A refresh reads the tail again and splices it
  // over the window from the first entry both hold, so a page the operator scrolled up for stays
  // put while the newest entries (streaming text, a stamped verdict, a card's status) refresh.
  const TAIL_LIMIT = 150;
  const PAGE_LIMIT = 150;
  const windows = new Map();
  // The load selectContext started for an agent, by id, while it is in flight (see revealEntry).
  const loads = new Map();
  const cursorOf = (answer) => (Number.isFinite(answer?.nextBeforeSeq) ? answer.nextBeforeSeq : null);
  function mergeTail(held, answer) {
    const fresh = Array.isArray(answer?.entries) ? answer.entries : [];
    const reset = () => ({ entries: fresh, nextBeforeSeq: cursorOf(answer) });
    if (!held || fresh.length === 0) return held && fresh.length === 0 ? held : reset();
    const at = held.entries.findIndex((e) => e.id === fresh[0].id);
    // More new entries than one tail holds, or a rewritten history: nothing we hold lines up, so
    // the window starts over and the pages scrolled up for are gone with it.
    if (at < 0) return reset();
    // Spliced in place: the window keeps its identity across a refresh, so a page read that was
    // in flight while the tail refreshed lands on the window that is still on screen.
    held.entries = [...held.entries.slice(0, at), ...fresh];
    return held;
  }
  async function loadOlder(agentId) {
    const held = windows.get(agentId);
    if (!held || held.nextBeforeSeq == null) return { loaded: 0, more: false };
    const page = await call("getAgentTranscriptPage", { id: agentId, beforeSeq: held.nextBeforeSeq, untilMs: Date.now(), limit: PAGE_LIMIT });
    const older = Array.isArray(page?.entries) ? page.entries : [];
    // A heartbeat or stream refresh during the read splices the tail into this same object; only
    // a window that started over (nothing lined up) is a different one, and this page was read
    // for the cursor that window no longer has.
    const current = windows.get(agentId);
    if (current !== held) return { loaded: 0, more: current?.nextBeforeSeq != null };
    held.entries = [...older, ...held.entries];
    held.nextBeforeSeq = cursorOf(page);
    return { loaded: older.length, more: held.nextBeforeSeq != null };
  }

  // The outline is the model's whole turn state (1,500 items on a long-lived agent) and it only
  // moves when the transcript does, so it is refetched only when the transcript's tail changed.
  const outlineCache = new Map();
  function shapeWindow(agentId, name, outline) {
    const held = windows.get(agentId) ?? { entries: [], nextBeforeSeq: null };
    const partial = held.nextBeforeSeq != null;
    const latestAgentMs = held.entries
      .filter((e) => e.kind === "send-message")
      .reduce((n, e) => Math.max(n, Number(e.timestampMs) || 0), 0);
    return { messages: messagesOf(held.entries, name, outline, partial), latestAgentMs, files: filesOf(held.entries), hasOlder: partial };
  }
  // The token in a noVNC URL is the display number. The host names its own loopback in that URL
  // (127.0.0.1:6081), which is the viewer's machine through the relay and the bug VNC-2 closed, so
  // only the number is taken from it -- the frame URL is always built on the page's own origin.
  function displayOfVncUrl(url) {
    const s = String(url ?? "");
    const token = /token%3D(\d+)/i.exec(s)?.[1] ?? /token=(\d+)/i.exec(s)?.[1] ?? null;
    return token ? Number(token) : null;
  }

  // CONSOLE-4: how stale the outline may be while the agent is at work. An agent doing tool calls
  // writes NO transcript entry, so the tail signature below does not move and the cache answered
  // the same outline for the whole turn -- measured on grok-bot-local-vm, seven shell steps over
  // 48 s added zero rows and then all landed in one paint. That is a badge with nothing to move
  // in it. Five seconds is chosen against the two costs it sits between: the /events tick is
  // debounced at 900 ms, and the long-lived agent's outline is 1,578 items and 211 ms.
  const OUTLINE_WORKING_MAX_AGE_MS = 5000;
  async function loadContext(context, name, status) {
    const [tail, automations, workflows, channels, box] = await Promise.all([
      call("getAgentTranscriptTail", { id: context.id, limit: TAIL_LIMIT }).catch(() => null),
      call("getAgentAutomations", { id: context.id }).catch(() => null),
      call("getAgentWorkflows", { id: context.id }).catch(() => null),
      call("getAgentChannels", { id: context.id }).catch(() => null),
      // pendingHandoff reaches the gateway only as the `handoff` field decorateForeverBoxStatus
      // stamps on the box status (sand-host.ts). A room has no box of its own.
      context.kind === "worker" ? call("getForeverBoxStatus", { id: context.id }).catch(() => null) : Promise.resolve(null),
    ]);
    windows.set(context.id, mergeTail(windows.get(context.id), tail));
    const entries = windows.get(context.id).entries;
    const last = entries.at(-1);
    const sig = `${entries.length}:${last?.id ?? ""}:${last?.timestampMs ?? ""}`;
    const cached = outlineCache.get(context.id);
    // The cache is kept, not dropped: it is what stops a 1,578-item outline being re-read on every
    // 900 ms tick. It is only ignored while this agent is actually working, and then only once the
    // held copy is older than five seconds.
    const stale = status === "working" && Date.now() - (cached?.at ?? 0) > OUTLINE_WORKING_MAX_AGE_MS;
    let outline = cached?.sig === sig && !stale ? cached.outline : null;
    if (outline == null) {
      outline = await call("getConversationOutline", { id: context.id }).catch(() => null);
      outlineCache.set(context.id, { sig, outline, at: Date.now() });
    }
    return {
      ...shapeWindow(context.id, name, outline),
      routines: routinesOf(automations, context),
      skills: skillsOf(workflows),
      channels: channels == null ? null : channelsOf(channels),
      handoff: box?.handoff ?? null,
      boxState: box?.state ?? null,
      // HANDBACK-1: the display the thumbnail is read from. getForeverBoxStatus is already in
      // flight above, and its vncUrl carries the websockify token, which IS the display number.
      // ensureForeverBox would answer the same question and ALLOCATE a seat doing it (measured
      // 16,277 ms cold on grok-bot-local-vm), so a picture must never be what calls it.
      boxDisplay: displayOfVncUrl(box?.vncUrl),
      // HANDBACK-1 (fix): WHICH SEAT the agent actually works on, straight from the host's own
      // assignment map. vncUrl alone could not answer it -- an agent that has never had its screen
      // opened reports state absent with a null vncUrl while it is working on display :5, and the
      // console then drew display :1 and captioned it "<name>'s screen". `null` means the agent has
      // no seat of its own, which is the shared screen; `undefined` means this host does not send
      // the field and nothing here may guess.
      boxSeat: box == null || !("boxSeat" in box) ? undefined : (box.boxSeat ?? null),
    };
  }

  // COST-1. loadContext asks for workflows LEAN, so the list it hands over carries no skill bodies.
  // Nothing on the conversation screen draws one, but the skills panel's <pre> and its editor do,
  // and getSkills has already put them on the record. So a tick carries a held body forward rather
  // than blanking it: without this, the next repaint of an open panel -- a skill enabled, a learning
  // turn finishing -- would draw empty instructions under every skill name.
  function carrySkillBodies(held, fresh) {
    const bodies = new Map((held ?? []).filter((s) => s?.id != null && s.body).map((s) => [s.id, s.body]));
    if (bodies.size === 0) return fresh;
    return (fresh ?? []).map((skill) => (skill?.body ? skill : { ...skill, body: bodies.get(skill?.id) ?? skill?.body ?? "" }));
  }

  // What loadContext read, onto the roster record it was read for. The transcript window and its
  // outline are the adapter's; the record carries what the views draw.
  function applyLoaded(r, loaded) {
    r.messages = loaded.messages;
    r.files = loaded.files;
    r.hasOlder = loaded.hasOlder;
    r.skills = carrySkillBodies(r.skills, loaded.skills);
    if (loaded.channels != null) r.channels = loaded.channels;
    r.handoff = loaded.handoff;
    r.boxState = loaded.boxState;
    r.boxDisplay = loaded.boxDisplay ?? null;
    r.boxSeat = loaded.boxSeat;
  }
  // The part of a record that reloadActive compares to decide whether the app must redraw. Every
  // emit rebuilds the whole conversation, so this has to name everything the views show and
  // nothing that moves on its own.
  const recordSig = (r) => [
    r.messages?.length ?? 0, r.messages?.at?.(-1)?.id ?? "", r.messages?.at?.(-1)?.text?.length ?? 0,
    r.files?.length ?? 0, r.hasOlder ? 1 : 0,
    (r.skills ?? []).map((s) => `${s.id}:${s.enabled ? 1 : 0}:${s.name}`).join(","),
    (r.channels ?? []).map((c) => `${c.platform}:${c.connected ? 1 : 0}`).join(","),
    r.handoff?.requestId ?? "", r.boxState ?? "",
    // HANDBACK-1. requestId and boxState alone could not see a hand-off end: the pending-to-done
    // flip keeps the same requestId and changes a field INSIDE an existing message, and a host
    // restart with no live hand-off moves neither. So the instruction, the display the thumbnail
    // is read from, and a digest of every message's own hand-off state ride here too. Without the
    // last one the card never repaints and the person is left looking at Action needed on a step
    // they have already finished.
    r.handoff?.instruction ?? "", r.boxDisplay ?? "", r.boxSeat === undefined ? "?" : String(r.boxSeat),
    (r.messages ?? []).filter((m) => m.handoff).map((m) => `${m.handoff.requestId}:${m.handoff.resolution ?? ""}`).join(","),
    r.composer?.state ?? "", r.composer?.nonce ?? "",
  ].join("|");

  const DEFAULTS = {
    activeContext: null,
    openContexts: [],
    workers: [], rooms: [], routines: [], plugins: [],
    models: { default: "default", available: [] },
    settings: { autoReview: { enabled: false, allow: [], block: [] }, localToolPermission: null, reachable: false },
    // desktop.timeline used to carry four hardcoded steps describing a run nobody started.
    // renderDesktop builds an honest list from real state now.
    desktop: { paused: false, timeline: [] },
    teaching: { active: false, workerId: null, startedAt: null },
    // countAgents is the host's on-disk count, the number its 50-agent cap is measured against;
    // null until read. search.enabled is isGlobalSearchEnabled, consulted once at boot (GW-14).
    agentCount: null,
    search: { enabled: false },
  };

  // The host's avatar, by URL, versioned. listAgents carries avatarVersion (null while the agent
  // has none) and the gateway serves GET /avatars/<id>?v=<version> for exactly that version,
  // immutable-cached, which the relay proxies. The old comment here said /avatars/<id> 404s: it
  // does, for an agent with no avatar, which was every agent on this box until one was uploaded.
  // The vendored SVGs stay as the placeholder, hashed from the id so a face is stable.
  //
  // Measured 2026-09-03 on this box: listAgents answers avatarVersion null for an agent whose
  // avatar setAgentAvatarBytes just stored, while getAgentAvatar { id } answers { version,
  // dataUrl } and GET /avatars/<id>?v=<version> serves it. So the version is taken from
  // listAgents when it carries one and from getAgentAvatar otherwise (once at boot, and after a
  // write), and a version once known is kept across ticks rather than reset by a null.
  const avatarUrl = (id, version) => `/avatars/${encodeURIComponent(id)}?v=${encodeURIComponent(String(version))}`;
  const avatarOf = (a, version) => (version != null ? avatarUrl(a.id, version) : pick(AVATARS, a.id));
  const avatarVersionOf = (id) => call("getAgentAvatar", { id }).then((answer) => answer?.version ?? null).catch(() => null);

  // COST-1. getAgentAvatar answers { version, dataUrl }: the WHOLE avatar, to learn a 16-character
  // string. MEASURED on grok-bot-local-vm at 390x844, 2026-09-09, with CDP capture: ten agents, ten
  // calls, 91.9 KiB of /api -- 37% of the whole first-paint budget -- and then the roster's own <img>
  // downloads the same five faces again off /avatars/<id>?v=<version>. Nothing was remembered across
  // reloads either, because listAgents answers avatarVersion null for every agent on this box
  // (buildSummary is called without readAvatar), so every boot paid it again.
  //
  // TWO CHANGES, AND NEITHER OF THEM MOVES A BYTE INTO ANOTHER BUCKET.
  //
  //   A version once learned is remembered, per browser, in localStorage. A remembered NULL is an
  //   answer too: five of the ten agents have no avatar, and "asked, there is none" is worth keeping.
  //
  //   A version NOT yet known is not learned before first paint. The roster draws the placeholder
  //   face -- the designed state for an agent with no version, not a broken image -- and the versions
  //   are learned a beat later, off the critical path, after which the real faces appear and are
  //   remembered for every later boot. A person waiting to read a conversation is not waiting on ten
  //   base64 avatars.
  //
  // AND A REMEMBERED VERSION IS CHECKED, because a stale one is a 404 and a 404 IS a broken face in
  // the roster. The check costs NOTHING: it reads the picture the page has already drawn. An <img>
  // whose src is that avatar URL and which has finished loading with naturalWidth 0 is the browser
  // itself reporting that the version is gone -- which is better evidence than a second request, and
  // the second request was the first draft of this. That draft downloaded every remembered face a
  // second time on every warm boot (relayAvatar answers no-store today, so nothing was shared with
  // the picture at all), which is 70 KiB spent to protect against a version that only moves when
  // somebody uploads a new avatar on another surface. No image on the page means no broken image to
  // fix, so nothing is checked and nothing is spent. Measured against the gateway: ?v=<right> answers
  // 200 immutable and ?v=<wrong> answers 404.
  const AVATAR_MEMO_KEY = "titanbot.avatarVersions";
  const avatarMemo = (() => {
    try {
      const held = JSON.parse(global.localStorage?.getItem?.(AVATAR_MEMO_KEY) ?? "null");
      return held != null && typeof held === "object" && !Array.isArray(held) ? held : {};
    } catch { return {}; }
  })();
  const writeAvatarMemo = () => {
    try { global.localStorage?.setItem?.(AVATAR_MEMO_KEY, JSON.stringify(avatarMemo)); } catch { /* a private window, or storage off */ }
  };
  // Ids whose version came out of the memo (check it) and ids whose version nobody knows yet (learn
  // it). Both are settled after first paint, in one pass, by settleAvatars.
  const avatarsTrusted = new Set();
  const avatarsUnknown = new Set();
  function rememberAvatarVersion(id, version) {
    avatarMemo[id] = version ?? null;
    writeAvatarMemo();
  }
  // The page's own picture for that avatar URL: true when the browser finished loading it and got
  // nothing, which is a 404 behind the version. Anything else -- still loading, loaded fine, no such
  // image drawn -- is not evidence of a stale version and is left alone.
  function pictureIsBroken(url) {
    try {
      const images = [...(global.document?.querySelectorAll?.("img") ?? [])].filter((img) => String(img.getAttribute?.("src") ?? "") === url);
      return images.length > 0 && images.every((img) => img.complete === true && Number(img.naturalWidth) === 0);
    } catch { return false; }
  }
  async function settleAvatars(onSettled) {
    const trusted = [...avatarsTrusted];
    const unknown = [...avatarsUnknown];
    avatarsTrusted.clear();
    avatarsUnknown.clear();
    for (const id of trusted) {
      const version = avatarMemo[id];
      if (version == null) continue;
      if (!pictureIsBroken(avatarUrl(id, version))) continue;
      delete avatarMemo[id];
      writeAvatarMemo();
      const corrected = await avatarVersionOf(id);
      rememberAvatarVersion(id, corrected);
      onSettled(id, corrected);
    }
    for (const id of unknown) {
      const learned = await avatarVersionOf(id);
      rememberAvatarVersion(id, learned);
      // null is worth reporting too: it replaces "not asked yet" with "asked, there is none", which
      // is what stops the next boot asking again.
      if (learned != null) onSettled(id, learned);
    }
  }
  // The identity fields a roster record carries from listAgents, refreshed on every tick so a
  // rename, an avatar or a hide made from any surface shows here (GW-01). `known` is the version
  // already held for this agent, kept when the row carries none.
  function identityOf(a, known = null) {
    const version = a.avatarVersion ?? known ?? null;
    return {
      name: a.name ?? "Untitled",
      // The host's own per-agent role field. Empty is the honest answer when it is unset -- the
      // views hide the row rather than printing the literal words "not set" as if it were one.
      role: (typeof a.title === "string" && a.title.trim()) || (a.isGroup ? "Group chat" : ""),
      // updateAgent takes the whole profile and trims name and description, so both have to be
      // carried here or a role edit would blank the description the host already holds.
      description: typeof a.description === "string" ? a.description : "",
      avatar: avatarOf(a, version),
      avatarVersion: version,
      // AVATAR-1: the profile field the console's crew choice lives in. Read on every tick like
      // the rest of the identity, so a pick made on another surface shows here on the next one.
      // Anything without the `titan:` prefix belongs to the desktop app's avatar editor and
      // mascot-crew.js leaves it alone.
      avatarShape: typeof a.avatarShape === "string" ? a.avatarShape : null,
      notify: a.notifyOnUpdatesEnabled !== false,
      hidden: a.isHiddenFromSidebar === true,
    };
  }

  // ---- PUSH-1's deep link ------------------------------------------------------------------------
  //
  // The shells open titaniumbot://card?tenant=&agent=&entry=&kind= with the https fallback
  // /?agent=<id>&entry=<id>, and this is the https half: the query names a conversation and, often, an
  // entry inside it. docs/APPS.md is the contract; openPaletteHit in app.js is the working precedent
  // for the select-then-reveal pair.
  //
  // The parse is deliberately forgiving and the landing is deliberately quiet. An id for an agent
  // this workspace does not have is ignored rather than reported: a push for a deleted agent, or a
  // link opened against the wrong workspace, must land on the console and not on an error. Two card
  // kinds expire in ten minutes, so an entry the host has already stamped expired lands as a plain
  // "this one timed out" rather than a dead Approve button -- which is the transcript's own doing, not
  // something to special-case here.
  function deepLinkQuery() {
    try {
      const params = new URLSearchParams(String(global.location?.search ?? ""));
      const agent = String(params.get("agent") ?? "").trim();
      const entry = String(params.get("entry") ?? "").trim();
      return { agent: agent.length > 0 ? agent : null, entry: entry.length > 0 ? entry : null };
    } catch { return { agent: null, entry: null }; }
  }
  function deepLinkContext(workers, rooms) {
    const { agent } = deepLinkQuery();
    if (agent == null) return null;
    if ((workers ?? []).some((w) => w.id === agent)) return { kind: "worker", id: agent };
    if ((rooms ?? []).some((r) => r.id === agent)) return { kind: "room", id: agent };
    return null;
  }
  // The query is cleared once it has been acted on, so a reload (or a pull-to-refresh on a phone) does
  // not re-navigate away from wherever the person has since gone.
  function clearDeepLinkQuery() {
    try {
      const url = new global.URL(global.location.href);
      if (!url.searchParams.has("agent") && !url.searchParams.has("entry")) return;
      url.searchParams.delete("agent");
      url.searchParams.delete("entry");
      global.history?.replaceState?.(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch { /* no history API: the query simply stays in the bar */ }
  }

  async function hydrate(seed) {
    const [agents, integrations, subscriptions, catalog, agentCount, searchEnabled, hostStatus] = await Promise.all([
      call("listAgents"),
      call("getListenerIntegrations").catch(() => null),
      relayFetch("/subscriptions").then((r) => r.json()).then((b) => b.subscriptions).catch(() => null),
      relayFetch("/endpoints").then((r) => r.json()).catch(() => null),
      call("countAgents").catch(() => null),
      call("isGlobalSearchEnabled").catch(() => false),
      call("getHostStatus").catch(() => null),
    ]);
    // The acceptance ledger is a host capability ("sendAcceptanceV1", host-gateway-api.ts). A host
    // that lists its capabilities without it keeps no ledger, and "no record" there is not a
    // refusal. A host that did not answer is assumed to run one, as this box does.
    const capabilities = Array.isArray(hostStatus?.capabilities) ? hostStatus.capabilities : null;
    const host = { sendAcceptance: capabilities == null ? true : capabilities.includes("sendAcceptanceV1") };

    // Ask the box what it is actually running before stamping any worker with a model name. This
    // used to happen after shape(), so workers wore the seed's default while the picker showed the
    // truth -- two numbers on one screen disagreeing about the same fact.
    let models = seed.models;
    try {
      const live = await (await relayFetch("/model")).json();
      if (live?.model) models = endpointModels(live, catalog);
    } catch { /* the model probe is a convenience, not a dependency */ }

    // One getAgentAvatar per agent whose row carries no version and whose version the previous
    // hydrate did not learn (see avatarOf). That answer is the whole avatar as a data URL, up to
    // the 2 MB this UI accepts, so it is asked once per agent, not once per hydrate: listAgents on
    // this box answers avatarVersion null for every agent (buildSummary is called without
    // readAvatar), so without the carry-over every hydrate moved every avatar to learn a string.
    // A boot is a hydrate with no roster to carry: DEFAULTS holds empty arrays and a rebuild does not.
    // That is the whole difference between "somebody is staring at an empty screen" and "the console is
    // already up", and it is what decides whether an unknown avatar version waits.
    const coldBoot = (seed.workers ?? []).length === 0 && (seed.rooms ?? []).length === 0;
    const knownVersions = new Map([...(seed.workers ?? []), ...(seed.rooms ?? [])].filter((r) => r?.avatarVersion != null).map((r) => [r.id, r.avatarVersion]));
    const versions = new Map(await Promise.all(agents.map(async (a) => {
      if (a.avatarVersion != null) return [a.id, a.avatarVersion];
      const held = knownVersions.get(a.id);
      if (held != null) return [a.id, held];
      // COST-1: what a previous page load already learned, verified after first paint rather than
      // before it. `null` in the memo is an answer ("this agent has no avatar"), not a miss, so the
      // `in` check is the one that has to be made here.
      if (a.id in avatarMemo) { avatarsTrusted.add(a.id); return [a.id, avatarMemo[a.id]]; }
      // Nobody knows this one yet. On a COLD boot it is not learned here: ten getAgentAvatar answers
      // are 91.9 KiB of base64 on the one path a person is waiting on with nothing on screen. The
      // placeholder draws, settleAvatars learns the version once the page is up, and every later boot
      // reads it out of localStorage.
      //
      // On a REBUILD -- a duplicate, a delete, an agent minted on another surface, all of which arrive
      // as a hydrate carrying the roster that is already drawn -- it IS learned inline. Nobody is
      // waiting on a blank screen then, and a duplicated agent wearing the placeholder until the next
      // reload is a worse answer than one more read.
      if (!coldBoot) return [a.id, await avatarVersionOf(a.id).then((learned) => { rememberAvatarVersion(a.id, learned); return learned; })];
      avatarsUnknown.add(a.id);
      return [a.id, null];
    })));
    const shape = (a) => ({
      id: a.id,
      // AVATAR-1: who was here first. The crew is handed out in creation order, so the roster
      // carries the host's own createdAt rather than the order listAgents happened to answer in.
      createdAt: Number(a.createdAt) || null,
      isGroup: a.isGroup === true,
      ...identityOf(a, versions.get(a.id) ?? null),
      ...statusOf(a),
      accent: pick(ACCENTS, a.id),
      model: models?.default ?? "default",
      files: [],
      // The screen an agent gets is a real fact, but only ensureForeverBox knows it and asking
      // for every agent at boot would allocate a display each. The panel fills this in when it
      // opens; until then it says it is asking rather than rendering a bold label over nothing.
      browser: { label: `${a.name} desktop`, screen: "" },
      messages: [],
      // Filled by loadContext for the context on screen: the agent's skills, the chat platforms
      // it holds a token for, the box's pending hand-off, and whether the transcript window has
      // older entries the host can page in. Null channels means "not read yet", not "none".
      skills: [], channels: null, handoff: null, boxState: null, boxDisplay: null, boxSeat: undefined, hasOlder: false,
      // The composer's last send, as the host's acceptance ledger reports it.
      composer: null,
      lastActivityAt: a.lastActivityAt ?? 0,
      unread: Number(a.unreadCount) || 0,
      preview: typeof a.lastMessagePreview === "string" ? a.lastMessagePreview : "",
    });

    const workers = agents.filter((a) => !a.isGroup).map(shape);
    const rooms = agents.filter((a) => a.isGroup).map((a) => ({
      ...shape(a), memberIds: a.memberIds ?? [], accent: pick(ACCENTS, a.id),
    }));

    // Newest activity first: whoever spoke last is who you most likely came here for.
    const byRecent = (a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    workers.sort(byRecent); rooms.sort(byRecent);

    const connectors = await connectorPlugins().catch(() => []);

    const first = workers[0] ?? rooms[0];
    if (!first) return { ...seed, host, workers: [], rooms: [], routines: [], plugins: [...connectors, ...pluginsOf(integrations)], openContexts: [], agentCount: Number.isFinite(Number(agentCount)) && agentCount !== null ? Number(agentCount) : null, search: { enabled: searchEnabled === true } };

    // A rebuild (a duplicate, a delete, a plugin disconnect) keeps the conversation on screen and
    // the open tabs, as long as those agents still exist; only a context that is gone, or a
    // first boot, lands on the most recent worker.
    const exists = (c) => c && (c.kind === "worker" ? workers : rooms).some((r) => r.id === c.id);
    const kept = exists(seed.activeContext) ? { kind: seed.activeContext.kind, id: seed.activeContext.id } : null;
    // PUSH-1's deep link, honoured HERE and not after the fact. A tap on a notification opens
    // /?agent=<id>&entry=<id>; selecting afterwards would load a conversation the person never asked
    // for and then load theirs -- measured on the 1,578-item agent, a second context load is another
    // 120 KiB of /api on the one screen that is meant to be cheap. `asked` wins over the kept
    // context because the person has just said which conversation they want.
    const asked = deepLinkContext(workers, rooms);
    const active = asked ?? kept ?? { kind: workers[0] ? "worker" : "room", id: first.id };
    const activeRecord = (active.kind === "worker" ? workers : rooms).find((r) => r.id === active.id);
    const openContexts = (seed.openContexts ?? []).filter(exists).map((c) => ({ kind: c.kind, id: c.id }));
    if (!openContexts.some((c) => c.kind === active.kind && c.id === active.id)) openContexts.push(active);
    const loaded = await loadContext(active, activeRecord.name, activeRecord.status);
    applyLoaded(activeRecord, loaded);

    // One call covers every agent. Fetching per-context left every other row showing zero
    // routines and no next run, which reads as "nothing scheduled" rather than "not loaded".
    const everyAutomation = await call("listAllAutomations").catch(() => null);
    const teaching = await call("getTeachRecordingStatus").catch(() => null);
    const hostSettings = await call("getHostSettings").catch(() => null);

    return {
      ...seed,
      teaching: teaching?.state === "recording"
        ? { active: true, workerId: teaching.agentId, startedAt: teaching.startedAtMs, maxDurationMs: teaching.maxDurationMs }
        : seed.teaching,
      // The policy the host is actually enforcing, not a sentence in the seed. isEnabled, the two
      // instruction lists and the tool-permission mode are all real fields it reads.
      settings: {
        autoReview: {
          enabled: hostSettings?.autoReviewInstructions?.isEnabled ?? false,
          allow: hostSettings?.autoReviewInstructions?.allowInstructions ?? [],
          block: hostSettings?.autoReviewInstructions?.blockInstructions ?? [],
        },
        localToolPermission: hostSettings?.localToolPermission ?? null,
        reachable: hostSettings != null,
      },
      host,
      activeContext: active,
      openContexts,
      workers, rooms,
      agentCount: Number.isFinite(Number(agentCount)) && agentCount !== null ? Number(agentCount) : null,
      search: { enabled: searchEnabled === true },
      routines: Array.isArray(everyAutomation) && everyAutomation.length
        ? everyAutomation.flatMap((entry) => {
            const owner = agents.find((a) => a.id === entry.agentId);
            if (!owner) return [];
            return routinesOf([entry.automation], { kind: owner.isGroup ? "room" : "worker", id: owner.id });
          })
        : loaded.routines,
      // The plan first, because it is what most customers answer through and the one group that
      // needs nothing done to it; then the providers a user connects, the box's own connectors, and
      // the chat listeners the host reports.
      plugins: [...includedPlugins(catalog?.included, models.default), ...subscriptionPlugins(subscriptions, models.default, catalog), ...connectors, ...pluginsOf(integrations)],
      models,
    };
  }

  function createGatewayAdapter(state) {
    const listeners = new Set();
    // Set by reloadRoster when a status, unread count or preview moved; reloadActive emits on it
    // even when the transcript did not change.
    let rosterChanged = false;
    // QOL-NEEDS-YOU adds needsYou: an agent already showing "attention" for a failed turn and
    // then blocked on the operator moves nothing else in this signature, and the pill would not
    // have been drawn until something unrelated changed.
    // BOX-6b adds needsRepair for the same reason: the host clearing or raising the repair state
    // moves nothing else in this signature, so the pill would not be drawn or dropped until
    // something unrelated changed.
    const rosterSig = () => [...state.workers, ...state.rooms].map((x) => `${x.id}:${x.status}:${x.needsYou ? 1 : 0}:${x.needsRepair ? 1 : 0}:${x.unread}:${x.preview}:${x.name}:${x.role}:${x.avatar}:${x.avatarShape ?? ""}:${x.hidden ? 1 : 0}:${x.notify ? 1 : 0}`).join("|") + `|${state.agentCount}`;
    // app.js drives the "working" bubble from simulateReply's 1.15s timer, which is right for a
    // demo and wrong for a machine: a real reply takes tens of seconds, so the dots flashed and
    // died and the wait happened in silence. The adapter owns that bubble's lifetime instead --
    // it lives from send until the worker actually speaks. Capped, so it can never spin forever
    // on a turn that died.
    const awaiting = new Map();
    const AWAIT_CAP_MS = 5 * 60_000;
    // Attachment reads, by path (GW-09): a transcript rebuild re-asks for every file on screen.
    const attachmentReads = new Map();
    const keyOf = (c) => `${c.kind}:${c.id}`;
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const same = (a, b) => Boolean(a && b && a.kind === b.kind && a.id === b.id);
    // After a create, the new agent is the conversation on screen (hydrate keeps the previous one).
    const landOn = async (id, kind) => {
      const r = id ? (kind === "worker" ? state.workers : state.rooms).find((x) => x.id === id) : null;
      if (!r) return;
      state.activeContext = { kind, id };
      if (!state.openContexts.some((c) => same(c, state.activeContext))) state.openContexts.push({ kind, id });
      const loaded = await loadContext(state.activeContext, r.name, r.status).catch(() => null);
      if (loaded) { applyLoaded(r, loaded); applyAwaiting(state.activeContext, r, loaded.latestAgentMs); }
    };
    const record = (c) => (c.kind === "worker" ? state.workers : state.rooms).find((r) => r.id === c.id);

    function emit(type, detail) {
      const event = { type, detail: clone(detail || {}), snapshot: clone(state) };
      listeners.forEach((l) => l(event));
      return event.snapshot;
    }

    // Anything the gateway cannot do yet surfaces as a message in the active transcript rather
    // than as a silent no-op, so an unwired control is visible instead of merely inert.
    function notWired(what) {
      const r = record(state.activeContext);
      if (r) r.messages.push({
        id: `unwired-${Date.now()}`, authorId: "system", authorName: "Machine Room",
        type: "system", text: `${what} is not wired to the gateway yet.`, time: timeOf(Date.now()),
      });
      return emit("message:created", { context: state.activeContext });
    }
    // A wired command the host refused or that never answered. Wave B routed these through
    // notWired, which stamped "is not wired to the gateway yet" on a real failure -- the row
    // then claimed the opposite of what had happened.
    function failed(what) {
      const r = record(state.activeContext);
      if (r) r.messages.push({
        id: `failed-${Date.now()}`, authorId: "system", authorName: "Machine Room",
        type: "system", text: what, time: timeOf(Date.now()),
      });
      return emit("message:created", { context: state.activeContext });
    }

    // After an adoption or an endpoint switch: re-read the scan and the catalog, redraw.
    async function refreshSubscriptions() {
      const [subscriptions, catalog, live] = await Promise.all([
        relayFetch("/subscriptions").then((r) => r.json()).then((b) => b.subscriptions).catch(() => null),
        relayFetch("/endpoints").then((r) => r.json()).catch(() => null),
        relayFetch("/model").then((r) => r.json()).catch(() => null),
      ]);
      if (live?.model) state.models = endpointModels(live, catalog);
      state.plugins = [
        ...includedPlugins(catalog?.included, state.models.default),
        ...subscriptionPlugins(subscriptions, state.models.default, catalog),
        ...state.plugins.filter((p) => !String(p.id).startsWith("sub:") && !String(p.id).startsWith("plan:")),
      ];
      for (const w of state.workers) w.model = state.models.default;
      // "plugin:" is the prefix the app redraws its panels for; anything else only refreshes the transcript.
      emit("plugin:state", {});
    }

    // CONNECT-2. A server the box has only just started is reported as initializing, and the
    // Plugins panel is drawn from state.plugins with no fetch of its own -- the 15 s heartbeat
    // refreshes trays, roster, model and transcript, never the connector cards. So a card built
    // in that window would say "initializing, 0 tool(s)" for the life of the page. Poll the cheap
    // installed list until the statuses it reports differ from the ones on the cards, then
    // rebuild the cards from it.
    const CONNECTOR_SETTLE_INTERVAL_MS = 1500, CONNECTOR_SETTLE_CAP_MS = 30000;
    let connectorSettleGeneration = 0;
    const stillConnecting = (plugin) => plugin.boxStatus === "initializing" || plugin.boxStatus === "loading";
    const connectorSignature = (rows) => rows.map((row) => `${row?.name ?? row?.id ?? ""}:${row?.status ?? ""}`).sort().join(",");
    const cardSignature = (cards) => connectorSignature(cards.map((card) => ({ name: card.name, status: card.boxStatus })));
    // After a connectors.json write, a refreshMcp, or a per-tool toggle: rebuild only the
    // Connectors cards from the host and leave the Provider and Listener cards alone. The nav is
    // grouped by `group`, so their position in this array does not matter.
    async function refreshConnectors() {
      const generation = ++connectorSettleGeneration;
      const connectors = await connectorPlugins(failed).catch(() => []);
      state.plugins = [...state.plugins.filter((p) => !String(p.id).startsWith("mcp:") && !String(p.id).startsWith("shell:")), ...connectors];
      const emitted = emit("plugin:state", {});
      // Deliberately not awaited: the write that asked for this refresh answers the operator now,
      // and the card catches up by itself while the box finishes the connect.
      if (connectors.some(stillConnecting)) void settleConnectors(generation, cardSignature(connectors));
      return emitted;
    }
    async function settleConnectors(generation, drawn) {
      const deadline = Date.now() + CONNECTOR_SETTLE_CAP_MS;
      let seen = drawn;
      while (Date.now() < deadline && generation === connectorSettleGeneration) {
        await new Promise((resolve) => setTimeout(resolve, CONNECTOR_SETTLE_INTERVAL_MS));
        if (generation !== connectorSettleGeneration) return;
        const installed = await tryCall("listInstalledMcpServers", {}).catch(() => null);
        // Nothing cheap to settle on: this host has no installed list, so the cards came from the
        // read-only fallback and the only way to refresh them is to rebuild them all.
        if (!Array.isArray(installed) || installed.length === 0) return;
        const signature = connectorSignature(installed);
        if (signature === seen) continue;
        seen = signature;
        const connectors = await connectorPlugins(null).catch(() => []);
        if (generation !== connectorSettleGeneration) return;
        state.plugins = [...state.plugins.filter((p) => !String(p.id).startsWith("mcp:") && !String(p.id).startsWith("shell:")), ...connectors];
        emit("plugin:state", {});
        if (!connectors.some(stillConnecting)) return;
      }
    }

    // Re-hangs the working bubble after a rebuild, for as long as we are genuinely still waiting.
    function applyAwaiting(context, r, latestAgentMs) {
      const key = keyOf(context);
      const wait = awaiting.get(key);
      if (!wait) return;
      const answered = latestAgentMs > wait.sentAtMs;
      const expired = Date.now() - wait.sentAtMs > AWAIT_CAP_MS;
      if (answered || expired) {
        awaiting.delete(key);
        r.status = "ready";
        r.statusText = expired ? "No reply came back" : "Ready for the next task";
        return;
      }
      r.status = "working";
      r.statusText = "Working now";
      // QOL-NEEDS-YOU: this branch means a send of ours is still unanswered, so the operator is
      // not the one being waited on, whatever the roster row still says.
      r.needsYou = false; r.needsYouReason = "";
      r.messages.push({ id: wait.id, authorId: wait.authorId, authorName: wait.authorName, type: "working", text: "", time: "" });
    }

    async function reloadRoster() {
      const before = rosterSig();
      await reloadRosterInner();
      if (rosterSig() !== before) rosterChanged = true;
    }
    // An agent the list did not hold a moment ago (one the operator or another agent minted, on
    // any surface) or one that is gone. The per-field update below only touches records it already
    // has, so membership used to reach the count and never the sidebar until a browser reload.
    // hydrate rebuilds the roster the way first load and duplicateAgent do, keeping the active
    // and open contexts, so the stream event that announced the agent is what draws its card.
    const membershipMoved = (agents) => {
      // An empty answer is what a host gives while its roster is still loading; it is not a
      // roster with nobody on it, and blanking the sidebar on it would be worse than a stale card.
      if (agents.length === 0) return false;
      const seen = new Set(agents.map((a) => a.id));
      const held = [...state.workers, ...state.rooms].map((x) => x.id);
      return held.length !== seen.size || held.some((id) => !seen.has(id));
    };
    async function reloadRosterInner() {
      const [agents, count] = await Promise.all([call("listAgents").catch(() => null), call("countAgents").catch(() => null)]);
      if (Number.isFinite(Number(count)) && count !== null) state.agentCount = Number(count);
      if (!agents) return;
      if (membershipMoved(agents)) { state = await hydrate(state); rosterChanged = true; return; }
      for (const a of agents) {
        const target = (a.isGroup ? state.rooms : state.workers).find((x) => x.id === a.id);
        if (!target) continue;
        Object.assign(target, identityOf(a, target.avatarVersion ?? null));
        const next = statusOf(a);
        target.status = next.status;
        target.statusText = next.statusText;
        // QOL-NEEDS-YOU: carried on every tick like the status it sits beside, so the pill and the
        // count clear on the same heartbeat the host clears the badge.
        target.needsYou = next.needsYou;
        target.needsYouReason = next.needsYouReason;
        // BOX-6b: carried the same way, so a repair that worked drops the pill on the next
        // heartbeat rather than leaving a fixed agent wearing the badge until a browser reload.
        target.needsRepair = next.needsRepair;
        target.needsRepairReason = next.needsRepairReason;
        target.lastActivityAt = a.lastActivityAt ?? target.lastActivityAt;
        target.unread = Number(a.unreadCount) || 0;
        target.preview = typeof a.lastMessagePreview === "string" ? a.lastMessagePreview : target.preview;
        if (a.isGroup) target.memberIds = a.memberIds ?? target.memberIds;
      }
    }

    // A failed turn used to leave no trace in this UI at all: the transcript simply never grew.
    // The host records it as an error tray, so read those and say so in the conversation.
    const reportedTrays = new Set();

    /**
     * FEEDBACK-1. Seeds for the automatic offer, queued here and drained by the page.
     *
     * MEASURED on grok-bot-local-vm, 2026-09-09: a model-endpoint failure writes NO turn-failed
     * row. The host logged the failure in 3 s, the tray fired, both transcript reads returned
     * messages only, and the page showed the person's own bubble plus "Accepted by the host" for
     * thirty seconds with the roster card still green. An offer keyed on the turn-failed entry
     * would therefore never fire on the commonest failure there is. The tray is the only live
     * signal, so the offer is built at tray-narration time.
     *
     * The seed carries the tray's own words because the developers need them. They do NOT go into
     * the conversation: the raw provider wording ("Agent failed to respond, fetch failed") is
     * exactly the presentation host-notes-read-as-errors.md bans, and it was what this function
     * used to push. The person reads the technical half on the card, where it is editable and where
     * they are deciding whether to send it.
     */
    const failedTurnReports = [];
    async function reloadTrays() {
      const trays = await call("getTrays").catch(() => null);
      if (!Array.isArray(trays)) return;
      attentionIds.clear();
      for (const t of trays) if (t.kind === "error" && t.agentId) attentionIds.add(t.agentId);
      for (const tray of trays) {
        if (tray.kind !== "error" || reportedTrays.has(tray.id)) continue;
        reportedTrays.add(tray.id);
        const owner = state.workers.find((w) => w.id === tray.agentId)
          ?? state.rooms.find((r) => r.id === tray.agentId);
        if (!owner) continue;
        awaiting.delete(keyOf({ kind: owner.memberIds ? "room" : "worker", id: owner.id }));
        // Plain words, and the technical half kept off the page. The line this replaced read
        // "That turn failed: Agent failed to respond — fetch failed", which is the machine's own
        // spelling of a problem the person can do exactly one thing about.
        //
        // BOX-6b: one failure is not "ask again". A store that needs repair fails identically on
        // every retry, so that agent's line names the repair and where to press it instead. The
        // predicate is the shared one above; the seed carries the verdict so the card app.js keeps
        // says the same thing without re-deciding it.
        const needsRepair = transcriptRepairWordsSeen(tray.title, tray.detail) || owner.needsRepair === true;
        owner.messages.push({
          id: `tray-${tray.id}`, authorId: "system", authorName: "Machine Room", type: "system",
          text: needsRepair
            ? TRANSCRIPT_REPAIR_SENTENCE
            : `${owner.name || "This agent"} could not finish that one. Ask again, or send the details to the developers.`,
          time: timeOf(Date.now()),
        });
        // A repair is a thing the operator does here, not a thing the developers do elsewhere, so
        // the roster row wears the pill from this tick rather than waiting for the host's own flag
        // on the next heartbeat -- and it is remembered, because reloadRosterInner runs a moment
        // later and would otherwise paint the pill straight back off on a box whose bundle does
        // not carry the host's flag yet.
        if (needsRepair) { repairIds.add(owner.id); owner.needsRepair = true; }
        failedTurnReports.push({
          trayId: tray.id,
          agentId: owner.id,
          agentName: owner.name || "",
          title: String(tray.title ?? "error"),
          detail: String(tray.detail ?? ""),
          needsRepair,
          at: Date.now(),
        });
        // The dedupe set dies with the page; without this, every reload re-narrates every historical
        // failure as though it had just happened.
        void call("dismissTray", { id: tray.id }).catch(() => {});
      }
    }

    // Every routine write re-reads the agent's automations instead of patching the row in place.
    // The host recomputes nextRunAt and triggerDescription on write, and -- the reason this exists
    // -- it answers 200 to a write it then declines to store, so the read back is the only proof
    // anything happened.
    async function reloadRoutines(scope) {
      const list = await call("getAgentAutomations", { id: scope.id });
      const rows = Array.isArray(list) ? list : [];
      const shaped = routinesOf(rows, scope);
      state.routines = [...state.routines.filter((x) => !same(x.scope, scope)), ...shaped];
      return { rows, shaped };
    }

    // The box's endpoint can be switched from anywhere (settings, the operator page, a gate
    // script mid-run), so the model shown on a card is re-read on every tick from the cheap
    // /model route, and the catalog is re-read only when it actually moved.
    let liveModelKey = null;
    async function reloadLiveModel() {
      const live = await relayFetch("/model").then((r) => r.json()).catch(() => null);
      if (!live?.model) return;
      const key = `${live.endpoint ?? ""}|${live.model}`;
      if (key === liveModelKey) return;
      liveModelKey = key;
      await refreshSubscriptions();
    }
    // The routines of one context, as the routine cards draw them: identity, enabled state, the
    // countdown, and the last run's outcome. Named so a heartbeat can tell a moved list from a
    // repainted one.
    const routinesSig = (context) => state.routines
      .filter((x) => same(x.scope, context))
      .map((x) => `${x.id}:${x.status ?? ""}:${x.nextRunAt ?? ""}:${x.lastRun?.status ?? ""}:${x.lastRun?.at ?? ""}:${x.name ?? ""}`)
      .join(",");
    async function reloadActive() {
      // Trays first: reloadRoster stamps every status through statusOf, which needs the tray set
      // already current. The other order let the roster paint over attention on every tick.
      await reloadTrays();
      await reloadRoster();
      await reloadLiveModel();
      // What the roster read is worth on its own. The sidebar's status pills and the header's
      // countAgents number come from the reads above; the transcript read below is a different
      // conversation with the host and can fail by itself. It used to take the roster with it --
      // a tail read that threw left `rosterChanged` set and emitted nothing, so the page kept
      // rendering a count the host had already told it was wrong until some later tick happened
      // to succeed. The roster's own answer is published whatever the transcript read does.
      const publishRoster = () => { if (rosterChanged) { emit("message:created", { context: state.activeContext }); rosterChanged = false; } };
      const r = record(state.activeContext);
      if (!r) { publishRoster(); return; }
      let loaded;
      try { loaded = await loadContext(state.activeContext, r.name, r.status); }
      catch (error) { publishRoster(); throw error; }
      // Emit only when something the transcript shows actually changed. Every emit makes the app
      // rebuild the whole conversation, and an unconditional one on each stream event and each
      // 15 s tick is a visible flash on a long conversation.
      const before = recordSig(r);
      // AUTOMATION-3: the routines the host holds for this context are part of what the views show,
      // and the host writes them on its own (a scheduled run finishing, a run failing, a routine
      // filed by another client). The app renders the last snapshot it was handed, so a change here
      // that emits nothing is a card the operator never sees.
      const routinesBefore = routinesSig(state.activeContext);
      applyLoaded(r, loaded);
      applyAwaiting(state.activeContext, r, loaded.latestAgentMs);
      state.routines = [
        ...state.routines.filter((x) => !same(x.scope, state.activeContext)),
        ...loaded.routines,
      ];
      if (recordSig(r) !== before || rosterChanged || routinesSig(state.activeContext) !== routinesBefore) emit("message:created", { context: state.activeContext });
      rosterChanged = false;
    }

    // The host's send-acceptance ledger, asked by the nonce the send carried. sendPrompt answers
    // { accepted: true } unconditionally (host-gateway-api.ts), so this is the only honest source
    // for "the host took that message": a record marked accepted. The gateway returns once the
    // send is admitted, so one or two reads normally settle it; a few more cover a slow ledger.
    async function acceptanceOf(clientNonce) {
      let last = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        last = await call("promptAcceptanceStatus", { accountSlot: HOST_ACCOUNT_SLOT, clientNonce })
          .catch((error) => ({ outcome: "error", error: error.message }));
        const settled = last?.outcome === "found" ? last.record?.status !== "pending" : last?.outcome !== "not-found" || attempt > 0;
        if (settled) break;
        await new Promise((resolve) => global.setTimeout(resolve, 500));
      }
      return describeAcceptance(last);
    }

    // The gateway pushes; this adapter pulls what changed. Re-reading the active transcript on
    // every event is cheap next to a turn, and it means a reply from any surface shows up here.
    let pending = null;
    let events = null;

    // COST-1, the boot quiet window. MEASURED on grok-bot-local-vm at 390x844: hydrate resolves
    // around 1,200 ms, the first /events frame lands at about 1,560 ms, and the 900 ms debounce then
    // fires reloadActive at about 2,750 ms -- which re-runs the whole of loadContext 1.5 s after
    // hydrate already did it. That is the twelve duplicate /api pairs a boot capture shows. The
    // frames that arrive while the page is still painting are collapsed into one read after it has
    // settled; the read is DEFERRED, never dropped, because a dropped frame is a card the person
    // never sees. The digest protocol above is what makes the deferred read nearly free.
    const BOOT_QUIET_MS = 2000;
    const bootAt = Date.now();
    const debounceDelay = () => Math.max(900, BOOT_QUIET_MS - (Date.now() - bootAt));

    function openStream() {
      if (events != null) return;
      try {
        // A 401 on this stream is invisible: EventSource exposes no status, only onerror. That is
        // fine here because the heartbeat below calls the gateway every 15 seconds and relayFetch
        // bounces to /login the first time one of those comes back unauthenticated.
        events = new global.EventSource("/events");
        events.onmessage = (message) => {
          // JOBBUS-3: a job transition is not a conversation change, so it does not pay for a
          // transcript re-read. It refreshes the Job bus card and nothing else. docs/JOB-BUS.md §5
          // names the event `{type:"job-bus", jobId, status}`; every other envelope on this stream
          // carries its name on `channel` with the body under `payload`, so both are read rather
          // than betting the console on which one the host settled on.
          let envelope = null;
          try { envelope = JSON.parse(message?.data ?? "null"); } catch { /* a heartbeat or a partial frame */ }
          if (envelope != null && (envelope.type === "job-bus" || envelope.channel === "job-bus")) {
            const body = envelope.payload ?? envelope;
            emit("job-bus:changed", { jobId: body.jobId ?? null, status: body.status ?? null });
            return;
          }
          if (pending) return;
          pending = global.setTimeout(() => { pending = null; reloadActive().catch(() => {}); }, debounceDelay());
        };
      } catch { /* no stream: the UI still works, it just will not update on its own */ }
    }
    openStream();

    // Heartbeat. The stream is the fast path; this is what keeps status honest when nothing is
    // being said -- the same 15s cadence the old operator UI settled on.
    let heartbeat = global.setInterval(() => { void reloadActive().catch(() => {}); }, 15_000);

    // ---- COST-1: what a backgrounded page costs ---------------------------------------------------
    //
    // MEASURED on grok-bot-local-vm at 390x844: the console has exactly one visibilitychange handler
    // anywhere (screen-tile.js:425), and hiding the document changed NOTHING -- 44 requests and
    // 654.8 KiB in the next sixty seconds, the same as a visible page. On iOS the webview is suspended
    // the moment the app leaves the foreground, so every one of those is work nobody can see.
    //
    // Hidden or going away: the heartbeat stops, the debounce is cancelled, and the stream is closed.
    // Visible again: ONE catch-up read and a fresh stream, because an EventSource closed here will not
    // reconnect itself. No card is lost by any of this -- PUSH-1's trigger is a sweep on the RELAY, not
    // a timer in this page, which is the whole reason the relay owns it.
    // `suspended` and not "is the heartbeat null": a visibilitychange on a page that was never hidden
    // is a thing other code dispatches, and answering it with a catch-up read would make coming back
    // cost two reads every time instead of one.
    let suspended = false;
    const suspend = () => {
      suspended = true;
      if (heartbeat != null) { global.clearInterval(heartbeat); heartbeat = null; }
      if (pending != null) { global.clearTimeout(pending); pending = null; }
      if (events != null) { try { events.close?.(); } catch { /* already gone */ } events = null; }
    };
    const resume = () => {
      if (!suspended) return;
      suspended = false;
      if (heartbeat == null) heartbeat = global.setInterval(() => { void reloadActive().catch(() => {}); }, 15_000);
      openStream();
      void reloadActive().catch(() => {});
    };
    const onVisibility = () => {
      if (global.document?.visibilityState === "hidden") suspend();
      else resume();
    };
    global.document?.addEventListener?.("visibilitychange", onVisibility);
    global.addEventListener?.("pagehide", suspend);

    // PUSH-1's deep link, landed. hydrate has already made the asked-for conversation the active one,
    // so this only has to reveal the entry and clear the query. Deferred by a tick because app.js
    // subscribes AFTER it constructs this adapter, and an emit with no listeners is a reveal nobody
    // scrolls to.
    const api = {
      getSnapshot: () => clone(state),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      destroy() {
        listeners.clear();
        suspend();
        global.document?.removeEventListener?.("visibilitychange", onVisibility);
        global.removeEventListener?.("pagehide", suspend);
      },
      // The heartbeat's own body, callable: a test with a stub gateway drives a refresh through
      // it, and a view that just wrote something can ask for the read-back without waiting 15s.
      refresh: () => reloadActive(),

      // Older entries, one page before the window (GW-03). Resolves with how many came and whether
      // the host has more; emits its own event so the view can keep its scroll offset instead of
      // jumping to the bottom the way a new message does.
      loadOlderMessages(input) {
        const context = input && typeof input === "object" ? { kind: input.kind, id: input.id } : state.activeContext;
        const r = record(context);
        if (!r) return Promise.resolve({ loaded: 0, more: false });
        return loadOlder(context.id).then((page) => {
          applyLoaded(r, { ...shapeWindow(context.id, r.name, outlineCache.get(context.id)?.outline ?? null), skills: r.skills, channels: null, handoff: r.handoff, boxState: r.boxState, boxDisplay: r.boxDisplay });
          applyAwaiting(context, r, 0);
          emit("transcript:older", { context, loaded: page.loaded, more: page.more });
          return page;
        });
      },

      selectContext(input, maybeId) {
        const context = typeof input === "object" ? { kind: input.kind, id: input.id } : { kind: input, id: maybeId };
        const r = record(context);
        if (!r) return clone(state);
        state.activeContext = context;
        if (!state.openContexts.some((c) => same(c, context))) state.openContexts.push(context);
        const snapshot = emit("context:selected", { context });
        const load = loadContext(context, r.name, r.status).then(async (loaded) => {
          applyLoaded(r, loaded);
          applyAwaiting(context, r, loaded.latestAgentMs);
          state.routines = [...state.routines.filter((x) => !same(x.scope, context)), ...loaded.routines];
          emit("message:created", { context });
          // Reading a conversation is what marks it read. Nothing in this UI ever told the host
          // that, so a badge raised by a reply stayed up for the life of the box. setAgentUnread
          // rather than openAgent: it says only this, and does not switch the host's active agent
          // or kickstart a pending turn as a side effect of a click in the roster.
          if ((r.unread ?? 0) > 0) {
            await call("setAgentUnread", { id: context.id, isUnread: false }).catch(() => {});
            await reloadRoster();
            emit("message:created", { context });
          }
        }).catch(() => {});
        // Recorded so a reveal asked for right after the click waits for this read, rather than
        // guessing how long five parallel reads and the outline take on a long agent.
        loads.set(context.id, load);
        return snapshot;
      },

      // uploadAttachment { filename, bytesBase64, agentId } -> { path }. Note the lowercase
      // argument names; the gateway answers 200 to the wrong ones and stores nothing.
      uploadAttachment(agentId, filename, bytesBase64) {
        return call("uploadAttachment", { filename, bytesBase64, agentId }).then((answer) => {
          if (!answer?.path) throw new Error("the host stored no path for that file");
          return { path: answer.path, name: filename };
        });
      },

      sendMessage(input, text, attachments = []) {
        const context = typeof input === "object" ? { kind: input.kind, id: input.id } : state.activeContext;
        const clean = String(text || "").trim();
        const r = record(context);
        // A message carrying only files is still a message worth sending.
        if (!r || (!clean && attachments.length === 0)) return null;
        r.messages.push({
          id: `local-${Date.now()}`, authorId: "you", authorName: "You",
          type: "text", text: clean, time: timeOf(Date.now()),
        });
        r.status = "working"; r.statusText = "Working now";
        // QOL-NEEDS-YOU: the operator has just answered. The host clears its badge on accept
        // (send-acceptance.ts), but that is a tick away; drop the pill with the send.
        r.needsYou = false; r.needsYouReason = "";
        const wait = { sentAtMs: Date.now(), id: `working-${Date.now()}`, authorId: context.id, authorName: r.name };
        awaiting.set(keyOf(context), wait);
        r.messages.push({ id: wait.id, authorId: wait.authorId, authorName: wait.authorName, type: "working", text: "", time: "" });
        // The nonce is what makes the send answerable: the host's acceptance ledger records a
        // send only under its clientNonce, and promptAcceptanceStatus is keyed by it.
        const clientNonce = nonce();
        r.composer = { state: "sending", text: "Sending…", nonce: clientNonce, at: Date.now() };
        const snapshot = emit("message:created", { context });
        // Not the dots: those belong to the reply. This is the send itself failing to be taken.
        const refused = (text) => {
          awaiting.delete(keyOf(context));
          r.messages = r.messages.filter((m) => m.id !== wait.id);
          r.status = "attention";
          r.statusText = "The last message was not accepted";
          r.composer = { state: "not-accepted", text, nonce: clientNonce, at: Date.now() };
        };
        call("sendPrompt", {
          agentId: context.id,
          prompt: clean,
          clientNonce,
          ...(attachments.length
            ? { attachmentPaths: attachments.map((a) => a.path), attachmentNames: attachments.map((a) => a.name) }
            : {}),
        })
          // A host that advertises no acceptance ledger cannot be asked; the gateway's answer is
          // then the whole truth, and the row says exactly that much rather than "not accepted".
          .then(() => (state.host?.sendAcceptance === false
            ? { state: "sent", text: "Taken by the gateway (this host keeps no acceptance ledger)" }
            : acceptanceOf(clientNonce)))
          .then((acceptance) => {
            if (acceptance.state === "accepted" || acceptance.state === "sent") r.composer = { ...acceptance, nonce: clientNonce, at: Date.now() };
            else refused(acceptance.text);
            emit("message:created", { context });
            // The refresh runs after the verdict is on screen and fails on its own: a refresh that
            // fails cannot turn a send the host accepted into a "not accepted".
            return reloadActive().catch(() => {});
          }, (error) => {
            // We know it failed. Leaving the dots up for five minutes turns a known failure into
            // an apparent silence, which is the harder thing to diagnose. This is a send the host
            // refused or never answered, not a missing wire, so the row says exactly that.
            refused(`Not accepted — ${error.message}`);
            r.messages.push({
              id: `send-failed-${Date.now()}`, authorId: "system", authorName: "Machine Room",
              type: "system", text: `Sending failed: ${error.message}`, time: timeOf(Date.now()),
            });
            emit("message:created", { context });
          });
        return snapshot;
      },

      // -- Skills (GW-05): the nine workflow commands. Every write is read back through
      // getAgentWorkflows before it resolves, for the same reason the routine writes are: the
      // gateway answers 200 to a write the store then declines, and the list is the only proof.
      // COST-1: `full`, not lean. This is the one read whose answer's bodies are actually drawn --
      // the panel's <pre> and its editor -- and it happens when the panel opens, not on a tick.
      getSkills(agentId) {
        return call("getAgentWorkflows", { id: agentId }, { projection: "full" }).then((list) => {
          const skills = skillsOf(list);
          const target = state.workers.find((w) => w.id === agentId) ?? state.rooms.find((x) => x.id === agentId);
          if (target) target.skills = skills;
          return skills;
        });
      },
      // createAgentWorkflow { id, spec } with spec { name, description, body, trigger } -- the
      // WorkflowSpec shape in shared/workflow-model.ts. trigger null is a plain skill.
      createSkill(agentId, spec) {
        const wanted = String(spec?.name ?? "").replace(/[\r\n]+/g, " ").trim();
        if (!wanted || !String(spec?.body ?? "").trim()) return Promise.reject(new Error("a skill needs a name and instructions"));
        return call("createAgentWorkflow", { id: agentId, spec: { name: wanted, description: String(spec.description ?? "").trim(), body: String(spec.body).trim(), trigger: null } })
          .then(() => this.getSkills(agentId))
          .then((skills) => {
            const created = skills.find((s) => s.name === wanted.slice(0, 80));
            if (!created) throw new Error("the host took the request and stored no skill");
            emit("settings:skills", { agentId });
            return created;
          });
      },
      // updateAgentWorkflow { id, workflowId, spec }. The trigger the host already holds goes back
      // with the edit, or a scheduled skill would be unscheduled by a typo fix.
      updateSkill(agentId, workflowId, spec) {
        const current = (record({ kind: "worker", id: agentId })?.skills ?? []).find((s) => s.id === workflowId) ?? null;
        const wanted = String(spec?.name ?? "").replace(/[\r\n]+/g, " ").trim();
        const body = String(spec?.body ?? "").trim();
        if (!wanted || !body) return Promise.reject(new Error("a skill needs a name and instructions"));
        const trigger = current?.scheduled ? { schedule: current.schedule, isEnabled: current.triggerEnabled !== false } : null;
        return call("updateAgentWorkflow", { id: agentId, workflowId, spec: { name: wanted, description: String(spec.description ?? "").trim(), body, trigger } })
          .then(() => this.getSkills(agentId))
          .then((skills) => {
            const saved = skills.find((s) => s.id === workflowId);
            if (!saved) throw new Error("the host answered but that skill is gone");
            if (saved.body !== body || saved.name !== wanted.slice(0, 80)) throw new Error("the host answered and kept the old skill");
            emit("settings:skills", { agentId });
            return saved;
          });
      },
      // setAgentWorkflowOwner { id, workflowId, ownerAgentId }: null hands an owned skill to the
      // box. Read back through getAgentWorkflows like every other write, because the host answers
      // 200 to a change its store then declines (another agent's skill is refused outright).
      makeSkillGlobal(agentId, workflowId) {
        return call("setAgentWorkflowOwner", { id: agentId, workflowId, ownerAgentId: null })
          .then(() => this.getSkills(agentId))
          .then((skills) => {
            const saved = skills.find((s) => s.id === workflowId);
            if (!saved) throw new Error("the host answered but that skill is gone");
            if (saved.ownerAgentId != null) throw new Error("the host answered and kept the skill owned");
            emit("settings:skills", { agentId });
            return saved;
          });
      },
      setSkillEnabled(agentId, workflowId, isEnabled) {
        return call("setAgentWorkflowEnabled", { id: agentId, workflowId, isEnabled: Boolean(isEnabled) })
          .then(() => this.getSkills(agentId))
          .then((skills) => {
            const saved = skills.find((s) => s.id === workflowId);
            if (!saved || saved.enabled !== Boolean(isEnabled)) throw new Error(`the host did not ${isEnabled ? "enable" : "disable"} that skill`);
            emit("settings:skills", { agentId });
            return saved;
          });
      },
      // deleteAgentWorkflow { id, workflowId } removes the folder from the box's shared library
      // (workflow-store.ts GlobalWorkflowLibrary.remove): the skill is gone for every agent on the
      // box, not only the one whose panel asked. The copy on the control says so.
      deleteSkill(agentId, workflowId) {
        const name = (record({ kind: "worker", id: agentId })?.skills ?? []).find((s) => s.id === workflowId)?.name ?? workflowId;
        return call("deleteAgentWorkflow", { id: agentId, workflowId })
          .then(() => this.getSkills(agentId))
          .then((skills) => {
            if (skills.some((s) => s.id === workflowId)) throw new Error("the host answered but the skill is still there");
            emit("settings:skills", { agentId });
            return name;
          });
      },
      // runAgentWorkflowNow { id, workflowId } fires a scheduled skill through the automation
      // runtime, by agent id. For an unscheduled one the host's own implementation sends
      // "@<name>" through tm.sendPrompt with NO agentId (workflow-commands.ts runAgentWorkflowNow),
      // which lands on whichever agent the host currently has active -- not necessarily the one
      // whose panel this is. So an unscheduled skill is run the way the host runs it, as the same
      // @-reference prompt, but addressed to this agent. A model turn either way.
      runSkill(agentId, workflowId) {
        const skill = (record({ kind: "worker", id: agentId })?.skills ?? []).find((s) => s.id === workflowId);
        if (!skill) return Promise.reject(new Error("that skill is not on this agent any more"));
        const run = skill.scheduled
          ? call("runAgentWorkflowNow", { id: agentId, workflowId })
          : call("sendPrompt", {
              agentId, prompt: `@${skill.name}`,
              richText: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "workflowReference", attrs: { id: skill.id, label: skill.name } }] }] }),
            });
        return run.then(() => { void reloadActive(); return { dispatched: true, name: skill.name, via: skill.scheduled ? "runAgentWorkflowNow" : "sendPrompt" }; });
      },
      // importAgentWorkflowText { id, markdown, name } -> { workflows, result: { imported, skipped } }.
      importSkillText(agentId, markdown, name) {
        const text = String(markdown ?? "").trim();
        if (!text) return Promise.reject(new Error("paste the skill's markdown first"));
        return call("importAgentWorkflowText", { id: agentId, markdown: text, ...(name ? { name } : {}) })
          .then((answer) => this.getSkills(agentId).then((skills) => importOutcome(answer, skills)))
          .then((outcome) => { emit("settings:skills", { agentId }); return outcome; });
      },
      // importAgentWorkflowUrl { id, url, name? }: the host stores a live reference to the URL,
      // not a copy, and the agent reads it at run time.
      importSkillUrl(agentId, url) {
        const source = String(url ?? "").trim();
        if (!/^https?:\/\//i.test(source)) return Promise.reject(new Error("a skill URL starts with http:// or https://"));
        return call("importAgentWorkflowUrl", { id: agentId, url: source })
          .then((answer) => this.getSkills(agentId).then((skills) => importOutcome(answer, skills)))
          .then((outcome) => { emit("settings:skills", { agentId }); return outcome; });
      },

      // portAgentLocalSkills { id }: the host scans its own cwd and home for CLAUDE.md, AGENTS.md
      // and .cursor/rules/*.md (workflow-store.ts discoverLocalSkillFiles) and links each as a
      // live reference. Whatever it found is the answer; nothing is claimed beyond the read-back.
      portLocalSkills(agentId) {
        return call("portAgentLocalSkills", { id: agentId })
          .then((answer) => this.getSkills(agentId).then((skills) => importOutcome(answer, skills)))
          .then((outcome) => { emit("settings:skills", { agentId }); return outcome; });
      },

      // -- The box (GW-10, superseded by HANDBACK-1). handBackForeverBox { id, trigger } ->
      // session.endHandoff: the exit from a request_box_help takeover, which had no button
      // anywhere. Read back through getForeverBoxStatus, whose `handoff` field is where
      // pendingHandoff reaches the gateway -- {requestId, instruction, startedAt, snapshotAt?} and
      // no image, since forwarding the snapshot took the status from 284 B to 10 KB on a blank
      // screen and it was stale besides. Any trigger except cancel/dismissed resolves the entry
      // handed_back, which is what makes "button" the done path and skipHandoff the other one.
      handBack(agentId) {
        // handBackForeverBox ends the hand-off and THEN awaits the turn it revived
        // (resumeAfterBoxHandoff, sand-host.ts), so its answer can be minutes away. The host has
        // already cleared the hand-off by then, and hanging the control's disappearance on that
        // answer left "Hand the computer back" on screen for the whole revived turn -- a button
        // the operator has just pressed, still offering the thing it already did. So the status is
        // polled alongside the call and the control follows the host, not the RPC.
        let settled = false;
        const apply = (status) => {
          settled = true;
          const target = state.workers.find((w) => w.id === agentId);
          if (target) {
            target.handoff = status?.handoff ?? null;
            target.boxState = status?.state ?? target.boxState;
            target.boxDisplay = displayOfVncUrl(status?.vncUrl) ?? target.boxDisplay ?? null;
            if (status != null && "boxSeat" in status) target.boxSeat = status.boxSeat ?? null;
          }
          emit("message:created", { context: state.activeContext });
        };
        const watch = async () => {
          for (let attempt = 0; attempt < 20 && !settled; attempt += 1) {
            await new Promise((resolve) => global.setTimeout(resolve, 1500));
            if (settled) return;
            const status = await call("getForeverBoxStatus", { id: agentId }).catch(() => null);
            if (status != null && status.handoff == null) { apply(status); return; }
          }
        };
        watch();
        return call("handBackForeverBox", { id: agentId, trigger: "button" })
          .then(() => call("getForeverBoxStatus", { id: agentId }).catch(() => null))
          .then((status) => {
            apply(status);
            return { pending: status?.handoff != null };
          });
      },

      // HANDBACK-1: the person hands the computer back WITHOUT doing the step. skipBoxHandoff is a
      // new command; a host too old to know it answers "unknown gateway method", and the answer is
      // {supported:false} so every Skip control simply is not drawn.
      //
      // The tempting fallback is handBackForeverBox {trigger:"dismissed"} -- it reaches the declined
      // resume prompt on an old host, but stamps the entry "completed", so the card would then read
      // Done on a step nobody did. A control that lies about what happened is worse than a control
      // that is not there, so this never falls back.
      skipHandoff(agentId) {
        if (commandMissing("skipBoxHandoff")) return Promise.resolve({ supported: false });
        // NOT `answer == null`. skipBoxHandoff used to be a void command, so a success came back as
        // the four bytes `null` -- byte for byte what tryCall hands back for a command this host has
        // never heard of. Every Skip that worked was reported to the person as "this computer's
        // software is too old", and the console then hid Skip everywhere for the rest of the
        // session. Whether the command exists is tryCall's own answer, kept in unknownCommands, so
        // that is what is asked. The host answers {ok:true} now as well, which is the belt.
        return tryCall("skipBoxHandoff", { id: agentId }).then(() => {
          if (commandMissing("skipBoxHandoff")) return { supported: false };
          // Same rule as handBack: the host, not the RPC, says whether the hand-off is over.
          return call("getForeverBoxStatus", { id: agentId }).catch(() => null).then((status) => {
            const target = state.workers.find((w) => w.id === agentId);
            if (target) {
              target.handoff = status?.handoff ?? null;
              target.boxState = status?.state ?? target.boxState;
              target.boxDisplay = displayOfVncUrl(status?.vncUrl) ?? target.boxDisplay ?? null;
              if (status != null && "boxSeat" in status) target.boxSeat = status.boxSeat ?? null;
            }
            emit("message:created", { context: state.activeContext });
            return { supported: true, pending: status?.handoff != null };
          });
        });
      },
      // ---- SETTINGS-2: who is looking, and what this computer will let an agent run ------------
      //
      // getWorkspaceIdentity reads GET /auth/state, the relay's own answer about the signed-in
      // session: whether a password is configured, whether this browser is through it, whether the
      // session is the OPERATOR's, and the workspace and person it belongs to. It degrades to null
      // the way getHostStatus already does when a route is absent, and the settings surface draws no
      // Operator section at all on a null -- FAIL CLOSED, because "the adapter has a job bus method"
      // is a customer one deploy away from the operator's rows.
      //
      // WHY THIS ROUTE AND NOT A NEW ONE. /auth/state is already the pre-login band's answer about
      // the session (ui/server.mjs), already same-origin and already no-store, and the relay is the
      // only thing that can tell an operator from a customer: RELAY == null, a session carrying no
      // tenant claim, or one minted by the instance password. The console never infers it from what
      // the adapter happens to be able to do. The operator field on that answer is item B's; until it
      // merges this read gets a body with no such field, which reads as false. Absent means false.
      //
      // AND GET /me, MERGED ONTO IT, because the two answers are halves of one identity and this
      // surface reads both. /auth/state is the SESSION -- required, authenticated, the person, and the
      // operator fact -- and it is all a caller who is not through the gate can have. /me sits BELOW
      // the gate and is the only thing that counts this workspace's own usage: talking minutes and
      // their cap, and the bot ceiling. Reading /auth/state alone is what left the usage rows on this
      // surface undrawable while the route that computes them was called by nobody.
      //
      // Each half degrades on its own. /me refusing -- no session yet, or an older relay with no such
      // route -- leaves the session half standing; both failing answers null, which the surface reads
      // as "not the operator" and draws no usage row at all.
      //
      // THE SESSION HALF IS SPREAD LAST, so where the two name the same fact -- operator, workspace --
      // the pre-login band's own answer is the one that stands. Both derive the operator the same way
      // from the same request (`tenantOf(req) === OPERATOR_SLUG`), so they cannot disagree about a real
      // session; naming one authority is what stops the merge from being a coin toss, and /auth/state
      // is the authority every other piece of this surface documents.
      getWorkspaceIdentity() {
        const read = (pathname) => relayFetch(pathname, { headers: { accept: "application/json" } })
          .then(async (response) => (response.ok ? response.json().catch(() => null) : null))
          .catch(() => null);
        return Promise.all([read("/auth/state"), read("/me")]).then(([session, me]) => (
          session == null && me == null ? null : { ...(me ?? {}), ...(session ?? {}) }
        ));
      },

      // The three choices source/shared/local-tool-permission.ts exports, with the operator's
      // ceiling applied by the host. WRITTEN then RE-READ, because resolveSandLocalToolPermission
      // can hand back something narrower than what was asked for, and a picker showing a mode the
      // computer is not in is the exact failure the endpoint row exists to avoid.
      setLocalToolPermission(value) {
        const wanted = String(value ?? "");
        if (!["always", "ask", "never"].includes(wanted)) return Promise.reject(new Error("that is not one of the three choices"));
        return call("setHostSettings", { localToolPermission: wanted })
          .then(() => call("getHostSettings"))
          .then((settings) => {
            const resolved = settings?.localToolPermission ?? null;
            state.settings.localToolPermission = resolved;
            return { value: resolved, capped: resolved != null && resolved !== wanted };
          })
          .catch((error) => { failed(`That was not saved on the computer: ${error.message}`); throw error; });
      },

      // The resolved value, read fresh. tryCall so a host without getHostSettings answers null and
      // the row falls back to whatever hydrate already put in state.
      getLocalToolPermission() {
        return tryCall("getHostSettings").then((settings) => {
          if (settings == null) return null;
          state.settings.localToolPermission = settings.localToolPermission ?? null;
          return { value: settings.localToolPermission ?? null, capped: false };
        });
      },

      // getHostStatus: the host bundle's version state, plus busy and capabilities.
      getHostStatus() {
        return call("getHostStatus").then((status) => ({
          hostVersion: status?.hostVersion ?? null,
          latestHostVersion: status?.latestHostVersion ?? null,
          hostUpdateAvailable: status?.hostUpdateAvailable ?? null,
          isBusy: Boolean(status?.isBusy),
          capabilities: Array.isArray(status?.capabilities) ? status.capabilities : [],
        }));
      },

      // ---------------------------------------------------------------- BOX-6b
      /**
       * Repair one agent's conversation store, on demand, from the details panel.
       *
       * `tryCall`, so a box on a bundle without the verb answers null and app.js simply does not
       * draw the control — the same degrade every other Wave D command uses. Anything else the
       * host says is thrown, because a refusal the person cannot see is a repair they will believe
       * happened.
       *
       * The host reads the agent under `id` the way every other per-agent command on this gateway
       * does; `agentId` rides along because the BOX-6b brief named that key and a host that reads
       * either one is then correct. Neither is a secret and neither is ambiguous.
       *
       * Shaped to {before, after, quarantined, outcome, reason}. An EMPTY `quarantined` is a NORMAL
       * answer -- the demo Titan's databases were both healthy and there was nothing to move aside,
       * which is the commonest damage shape rather than an unusual one -- so a console that read it
       * as a failure would report the one real case in production as broken while it was fixed.
       * The host sends it as an array of paths; a lone string is accepted too rather than dropped.
       */
      /**
       * False once this box has answered "unknown gateway method" for the repair verb. The panel
       * asks before it draws the control, so a box on an older bundle stops offering a button that
       * cannot do anything the moment we learn it cannot. Before the first call it is true: the
       * gateway carries no capability list for this, and a control that appears once and then goes
       * away is better than one that never appears on a box that can repair.
       */
      canRepairTranscript() {
        return !commandMissing("repairAgentTranscript");
      },

      repairTranscript(agentId) {
        return tryCall("repairAgentTranscript", { id: agentId, agentId }).then((answer) => {
          if (answer == null) return null;
          // `Number(null)` is 0 and `Number("")` is 0, so a host that did not count has to be told
          // apart from one that counted nothing: "before: 0" and "before: unknown" are different
          // reports and only one of them is a number worth printing.
          const count = (value) => {
            if (value == null || value === "") return null;
            const n = Number(value);
            return Number.isFinite(n) ? n : null;
          };
          const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value])
            .map((item) => String(item).trim())
            .filter(Boolean);
          const shaped = {
            before: count(answer.before),
            after: count(answer.after),
            quarantined: list(answer.quarantined),
            outcome: typeof answer.outcome === "string" && answer.outcome.trim() ? answer.outcome.trim() : "",
            // The host's own sentence about what it did. Kept separate from `outcome` because it
            // arrives on a success as well as a refusal, so the panel prints it either way rather
            // than reading it as a verdict.
            reason: typeof answer.reason === "string" ? answer.reason.trim() : "",
          };
          // Only a repair the host stood behind forgets the failure this page saw. A refusal leaves
          // the pill and the control exactly where they were, which is the truth.
          if (repairWorked(shaped) || repairCleared(shaped)) repairIds.delete(agentId);
          return shaped;
        });
      },

      // ---------------------------------------------------------------- FEEDBACK-1
      // Four doors, and none of them decides anything. The page draws, the person decides, and
      // only then does anything leave the workspace.

      /** Seeds queued by reloadTrays since the last drain. Page-local; they die with the page. */
      takeFailedTurnReports() {
        return failedTurnReports.splice(0, failedTurnReports.length);
      },

      /**
       * What agents have written down and nobody has decided about yet. `tryCall` rather than
       * `call`: a box on an older bundle answers "unknown gateway method", which is "this box
       * cannot say" and not an error worth putting on screen.
       */
      listProblemReports() {
        return tryCall("listProblemReports").then((answer) => (Array.isArray(answer?.reports) ? answer.reports : []));
      },

      /** Clears one pending report out of the box, whichever way the person decided. */
      resolveProblemReport(id, outcome) {
        return tryCall("resolveProblemReport", { id, outcome: outcome === "sent" ? "sent" : "dropped" });
      },

      /**
       * The send. Same-origin, the way this page already posts /endpoints/use and /box/launch, and
       * for the same reason: the relay holds the control-plane credential and the box does not. The
       * relay stamps the workspace from its own registry, so nothing here names a tenant and
       * nothing here could name someone else's.
       */
      sendProblemReport(payload) {
        return relayFetch("/feedback", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
        }).then(async (response) => {
          const text = await response.text();
          let body; try { body = JSON.parse(text); } catch { body = null; }
          // `message` FIRST. The relay answers every failure with a plain sentence under that key
          // and nothing under `error`, so reading `error` first threw all three of them away and
          // put an HTTP status code in front of a customer instead.
          if (!response.ok) throw new Error(body?.message ?? body?.error ?? `the report was not sent (${response.status})`);
          return body ?? {};
        });
      },

      // updateForeverBox { id, force? } recreates the box preserving data; resetForeverBox { id }
      // recreates it from the last snapshot and can lose unsynced work. Both are the desktop
      // app's Updates tab, which box-reference-docs.ts sends users to and which did not exist here.
      updateBox(agentId) {
        return call("updateForeverBox", { id: agentId }).then((status) => ({ state: status?.state ?? "unknown", status }));
      },
      resetBox(agentId) {
        return call("resetForeverBox", { id: agentId }).then((status) => ({ state: status?.state ?? "unknown", status }));
      },

      addWorker(worker) {
        const name = worker?.name?.trim();
        if (!name) return Promise.reject(new Error("a name is required"));
        return call("createAgent", { name, description: worker.role ?? "" })
          .then(async (result) => {
            state = await hydrate(state);
            await landOn(result?.agent?.id, "worker");
            emit("worker:created", { name });
            return result?.agent ?? { name };
          })
          .catch((error) => { failed(`Creating a worker failed: ${error.message}`); throw error; });
      },

      addRoom(room) {
        const name = room?.name?.trim();
        if (!name) return Promise.reject(new Error("a name is required"));
        // An empty "first member" select used to send memberAgentIds:[null], which the gateway
        // answers 200 to and then has a room with a member that is not an agent.
        const memberAgentIds = (room.memberIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
        return call("createGroup", { name, description: "", memberAgentIds })
          .then(async (result) => {
            state = await hydrate(state);
            await landOn(result?.agent?.id, "room");
            emit("room:created", { name });
            return result?.agent ?? { name };
          })
          .catch((error) => { failed(`Creating a room failed: ${error.message}`); throw error; });
      },

      addMember(roomId, workerId) {
        const room = state.rooms.find((r) => r.id === roomId);
        if (!room || room.memberIds.includes(workerId)) return clone(state);
        const before = [...room.memberIds];
        const memberIds = [...room.memberIds, workerId];
        room.memberIds = memberIds;
        const snapshot = emit("room:member-added", { roomId, workerId });
        call("setGroupMembers", { id: roomId, memberAgentIds: memberIds }).catch((error) => {
          room.memberIds = before;
          emit("room:member-added", { roomId, workerId });
          failed(`Adding a member failed: ${error.message}`);
        });
        return snapshot;
      },

      removeMember(roomId, workerId) {
        const room = state.rooms.find((r) => r.id === roomId);
        if (!room) return clone(state);
        // A room with no members takes no turns. The old operator UI refuses the same way.
        if (room.memberIds.length <= 1) return failed("A room needs at least one member.");
        const before = [...room.memberIds];
        const memberIds = room.memberIds.filter((id) => id !== workerId);
        room.memberIds = memberIds;
        const snapshot = emit("room:member-removed", { roomId, workerId });
        call("setGroupMembers", { id: roomId, memberAgentIds: memberIds }).catch((error) => {
          room.memberIds = before;
          emit("room:member-removed", { roomId, workerId });
          failed(`Removing a member failed: ${error.message}`);
        });
        return snapshot;
      },

      // createAgentAutomation { id, spec } with spec { name, prompt, trigger, isEnabled } -- the
      // same shape the old operator UI builds, and the same shape getAgentAutomations hands back,
      // so it round-trips. The host validates the cron and computes nextRunAt; nothing is reported
      // until that comes back.
      //
      // automation-store.upsert returns null and writes NOTHING when the name, the prompt or the
      // trigger fails to parse, and the gateway still answers 200. This used to resolve with
      // shaped[length - 1] on that path, so a routine that was never written toasted the name of
      // one that was already there. The id the agent did not have a moment ago is the proof.
      createRoutine(agentId, kind, spec) {
        const scope = { kind, id: agentId };
        return call("getAgentAutomations", { id: agentId }).catch(() => null).then((before) => {
          const known = Array.isArray(before) ? new Set(before.map((a) => a.id)) : null;
          return call("createAgentAutomation", { id: agentId, spec })
            .then(() => reloadRoutines(scope))
            .then(({ rows, shaped }) => {
              emit("routine:created", { agentId });
              // With no usable pre-read the name is all there is to match on. Compare against
              // what the host would have stored: clampAutomationName collapses whitespace, trims,
              // then cuts at AUTOMATION_MAX_NAME_LENGTH.
              const wanted = String(spec.name).replace(/\s+/g, " ").trim().slice(0, 80);
              const created = known
                ? rows.find((a) => !known.has(a.id))
                : rows.find((a) => a.name === wanted);
              if (!created) throw new Error("the host took the request and stored no routine — check the trigger fields");
              return shaped.find((r) => r.id === `${agentId}::${created.id}`);
            });
        });
      },

      // updateAgentAutomation { id, automationId, spec }. automation-store.update declines the
      // same way upsert does -- null, no write, 200 back -- so the saved row is read and checked
      // against what was sent rather than assumed.
      updateRoutine(routineId, spec) {
        const routine = state.routines.find((r) => r.id === routineId);
        if (!routine) return Promise.reject(new Error("that routine is not on this box any more"));
        const scope = routine.scope;
        const [agentId, automationId] = splitRoutineId(routineId);
        return call("updateAgentAutomation", { id: agentId, automationId, spec })
          .then(() => reloadRoutines(scope))
          .then(({ rows, shaped }) => {
            emit("routine:updated", { routineId });
            const saved = rows.find((a) => a.id === automationId);
            if (!saved) throw new Error("the host answered but that routine is gone");
            if (saved.prompt !== spec.prompt || memberTypes(saved.trigger) !== memberTypes(spec.trigger)) {
              throw new Error("the host answered but kept the old routine — check the trigger fields");
            }
            return shaped.find((r) => r.id === routineId);
          });
      },

      // setAgentAutomationEnabled { id, automationId, isEnabled }. Pausing is the control an
      // operator reaches for when a routine is misbehaving, so it reports the host's flag rather
      // than flipping the card and hoping.
      setRoutineEnabled(routineId, isEnabled) {
        const routine = state.routines.find((r) => r.id === routineId);
        if (!routine) return Promise.reject(new Error("that routine is not on this box any more"));
        const scope = routine.scope;
        const [agentId, automationId] = splitRoutineId(routineId);
        return call("setAgentAutomationEnabled", { id: agentId, automationId, isEnabled })
          .then(() => reloadRoutines(scope))
          .then(({ rows, shaped }) => {
            emit("routine:updated", { routineId });
            const saved = rows.find((a) => a.id === automationId);
            if (!saved || (saved.isEnabled !== false) !== isEnabled) {
              throw new Error(`the host did not ${isEnabled ? "resume" : "pause"} that routine`);
            }
            return shaped.find((r) => r.id === routineId);
          });
      },

      // deleteAgentAutomation { id, automationId }. The host removes the routine's folder, so
      // "still listed" is the whole failure condition.
      deleteRoutine(routineId) {
        const routine = state.routines.find((r) => r.id === routineId);
        if (!routine) return Promise.reject(new Error("that routine is not on this box any more"));
        const scope = routine.scope, name = routine.name;
        const [agentId, automationId] = splitRoutineId(routineId);
        return call("deleteAgentAutomation", { id: agentId, automationId })
          .then(() => reloadRoutines(scope))
          .then(({ rows }) => {
            emit("routine:deleted", { routineId });
            if (rows.some((a) => a.id === automationId)) throw new Error("the host answered but the routine is still there");
            return name;
          });
      },

      runRoutine(routineId) {
        // The view awaits this and reads lastRun.duration off what it resolves with, so the
        // duration is measured rather than invented -- a routine that took nine seconds should
        // not report the demo's cheerful 2.2s.
        const routine = state.routines.find((r) => r.id === routineId);
        if (!routine) return Promise.resolve(null);
        const [agentId, automationId] = splitRoutineId(routineId);
        routine.status = "running";
        emit("routine:started", { routineId });
        const startedMs = Date.now();
        return call("runAgentAutomationNow", { id: agentId, automationId })
          .then(() => {
            // Dispatched is all we know. The gateway accepts the run and returns; it does not
            // report the outcome here, so claiming "passed" invents a result -- and the elapsed
            // time would be the latency of the POST, not the duration of the work.
            routine.status = "ready";
            routine.lastRun = { status: "dispatched", duration: "" };
            emit("routine:completed", { routineId });
            // Read the outcome back rather than assuming one: the host records status and both
            // timestamps, so a moment later the card can show what really happened.
            void call("getAgentAutomations", { id: agentId })
              .then((list) => {
                const fresh = (list ?? []).find((a) => a.id === automationId);
                if (fresh) { routine.lastRun = lastRunOf(fresh); emit("routine:completed", { routineId }); }
              })
              .catch(() => {});
            void reloadActive();
            return clone(routine);
          })
          .catch((error) => {
            routine.status = "ready";
            routine.lastRun = { status: "failed", duration: "" };
            emit("routine:completed", { routineId });
            failed(`${routine.name} could not run: ${error.message}`);
            throw error;
          });
      },

      // Each agent gets its own X display. The host has been assigning them all along --
      // /home/box/.sand-window-assignments.json maps agentId to a fork index, websockify on 6081
      // routes by that index as its token, and 6080 is the shared seat on :1. ensureForeverBox
      // allocates one if the agent has never had a screen (about 13s cold) and returns its URL.
      // The same call, rendered as one sentence for the Agent details row. That row used to be a
      // bold "Browser" label over an empty string, because nothing ever assigned the url it read.
      describeScreen(agentId) {
        if (!agentId) return Promise.resolve("A room has no screen of its own — it looks at a member's.");
        return this.ensureDesktop(agentId).then((desk) => (desk.shared
          ? `The shared screen on display :1 — every agent on this box sees it (box ${desk.state}).`
          : `Its own screen on this box — display :${desk.display} (box ${desk.state}).`));
      },
      ensureDesktop(agentId) {
        if (!agentId) return Promise.reject(new Error("an agent is required"));
        return call("ensureForeverBox", { id: agentId }).then((status) => {
          const url = status?.vncUrl ?? "";
          // The websockify token IS the display number, so one parse gives both the frame to show
          // and the display to launch apps on.
          const token = /token%3D(\d+)/i.exec(url)?.[1] ?? /token=(\d+)/i.exec(url)?.[1] ?? null;
          const display = token ? Number(token) : 1;
          // The host's answer names its own loopback (127.0.0.1:6081), which is the right address
          // only for a browser on the same machine as the box. Through the R750 that sent the
          // operator's browser at his own Mac, and the frame read "Failed to connect to downstream
          // server". So the frame is asked for on the page's own origin instead: the relay proxies
          // the box's noVNC at /vnc/<display>/, behind the same login as everything else. It is
          // still the box's own vnc.html, not a copy -- vnc_lite ignores resize=scale, so the
          // framebuffer rendered at native size inside a smaller iframe and showed the top-left
          // corner of the screen with the rest cropped away.
          //
          // The path query is what noVNC opens its websocket on, and this client resolves it with
          // `new URL(path, location.href)` -- relative to the PAGE, not to the host -- so it is
          // given as an absolute path or it would land at /vnc/N/vnc/N/websockify.
          const src = `${global.location.origin}/vnc/${display}/vnc.html`
            + `?path=${encodeURIComponent(`/vnc/${display}/websockify`)}`
            + "&autoconnect=1&resize=scale&reconnect=1&bell=0";
          return {
            state: status?.state ?? "unknown",
            display,
            url: src,
            shared: !token,
          };
        });
      },

      // The receipts behind an evidence verdict. The host has measured and stored them all along
      // and getAgentEvidence was called by verification scripts only, so a pill said "unsupported"
      // and there was no way to see what it had been checked against.
      getEvidence(agentId, attemptId) {
        return call("getAgentEvidence", { id: agentId, ...(attemptId ? { attemptId } : {}) })
          .then((answer) => ({
            receipts: Array.isArray(answer?.receipts) ? answer.receipts : [],
            attestations: Array.isArray(answer?.attestations) ? answer.attestations : [],
          }));
      },

      // Memory the host keeps for one agent. These three were on the operator page only.
      getMemories(agentId) {
        return call("getAgentMemories", { id: agentId }).then((rows) => (Array.isArray(rows) ? rows : []));
      },
      forgetMemory(agentId, memoryId) {
        return call("deleteAgentMemory", { id: agentId, memoryId }).then(() => this.getMemories(agentId));
      },
      clearMemories(agentId) {
        return call("clearAgentMemories", { id: agentId }).then(() => this.getMemories(agentId));
      },

      // BOTS-4. The write side of the same store, which the host had no command for until this
      // wave: adding a bot from the catalog seeds its operating rules as the agent's OWN
      // remembered facts, not as a document and not as a second copy of the description.
      //
      // The host answers { added, duplicates, rejected } and that answer is passed through whole.
      // A fact longer than the store's cap comes back under `rejected` with the reason rather than
      // being written short, so the setup card can say which one did not fit. Read back with
      // getMemories by the caller, like every other write on this adapter.
      seedAgentMemories(agentId, memories, kind) {
        const rows = (Array.isArray(memories) ? memories : []).map((m) => String(m ?? ""));
        return call("addAgentMemories", { id: agentId, memories: rows, ...(kind ? { kind } : {}) })
          .then((answer) => ({
            added: Array.isArray(answer?.added) ? answer.added : [],
            duplicates: Number(answer?.duplicates) || 0,
            rejected: Array.isArray(answer?.rejected) ? answer.rejected : [],
          }));
      },

      // The agent's own opening message, asked for AFTER its memories and skills are in place so
      // the introduction is written by an agent that already knows what it is. Nothing else
      // produces that message: sendPrompt writes a user entry, which permanently suppresses the
      // introduction the host was holding.
      kickstartAgent(agentId) {
        return call("kickstartAgent", { id: agentId })
          .then((answer) => ({ isIntroductionInFlight: answer?.isIntroductionInFlight === true }));
      },

      // AVATAR-1: the operator's crew pick, on the host rather than in this browser -- the face is
      // the agent's, so it has to be the same face on the next machine that opens the console.
      // There is no `character` field to write: measured on the box 2026-09-06, updateAgent drops
      // a key the profile does not know, and keeps an arbitrary string in avatarShape. So the pick
      // goes in as `titan:<name>` (or `titan:classic` for the opt-out), namespaced away from the
      // desktop app's eight shape names, and avatarColor takes the character's own colour so that
      // app's avatar for this agent comes up matching instead of arguing. Read back before it is
      // reported, like every other write here.
      setCharacter(agentId, choice) {
        const target = state.workers.find((w) => w.id === agentId) ?? state.rooms.find((r) => r.id === agentId);
        if (!target) return Promise.reject(new Error("that agent is not on this box any more"));
        const crew = global.TitanCrew;
        if (!crew) return Promise.reject(new Error("the crew list did not load in this browser"));
        const shape = crew.shapeValueFor(choice);
        const index = crew.indexOfCharacter(choice);
        return call("listAgents")
          .then((agents) => {
            const current = (Array.isArray(agents) ? agents : []).find((a) => a.id === agentId);
            if (!current) throw new Error("that agent is not on this box any more");
            const profile = {
              name: current.name,
              description: current.description ?? "",
              title: current.title ?? "",
              avatarShape: shape,
              // The classic mark is the operator asking for no character at all, so the colour
              // the host is holding is left where it is rather than overwritten with a crew one.
              avatarColor: index >= 0 ? crew.CREW[index].color : (current.avatarColor ?? ""),
            };
            return call("updateAgent", { id: agentId, profile });
          })
          .then(() => call("listAgents"))
          .then((agents) => {
            const fresh = (Array.isArray(agents) ? agents : []).find((a) => a.id === agentId);
            if (!fresh) throw new Error("the host answered but that agent is gone");
            if (fresh.avatarShape !== shape) throw new Error("the host answered and kept the old character");
            Object.assign(target, identityOf(fresh, target.avatarVersion ?? null));
            emit("settings:profile", { agentId });
            return crew.storedChoice(fresh);
          });
      },

      // updateAgent takes the whole profile and trims name and description, so both go with the
      // title or the host writes empty strings over what it already had. They are read from the
      // host immediately before the write rather than from the roster cache: reloadRosterInner
      // refreshes status, unread, preview and activity only, so a cached name or description can
      // be hours stale on a long-lived page, and sending the stale copy would silently revert a
      // rename made from the desktop app. The write is then read back: the host answers 200 and
      // the saved profile is the only proof it took.
      // updateProfile writes whichever of name, title and description the caller hands it and
      // carries the host's current value for the rest (GW-01). Read back and compared field by
      // field: the host trims each, so the comparison is against the trimmed value.
      updateProfile(agentId, patch) {
        const target = state.workers.find((w) => w.id === agentId) ?? state.rooms.find((r) => r.id === agentId);
        if (!target) return Promise.reject(new Error("that agent is not on this box any more"));
        const wanted = {};
        for (const key of ["name", "title", "description"]) if (patch && typeof patch[key] === "string") wanted[key] = patch[key].replace(/[\r\n]+/g, " ").trim();
        if (wanted.name === "") return Promise.reject(new Error("an agent needs a name"));
        return call("listAgents")
          .then((agents) => {
            const current = (Array.isArray(agents) ? agents : []).find((a) => a.id === agentId);
            if (!current) throw new Error("that agent is not on this box any more");
            const profile = { name: wanted.name ?? current.name, description: wanted.description ?? current.description ?? "", title: wanted.title ?? current.title ?? "" };
            return call("updateAgent", { id: agentId, profile });
          })
          .then(() => call("listAgents"))
          .then((agents) => {
            const fresh = (Array.isArray(agents) ? agents : []).find((a) => a.id === agentId);
            if (!fresh) throw new Error("the host answered but that agent is gone");
            const saved = { name: String(fresh.name ?? "").trim(), title: String(fresh.title ?? "").trim(), description: String(fresh.description ?? "").trim() };
            for (const key of Object.keys(wanted)) if (saved[key] !== wanted[key]) throw new Error(`the host answered and kept the old ${key === "title" ? "role" : key}`);
            Object.assign(target, identityOf(fresh, target.avatarVersion ?? null));
            emit("settings:profile", { agentId });
            return saved;
          });
      },
      setRole(agentId, title) {
        return this.updateProfile(agentId, { title: String(title ?? "") }).then((saved) => saved.title);
      },
      // setAgentAvatarBytes { id, pngBase64 }. The proof is the version getAgentAvatar reports
      // afterwards (listAgents does not carry it on this box, see avatarOf): the gateway serves
      // /avatars/<id>?v=<that version>, and the roster image is pointed at it. A null version
      // after the write means the host kept nothing.
      setAvatar(agentId, pngBase64) {
        const target = state.workers.find((w) => w.id === agentId) ?? state.rooms.find((r) => r.id === agentId);
        if (!target) return Promise.reject(new Error("that agent is not on this box any more"));
        if (typeof pngBase64 !== "string" || pngBase64.length === 0) return Promise.reject(new Error("pick a PNG file first"));
        const before = target.avatarVersion;
        return call("setAgentAvatarBytes", { id: agentId, pngBase64 })
          .then(() => Promise.all([call("listAgents"), call("getAgentAvatar", { id: agentId }).catch(() => null)]))
          .then(([agents, avatar]) => {
            const fresh = (Array.isArray(agents) ? agents : []).find((a) => a.id === agentId);
            if (!fresh) throw new Error("the host answered but that agent is gone");
            const version = fresh.avatarVersion ?? avatar?.version ?? null;
            if (version == null || version === before) throw new Error("the host answered and reports no new avatar version");
            // COST-1: the memo a later boot reads instead of re-downloading every face. It is written
            // here rather than only in hydrate so the next reload starts from the version this write
            // just proved, not the one before it.
            rememberAvatarVersion(agentId, version);
            Object.assign(target, identityOf(fresh, version));
            emit("settings:avatar", { agentId });
            return { avatar: target.avatar, version: target.avatarVersion };
          });
      },
      // setAgentNotifyOnUpdates { id, isEnabled } (setAgentNotificationsEnabled is its alias);
      // setAgentHiddenFromSidebar { id, isHidden }. Both read back from listAgents.
      setNotifications(agentId, enabled) {
        const target = state.workers.find((w) => w.id === agentId) ?? state.rooms.find((r) => r.id === agentId);
        if (!target) return Promise.reject(new Error("that agent is not on this box any more"));
        const isEnabled = Boolean(enabled);
        return call("setAgentNotifyOnUpdates", { id: agentId, isEnabled })
          .then(() => call("listAgents"))
          .then((agents) => {
            const fresh = (Array.isArray(agents) ? agents : []).find((a) => a.id === agentId);
            if (!fresh) throw new Error("the host answered but that agent is gone");
            if ((fresh.notifyOnUpdatesEnabled !== false) !== isEnabled) throw new Error(`the host did not turn notifications ${isEnabled ? "on" : "off"}`);
            Object.assign(target, identityOf(fresh, target.avatarVersion ?? null));
            emit("settings:notify", { agentId });
            return target.notify;
          });
      },
      setHidden(agentId, hidden) {
        const target = state.workers.find((w) => w.id === agentId) ?? state.rooms.find((r) => r.id === agentId);
        if (!target) return Promise.reject(new Error("that agent is not on this box any more"));
        const isHidden = Boolean(hidden);
        return call("setAgentHiddenFromSidebar", { id: agentId, isHidden })
          .then(() => call("listAgents"))
          .then((agents) => {
            const fresh = (Array.isArray(agents) ? agents : []).find((a) => a.id === agentId);
            if (!fresh) throw new Error("the host answered but that agent is gone");
            if ((fresh.isHiddenFromSidebar === true) !== isHidden) throw new Error(`the host did not ${isHidden ? "hide" : "unhide"} that agent`);
            Object.assign(target, identityOf(fresh, target.avatarVersion ?? null));
            emit("settings:hidden", { agentId });
            return target.hidden;
          });
      },
      // duplicateAgent { id } clones the agent's folder without its chat history (agent-clone.ts)
      // under "<name> copy". The clone's id is whatever listAgents holds afterwards that it did
      // not hold before; the roster is rebuilt around it.
      duplicateAgent(agentId) {
        const source = state.workers.find((w) => w.id === agentId);
        if (!source) return Promise.reject(new Error("only an agent can be duplicated — the host does not clone rooms"));
        return call("listAgents").then((agents) => {
          const known = new Set((Array.isArray(agents) ? agents : []).map((a) => a.id));
          return call("duplicateAgent", { id: agentId })
            .then((answer) => call("listAgents").then((after) => {
              const created = (Array.isArray(after) ? after : []).find((a) => !known.has(a.id)) ?? answer?.agent ?? null;
              if (!created?.id) throw new Error("the host answered and lists no new agent");
              return created;
            }))
            .then(async (created) => {
              state = await hydrate(state);
              emit("worker:created", { name: created.name });
              return { id: created.id, name: created.name };
            });
        });
      },
      // deleteAgents { ids }. One agent from this panel; the command takes a list, so it is the
      // list form that is wired. "Still listed" is the whole failure condition.
      deleteAgent(agentId) {
        const target = state.workers.find((w) => w.id === agentId) ?? state.rooms.find((r) => r.id === agentId);
        if (!target) return Promise.reject(new Error("that agent is not on this box any more"));
        const name = target.name;
        return call("deleteAgents", { ids: [agentId] })
          .then(() => call("listAgents"))
          .then(async (agents) => {
            if ((Array.isArray(agents) ? agents : []).some((a) => a.id === agentId)) throw new Error("the host answered but the agent is still there");
            state = await hydrate(state);
            emit("worker:deleted", { agentId });
            return name;
          });
      },

      // -- Attachments (GW-09). readAttachmentImage { path } -> { dataUrl, width, height } | null;
      // readAttachmentText { path, agentId } -> { kind:"text", text, truncated, bytes } |
      // { kind:"binary", bytes } | null, the text being the first 64 KB of the file;
      // readAttachmentChunk { path, agentId, offset, length } -> { bytesBase64, totalSize, mime }
      // pages the rest. Reads are cached by path: a re-render of the transcript must not re-read
      // every file from the host, and a null answer is cached too -- the host said no.
      // agentId rides the image read too. The host serves any image under its sand root for this
      // one (attachments-service.ts readHostAttachmentImage ignores the agent) while the text reads
      // are scoped to the agent's own attachments dir; sending it now means the host-side scoping
      // fix changes nothing here.
      readAttachmentImage(path, agentId = null) {
        const key = `img:${path}`;
        if (!attachmentReads.has(key)) attachmentReads.set(key, call("readAttachmentImage", { path, agentId }).then((answer) => (answer?.dataUrl ? { dataUrl: answer.dataUrl, width: answer.width ?? null, height: answer.height ?? null } : null)));
        return attachmentReads.get(key);
      },
      readAttachmentText(agentId, path) {
        const key = `txt:${path}`;
        if (!attachmentReads.has(key)) attachmentReads.set(key, call("readAttachmentText", { path, agentId }).then((answer) => (answer && typeof answer === "object" ? answer : null)));
        return attachmentReads.get(key);
      },
      readAttachmentChunk(agentId, path, offset, length) {
        return call("readAttachmentChunk", { path, agentId, offset: Math.max(0, Number(offset) || 0), length: Math.max(1, Number(length) || 1) }).then((answer) => {
          if (!answer || typeof answer.bytesBase64 !== "string") return null;
          const bytes = Uint8Array.from(global.atob(answer.bytesBase64), (c) => c.charCodeAt(0));
          return { text: new global.TextDecoder().decode(bytes), bytes: bytes.length, totalSize: Number(answer.totalSize) || 0, mime: answer.mime ?? null };
        });
      },

      // -- Search (GW-14). isGlobalSearchEnabled was read once at boot into state.search; the
      // palette hides itself when it was false. searchAgents { query, limit } answers transcript
      // hits { agentId, entryId, role, timestampMs, snippet }; searchMedia the indexed files
      // { agentId, entryId, fileName, kind, mime, timestampMs }. Bots are matched here, on the
      // roster already held: the host has no agent-name search.
      searchEnabled: () => state.search?.enabled === true,
      search(query, limit = 20) {
        const q = String(query ?? "").trim();
        if (!q) return Promise.resolve({ messages: [], bots: [], files: [] });
        const nameOf = (id) => (state.workers.find((w) => w.id === id) ?? state.rooms.find((r) => r.id === id))?.name ?? null;
        const kindOf = (id) => (state.rooms.some((r) => r.id === id) ? "room" : "worker");
        const lower = q.toLowerCase();
        const bots = [...state.workers, ...state.rooms]
          .filter((r) => [r.name, r.role, r.description].some((v) => String(v ?? "").toLowerCase().includes(lower)))
          .map((r) => ({ agentId: r.id, kind: r.memberIds ? "room" : "worker", name: r.name, role: r.role ?? "", hidden: r.hidden === true }));
        return Promise.all([
          call("searchAgents", { query: q, limit }).catch(() => []),
          call("searchMedia", { query: q, limit }).catch(() => []),
        ]).then(([hits, media]) => ({
          messages: (Array.isArray(hits) ? hits : []).filter((h) => h && nameOf(h.agentId)).map((h) => ({ agentId: h.agentId, kind: kindOf(h.agentId), agentName: nameOf(h.agentId), entryId: h.entryId, role: h.role ?? "", timestampMs: Number(h.timestampMs) || 0, snippet: String(h.snippet ?? "") })),
          bots,
          files: (Array.isArray(media) ? media : []).filter((m) => m && nameOf(m.agentId)).map((m) => ({ agentId: m.agentId, kind: kindOf(m.agentId), agentName: nameOf(m.agentId), entryId: m.entryId, fileName: String(m.fileName ?? ""), fileKind: m.kind ?? "file", timestampMs: Number(m.timestampMs) || 0 })),
        }));
      },
      // Brings a transcript entry into the window: pages older entries in through loadOlder
      // until the id is held, bounded, then emits so the view can scroll to it. Resolves with
      // whether the entry is on screen now.
      revealEntry(input, entryId) {
        const context = input && typeof input === "object" ? { kind: input.kind, id: input.id } : state.activeContext;
        const r = record(context);
        if (!r) return Promise.resolve(false);
        const held = () => (windows.get(context.id)?.entries ?? []).some((e) => e.id === entryId);
        const step = async (pages) => {
          await (loads.get(context.id) ?? Promise.resolve());
          if (held()) return true;
          if (pages <= 0) return false;
          const page = await loadOlder(context.id);
          if (page.loaded === 0 && !page.more) return held();
          return step(pages - 1);
        };
        return step(8).then((found) => {
          applyLoaded(r, { ...shapeWindow(context.id, r.name, outlineCache.get(context.id)?.outline ?? null), skills: r.skills, channels: null, handoff: r.handoff, boxState: r.boxState, boxDisplay: r.boxDisplay });
          applyAwaiting(context, r, 0);
          emit("transcript:reveal", { context, entryId, found });
          return found;
        });
      },

      // dismissWidget { entryId, agentId } (GW-11 item 2): the × on a question card. The host
      // stamps widgetDismissed on the entry and the next refresh reads it back as the card's
      // status; nothing is reported here beyond the host taking the call.
      dismissCard(context, messageId) {
        const target = context ?? state.activeContext;
        const r = record(target);
        const message = r?.messages.find((m) => m.id === messageId);
        if (!message?.card || message.card.kind !== "widget") return Promise.reject(new Error("only a question card can be dismissed"));
        message.card.status = "sending";
        emit("message:created", { context: target });
        return call("dismissWidget", { entryId: messageId, agentId: target.id })
          .then((answer) => reloadActive().then(() => answer?.accepted !== false))
          .catch((error) => { message.card.status = "pending"; failed(`That dismissal did not reach the host: ${error.message}`); throw error; });
      },

      // AUDIT-1: getAgentActionAudit { id, limit, before } -> { rows, nextBefore }, newest first.
      // The per-agent action ledger the host writes on every tool action (agents/<id>/audit.jsonl).
      getActionAudit(agentId, options = {}) {
        return call("getAgentActionAudit", { id: agentId, limit: options.limit ?? 50, ...(options.before ? { before: options.before } : {}) })
          .then((answer) => ({ rows: Array.isArray(answer?.rows) ? answer.rows : [], nextBefore: answer?.nextBefore ?? null }));
      },

      setRunPaused(paused) {
        // Presentation only: this pauses the operator's view of the desktop, not the worker.
        state.desktop.paused = Boolean(paused);
        return emit("desktop:pause", { paused: state.desktop.paused });
      },

      // A subscription card: the value is a key (or the word "adopt" for a CLI-store provider)
      // and goes straight to the relay, which keeps it in its 0600 store. This resolves with the
      // adoption's own outcome, because the caller used to toast a success the moment the form
      // was submitted -- and the sentence it toasted said the value had been discarded.
      submitSecret(pluginId, field, value) {
        if (String(pluginId).startsWith("sub:")) {
          const id = String(pluginId).slice(4);
          const isKey = field === "API key";
          if (!isKey && String(value).trim().toLowerCase() !== "adopt") {
            return Promise.resolve({ accepted: false, message: `Type adopt to confirm ${id}` });
          }
          return relayFetch("/subscriptions/adopt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(isKey ? { id, apiKey: value } : { id }) })
            .then(async (res) => {
              const body = await res.json().catch(() => ({}));
              if (!res.ok) {
                failed(`Adopting ${id} failed: ${body?.error ?? res.status}`);
                return { accepted: false, message: `Adopting ${id} failed: ${body?.error ?? res.status}` };
              }
              await refreshSubscriptions();
              // The scan is re-read, so this reports what the relay now holds rather than what
              // the POST was asked to do.
              const card = state.plugins.find((p) => p.id === pluginId);
              return {
                accepted: true,
                message: card?.status === "connected"
                  ? `${card.name} adopted — the value is in the relay's 0600 store on this Mac, not in chat or model context`
                  : `${id} was accepted, but the scan does not report it adopted yet`,
              };
            })
            .catch((error) => {
              failed(`Adopting ${id} failed: ${error.message}`);
              return { accepted: false, message: `Adopting ${id} failed: ${error.message}` };
            });
        }
        // Not a provider card. A connector's env values go through setConnectorSecret (the key
        // form on its own card) and a host secret request through submitSecretRequest (the masked
        // input on the card in the conversation); neither lands here.
        notWired(`Storing a secret for ${pluginId} — this card has no credential route`);
        return Promise.resolve({ accepted: false, message: `This page has no place to store a ${field} for ${pluginId}` });
      },
      // Resolves with what happened, so the caller can toast the outcome instead of toasting the
      // click: this used to fire "Plugin installed globally" before the host had answered, and on
      // a card whose route the host always rejects the answer was always an error.
      // agentId is the caller's, not this page's guess. The card that draws the Disconnect button
      // is labelled and read from app.js's contextLead(), which for a ROOM is the chief/first
      // member worker and not the room itself -- so taking state.activeContext.id here unbound a
      // channel on a different agent than the button named.
      setPluginState(pluginId, status, agentId) {
        const plugin = state.plugins.find((p) => p.id === pluginId);
        if (!plugin) return Promise.resolve(`No such plugin: ${pluginId}`);
        const platform = plugin.id;
        if (plugin.connectable === false) {
          return Promise.resolve(plugin.connectNote ?? `${plugin.name} cannot be connected from this page.`);
        }
        if (status === "available" || status === "disconnect") {
          // CP-12: disconnectChannel is per agent (host-gateway-api.ts:557 -> manager
          // .disconnectChannel(args.id, args.platform)). Sent without an id it unbound nothing.
          const context = agentId ? { kind: "worker", id: agentId } : state.activeContext;
          if (!context?.id) return Promise.resolve(`No agent is on screen, and a listener is unbound per agent.`);
          return call("disconnectChannel", { id: context.id, platform })
            .then(() => hydrate(state)).then((next) => { state = next; emit("plugin:state", { pluginId, status: "available" }); return `${plugin.name} disconnected`; })
            .catch((error) => { failed(`Disconnecting ${plugin.name} failed: ${error.message}`); return `Disconnecting ${plugin.name} failed: ${error.message}`; });
        }
        // The credential never reaches this page. The host returns the platform's own consent URL,
        // the operator approves there, and the channel binds host-side -- which is why this opens
        // a tab rather than collecting anything.
        return call("getListenerConnectUrl", { platform })
          .then((answer) => {
            const url = answer?.url;
            if (!url) { failed(`${plugin.name} returned no connect URL`); return `${plugin.name} returned no connect URL`; }
            global.open(url, "_blank", "noopener");
            const r = record(state.activeContext);
            if (r) r.messages.push({
              id: `connect-${Date.now()}`, authorId: "system", authorName: "Machine Room", type: "system",
              text: `Approve ${plugin.name} in the tab that just opened. The connection completes on the host, not here.`,
              time: timeOf(Date.now()),
            });
            emit("plugin:state", { pluginId, status: "connecting" });
            return `Approve ${plugin.name} in the tab that just opened`;
          })
          .catch((error) => { failed(`Connecting ${plugin.name} failed: ${error.message}`); return `Connecting ${plugin.name} failed: ${error.message}`; });
      },
      // CP-03: a real per-tool switch. toggleMcpToolDisabled { serverId, toolName, disabled }
      // writes the host's mcpDisabledToolsByServerId, whose normaliser keeps only positive-integer
      // server ids -- which is why this is drawn only for a card that carries the host's numeric
      // id. The row is never flipped from the click: the list is read back through
      // listMcpServerTools and the switch shows whatever the host now holds.
      togglePluginTool(pluginId, toolId) {
        const plugin = state.plugins.find((p) => p.id === pluginId);
        const tool = plugin?.tools?.find((t) => t.id === toolId);
        if (!plugin || !tool) return Promise.resolve({ accepted: false, message: `No such tool: ${toolId}` });
        if (plugin.serverId == null || tool.togglable === false) {
          notWired(plugin.serverId == null
            ? "Per-tool permissions — the host keys them by numeric server id and this connector has no numeric id here, so the write would be dropped"
            : "Per-tool permissions — this host has no toggleMcpToolDisabled command, so there is nowhere to write the disable");
          return Promise.resolve({ accepted: false, message: plugin.toolsReadOnlyNote ?? "This host cannot store a per-tool disable for this connector." });
        }
        const disabled = tool.enabled !== false;
        const readBack = async () => {
          const rows = await tryCall("listMcpServerTools", { serverId: plugin.serverId }).catch(() => null);
          if (!Array.isArray(rows)) return null;
          plugin.tools = rows.map((t) => ({
            id: `${plugin.name}::${t.name}`, name: t.name,
            description: oneLine(t.description ?? "", 160) || "No description from the server.",
            enabled: t.enabled !== false, togglable: tool.togglable,
          }));
          emit("plugin:state", { pluginId, toolId });
          return plugin.tools.find((t) => t.id === toolId) ?? null;
        };
        return tryCall("toggleMcpToolDisabled", { serverId: plugin.serverId, toolName: tool.name, disabled })
          .then(async (answer) => {
            if (answer === null) {
              notWired("Per-tool permissions — this host has no toggleMcpToolDisabled command yet");
              return { accepted: false, message: "This host has no toggleMcpToolDisabled command yet, so nothing was changed." };
            }
            const now = await readBack();
            if (now == null) return { accepted: true, message: `The host took the change but reports no tool list for ${plugin.name}.` };
            return {
              accepted: now.enabled === !disabled,
              message: now.enabled === !disabled
                ? `${tool.name} is now ${now.enabled ? "enabled" : "disabled"} on the host`
                : `The host still reports ${tool.name} as ${now.enabled ? "enabled" : "disabled"}`,
            };
          })
          .catch((error) => {
            failed(`That tool switch did not reach the host: ${error.message}`);
            return { accepted: false, message: `${tool.name} was not changed: ${error.message}` };
          });
      },
      // CP-10 item 1: a connector's own env credential. The host names the fields
      // (listConnectorSecretFields) and stores the value (setConnectorSecret); this page holds it
      // only for the length of the call and never paints it into the DOM.
      // CLOUD-BROWSER-1. The cloud browser's own key store, which is neither a connector's
      // environment nor the agent shell's. A host that predates the cloud leg answers null, and
      // the sentence says the value was not stored rather than pretending it was.
      setCloudBrowserKey(field, value) {
        return tryCall("setCloudBrowserKey", { field, value })
          .then((answer) => (answer === null
            ? { accepted: false, message: `This host has no cloud browser yet, so ${field} was not stored.` }
            : { accepted: answer?.stored !== false, message: `${field} stored on the host.` }))
          .catch((error) => ({ accepted: false, message: `${field} was not stored: ${error.message}` }));
      },
      setConnectorSecret(server, field, value) {
        return tryCall("setConnectorSecret", { server, field, value })
          .then((answer) => {
            if (answer === null) return { accepted: false, message: `This host has no setConnectorSecret command yet, so ${field} was not stored.` };
            const stored = answer?.stored !== false && answer?.ok !== false && answer?.error == null;
            return {
              accepted: stored,
              message: typeof answer?.message === "string" ? answer.message
                : answer?.error ? `${server} rejected ${field}: ${answer.error}`
                : stored ? `${field} stored by the host for ${server} — it never entered chat or model context`
                : `The host did not store ${field} for ${server}`,
            };
          })
          .catch((error) => {
            failed(`Storing ${field} for ${server} failed: ${error.message}`);
            return { accepted: false, message: `${field} was not stored: ${error.message}` };
          });
      },

      // CONNECT-5: the shell-tool half of the same promise. setShellSecret stores the value in the
      // host's 0600 store and pushes it into the box shell's environment; `applied` is the host
      // saying whether the LIVE box took it, so this page never claims a running box has a key it
      // has not been handed yet.
      setShellSecret(id, field, value) {
        return tryCall("setShellSecret", { field, value })
          .then((answer) => {
            if (answer === null) return { accepted: false, message: `This host has no setShellSecret command yet, so ${field} was not stored.` };
            const stored = answer?.stored !== false;
            void refreshConnectors();
            return {
              accepted: stored,
              message: !stored ? `The host did not store ${field}.`
                : answer?.applied === true
                  ? `${field} stored by the host and pushed into the box shell — it never entered chat or model context`
                  : `${field} stored by the host; the box was not reachable, so it lands on the box's next start`,
            };
          })
          .catch((error) => {
            failed(`Storing ${field} failed: ${error.message}`);
            return { accepted: false, message: `${field} was not stored: ${error.message}` };
          });
      },
      deleteShellSecret(field) {
        return tryCall("deleteShellSecret", { field })
          .then((answer) => {
            if (answer === null) return { accepted: false, message: "This host has no deleteShellSecret command yet." };
            void refreshConnectors();
            return {
              accepted: answer?.removed === true,
              message: answer?.removed === true
                ? `${field} removed from the host's store${answer?.applied === true ? " and cleared in the box shell" : ""}`
                : `The host held no ${field} to remove`,
            };
          })
          .catch((error) => ({ accepted: false, message: `${field} was not removed: ${error.message}` }));
      },
      // Whether the BOX has the variable, asked of the box's own shell. It answers set/unset and
      // never the value; that is the whole contract of the probe.
      probeShellSecret(field) {
        return tryCall("probeShellSecret", { field })
          .then((answer) => {
            if (answer === null) return { accepted: false, message: "This host has no probeShellSecret command yet." };
            const state = String(answer?.state ?? "unknown");
            return {
              accepted: state === "set",
              message: state === "set" ? `The box shell has ${field} set.`
                : state === "unset" ? `The box shell has no ${field}. Store it above, or restart the box if it was just stored.`
                : `The box shell answered something this page does not recognise for ${field}.`,
            };
          })
          .catch((error) => ({ accepted: false, message: `The box was not asked about ${field}: ${error.message}` }));
      },
      // The installer runs in the box as the user the host runs as, capped at five minutes, and
      // answers with the tail of its own output. Nothing is retried and nothing is hidden: an
      // install that failed says so with the box's own last lines.
      installShellTool(id, agentId) {
        return tryCall("installShellTool", { id, ...(agentId ? { agentId } : {}) })
          .then((answer) => {
            if (answer === null) return { accepted: false, message: "This host has no installShellTool command yet." };
            void refreshConnectors();
            return {
              accepted: answer?.ok === true,
              output: String(answer?.output ?? ""),
              message: answer?.ok === true
                ? `Installed in the box${answer?.taught === true ? ", and the skill was imported for this agent" : ""}.`
                : answer?.timedOut === true
                  ? "The installer was killed after five minutes."
                  : `The installer exited ${answer?.exitCode ?? "with no code"}.`,
            };
          })
          .catch((error) => ({ accepted: false, output: "", message: `The installer did not run: ${error.message}` }));
      },
      teachShellTool(id, agentId) {
        return tryCall("teachShellTool", { id, agentId })
          .then((answer) => {
            if (answer === null) return { accepted: false, message: "This host has no teachShellTool command yet." };
            return { accepted: true, message: `${answer?.name ?? id} skill imported as a workflow for this agent.` };
          })
          .catch((error) => ({ accepted: false, message: `The skill was not imported: ${error.message}` }));
      },

      // -- MARKET-1: the marketplace. Two reads and one derivation; every WRITE goes through the
      // connector paths that were already here, so Add and Uninstall are the same round trip the
      // connector editor makes and nothing new can write connectors.json.
      listMarketplace(force) { return marketplaceCatalog(force === true); },
      getMarketplaceItem(kind, id) { return tryCall("getMarketplaceItem", { kind, id }); },
      // The install state of every catalog plugin against the connector and shell-tool cards this
      // adapter already holds. `cards` is an argument so a test can hand it a built list; the page
      // passes nothing and gets the live ones.
      installedPlugins(cards) {
        return marketplaceCatalog().then((catalog) => marketplaceInstallState(
          catalog?.plugins ?? [],
          Array.isArray(cards) ? cards : state.plugins,
        ));
      },
      // Add. A connector is written with the catalog's own entry -- the same {command,args,env}
      // object the presets already carry -- and env NAMES only: connectors.json is plaintext on
      // the box, so the values go through the credential card on the plugin page afterwards. A
      // shell tool is installed in the box by the host's own installer.
      //
      // MARKET-6: a row may install more than one thing. TinyFish is a connector AND a shell tool
      // -- one provider, one key, two processes -- and Add has to mean both, or the page says
      // Added while half of it was never installed. One component behaves exactly as before.
      async addMarketplacePlugin(item, agentId) {
        const components = marketplaceComponents(item);
        if (components.length > 1) {
          const results = [];
          for (const component of components) results.push(await this.addMarketplaceComponent(item, component, agentId));
          const bad = results.find((result) => result?.accepted === false);
          return bad ?? { accepted: true, message: `${String(item?.name ?? item?.id ?? "It")} added — ${results.length} components` };
        }
        return this.addMarketplaceComponent(item, components[0] ?? null, agentId);
      },
      addMarketplaceComponent(item, component, agentId) {
        const kind = component?.kind ?? (item?.kind === "shell-tool" ? "shell-tool" : "connector");
        if (kind === "shell-tool") {
          return this.installShellTool(component?.shellToolId || marketplaceShellToolId(item), agentId);
        }
        const entry = component?.install ?? item?.install ?? {};
        const name = component?.connectorName || marketplaceConnectorName(item);
        // A catalog row that names an ADDRESS rather than a command is a remote server. Which way
        // the box opens one is the host's business (connectorEntryFromSpec), so the console hands
        // it the same spec its own Add-your-own link door builds and does not decide the transport.
        const url = String(entry?.url ?? "").trim();
        if (url) {
          return this.addLocalConnector(byoRemoteSpec({
            name,
            url,
            transport: String(entry?.type ?? entry?.transport ?? "http"),
            headers: Object.entries(entry?.headers ?? {}).map(([header, value]) => ({
              name: header,
              secret: byoLooksLikeSecretHeader(header, value),
              value: byoLooksLikeSecretHeader(header, value) ? "" : String(value ?? ""),
            })),
          }));
        }
        if (typeof entry.command !== "string" || entry.command.length === 0) {
          return Promise.resolve({ accepted: false, message: "This catalog entry names neither a command to run nor an address to open, so there is nothing to add. Use Add your own." });
        }
        return this.addConnector({
          name,
          command: entry.command,
          args: Array.isArray(entry.args) ? entry.args : [],
          envNames: Object.keys(entry.env ?? {}),
          replace: item?.replaces === true,
        });
      },
      // Uninstall. The entry comes out of connectors.json through the same write Remove already
      // made; the stored credentials are a separate offer, and they have to be cleared BEFORE the
      // entry goes -- deleteConnectorSecret resolves the server through connectors.json, so once
      // the row is gone the host cannot reach its own store for it.
      deleteConnectorSecret(server, field) {
        return tryCall("deleteConnectorSecret", { server, field })
          .then((answer) => (answer === null
            ? { accepted: false, message: `This host has no deleteConnectorSecret command yet, so ${field} is still in its store.` }
            : { accepted: answer?.removed === true, message: answer?.removed === true ? `${field} cleared from the host's store.` : `The host held no value for ${field}.` }))
          .catch((error) => ({ accepted: false, message: `${field} was not cleared: ${error.message}` }));
      },

      // -- CP-11: the connectors editor. The relay owns connectors.json (GET/POST /connectors);
      // the host re-reads it on refreshMcp, so an added connector appears on its card without an
      // operator running docker exec. Env VALUES are deliberately absent from this write: the
      // form collects names only, and setConnectorSecret above carries the values.
      //
      // CONNECT-3: the preset buttons that editor draws, as data. A click fills the form, the
      // operator reads what it filled in, and nothing is written until Add connector is pressed.
      connectorPresets() {
        return connectorPresetCatalog().map((preset) => ({
          id: preset.id, label: preset.label, name: preset.name,
          command: preset.entry.command,
          args: [...preset.entry.args],
          argsText: joinConnectorArgs(preset.entry.args),
          envNames: Object.keys(preset.entry.env),
          // One line per credential field, so the editor can say what each value is and where it
          // comes from before the operator has anything to paste.
          hints: { ...(preset.hints ?? {}) },
          replaces: preset.replaces === true,
          note: preset.note,
        }));
      },
      splitConnectorArgs,
      // Its inverse, so a pasted block's arguments go back into the editor's one-line field with
      // the quotes that make them survive a re-read. Without it a --header argument that holds a
      // space would come back as two arguments the next time the form was submitted.
      joinConnectorArgs,

      // -- MARKET-6: the three doors, and the one writer behind them ----------------------------
      // The pure halves, exposed so the page can refuse before it writes and preview before it
      // asks. Nothing here touches the network except byoPreview, which asks the host what it
      // would write and degrades to the spec when the host has no answer for that yet.
      byoTransports() { return BYO_TRANSPORTS.map((t) => ({ ...t })); },
      byoRemoteSpec, byoProgramSpec, byoRefusal, byoParsePasted, byoPreview,
      byoEnvNameFor, byoNameFromUrl,

      // The host's own argument shape for that one writer, built from the spec the doors produce.
      // The doors speak in rows a form can draw -- a header is a row that knows whether it is a
      // secret -- and the host speaks in the entry it is about to write. A secret header crosses as
      // the NAME it is stored under wrapped in braces, never a value: the host substitutes it out of
      // the 0600 store at the moment it hands the server to the box, so no value passes through
      // here, through the page, or through the file. Env names cross as an array, which is how this
      // box says "a credential the operator still owes" and what makes the masked card offer it.
      hostConnectorArgs: (spec) => {
        const envNames = Array.isArray(spec?.envNames) ? spec.envNames.map(String) : [];
        if (spec?.shape === "remote") {
          const headers = {};
          for (const row of Array.isArray(spec.headers) ? spec.headers : []) {
            const name = String(row?.name ?? "").trim();
            if (!name) continue;
            headers[name] = row?.secret === true ? byoHeaderPlaceholder(name, String(row?.env ?? "").trim()) : String(row?.value ?? "");
          }
          return {
            name: spec.name,
            url: String(spec.url ?? ""),
            type: spec.transport === "sse" ? "sse" : "http",
            ...(Object.keys(headers).length === 0 ? {} : { headers }),
            env: envNames,
          };
        }
        return {
          name: spec?.name,
          command: String(spec?.command ?? ""),
          args: Array.isArray(spec?.args) ? spec.args.map(String) : [],
          env: envNames,
        };
      },

      // ONE validated writer. addLocalConnector is the host's: it owns the reserved name, the
      // env-name rule, the empty-credential rule and the remote-address rule, so the console, the
      // agent's own AddMcpServer and installMarketplacePlugin cannot drift apart. A box whose
      // bundle predates it answers "unknown gateway method", and this falls back to the relay's
      // whole-file write so a console in front of an older box keeps working instead of refusing.
      async addLocalConnector(spec) {
        const refusal = byoRefusal(spec);
        if (refusal) return { accepted: false, message: refusal };
        const answer = await tryCall("addLocalConnector", { ...this.hostConnectorArgs(spec), replace: true })
          .catch((error) => ({ __failed: error }));
        if (answer && answer.__failed) return { accepted: false, message: `${spec.name} was not added: ${answer.__failed.message}` };
        if (answer !== null) {
          await refreshConnectors();
          return {
            accepted: answer?.added !== false,
            message: answer?.message ?? `${spec.name} added — the host wrote it and re-read its servers`,
            entry: answer?.entry ?? null,
          };
        }
        if (spec?.shape === "remote") {
          return { accepted: false, message: "This box is on a version that can only start a connector from a command, so it cannot open an address on its own yet. Update the box and add it again." };
        }
        return this.writeOneConnector(spec);
      },
      async removeLocalConnector(name, options) {
        const clearSecrets = options?.clearSecrets === true;
        const answer = await tryCall("removeLocalConnector", { server: name, name, clearSecrets })
          .catch((error) => ({ __failed: error }));
        if (answer && answer.__failed) return { accepted: false, message: `${name} was not removed: ${answer.__failed.message}` };
        if (answer !== null) {
          await refreshConnectors();
          // The host answers `cleared: string[]` (mcp-service's removeLocalConnector), and reading
          // a field it does not have meant the toast could never once report a cleared value: the
          // clause was dead on every box while the call really was clearing keys. The old shape is
          // still read for a box on a bundle that predates the array.
          const cleared = Array.isArray(answer?.cleared) ? answer.cleared.length : Number(answer?.clearedCredentials ?? 0);
          return {
            accepted: answer?.removed !== false,
            message: answer?.message ?? `${name} removed${cleared ? `, and ${cleared} stored value${cleared === 1 ? "" : "s"} cleared` : ""}`,
            clearedCredentials: cleared,
          };
        }
        // The old ordering, kept for a box that has not landed the host half: the values have to
        // go BEFORE the entry, because deleteConnectorSecret resolves the server through
        // connectors.json and cannot reach its own store once the row has left the file.
        let cleared = 0;
        if (clearSecrets && typeof this.listConnectorSecretFields === "function") {
          const fields = await tryCall("listConnectorSecretFields", { server: name }).catch(() => null);
          const held = (Array.isArray(fields?.stored) ? fields.stored : []).map(String);
          for (const field of held) {
            const gone = await this.deleteConnectorSecret(name, field);
            if (gone?.accepted) cleared += 1;
          }
        }
        const removed = await this.removeOneConnector(name);
        return { ...removed, clearedCredentials: cleared };
      },
      // A credential typed once, landing everywhere the plugin says it is used. MARKET-5: the
      // TinyFish page carried two forms for one key, each warning that the other's value did not
      // reach it. The host fans out; where it cannot yet, this does the same fan-out from the
      // catalog's own declaration so the page's promise is kept either way.
      async setPluginCredential(pluginId, field, value, plugin) {
        const answer = await tryCall("setPluginCredential", { pluginId, field, value }).catch((error) => ({ __failed: error }));
        if (answer && answer.__failed) return { accepted: false, message: `${field} was not stored: ${answer.__failed.message}` };
        if (answer !== null) {
          await refreshConnectors();
          return {
            accepted: answer?.stored !== false,
            message: answer?.message ?? `${field} stored on the host.`,
            wentTo: Array.isArray(answer?.wentTo) ? answer.wentTo : [],
            pendingWindows: Array.isArray(answer?.pendingWindows) ? answer.pendingWindows : [],
          };
        }
        const consumers = catalogPluginCredentials(plugin ?? marketplaceItemFromCache(pluginId))
          .find((credential) => credential.field === field)?.consumers ?? [];
        const results = [];
        const wentTo = [];
        for (const consumer of consumers) {
          if (consumer?.kind === "shell") {
            results.push(await this.setShellSecret(pluginId, String(consumer.env ?? field), value));
            wentTo.push("the agent's shell");
          } else if (consumer?.kind === "cloud-browser") {
            // CLOUD-BROWSER-1. Its own gateway command, because its own store: this value is
            // read in the host process by the vendor adapters and is merged into no child
            // environment, which is the whole difference between it and the two above.
            results.push(await this.setCloudBrowserKey(String(consumer.env ?? field), value));
            wentTo.push("the cloud browser");
          } else if (consumer?.kind === "connector" || consumer?.kind === "header" || consumer?.kind === "url") {
            const server = String(consumer.server ?? plugin?.connectorName ?? pluginId);
            results.push(await this.setConnectorSecret(server, String(consumer.env ?? field), value));
            wentTo.push("the connector");
          }
        }
        if (!results.length) {
          const server = String(plugin?.connectorName ?? pluginId);
          results.push(await this.setConnectorSecret(server, field, value));
          wentTo.push("the connector");
        }
        const bad = results.find((r) => r && r.accepted === false);
        return {
          accepted: bad == null,
          message: bad?.message ?? `${field} stored on the host.`,
          wentTo: [...new Set(wentTo)],
          pendingWindows: [],
        };
      },
      // CONNECT-11: the values the store still holds for a connector nobody has any more. The old
      // resolver went through connectors.json for list, set AND delete, so once an entry left the
      // file its stored value could not be named, let alone cleared -- it sat there for the life
      // of the box. A host without the command answers null and the strip is simply not drawn.
      async listConnectorSecretOrphans() {
        const answer = await tryCall("listConnectorSecretOrphans", {}).catch(() => null);
        if (answer == null) return null;
        const rows = Array.isArray(answer) ? answer : (Array.isArray(answer?.orphans) ? answer.orphans : []);
        return rows.map((row) => ({
          server: String(row?.server ?? row?.name ?? row ?? ""),
          fields: (Array.isArray(row?.fields) ? row.fields : []).map(String),
        })).filter((row) => row.server.length > 0);
      },
      async clearConnectorSecretOrphan(server) {
        const answer = await tryCall("deleteConnectorSecret", { server, all: true }).catch((error) => ({ __failed: error }));
        if (answer && answer.__failed) return { accepted: false, message: `${server} was not cleared: ${answer.__failed.message}` };
        if (answer === null) return { accepted: false, message: `This host has no deleteConnectorSecret command yet, so ${server}'s values are still in its store.` };
        const removed = Number(answer?.removed === true ? 1 : answer?.removed ?? 0);
        return { accepted: removed > 0, message: removed > 0 ? `${server}'s stored values cleared.` : `The host held nothing for ${server}.` };
      },
      listConnectors() {
        return connectorConfig().then((c) => Object.entries(c?.mcpServers ?? {}).map(([name, spec]) => ({
          name, command: spec?.command ?? null, argCount: Array.isArray(spec?.args) ? spec.args.length : 0,
          envNames: Object.keys(spec?.env ?? {}),
        })));
      },
      // The old four-field editor's entry point, kept because the Marketplace's Add, the agent's
      // integration prompt and the gate all call it. It is now a thin shape change onto the one
      // writer: a name, a command, its arguments and env NAMES are a program spec.
      addConnector(spec) {
        return this.addLocalConnector(byoSpecFromFields(spec));
      },
      // The relay's whole-file write, which is what a box too old for addLocalConnector still
      // needs. It is the LAST caller of it: everything else goes through the host, where the
      // validation lives and where a read-modify-write of a customer's connector file over docker
      // exec stops being the mechanism.
      async writeOneConnector(spec) {
        const name = String(spec?.name ?? "").trim();
        const command = String(spec?.command ?? "").trim();
        if (!name) return { accepted: false, message: "A connector needs a name." };
        if (!command) return { accepted: false, message: "A stdio connector needs a command; the relay rejects one without it." };
        // SECRET-2: the reserved destination name. A secret card whose connector is "shell" means
        // the agent's own box shell environment, so a connector called that could never be handed
        // a credential. The host and the relay refuse it too; saying so here is what makes the
        // refusal readable instead of a 400.
        if (name.toLowerCase() === "shell") return { accepted: false, message: BYO_REFUSAL.reservedName };
        const args = Array.isArray(spec?.args) ? spec.args.map((a) => String(a)) : [];
        const envNames = (Array.isArray(spec?.envNames) ? spec.envNames : []).map((n) => String(n).trim()).filter(Boolean);
        // Never a map derived from a read that may have failed: this POST REPLACES the file.
        const held = await readableConnectorServers();
        if (held == null) return { accepted: false, message: connectorsNote ?? CONNECTORS_UNREADABLE };
        const servers = { ...held };
        // A duplicate name is still refused for anything typed by hand. `replace` is set only by a
        // preset that owns its name (the TinyFish one), where refusing would leave the OAuth entry
        // in place with no way to swap recipes from this page.
        const replacing = servers[name] != null;
        if (replacing && spec?.replace !== true) return { accepted: false, message: `${name} is already configured on the box.` };
        // Names with no values: the file records which env the process wants, and the host's own
        // store is where the value goes. Writing a value here would put it in a 0600 JSON file
        // this page can read back, which is exactly what setConnectorSecret exists to avoid.
        servers[name] = { command, args, env: Object.fromEntries(envNames.map((n) => [n, ""])) };
        return this.writeConnectors(servers, `${name} ${replacing ? "replaced" : "added"}`);
      },
      // The old front door, now the one that goes through the host. `clearSecrets` rides along so
      // the ordering -- values first, then the entry -- lives in ONE place (the host's own
      // removeLocalConnector) instead of being the console's private knowledge.
      removeConnector(name, options) {
        return this.removeLocalConnector(name, options);
      },
      // The relay's whole-file write, kept for a box whose bundle predates removeLocalConnector.
      async removeOneConnector(name) {
        const held = await readableConnectorServers();
        if (held == null) return { accepted: false, message: connectorsNote ?? CONNECTORS_UNREADABLE };
        const servers = { ...held };
        if (!servers[name]) return { accepted: false, message: `${name} is not in connectors.json.` };
        delete servers[name];
        return this.writeConnectors(servers, `${name} removed`);
      },
      async writeConnectors(servers, what) {
        const res = await relayFetch("/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcpServers: servers }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          // TENANT-2: an instance with no docker of its own answers {error: "not_available",
          // detail}. Show the sentence rather than the machine word.
          const message = body?.detail ?? `connectors.json was not written: ${body?.error ?? res.status}`;
          failed(message);
          return { accepted: false, message };
        }
        // The host re-reads connectors.json and relaunches its stdio servers on refreshMcp
        // (host-gateway-api.ts routes a bare call to the mcp extension's management.restart), so
        // the card is current without a container restart.
        const refreshed = await call("refreshMcp", {}).then(() => true).catch(() => false);
        await refreshConnectors();
        const names = Object.keys(servers);
        return {
          accepted: true, servers: names,
          message: refreshed
            ? `${what} — the host re-read connectors.json`
            : `${what} in connectors.json, but refreshMcp did not answer; the card follows on the next host restart`,
        };
      },

      // -- CP-04: a listener token, taken here and handed to the host for the agent on screen.
      // connectChannel { id, platform, token } (host-gateway-api.ts:553) answers with that
      // agent's channels, so the row under the form is the host's own state, not the click.
      // agentId comes from the caller: the form is drawn for app.js's contextLead(), which on a
      // group conversation is a member worker rather than the room. Reading state.activeContext
      // here stored the token against the room the form never named.
      connectListener(platform, token, agentId) {
        const context = agentId ? { kind: "worker", id: agentId } : state.activeContext;
        if (!context?.id) return Promise.resolve({ accepted: false, message: "No agent is on screen to bind this listener to." });
        return call("connectChannel", { id: context.id, platform, token })
          .then((answer) => {
            const r = record(context);
            if (r && answer) r.channels = channelsOf(answer);
            const row = (r?.channels ?? []).find((c) => c.platform === platform) ?? null;
            emit("plugin:state", { pluginId: platform, status: row?.connected ? "connected" : "available" });
            return {
              accepted: row?.connected === true,
              message: row?.connected
                ? `${platform} connected for ${r?.name ?? "this agent"} — the host holds the token, this page does not`
                : `The host took the token but still lists no ${platform} channel for ${r?.name ?? "this agent"}`,
            };
          })
          .catch((error) => {
            failed(`Connecting ${platform} failed: ${error.message}`);
            return { accepted: false, message: `${platform} was not connected: ${error.message}` };
          });
      },

      // CP-10 item 2: the answer to a host secret request. submitSecret { entryId, value, agentId }
      // is real (widget-responses.ts:355): the host routes the value to the connector credential
      // store, stamps secretProvided on the entry and resumes the agent.
      // It also returns void -- HTTP 200, empty body -- on EVERY failure path: no such entry, not
      // a secret request, already answered, or routeSecret returning null. So a 200 is not an
      // answer. The host's own stamp is: cardOf reads entry.secretProvided into card.status, so
      // the transcript is re-read and that stamp is what decides what this reports.
      submitSecretRequest(context, messageId, value) {
        const target = context ?? state.activeContext;
        const r = record(target);
        const message = r?.messages.find((m) => m.id === messageId);
        const card = message?.card;
        if (!card || card.kind !== "secret") return Promise.reject(new Error("only a credential request can be answered this way"));
        if (!String(value ?? "").trim()) return Promise.resolve({ accepted: false, message: "The host discards an empty value." });
        card.status = "sending";
        emit("message:created", { context: target });
        return call("submitSecret", { entryId: card.entryId ?? messageId, value, agentId: target.id })
          .then(() => reloadActive())
          .then(() => {
            const now = record(target)?.messages.find((m) => m.id === messageId)?.card ?? null;
            if (now?.status === "provided") return { accepted: true, message: "The host stored it and resumed the agent" };
            if (now) now.status = "pending";
            emit("message:created", { context: target });
            return { accepted: false, message: "The host took the call but still does not report this request as answered — nothing was stored." };
          })
          .catch((error) => {
            card.status = "pending";
            failed(`That credential did not reach the host: ${error.message}`);
            return { accepted: false, message: `Not stored: ${error.message}` };
          });
      },
      // Every argument name and resolution string below was read from host source, not guessed:
      // resolveAutoReviewApproval resolves "approved"|"denied" (runner/sand-auto-review.ts:9);
      // resolveLocalToolPermission takes the ask's own vocabulary; respondToWidget takes
      // (entryId, value, agentId). Nothing reports success on its own -- the host rewrites the
      // card's status and reloadActive reads it back, so the card says what actually happened.
      decideApproval(context, messageId, decision) {
        const target = context ?? state.activeContext;
        const r = record(target);
        const message = r?.messages.find((m) => m.id === messageId);
        const card = message?.card;
        if (!card) return clone(state);
        const agentId = target.id;
        const sent = (promise) => {
          card.status = "sending";
          promise.then(() => reloadActive())
            .catch((error) => { card.status = "pending"; failed(`That answer did not reach the host: ${error.message}`); });
          return emit("message:created", { context: target });
        };
        // COMMAND-CARD-1. "Always allow" is not a host resolution -- resolveAutoReviewApproval takes
        // only approved|denied (runner/sand-auto-review.ts:9) -- so it is TWO calls in order: the
        // proposed rule goes into the person's Auto-review settings, and only then is the approval
        // approved. If the settings write fails nothing is resolved: the card stays pending and says
        // the rule was not saved, because approving anyway would grant the action while quietly
        // dropping the standing permission the person actually asked for.
        //
        // The current instructions are re-read from the host in the same breath rather than taken
        // from this page's copy. setHostSettings REPLACES the whole autoReviewInstructions object,
        // and the settings panel may have a block list in flight; writing from a stale snapshot
        // would silently undo it.
        if (card.kind === "auto-review" && decision === "always") {
          const rule = typeof card.rule === "string" ? card.rule.trim() : "";
          if (rule.length === 0) return notWired("Always-allowing this — the host proposed no rule to add, so there is nothing to save");
          card.status = "sending";
          (async () => {
            const live = await call("getHostSettings").catch((error) => { throw new Error(`Your review settings could not be read, so nothing was allowed: ${error.message}`); });
            const current = live?.autoReviewInstructions ?? {};
            const allow = Array.isArray(current.allowInstructions) ? [...current.allowInstructions] : [];
            if (!allow.some((entry) => String(entry).trim() === rule)) allow.push(rule);
            const block = Array.isArray(current.blockInstructions) ? current.blockInstructions : [];
            const isEnabled = current.isEnabled ?? true;
            await call("setHostSettings", { autoReviewInstructions: { isEnabled, allowInstructions: allow, blockInstructions: block } })
              .catch((error) => { throw new Error(`The standing rule was not saved, so nothing was allowed: ${error.message}`); });
            state.settings.autoReview = { enabled: isEnabled, allow, block };
            await call("resolveAutoReviewApproval", { agentId, entryId: messageId, requestId: card.requestId, resolution: "approved" })
              .catch((error) => { throw new Error(`The rule was saved, but this one action was not approved: ${error.message}`); });
          })()
            .then(() => reloadActive())
            .catch((error) => { card.status = "pending"; failed(error.message); });
          return emit("message:created", { context: target });
        }
        if (card.kind === "auto-review") return sent(call("resolveAutoReviewApproval", {
          agentId, entryId: messageId, requestId: card.requestId,
          resolution: decision === "denied" ? "denied" : "approved",
        }));
        if (card.kind === "local-tool") return sent(call("resolveLocalToolPermission", {
          agentId, entryId: messageId, requestId: card.requestId, resolution: decision,
        }));
        if (card.kind === "widget") return sent(call("respondToWidget", {
          entryId: messageId, value: decision, agentId,
        }));
        // A credential request is answered through submitSecretRequest, which carries the masked
        // value; there is no decision button on that card to land here.
        return notWired("Answering a credential request with a decision button — it takes a masked value, not a choice");
      },
      setModel(workerId, modelId) {
        // Box-wide: every agent answers through one endpoint. The menu lists the catalog, adopted
        // subscriptions included, so choosing here is the endpoint switch.
        const chosen = state.models.available.find((m) => m.id === modelId);
        if (!chosen || chosen.provider === "box") return notWired("Per-agent models — this host routes every agent through one endpoint");
        relayFetch("/endpoints/use", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: modelId }) })
          .then(async (res) => {
            const body = await res.json().catch(() => ({}));
            // A relay that cannot reach its box answers {error: "not_available", detail}. The
            // detail is the sentence written for an owner; the error word is for us. TENANT-2.
            if (!res.ok) { failed(body?.detail ?? `Switching to ${chosen.name} failed: ${body?.error ?? res.status}`); return; }
            await refreshSubscriptions();
          })
          .catch((error) => failed(`Switching to ${chosen.name} failed: ${error.message}`));
        return emit("settings:model", { workerId, modelId });
      },
      // MODELS-1. The model a provider card is pointed at.
      //
      // No new route: POST /subscriptions/adopt already takes {id, apiKey, model} and a re-adopt
      // with no key keeps the stored one (both measured on this Mac 2026-09-08), so choosing a
      // model is that same POST with the key left out. What it changes is the endpoints.json row.
      //
      // THREE CLOCKS, and the caller is told which one it got, because "takes effect immediately"
      // is three different sentences here. The catalog row moves as soon as this resolves. The BOX
      // moves only when it is pointed at this endpoint -- so a card the box is already answering
      // through is re-applied here, and one it is not waits for the Use button beside it. And the
      // box that is re-applied answers on its NEXT TURN, because the host re-reads box-secrets.json
      // on every stream; nothing restarts and no message already in flight changes model.
      setEndpointModel(pluginId, modelId) {
        const card = state.plugins.find((plugin) => plugin.id === pluginId) ?? null;
        const id = String(pluginId ?? "").startsWith("sub:") ? String(pluginId).slice(4) : "";
        const model = String(modelId ?? "").trim();
        if (card == null || id.length === 0 || model.length === 0) {
          return Promise.resolve({ accepted: false, message: "This card has no model to set." });
        }
        const applying = card.live === true;
        return relayFetch("/subscriptions/adopt", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, model }),
        })
          .then(async (res) => {
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              const why = body?.detail ?? body?.error ?? res.status;
              failed(`${card.name} could not be set to ${model}: ${why}`);
              return { accepted: false, message: `${card.name} could not be set to ${model}: ${why}` };
            }
            // The box only follows if it is on this endpoint. Pointing it at an endpoint it is not
            // using would be a switch the person did not ask for.
            if (applying && card.endpointId) {
              const used = await relayFetch("/endpoints/use", {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: card.endpointId }),
              });
              if (!used.ok) {
                const detail = await used.json().catch(() => ({}));
                failed(`${card.name} now points at ${model}, but this box could not be moved onto it: ${detail?.detail ?? detail?.error ?? used.status}`);
                await refreshSubscriptions();
                return { accepted: false, applied: false, model, message: `${card.name} now points at ${model}, but this box was not moved onto it.` };
              }
            }
            await refreshSubscriptions();
            return {
              accepted: true, applied: applying, model,
              message: applying
                ? `${card.name} answers with ${model} from the next turn.`
                : `${card.name} is set to ${model}. Choose it above to point this box at it.`,
            };
          })
          .catch((error) => {
            failed(`${card.name} could not be set to ${model}: ${error.message}`);
            return { accepted: false, message: `${card.name} could not be set to ${model}: ${error.message}` };
          });
      },
      setAutoReview(enabled, rule) {
        const current = state.settings.autoReview ?? { allow: [], block: [] };
        // The view offers one free-text field. Treat it as a block instruction, because that is
        // the direction an operator writes in ("ask me before deleting anything") and the safe
        // way to be wrong.
        const block = typeof rule === "string" && rule.trim()
          ? [rule.trim()]
          : current.block ?? [];
        const next = { isEnabled: Boolean(enabled), allowInstructions: current.allow ?? [], blockInstructions: block };
        state.settings.autoReview = { enabled: next.isEnabled, allow: next.allowInstructions, block: next.blockInstructions };
        emit("settings:auto-review", { enabled: next.isEnabled });
        return call("setHostSettings", { autoReviewInstructions: next })
          .catch((error) => { failed(`Review policy could not be saved: ${error.message}`); throw error; });
      },

      // ---- the Titan Job Bus (docs/JOB-BUS.md) ------------------------------------------------
      // The token lives on the relay, so its four routes are console-session calls; the jobs and
      // the worker mapping live on the gateway. The card reads both through here rather than
      // fetching, so the offline demo can answer the same shapes with no network at all.
      getJobBusStatus() {
        return relayFetch("/job-bus/status").then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body?.error ?? `the relay answered ${r.status}`);
          return body;
        });
      },
      // null, not [], when this box's gateway has no jobBusList: the card then says the host is
      // older than the console instead of drawing an empty table as if no job had ever run.
      listJobBusJobs() {
        // The contract says {jobs:[...]}; a bare array is read too, because a host that answered
        // one would otherwise paint "no jobs yet" over a bus that had run plenty.
        return tryCall("jobBusList").then((answer) => (answer == null ? null : Array.isArray(answer) ? answer : answer.jobs ?? []));
      },
      generateJobBusToken() { return jobBusWrite("/job-bus/token/generate", {}).then(armJobBusOnToken); },
      setJobBusToken(token) { return jobBusWrite("/job-bus/token", { token }).then(armJobBusOnToken); },
      clearJobBusToken() { return jobBusWrite("/job-bus/token/clear", {}); },
      // §10.7's own settings file, read and written by two commands of its own. null, not {}, on a
      // host that has neither: the card then says the bundle is older than the contract instead of
      // drawing the defaults as though it had read them off this box.
      getJobBusSettings() { return tryCall("jobBusGetSettings"); },
      setJobBusSettings(partial) {
        return call("jobBusSetSettings", partial)
          .catch((error) => { failed(`The job bus settings were not saved: ${error.message}`); throw error; });
      },

      // ---- agent email (docs/MAIL.md) ---------------------------------------------------------
      // Relay-local, like the subscriptions and the endpoint catalog: the settings file, the
      // signing secret and the received-mail ledger all live beside the relay, so this is a
      // session call rather than a gateway command. Both routes answer the same shape, and that
      // shape never carries the two secrets -- it says whether each one is set.
      getMailSettings() {
        return relayFetch("/mail/settings").then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body?.error ?? `the relay answered ${r.status}`);
          return body;
        });
      },
      // A partial save. A secret is sent as a string to set it and as null to clear it; leaving it
      // out is what lets the card save the rest of the form without ever holding one.
      setMailSettings(partial) {
        return relayFetch("/mail/settings", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(partial ?? {}),
        }).then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body?.error ?? `the relay answered ${r.status}`);
          return body;
        });
      },

      // ---- ONBOARD-1: the first-run setup with Titan ----------------------------------------
      // Three commands, and the console degrades on each of them rather than guessing. tryCall is
      // what makes that possible for the read: a host older than this wave answers "unknown
      // gateway method", which says this box cannot report a first run -- not that it is in one --
      // so the answer is null and app.js opens no dialog at all.
      getOnboardingState() {
        return tryCall("getOnboardingState");
      },
      // The person's own way out of the dialog: Skip for now, or Done once all five are in.
      // Whatever Titan captured goes with it, so a person who skips halfway keeps the answers they
      // already gave, and `skipped` is what tells the box which of the two it was rather than
      // recording every close as a finish. The interview's ordinary ending does not come through
      // here at all: Titan calls finish_onboarding and the box answers done:true on the next poll.
      completeOnboarding(answers, options) {
        return call("completeOnboarding", {
          answers: answers ?? {},
          ...(options?.skipped === true ? { skipped: true } : {}),
        });
      },
      // Titan's opening line. The host owns it: startOnboarding puts the setup recipe on that
      // first turn as a workflow reference, so the words Titan says are the host's and this file
      // holds no script (docs/ONBOARDING.md sections 6 and 7).
      // A host too old to have the command answers "unknown gateway method", and then the console
      // sends a plain first turn instead. Titan answers as himself, which is a plainer opening
      // rather than a wrong one, and better than a dialog that waits forever on an empty
      // conversation.
      startOnboarding(agentId) {
        const id = agentId ?? state.activeContext?.id;
        if (!id) return Promise.resolve({ started: false });
        return tryCall("startOnboarding", { agentId: id }).then((answer) => {
          if (answer) return { started: true };
          return call("sendPrompt", {
            agentId: id, clientNonce: nonce(),
            prompt: "Let's get set up.",
          }).then(() => ({ started: true }));
        });
      },

      startTeaching(workerId) {
        const id = workerId ?? state.activeContext?.id;
        const worker = state.workers.find((w) => w.id === id);
        if (!worker) return Promise.resolve({ ok: false, reason: "unknown-agent", message: "That agent is not on this host." });
        // The recording dialog is a claim that ffmpeg is rolling on the box, so nothing is set
        // here until the host says it is. This used to flip state.teaching on the click and let
        // the view open the modal beside a start the host had refused.
        return call("startTeachRecording", { agentId: id })
          .then((status) => {
            if (status?.state !== "recording") {
              return { ok: false, reason: "not-recording", message: `The host answered ${JSON.stringify(status?.state ?? null)} instead of starting a recording.` };
            }
            // The host's start() short-circuits on any recording already running and answers with
            // THAT recording, so a click on a second agent comes back as a success carrying the
            // first agent's id. Taking it would title a dialog for this agent over another
            // agent's screen, on a clock that started before the click.
            const owner = status.agentId ?? id;
            if (owner !== id) {
              const other = state.workers.find((w) => w.id === owner);
              const message = `${other?.name ?? "Another agent"} is already recording on this box. Finish or discard that recording before starting another.`;
              emit("teaching:failed", { workerId: id, reason: "busy", message });
              return { ok: false, reason: "busy", message };
            }
            // Trust the host's clock, not ours: the elapsed time an operator reads has to be the
            // recording's, or a ten-minute cap arrives sooner than the timer says it will.
            state.teaching = {
              active: true,
              workerId: status.agentId ?? id,
              startedAt: status.startedAtMs ?? Date.now(),
              maxDurationMs: status.maxDurationMs ?? null,
            };
            emit("teaching:started", { workerId: state.teaching.workerId });
            return { ok: true, workerId: state.teaching.workerId, startedAt: state.teaching.startedAt, maxDurationMs: state.teaching.maxDurationMs };
          })
          .catch((error) => {
            const message = String(error?.message ?? error);
            state.teaching = { active: false, workerId: null, startedAt: null };
            // The two refusals an operator can act on carry their own code; everything else keeps
            // the host's sentence, because inventing a friendlier one would hide what happened.
            const reason = /feature gate is off/i.test(message) ? "gate-off"
              : /private desktop monitor/i.test(message) ? "no-monitor"
                : "host";
            const failure = { ok: false, reason, message };
            emit("teaching:failed", { workerId: id, reason, message });
            return failure;
          });
      },

      // Both buttons land here; save is the only difference. It resolves once the host has
      // answered, so the view can hold the dialog and the timer open until the box is idle --
      // a closed modal over a live ffmpeg is the bug this replaces.
      finishTeaching(save = true, note = "") {
        const id = state.teaching?.workerId ?? state.activeContext?.id;
        if (!id) return Promise.resolve({ ok: false, reason: "unknown-agent", message: "There is no recording to stop." });
        // Read the host before stopping it. stop() answers a bare {state:"idle"} whenever it holds
        // no recording, which is the same shape a real stop returns, so a click on a recording the
        // ten-minute cap already finished came back here as a success and was announced as
        // "Recording discarded" -- for a recording the box had saved, queued and handed to the
        // model. An explicit idle is the only value that means "there was nothing to stop"; an
        // unreadable status falls through to the stop, because refusing to stop on a failed read
        // is the worse of the two mistakes.
        return call("getTeachRecordingStatus").catch(() => null).then((before) => {
          if (before?.state === "idle") {
            state.teaching = { active: false, workerId: null, startedAt: null };
            emit("teaching:finished", { workerId: id, saved: null });
            // noteSent:false keeps the view from clearing the textarea. The cap saves and
            // dispatches with nothing from the dialog in it, so the note in front of the operator
            // was never sent anywhere and throwing it away here would be the second loss.
            return {
              ok: true, saved: null, alreadyStopped: true, workerId: id, noteSent: false,
              message: "This box was no longer recording, so nothing here stopped it. The ten-minute cap ends a recording by saving it and starting the learning turn, and that save carries no note, so read the agent's transcript before recording again. The note typed here was not sent and is still in the field.",
            };
          }
          return call("stopTeachRecording", save && note ? { agentId: id, save, note } : { agentId: id, save })
            .then((status) => {
              if (status?.state !== "idle") {
                return { ok: false, reason: "not-idle", message: `The host still reports the recording as ${String(status?.state ?? "unknown")}.` };
              }
              state.teaching = { active: false, workerId: null, startedAt: null };
              emit("teaching:finished", { workerId: id, saved: Boolean(save) });
              // save:true is what queues demo.mp4 and dispatches the learning prompt. The note
              // travels in the stop above, because the host dispatches that prompt from inside the
              // stop: the note used to follow as a second message and reached the agent after the
              // learning turn had already begun. A stop that answered idle carried it.
              void reloadActive().catch(() => {});
              return { ok: true, saved: Boolean(save), workerId: id, noteSent: save && note ? true : null };
            })
            .catch((error) => ({ ok: false, reason: "host", message: String(error?.message ?? error) }));
        });
      },

      // What the open dialog polls. The host is the only thing that knows a recording ended -- the
      // cap fires on the box, and nothing pushes that to the page -- so a dialog with no way to
      // ask keeps a red dot pulsing and a timer counting over a recording that is already saved.
      // null means the question could not be asked, which is not the same answer as "idle".
      teachStatus() {
        return call("getTeachRecordingStatus")
          .then((status) => (status?.state === "recording"
            ? { active: true, workerId: status.agentId ?? null, startedAt: status.startedAtMs ?? null, maxDurationMs: status.maxDurationMs ?? null }
            : { active: false, workerId: null, startedAt: null, maxDurationMs: null }))
          .catch(() => null);
      },

      // The view layer calls these directly for local echo; keep them local.
      addMessage(context, message) {
        const target = context ?? state.activeContext;
        const r = record(target);
        if (!r) return null;
        // Anything attributed to a worker is fiction unless it came off the wire. The type does
        // not matter: a "skill" card and a "routine-result" card lie exactly as loudly as text,
        // and both slipped through when this checked for text alone.
        const fabricated = message.authorId && message.authorId !== "you" && message.type !== "working" && message.type !== "decision";
        if (fabricated) return null;
        // One set of dots, whoever asked for them. Hand back the bubble already hanging so the
        // caller's later removal is aimed at a message this adapter is willing to defend.
        const wait = awaiting.get(keyOf(target));
        if (message.type === "working" && wait) return { ...message, id: wait.id, time: "" };
        const complete = {
          id: message.id || `local-${Date.now()}-${r.messages.length}`,
          time: message.time || timeOf(Date.now()),
          type: "text",
          ...message,
        };
        r.messages.push(complete);
        emit("message:created", { context: target, message: complete });
        return complete;
      },
      removeMessage(context, messageId) {
        const target = context ?? state.activeContext;
        const wait = awaiting.get(keyOf(target));
        // The demo timer tries to clear the dots after 1.15s. While the worker is genuinely still
        // out there, that removal is declined; the reply landing is what clears them.
        if (wait && messageId === wait.id) return clone(state);
        const r = record(target);
        if (r) r.messages = r.messages.filter((m) => m.id !== messageId);
        return emit("message:removed", { messageId });
      },
      setWorkerStatus(workerId, status, statusText) {
        // Same reason: the demo flips the worker back to ready on its own timer.
        if (status === "ready" && awaiting.has(`worker:${workerId}`)) return clone(state);
        const w = state.workers.find((x) => x.id === workerId);
        if (w) Object.assign(w, { status, statusText: statusText ?? w.statusText });
        return emit("worker:status", { workerId, status });
      },
    };

    // COST-1: the avatar versions, settled once the page is up -- the remembered ones checked (a stale
    // one is a 404 and a 404 is a broken face, so the check is not optional, just not on the critical
    // path) and the unknown ones learned. Either way the roster repaints with the real face and the
    // answer is remembered, so no later boot pays for it at all.
    void settleAvatars((id, version) => {
      const r = state.workers.find((x) => x.id === id) ?? state.rooms.find((x) => x.id === id);
      if (!r) return;
      r.avatarVersion = version;
      r.avatar = version != null ? avatarUrl(id, version) : pick(AVATARS, id);
      emit("worker:status", { workerId: id, status: r.status });
    }).catch(() => { /* a check that cannot be made leaves the remembered version alone */ });

    // PUSH-1's deep link, the second half. hydrate already made ?agent= the active context, so the
    // only thing left is ?entry=, and then clearing the query. The timeout is what lets app.js
    // subscribe first: it constructs this adapter and then adds its listener, and a reveal emitted
    // before that is a scroll nobody performs.
    const { agent: askedAgent, entry: askedEntry } = deepLinkQuery();
    if (askedAgent != null || askedEntry != null) {
      global.setTimeout(() => {
        const context = state.activeContext;
        const onAsked = askedAgent == null || context?.id === askedAgent;
        const done = () => clearDeepLinkQuery();
        if (!onAsked || askedEntry == null) { done(); return; }
        Promise.resolve(api.revealEntry(context, askedEntry)).catch(() => {}).then(done);
      }, 0);
    }

    return api;
  }

  // The Log out control. It is drawn only where signing out means something: /auth/state says
  // whether the relay has a password at all, and on this Mac's loopback console it does not.
  // Wired here rather than in app.js so the handoff's own event layer stays as it was.
  async function wireLogout() {
    const button = global.document?.getElementById?.("logout-button");
    if (button == null) return;
    let state = null;
    try { state = await (await fetch("/auth/state")).json(); } catch { return; }
    if (state?.required !== true) return;
    button.hidden = false;
    button.addEventListener("click", async () => {
      button.disabled = true;
      // The POST clears the cookie; the navigation is what the operator sees. Both happen even if
      // the relay is unreachable, because a Log out that appears to do nothing is worse than one
      // that leaves a dead cookie behind on a server that is already down.
      try { await fetch("/logout", { method: "POST" }); } catch { /* going to /login regardless */ }
      global.location.assign("/login");
    });
  }
  wireLogout().catch(() => { /* no control drawn; the relay is the source of truth either way */ });

  // app.js constructs its adapter synchronously, so the gateway is read before it loads. If the
  // gateway is unreachable the demo adapter runs instead and the page still comes up.
  global.__bootMachineRoom = async function bootMachineRoom() {
    try {
      const state = await hydrate(DEFAULTS);
      global.createDemoAdapter = () => createGatewayAdapter(state);
      global.__machineRoomLive = true;
    } catch (error) {
      global.createDemoAdapter = demoFactory;
      global.__machineRoomLive = false;
      global.__machineRoomError = String(error.message ?? error);
    }
  };
})(window);
