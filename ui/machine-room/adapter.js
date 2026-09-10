/*
 * Warmwind frontend adapter contract
 * ----------------------------------
 * A context is either { kind: "worker", id } for a direct agent conversation,
 * or { kind: "room", id } for a multi-agent group chat. Rooms never represent
 * direct messages. Files, browser sessions, and routines resolve through the
 * active context; plugins and creation remain global.
 *
 * SECURITY: submitSecret receives a credential only long enough to hand it to
 * a secure native bridge. This demo intentionally discards the value. A real
 * adapter must never add it to messages, application state, analytics, or logs.
 */
(function attachAdapter(global) {
  "use strict";

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function timeLabel() {
    return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date());
  }

  function normalizeContext(contextOrKind, maybeId) {
    if (typeof contextOrKind === "object" && contextOrKind) {
      return { kind: contextOrKind.kind, id: contextOrKind.id };
    }
    return { kind: contextOrKind, id: maybeId };
  }

  function sameContext(left, right) {
    return Boolean(left && right && left.kind === right.kind && left.id === right.id);
  }

  function createDemoAdapter(initialState) {
    const state = clone(initialState);
    const listeners = new Set();
    const timers = new Set();

    // JOBBUS-3: the Job bus card with no relay and no gateway behind it (docs/JOB-BUS.md §7,
    // hardened by §10.7). A bus with no token has never been called, so it carries no jobs;
    // generating one here mints a value that exists only in this tab and reaches no file, which
    // is why the card's warning says so on this path. Generating also arms `enabled`, the same
    // way the gateway adapter does, because §10.7 makes those one act.
    //
    // The settings are the shape §10.7 fixes, with `workers` holding an AGENT ID out of the demo
    // roster rather than a name: the card resolves an id to the agent's name for the select, and
    // a demo that stored a name would let that half of the card pass untested. The two jobs are
    // the shapes the table has to draw: a done job with a result line, and one stopped on a
    // human. Both name the per-job clone (§10.2) and the agent it was cloned from.
    const jobBus = {
      configured: false,
      source: null,
      base_url: `${(global.location && global.location.origin) || "https://your-console"}/v1`,
      settings: {
        enabled: false,
        workers: { "nextgen.chapter": "clientsync" },
        repos: ["webdevtodayjason/nextgen-training"],
        allowedConnectors: ["github"],
        timeoutMin: 120,
        queueTimeoutMin: 60,
        maxOpen: 20,
        // 10.9: the operator switch behind policy.require_attestation, and what the host says about
        // the files it read at start. Both are drawn by the card, so the offline gate sees them.
        allowUnattested: false,
        integrity: { ok: true, detail: "", quarantined: [] },
      },
      jobs: [
        {
          id: "job_m4k2x9q7a1b3c5d7e9f1",
          type: "nextgen.chapter",
          status: "needs_human",
          idempotency_key: "c05-ch3-2026-09-05",
          worker: { agentId: "clone-e9f1", sourceAgentId: "clientsync", agentName: "ClientSync Tester · job d7e9f1" },
          created_at: "2026-09-05T22:41:00.000Z",
          result: null,
          needs_human: { reason: "github_auth", detail: "gh could not authenticate in the sandbox. Add a GitHub credential and re-submit." },
        },
        {
          id: "job_m4k1p2r4t6v8w0y2z4a6",
          type: "nextgen.chapter",
          status: "done",
          idempotency_key: "c05-ch2-2026-09-05",
          worker: { agentId: "clone-z4a6", sourceAgentId: "clientsync", agentName: "ClientSync Tester · job y2z4a6" },
          created_at: "2026-09-05T21:12:00.000Z",
          result: { summary: "Course 05 Ch2 notes on main", commits: ["4f1c0b9d2e6a8c3b5d7f9a1c3e5b7d9f1a3c5e7b"], artifacts: [{ path: "notes/c05/02-intro.md", bytes: 18000, sha256: "0f2e" }] },
          needs_human: null,
        },
      ],
    };
    const demoToken = () => Array.from({ length: 48 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

    // Agent email (docs/MAIL.md), the same shape the relay answers with so the card is one piece
    // of code here too. The two secrets are booleans in this demo for the same reason they are
    // booleans on the relay: nothing on this page can read one back.
    const mail = {
      enabled: false,
      domain: "titanium.bot",
      fromName: "Titanium Bot",
      apiBase: "https://api.resend.com",
      catchAllAgentId: "",
      routes: {},
      apiKeySet: false,
      webhookSecretSet: false,
      recent: [
        {
          at: "2026-09-06T21:04:00.000Z", email_id: "em_demo2", message_id: "<b@client.test>",
          from: "jane@client.test", to: "books@titanium.bot", subject: "September invoice",
          agentId: "books", agentName: "Books", outcome: "delivered",
        },
        {
          at: "2026-09-06T18:22:00.000Z", email_id: "em_demo1", message_id: "<a@client.test>",
          from: "noreply@vendor.test", to: "sales@titanium.bot", subject: "Your renewal quote",
          agentId: "", agentName: "", outcome: "no_route",
        },
      ],
    };

    // ONBOARD-1: the first-run setup with Titan, in this page only. A live box answers
    // getOnboardingState out of its own settings; there is no box here, so the fixture is armed
    // deliberately -- ?onboarding=1 on the URL, or window.__machineRoomOnboardingDemo set before
    // boot -- and every other offline view of this console opens the way it always did.
    function onboardingArmed() {
      if (global.__machineRoomOnboardingDemo === true) return true;
      try { return new URLSearchParams(global.location.search).get("onboarding") === "1"; } catch { return false; }
    }
    const onboarding = { done: !onboardingArmed(), startedAt: null, answers: {} };
    // Armed, the roster has to look like the box the dialog is really for: a first agent called
    // Titan whose conversation has not started. Leaving the seeded conversation under it would
    // have the first-run dialog open on four days of somebody else's chat, which is not the thing
    // being shown. The id is left alone, so the rooms and routines that point at it still resolve.
    if (!onboarding.done && state.workers.length > 0) {
      state.workers[0].name = "Titan";
      state.workers[0].messages = [];
      state.workers[0].preview = "";
      state.workers[0].unread = 0;
    }


    // The shape both mail routes answer with. The addresses come off the roster, so adding an
    // agent in the demo adds its address here, which is what the relay does with the real one.
    function mailShape() {
      const origin = (global.location && global.location.origin) || "https://your-console";
      return {
        enabled: mail.enabled,
        domain: mail.domain,
        fromName: mail.fromName,
        apiBase: mail.apiBase,
        catchAllAgentId: mail.catchAllAgentId,
        routes: clone(mail.routes),
        apiKeySet: mail.apiKeySet,
        webhookSecretSet: mail.webhookSecretSet,
        webhookUrl: `${origin}/hooks/resend`,
        // The same normalization the relay uses (ui/mail-edge.mjs agentLocalpart), so this page
        // shows the address that would really route.
        addresses: mail.domain
          ? state.workers.filter((worker) => !worker.isGroup).map((worker) => {
            const localpart = String(worker.name).toLowerCase()
              .replace(/[\s-]+/g, "").replace(/[^a-z0-9._]+/g, "").replace(/^[._]+|[._]+$/g, "");
            return { agentId: worker.id, name: worker.name, address: localpart ? `${localpart}@${mail.domain}` : "", note: "" };
          })
          : [],
        recent: clone(mail.recent),
      };
    }

    function emit(type, detail) {
      const event = { type, detail: clone(detail || {}), snapshot: clone(state) };
      listeners.forEach((listener) => listener(event));
      return event.snapshot;
    }

    function workerById(workerId) {
      return state.workers.find((worker) => worker.id === workerId);
    }

    function roomById(roomId) {
      return state.rooms.find((room) => room.id === roomId);
    }

    function pluginById(pluginId) {
      return state.plugins.find((plugin) => plugin.id === pluginId);
    }

    function contextExists(context) {
      return context.kind === "worker" ? Boolean(workerById(context.id)) : context.kind === "room" ? Boolean(roomById(context.id)) : false;
    }

    function contextRecord(context) {
      return context.kind === "worker" ? workerById(context.id) : roomById(context.id);
    }

    function contextMessages(context) {
      const record = contextRecord(context);
      return record ? record.messages : null;
    }

    function ensureOpenContext(context) {
      state.openContexts = state.openContexts || [];
      if (!state.openContexts.some((item) => sameContext(item, context))) state.openContexts.push(clone(context));
    }

    function addTimer(callback, delay) {
      const timer = global.setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
      return timer;
    }

    return {
      getSnapshot() {
        return clone(state);
      },

      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },

      destroy() {
        timers.forEach((timer) => global.clearTimeout(timer));
        timers.clear();
        listeners.clear();
      },

      selectContext(contextOrKind, maybeId) {
        const context = normalizeContext(contextOrKind, maybeId);
        if (!contextExists(context)) return clone(state);
        state.activeContext = context;
        ensureOpenContext(context);
        return emit("context:selected", { context });
      },

      sendMessage(contextInput, text) {
        const context = normalizeContext(contextInput);
        const messages = contextMessages(context);
        const cleanText = String(text || "").trim();
        if (!messages || !cleanText) return null;
        const message = {
          id: uid("message"),
          authorId: "you",
          authorName: "You",
          type: "text",
          text: cleanText,
          time: timeLabel(),
          status: "sent",
        };
        messages.push(message);
        emit("message:created", { context, message });
        return clone(message);
      },

      addMessage(contextInput, message) {
        const context = normalizeContext(contextInput);
        const messages = contextMessages(context);
        if (!messages) return null;
        const completeMessage = {
          id: message.id || uid("message"),
          time: message.time || timeLabel(),
          type: "text",
          ...clone(message),
        };
        messages.push(completeMessage);
        emit("message:created", { context, message: completeMessage });
        return clone(completeMessage);
      },

      removeMessage(contextInput, messageId) {
        const context = normalizeContext(contextInput);
        const record = contextRecord(context);
        if (!record) return clone(state);
        record.messages = record.messages.filter((message) => message.id !== messageId);
        return emit("message:removed", { context, messageId });
      },

      setWorkerStatus(workerId, status, statusText) {
        const worker = workerById(workerId);
        if (!worker) return clone(state);
        worker.status = status;
        worker.statusText = statusText;
        return emit("worker:status", { workerId, status, statusText });
      },

      decideApproval(contextInput, messageId, decision) {
        const context = normalizeContext(contextInput);
        const messages = contextMessages(context);
        const message = messages && messages.find((item) => item.id === messageId);
        if (!message || message.type !== "approval") return clone(state);
        message.decision = decision;
        return emit("approval:decided", { context, messageId, decision });
      },

      addMember(roomId, workerId) {
        const room = roomById(roomId);
        if (!room || !workerById(workerId) || room.memberIds.includes(workerId)) return clone(state);
        room.memberIds.push(workerId);
        return emit("room:member-added", { roomId, workerId });
      },

      removeMember(roomId, workerId) {
        const room = roomById(roomId);
        if (!room) return clone(state);
        room.memberIds = room.memberIds.filter((id) => id !== workerId);
        return emit("room:member-removed", { roomId, workerId });
      },

      addWorker(worker) {
        const nextWorker = {
          id: worker.id || uid("worker"),
          name: worker.name || "New worker",
          role: worker.role || "General purpose",
          status: "ready",
          statusText: "Ready",
          avatar: worker.avatar || "assets/avatar-coro.svg",
          accent: worker.accent || "#31b6b8",
          model: worker.model || state.models.default,
          files: [],
          browser: { label: "New session", url: "about:blank" },
          messages: [],
        };
        state.workers.push(nextWorker);
        const context = { kind: "worker", id: nextWorker.id };
        state.activeContext = context;
        ensureOpenContext(context);
        emit("worker:created", { worker: nextWorker, context });
        return clone(nextWorker);
      },

      addRoom(room) {
        const nextRoom = {
          id: room.id || uid("room"),
          name: room.name || "New room",
          memberIds: Array.from(new Set(room.memberIds || [])),
          accent: room.accent || "#8b69ea",
          files: [],
          browser: { label: "Shared browser", url: "about:blank" },
          messages: [],
        };
        state.rooms.push(nextRoom);
        const context = { kind: "room", id: nextRoom.id };
        state.activeContext = context;
        ensureOpenContext(context);
        emit("room:created", { room: nextRoom, context });
        return clone(nextRoom);
      },

      runRoutine(routineId) {
        const routine = state.routines.find((item) => item.id === routineId);
        if (!routine || routine.status === "running") return Promise.resolve(clone(routine));
        const performerId = routine.delegatedToId || routine.coordinatorId || (routine.scope.kind === "worker" ? routine.scope.id : null);
        const performer = workerById(performerId);
        routine.status = "running";
        routine.lastRun = { status: "running", startedAt: Date.now() };
        if (performer) {
          performer.status = "working";
          performer.statusText = routine.name;
        }
        emit("routine:started", { routineId, scope: routine.scope, performerId });

        return new Promise((resolve) => {
          addTimer(() => {
            const seconds = Math.floor(1.2 + Math.random() * 1.8);
            routine.status = "ready";
            routine.lastRun = { status: "passed", duration: `${seconds}.${Math.floor(Math.random() * 9)}s` };
            if (performer) {
              performer.status = "ready";
              performer.statusText = "Ready for the next task";
            }
            emit("routine:completed", {
              routineId,
              scope: routine.scope,
              performerId,
              duration: routine.lastRun.duration,
            });
            resolve(clone(routine));
          }, 1150);
        });
      },

      setPluginState(pluginId, status) {
        const plugin = pluginById(pluginId);
        if (!plugin) return clone(state);
        plugin.status = status;
        return emit("plugin:state", { pluginId, status });
      },

      togglePluginTool(pluginId, toolId) {
        const plugin = pluginById(pluginId);
        const tool = plugin && plugin.tools.find((item) => item.id === toolId);
        if (!tool) return clone(state);
        tool.enabled = !tool.enabled;
        return emit("plugin:tool-toggled", { pluginId, toolId, enabled: tool.enabled });
      },

      submitSecret(pluginId, fieldName, secretValue) {
        const plugin = pluginById(pluginId);
        const received = typeof secretValue === "string" && secretValue.length > 0;
        secretValue = "";
        if (!plugin || !received) return { accepted: false };
        plugin.status = "connected";
        plugin.connectedField = fieldName;
        emit("secret:accepted", { pluginId, fieldName, accepted: true });
        return { accepted: true };
      },

      // SECRET-1. The inline credential card with no host behind it. Same contract as the gateway
      // adapter's method -- it resolves { accepted, message } and the card's own status is what
      // reports the outcome -- and the same custody: the value is read once, never stored on the
      // message, never emitted, never logged. `discards` is in the copy because on THIS path that
      // is the truth, and a "saved" toast with no host behind it would be the one lie this page
      // must not tell.
      submitSecretRequest(contextInput, messageId, secretValue) {
        const context = normalizeContext(contextInput);
        const messages = contextMessages(context);
        const message = messages && messages.find((item) => item.id === messageId);
        const card = message && message.card;
        const received = typeof secretValue === "string" && secretValue.trim().length > 0;
        secretValue = "";
        if (!card || card.kind !== "secret") {
          return Promise.reject(new Error("only a credential request can be answered this way"));
        }
        if (!received) return Promise.resolve({ accepted: false, message: "The host discards an empty value." });
        card.status = "provided";
        emit("message:created", { context });
        return Promise.resolve({
          accepted: true,
          message: "Saved securely and kept private. With no gateway behind this page the value is discarded, not stored.",
        });
      },

      setModel(workerId, modelId) {
        const worker = workerById(workerId);
        if (!worker || !state.models.available.some((model) => model.id === modelId)) return clone(state);
        worker.model = modelId;
        return emit("model:changed", { workerId, modelId });
      },

      setAutoReview(enabled, rule) {
        state.settings.autoReview.enabled = Boolean(enabled);
        if (typeof rule === "string") state.settings.autoReview.rule = rule;
        return emit("settings:auto-review", clone(state.settings.autoReview));
      },

      // ---- SETTINGS-2 ---------------------------------------------------------------------------
      // Declared here so the demo adapter answers the same three shapes the gateway one does and the
      // settings surface degrades identically with no gateway behind it.
      //
      // WHO IS LOOKING IS NOT THE GATEWAY'S FACT. This adapter runs when the GATEWAY is unreachable,
      // but the page itself was still served by the relay, and the relay is the only thing that knows
      // whether this session is the operator's. So the read is the same same-origin GET /auth/state
      // the gateway adapter makes, and a console whose box is down still shows its operator the
      // technical section -- which is exactly when they need it. Unreachable or carrying no operator
      // field, it answers null and no Operator section is drawn: fail closed, same as live.
      getWorkspaceIdentity() {
        if (typeof fetch !== "function") return Promise.resolve(null);
        return fetch("/auth/state", { headers: { accept: "application/json" } })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null);
      },

      getLocalToolPermission() {
        return Promise.resolve({ value: state.settings.localToolPermission ?? "ask", capped: false });
      },

      setLocalToolPermission(value) {
        const wanted = String(value ?? "");
        if (!["always", "ask", "never"].includes(wanted)) return Promise.reject(new Error("that is not one of the three choices"));
        state.settings.localToolPermission = wanted;
        return Promise.resolve({ value: wanted, capped: false });
      },

      // Both resolve the same shape the gateway adapter answers with, because the view waits on
      // the host before it opens or closes the recording dialog. Nothing records offline; this
      // path exists so the dialog can still be looked at with no gateway.
      startTeaching(workerId) {
        state.teaching = { active: true, workerId, startedAt: Date.now(), maxDurationMs: null };
        emit("teaching:started", { workerId });
        return Promise.resolve({ ok: true, workerId, startedAt: state.teaching.startedAt, maxDurationMs: null });
      },

      finishTeaching(save = true) {
        if (!state.teaching.active) return Promise.resolve({ ok: true, saved: Boolean(save), workerId: null });
        const workerId = state.teaching.workerId;
        state.teaching = { active: false, workerId: null, startedAt: null };
        emit("teaching:finished", { workerId, saved: Boolean(save) });
        return Promise.resolve({ ok: true, saved: Boolean(save), workerId });
      },

      setRunPaused(paused) {
        state.desktop.paused = Boolean(paused);
        return emit("desktop:pause", { paused: state.desktop.paused });
      },

      // The Claim provenance panel behind an evidence chip. Live, this is getAgentEvidence over
      // the host's ledger; offline there is no ledger, so it answers from the same stamp the chip
      // was drawn from -- both of its lists, so the chip's count and the panel's two counts can
      // never disagree. The heads stay empty: an invented tool-result head would be the one lie
      // this demo must not tell, and the reveal already says so for a head the host never stored.
      getEvidence(workerId, attemptId) {
        const worker = workerById(workerId);
        const message = (worker ? worker.messages : []).find((item) => item.evidence && item.evidence.attemptId === attemptId);
        const stamp = message ? message.evidence : {};
        const count = Number(stamp.receipts) || 0;
        const receipts = Array.from({ length: count }, (unused, index) => ({ type: "shell_command", command: `demo action ${index + 1}` }));
        const attestations = (stamp.attestations ?? []).map((eventId) => ({ eventId, tool: "shell", ok: true, bytes: 0, head: "" }));
        return Promise.resolve({ receipts, attestations });
      },

      // The same seven shapes the gateway adapter answers with, so the card is one piece of code.
      getJobBusStatus() {
        return Promise.resolve({ configured: jobBus.configured, source: jobBus.source, base_url: jobBus.base_url });
      },
      listJobBusJobs() {
        return Promise.resolve(jobBus.configured ? clone(jobBus.jobs) : []);
      },
      generateJobBusToken() {
        jobBus.configured = true;
        jobBus.source = "file";
        jobBus.settings.enabled = true;
        return Promise.resolve({
          accepted: true, token: demoToken(),
          message: "Generated in this page only. With no relay behind it nothing was written, so this value opens nothing.",
        });
      },
      setJobBusToken(token) {
        if (typeof token !== "string" || token.trim().length < 32) {
          return Promise.resolve({ accepted: false, message: "A job bus token is at least 32 characters." });
        }
        jobBus.configured = true;
        jobBus.source = "file";
        jobBus.settings.enabled = true;
        return Promise.resolve({ accepted: true, message: "Held in this page only. With no relay behind it nothing was written." });
      },
      clearJobBusToken() {
        jobBus.configured = false;
        jobBus.source = null;
        return Promise.resolve({ accepted: true, message: "Cleared in this page only." });
      },
      getJobBusSettings() { return Promise.resolve(clone(jobBus.settings)); },
      setJobBusSettings(partial) {
        // A partial merge, the way §10.7 writes it, so the switch can send {enabled} alone and the
        // Save can send the lists without either of them clearing the other.
        jobBus.settings = { ...jobBus.settings, ...clone(partial || {}) };
        return Promise.resolve(clone(jobBus.settings));
      },

      // Agent email, in this page only. The addresses are derived from the demo roster exactly the
      // way the relay derives them from the real one.
      getMailSettings() { return Promise.resolve(mailShape()); },
      setMailSettings(partial) {
        const patch = clone(partial || {});
        // apiBase is not in this list because the relay does not take one either: it reads Resend
        // at a fixed address, so nothing a console session sends can point it somewhere else.
        for (const field of ["enabled", "domain", "fromName", "catchAllAgentId", "routes"]) {
          if (patch[field] !== undefined) mail[field] = patch[field];
        }
        // A string sets the secret, null clears it, absent keeps it -- the relay's own rule, held
        // here as the boolean this demo can honestly report.
        if (typeof patch.apiKey === "string") mail.apiKeySet = patch.apiKey.trim().length > 0;
        else if (patch.apiKey === null) mail.apiKeySet = false;
        if (typeof patch.webhookSecret === "string") mail.webhookSecretSet = patch.webhookSecret.trim().length > 0;
        else if (patch.webhookSecret === null) mail.webhookSecretSet = false;
        return Promise.resolve(mailShape());
      },

      // ONBOARD-1. The same three shapes the gateway adapter answers with, so the dialog is one
      // piece of code on both paths.
      getOnboardingState() {
        return Promise.resolve(clone(onboarding));
      },
      completeOnboarding(answers, options) {
        onboarding.done = true;
        onboarding.doneReason = options?.skipped === true ? "skipped" : "completed";
        onboarding.answers = { ...onboarding.answers, ...clone(answers || {}) };
        return Promise.resolve(clone(onboarding));
      },
      // Live, this is the sendPrompt carrying the onboarding marker, and the host answers it with
      // Titan's own opening. There is no host here and no model, so the demo says the first line
      // itself rather than leaving the dialog silent -- as Titan, because the agent it is pushed
      // onto is the one the dialog is bound to.
      startOnboarding(workerId) {
        const worker = workerById(workerId);
        if (!worker) return Promise.resolve({ started: false });
        if (onboarding.startedAt == null) onboarding.startedAt = Date.now();
        worker.messages.push({
          id: uid("onboarding"), authorId: worker.id, authorName: worker.name, type: "text",
          time: timeLabel(),
          text: "I am Titan, your AI lead. I run the crew on this box and I am the one you talk to. Give me a minute of setup and I will know how to help. First, what should I call you?",
        });
        emit("message:created", { context: { kind: "worker", id: worker.id } });
        return Promise.resolve({ started: true });
      },
    };
  }

  global.createDemoAdapter = createDemoAdapter;
})(window);
