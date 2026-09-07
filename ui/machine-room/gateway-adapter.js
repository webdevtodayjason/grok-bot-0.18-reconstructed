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

  async function call(method, args = {}) {
    const r = await relayFetch(`/api/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) throw new Error(body?.error ?? `${method} failed (${r.status})`);
    return body;
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

  // The transcript never records tool calls; the conversation outline (the model's own turn state,
  // no timestamps, rewritten by compaction) does. Weave the outline's tool rows into the durable
  // transcript so a claim sits next to its receipt, the way the upstream desktop shows it. A row is
  // placed before the next transcript entry the outline also contains; rows after the last shared
  // entry go at the end, which is what "worked and never reported" looks like.
  const TOOL_LABELS = { shellToolCall: "Shell", readToolCall: "Read", communicateUpdateToolCall: "Update", computerUseToolCall: "Computer", Task: "Task" };
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
  function toolRowText(item) {
    const label = TOOL_LABELS[item.name] ?? String(item.name ?? "Tool").replace(/ToolCall$/, "");
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
    return { text, detail };
  }
  const messageKey = (message) => (message?.type === "text" ? `a:${String(message.content ?? "").trim()}` : `a:${JSON.stringify(message ?? null)}`);
  const userText = (e) => (typeof e.content === "string" ? e.content : e.content?.map?.((c) => c.text ?? "").join("") ?? "");
  function entryKey(e) {
    if (e.kind === "send-message") return messageKey(e.message);
    if (e.kind === "message" && e.role === "user") return `u:${userText(e).trim()}`;
    return null;
  }
  function outlineKey(item) {
    if (item.kind === "send-message") return messageKey(item.message);
    if (item.kind === "user") return `u:${String(item.text ?? "").trim()}`;
    return null;
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
    const inserts = new Map();
    let cursor = 0;
    let pending = [];
    for (const item of items) {
      if (item?.kind === "tool-call") { const row = toolRowText(item); pending.push({ kind: "tool-row", id: `tool-${item.id}`, text: row.text, detail: row.detail }); continue; }
      const key = item ? outlineKey(item) : null;
      if (key == null) continue;
      let at = -1;
      for (let j = cursor; j < entries.length; j += 1) if (entryKey(entries[j]) === key) { at = j; break; }
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
  const isAttachmentEntry = (e) => e.kind === "user-attachment" || (e.kind === "send-message" && e.message?.type === "attachment");
  function messagesOf(transcript, fallbackName, outline, partial = false) {
    return collapseAgentExchanges(weaveToolRows(transcript, outline, partial), fallbackName)
      .filter((e) => e.kind === "send-message" || e.kind === "tool-row" || e.kind === "agent-exchange" || e.kind === "user-attachment" || (e.kind === "message" && e.role === "user"))
      .map((e, i) => {
        if (e.kind === "tool-row") return { id: e.id, type: "system", text: e.text, detail: e.detail ?? "" };
        if (e.kind === "agent-exchange") return { id: e.id, type: "system", text: `${e.count} message${e.count === 1 ? "" : "s"} with ${e.peer}`, peer: e.peer, self: e.self, exchange: e.exchange };
        const mine = e.kind !== "send-message";
        const card = mine ? null : cardOf(e);
        const attachment = isAttachmentEntry(e)
          ? attachmentOf(e.kind === "user-attachment" ? e.file_path : (e.message.url ?? e.message.file_path), e.kind === "user-attachment" ? e.file_name : e.message.file_name)
          : null;
        const text = attachment ? (e.kind === "send-message" ? e.message.alt ?? "" : "")
          : e.kind === "send-message"
          ? (typeof e.message?.content === "string" ? e.message.content : "")
          : (typeof e.content === "string" ? e.content : e.content?.map?.((c) => c.text ?? "").join("") ?? "");
        return {
          id: e.id ?? `entry-${i}`,
          authorId: mine ? "you" : (e.author?.id ?? "agent"),
          authorName: mine ? "You" : (e.author?.name ?? fallbackName),
          type: card ? "decision" : attachment ? "attachment" : "text",
          ...(card ? { card } : {}),
          ...(attachment ? { attachment } : {}),
          text: String(text).trim(),
          time: timeOf(Number(e.timestampMs ?? e.createdAt)),
          ...(e.evidence ? { evidence: e.evidence } : {}),
        };
      })
      // Claim provenance (docs/EVIDENCE-CONTRACT.md): the host stamps every text reply with a verdict
      // it computed from the tool results of that attempt. The stamp rides on the reply itself and
      // the view draws it as a chip inside that reply's row. It used to be synthesized here as a
      // separate system line reading "Evidence: unsupported · <url> in no tool result this attempt",
      // which an operator read as an error under a reply that had in fact been delivered.
      .filter((m) => m.text || m.card || m.attachment);
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
  function filesOf(transcript) {
    const seen = new Set();
    return (transcript ?? []).flatMap((e) => {
      if (e.kind === "user-attachment" && e.file_path) {
        return [{ name: e.file_name || String(e.file_path).split("/").pop(), path: e.file_path, from: "you", at: Number(e.timestampMs) || 0, bytes: Number(e.byteSize) || 0 }];
      }
      if (e.kind === "send-message" && e.message?.type === "attachment") {
        const url = e.message.url ?? e.message.file_path;
        if (url) return [{ name: e.message.file_name || String(url).split("/").pop(), path: url, from: "the worker", at: Number(e.timestampMs) || 0, bytes: Number(e.message.byteSize) || 0 }];
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

  function statusOf(agent) {
    if (agent.isRunning) return { status: "working", statusText: "Working now", needsYou: false, needsYouReason: "" };
    // The third real state the old operator UI has and this one discarded: blocked on you.
    if (agent.awaitingUserResponse || attentionIds.has(agent.id)) {
      // QOL-NEEDS-YOU: "attention" covers two different things -- the host says this agent is
      // waiting on the operator, or its last turn errored. Only the first is a job for a person,
      // so it gets its own flag: the amber pill and the "N need you" count read this, not the
      // status, and a failed turn no longer inflates the count.
      const awaiting = agent.awaitingUserResponse;
      return {
        status: "attention",
        statusText: awaiting ? "Waiting on you" : "The last turn failed",
        needsYou: Boolean(awaiting),
        needsYouReason: awaiting && typeof awaiting.reason === "string" ? awaiting.reason : "",
      };
    }
    // The description is what the agent is for; it lives on the profile and the details panel. As
    // the idle status line it ran the whole persona across the sidebar card, the header and the
    // status pill (MR-28), so the status line says the state and nothing else.
    return { status: "ready", statusText: "Ready for the next task", needsYou: false, needsYouReason: "" };
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
      TINYFISH_API_KEY: "Your TinyFish account's API key, carried to https://agent.tinyfish.ai/mcp as an Authorization bearer — X-API-Key is the REST-side name and this endpoint refuses it. The key is account-wide; it carries no separate scopes.",
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
  const CREDENTIAL_HINTS = Object.fromEntries(CONNECTOR_PRESETS.flatMap((p) => Object.entries(p.hints ?? {})));
  const credentialHintsFor = (fields) => Object.fromEntries(fields.flatMap((f) => (CREDENTIAL_HINTS[f] ? [[f, CREDENTIAL_HINTS[f]]] : [])));

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
  async function marketplaceCatalog(force) {
    if (marketplaceCatalogCache && force !== true) return marketplaceCatalogCache;
    const answer = await tryCall("listMarketplace", {});
    if (answer == null) return null;
    marketplaceCatalogCache = {
      plugins: Array.isArray(answer.plugins) ? answer.plugins : [],
      bots: Array.isArray(answer.bots) ? answer.bots : [],
      // The host serves categories as { plugins, bots } (source/shared/marketplace/catalog.ts), and
      // this cache feeds the Plugins tab; a flat array is accepted too so an older host still
      // draws chips instead of silently drawing none. marketplace-bots.js takes .bots the same way.
      categories: (Array.isArray(answer.categories) ? answer.categories : (answer.categories?.plugins ?? [])).map(String),
    };
    return marketplaceCatalogCache;
  }

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
  function marketplaceInstallState(items, cards) {
    const byId = new Map((Array.isArray(cards) ? cards : []).map((card) => [card.id, card]));
    return (Array.isArray(items) ? items : []).map((item) => {
      const kind = item?.kind === "shell-tool" ? "shell-tool" : "connector";
      const cardId = marketplaceCardId(item);
      const card = byId.get(cardId) ?? null;
      const installed = card != null && (kind === "shell-tool"
        ? card.shellTool?.installed === true
        : card.removable === true);
      const stored = new Set(Array.isArray(card?.storedFields) ? card.storedFields.map(String) : []);
      const missing = (Array.isArray(card?.secretFields) ? card.secretFields.map(String) : []).filter((field) => !stored.has(field));
      const needsAuth = installed && missing.length > 0;
      const ready = installed && !needsAuth && (card?.boxStatus === "connected" || card?.status === "connected");
      return {
        id: String(item?.id ?? ""),
        name: String(item?.name ?? item?.id ?? ""),
        kind,
        connectorName: kind === "connector" ? marketplaceConnectorName(item) : "",
        shellToolId: kind === "shell-tool" ? marketplaceShellToolId(item) : "",
        cardId,
        installed, needsAuth, ready,
        missingCredentials: missing,
        storedCredentials: [...stored],
        label: !installed ? "Not installed" : needsAuth ? "Needs auth" : ready ? "Ready" : "Connecting",
      };
    });
  }

  // Subscriptions already authenticated on this Mac (docs/SUBSCRIPTIONS-CONTRACT.md), shown as
  // plugin cards. A key provider that is not yet adopted renders as "installed", which is the one
  // state the handoff app draws with a secure input; the value goes to the relay's 0600 store and
  // never through chat. Codex and MiniMax adopt from their CLI stores on a typed "adopt".
  const SUB_CATEGORY = { key: "Provider · paste a key", endpoint: "Provider · CLI login", runtime: "Provider · next contract", none: "Provider · not usable here" };
  function subscriptionPlugins(rows, liveEndpointId) {
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
  // Every endpoint in the catalog, adopted subscriptions included, as a model-menu entry. The
  // switch is box-wide; the app's per-worker menu is the only affordance it offers for it.
  function endpointModels(live, catalog) {
    const rows = Array.isArray(catalog?.endpoints) ? catalog.endpoints : [];
    const available = rows.map((e) => ({ id: e.id, name: `${e.name} · ${e.model}`, provider: e.subscription ? "subscription" : e.baseUrl, context: e.contextWindow ? `${Math.round(e.contextWindow / 1000)}k` : "" }));
    const current = rows.find((e) => e.baseUrl === catalog?.live?.baseUrl && e.model === catalog?.live?.model);
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
  async function loadContext(context, name) {
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
    let outline = cached?.sig === sig ? cached.outline : null;
    if (outline == null) {
      outline = await call("getConversationOutline", { id: context.id }).catch(() => null);
      outlineCache.set(context.id, { sig, outline });
    }
    return {
      ...shapeWindow(context.id, name, outline),
      routines: routinesOf(automations, context),
      skills: skillsOf(workflows),
      channels: channels == null ? null : channelsOf(channels),
      handoff: box?.handoff ?? null,
      boxState: box?.state ?? null,
    };
  }

  // What loadContext read, onto the roster record it was read for. The transcript window and its
  // outline are the adapter's; the record carries what the views draw.
  function applyLoaded(r, loaded) {
    r.messages = loaded.messages;
    r.files = loaded.files;
    r.hasOlder = loaded.hasOlder;
    r.skills = loaded.skills;
    if (loaded.channels != null) r.channels = loaded.channels;
    r.handoff = loaded.handoff;
    r.boxState = loaded.boxState;
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
    const knownVersions = new Map([...(seed.workers ?? []), ...(seed.rooms ?? [])].filter((r) => r?.avatarVersion != null).map((r) => [r.id, r.avatarVersion]));
    const versions = new Map(await Promise.all(agents.map(async (a) => [a.id, a.avatarVersion ?? knownVersions.get(a.id) ?? await avatarVersionOf(a.id)])));
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
      skills: [], channels: null, handoff: null, boxState: null, hasOlder: false,
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
    const active = kept ?? { kind: workers[0] ? "worker" : "room", id: first.id };
    const activeRecord = (active.kind === "worker" ? workers : rooms).find((r) => r.id === active.id);
    const openContexts = (seed.openContexts ?? []).filter(exists).map((c) => ({ kind: c.kind, id: c.id }));
    if (!openContexts.some((c) => c.kind === active.kind && c.id === active.id)) openContexts.push(active);
    const loaded = await loadContext(active, activeRecord.name);
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
      // Providers first: they are what a user connects; the box's own connectors follow, then the
      // chat listeners the host reports.
      plugins: [...subscriptionPlugins(subscriptions, models.default), ...connectors, ...pluginsOf(integrations)],
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
    const rosterSig = () => [...state.workers, ...state.rooms].map((x) => `${x.id}:${x.status}:${x.needsYou ? 1 : 0}:${x.unread}:${x.preview}:${x.name}:${x.role}:${x.avatar}:${x.avatarShape ?? ""}:${x.hidden ? 1 : 0}:${x.notify ? 1 : 0}`).join("|") + `|${state.agentCount}`;
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
      const loaded = await loadContext(state.activeContext, r.name).catch(() => null);
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
      state.plugins = [...subscriptionPlugins(subscriptions, state.models.default), ...state.plugins.filter((p) => !String(p.id).startsWith("sub:"))];
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
        target.lastActivityAt = a.lastActivityAt ?? target.lastActivityAt;
        target.unread = Number(a.unreadCount) || 0;
        target.preview = typeof a.lastMessagePreview === "string" ? a.lastMessagePreview : target.preview;
        if (a.isGroup) target.memberIds = a.memberIds ?? target.memberIds;
      }
    }

    // A failed turn used to leave no trace in this UI at all: the transcript simply never grew.
    // The host records it as an error tray, so read those and say so in the conversation.
    const reportedTrays = new Set();
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
        owner.messages.push({
          id: `tray-${tray.id}`, authorId: "system", authorName: "Machine Room", type: "text",
          text: `That turn failed: ${tray.title ?? "error"}${tray.detail ? ` — ${tray.detail}` : ""}`,
          time: timeOf(Date.now()),
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
      try { loaded = await loadContext(state.activeContext, r.name); }
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
    try {
      // A 401 on this stream is invisible: EventSource exposes no status, only onerror. That is
      // fine here because the heartbeat below calls the gateway every 15 seconds and relayFetch
      // bounces to /login the first time one of those comes back unauthenticated.
      const events = new global.EventSource("/events");
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
        pending = global.setTimeout(() => { pending = null; reloadActive().catch(() => {}); }, 900);
      };
    } catch { /* no stream: the UI still works, it just will not update on its own */ }

    // Heartbeat. The stream is the fast path; this is what keeps status honest when nothing is
    // being said -- the same 15s cadence the old operator UI settled on.
    const heartbeat = global.setInterval(() => { void reloadActive().catch(() => {}); }, 15_000);

    return {
      getSnapshot: () => clone(state),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      destroy() { listeners.clear(); global.clearInterval(heartbeat); },
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
          applyLoaded(r, { ...shapeWindow(context.id, r.name, outlineCache.get(context.id)?.outline ?? null), skills: r.skills, channels: null, handoff: r.handoff, boxState: r.boxState });
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
        const load = loadContext(context, r.name).then(async (loaded) => {
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
      getSkills(agentId) {
        return call("getAgentWorkflows", { id: agentId }).then((list) => {
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

      // -- The box (GW-10). handBackForeverBox { id, trigger } -> session.endHandoff: the exit
      // from a request_box_help takeover, which had no button anywhere. Read back through
      // getForeverBoxStatus, whose `handoff` field is where pendingHandoff reaches the gateway.
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
          if (target) { target.handoff = status?.handoff ?? null; target.boxState = status?.state ?? target.boxState; }
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
          applyLoaded(r, { ...shapeWindow(context.id, r.name, outlineCache.get(context.id)?.outline ?? null), skills: r.skills, channels: null, handoff: r.handoff, boxState: r.boxState });
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
      addMarketplacePlugin(item, agentId) {
        if (item?.kind === "shell-tool") return this.installShellTool(marketplaceShellToolId(item), agentId);
        const entry = item?.install ?? {};
        if (typeof entry.command !== "string" || entry.command.length === 0) {
          return Promise.resolve({ accepted: false, message: "This catalog entry has no connector command; add it with the connector editor." });
        }
        return this.addConnector({
          name: marketplaceConnectorName(item),
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
        return CONNECTOR_PRESETS.map((preset) => ({
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
      listConnectors() {
        return connectorConfig().then((c) => Object.entries(c?.mcpServers ?? {}).map(([name, spec]) => ({
          name, command: spec?.command ?? null, argCount: Array.isArray(spec?.args) ? spec.args.length : 0,
          envNames: Object.keys(spec?.env ?? {}),
        })));
      },
      async addConnector(spec) {
        const name = String(spec?.name ?? "").trim();
        const command = String(spec?.command ?? "").trim();
        if (!name) return { accepted: false, message: "A connector needs a name." };
        if (!command) return { accepted: false, message: "A stdio connector needs a command; the relay rejects one without it." };
        // SECRET-2: the reserved destination name. A secret card whose connector is "shell" means
        // the agent's own box shell environment, so a connector called that could never be handed
        // a credential. The host and the relay refuse it too; saying so here is what makes the
        // refusal readable instead of a 400.
        if (name.toLowerCase() === "shell") {
          return { accepted: false, message: '"shell" is reserved for the agent\'s own box shell environment, so a connector cannot use that name. Rename it (for example shell-mcp) and add it again.' };
        }
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
      async removeConnector(name) {
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
      // Skip for now, and the close at the end of the interview. Whatever Titan captured goes with
      // it, so a person who skips halfway keeps the answers they already gave.
      completeOnboarding(answers) {
        return call("completeOnboarding", { answers: answers ?? {} });
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
