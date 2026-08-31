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
  function messagesOf(transcript, fallbackName) {
    return (transcript ?? [])
      .filter((e) => e.kind === "send-message" || (e.kind === "message" && e.role === "user"))
      .map((e, i) => {
        const mine = e.kind !== "send-message";
        const text = e.kind === "send-message"
          ? (typeof e.message?.content === "string" ? e.message.content : "")
          : (typeof e.content === "string" ? e.content : e.content?.map?.((c) => c.text ?? "").join("") ?? "");
        return {
          id: e.id ?? `entry-${i}`,
          authorId: mine ? "you" : (e.author?.id ?? "agent"),
          authorName: mine ? "You" : (e.author?.name ?? fallbackName),
          type: "text",
          text: String(text).trim(),
          time: timeOf(Number(e.timestampMs ?? e.createdAt)),
        };
      })
      .filter((m) => m.text);
  }

  function statusOf(agent) {
    if (agent.isRunning) return { status: "working", statusText: "Working now" };
    return { status: "ready", statusText: agent.description || "Ready for the next task" };
  }

  function routinesOf(list, scope) {
    return (list ?? []).map((a) => ({
      id: `${scope.id}::${a.id}`,
      name: a.name ?? a.id,
      scope,
      coordinatorId: scope.id,
      delegatedToId: null,
      trigger: a.trigger?.summary ?? a.summary ?? "On a schedule",
      instruction: a.prompt ?? a.instruction ?? "",
      status: a.enabled === false ? "paused" : "ready",
      nextRunAt: a.nextRunAt ?? null,
      lastRun: a.runs?.length
        ? { status: a.runs[a.runs.length - 1].status ?? "passed", duration: "" }
        : null,
    }));
  }

  // Integrations are the closest real thing to the prototype's plugin cards. Tool lists and
  // per-tool switches are not in the gateway yet, so the cards render with no tools rather than
  // with invented ones.
  function pluginsOf(raw) {
    const list = Array.isArray(raw) ? raw
      : Array.isArray(raw?.platforms) ? raw.platforms
      : Array.isArray(raw?.connections) ? raw.connections : [];
    return list.map((p) => {
      const name = p.name ?? p.platform ?? p.id ?? "Connector";
      return {
        id: String(p.id ?? p.platform ?? name).toLowerCase(),
        name: name[0].toUpperCase() + name.slice(1),
        icon: name[0].toUpperCase(),
        category: "Connector",
        description: p.description ?? "Connected through the host listener.",
        status: (p.isConnected ?? p.connected) ? "connected" : "available",
        account: p.account ?? null,
        secretField: "OAuth connection",
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
    settings: {
      autoReview: {
        enabled: true,
        rule: "Approve read-only tools. Ask me before external writes, purchases, deletions, or sending messages.",
      },
    },
    desktop: {
      paused: false,
      timeline: [
        { label: "Opened the active context", status: "done" },
        { label: "Loaded shared working state", status: "done" },
        { label: "Reviewing the current task", status: "active" },
        { label: "Return outcome to conversation", status: "pending" },
      ],
    },
    teaching: { active: false, workerId: null, startedAt: null },
  };

  async function hydrate(seed) {
    const [agents, integrations] = await Promise.all([
      call("listAgents"),
      call("getListenerIntegrations").catch(() => null),
    ]);

    const shape = (a) => ({
      id: a.id,
      name: a.name ?? "Untitled",
      role: a.description || (a.isGroup ? "Group chat" : "Worker"),
      ...statusOf(a),
      avatar: pick(AVATARS, a.id),
      accent: pick(ACCENTS, a.id),
      model: seed.models?.default ?? "default",
      files: [],
      browser: { label: `${a.name} desktop`, url: "" },
      messages: [],
      lastActivityAt: a.lastActivityAt ?? 0,
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

    let models = seed.models;
    try {
      const live = await (await fetch("/model")).json();
      if (live?.model) models = { default: live.model, available: [{ id: live.model, name: live.model, provider: live.endpoint ?? "box", context: "" }] };
    } catch { /* the model probe is a convenience, not a dependency */ }

    return {
      ...seed,
      activeContext: active,
      openContexts: [active],
      workers, rooms,
      routines: loaded.routines,
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
        type: "text", text: `${what} is not wired to the gateway yet.`, time: timeOf(Date.now()),
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

    async function reloadActive() {
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
          .catch((error) => notWired(`Sending failed: ${error.message}`));
        return snapshot;
      },

      addWorker(worker) {
        const name = worker?.name?.trim();
        if (!name) return clone(state);
        call("createAgent", { name, description: worker.role ?? "" })
          .then(() => hydrate(state)).then((next) => { state = next; emit("worker:created", { name }); })
          .catch((error) => notWired(`Creating a worker failed: ${error.message}`));
        return clone(state);
      },

      addRoom(room) {
        const name = room?.name?.trim();
        if (!name) return clone(state);
        call("createGroup", { name, memberIds: room.memberIds ?? [] })
          .then(() => hydrate(state)).then((next) => { state = next; emit("room:created", { name }); })
          .catch((error) => notWired(`Creating a room failed: ${error.message}`));
        return clone(state);
      },

      addMember(roomId, workerId) {
        const room = state.rooms.find((r) => r.id === roomId);
        if (!room || room.memberIds.includes(workerId)) return clone(state);
        const memberIds = [...room.memberIds, workerId];
        room.memberIds = memberIds;
        const snapshot = emit("room:member-added", { roomId, workerId });
        call("setGroupMembers", { id: roomId, memberIds }).catch((error) => notWired(`Adding a member failed: ${error.message}`));
        return snapshot;
      },

      removeMember(roomId, workerId) {
        const room = state.rooms.find((r) => r.id === roomId);
        if (!room) return clone(state);
        const memberIds = room.memberIds.filter((id) => id !== workerId);
        room.memberIds = memberIds;
        const snapshot = emit("room:member-removed", { roomId, workerId });
        call("setGroupMembers", { id: roomId, memberIds }).catch((error) => notWired(`Removing a member failed: ${error.message}`));
        return snapshot;
      },

      runRoutine(routineId) {
        const routine = state.routines.find((r) => r.id === routineId);
        if (!routine) return clone(state);
        // Routine ids are namespaced by scope here so two workers can hold the same automation
        // name; the gateway wants the bare id back.
        const [agentId, automationId] = routineId.split("::");
        routine.status = "running";
        const snapshot = emit("routine:started", { routineId });
        call("runAgentAutomationNow", { id: agentId, automationId })
          .then(() => { routine.status = "ready"; routine.lastRun = { status: "passed", duration: "" }; emit("routine:completed", { routineId }); })
          .catch((error) => { routine.status = "ready"; notWired(`Test run failed: ${error.message}`); });
        return snapshot;
      },

      setRunPaused(paused) {
        // Presentation only: this pauses the operator's view of the desktop, not the worker.
        state.desktop.paused = Boolean(paused);
        return emit("desktop:pause", { paused: state.desktop.paused });
      },

      // -- No backend behind these yet. They say so rather than pretending. ------------------
      submitSecret() { return notWired("The secure credential bridge"); },
      setPluginState() { return notWired("Installing and connecting plugins"); },
      togglePluginTool() { return notWired("Per-tool permissions"); },
      decideApproval() { return notWired("Approval cards"); },
      setModel() { return notWired("Per-worker model routing"); },
      setAutoReview() { return notWired("Auto-review rules"); },
      startTeaching() { return notWired("Teaching from a demonstration"); },
      finishTeaching() { return notWired("Teaching from a demonstration"); },

      // The view layer calls these directly for local echo; keep them local.
      addMessage(context, message) {
        const target = context ?? state.activeContext;
        const r = record(target);
        if (!r) return null;
        const fabricated = message.type === "text" && message.authorId && message.authorId !== "you";
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
