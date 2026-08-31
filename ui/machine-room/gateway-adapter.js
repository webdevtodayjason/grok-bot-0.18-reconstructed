/*
 * Gateway-backed adapter for the Machine Room frontend.
 * ----------------------------------------------------
 * The handoff README asks that the DOM and event layer stay unchanged and that only the adapter
 * be replaced. So this file loads after adapter.js and takes over the factory app.js already
 * calls; app.js and adapter.js are byte-identical to the handoff. The demo factory is kept as
 * createDemoAdapterOffline so the prototype still runs with no gateway behind it.
 *
 * Two rules this file holds to, because the alternative is a UI that lies:
 *   - A method with no backend behind it yet says so, on screen. It never reports success.
 *   - submitSecret refuses outright. Telling someone a credential was stored when it was not is
 *     worse than any missing feature.
 */
(function attachGatewayAdapter(global) {
  "use strict";

  const demoFactory = global.createDemoAdapter;
  global.createDemoAdapterOffline = demoFactory;

  async function call(method, args = {}) {
    const r = await fetch(`/api/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) throw new Error(body?.error ?? `${method} failed (${r.status})`);
    return body;
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
    if (m.type === "widget" && m.widget) return {
      kind: "widget", requestId: null, status: "pending",
      title: m.widget.prompt || "The agent asked you a question",
      detail: "", rule: null,
      options: Array.isArray(m.widget.options) ? m.widget.options : [],
    };
    // Still refused, but silently dropping it meant the operator never learned it had been asked.
    if (m.type === "secret-request") return {
      kind: "secret", requestId: null, status: "pending",
      title: "The agent asked for a credential",
      detail: "This UI will not carry a secret. Answer it in the host app.", rule: null, options: [],
    };
    return null;
  }

  function messagesOf(transcript, fallbackName) {
    return (transcript ?? [])
      .filter((e) => e.kind === "send-message" || (e.kind === "message" && e.role === "user"))
      .map((e, i) => {
        const mine = e.kind !== "send-message";
        const card = mine ? null : cardOf(e);
        const text = e.kind === "send-message"
          ? (typeof e.message?.content === "string" ? e.message.content : "")
          : (typeof e.content === "string" ? e.content : e.content?.map?.((c) => c.text ?? "").join("") ?? "");
        return {
          id: e.id ?? `entry-${i}`,
          authorId: mine ? "you" : (e.author?.id ?? "agent"),
          authorName: mine ? "You" : (e.author?.name ?? fallbackName),
          type: card ? "decision" : "text",
          ...(card ? { card } : {}),
          text: String(text).trim(),
          time: timeOf(Number(e.timestampMs ?? e.createdAt)),
        };
      })
      .filter((m) => m.text || m.card);
  }

  // Agents the host is currently raising an error tray for. Rebuilt each pass, never accumulated:
  // a tray the operator cleared has to stop colouring the roster.
  const attentionIds = new Set();

  function statusOf(agent) {
    if (agent.isRunning) return { status: "working", statusText: "Working now" };
    // The third real state the old operator UI has and this one discarded: blocked on you.
    if (agent.awaitingUserResponse || attentionIds.has(agent.id)) {
      return {
        status: "attention",
        statusText: agent.awaitingUserResponse ? "Waiting on you" : "The last turn failed",
      };
    }
    return { status: "ready", statusText: agent.description || "Ready for the next task" };
  }

  // The automation record carries triggerDescription, schedule, isEnabled, lastRunAt and a runs[]
  // array that is NEWEST FIRST. Reading runs[length - 1] reports the oldest run as the latest, and
  // the status vocabulary is "ok", not the demo's "passed".
  const RUN_OK = new Set(["ok", "success", "completed", "passed"]);

  function lastRunOf(automation) {
    const runs = Array.isArray(automation.runs) ? automation.runs : [];
    if (runs.length === 0) return null;
    const newest = runs.reduce((best, run) =>
      (run.startedAt ?? 0) > (best.startedAt ?? 0) ? run : best, runs[0]);
    const ms = Number(newest.finishedAt) - Number(newest.startedAt);
    return {
      // Report the host's own word when it is not one we recognise, rather than mapping an unknown
      // outcome onto "passed" and telling the operator a run succeeded.
      status: RUN_OK.has(newest.status) ? "passed" : (newest.status ?? "unknown"),
      // A real measured duration: the host stamps both ends of the run.
      duration: Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : "",
      at: newest.finishedAt ?? newest.startedAt ?? null,
      trigger: newest.trigger ?? null,
    };
  }

  function routinesOf(list, scope) {
    return (list ?? []).map((a) => ({
      id: `${scope.id}::${a.id}`,
      name: a.name ?? a.id,
      scope,
      // The gateway has no coordinator or delegate on an automation. This was the agent you
      // happened to have open, rendered as "coordinates · <name>" -- a routing fact nobody set.
      coordinatorId: null,
      delegatedToId: null,
      trigger: a.triggerDescription ?? a.trigger?.summary ?? a.summary ?? "On a schedule",
      instruction: a.prompt ?? a.instruction ?? "",
      status: a.isEnabled === false ? "paused" : "ready",
      nextRunAt: a.nextRunAt ?? null,
      // The host stamps this; the island had nothing else to say but "moments ago".
      lastRunAt: a.lastRunAt ?? null,
      lastRun: lastRunOf(a),
    }));
  }

  // Integrations are the closest real thing to the prototype's plugin cards. Tool lists and
  // per-tool switches are not in the gateway yet, so the cards render with no tools rather than
  // with invented ones.
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
        tools: [],
        skills: [],
      };
    });
  }

  async function loadContext(context, name) {
    const [transcript, automations] = await Promise.all([
      call("getAgentTranscript", { id: context.id }).catch(() => null),
      call("getAgentAutomations", { id: context.id }).catch(() => null),
    ]);
    const latestAgentMs = (transcript ?? [])
      .filter((e) => e.kind === "send-message")
      .reduce((n, e) => Math.max(n, Number(e.timestampMs) || 0), 0);
    return { messages: messagesOf(transcript, name), routines: routinesOf(automations, context), latestAgentMs };
  }

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
  };

  async function hydrate(seed) {
    const [agents, integrations] = await Promise.all([
      call("listAgents"),
      call("getListenerIntegrations").catch(() => null),
    ]);

    // Ask the box what it is actually running before stamping any worker with a model name. This
    // used to happen after shape(), so workers wore the seed's default while the picker showed the
    // truth -- two numbers on one screen disagreeing about the same fact.
    let models = seed.models;
    try {
      const live = await (await fetch("/model")).json();
      if (live?.model) models = { default: live.model, available: [{ id: live.model, name: live.model, provider: live.endpoint ?? "box", context: "" }] };
    } catch { /* the model probe is a convenience, not a dependency */ }

    const shape = (a) => ({
      id: a.id,
      name: a.name ?? "Untitled",
      // The host's own per-agent role field. Empty is the honest answer when it is unset.
      role: (typeof a.title === "string" && a.title.trim()) || (a.isGroup ? "Group chat" : "not set"),
      ...statusOf(a),
      // Real face when the host has one. It does not on this box -- no avatarDataUrl, no colour,
      // no shape -- and /avatars/<id> 404s, so pointing at it just broke every image. The vendored
      // SVGs are placeholders, but the mapping is a stable hash of the id, so a worker keeps the
      // same face across reloads rather than swapping faces with its neighbour.
      avatar: a.avatarDataUrl || pick(AVATARS, a.id),
      accent: pick(ACCENTS, a.id),
      model: models?.default ?? "default",
      files: [],
      browser: { label: `${a.name} desktop`, url: "" },
      messages: [],
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

    const first = workers[0] ?? rooms[0];
    if (!first) return { ...seed, workers: [], rooms: [], routines: [], plugins: pluginsOf(integrations), openContexts: [] };

    const active = { kind: workers[0] ? "worker" : "room", id: first.id };
    const loaded = await loadContext(active, first.name);
    first.messages = loaded.messages;

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
      activeContext: active,
      openContexts: [active],
      workers, rooms,
      routines: Array.isArray(everyAutomation) && everyAutomation.length
        ? everyAutomation.flatMap((entry) => {
            const owner = agents.find((a) => a.id === entry.agentId);
            if (!owner) return [];
            return routinesOf([entry.automation], { kind: owner.isGroup ? "room" : "worker", id: owner.id });
          })
        : loaded.routines,
      plugins: pluginsOf(integrations),
      models,
    };
  }

  function createGatewayAdapter(state) {
    const listeners = new Set();
    // app.js drives the "working" bubble from simulateReply's 1.15s timer, which is right for a
    // demo and wrong for a machine: a real reply takes tens of seconds, so the dots flashed and
    // died and the wait happened in silence. The adapter owns that bubble's lifetime instead --
    // it lives from send until the worker actually speaks. Capped, so it can never spin forever
    // on a turn that died.
    const awaiting = new Map();
    const AWAIT_CAP_MS = 5 * 60_000;
    const keyOf = (c) => `${c.kind}:${c.id}`;
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const same = (a, b) => Boolean(a && b && a.kind === b.kind && a.id === b.id);
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
      r.messages.push({ id: wait.id, authorId: wait.authorId, authorName: wait.authorName, type: "working", text: "", time: "" });
    }

    async function reloadRoster() {
      const agents = await call("listAgents").catch(() => null);
      if (!agents) return;
      for (const a of agents) {
        const target = (a.isGroup ? state.rooms : state.workers).find((x) => x.id === a.id);
        if (!target) continue;
        const next = statusOf(a);
        target.status = next.status;
        target.statusText = next.statusText;
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

    async function reloadActive() {
      // Trays first: reloadRoster stamps every status through statusOf, which needs the tray set
      // already current. The other order let the roster paint over attention on every tick.
      await reloadTrays();
      await reloadRoster();
      const r = record(state.activeContext);
      if (!r) return;
      const loaded = await loadContext(state.activeContext, r.name);
      r.messages = loaded.messages;
      applyAwaiting(state.activeContext, r, loaded.latestAgentMs);
      state.routines = [
        ...state.routines.filter((x) => !same(x.scope, state.activeContext)),
        ...loaded.routines,
      ];
      emit("message:created", { context: state.activeContext });
    }

    // The gateway pushes; this adapter pulls what changed. Re-reading the active transcript on
    // every event is cheap next to a turn, and it means a reply from any surface shows up here.
    let pending = null;
    try {
      const events = new EventSource("/events");
      events.onmessage = () => {
        if (pending) return;
        pending = setTimeout(() => { pending = null; reloadActive().catch(() => {}); }, 400);
      };
    } catch { /* no stream: the UI still works, it just will not update on its own */ }

    // Heartbeat. The stream is the fast path; this is what keeps status honest when nothing is
    // being said -- the same 15s cadence the old operator UI settled on.
    setInterval(() => { void reloadActive().catch(() => {}); }, 15_000);

    return {
      getSnapshot: () => clone(state),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      destroy() { listeners.clear(); },

      selectContext(input, maybeId) {
        const context = typeof input === "object" ? { kind: input.kind, id: input.id } : { kind: input, id: maybeId };
        const r = record(context);
        if (!r) return clone(state);
        state.activeContext = context;
        if (!state.openContexts.some((c) => same(c, context))) state.openContexts.push(context);
        const snapshot = emit("context:selected", { context });
        loadContext(context, r.name).then((loaded) => {
          r.messages = loaded.messages;
          applyAwaiting(context, r, loaded.latestAgentMs);
          state.routines = [...state.routines.filter((x) => !same(x.scope, context)), ...loaded.routines];
          emit("message:created", { context });
        }).catch(() => {});
        return snapshot;
      },

      sendMessage(input, text) {
        const context = typeof input === "object" ? { kind: input.kind, id: input.id } : state.activeContext;
        const clean = String(text || "").trim();
        const r = record(context);
        if (!r || !clean) return null;
        r.messages.push({
          id: `local-${Date.now()}`, authorId: "you", authorName: "You",
          type: "text", text: clean, time: timeOf(Date.now()),
        });
        r.status = "working"; r.statusText = "Working now";
        const wait = { sentAtMs: Date.now(), id: `working-${Date.now()}`, authorId: context.id, authorName: r.name };
        awaiting.set(keyOf(context), wait);
        r.messages.push({ id: wait.id, authorId: wait.authorId, authorName: wait.authorName, type: "working", text: "", time: "" });
        const snapshot = emit("message:created", { context });
        call("sendPrompt", { agentId: context.id, prompt: clean })
          .then(() => reloadActive())
          .catch((error) => {
            // We know it failed. Leaving the dots up for five minutes turns a known failure into
            // an apparent silence, which is the harder thing to diagnose.
            awaiting.delete(keyOf(context));
            r.messages = r.messages.filter((m) => m.id !== wait.id);
            r.status = "attention";
            r.statusText = "The last message did not reach the gateway";
            notWired(`Sending failed: ${error.message}`);
          });
        return snapshot;
      },

      addWorker(worker) {
        const name = worker?.name?.trim();
        if (!name) return Promise.reject(new Error("a name is required"));
        return call("createAgent", { name, description: worker.role ?? "" })
          .then(async (result) => {
            state = await hydrate(state);
            emit("worker:created", { name });
            return result?.agent ?? { name };
          })
          .catch((error) => { notWired(`Creating a worker failed: ${error.message}`); throw error; });
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
            emit("room:created", { name });
            return result?.agent ?? { name };
          })
          .catch((error) => { notWired(`Creating a room failed: ${error.message}`); throw error; });
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
          notWired(`Adding a member failed: ${error.message}`);
        });
        return snapshot;
      },

      removeMember(roomId, workerId) {
        const room = state.rooms.find((r) => r.id === roomId);
        if (!room) return clone(state);
        // A room with no members takes no turns. The old operator UI refuses the same way.
        if (room.memberIds.length <= 1) return notWired("A room needs at least one member");
        const before = [...room.memberIds];
        const memberIds = room.memberIds.filter((id) => id !== workerId);
        room.memberIds = memberIds;
        const snapshot = emit("room:member-removed", { roomId, workerId });
        call("setGroupMembers", { id: roomId, memberAgentIds: memberIds }).catch((error) => {
          room.memberIds = before;
          emit("room:member-removed", { roomId, workerId });
          notWired(`Removing a member failed: ${error.message}`);
        });
        return snapshot;
      },

      // createAgentAutomation { id, spec } with spec { name, prompt, trigger, isEnabled } -- the
      // same shape the old operator UI builds, and the same shape getAgentAutomations hands back,
      // so it round-trips. The host validates the cron and computes nextRunAt; nothing is reported
      // until that comes back.
      createRoutine(agentId, kind, spec) {
        return call("createAgentAutomation", { id: agentId, spec })
          .then(() => call("getAgentAutomations", { id: agentId }))
          .then((list) => {
            const scope = { kind, id: agentId };
            const shaped = routinesOf(list ?? [], scope);
            state.routines = [...state.routines.filter((x) => !same(x.scope, scope)), ...shaped];
            emit("routine:created", { agentId });
            return shaped.find((r) => r.name === spec.name) ?? shaped[shaped.length - 1];
          });
      },

      runRoutine(routineId) {
        // The view awaits this and reads lastRun.duration off what it resolves with, so the
        // duration is measured rather than invented -- a routine that took nine seconds should
        // not report the demo's cheerful 2.2s.
        const routine = state.routines.find((r) => r.id === routineId);
        if (!routine) return Promise.resolve(null);
        // Routine ids are namespaced by scope so two workers can hold the same automation name;
        // the gateway wants the bare id back.
        const [agentId, automationId] = routineId.split("::");
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
            notWired(`${routine.name} could not run: ${error.message}`);
            throw error;
          });
      },

      setRunPaused(paused) {
        // Presentation only: this pauses the operator's view of the desktop, not the worker.
        state.desktop.paused = Boolean(paused);
        return emit("desktop:pause", { paused: state.desktop.paused });
      },

      // -- No backend behind these yet. They say so rather than pretending. ------------------
      submitSecret() { return notWired("The secure credential bridge"); },
      setPluginState(pluginId, status) {
        const plugin = state.plugins.find((p) => p.id === pluginId);
        if (!plugin) return clone(state);
        const platform = plugin.id;
        if (status === "available" || status === "disconnect") {
          call("disconnectChannel", { platform })
            .then(() => hydrate(state)).then((next) => { state = next; emit("plugin:state", { pluginId, status: "available" }); })
            .catch((error) => notWired(`Disconnecting ${plugin.name} failed: ${error.message}`));
          return clone(state);
        }
        // The credential never reaches this page. The host returns the platform's own consent URL,
        // the operator approves there, and the channel binds host-side -- which is why this opens
        // a tab rather than collecting anything.
        call("getListenerConnectUrl", { platform })
          .then((answer) => {
            const url = answer?.url;
            if (!url) return notWired(`${plugin.name} returned no connect URL`);
            global.open(url, "_blank", "noopener");
            const r = record(state.activeContext);
            if (r) r.messages.push({
              id: `connect-${Date.now()}`, authorId: "system", authorName: "Machine Room", type: "system",
              text: `Approve ${plugin.name} in the tab that just opened. The connection completes on the host, not here.`,
              time: timeOf(Date.now()),
            });
            emit("plugin:state", { pluginId, status: "connecting" });
          })
          .catch((error) => notWired(`Connecting ${plugin.name} failed: ${error.message}`));
        return clone(state);
      },
      togglePluginTool() { return notWired("Per-tool permissions"); },
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
            .catch((error) => { card.status = "pending"; notWired(`That answer did not reach the host: ${error.message}`); });
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
        return notWired("Answering a credential request from this UI");
      },
      setModel() { return notWired("Per-worker model routing"); },
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
          .catch((error) => { notWired(`Review policy could not be saved: ${error.message}`); throw error; });
      },
      startTeaching(workerId) {
        const id = workerId ?? state.activeContext?.id;
        const worker = state.workers.find((w) => w.id === id);
        if (!worker) return clone(state);
        state.teaching = { active: true, workerId: id, startedAt: Date.now() };
        const snapshot = emit("teaching:started", { workerId: id });
        call("startTeachRecording", { agentId: id })
          .then((status) => {
            // Trust the host's clock, not ours: the elapsed time an operator reads has to be the
            // recording's, or a ten-minute cap arrives sooner than the timer says it will.
            state.teaching = {
              active: status?.state === "recording",
              workerId: status?.agentId ?? id,
              startedAt: status?.startedAtMs ?? Date.now(),
              maxDurationMs: status?.maxDurationMs ?? null,
            };
            emit("teaching:started", { workerId: id });
          })
          .catch((error) => {
            state.teaching = { active: false, workerId: null, startedAt: null };
            emit("teaching:finished", { workerId: id });
            notWired(`Recording could not start: ${error.message}`);
          });
        return snapshot;
      },

      finishTeaching(save = true) {
        const id = state.teaching?.workerId ?? state.activeContext?.id;
        state.teaching = { active: false, workerId: null, startedAt: null };
        const snapshot = emit("teaching:finished", { workerId: id });
        if (!id) return snapshot;
        // save:true is what queues demo.mp4 and dispatches the learning prompt. The agent's reply
        // arrives through the transcript like any other turn, so nothing is fabricated here.
        call("stopTeachRecording", { agentId: id, save })
          .then(() => reloadActive())
          .catch((error) => notWired(`Recording could not be saved: ${error.message}`));
        return snapshot;
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
