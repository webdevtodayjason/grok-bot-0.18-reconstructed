(function startWarmwindPrototype() {
  "use strict";

  const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

  const initialState = {
    activeContext: { kind: "worker", id: "chief" },
    openContexts: [
      { kind: "worker", id: "chief" },
      { kind: "room", id: "msp-team" },
      { kind: "worker", id: "atera" },
    ],
    workers: [
      {
        id: "chief",
        name: "Chief of Staff",
        role: "Lead orchestrator",
        status: "ready",
        statusText: "Ready for the next task",
        avatar: "assets/avatar-chief.svg",
        accent: "#8b69ea",
        model: "nemotron-super",
        files: [
          { name: "team-brief.md", meta: "Updated today" },
          { name: "delegation-map.json", meta: "4 workers" },
          { name: "weekly-outcomes.pdf", meta: "Generated Friday" },
        ],
        browser: { label: "Chief research", url: "https://titaniumcomputing.com" },
        messages: [
          {
            id: "chief-welcome",
            authorId: "chief",
            authorName: "Chief of Staff",
            type: "text",
            text: "The team is online. Give me the outcome and I’ll coordinate the work across the right people.",
            time: "5:30 PM",
          },
        ],
      },
      {
        id: "atera",
        name: "Atera Triage",
        role: "Service desk specialist",
        status: "working",
        statusText: "Reviewing tickets & priorities",
        avatar: "assets/avatar-atera.svg",
        accent: "#31b6b8",
        model: "glm-4.7",
        files: [
          { name: "ticket-audit.csv", meta: "42 rows" },
          { name: "priority-notes.md", meta: "3 urgent" },
        ],
        browser: { label: "Atera tickets", url: "https://app.atera.com/tickets?created=overnight" },
        messages: [
          {
            id: "atera-welcome",
            authorId: "atera",
            authorName: "Atera Triage",
            type: "text",
            text: "I’m connected to the service desk and ready to triage. You can also teach me a task from my desktop.",
            time: "5:31 PM",
          },
        ],
      },
      {
        id: "marketing",
        name: "Marketing Channels",
        role: "Campaign operator",
        status: "working",
        statusText: "Drafting campaign updates",
        avatar: "assets/avatar-marketing.svg",
        accent: "#e25e96",
        model: "nemotron-super",
        files: [
          { name: "client-digest.md", meta: "Draft" },
          { name: "campaign-calendar.csv", meta: "August" },
        ],
        browser: { label: "Campaign workspace", url: "https://app.hubspot.com/campaigns" },
        messages: [
          {
            id: "marketing-welcome",
            authorId: "marketing",
            authorName: "Marketing Channels",
            type: "text",
            text: "I’m ready to draft, revise, and distribute approved client communications.",
            time: "5:32 PM",
          },
        ],
      },
      {
        id: "clientsync",
        name: "ClientSync Tester",
        role: "Regression specialist",
        status: "attention",
        statusText: "Running regression suite",
        avatar: "assets/avatar-clientsync.svg",
        accent: "#e7a23c",
        model: "qwen-3.5",
        files: [{ name: "regression-report.json", meta: "1 warning" }],
        browser: { label: "ClientSync local", url: "http://clientsync.local/audits" },
        messages: [
          {
            id: "clientsync-welcome",
            authorId: "clientsync",
            authorName: "ClientSync Tester",
            type: "text",
            text: "The current regression run has one warning that needs review.",
            time: "5:33 PM",
          },
        ],
      },
    ],
    rooms: [
      {
        id: "msp-team",
        name: "MSP Team",
        accent: "#8b69ea",
        memberIds: ["chief", "atera", "marketing"],
        files: [
          { name: "overnight-summary.pdf", meta: "Shared by Atera" },
          { name: "client-digest.md", meta: "Shared by Marketing" },
        ],
        browser: { label: "MSP shared browser", url: "https://app.atera.com/tickets?team=msp" },
        messages: [
          {
            id: "msp-1",
            authorId: "you",
            authorName: "You",
            type: "text",
            text: "Morning team — can you review overnight tickets, surface anything urgent, and update the client communications draft for the weekly digest?",
            time: "5:35 PM",
            status: "read",
          },
          {
            id: "msp-2",
            authorId: "chief",
            authorName: "Chief of Staff",
            type: "text",
            text: "On it. I’ve synced with Atera Triage for ticket triage and prioritization.\nI’ll consolidate the key items and make sure communications are aligned.",
            time: "5:36 PM",
          },
          {
            id: "msp-3",
            authorId: "atera",
            authorName: "Atera Triage",
            type: "approval",
            text: "Reviewed 42 new tickets overnight. 3 are high priority: one server performance issue, one VPN outage, and one backup failure. I’m working through fixes now.",
            time: "5:36 PM",
            approval: {
              title: "Connect Context7",
              description: "Use the saved connector credential for this task.",
              connectorId: "context7",
            },
            decision: null,
          },
          {
            id: "msp-4",
            authorId: "marketing",
            authorName: "Marketing Channels",
            type: "text",
            text: "Drafting the weekly client digest now. Key highlights and upcoming maintenance windows are included. I’ll share a draft soon. 🚀",
            time: "5:40 PM",
          },
        ],
      },
      {
        id: "ai-operations",
        name: "AI Operations",
        accent: "#31b6b8",
        memberIds: ["chief", "clientsync"],
        files: [{ name: "regression-report.json", meta: "Shared by ClientSync" }],
        browser: { label: "AI operations", url: "http://clientsync.local/runs" },
        messages: [
          {
            id: "aiops-1",
            authorId: "clientsync",
            authorName: "ClientSync Tester",
            type: "text",
            text: "Regression run 184 is active. I’ll bring only failed or ambiguous checks back to this room.",
            time: "4:52 PM",
          },
        ],
      },
      {
        id: "client-comms",
        name: "Client Communications",
        accent: "#e25e96",
        memberIds: ["chief", "marketing"],
        files: [{ name: "client-digest.md", meta: "Current draft" }],
        browser: { label: "Client communications", url: "https://app.hubspot.com/campaigns" },
        messages: [
          {
            id: "comms-1",
            authorId: "marketing",
            authorName: "Marketing Channels",
            type: "text",
            text: "The weekly digest draft is ready for Chief’s review before distribution.",
            time: "4:48 PM",
          },
        ],
      },
      {
        id: "diag-room",
        name: "Diag Room",
        accent: "#e7a23c",
        memberIds: ["chief", "atera"],
        files: [{ name: "group-contract-audit.md", meta: "Passed" }],
        browser: { label: "Diagnostic session", url: "http://localhost:7777/diag" },
        messages: [
          {
            id: "diag-1",
            authorId: "atera",
            authorName: "Atera Triage",
            type: "text",
            text: "Atera Triage: here.",
            time: "7:30 PM",
          },
        ],
      },
    ],
    routines: [
      {
        id: "chief-morning-brief",
        name: "Morning command brief",
        scope: { kind: "worker", id: "chief" },
        coordinatorId: "chief",
        delegatedToId: null,
        trigger: "Weekdays at 7:00 AM",
        instruction: "Review overnight worker outcomes, exceptions, and anything awaiting operator judgment.",
        status: "ready",
        nextRunAt: minutesFromNow(134),
        lastRun: { status: "passed", duration: "2.2s" },
      },
      {
        id: "atera-ticket-review",
        name: "Weekday ticket review",
        scope: { kind: "worker", id: "atera" },
        coordinatorId: "atera",
        delegatedToId: null,
        trigger: "Weekdays at 7:30 AM",
        instruction: "Review new Atera tickets, prioritize urgent work, and report exceptions.",
        status: "ready",
        nextRunAt: minutesFromNow(164),
        lastRun: { status: "passed", duration: "2.6s" },
      },
      {
        id: "marketing-weekly-draft",
        name: "Weekly digest draft",
        scope: { kind: "worker", id: "marketing" },
        coordinatorId: "marketing",
        delegatedToId: null,
        trigger: "Friday at 2:30 PM",
        instruction: "Draft the weekly client digest and request review before sending.",
        status: "ready",
        nextRunAt: minutesFromNow(420),
        lastRun: { status: "passed", duration: "4.1s" },
      },
      {
        id: "msp-weekly-digest",
        name: "MSP weekly client digest",
        scope: { kind: "room", id: "msp-team" },
        coordinatorId: "chief",
        delegatedToId: "marketing",
        trigger: "Friday at 3:00 PM",
        instruction: "Chief coordinates the room; Marketing drafts from Atera’s resolved-ticket summary.",
        status: "ready",
        nextRunAt: minutesFromNow(76),
        lastRun: { status: "passed", duration: "4.4s" },
      },
      {
        id: "msp-urgent-webhook",
        name: "Urgent ticket intake",
        scope: { kind: "room", id: "msp-team" },
        coordinatorId: "chief",
        delegatedToId: "atera",
        trigger: "Atera plugin · urgent_ticket",
        instruction: "Chief receives the trigger and delegates triage to Atera; the result returns to this room.",
        status: "ready",
        nextRunAt: null,
        lastRun: null,
      },
      {
        id: "aiops-regression",
        name: "Nightly regression sweep",
        scope: { kind: "room", id: "ai-operations" },
        coordinatorId: "chief",
        delegatedToId: "clientsync",
        trigger: "Daily at 11:30 PM",
        instruction: "Run the regression suite and surface failed or ambiguous checks to AI Operations.",
        status: "ready",
        nextRunAt: minutesFromNow(238),
        lastRun: { status: "passed", duration: "8.7s" },
      },
      {
        id: "comms-approval",
        name: "Client digest review",
        scope: { kind: "room", id: "client-comms" },
        coordinatorId: "chief",
        delegatedToId: "marketing",
        trigger: "When draft is ready",
        instruction: "Marketing prepares the draft; Chief reviews before any external send.",
        status: "ready",
        nextRunAt: null,
        lastRun: { status: "passed", duration: "3.5s" },
      },
    ],
    plugins: [
      {
        id: "context7",
        name: "Context7",
        icon: "◫",
        category: "Connector + MCP",
        description: "Current technical documentation and code examples for agent work.",
        status: "connected",
        account: "Machine Room workspace",
        secretField: "Workspace token",
        tools: [
          { id: "resolve-library", name: "Resolve library", description: "Match a package to its canonical docs", enabled: true },
          { id: "query-docs", name: "Query documentation", description: "Search current documentation", enabled: true },
        ],
        skills: ["Technical research", "Library migration"],
      },
      {
        id: "atera-plugin",
        name: "Atera",
        icon: "A",
        category: "Plugin",
        description: "Read, update, and route service desk tickets through an assigned account.",
        status: "installed",
        account: null,
        secretField: "API key",
        tools: [
          { id: "list-tickets", name: "List tickets", description: "Read tickets using filters", enabled: true },
          { id: "update-ticket", name: "Update ticket", description: "Change status and priority", enabled: false },
          { id: "add-note", name: "Add private note", description: "Write an internal ticket note", enabled: false },
        ],
        skills: ["Ticket triage"],
      },
      {
        id: "slack",
        name: "Slack",
        icon: "⌘",
        category: "Connector",
        description: "Deliver updates to approved channels and retrieve thread context.",
        status: "available",
        account: null,
        secretField: "OAuth connection",
        tools: [
          { id: "read-thread", name: "Read thread", description: "Load message context", enabled: false },
          { id: "send-message", name: "Send message", description: "Post after policy review", enabled: false },
        ],
        skills: ["Channel update"],
      },
    ],
    models: {
      default: "nemotron-super",
      available: [
        { id: "nemotron-super", name: "Nemotron Super", provider: "Spark 4", context: "128K" },
        { id: "glm-4.7", name: "GLM 4.7", provider: "MacBook Pro", context: "88K" },
        { id: "qwen-3.5", name: "Qwen 3.5", provider: "Local Docker", context: "64K" },
      ],
    },
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

  const adapter = window.createDemoAdapter(initialState);
  let state = adapter.getSnapshot();
  let rosterMode = "workers";
  let selectedPluginId = "context7";
  let activeDesktopApp = "browser";
  let teachInterval = null;
  // The dialog's clock is local; only the box knows a recording has ended. The ten-minute cap
  // fires there, saves the recording and dispatches the learning turn, and nothing pushes that to
  // this page -- so without this poll the red dot keeps pulsing over a recording that is already
  // finished, and the next Discard click reports a save as a discard.
  let teachPoll = null;
  // True from a stop click until the host has answered it, so a second click cannot fire a second
  // stopTeachRecording at a recording that is already being torn down.
  let teachStopping = false;
  // The live screen in the recording dialog is a real VNC client, proxied through the relay, so its
  // iframe is a separate process. It focuses itself when it connects, and from then on Chromium delivers
  // every key to it -- blurring the element puts document.activeElement back on this page while
  // the keys keep going to the box, which is a dialog that looks like it has the keyboard and
  // does not. The only signal that cannot lie is whether the frame exists, so it is mounted only
  // while the operator has asked for the screen and removed the moment they ask for it back.
  let teachScreenControl = false;
  let teachScreenUrl = "";
  let countdownInterval = null;
  let toastTimer = null;
  let rosterHidden = false;
  let nowDismissedId = null;

  const elements = {
    stage: document.getElementById("stage"),
    workerRoster: document.getElementById("worker-roster"),
    rosterList: document.getElementById("worker-stack"),
    hideRoster: document.getElementById("hide-roster"),
    roomTitle: document.getElementById("room-title"),
    roomSubtitle: document.getElementById("room-subtitle"),
    participantCluster: document.getElementById("participant-cluster"),
    transcript: document.getElementById("transcript"),
    workspaceList: document.getElementById("workspace-list"),
    composer: document.getElementById("composer"),
    messageInput: document.getElementById("message-input"),
    contextCard: document.getElementById("context-card"),
    capabilityScope: document.getElementById("capability-scope"),
    desktopCapsuleScope: document.getElementById("desktop-capsule-scope"),
    scheduleButton: document.getElementById("schedule-button"),
    countdown: document.getElementById("next-routine-countdown"),
    countdownLabel: document.getElementById("next-routine-label"),
    nowIsland: document.querySelector(".now-island"),
    nowHeading: document.getElementById("now-heading"),
    routineTitle: document.getElementById("routine-title"),
    routineWorker: document.getElementById("routine-worker"),
    routineMeta: document.getElementById("routine-meta"),
    panelDialog: document.getElementById("panel-dialog"),
    panelTitle: document.getElementById("panel-title"),
    panelEyebrow: document.getElementById("panel-eyebrow"),
    panelContent: document.getElementById("panel-content"),
    desktopDialog: document.getElementById("desktop-dialog"),
    desktopTitle: document.getElementById("desktop-title"),
    desktopWindow: document.getElementById("desktop-window"),
    desktopTimeline: document.getElementById("desktop-timeline"),
    desktopLive: document.querySelector(".desktop-live"),
    pauseRun: document.getElementById("pause-run"),
    teachDialog: document.getElementById("teach-dialog"),
    teachTitle: document.getElementById("teach-title"),
    teachTimer: document.getElementById("teach-timer"),
    toast: document.getElementById("toast"),
    // QOL-NEEDS-YOU: the conversation header's amber pill.
    headerNeedsYou: document.getElementById("header-needs-you"),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function sameContext(left, right) {
    return Boolean(left && right && left.kind === right.kind && left.id === right.id);
  }

  function workerById(id) {
    return state.workers.find((worker) => worker.id === id);
  }

  function roomById(id) {
    return state.rooms.find((room) => room.id === id);
  }

  function modelById(id) {
    return state.models.available.find((model) => model.id === id);
  }

  function activeContext() {
    return state.activeContext;
  }

  function contextRecord(context = activeContext()) {
    return context.kind === "worker" ? workerById(context.id) : roomById(context.id);
  }

  function contextName(context = activeContext()) {
    const record = contextRecord(context);
    return record ? record.name : "Unknown context";
  }

  function contextMembers(context = activeContext()) {
    const record = contextRecord(context);
    if (!record) return [];
    return context.kind === "worker" ? [record] : record.memberIds.map(workerById).filter(Boolean);
  }

  function contextMessages(context = activeContext()) {
    const record = contextRecord(context);
    return record ? record.messages : [];
  }

  function contextLead(context = activeContext()) {
    if (context.kind === "worker") return workerById(context.id);
    const room = roomById(context.id);
    return room && workerById(room.memberIds.includes("chief") ? "chief" : room.memberIds[0]);
  }

  function routinesForContext(context = activeContext()) {
    return state.routines.filter((routine) => sameContext(routine.scope, context));
  }

  function scheduledRoutines(context = activeContext()) {
    return routinesForContext(context)
      // A paused routine still carries its next-run timestamp, so counting down to it promised a
      // run that was never going to fire.
      .filter((routine) => routine.status !== "paused")
      .filter((routine) => routine.nextRunAt && new Date(routine.nextRunAt).getTime() > Date.now())
      .sort((left, right) => new Date(left.nextRunAt) - new Date(right.nextRunAt));
  }

  function avatarMarkup(worker, className, title) {
    if (!worker) return "";
    return `<img class="${className}" src="${escapeHtml(worker.avatar)}" alt="${escapeHtml(title || worker.name)}" />`;
  }

  function roomAvatarsMarkup(room, className = "room-avatar-stack") {
    const members = room.memberIds.map(workerById).filter(Boolean).slice(0, 3);
    const imageClass = className === "workspace-avatars" ? " class=\"workspace-avatar\"" : "";
    return `<span class="${className}">${members.map((worker) => `<img${imageClass} src="${escapeHtml(worker.avatar)}" alt="" />`).join("")}</span>`;
  }

  // ---- QOL-NEEDS-YOU -------------------------------------------------------------------
  // An agent that ended its turn asking the operator something carries needsYou on its roster
  // record (gateway-adapter.js statusOf, off the host's awaitingUserResponse). "Attention" alone
  // could not say this: it also covers a turn that errored, which is not a job for a person.
  // Three surfaces read the flag -- the sidebar card, the conversation header, and the count
  // beside the agent count -- so a blocked agent is visible without opening its conversation.
  function needsYou(record) {
    return record != null && record.needsYou === true;
  }

  function needsYouPillMarkup(record, className) {
    if (!needsYou(record)) return "";
    const reason = typeof record.needsYouReason === "string" ? record.needsYouReason.trim() : "";
    return `<span class="${className}" title="${escapeHtml(reason || "This agent is waiting on you")}">Waiting on you</span>`;
  }

  function needsYouCount() {
    return [...state.workers, ...state.rooms].filter(needsYou).length;
  }

  function renderNeedsYouCount() {
    const slot = document.querySelector("[data-needs-you-count]");
    if (!slot) return;
    const count = needsYouCount();
    slot.hidden = count === 0;
    slot.textContent = count === 0 ? "" : `${count} need${count === 1 ? "s" : ""} you`;
    slot.title = count === 0 ? "" : "Agents whose last turn ended asking you something";
  }
  // ---- end QOL-NEEDS-YOU ---------------------------------------------------------------

  function statusClass(status) {
    if (status === "working") return "working";
    if (status === "attention") return "attention";
    return "ready";
  }

  function formatCountdown(dateString) {
    if (!dateString) return "on trigger";
    const remaining = Math.max(0, new Date(dateString).getTime() - Date.now());
    const totalMinutes = Math.ceil(remaining / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    return `${Math.max(1, minutes)}m`;
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.remove("is-visible");
    void elements.toast.offsetWidth;
    elements.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2800);
  }

  function renderRosterTabs() {
    document.querySelectorAll("[data-roster-tab]").forEach((tab) => {
      const active = tab.dataset.rosterTab === rosterMode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    elements.rosterList.setAttribute("aria-labelledby", rosterMode === "workers" ? "workers-tab" : "rooms-tab");
  }

  function workerCardMarkup(worker) {
    const selected = sameContext(activeContext(), { kind: "worker", id: worker.id });
    return `<button class="worker-card${selected ? " is-active" : ""}" type="button" data-context-kind="worker" data-context-id="${escapeHtml(worker.id)}" data-status="${escapeHtml(worker.status)}" style="--accent:${escapeHtml(worker.accent)}" aria-pressed="${selected}">
      ${avatarMarkup(worker, "worker-avatar")}
      <span class="worker-copy"><span class="worker-name"><i class="status-dot ${statusClass(worker.status)}"></i>${escapeHtml(worker.name)}${needsYouPillMarkup(worker, "needs-you-pill")}</span><span class="worker-status">${escapeHtml(worker.statusText)}</span></span>
    </button>`;
  }

  function roomCardMarkup(room) {
    const selected = sameContext(activeContext(), { kind: "room", id: room.id });
    const routineCount = routinesForContext({ kind: "room", id: room.id }).length;
    return `<button class="worker-card room-card${selected ? " is-active" : ""}" type="button" data-context-kind="room" data-context-id="${escapeHtml(room.id)}" style="--accent:${escapeHtml(room.accent)}" aria-pressed="${selected}">
      ${roomAvatarsMarkup(room)}
      <span class="worker-copy"><span class="worker-name"><i class="status-dot ${statusClass(room.status)}"></i>${escapeHtml(room.name)}</span><span class="worker-status">${room.memberIds.length} workers · ${routineCount} ${routineCount === 1 ? "routine" : "routines"}</span></span>
      <span class="room-count">›</span>
    </button>`;
  }

  // GW-01: an agent hidden from the sidebar (setAgentHiddenFromSidebar) goes to a collapsed group
  // at the foot of the roster rather than vanishing -- it is still on the box and still reachable.
  // The group keeps its open state across redraws; a redraw on every tick would otherwise snap
  // it shut under the cursor.
  let hiddenGroupOpen = false;
  function renderRoster() {
    renderRosterTabs();
    const list = rosterMode === "workers" ? state.workers : state.rooms;
    const markup = rosterMode === "workers" ? workerCardMarkup : roomCardMarkup;
    const shown = list.filter((r) => r.hidden !== true);
    const hidden = list.filter((r) => r.hidden === true);
    elements.rosterList.innerHTML = shown.map(markup).join("")
      + (hidden.length ? `<details class="roster-hidden" data-roster-hidden${hiddenGroupOpen ? " open" : ""}><summary>Hidden · ${hidden.length}</summary>${hidden.map(markup).join("")}</details>` : "");
    // countAgents is the host's on-disk count, the one its 50-agent cap is measured against. The
    // number is absent, not zero, until the host has answered.
    const count = document.querySelector("[data-agent-count]");
    if (count) {
      const known = Number.isFinite(state.agentCount) ? state.agentCount : null;
      count.hidden = known == null;
      count.textContent = known == null ? "" : `${known} / ${AGENT_CAP} agents`;
      count.title = known == null ? "" : "countAgents, as the host reports it — the cap is the host's";
    }
    renderNeedsYouCount();
  }
  const AGENT_CAP = 50;

  function renderConversationHeader() {
    const context = activeContext();
    const name = contextName();
    const members = contextMembers();
    const lead = contextLead();
    elements.roomTitle.textContent = name;
    elements.roomSubtitle.textContent = context.kind === "worker"
      ? `Agent · ${lead ? lead.statusText : "unknown"}`
      : `Room · ${members.length} ${members.length === 1 ? "member" : "members"}`;
    elements.messageInput.placeholder = `Ask ${name}…`;
    elements.participantCluster.innerHTML = members.slice(0, 4).map((worker) => avatarMarkup(worker, "participant-avatar", worker.name)).join("");
    // QOL-NEEDS-YOU: the header carries the same pill, so the conversation you are looking at
    // says it is blocked on you without a trip back to the sidebar.
    const headerPill = elements.headerNeedsYou;
    if (headerPill) {
      const record = contextRecord(context);
      const reason = needsYou(record) && typeof record.needsYouReason === "string" ? record.needsYouReason.trim() : "";
      headerPill.hidden = !needsYou(record);
      headerPill.title = reason || "This agent is waiting on you";
    }
  }

  function agentContextCard(worker) {
    const model = modelById(worker.model);
    const routineCount = routinesForContext({ kind: "worker", id: worker.id }).length;
    return `<div class="context-profile">
      <div class="island-heading"><div><span class="status-dot ${statusClass(worker.status)}"></span><strong>Agent</strong></div></div>
      <div class="context-profile-header">${avatarMarkup(worker, "context-profile-avatar")}<div class="context-profile-copy"><span class="context-kind-label">Direct conversation</span><strong>${escapeHtml(worker.name)}</strong><small>${escapeHtml(worker.statusText)}</small></div></div>
      <div class="context-divider"></div>
      <div class="context-detail-list">${worker.role ? `<div class="context-detail-row"><span>Role</span><strong>${escapeHtml(worker.role)}</strong></div>` : ""}<div class="context-detail-row"><span>Endpoint (box-wide)</span><strong>${escapeHtml(model ? model.name : worker.model)}</strong></div></div>
      <button class="context-action-row" type="button" data-context-action="profile"><span>Agent details</span><b>›</b></button>
      <button class="context-action-row" type="button" data-context-action="routines"><span>Routines</span><b>${routineCount}</b></button>
      ${typeof adapter.getSkills === "function" ? `<button class="context-action-row" type="button" data-context-action="skills"><span>Skills enabled</span><b>${(worker.skills ?? []).filter((skill) => skill.enabled).length} of ${(worker.skills ?? []).length}</b></button>` : ""}
      <button class="context-action-row" type="button" data-context-action="files"><span>Files</span><b>${worker.files.length}</b></button>
    </div>`;
  }

  function roomContextCard(room) {
    const members = room.memberIds.map(workerById).filter(Boolean);
    const routineCount = routinesForContext({ kind: "room", id: room.id }).length;
    const memberRows = members.map((worker) => `<div class="member-row">${avatarMarkup(worker, "member-avatar")}<span>${escapeHtml(worker.name)}</span><button class="member-remove" type="button" data-remove-member="${escapeHtml(worker.id)}" aria-label="Remove ${escapeHtml(worker.name)}">×</button></div>`).join("");
    return `<div class="context-profile">
      <div class="island-heading"><div><span class="status-dot ${statusClass(room.status)}"></span><strong>Room</strong></div></div>
      <p class="context-room-name">${escapeHtml(room.name)}</p>
      <div class="member-list">${memberRows}</div>
      <button class="text-action" type="button" data-context-action="members"><span>＋</span> Add member</button>
      <div class="context-divider"></div>
      <button class="context-action-row" type="button" data-context-action="routines"><span>Room routines</span><b>${routineCount}</b></button>
      <button class="context-action-row" type="button" data-context-action="files"><span>Shared files</span><b>${room.files.length}</b></button>
    </div>`;
  }

  function renderContextCard() {
    const context = activeContext();
    const record = contextRecord();
    elements.contextCard.innerHTML = context.kind === "worker" ? agentContextCard(record) : roomContextCard(record);
  }

  // Agents write markdown. Splitting on newlines and escaping delivered every bullet as a literal
  // asterisk and every code span wrapped in backticks -- a morning of reading agent output in
  // source form. This is the renderer the old operator UI already uses, which escapes FIRST and
  // only then adds the handful of tags it recognises, so nothing an agent says can inject markup.
  // Escaped FIRST, so these patterns only ever match text the model wrote. Nothing here can
  // introduce a tag the escape did not already remove.
  function inlineMarkup(line) {
    return escapeHtml(line)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  }

  function paragraphMarkup(text) {
    // Line by line, not block by block. The block form required EVERY line in a paragraph to be a
    // bullet, so an agent that writes a lead sentence and then a list -- which is how they all
    // write -- got the whole thing rendered as literal dashes.
    const lines = String(text || "").split("\n");
    let html = "";
    let list = null;
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const heading = /^\s{0,3}(#{1,4})\s+(.*)$/.exec(line);
      if (bullet) {
        if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
        html += `<li>${inlineMarkup(bullet[1])}</li>`;
      } else if (numbered) {
        if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
        html += `<li>${inlineMarkup(numbered[1])}</li>`;
      } else if (heading) {
        closeList();
        html += `<p class="message-heading"><strong>${inlineMarkup(heading[2])}</strong></p>`;
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        html += `<p>${inlineMarkup(line)}</p>`;
      }
    }
    closeList();
    return html;
  }


  const DECISION_ACTIONS = {
    "auto-review": [["approved", "✓ Approve", true], ["denied", "✕ Deny", false]],
    "local-tool": [["allow-once", "✓ Allow once", true], ["always", "↗ Always allow", false], ["deny", "✕ Deny", false]],
  };

  function decisionMarkup(message) {
    const card = message.card;
    if (card.status === "sending") {
      return `<div class="inline-card" style="--card-accent:var(--teal-500)"><div class="inline-card-header"><span class="inline-card-icon">◌</span><span class="inline-card-copy"><strong>${escapeHtml(card.title)}</strong><small class="approval-result">Sending your answer…</small></span></div></div>`;
    }
    if (card.status && card.status !== "pending") {
      const settled = card.status === "approved" ? "You approved this"
        : card.status === "denied" ? "You denied this"
        : card.status === "answered" ? `You answered${card.answer != null ? `: ${String(card.answer)}` : ""}`
        : card.status === "dismissed" ? "You dismissed this"
        : card.status === "provided" ? "You provided this — the host stored it and resumed the agent. The value is not in this conversation."
        : `Closed by the host — ${card.status}`;
      const accent = card.status === "approved" || card.status === "answered" ? "var(--green-500)" : "var(--amber-500)";
      return `<div class="inline-card" style="--card-accent:${accent}"><div class="inline-card-header"><span class="inline-card-icon">${card.status === "approved" || card.status === "answered" ? "✓" : "✕"}</span><span class="inline-card-copy"><strong>${escapeHtml(card.title)}</strong><small class="approval-result">${escapeHtml(settled)}</small></span></div></div>`;
    }
    const button = (value, label, primary) => `<button class="card-action${primary ? " primary" : ""}" type="button" data-decide="${escapeHtml(String(value))}" data-message-id="${escapeHtml(message.id)}">${escapeHtml(label)}</button>`;
    // GW-11 item 2: the × on a question card is dismissWidget on the host, drawn only where the
    // adapter implements it. It used to close the card on this page and nowhere else.
    const dismiss = card.kind === "widget" && typeof adapter.dismissCard === "function"
      ? `<button class="member-remove card-dismiss" type="button" data-dismiss-card="${escapeHtml(message.id)}" aria-label="Dismiss this question">×</button>`
      : "";
    const actions = DECISION_ACTIONS[card.kind]
      ? DECISION_ACTIONS[card.kind].map(([v, l, p]) => button(v, l, p)).join("")
      : card.kind === "widget"
        ? ((card.options ?? []).length ? card.options : ["Yes", "No"]).map((option, index) => {
            const value = typeof option === "string" ? option : (option.value ?? option.label ?? String(index));
            const label = typeof option === "string" ? option : (option.label ?? option.value ?? String(index));
            return button(value, label, index === 0);
          }).join("")
        : card.kind === "secret" && typeof adapter.submitSecretRequest === "function"
          // CP-10 item 2: submitSecret { entryId, value, agentId } is a real host command, so the
          // masked input belongs here. The value lives in the input's value property for the
          // length of the call and is cleared on submit; it is never written into the markup.
          ? `<div class="field"><label class="sr-only" for="secret-input-${escapeHtml(message.id)}">${escapeHtml(card.field ?? "credential")}</label><input id="secret-input-${escapeHtml(message.id)}" data-secret-input="${escapeHtml(message.id)}" type="password" autocomplete="off" placeholder="${escapeHtml(card.field ?? "credential")}" /></div><button class="card-action primary" type="button" data-submit-secret="${escapeHtml(message.id)}">Send securely</button>`
          : `<span class="field-hint">Answer this in the host app. This page has no command to carry a credential to it.</span>`;
    return `<div class="inline-card" style="--card-accent:var(--amber-500)"><div class="inline-card-header"><span class="inline-card-icon">▣</span><span class="inline-card-copy"><strong>${escapeHtml(card.title)}</strong><small>${escapeHtml(card.detail || "The agent is blocked until you answer.")}</small></span>${dismiss}</div>${card.rule ? `<div class="tag-list"><span class="tag">would add rule · ${escapeHtml(card.rule)}</span></div>` : ""}<div class="inline-card-actions">${actions}</div></div>`;
  }

  // GW-09: a file in the transcript. The markup is a slot; fillAttachments asks the host for the
  // bytes after the render (readAttachmentImage for an image, readAttachmentText for anything
  // else) so nothing here is drawn from the path alone.
  function attachmentMarkup(message) {
    const a = message.attachment;
    const body = a.kind === "image"
      ? `<div class="attachment-slot" data-attachment-slot>Reading ${escapeHtml(a.name)} from the host…</div>`
      : `<pre class="attachment-preview" data-attachment-slot>Reading ${escapeHtml(a.name)} from the host…</pre>`;
    return `<figure class="message-attachment" data-attachment="${escapeHtml(a.path)}" data-attachment-kind="${escapeHtml(a.kind)}" data-attachment-name="${escapeHtml(a.name)}"><figcaption><span class="tag">▱ ${escapeHtml(a.name)}</span></figcaption>${body}</figure>`;
  }

  function specialMessageMarkup(message) {
    if (message.type === "decision") return decisionMarkup(message);
    if (message.type === "skill") return `<div class="inline-card" style="--card-accent:var(--violet-500)"><div class="inline-card-header"><span class="inline-card-icon">✦</span><span class="inline-card-copy"><strong>${escapeHtml(message.title)}</strong><small>${escapeHtml(message.description)}</small></span></div><div class="tag-list"><span class="tag">skill draft</span><span class="tag">recording attached</span><span class="tag">review required</span></div></div>`;
    return "";
  }

  function messageMarkup(message) {
    if (message.type === "system") {
      // An evidence pill is a disclosure: the host stored the receipts behind the verdict and
      // getAgentEvidence reads them, so the pill opens them rather than only naming the verdict.
      const evidence = message.evidence?.attemptId ? ' data-evidence="1" role="button" tabindex="0"' : "";
      return `<article class="message-row is-system${message.exchange ? " is-exchange" : ""}${evidence ? " is-evidence" : ""}" data-message-id="${escapeHtml(message.id)}"${message.exchange ? ' data-exchange="1" role="button" tabindex="0"' : ""}${evidence}><div class="message-bubble">${escapeHtml(message.text)}</div></article>`;
    }
    const isUser = message.authorId === "you";
    const author = workerById(message.authorId);
    const isWorking = message.type === "working";
    const body = isWorking ? `<div class="typing-dots" aria-label="${escapeHtml(message.authorName)} is working"><i></i><i></i><i></i></div>`
      : message.type === "attachment" && message.attachment ? `${paragraphMarkup(message.text)}${attachmentMarkup(message)}`
      : `${paragraphMarkup(message.text)}${specialMessageMarkup(message)}`;
    return `<article class="message-row${isUser ? " is-user" : ""}${isWorking ? " working-message" : ""}" data-message-id="${escapeHtml(message.id)}">${!isUser ? avatarMarkup(author, "message-avatar") : ""}<div class="message-block"><div class="message-meta"><strong>${escapeHtml(message.authorName || (author && author.name) || "Worker")}</strong><time>${escapeHtml(message.time || "now")}</time></div><div class="message-bubble">${body}</div></div></article>`;
  }

  // The transcript is a tail window; the row above it says the host holds more and offers to
  // page it in (GW-03). Scrolling to the top asks for the same page.
  function transcriptMarkup() {
    const record = contextRecord();
    const older = record?.hasOlder && typeof adapter.loadOlderMessages === "function"
      ? `<div class="transcript-older"><button class="ghost-button" type="button" data-load-older>Show earlier messages</button></div>`
      : "";
    return older + contextMessages().map(messageMarkup).join("");
  }

  // A row just revealed (a search hit) holds the reader on it: a refresh that lands in the next
  // moments must not scroll the transcript back to the bottom under the flash.
  let holdScrollUntil = 0;
  function renderTranscript(keepScroll, pinToRevealed) {
    const wasNearBottom = elements.transcript.scrollHeight - elements.transcript.scrollTop - elements.transcript.clientHeight < 90;
    elements.transcript.innerHTML = transcriptMarkup();
    fillAttachments();
    if (pinToRevealed || Date.now() < holdScrollUntil) return;
    if (!keepScroll || wasNearBottom) requestAnimationFrame(() => { elements.transcript.scrollTop = elements.transcript.scrollHeight; });
  }

  // After an older page lands: the same rebuild, but the reader stays on the line they were on
  // rather than being thrown to the bottom the way a new message does.
  function renderTranscriptKeepingOffset() {
    const box = elements.transcript;
    const previousHeight = box.scrollHeight;
    const previousTop = box.scrollTop;
    box.innerHTML = transcriptMarkup();
    fillAttachments();
    box.scrollTop = box.scrollHeight - previousHeight + previousTop;
  }

  // GW-14: a search hit, or a file, brought on screen. The adapter has paged the entry into the
  // window and emitted transcript:reveal; the row is scrolled to and flashed once.
  function flashEntry(entryId) {
    const row = elements.transcript.querySelector(`[data-message-id="${CSS.escape(entryId)}"]`);
    if (!row) return false;
    holdScrollUntil = Date.now() + 3000;
    row.scrollIntoView({ block: "center" });
    row.classList.add("is-flash");
    window.setTimeout(() => row.classList.remove("is-flash"), 2500);
    return true;
  }

  let loadingOlder = false;
  function loadOlderMessages() {
    const record = contextRecord();
    if (loadingOlder || !record?.hasOlder || typeof adapter.loadOlderMessages !== "function") return;
    loadingOlder = true;
    const button = elements.transcript.querySelector("[data-load-older]");
    if (button) { button.disabled = true; button.textContent = "Reading earlier messages…"; }
    Promise.resolve(adapter.loadOlderMessages(activeContext()))
      .catch((error) => showToast(`Could not read earlier messages: ${error.message}`))
      .finally(() => { loadingOlder = false; });
  }

  // The composer's state is the host's acceptance ledger, not the click: sendPrompt answers
  // { accepted: true } no matter what (GW-03), and promptAcceptanceStatus is what says whether the
  // host actually took the message. Empty until a send; then the ledger's word, verbatim.
  function renderComposerStatus() {
    const status = document.getElementById("composer-status");
    if (!status) return;
    const record = contextRecord();
    const composer = record?.composer ?? null;
    status.hidden = !composer;
    if (!composer) { status.textContent = ""; status.removeAttribute("data-client-nonce"); status.dataset.composerState = "idle"; return; }
    status.textContent = composer.text;
    status.dataset.composerState = composer.state;
    if (composer.nonce) status.dataset.clientNonce = composer.nonce; else status.removeAttribute("data-client-nonce");
  }

  function contextChipMarkup(context) {
    const record = contextRecord(context);
    if (!record) return "";
    const selected = sameContext(context, activeContext());
    const visual = context.kind === "worker" ? avatarMarkup(record, "workspace-avatar") : roomAvatarsMarkup(record, "workspace-avatars");
    const accent = context.kind === "worker" ? record.accent : record.accent;
    return `<button class="workspace-chip${selected ? " is-active" : ""}" type="button" data-context-kind="${context.kind}" data-context-id="${escapeHtml(context.id)}" style="--chip-accent:${escapeHtml(accent)}">${visual}<span>${escapeHtml(record.name)}</span></button>`;
  }

  function renderWorkspaces() {
    elements.workspaceList.innerHTML = state.openContexts.map(contextChipMarkup).join("");
  }

  function renderCapabilities() {
    const name = contextName();
    const kind = activeContext().kind;
    elements.capabilityScope.textContent = `${name} tools`;
    document.querySelectorAll("[data-capability-scope='context']").forEach((button) => {
      const label = button.querySelector("span:last-child").textContent;
      button.setAttribute("aria-label", `${label} for ${kind === "worker" ? "agent" : "room"} ${name}`);
      button.title = `${name} · ${label}`;
    });
    elements.desktopCapsuleScope.textContent = kind === "worker" ? `${name} · private` : `${name} · shared`;
  }

  function renderNowAndSchedule() {
    const routines = routinesForContext();
    const running = routines.find((routine) => routine.status === "running");
    const next = scheduledRoutines()[0];
    const display = running || next;
    if (display) {
      // Dismissing hides THIS routine, not the island forever -- a different routine coming up is
      // new information. Un-dismissing on a timer made the button look broken.
      elements.nowIsland.classList.toggle("is-dismissed", display.id === nowDismissedId);
      elements.nowHeading.textContent = running ? "Now" : "Up next";
      elements.routineTitle.textContent = display.name;
      const performer = workerById(display.delegatedToId || display.coordinatorId || (display.scope.kind === "worker" ? display.scope.id : null));
      elements.routineWorker.textContent = running ? `${performer ? performer.name : contextName()} is working` : `Attached to ${contextName()}`;
      const startedMs = display.lastRunAt ? Date.now() - Number(display.lastRunAt) : null;
      elements.routineMeta.textContent = !running
        ? `Scheduled in ${formatCountdown(display.nextRunAt)}`
        : startedMs == null ? "Running — the host reported no start time"
        : startedMs < 60_000 ? `Started ${Math.max(1, Math.round(startedMs / 1000))}s ago`
        : `Started ${Math.round(startedMs / 60_000)}m ago`;
    } else {
      elements.nowIsland.classList.add("is-dismissed");
    }
    if (next) {
      elements.countdown.textContent = formatCountdown(next.nextRunAt);
      elements.countdownLabel.textContent = "next routine";
      elements.scheduleButton.setAttribute("aria-label", `${next.name} runs in ${formatCountdown(next.nextRunAt)}`);
      // The arc measures one real span. An unlabelled arc gets read as whatever the viewer
      // assumes, so the tooltip says which span it is.
      const from = Number(next.lastRunAt) || 0;
      const to = Number(next.nextRunAt) || 0;
      const fill = from && to && to > from
        ? Math.max(0, Math.min(100, (100 * (Date.now() - from)) / (to - from)))
        : 0;
      elements.scheduleButton.style.setProperty("--ring-fill", `${fill.toFixed(1)}%`);
      elements.scheduleButton.title = from && to
        ? `${next.name} · ${contextName()} — ${fill.toFixed(0)}% of the wait since its last run`
        : `${next.name} · ${contextName()}`;
    } else {
      elements.countdown.textContent = "trigger";
      elements.countdownLabel.textContent = "event routine";
      elements.scheduleButton.setAttribute("aria-label", `${contextName()} has no timed routine; open event-triggered routines`);
      elements.scheduleButton.title = `${contextName()} routines`;
    }
  }

  function renderAll(keepScroll, pinToRevealed) {
    renderRoster();
    renderConversationHeader();
    renderContextCard();
    renderTranscript(keepScroll, pinToRevealed);
    renderComposerStatus();
    renderWorkspaces();
    renderCapabilities();
    renderNowAndSchedule();
  }

  function selectContext(kind, id) {
    rosterMode = kind === "worker" ? "workers" : "rooms";
    adapter.selectContext({ kind, id });
    closeOpenDialogs();
  }

  function closeOpenDialogs(except) {
    [elements.panelDialog, elements.desktopDialog, elements.teachDialog].forEach((dialog) => {
      // The recording dialog is not a view that can be tidied away: dismissing it without stopping
      // the host leaves ffmpeg writing with nothing on screen that says so.
      if (dialog === elements.teachDialog && state.teaching?.active) return;
      if (dialog !== except && dialog.open) dialog.close();
    });
  }

  function openPanel(eyebrow, title, content) {
    closeOpenDialogs(elements.panelDialog);
    elements.panelEyebrow.textContent = eyebrow;
    elements.panelTitle.textContent = title;
    elements.panelContent.innerHTML = content;
    if (!elements.panelDialog.open) elements.panelDialog.showModal();
  }

  function routineScopeLabel(routine) {
    const record = contextRecord(routine.scope);
    return record ? record.name : "Unknown context";
  }

  function routinesPanel() {
    const routines = routinesForContext();
    const context = activeContext();
    const name = contextName();
    const cards = routines.length ? routines.map((routine) => {
      const coordinator = workerById(routine.coordinatorId);
      const delegate = workerById(routine.delegatedToId);
      const running = routine.status === "running";
      const paused = routine.status === "paused";
      const RUN_LABEL = { passed: "✓ Last run succeeded", running: "● Running now…", failed: "✕ Last run failed", dispatched: "→ Dispatched · outcome not reported yet", unknown: "· Last run outcome not reported" };
      // How the run started, in the operator's words. It matters most on a failure: a scheduled
      // run raises no tray error by design, so this card is the only place a run nobody pressed
      // can be seen to have failed, and the reason the host stored on the run comes up with it.
      const RUN_TRIGGER = { schedule: "on its schedule", event: "on an event", manual: "on a test run" };
      const lastFailed = routine.lastRun ? routine.lastRun.status === "failed" : false;
      const lastResult = routine.lastRun
        ? `<div class="run-result${lastFailed ? " failed" : ""}">${escapeHtml(RUN_LABEL[routine.lastRun.status] ?? RUN_LABEL.unknown)}${RUN_TRIGGER[routine.lastRun.trigger] ? ` · ${escapeHtml(RUN_TRIGGER[routine.lastRun.trigger])}` : ""}${routine.lastRun.duration ? ` · ${escapeHtml(routine.lastRun.duration)}` : ""}${lastFailed && routine.lastRun.detail ? `<div class="run-detail">${escapeHtml(routine.lastRun.detail)}</div>` : ""}</div>`
        : `<div class="run-result">Never run</div>`;
      // Pause, edit and delete are setAgentAutomationEnabled / updateAgentAutomation /
      // deleteAgentAutomation on the gateway. The card had a Test run button and nothing else, so
      // a routine written here could only ever be run, never stopped or corrected.
      const controls = `<button class="primary-button" type="button" data-run-routine="${escapeHtml(routine.id)}" ${running ? "disabled" : ""}>${running ? "Running…" : "Test run"}</button><button class="ghost-button" type="button" data-toggle-routine="${escapeHtml(routine.id)}" data-routine-paused="${paused}">${paused ? "Resume" : "Pause"}</button><button class="ghost-button" type="button" data-edit-routine="${escapeHtml(routine.id)}">Edit</button><button class="ghost-button" type="button" data-delete-routine="${escapeHtml(routine.id)}">Delete</button>`;
      // The pill names what the routine IS before what its last run did: a paused routine whose
      // last run failed is still paused, and its failure is on the run line below with the reason.
      return `<article class="routine-card"><div><div class="routine-header"><h3>${escapeHtml(routine.name)}</h3><span class="status-pill ${running ? "working" : paused ? "" : lastFailed ? "attention" : "success"}">${escapeHtml(running ? "running" : paused ? "paused" : lastFailed ? "last run failed" : routine.status)}</span></div><p>${escapeHtml(routine.instruction)}</p><div class="routine-meta"><span class="tag">◷ ${escapeHtml(routine.trigger)}</span><span class="tag">attached · ${escapeHtml(routineScopeLabel(routine))}</span>${coordinator ? `<span class="tag">coordinates · ${escapeHtml(coordinator.name)}</span>` : ""}${delegate ? `<span class="tag">runs as · ${escapeHtml(delegate.name)}</span>` : ""}</div>${routine.nextRunAt ? `<div class="run-result">Next run in ${escapeHtml(formatCountdown(routine.nextRunAt))}</div>` : ""}${lastResult}</div><div style="display:grid;gap:6px;align-content:start">${controls}</div></article>`;
    }).join("") : `<div class="empty-state"><div><strong>No routines attached to ${escapeHtml(name)}</strong><p>Create one here and it will belong to this ${context.kind === "worker" ? "agent" : "room"}—not to the whole system.</p></div></div>`;
    // One form serves both writes: the trigger stack is the hard part of it and an edit that
    // could not reach the stack would only ever be a rename.
    const editing = editingRoutineId ? routines.find((routine) => routine.id === editingRoutineId) : null;
    const form = `<details class="routine-create"${editing ? " open" : ""}><summary class="secondary-button">${editing ? `Editing ${escapeHtml(editing.name)}` : "＋ New routine"}</summary><form ${editing ? `data-edit-routine-form="${escapeHtml(editing.id)}"` : "data-new-routine"}><div class="field"><label for="routine-name">Name</label><input id="routine-name" name="name" required placeholder="e.g. Morning ticket sweep" value="${escapeHtml(editing ? editing.name : "")}" /></div><div class="field"><label for="routine-prompt">What it should do</label><textarea id="routine-prompt" name="prompt" rows="3" required placeholder="Written as if you were asking in chat">${escapeHtml(editing ? editing.instruction : "")}</textarea></div><div class="field"><label>Triggers</label><div id="trigger-stack">${triggerStackMarkup()}</div></div><div class="form-actions">${editing ? `<button class="ghost-button" type="button" data-cancel-routine-edit>Cancel</button>` : ""}<button class="primary-button" type="submit">${editing ? "Save changes" : "Create routine"}</button></div></form></details>`;
    return `<div class="panel-intro"><p>These routines belong only to <strong>${escapeHtml(name)}</strong>. ${context.kind === "room" ? "A room routine can coordinate several members and delegate its execution step." : "An agent routine runs in this agent’s own context."}</p>${form}</div><div class="routine-list">${cards}</div>`;
  }

  function resetRoutineForm() {
    draftTriggers = [blankTrigger("cron")];
    editingRoutineId = null;
  }

  function renderRoutinesPanel() {
    // An armed delete lives on the button's own label, so any repaint disarms it: a button reading
    // "Delete" must never be one click from deleting.
    armedDeleteId = null;
    // The editor belongs to one routine in one context. Switching context leaves it pointing at a
    // routine that is no longer on screen, and its half-typed triggers would then be submitted
    // here as a brand new one.
    if (editingRoutineId && !routinesForContext().some((routine) => routine.id === editingRoutineId)) resetRoutineForm();
    openPanel(activeContext().kind === "worker" ? "Agent routines" : "Room routines", `${contextName()} routines`, routinesPanel());
  }

  // -- Skills (GW-05): the "how" beside the routines' "when". Every row is the host's own
  // workflow record read through getAgentWorkflows; every control is drawn only where the adapter
  // in front of this page implements the write, the way the Agent details panel guards its own.
  let editingSkillId = null;
  let armedDeleteSkillId = null;
  // What the open Skills panel is currently showing, so a refresh that changed nothing does not
  // rebuild the markup under the operator's hands.
  let paintedSkillsSig = "";
  const skillsSig = (worker) => (worker?.skills ?? []).map((skill) => `${skill.id}:${skill.enabled ? 1 : 0}:${skill.ownerAgentId ?? ""}:${skill.name}`).join("|");

  // -- Agent-owned skills (qol/skills). ownerAgentId is off the host's own workflow record
  // (shared/workflow-model.ts): null means the skill is global -- in every agent's library, the way
  // every skill used to be -- and an id means one agent wrote it for itself. The host offers an
  // owned skill to nobody but its owner, so an id read here is always the agent on screen; it is
  // still resolved through the roster rather than assumed, because a card that names the wrong
  // owner is exactly the confusion this section exists to end.
  function skillOwnerName(skill, worker) {
    if (skill.ownerAgentId == null) return null;
    if (skill.ownerAgentId === worker?.id) return worker.name;
    const known = [...state.workers, ...state.rooms].find((agent) => agent?.id === skill.ownerAgentId);
    return known?.name ?? skill.ownerAgentId;
  }
  function skillOwnerTag(skill, worker) {
    if (skill.source === "managed" || skill.source === "plugin") return "";
    const owner = skillOwnerName(skill, worker);
    return owner == null
      ? '<span class="tag skill-scope-tag">global · every agent</span>'
      : `<span class="tag skill-scope-tag owned">owned by ${escapeHtml(owner)}</span>`;
  }
  function skillSection(title, emptyNote, cards) {
    return `<div class="plugin-section-title skills-section-title"><span>${escapeHtml(title)}</span></div>${cards || `<div class="empty-state"><div><p>${escapeHtml(emptyNote)}</p></div></div>`}`;
  }

  function skillCardMarkup(skill, worker) {
    const canToggle = typeof adapter.setSkillEnabled === "function";
    const canRun = typeof adapter.runSkill === "function";
    // The host's store refuses to edit or remove a managed or plugin skill (WorkflowStore.remove
    // answers false), so those two controls are not drawn for one.
    const editable = !["managed", "plugin"].includes(skill.source);
    const canEdit = editable && typeof adapter.updateSkill === "function";
    const canDelete = editable && typeof adapter.deleteSkill === "function";
    const origin = skill.source === "managed" ? "managed skill" : skill.source === "plugin" ? "plugin skill" : skill.sourceRef ? `live reference · ${skill.sourceRef}` : "stored on the host";
    const schedule = skill.scheduled ? `<span class="tag">◷ ${escapeHtml(skill.scheduleDescription || skill.schedule)}</span>` : "";
    const lastRun = skill.lastRunAt ? `<div class="run-result">Last run ${escapeHtml(new Date(Number(skill.lastRunAt)).toLocaleString())}</div>` : "";
    const controls = [
      canRun ? `<button class="primary-button" type="button" data-run-skill="${escapeHtml(skill.id)}" ${skill.enabled ? "" : "disabled"}>Run now</button>` : "",
      canEdit ? `<button class="ghost-button" type="button" data-edit-skill="${escapeHtml(skill.id)}">Edit</button>` : "",
      canDelete ? `<button class="ghost-button" type="button" data-delete-skill="${escapeHtml(skill.id)}" title="${skill.ownerAgentId == null ? "Removes this skill from the box's shared library, for every agent" : "Removes this agent's own skill; no other agent has it"}">Delete</button>` : "",
      // Only an owned skill can be handed to the box, and only where the adapter implements it.
      skill.ownerAgentId != null && typeof adapter.makeSkillGlobal === "function"
        ? `<button class="ghost-button" type="button" data-make-skill-global="${escapeHtml(skill.id)}" title="Puts this skill in the box's shared library, for every agent. It cannot be given back to one agent from here.">Make global</button>`
        : "",
    ].join("");
    const toggle = canToggle
      ? `<button class="switch" type="button" data-toggle-skill="${escapeHtml(skill.id)}" aria-label="Enable ${escapeHtml(skill.name)} for this agent" aria-pressed="${skill.enabled}"></button>`
      : `<span class="status-pill${skill.enabled ? " success" : ""}">${skill.enabled ? "enabled" : "disabled"}</span>`;
    return `<article class="routine-card skill-card" data-skill-id="${escapeHtml(skill.id)}" data-skill-name="${escapeHtml(skill.name)}"><div><div class="routine-header"><h3>${escapeHtml(skill.name)}</h3>${toggle}</div><p>${escapeHtml(skill.description || "No description on the host.")}</p><pre class="skill-body">${escapeHtml(skill.body)}</pre><div class="routine-meta"><span class="tag">${escapeHtml(origin)}</span>${skillOwnerTag(skill, worker)}${schedule}${skill.helperScripts.length ? `<span class="tag">${skill.helperScripts.length} helper file(s)</span>` : ""}</div>${lastRun}</div><div style="display:grid;gap:6px;align-content:start">${controls}</div></article>`;
  }

  function skillsPanel(worker) {
    const skills = worker.skills ?? [];
    const editing = editingSkillId ? skills.find((skill) => skill.id === editingSkillId) : null;
    const canCreate = typeof adapter.createSkill === "function";
    const canImportText = typeof adapter.importSkillText === "function";
    const canImportUrl = typeof adapter.importSkillUrl === "function";
    // Two sections, because a skill is either this agent's own or the box's. The host has already
    // filtered the list -- another agent's owned skills are not in it at all -- so the split here is
    // over what came back, never a guess about what exists.
    const ownedCards = skills.filter((skill) => skill.ownerAgentId != null).map((skill) => skillCardMarkup(skill, worker)).join("");
    const globalCards = skills.filter((skill) => skill.ownerAgentId == null).map((skill) => skillCardMarkup(skill, worker)).join("");
    const cards = skills.length
      ? `${skillSection("This agent's skills", `${worker.name} has not written a skill of its own yet. One it saves during a turn, or learns from a demonstration, lands here and no other agent is offered it.`, ownedCards)}${skillSection("Global skills", "No global skills on this box yet.", globalCards)}`
      : `<div class="empty-state"><div><strong>No skills in this agent's library</strong><p>A skill is a named recipe an agent can be asked to run by name. Global skills are shared by every agent on the box; a skill an agent writes for itself belongs to it alone. Routines created on the Routines panel are scheduled skills and stay there.</p></div></div>`;
    const form = canCreate || editing
      ? `<details class="routine-create"${editing ? " open" : ""}><summary class="secondary-button">${editing ? `Editing ${escapeHtml(editing.name)}` : "＋ New skill"}</summary><form ${editing ? `data-skill-form="${escapeHtml(editing.id)}"` : "data-skill-form=\"\""}><div class="field"><label for="skill-name">Name</label><input id="skill-name" name="name" required placeholder="e.g. Weekly ticket digest" value="${escapeHtml(editing ? editing.name : "")}" /></div><div class="field"><label for="skill-description">When to use it</label><input id="skill-description" name="description" placeholder="One line the agent reads to decide" value="${escapeHtml(editing ? editing.description : "")}" /></div><div class="field"><label for="skill-body">Instructions</label><textarea id="skill-body" name="body" rows="5" required placeholder="The recipe, written as you would to a person">${escapeHtml(editing ? editing.body : "")}</textarea></div><div class="form-actions">${editing ? `<button class="ghost-button" type="button" data-cancel-skill-edit>Cancel</button>` : ""}<button class="primary-button" type="submit">${editing ? "Save changes" : "Create skill"}</button></div></form></details>`
      : "";
    const canPort = typeof adapter.portLocalSkills === "function";
    const importers = canImportText || canImportUrl || canPort
      ? `<details class="routine-create"><summary class="secondary-button">⇩ Import a skill</summary>${canImportText ? `<form data-import-skill-text><div class="field"><label for="skill-markdown">Paste skill markdown</label><textarea id="skill-markdown" name="markdown" rows="5" required placeholder="---&#10;name: My skill&#10;description: when to use it&#10;---&#10;The recipe…"></textarea><span class="field-hint">Frontmatter name and description are read if present; a trigger.schedule in it makes the skill scheduled as well.</span></div><div class="form-actions"><button class="primary-button" type="submit">Import markdown</button></div></form>` : ""}${canImportUrl ? `<form data-import-skill-url><div class="field"><label for="skill-url">Or a URL</label><input id="skill-url" name="url" type="url" required placeholder="https://…/SKILL.md" /><span class="field-hint">Stored as a live reference: the agent reads the URL when it runs the skill, so it follows the source as it changes.</span></div><div class="form-actions"><button class="primary-button" type="submit">Import from URL</button></div></form>` : ""}${canPort ? `<div class="setting-row"><div><strong>Port the host's local skill files</strong><small>The host scans its own working directory and home for CLAUDE.md, AGENTS.md and .cursor/rules and links each as a live reference. It reports what it found; nothing is invented here.</small></div><button class="ghost-button" type="button" data-port-local-skills>Port</button></div>` : ""}</details>`
      : "";
    return `<div class="panel-intro"><p><strong>Skills</strong> are the how, read by an agent when it is asked by name or when a scheduled one fires. A skill <strong>${escapeHtml(worker.name)}</strong> writes for itself is <strong>its own</strong> — nobody else is offered it, and it is on for ${escapeHtml(worker.name)} from the moment it is saved. A skill created or imported <em>here</em> is <strong>global</strong>: in the library for every agent on the box. “Make global” hands an owned skill to the box and cannot be undone from this panel; the switch is ${escapeHtml(worker.name)}'s own per-agent enable; Delete removes a global skill for every agent.</p>${form}${importers}</div><div class="routine-list" data-skill-list>${cards}</div>`;
  }

  function renderSkillsPanel() {
    const context = activeContext();
    if (context.kind !== "worker") { showToast("Skills belong to an agent — open one of this room's members."); return; }
    if (typeof adapter.getSkills !== "function") { showToast("This offline view has no gateway, so there are no skills to read."); return; }
    armedDeleteSkillId = null;
    const worker = contextRecord();
    if (editingSkillId && !(worker.skills ?? []).some((skill) => skill.id === editingSkillId)) editingSkillId = null;
    paintedSkillsSig = skillsSig(worker);
    openPanel("Agent skills", `${worker.name} skills`, skillsPanel(worker));
    // What is drawn came from the last refresh; read the host again so the panel opens on the
    // list as it is now, not as it was at the last tick.
    adapter.getSkills(worker.id)
      // A repaint disarms the delete, as every repaint must: a button reading "Delete" is never
      // one click from deleting.
      .then((skills) => { worker.skills = skills; armedDeleteSkillId = null; paintedSkillsSig = skillsSig(worker); if (elements.panelDialog.open && elements.panelEyebrow.textContent === "Agent skills") elements.panelContent.innerHTML = skillsPanel(worker); })
      .catch((error) => showToast(`Could not read this agent's skills: ${error.message}`));
  }

  // A learning turn ends with a new skill in the box's library, and this panel was painted once,
  // when it opened. Nothing new is polled for it: loadContext already reads getAgentWorkflows on
  // every refresh and applyLoaded puts the list on the record, so the panel only has to redraw
  // when that list actually moved -- and never while the operator is typing into it.
  function refreshOpenSkillsPanel() {
    if (!elements.panelDialog.open || elements.panelEyebrow.textContent !== "Agent skills") return;
    if (activeContext().kind !== "worker") return;
    const worker = contextRecord();
    const sig = skillsSig(worker);
    if (!worker || sig === paintedSkillsSig) return;
    if (elements.panelContent.contains(document.activeElement)) return;
    paintedSkillsSig = sig;
    armedDeleteSkillId = null;
    elements.panelContent.innerHTML = skillsPanel(worker);
  }

  // Only the gateway adapter stores a secret; the offline demo factory discards it and resolves
  // {accepted:true} with no message. So the fallback copy on both the form and the toast has to
  // be the demo's truth, not the relay's: claiming a credential was stored when it was thrown
  // away is the same class of lie this wave exists to remove, pointing the other way.
  const isLiveGateway = () => window.__machineRoomLive === true;
  // Only the gateway adapter allocates a display. Called bare, this threw "adapter.ensureDesktop
  // is not a function" out of the click handler on the offline path, past the .catch that was
  // already there for it, and left the pane on its "Opening…" sentence forever.
  const ensureDesktop = (agentId) => (typeof adapter.ensureDesktop === "function"
    ? adapter.ensureDesktop(agentId)
    : Promise.reject(new Error("this offline view has no gateway, so the box allocates no screen")));
  const demoSecretNote = "Offline view: this page has no gateway, so the value is discarded and nothing is stored.";

  function pluginStatusLabel(status) {
    return status === "connected" ? "connected" : status === "installed" ? "needs account" : "available";
  }

  // CP-04: the local token form. connectChannel { id, platform, token } binds the listener to the
  // agent on screen; the Cursor-hosted route stays reachable and is labelled for what it is.
  function listenerConnectMarkup(plugin, lead) {
    const who = lead ? escapeHtml(lead.name) : "the agent on screen";
    const cursorRoute = `<div class="form-actions"><button class="ghost-button" type="button" data-install-plugin="${escapeHtml(plugin.id)}">Use the Cursor-hosted route instead</button></div><span class="field-hint">That route opens cursor.com's connect page. It signs in to a Cursor account this box does not have, so it cannot finish here — the form above is the route that works.</span>`;
    if (!lead) return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Connect ${escapeHtml(plugin.name)}</strong><small>A listener binds to one agent. Open an agent's conversation first, then connect it here.</small></div></div>${cursorRoute}</div>`;
    return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Connect ${escapeHtml(plugin.name)} for ${who}</strong><small>The token goes to the host as this agent's ${escapeHtml(plugin.name)} credential and is read back from getAgentChannels. It never enters chat or model context, and this page keeps no copy.</small></div></div><form data-connect-channel="${escapeHtml(plugin.id)}"><div class="field"><label for="channel-token-${escapeHtml(plugin.id)}">${escapeHtml(plugin.name)} token</label><input id="channel-token-${escapeHtml(plugin.id)}" name="token" type="password" autocomplete="off" required placeholder="Enter securely" /></div><div class="form-actions"><button class="primary-button" type="submit">Connect for ${who}</button></div></form>${cursorRoute}</div>`;
  }
  // CP-12: unbinding is per agent too, so the button says whose channel it drops.
  function listenerConnectedMarkup(plugin, lead) {
    const who = lead ? escapeHtml(lead.name) : "this agent";
    return `<div class="demo-note"><strong>${escapeHtml(plugin.name)} is connected for ${who}</strong><br />The host holds the token. This page never received it and cannot show it.<div class="form-actions"><button class="ghost-button" type="button" data-disconnect-plugin="${escapeHtml(plugin.id)}">Disconnect for ${who}</button></div></div>`;
  }
  // CP-10 item 1: one masked input per field the host names for this connector.
  function connectorSecretMarkup(plugin) {
    const stored = new Set(plugin.storedFields ?? []);
    // The connector catalog carries one line per credential field -- what the value is, where it
    // is created, the least it needs -- and a field with no hint behind it simply gets none.
    const hints = plugin.secretHints ?? {};
    const fields = plugin.secretFields.map((field) => `<div class="field"><label for="connector-secret-${escapeHtml(plugin.id)}-${escapeHtml(field)}">${escapeHtml(field)}</label><input id="connector-secret-${escapeHtml(plugin.id)}-${escapeHtml(field)}" name="${escapeHtml(field)}" type="password" autocomplete="off" placeholder="${stored.has(field) ? "The host holds a value — type to replace it" : "Enter securely"}" />${hints[field] ? `<span class="field-hint" data-credential-hint="${escapeHtml(field)}">${escapeHtml(hints[field])}</span>` : ""}</div>`).join("");
    return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Credentials for ${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.secretHint || "The host stores these and hands them to the connector process.")}</small></div></div><form data-connector-secret-form="${escapeHtml(plugin.id)}">${fields}<div class="form-actions"><button class="primary-button" type="submit">Store on the host</button></div><span class="field-hint">Leave a field blank to leave what the host already holds for it untouched. Nothing you type here is written into this page.</span></form></div>`;
  }
  // CONNECT-5: a shell tool card. Install runs the catalog's command in the box and prints the
  // tail of its own output here; the usage line is what the agent is meant to type once the
  // credential card above has a value. The teach button is drawn only where the tool publishes a
  // skill, and only for the agent on screen -- a workflow is imported for one agent.
  function shellToolMarkup(plugin, lead) {
    const tool = plugin.shellTool;
    const id = escapeHtml(tool.id);
    const teach = tool.teachable && typeof adapter.teachShellTool === "function"
      ? (lead
        ? `<div class="setting-row"><div><strong>Teach ${escapeHtml(lead.name)} to use it</strong><small>Imports ${escapeHtml(plugin.name)}'s own published SKILL.md as a workflow for this agent. The host fetches it; this page never sees the URL's answer.</small></div><button class="ghost-button" type="button" data-teach-shell-tool="${id}">Teach the active agent</button></div>`
        : `<div class="setting-row"><div><strong>Teach an agent to use it</strong><small>A workflow is imported for one agent. Open an agent's conversation first, then come back.</small></div><span class="status-pill">no agent on screen</span></div>`)
      : "";
    const probe = typeof adapter.probeShellSecret === "function"
      ? `<div class="setting-row"><div><strong>Does the box have ${escapeHtml(tool.field)}?</strong><small>Asks the box's own shell — the one the agent runs commands in — and reports set or unset. It never prints the value.</small></div><button class="ghost-button" type="button" data-probe-shell-secret="${escapeHtml(tool.field)}">Ask the box</button></div>`
      : "";
    return `<section><div class="plugin-section-title"><span>Install in the box</span><span>as the host's own user</span></div><div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>${escapeHtml(plugin.name)}</strong><small>Runs in the box, capped at five minutes. The last lines of its output come back here.</small></div></div><pre class="shell-tool-command">${escapeHtml(tool.install)}</pre><div class="form-actions"><button class="primary-button" type="button" data-install-shell-tool="${id}">Install in the box</button></div><pre class="shell-tool-output" data-shell-tool-output="${id}" hidden></pre></div>${tool.usage ? `<div class="demo-note"><strong>Once it is installed</strong><br />${escapeHtml(tool.usage)}</div>` : ""}${probe}${teach}</section>`;
  }
  const connectorRemoveRow = (plugin) => (plugin.group === "Connectors" && plugin.removable && typeof adapter.removeConnector === "function"
    ? `<div class="setting-row"><div><strong>Remove this connector</strong><small>Drops ${escapeHtml(plugin.name)} from connectors.json on the box and asks the host to re-read the file.</small></div><button class="ghost-button" type="button" data-remove-connector="${escapeHtml(plugin.name)}">Remove</button></div>`
    : "");

  // MARKET-1: the three boxes a plugin card is made of, pulled out of pluginDetailMarkup so the
  // Marketplace's plugin page draws exactly the ones the Settings provider and listener sections
  // do. Nothing here changed in the move; only the call sites multiplied.
  //
  // A tool row carries a switch only where the write exists. Where it does not, the row says
  // what the host holds and the section says why it cannot be changed from here.
  function pluginToolsMarkup(plugin) {
    const toolRow = (tool) => `<div class="tool-row"><div><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.description)}</small></div>${tool.togglable === false
      ? `<span class="status-pill${tool.enabled ? " success" : ""}">${tool.enabled ? "enabled" : "disabled"}</span>`
      : `<button class="switch" type="button" data-toggle-tool="${escapeHtml(tool.id)}" aria-label="Toggle ${escapeHtml(tool.name)}" aria-pressed="${tool.enabled}"></button>`}</div>`;
    return plugin.tools.length
      ? plugin.tools.map(toolRow).join("") + (plugin.toolsReadOnlyNote ? `<span class="field-hint">${escapeHtml(plugin.toolsReadOnlyNote)}</span>` : "")
      : `<div class="empty-state">${escapeHtml(plugin.toolsNote || "No tools are reported for this plugin.")}</div>`;
  }
  // Only once getAgentChannels has actually been read for the agent on screen: until then this
  // page does not know whether that agent holds a token, and drawing a Connect form on a listener
  // it is already bound to would be a guess wearing a control.
  const listenerChannelOf = (plugin, lead) => (plugin.group === "Listeners" && typeof adapter.connectListener === "function" && Array.isArray(lead?.channels)
    ? { canConnect: true, channel: lead.channels.find((c) => c.platform === plugin.id) }
    : { canConnect: false, channel: undefined });
  // CONNECT-5: the same credential card, whichever store is behind it. A shell tool's value goes
  // to setShellSecret (the box shell's environment); a connector's to setConnectorSecret (the
  // connector process's). The component is one because the promise it makes is one.
  function pluginSecretsMarkup(plugin) {
    const secretWriter = plugin.shellTool ? adapter.setShellSecret : adapter.setConnectorSecret;
    return Array.isArray(plugin.secretFields) && plugin.secretFields.length && typeof secretWriter === "function"
      ? connectorSecretMarkup(plugin) : "";
  }
  function pluginAccountMarkup(plugin, lead) {
    // CP-04: a listener binds per agent with a token the host takes (connectChannel). The local
    // form is the route that works on this box; the Cursor-hosted flow stays as a labelled
    // secondary, because getListenerConnectUrl answers with cursor.com's page for an account this
    // box does not have and clicking it can only end in a dead tab.
    const { canConnect, channel } = listenerChannelOf(plugin, lead);
    if (canConnect && channel?.connected !== true) return listenerConnectMarkup(plugin, lead);
    if (canConnect && channel?.connected === true) return listenerConnectedMarkup(plugin, lead);
    // A card the host cannot connect gets no button. Clicking it ran getListenerConnectUrl with a
    // subscription id, which always errors -- behind a success toast fired before the answer came.
    if (plugin.status === "available" && plugin.connectable === false) return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Not connectable from here</strong><small>${escapeHtml(plugin.connectNote || `This host has no connect flow for ${plugin.name}.`)}</small></div></div></div>`;
    if (plugin.status === "available") return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Connect ${escapeHtml(plugin.name)}</strong><small>Opens ${escapeHtml(plugin.name)}'s own authorisation page. The credential is exchanged there and stored by the host — it never passes through this page.</small></div></div><div class="form-actions"><button class="primary-button" type="button" data-install-plugin="${escapeHtml(plugin.id)}">Connect ${escapeHtml(plugin.name)}</button></div></div>`;
    if (plugin.status === "pending") return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Awaiting authorisation</strong><small>Finish approving ${escapeHtml(plugin.name)} in the tab that opened, then reopen this panel.</small></div></div></div>`;
    if (plugin.status === "installed") return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Secure value required</strong><small>Scoped to ${escapeHtml(plugin.name)} · ${escapeHtml(plugin.secretField)}. It never enters chat or model context.</small></div></div><form data-secret-form="${escapeHtml(plugin.id)}"><div class="field"><label for="secret-${escapeHtml(plugin.id)}">${escapeHtml(plugin.secretField)}</label><input id="secret-${escapeHtml(plugin.id)}" name="secret" type="password" autocomplete="off" required placeholder="Enter securely" /><span class="field-hint">${escapeHtml(plugin.secretHint || demoSecretNote)}</span></div><div class="form-actions"><button class="primary-button" type="submit">Connect account</button></div></form></div>`;
    return `<div class="demo-note"><strong>${escapeHtml(plugin.account || (plugin.group === "Providers" ? "Adopted on this Mac" : "Connected"))}</strong><br />${escapeHtml(plugin.connectedNote || "The host holds this connection. Contexts receive its capabilities, never the credential.")}</div>`;
  }
  // GW-08: a listener is bound per agent. The card is global; this row is getAgentChannels for
  // the agent on screen -- whether it holds a token for this platform -- and says which agent.
  function pluginChannelRowMarkup(plugin, lead) {
    if (plugin.group !== "Listeners") return "";
    const { channel } = listenerChannelOf(plugin, lead);
    const line = !lead ? "No agent on screen to read a channel for."
      : lead.channels == null ? `Not read yet for ${lead.name} — the host answers getAgentChannels on the next refresh.`
      : !channel ? `${lead.name}: the host lists no ${plugin.name} channel manifest for this agent.`
      : channel.connected ? `${lead.name}: connected${channel.detail ? ` · ${channel.detail}` : ""}.`
      : `${lead.name}: not connected — this agent holds no ${plugin.name} token.`;
    return `<div class="setting-row" data-channel-state="${escapeHtml(plugin.id)}"><div><strong>For ${escapeHtml(lead ? lead.name : "this agent")}</strong><small>${escapeHtml(line)}</small></div><span class="status-pill${channel?.connected ? " success" : ""}">${channel ? (channel.connected ? "connected" : "not connected") : "unknown"}</span></div>`;
  }

  function pluginDetailMarkup(plugin) {
    if (!plugin) return `<div class="empty-state">Choose a plugin to inspect its tools and account.</div>`;
    const tools = pluginToolsMarkup(plugin);
    const lead = contextLead();
    const account = pluginAccountMarkup(plugin, lead);
    const connectorSecrets = pluginSecretsMarkup(plugin);
    const channelRow = pluginChannelRowMarkup(plugin, lead);
    const providerSwitch = plugin.endpointId
      ? `<div class="provider-switch">${plugin.live ? `<span class="status-pill success">answering now</span>` : plugin.status === "connected" ? `<button class="primary-button" type="button" data-use-endpoint="${escapeHtml(plugin.endpointId)}">Use this endpoint</button>` : ""}</div>`
      : "";
    // The Skills section was a heading over an empty div on every card the gateway builds: no
    // plugin here ships skills. It renders only where there are some, or where there is a reason.
    const skillsSection = plugin.skills.length
      ? `<section><div class="plugin-section-title"><span>Skills in package</span></div><div class="tag-list">${plugin.skills.map((skill) => `<span class="tag">✦ ${escapeHtml(skill)}</span>`).join("")}</div></section>`
      : plugin.skillsNote ? `<section><div class="plugin-section-title"><span>Skills in package</span></div><div class="empty-state">${escapeHtml(plugin.skillsNote)}</div></section>` : "";
    return `<div class="plugin-hero"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><div class="plugin-hero-copy"><h3>${escapeHtml(plugin.name)}</h3><p>${escapeHtml(plugin.description)}</p></div><span class="status-pill ${plugin.status === "connected" ? "success" : ""}">${escapeHtml(pluginStatusLabel(plugin.status))}</span></div><div class="plugin-sections"><section><div class="plugin-section-title"><span>${plugin.group === "Providers" ? "Provider account" : "Global account"}</span><span>${escapeHtml(plugin.category)}</span></div>${account}${connectorSecrets}${providerSwitch}${channelRow}${connectorRemoveRow(plugin)}</section>${plugin.shellTool ? shellToolMarkup(plugin, lead) : ""}<section><div class="plugin-section-title"><span>Tools available for assignment</span>${plugin.tools.length ? `<span>${plugin.tools.filter((tool) => tool.enabled).length}/${plugin.tools.length} enabled</span>` : ""}</div><div class="plugin-list">${tools}</div></section>${skillsSection}</div>`;
  }

  // The relay holds the endpoint catalogue and probes each one; the box holds which is in use.
  // Both are read here rather than assumed, so the panel cannot claim a model the box is not on.
  function fillEndpoints() {
    const select = elements.panelContent.querySelector("#endpoint-select");
    const current = elements.panelContent.querySelector("#endpoint-current");
    const health = elements.panelContent.querySelector("#endpoint-health");
    if (!select) return;
    Promise.all([
      fetch("/endpoints").then((r) => r.json()).catch(() => ({ endpoints: [] })),
      fetch("/model").then((r) => r.json()).catch(() => ({})),
    ]).then(([catalog, live]) => {
      const list = catalog.endpoints ?? [];
      select.innerHTML = list.map((e) => {
        const on = live.model && e.model === live.model;
        const reach = e.health?.reachable ? "" : " · unreachable";
        return `<option value="${escapeHtml(e.id)}" ${on ? "selected" : ""}>${escapeHtml(e.name)}${escapeHtml(reach)}</option>`;
      }).join("") || `<option value="">No endpoints configured</option>`;
      if (current) current.textContent = live.model
        ? `${live.model} · ${live.endpoint ?? "unknown host"} (from ${live.source ?? "unknown"})`
        : "The box reports no model. Agents cannot answer until one is set.";
      if (health) {
        const chosen = list.find((e) => live.model && e.model === live.model);
        health.textContent = chosen ? (chosen.health?.reachable ? `${chosen.health.ms}ms` : "unreachable") : "unknown";
        health.className = `status-pill${chosen?.health?.reachable ? " success" : ""}`;
      }
    });
    select.onchange = () => {
      const id = select.value;
      if (!id) return;
      if (current) current.textContent = "Switching…";
      fetch("/endpoints/use", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })
        .then((r) => r.json())
        .then((answer) => { showToast(`Now answering through ${answer.using ?? id}`); fillEndpoints(); })
        .catch((error) => showToast(`Could not switch endpoint: ${error.message}`));
    };
  }

  const TRIGGER_KINDS = [
    ["cron", "On a schedule"], ["slack", "Slack message"], ["github", "Git event"],
    ["linear", "Linear issue"], ["sentry", "Sentry alert"], ["pagerduty", "PagerDuty incident"],
    ["microsoftTeams", "Teams message"],
  ];
  // What can actually deliver an event on this box. The host builds exactly two event sources
  // (createBackendRelaySources: a Slack one and a GitHub one), hands those two to the trigger hub
  // and nothing else, and both are polled out of Cursor's backend relay -- which needs a Cursor
  // login this deployment does not have. So Linear, Sentry, PagerDuty and Teams have no source at
  // all here, and Slack and GitHub only work while the host reports that listener connected. The
  // picker used to offer all six as though they worked: the routine saved, its card showed the
  // word "trigger" where a countdown goes, and nothing ever fired it.
  const EVENT_TRIGGER_PLATFORM = {
    slack: "Slack", github: "GitHub", linear: "Linear",
    sentry: "Sentry", pagerduty: "PagerDuty", microsoftTeams: "Teams",
  };
  const RELAY_SOURCED_TRIGGERS = ["slack", "github"];
  function listenerRow(platform) {
    return (state.plugins ?? []).find((plugin) => plugin.group === "Listeners" && plugin.id === platform) ?? null;
  }
  // Null means this box can serve the trigger. A string is the reason it cannot, written to be
  // read by whoever is about to save a routine on it.
  function triggerUnavailable(kind) {
    if (kind === "cron") return null;
    const platform = EVENT_TRIGGER_PLATFORM[kind] ?? kind;
    if (!RELAY_SOURCED_TRIGGERS.includes(kind))
      return `Nothing on this box delivers ${platform} events. The host wires its trigger hub to a Slack source and a GitHub source and to nothing else, so a routine on this trigger would save and then wait forever.`;
    const row = listenerRow(kind);
    if (row && row.status === "connected") return null;
    return `${platform} events reach a routine only through Cursor's backend relay, and the host reports ${row ? `its ${platform} listener ${row.category.toLowerCase()}` : `no ${platform} listener at all`}. Connecting one needs a Cursor login this box does not have, so a routine on this trigger would save and then wait forever.`;
  }

  const GITHUB_EVENTS = [
    ["pr-opened", "PR opened"], ["pr-merged", "PR merged"], ["review-requested", "Review requested"],
    ["issue-assigned", "Issue assigned"], ["ci-failed", "CI failed"], ["ci-passed", "CI passed"],
  ];
  const SLACK_MATCHES = [
    ["message", "Any message"], ["mention", "When @mentioned"], ["keyword", "Keyword match"], ["reaction", "A reaction"],
  ];
  const LINEAR_EVENTS = [
    ["issueCreated", "Issue created"], ["statusChanged", "Issue status changed"], ["endOfCycle", "End of cycle"],
  ];
  const SENTRY_EVENTS = [
    ["issueCreated", "Created"], ["issueResolved", "Resolved"], ["issueAssigned", "Assigned"],
    ["issueArchived", "Archived"], ["issueUnresolved", "Unresolved"], ["issueAny", "Any issue event"],
  ];
  const PAGERDUTY_EVENTS = [
    ["incidentTriggered", "Triggered"], ["incidentAcknowledged", "Acknowledged"], ["incidentResolved", "Resolved"],
    ["incidentEscalated", "Escalated"], ["incidentAny", "Any incident event"],
  ];

  let draftTriggers = [{ type: "cron", schedule: "0 8 * * 1-5" }];
  // Which routine the form is editing. Panel-local like draftTriggers: the panel is rebuilt from
  // its markup on every open, so there is nowhere else for it to live.
  let editingRoutineId = null;
  let armedDeleteId = null;
  // Same two-click arming as the routine delete, for "forget every memory".
  let armedClearMemoriesId = null;
  // And for deleting the agent itself (GW-01).
  let armedDeleteAgentId = null;
  // AUDIT-1: ledger heads live here, not in the markup, so an un-revealed one is never in the DOM.
  let auditHeads = [];

  // The host parses each trigger into a typed listener and throws away the members it cannot
  // read (automation-trigger.ts parseMember), then automation-store.upsert writes nothing at all
  // if that leaves none -- and the gateway answers 200 either way. A flat { type: "slack",
  // channel, keyword } parses to nothing. These are the shapes parseMember actually accepts,
  // ported from the operator UI's blankTrigger rather than invented here.
  function blankTrigger(kind) {
    if (kind === "cron") return { type: "cron", schedule: "0 8 * * 1-5" };
    if (kind === "slack") return { type: "slack", channel: "*", match: { kind: "message" } };
    if (kind === "github") return { type: "github", repo: "", events: ["pr-opened"] };
    if (kind === "linear") return { type: "linear", event: { case: "issueCreated" }, projectIds: [], teamIds: [] };
    if (kind === "sentry") return { type: "sentry", event: { case: "issueCreated" }, projectIds: [] };
    if (kind === "pagerduty") return { type: "pagerduty", event: { case: "incidentTriggered" }, serviceIds: [] };
    return { type: "microsoftTeams", tenantId: "", teamId: "", teamIds: [], channelIds: [],
      messageContains: "", messageContainsIsRegex: false, blockUnauthenticatedTeamsUsers: false };
  }

  // A group trigger is n listeners, anything else is one. Cloned, because the form mutates what
  // it is handed and the card behind it is drawn from the same snapshot.
  function triggerMembers(spec) {
    const members = spec == null ? [] : spec.type === "group" ? (spec.listeners ?? []) : [spec];
    return members.length ? members.map((m) => JSON.parse(JSON.stringify(m))) : [blankTrigger("cron")];
  }

  const isCiEvent = (kind) => kind === "ci-passed" || kind === "ci-failed";
  const idList = (value) => String(value).split(/[,\s]+/).filter(Boolean);

  // Ported from the old operator UI. Each rule is a field the host needs and will not complain
  // about: an incomplete trigger is accepted and then never fires, which is the worst outcome.
  // The id filters are genuinely optional -- the host treats an empty list as "everything" -- so
  // demanding a Linear team or a Sentry project here refused triggers the host would have taken.
  function triggerProblem(t) {
    if (t.type === "cron") {
      const v = String(t.schedule ?? "").trim();
      if (!v) return "needs a schedule";
      if (!/^@every\s+\d+\s*[smhd]$/i.test(v) && v.split(/\s+/).length !== 5) return "not a cron expression";
      return null;
    }
    if (t.type === "github") {
      if (!/^[^\s/]+\/[^\s/]+$/.test(String(t.repo ?? "").trim())) return "needs owner/repo";
      if (!(t.events ?? []).length) return "pick at least one event";
      if ((t.events ?? []).some(isCiEvent) && !String(t.ciBranch ?? "").trim()) return "CI events need a branch";
      return null;
    }
    if (t.type === "slack") {
      if (!String(t.channel ?? "").trim()) return "needs a channel, or * for anywhere";
      if (t.match?.kind === "keyword" && !String(t.match.keyword ?? "").trim()) return "needs a keyword";
      return null;
    }
    if (t.type === "microsoftTeams") {
      if (!String(t.tenantId ?? "").trim()) return "needs a tenant id";
      if (!String(t.teamId ?? "").trim()) return "needs a team id";
      return null;
    }
    return null;
  }

  // Field names are the host's, not the form's: a Slack match and its keyword nest under match,
  // an event case nests under event, and the id filters are lists. Writing any of them flat is
  // exactly what the host was dropping.
  function applyTrigger(t, field, value) {
    if (field === "match") t.match = value === "keyword" ? { kind: "keyword", keyword: "" } : { kind: value };
    else if (field === "keyword") t.match = { kind: "keyword", keyword: value };
    else if (field === "event") t.event = value === "statusChanged" ? { case: value, statusIds: [] }
      : value === "endOfCycle" ? { case: value, cycleIds: [] } : { case: value };
    else if (field === "ids") t[t.type === "pagerduty" ? "serviceIds" : "projectIds"] = idList(value);
    else if (field === "teamIds") t.teamIds = idList(value);
    else if (field === "userAllowlist") {
      const users = idList(value);
      if (users.length) t.userAllowlist = users; else delete t.userAllowlist;
    } else t[field] = value;
  }

  function triggerFields(t, i) {
    const box = (name, label, value, hint) =>
      `<div class="field"><label for="trig-${i}-${name}">${escapeHtml(label)}</label><input id="trig-${i}-${name}" data-trig="${i}" data-trig-field="${name}" value="${escapeHtml(String(value ?? ""))}" placeholder="${escapeHtml(hint ?? "")}" /></div>`;
    const pick = (name, label, options, current) =>
      `<div class="field"><label for="trig-${i}-${name}">${escapeHtml(label)}</label><select id="trig-${i}-${name}" data-trig="${i}" data-trig-field="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(current) === v ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select></div>`;
    if (t.type === "cron") return box("schedule", "Cron expression", t.schedule, "0 8 * * 1-5");
    if (t.type === "slack") return pick("match", "Fires on", SLACK_MATCHES, t.match?.kind)
      + box("channel", "Channel", t.channel, "#support or * for anywhere")
      + (t.match?.kind === "keyword" ? box("keyword", "Containing", t.match.keyword, "outage") : "");
    if (t.type === "github") return box("repo", "Repository", t.repo, "owner/repo")
      + `<div class="field"><label>Events</label><div class="tag-list">${GITHUB_EVENTS.map(([v, l]) => `<label class="tag"><input type="checkbox" data-trig="${i}" data-trig-event="${v}" ${(t.events ?? []).includes(v) ? "checked" : ""} /> ${escapeHtml(l)}</label>`).join("")}</div></div>`
      + ((t.events ?? []).some(isCiEvent) ? box("ciBranch", "CI branch", t.ciBranch, "main") : "")
      + box("userAllowlist", "Only from (optional)", (t.userAllowlist ?? []).join(", "), "Anyone");
    if (t.type === "linear") return pick("event", "Fires on", LINEAR_EVENTS, t.event?.case)
      + box("ids", "Project ids (optional)", (t.projectIds ?? []).join(", "), "All projects")
      + box("teamIds", "Team ids (optional)", (t.teamIds ?? []).join(", "), "All teams");
    if (t.type === "sentry") return pick("event", "Fires on", SENTRY_EVENTS, t.event?.case)
      + box("ids", "Project ids (optional)", (t.projectIds ?? []).join(", "), "All projects");
    if (t.type === "pagerduty") return pick("event", "Fires on", PAGERDUTY_EVENTS, t.event?.case)
      + box("ids", "Service ids (optional)", (t.serviceIds ?? []).join(", "), "All services");
    if (t.type === "microsoftTeams") return box("tenantId", "Tenant id", t.tenantId, "")
      + box("teamId", "Team id", t.teamId, "")
      + box("messageContains", "Containing (optional)", t.messageContains, "Any text");
    return "";
  }

  function triggerStackMarkup() {
    // An unserved kind stays in the list, because a routine that already carries one has to be
    // editable, but it cannot be picked and it says why. A schedule is served by the box itself.
    // The note is built from what triggerUnavailable actually said, not from a fixed sentence: a
    // listener the host reports connected drops out of the list and out of the prose with it,
    // rather than being offered in the picker under a paragraph still calling it unavailable.
    const blocked = TRIGGER_KINDS.filter(([kind]) => triggerUnavailable(kind) != null);
    const unsourced = blocked.filter(([kind]) => !RELAY_SOURCED_TRIGGERS.includes(kind)).map(([, label]) => label);
    const unconnected = blocked.filter(([kind]) => RELAY_SOURCED_TRIGGERS.includes(kind)).map(([, label]) => label);
    const sentences = blocked.length === 0 ? [] : [
      `${blocked.length} of the trigger kinds below need a listener this box has not connected, so ${blocked.length === 1 ? "it is" : "they are"} listed and cannot be chosen.`,
      "The host wires its trigger hub to one Slack event source and one GitHub event source and to nothing else, and both are polled out of Cursor\u2019s backend relay, which needs a login this box does not have.",
      ...(unsourced.length ? [`${unsourced.join(", ")} have no event source here at all.`] : []),
      ...(unconnected.length ? [`${unconnected.join(" and ")} would work only while the host reports that listener connected, and it does not.`] : []),
      "A schedule is run by the box itself and always works.",
    ];
    const intro = sentences.length
      ? `<p class="field-hint" data-event-triggers-note>${escapeHtml(sentences.join(" "))}</p>`
      : "";
    return intro + draftTriggers.map((t, i) => {
      const problem = triggerProblem(t);
      const unavailable = triggerUnavailable(t.type);
      const options = TRIGGER_KINDS.map(([v, l]) => {
        const why = triggerUnavailable(v);
        return `<option value="${v}" ${t.type === v ? "selected" : ""}${why && t.type !== v ? " disabled" : ""}>${escapeHtml(why ? `${l} (no listener on this box)` : l)}</option>`;
      }).join("");
      return `<div class="panel-card" style="${problem || unavailable ? "outline:1px solid var(--amber-500)" : ""}"><div class="setting-row"><select data-trig="${i}" data-trig-field="type">${options}</select>${draftTriggers.length > 1 ? `<button class="ghost-button" type="button" data-drop-trigger="${i}">Remove</button>` : ""}</div>${unavailable ? `<span class="field-hint" data-trigger-unavailable="${escapeHtml(t.type)}">${escapeHtml(unavailable)}</span>` : ""}${triggerFields(t, i)}${problem ? `<span class="field-hint">${escapeHtml(problem)}: the host accepts an incomplete trigger and then never fires it.</span>` : ""}</div>`;
    }).join("") + `<button class="ghost-button" type="button" data-add-trigger>＋ Another trigger</button>`;
  }

  function notificationsPanel() {
    const rows = [...state.workers, ...state.rooms]
      .filter((r) => (r.unread ?? 0) > 0)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .map((r) => `<button class="context-action-row" type="button" data-context-kind="${escapeHtml(r.memberIds ? "room" : "worker")}" data-context-id="${escapeHtml(r.id)}"><span><strong>${escapeHtml(r.name)}</strong><small>${escapeHtml(r.preview || "No preview from the host")}</small></span><b>${r.unread}</b></button>`)
      .join("");
    return rows
      ? `<div class="panel-intro"><p>Unread counts as the host reports them. Nothing here is generated by this UI.</p></div><div class="context-detail-list">${rows}</div>`
      : `<div class="empty-state">Nothing unread. This is the host's own unread count — there is no separate notification feed on this gateway.</div>`;
  }

  // ===== Marketplace ==================================================================
  // MARKET-1. The Global capabilities panel became the Marketplace: two pill tabs, Plugins and
  // Bots. Plugins is the catalog the host serves (listMarketplace) drawn against the connector and
  // shell-tool cards this page already builds; Bots is rendered by the bots half of this wave
  // through window.__marketplaceBots. Providers and chat listeners LEFT this panel for Settings --
  // a provider is where the box answers from and a listener is what it listens to; neither is a
  // thing you install, and offering them in a marketplace was the confusion this wave removes.
  //
  // Every write here is a path that already existed: Add is addConnector (or installShellTool),
  // Uninstall is removeConnector, a credential is the same credential card, a tool switch is the
  // same toggleMcpToolDisabled. The catalog only says WHICH entry, never how it is written.
  const MARKETPLACE_ALL = "All";
  let marketplaceTab = "plugins";
  let marketplaceQuery = "";
  let marketplaceCategory = MARKETPLACE_ALL;
  let marketplaceCatalog = null;
  let marketplaceInstalls = [];
  let marketplaceNote = null;
  let marketplacePluginId = null;
  let marketplaceArmedUninstall = null;

  // Which surface the plugin cards are drawn on right now, so a control on a card re-renders the
  // panel it lives in: the Marketplace for a connector or a shell tool, Settings for a provider
  // or a chat listener. Before this, every one of them called renderPluginsPanel and a click on a
  // provider card in Settings would have thrown the operator into the Marketplace.
  let openPluginSurface = "marketplace";

  // The cards this panel owns. Providers and Listeners are in Settings and must not appear here.
  const marketplaceCards = () => state.plugins.filter((plugin) => {
    const group = plugin.group ?? "Connectors";
    return group === "Connectors" || group === "Shell tools";
  });
  const marketplaceItems = () => (marketplaceCatalog?.plugins ?? []);
  const marketplaceItemById = (id) => marketplaceItems().find((item) => String(item.id) === String(id)) ?? null;
  const marketplaceInstallById = (id) => marketplaceInstalls.find((row) => String(row.id) === String(id)) ?? null;

  function renderMarketplacePanel() {
    openPluginSurface = "marketplace";
    openPanel("Marketplace", "Plugins & bots", marketplaceMarkup());
    mountMarketplaceBots();
    refreshMarketplace();
  }

  // The catalog is read once through the gateway and cached by the adapter; the install states are
  // re-derived every time, because a connector added a second ago is still connecting.
  function refreshMarketplace(live) {
    if (typeof adapter.listMarketplace !== "function" || typeof adapter.installedPlugins !== "function") {
      marketplaceNote = "This view has no gateway behind it, so there is no catalog to read.";
      if (elements.panelDialog.open && openPluginSurface === "marketplace") paintMarketplaceBody();
      return;
    }
    Promise.all([adapter.listMarketplace(), adapter.installedPlugins()])
      .then(([catalog, installs]) => {
        marketplaceCatalog = catalog;
        marketplaceInstalls = Array.isArray(installs) ? installs : [];
        marketplaceNote = catalog ? null : "This host serves no marketplace catalog yet — listMarketplace is not one of its commands.";
      })
      .catch((error) => { marketplaceNote = `The marketplace catalog could not be read: ${error.message}`; })
      .then(() => {
        if (!elements.panelDialog.open || openPluginSurface !== "marketplace") return;
        if (live === true) paintMarketplaceLive(); else paintMarketplaceBody();
      });
  }

  // The operator asked for this one, so it redraws everything.
  function paintMarketplaceBody() {
    const body = elements.panelContent.querySelector("[data-marketplace-body]");
    if (!body) return;
    body.innerHTML = marketplaceBodyMarkup();
    mountMarketplaceBots();
  }

  // The box moved under the panel, and nobody asked. A repaint here must never take a half-typed
  // value with it -- a credential being entered, the connector editor's fields, an armed Uninstall
  // -- so it redraws only the two parts that hold no input, and stands down entirely otherwise.
  function paintMarketplaceLive() {
    const body = elements.panelContent.querySelector("[data-marketplace-body]");
    if (!body || marketplaceArmedUninstall) return;
    if (body.contains(document.activeElement)) return;
    if (body.querySelector("[data-connector-editor][open]")) return;
    const typed = [...body.querySelectorAll("input[type=password], input[type=text], input:not([type]), textarea")];
    if (typed.some((field) => field.value !== "")) return;
    const strip = body.querySelector("[data-marketplace-installed]");
    const sections = body.querySelector("[data-marketplace-sections]");
    if (strip) strip.outerHTML = marketplaceInstalledStripMarkup();
    if (sections) sections.innerHTML = marketplaceSectionsMarkup();
    if (!strip && !sections) { body.innerHTML = marketplaceBodyMarkup(); mountMarketplaceBots(); }
  }

  function marketplaceMarkup() {
    const tab = (id, label) => `<button class="roster-tab${marketplaceTab === id ? " is-active" : ""}" type="button" data-marketplace-tab="${id}">${label}</button>`;
    return `<div id="marketplace-panel" data-marketplace><div class="panel-intro"><p>Plugins are the connectors and shell tools this box can run; Bots are agent templates you import. The catalog is served by the host, so an agent's own plugin tools and this page read the same rows. Providers and chat listeners are not installed from here — they are in Settings.</p><span class="status-pill success">global</span></div><div class="roster-tabs" data-marketplace-tabs>${tab("plugins", "Plugins")}${tab("bots", "Bots")}</div><div data-marketplace-body>${marketplaceBodyMarkup()}</div></div>`;
  }

  function marketplaceBodyMarkup() {
    // The Bots tab body belongs to the bots half of this wave. The container and the hook name are
    // the contract between the two; until that half is on the page, the placeholder says so.
    if (marketplaceTab === "bots") return `<div id="marketplace-bots" data-marketplace-bots><div class="empty-state">The Bots tab is drawn by the bot templates half of this wave. It is not on this build.</div></div>`;
    if (marketplacePluginId) return marketplacePluginPageMarkup();
    return marketplaceListMarkup();
  }

  function mountMarketplaceBots() {
    if (marketplaceTab !== "bots") return;
    const container = elements.panelContent.querySelector("#marketplace-bots");
    if (!container) return;
    if (typeof window.__marketplaceBots?.render === "function") window.__marketplaceBots.render(container);
  }

  // -- The Plugins tab, list view: an installed strip, a search field, category chips, and one
  // section per category with a card each.
  function marketplaceInstalledStripMarkup() {
    const cards = marketplaceCards();
    const connected = cards.filter((card) => card.status === "connected").length;
    // QOL-LOGOS: the strip's tiles are the catalog's tiles, at the same 40px as a card's. A card
    // the catalog does not carry (a custom MCP server, a gate's throwaway) keeps the character it
    // has always had, on the default tile.
    const icons = cards
      .map((card) => {
        const icon = marketplaceIconForCard(card);
        const background = icon?.color ? ` style="background:${escapeHtml(marketplaceColor(icon.color))}"` : "";
        const face = icon ? marketplaceTileFaceMarkup(icon, card.name) : escapeHtml(card.icon);
        return `<button class="plugin-icon marketplace-tile" type="button" data-plugin-id="${escapeHtml(card.id)}" title="${escapeHtml(card.name)}" aria-label="${escapeHtml(card.name)}"${background}>${face}</button>`;
      })
      .join("");
    return `<div class="marketplace-installed" data-marketplace-installed><span><strong>${cards.length} installed</strong> · ${connected} connected</span><div class="marketplace-installed-icons">${icons || `<small>Nothing is installed on this box yet.</small>`}</div></div>`;
  }

  function marketplaceCategories() {
    const items = marketplaceItems();
    if (!items.length) return [MARKETPLACE_ALL];
    const declared = (marketplaceCatalog?.categories ?? []).map(String);
    const used = [...new Set(items.map((item) => String(item.category ?? "")).filter(Boolean))];
    const featured = items.some((item) => item.featured === true) ? ["Featured"] : [];
    const ordered = declared.length ? declared : [...featured, ...used];
    return [
      MARKETPLACE_ALL,
      ...ordered.filter((name) => (name === "Featured" ? featured.length > 0 : used.includes(name))),
      ...used.filter((name) => !ordered.includes(name)),
    ];
  }

  // The catalog's tile colour, and only a colour. It lands inside a style attribute, so anything
  // that is not a plain CSS colour token is dropped rather than painted; the catalog is repo data,
  // and this keeps it that way rather than trusting it to stay that way.
  const marketplaceColor = (value) => {
    const text = String(value ?? "").trim();
    return /^#[0-9a-f]{3,8}$/i.test(text) || /^rgba?\([\d.,\s%]+\)$/i.test(text) || /^[a-z]+$/i.test(text)
      ? text : "rgba(255, 255, 255, 0.08)";
  };

  // -- QOL-LOGOS ------------------------------------------------------------------------------
  // One tile, one size, everywhere. The catalog may name a logo FILE beside its letter and colour
  // (`icon.file` on a plugin, `tile.file` on a bot, source/shared/marketplace/catalog.ts). It is a
  // path relative to /machine-room/ -- a file the relay already serves out of ui/machine-room/,
  // beside app.js -- and NEVER a URL: this console fetches nothing from the internet, so a box with
  // no outbound network still paints the whole panel. The letter tile stays the fallback for a
  // plugin the catalog gives no file, and for a file that does not load.
  const MARKETPLACE_LOGO_PREFIX = "marketplace/logos/";
  const marketplaceLogoSrc = (file) => {
    const value = String(file ?? "").trim();
    if (!value.startsWith(MARKETPLACE_LOGO_PREFIX)) return "";
    if (value.split("/").includes("..")) return "";
    return /^[\w./-]+\.(svg|png)$/i.test(value) ? value : "";
  };

  // The tile's face: the logo when the catalog names one, the letter otherwise. The letter rides
  // along in data-marketplace-letter so a broken image can be turned back into the letter tile
  // without a second read of the catalog.
  function marketplaceTileFaceMarkup(icon, name) {
    const letter = String(icon?.letter ?? String(name ?? "?").slice(0, 1)).toUpperCase();
    const src = marketplaceLogoSrc(icon?.file);
    if (!src) return escapeHtml(letter);
    return `<img class="marketplace-tile-img" src="${escapeHtml(src)}" alt="" data-marketplace-logo="${escapeHtml(src)}" data-marketplace-letter="${escapeHtml(letter)}" />`;
  }

  // The whole tile, at one of the two standard sizes: 40px on a card and in the installed strip,
  // 64px on the plugin page. The size is CSS, not markup, so nothing here can invent a third one.
  function marketplaceTileMarkup(icon, name, large) {
    const color = marketplaceColor(icon?.color);
    return `<span class="plugin-icon marketplace-tile${large === true ? " is-large" : ""}" style="background:${escapeHtml(color)}">${marketplaceTileFaceMarkup(icon, name)}</span>`;
  }

  // An installed card's catalog icon, so the strip's tiles are the same tiles as the cards'. The
  // strip is drawn from what the box actually runs (state.plugins), and marketplaceInstalls is the
  // only thing that says which catalog row a card id belongs to.
  function marketplaceIconForCard(card) {
    const row = marketplaceInstalls.find((install) => String(install.cardId) === String(card?.id));
    const item = row ? marketplaceItemById(row.id) : null;
    return item?.icon ?? null;
  }

  // An image that does not load must not leave a broken-image glyph where a tile should be: the
  // img is dropped and its letter written back, so the fallback is the letter tile the catalog
  // always carried. `error` does not bubble, so this listens in the capture phase, once.
  if (!window.__marketplaceLogoFallback) {
    window.__marketplaceLogoFallback = true;
    document.addEventListener("error", (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("marketplace-tile-img")) return;
      const tile = img.parentElement;
      const letter = String(img.dataset.marketplaceLetter ?? "?");
      img.remove();
      if (tile) tile.textContent = letter;
    }, true);
  }

  // The same filter the catalog's own SearchPlugins tool applies: name, tagline, category.
  function marketplaceMatches(item) {
    const q = marketplaceQuery.trim().toLowerCase();
    if (!q) return true;
    return [item.name, item.tagline, item.category].some((field) => String(field ?? "").toLowerCase().includes(q));
  }

  function marketplaceCardMarkup(item) {
    const install = marketplaceInstallById(item.id);
    const action = install?.installed === true
      ? `<span class="status-pill success marketplace-card-action" data-marketplace-added="${escapeHtml(item.id)}">✓ Added</span>`
      : `<button class="primary-button marketplace-card-action" type="button" data-marketplace-add="${escapeHtml(item.id)}">Add</button>`;
    // QOL-LOGOS: one tile at one size (the catalog's logo when it names one, its letter when not),
    // and the action carries its own class so the "✓ Added" pill cannot be squeezed to a clip.
    return `<div class="plugin-card marketplace-card" data-marketplace-card="${escapeHtml(item.id)}"><button class="marketplace-card-open" type="button" data-marketplace-plugin="${escapeHtml(item.id)}">${marketplaceTileMarkup(item?.icon, item?.name)}<span class="marketplace-card-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.tagline ?? "")}</small></span></button>${action}</div>`;
  }

  function marketplaceSectionsMarkup() {
    const items = marketplaceItems().filter(marketplaceMatches);
    if (!items.length) {
      return marketplaceItems().length
        ? `<div class="empty-state">No plugin in this catalog matches “${escapeHtml(marketplaceQuery)}”.</div>`
        : `<div class="empty-state">There is no catalog to draw. The installed strip above is what this box is actually running.</div>`;
    }
    // QOL-LOGOS: a card is drawn ONCE on the page. Featured is a flag, not a category, so a
    // featured plugin used to be painted twice under All -- once in Featured and again in its own
    // category -- which is what the operator's screenshot shows. The CATEGORY section keeps every
    // member and Featured yields to it, because the other way round emptied four headings out of
    // the default view: five of ten plugins are featured, and Communication, Project management,
    // Web & Search and Code review have no other member. Press the Featured chip and the section
    // is drawn on its own with all of them, which is what makes the chip worth pressing.
    const shown = marketplaceCategories()
      .filter((category) => category !== MARKETPLACE_ALL)
      .filter((category) => marketplaceCategory === MARKETPLACE_ALL || category === marketplaceCategory);
    const claimed = new Set(shown
      .filter((category) => category !== "Featured")
      .flatMap((category) => items.filter((item) => String(item.category ?? "") === category).map((item) => String(item.id))));
    const sections = shown
      .map((category) => {
        const members = category === "Featured"
          ? items.filter((item) => item.featured === true && !claimed.has(String(item.id)))
          : items.filter((item) => String(item.category ?? "") === category);
        if (!members.length) return "";
        return `<div class="plugin-group-title">${escapeHtml(category)}</div><div class="marketplace-grid">${members.map(marketplaceCardMarkup).join("")}</div>`;
      })
      .join("");
    return sections || `<div class="empty-state">Nothing in that category matches.</div>`;
  }

  function marketplaceListMarkup() {
    const chips = marketplaceCategories()
      .map((category) => `<button class="tag${marketplaceCategory === category ? " is-active" : ""}" type="button" data-marketplace-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`)
      .join("");
    const note = marketplaceNote ? `<div class="empty-state" data-marketplace-note>${escapeHtml(marketplaceNote)}</div>` : "";
    return `${marketplaceInstalledStripMarkup()}<div class="field marketplace-search"><label class="sr-only" for="marketplace-search">Search plugins</label><input class="search-input" id="marketplace-search" data-marketplace-search type="search" placeholder="Search plugins" value="${escapeHtml(marketplaceQuery)}" /></div><div class="palette-chips marketplace-chips" data-marketplace-chips>${chips}</div>${note}<div class="marketplace-sections" data-marketplace-sections>${marketplaceSectionsMarkup()}</div>${connectorEditorMarkup()}`;
  }

  // -- The plugin page. Opened from a card, or from the installed strip for a connector nobody put
  // in the catalog (a custom MCP server, or the throwaway one a gate adds), which gets a page
  // drawn from its own card alone.
  function marketplacePluginPageMarkup() {
    const key = String(marketplacePluginId);
    const item = marketplaceItemById(key);
    const install = marketplaceInstallById(key);
    // The key is a card id when the operator came from the installed strip (the strip emits card
    // ids verbatim, and a demo card's id carries no colon), and a catalog id when it came from a
    // catalog card; try the verbatim id first, then the connector card the catalog names.
    const cardId = install?.cardId ?? (key.includes(":") ? key : `mcp:${key}`);
    const card = state.plugins.find((plugin) => plugin.id === key)
      ?? state.plugins.find((plugin) => plugin.id === cardId) ?? null;
    // The tool switches on this page are handled by id through selectedPluginId, and this page can
    // be reached from a catalog card as well as from the installed strip. Pinning it here means it
    // is the card on screen whichever way the operator arrived.
    if (card) selectedPluginId = card.id;
    const back = `<div class="form-actions"><button class="ghost-button" type="button" data-marketplace-back>← All plugins</button></div>`;
    if (!item && !card) return `${back}<div class="empty-state">That plugin is not in this host's catalog and nothing on this box matches it.</div>`;
    const lead = contextLead();
    const name = String(item?.name ?? card?.name ?? key);
    // QOL-LOGOS: the same tile as the card, at the page size. A card with no catalog row behind it
    // keeps its own character and the console's default tile colour.
    const hero = item?.icon
      ? marketplaceTileMarkup(item.icon, name, true)
      : `<span class="plugin-icon marketplace-tile is-large">${escapeHtml(String(card?.icon ?? name.slice(0, 1)).toUpperCase())}</span>`;
    const description = String(item?.description ?? card?.description ?? "");
    // A catalog row carries the contract's three states. A card with no catalog row keeps the
    // status pill it has always had rather than being forced into a vocabulary it never used.
    const label = install ? install.label : pluginStatusLabel(card?.status ?? "available");
    const ready = install ? install.ready === true : card?.status === "connected";
    const source = item?.source?.url
      ? `<a class="ghost-button" href="${escapeHtml(String(item.source.url))}" target="_blank" rel="noreferrer noopener" data-marketplace-source>View source ↗</a>`
      : "";
    return `${back}<section class="plugin-detail"><div class="plugin-hero">${hero}<div class="plugin-hero-copy"><h3>${escapeHtml(name)}</h3><p>${escapeHtml(description)}</p></div><span class="status-pill${ready ? " success" : ""}">${escapeHtml(label)}</span></div><div class="form-actions marketplace-actions">${source}${marketplaceInstallControlMarkup(item, install, card)}</div><div class="plugin-sections">${marketplaceAccountsSectionMarkup(item, install, card, lead)}${card?.shellTool ? shellToolMarkup(card, lead) : ""}${marketplaceConnectorsSectionMarkup(item, card)}</div></section>`;
  }

  // Add, or Uninstall with the offer to clear what the host stores for it. The clear has to happen
  // BEFORE the entry leaves connectors.json: deleteConnectorSecret resolves the server through
  // that file, so once the row is gone the host cannot reach its own store for it.
  function marketplaceInstallControlMarkup(item, install, card) {
    const stored = (install?.storedCredentials ?? card?.storedFields ?? []).length;
    const installed = install?.installed === true || (install == null && card?.removable === true);
    if (!installed) return item ? `<button class="primary-button" type="button" data-marketplace-add="${escapeHtml(item.id)}">Add</button>` : "";
    // A shell tool has no inverse here: installShellTool runs an installer in the box and the host
    // has no command that removes it. Offering an Uninstall would call removeConnector with a name
    // connectors.json has never held, which answers "not in connectors.json" and does nothing.
    if (install?.kind === "shell-tool" || card?.shellTool != null) return "";
    const name = install?.connectorName || card?.name || "";
    if (!name || typeof adapter.removeConnector !== "function") return "";
    const armed = marketplaceArmedUninstall === name;
    const clear = stored > 0
      ? `<label class="tag"><input type="checkbox" data-marketplace-clear-secrets checked /> Also clear the ${stored} value${stored === 1 ? "" : "s"} the host stores for it</label>`
      : "";
    return `${clear}<button class="danger-button" type="button" data-marketplace-uninstall="${escapeHtml(name)}">${armed ? "Click again to remove" : "Uninstall"}</button>`;
  }

  function marketplaceAccountsSectionMarkup(item, install, card, lead) {
    const label = install ? install.label : pluginStatusLabel(card?.status ?? "available");
    const ready = install ? install.ready === true : card?.status === "connected";
    const line = install?.installed === false
      ? "Add it and its credential fields appear here; the host stores the values, never this page."
      : install?.needsAuth
        ? `The host holds no value for ${install.missingCredentials.join(", ")}. Enter it below and the host stores it.`
        : "The host holds this account's credentials in its own 0600 store and hands them to the process it launches.";
    const account = `<div class="setting-row" data-marketplace-account="${escapeHtml(String(item?.id ?? card?.id ?? ""))}"><div><strong>default</strong><small>${escapeHtml(line)}</small></div><span class="status-pill${ready ? " success" : ""}">${escapeHtml(label)}</span></div>`;
    // Not installed: the catalog's own one-line hints are all there is to show, and they are what
    // an operator needs before they go and make the credential.
    const hints = install?.installed === false && item?.credentialHints
      ? Object.entries(item.credentialHints).map(([field, hint]) => `<div class="setting-row"><div><strong>${escapeHtml(field)}</strong><small data-credential-hint="${escapeHtml(field)}">${escapeHtml(String(hint))}</small></div></div>`).join("")
      : "";
    const body = card ? `${pluginAccountMarkup(card, lead)}${pluginSecretsMarkup(card)}` : "";
    return `<section data-marketplace-accounts><div class="plugin-section-title"><span>Accounts</span><span>1 account</span></div>${account}${hints}${body}</section>`;
  }

  function marketplaceConnectorsSectionMarkup(item, card) {
    const shellTool = item?.kind === "shell-tool" || card?.shellTool != null;
    const count = `<span>${!shellTool && card?.tools?.length ? `${card.tools.filter((tool) => tool.enabled).length}/${card.tools.length} enabled` : !shellTool && card ? "1 connector" : "0 connectors"}</span>`;
    if (!card || shellTool) {
      return `<section data-marketplace-connectors><div class="plugin-section-title"><span>Connectors</span>${count}</div><div class="empty-state">${escapeHtml(shellTool ? "A shell tool is not an MCP server: the agent runs its command itself, so there is no connector here. Its command and its key are above." : "Not on this box yet. Add it and the host launches its server, discovers its tools, and lists them here.")}</div></section>`;
    }
    const status = String(card.boxStatus ?? card.status ?? "unknown");
    const server = `<div class="setting-row" data-connector-status="${escapeHtml(card.name)}"><div><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.description)}</small></div><span class="status-pill${card.status === "connected" ? " success" : ""}">${escapeHtml(status)}</span></div>`;
    return `<section data-marketplace-connectors><div class="plugin-section-title"><span>Connectors</span>${count}</div>${server}<div class="plugin-list">${pluginToolsMarkup(card)}</div></section>`;
  }

  // Typing filters the sections in place: repainting the whole body would take the focus and the
  // caret out of the field on every keystroke.
  function handleMarketplaceInput(event) {
    const field = event.target.closest?.("[data-marketplace-search]");
    if (!field) return;
    marketplaceQuery = field.value;
    const sections = elements.panelContent.querySelector("[data-marketplace-sections]");
    if (sections) sections.innerHTML = marketplaceSectionsMarkup();
  }

  // The Marketplace, or Settings, or neither: a card control re-renders the panel it is drawn in.
  function renderPluginsPanel() {
    if (openPluginSurface === "settings") { openSettingsPanel(); return; }
    renderMarketplacePanel();
  }

  // ===== end Marketplace ==============================================================

  // CP-11: adding a connector used to mean an operator editing connectors.json inside the
  // container by hand. The relay owns that file (GET/POST /connectors) and the host re-reads it
  // on refreshMcp, so this form is the whole round trip. Environment VALUES are deliberately not
  // collected here -- the file is plaintext on the box; the values go through the key form on the
  // connector's own card, which hands them to the host's store.
  function connectorEditorMarkup() {
    if (typeof adapter.addConnector !== "function") return "";
    const configured = state.plugins.filter((p) => p.group === "Connectors" && p.removable);
    const rows = configured.length
      ? configured.map((p) => `<div class="setting-row"><div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.category)}</small></div><button class="ghost-button" type="button" data-remove-connector="${escapeHtml(p.name)}">Remove</button></div>`).join("")
      : `<div class="empty-state">No stdio connector is configured on this box yet.</div>`;
    // CONNECT-3: a preset is a button that FILLS this form, not one that installs anything. The
    // operator sees the entry before it is written, and the credential still goes through the key
    // form on the connector's own card afterwards.
    const presets = typeof adapter.connectorPresets === "function" ? adapter.connectorPresets() : [];
    const presetRow = presets.length
      ? `<div class="form-actions" data-connector-presets>${presets.map((p) => `<button class="ghost-button" type="button" data-connector-preset="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`).join("")}</div><span class="field-hint">A preset fills the fields below with that service's connector entry, so it can be read before it is written. Nothing is written until Add connector, and a credential is a separate step on the connector's own card.</span>`
      : "";
    // Filled by the preset click below with one line per credential the filled entry will want:
    // what it is, where it is created, the least it needs. An operator reading the form before
    // pressing Add connector can see what they have to go and get, rather than finding out at the
    // key form on the card afterwards.
    const presetHints = presets.length ? `<div class="plugin-list" data-connector-preset-hints></div>` : "";
    return `<details class="panel-card" data-connector-editor><summary>Add or remove a connector</summary><p class="field-hint">Writes connectors.json on the box and calls refreshMcp, so the host relaunches its stdio servers without a container restart. Give the environment variable NAMES the process needs; their values go in the key form on the connector's card, where the host stores them instead of this file.</p>${presetRow}${presetHints}<form data-add-connector><div class="field"><label for="connector-name">Name</label><input id="connector-name" name="name" required placeholder="e.g. localfiles" /></div><div class="field"><label for="connector-command">Command</label><input id="connector-command" name="command" required placeholder="e.g. npx" /></div><div class="field"><label for="connector-args">Arguments</label><input id="connector-args" name="args" placeholder="space separated; quote one that holds a space, e.g. --header &quot;Name:Value&quot;" /></div><div class="field"><label for="connector-env">Environment variable names</label><input id="connector-env" name="envNames" placeholder="comma separated, names only" /></div><div class="form-actions"><button class="primary-button" type="submit">Add connector</button></div></form><div class="plugin-list">${rows}</div></details>`;
  }

  function agentProfilePanel(worker) {
    const model = modelById(worker.model);
    const routines = routinesForContext({ kind: "worker", id: worker.id });
    // Role is the host's own per-agent title and updateAgent writes it, so this is a field rather
    // than the literal words "not set". The endpoint is box-wide and says so.
    // Every control here is drawn only where the adapter in front of this page actually
    // implements it. The offline demo factory has no setRole, getMemories, forgetMemory or
    // clearMemories, and an unguarded button would throw a TypeError out of the click handler
    // and simply do nothing -- a control that looks live and is not.
    const canWriteRole = typeof adapter.setRole === "function";
    // GW-01: name and description go through the same updateAgent profile write as the role, so
    // the three share one Save. Avatar, notifications, hide, duplicate and delete are each their
    // own gateway command and each is drawn only where the adapter implements it.
    const canWriteProfile = typeof adapter.updateProfile === "function";
    const canReadMemories = typeof adapter.getMemories === "function";
    const canAvatar = typeof adapter.setAvatar === "function";
    const canNotify = typeof adapter.setNotifications === "function";
    const canHide = typeof adapter.setHidden === "function";
    const canDuplicate = typeof adapter.duplicateAgent === "function";
    const canDelete = typeof adapter.deleteAgent === "function";
    const canAudit = typeof adapter.getActionAudit === "function";
    // These three fields carried an inline min-width of 220px. A setting row's label column asks
    // for 200px of its own, and this card is 367px wide inside the two-column panel grid, so the
    // control was pinned 84px past the card's right edge and the whole dialog scrolled sideways
    // to reach it. The width is the stylesheet's now (styles.css, "qol/panels"): the row wraps
    // the control under its label when there is no room beside it.
    const identity = canWriteProfile
      ? `<div class="setting-row"><div><strong>Name</strong><small>The host's own name for this agent, on its profile file.</small></div><div class="field" style="margin:0"><label class="sr-only" for="agent-name">Name</label><input id="agent-name" data-name-for="${escapeHtml(worker.id)}" value="${escapeHtml(worker.name)}" required /></div></div><div class="setting-row"><div><strong>Description</strong><small>What this agent is for, as the host stores it. Shown on its profile; the sidebar line is its state, not this text.</small></div><div class="field" style="margin:0"><label class="sr-only" for="agent-description">Description</label><textarea id="agent-description" data-description-for="${escapeHtml(worker.id)}" rows="3">${escapeHtml(worker.description ?? "")}</textarea></div></div>`
      : "";
    const role = `<div class="setting-row"><div><strong>Role</strong><small>The host's own per-agent title, stored on this agent's profile file. Blank is a real answer — the context card hides the row rather than printing the words 'not set'.</small></div><div class="field" style="margin:0"><label class="sr-only" for="agent-role">Role</label><input id="agent-role" data-role-for="${escapeHtml(worker.id)}" value="${escapeHtml(worker.role)}"${canWriteRole ? "" : " readonly"} placeholder="e.g. Service desk specialist" /></div>${canWriteRole ? `<button class="ghost-button" type="button" data-save-role="${escapeHtml(worker.id)}">Save</button>` : `<span class="status-pill">read-only offline</span>`}</div>`;
    const avatar = canAvatar
      ? `<div class="setting-row"><div><strong>Avatar</strong><small data-avatar-note>${worker.avatarVersion ? `The host serves this agent's own avatar (version ${escapeHtml(String(worker.avatarVersion))}).` : "The host holds no avatar for this agent; the face shown is a placeholder. Upload a PNG and the host stores and serves it."}</small></div><label class="ghost-button avatar-upload"><input type="file" accept="image/png,.png" data-avatar-for="${escapeHtml(worker.id)}" hidden />Upload PNG</label></div>`
      : "";
    const switches = (canNotify ? `<div class="setting-row"><div><strong>Notify on updates</strong><small>The host's per-agent notification flag (setAgentNotifyOnUpdates). Off, and this agent's replies raise no notification.</small></div><button class="switch" type="button" data-toggle-notify="${escapeHtml(worker.id)}" aria-label="Notify on updates" aria-pressed="${worker.notify !== false}"></button></div>` : "")
      + (canHide ? `<div class="setting-row"><div><strong>Hidden from the roster</strong><small>Moves this agent to the roster's collapsed Hidden group. It stays on the box and keeps working.</small></div><button class="switch" type="button" data-toggle-hidden="${escapeHtml(worker.id)}" aria-label="Hide from the roster" aria-pressed="${worker.hidden === true}"></button></div>` : "");
    const hygiene = canDuplicate || canDelete
      ? `<div class="setting-row"><div><strong>Duplicate</strong><small>Clones this agent on the host as “${escapeHtml(worker.name)} copy” — profile, skills and routines, not the conversation.</small></div>${canDuplicate ? `<button class="ghost-button" type="button" data-duplicate-agent="${escapeHtml(worker.id)}">Duplicate</button>` : ""}</div>${canDelete ? `<div class="setting-row"><div><strong>Delete this agent</strong><small>Removes the agent and its conversation from the host. Two clicks; the host keeps no copy.</small></div><button class="danger-button" type="button" data-delete-agent="${escapeHtml(worker.id)}">Delete</button></div>` : ""}`
      : "";
    const browser = `<div class="setting-row"><div><strong>Browser</strong><small data-browser-screen="${escapeHtml(worker.id)}">${escapeHtml(worker.browser.screen || "Asking the host which screen this agent has…")}</small></div><button class="ghost-button" type="button" data-open-context-browser>Open</button></div>`;
    const memories = canReadMemories
      ? `<section class="settings-section" data-memories-for="${escapeHtml(worker.id)}"><div class="setting-row"><div><strong>Memory</strong><small>What the host has remembered about this agent across conversations.</small></div>${typeof adapter.clearMemories === "function" ? `<button class="ghost-button" type="button" data-clear-memories="${escapeHtml(worker.id)}">Forget all</button>` : ""}</div><div class="context-detail-list" data-memory-list>Reading this agent's memories…</div></section>`
      : "";
    // AUDIT-1: the action ledger the host writes on every tool action, read on demand so opening
    // the panel does not pull the whole file; heads stay out of the DOM until asked for, the way
    // the evidence disclosure holds its attestations.
    const audit = canAudit
      ? `<section class="settings-section" data-audit-for="${escapeHtml(worker.id)}"><div class="setting-row"><div><strong>Action ledger</strong><small>Every tool action the host recorded for this agent (getAgentActionAudit), newest first. Tool output is withheld until you ask for one row's.</small></div><button class="ghost-button" type="button" data-read-audit="${escapeHtml(worker.id)}">Read</button></div><div class="context-detail-list" data-audit-list></div></section>`
      : "";
    return `<div class="panel-grid"><section class="panel-card"><div class="panel-card-header">${avatarMarkup(worker, "context-profile-avatar")}<span class="status-pill ${worker.status === "working" ? "working" : worker.status === "attention" ? "" : "success"}">${escapeHtml(worker.statusText)}</span></div><h3>${escapeHtml(worker.name)}</h3><p>${escapeHtml(worker.role || "No role set on the host.")}</p><div class="tag-list"><span class="tag">endpoint (box-wide) · ${escapeHtml(model ? model.name : worker.model)}</span><span class="tag">${worker.files.length} files</span><span class="tag">${routines.length} routines</span></div></section><section class="settings-section"><h3>Agent-owned context</h3><p>The direct transcript, the role and the routines shown here belong to this agent. The endpoint and the box's screens belong to the whole box and are shared with every other agent on it.</p>${identity}${role}${avatar}${switches}<div class="setting-row"><div><strong>Direct conversation</strong><small>Operator-to-agent thread</small></div><span class="status-pill ${worker.status === "working" ? "working" : ""}">${escapeHtml(worker.statusText)}</span></div>${browser}${hygiene}</section>${memories}${audit}</div>`;
  }

  // The two async fills the panel above leaves placeholders for. Both are real host reads: the
  // screen comes from ensureForeverBox, the memories from getAgentMemories.
  function memoryRowsMarkup(rows) {
    if (!rows.length) return `<div class="empty-state">The host holds no memories for this agent yet.</div>`;
    return rows.map((row) => {
      // The host returns a plain string for a memory with no envelope; the operator page handles
      // that shape and this one used to JSON-quote it. A row with no id cannot be forgotten one
      // at a time, so it gets no button rather than a button that posts an empty memoryId.
      const plain = typeof row === "string";
      const id = plain ? "" : row.id ?? row.memoryId ?? "";
      const text = plain ? row : row.text ?? row.content ?? row.memory ?? JSON.stringify(row);
      const forget = id && typeof adapter.forgetMemory === "function"
        ? `<button class="ghost-button" type="button" data-forget-memory="${escapeHtml(String(id))}">Forget</button>`
        : `<span class="status-pill">${id ? "read-only offline" : "no id — clear all only"}</span>`;
      return `<div class="context-detail-row"><span>${escapeHtml(String(text))}</span>${forget}</div>`;
    }).join("");
  }

  function fillAgentProfilePanel(worker) {
    const screen = elements.panelContent.querySelector(`[data-browser-screen="${CSS.escape(worker.id)}"]`);
    if (screen && adapter.describeScreen) {
      adapter.describeScreen(worker.id)
        .then((line) => { screen.textContent = line; })
        .catch((error) => { screen.textContent = `The host could not say which screen this agent has: ${error.message}`; });
    }
    const list = elements.panelContent.querySelector("[data-memory-list]");
    if (list && adapter.getMemories) {
      adapter.getMemories(worker.id)
        .then((rows) => { list.innerHTML = memoryRowsMarkup(rows); })
        .catch((error) => { list.innerHTML = `<div class="empty-state">Could not read this agent's memories: ${escapeHtml(error.message)}</div>`; });
    }
  }

  function openAgentProfile(worker) {
    if (!worker) return;
    armedDeleteAgentId = null;
    auditHeads = [];
    openPanel("Agent details", worker.name, agentProfilePanel(worker));
    fillAgentProfilePanel(worker);
  }

  function membersPanel() {
    const room = contextRecord();
    const rows = state.workers.map((worker) => {
      const member = room.memberIds.includes(worker.id);
      return `<div class="member-manager-row"><div class="member-row">${avatarMarkup(worker, "member-avatar")}<span>${escapeHtml(worker.name)}</span></div><button class="${member ? "ghost-button" : "primary-button"}" type="button" data-manage-member="${escapeHtml(worker.id)}" data-member-action="${member ? "remove" : "add"}">${member ? "Remove" : "Add"}</button></div>`;
    }).join("");
    return `<div class="panel-intro"><p>This is a real group-chat roster. Only these workers receive a turn or appear with sender labels in <strong>${escapeHtml(room.name)}</strong>.</p><span class="status-pill success">${room.memberIds.length} members</span></div><div class="member-manager-list">${rows}</div>`;
  }

  // PROVIDERS-1: providers and chat listeners left the Marketplace for Settings. A provider is
  // where this box answers from; a listener is what it listens to. Neither is something you
  // install, and neither belongs in a catalog of things you do. The CARDS are unchanged -- the
  // same nav buttons and the same pluginDetailMarkup the Plugins page drew -- so nothing about
  // their behaviour moved with them, only the panel they are in.
  const pluginNavButton = (plugin, activeId) => `<button class="plugin-nav-button${plugin.id === activeId ? " is-active" : ""}" type="button" data-plugin-id="${escapeHtml(plugin.id)}"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><span><strong>${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.category)}</small></span><span class="status-dot ${plugin.status === "connected" ? "success" : plugin.status === "installed" ? "attention" : ""}"></span></button>`;

  function pluginGroupSection(group, title, blurb, empty) {
    const members = state.plugins.filter((plugin) => (plugin.group ?? "Connectors") === group);
    const head = `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(blurb)}</p>`;
    if (!members.length) return `<section class="settings-section" data-plugin-group="${escapeHtml(group)}">${head}<div class="empty-state">${escapeHtml(empty)}</div></section>`;
    // One selection on the page, one open card. Falling back to each section's own first member
    // put TWO detail panes on Settings at once: the Slack listener's Connect form, its masked
    // token input and its Cursor-route button sat beside every provider card, which is a change
    // in what a provider card shows and this move was meant to change only where they live.
    // The section that owns the selection draws the detail; the other draws its cards alone.
    const selected = members.find((plugin) => plugin.id === selectedPluginId) ?? null;
    const detail = selected
      ? `<section class="plugin-detail">${pluginDetailMarkup(selected)}</section>`
      : `<div class="empty-state">Pick one to open it.</div>`;
    return `<section class="settings-section" data-plugin-group="${escapeHtml(group)}">${head}<div class="plugin-browser"><aside class="plugin-sidebar">${members.map((plugin) => pluginNavButton(plugin, selected?.id ?? null)).join("")}</aside>${detail}</div></section>`;
  }

  function settingsPanel() {
    // Per-agent routing does not exist on this host: updateAgent takes only name, description and
    // title, and the model is resolved globally from box-secrets.json on every request. A picker
    // per worker promised something the machine cannot do. One endpoint, switchable, is the truth.
    const rows = `<div class="setting-row"><div><strong>Endpoint</strong><small>Every worker and every subagent on this box answers through this one. Switching takes effect on the next turn.</small></div><select class="model-select" id="endpoint-select" aria-label="Inference endpoint"><option value="">Loading…</option></select></div><div class="setting-row"><div><strong>Currently answering</strong><small id="endpoint-current">Reading from the box…</small></div><span class="status-pill" id="endpoint-health">…</span></div>`;
    // GW-10: the desktop app's Updates tab, which box-reference-docs.ts tells the model to send
    // users to. Update and Reset recreate the box for the agent on screen (the host keys both by
    // agent id). updateHostNow is deliberately NOT here: it swaps the host bundle from S3, and this
    // box runs a locally patched bundle that such a swap would overwrite.
    const boxAgent = contextLead();
    const updates = typeof adapter.getHostStatus === "function"
      ? `<section class="settings-section" data-updates-panel><h3>Updates</h3><p>The host bundle this box runs, as getHostStatus reports it. The host itself is not updated from this page: updateHostNow would fetch a bundle from S3 over the locally patched one this box runs, so that command is left unwired here on purpose.</p><div class="setting-row"><div><strong>Host version</strong><small data-host-version>Reading from the host…</small></div><span class="status-pill" data-host-update>…</span></div>${boxAgent ? `<div class="setting-row"><div><strong>Update ${escapeHtml(boxAgent.name)}'s computer</strong><small>Moves the box to a fresh instance and keeps files and logins. Two clicks.</small></div><button class="ghost-button" type="button" data-update-box="${escapeHtml(boxAgent.id)}"${typeof adapter.updateBox === "function" ? "" : " disabled"}>Update</button></div><div class="setting-row"><div><strong>Reset ${escapeHtml(boxAgent.name)}'s computer</strong><small>Restores the box from its last snapshot. Recent unsynced work can be lost — prefer Update. Two clicks.</small></div><button class="danger-button" type="button" data-reset-box="${escapeHtml(boxAgent.id)}"${typeof adapter.resetBox === "function" ? "" : " disabled"}>Reset</button></div>` : ""}</section>`
      : "";
    return `<div class="panel-intro"><p>Inference and review policy are global on this host. Routines stay attached to individual agents and rooms.</p><span class="status-pill${state.settings.reachable ? " success" : ""}">${state.settings.reachable ? "Host settings loaded" : "Host settings unreachable"}</span></div><div class="settings-list"><section class="settings-section"><h3>Inference</h3><p>This host routes every agent through a single endpoint. Per-agent models are not something it can do.</p>${rows}</section>${pluginGroupSection("Providers", "Providers", "Every endpoint this box could answer through, as the relay reports them. Adopting one stores its credential in the relay's 0600 store on this Mac; switching one is the endpoint row above.", "The relay reports no providers for this box.")}${pluginGroupSection("Listeners", "Chat listeners", "The chat platforms the host binds to. A listener binds to one agent at a time — the agent whose conversation is on screen.", "This host reports no chat listeners.")}<section class="settings-section"><div class="setting-row"><div><strong>Natural-language auto-review</strong><small>${state.settings.autoReview.enabled ? "Armed. The host checks each action against the instructions below." : "Off. Every tool an agent holds runs without review."}</small></div><button class="switch" type="button" id="auto-review-toggle" aria-pressed="${state.settings.autoReview.enabled}"></button></div><div class="field"><label for="auto-review-rule">Ask me before…</label><textarea id="auto-review-rule" rows="3" placeholder="e.g. sending email, deleting anything, spending money">${escapeHtml((state.settings.autoReview.block ?? []).join("\n"))}</textarea></div>${(state.settings.autoReview.allow ?? []).length ? `<div class="setting-row"><div><strong>Always allowed</strong><small>${escapeHtml((state.settings.autoReview.allow ?? []).join("; "))}</small></div></div>` : ""}${state.settings.localToolPermission ? `<div class="setting-row"><div><strong>Local tool permission</strong><small>The host is set to "${escapeHtml(state.settings.localToolPermission)}" for tools that run on this machine.</small></div><span class="status-pill">${escapeHtml(state.settings.localToolPermission)}</span></div>` : ""}<div class="form-actions"><button class="primary-button" type="button" data-save-review>Save policy</button></div></section>${updates}</div>`;
  }

  function openSettingsPanel() {
    openPluginSurface = "settings";
    openPanel("Global router & policy", "Operator settings", settingsPanel());
    fillEndpoints();
    fillHostStatus();
  }

  // The Updates rows fill from getHostStatus after the panel opens, like the endpoint rows do.
  let armedBoxAction = null;
  function fillHostStatus() {
    const version = elements.panelContent.querySelector("[data-host-version]");
    const pill = elements.panelContent.querySelector("[data-host-update]");
    if (!version || typeof adapter.getHostStatus !== "function") return;
    armedBoxAction = null;
    adapter.getHostStatus().then((status) => {
      version.textContent = status.hostVersion
        ? `${status.hostVersion} on this box${status.latestHostVersion ? ` · ${status.latestHostVersion} published` : ""}${status.isBusy ? " · host busy" : ""}`
        : "The host did not report a version";
      if (pill) {
        pill.textContent = status.hostUpdateAvailable === true ? "newer bundle published" : status.hostUpdateAvailable === false ? "current" : "unknown";
        pill.className = `status-pill${status.hostUpdateAvailable === false ? " success" : ""}`;
      }
    }).catch((error) => { version.textContent = `Could not read the host version: ${error.message}`; });
  }

  function addPanel() {
    const options = state.workers.map((worker) => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}</option>`).join("");
    return `<div class="panel-grid"><section class="panel-card"><div class="panel-card-header"><span class="panel-card-icon">♙</span><span class="status-pill">agent</span></div><h3>Create an agent</h3><p>An agent gets its own direct conversation, model, files, browser session, and routines.</p><form data-add-worker><div class="field"><label for="worker-name">Name</label><input id="worker-name" name="name" required placeholder="e.g. Finance Reviewer" /></div><div class="field"><label for="worker-role">Role</label><input id="worker-role" name="role" placeholder="What this agent owns" /></div><div class="form-actions"><button class="primary-button" type="submit">Create agent</button></div></form></section><section class="panel-card"><div class="panel-card-header"><span class="panel-card-icon">◌</span><span class="status-pill">room</span></div><h3>Create a room</h3><p>A room is a group chat with a truthful roster and its own shared routines, files, and browser context.</p><form data-add-room><div class="field"><label for="room-name-input">Name</label><input id="room-name-input" name="name" required placeholder="e.g. Finance close" /></div><div class="field"><label for="room-first-member">First member</label><select id="room-first-member" name="memberId">${options}</select></div><div class="form-actions"><button class="primary-button" type="submit">Create room</button></div></form></section></div>`;
  }

  // One iframe, reused. Asking the relay to put the app on the box's display is fire-and-forget:
  // if it is already running the launch is a no-op, and the view shows whatever is really there.
  // One iframe, reused. noVNC re-runs its whole handshake when the element is replaced, which is
  // what made the old desktop reconnect on every repaint.
  let mountedDesktop = null;

  function mountBoxSurface(app, caption) {
    const context = activeContext();
    const record = contextRecord();
    // A room has no screen of its own; its members do. Fall back to the lead member's.
    const agentId = context.kind === "worker" ? context.id : (record?.memberIds ?? [])[0] ?? null;

    const borrowedFrom = context.kind === "room" && agentId
      ? (state.workers.find((w) => w.id === agentId)?.name ?? "a member")
      : null;
    const paint = (frameUrl, display, shared) => {
      // A room has no screen of its own -- it is looking at a member's. Saying "Diag Room's own
      // screen" would invent an ownership the host does not have.
      const line = shared
        ? `${caption} · shared screen — every agent on this box sees it`
        : borrowedFrom
          ? `${caption} · ${escapeHtml(borrowedFrom)}'s screen, shown for this room (display :${display})`
          : `${caption} · ${escapeHtml(contextName())}'s own screen (display :${display})`;
      const existing = elements.desktopWindow.querySelector("iframe[data-box-vnc]");
      if (existing && mountedDesktop === frameUrl) {
        elements.desktopWindow.querySelector("[data-box-caption]").innerHTML = line;
      } else {
        mountedDesktop = frameUrl;
        elements.desktopWindow.innerHTML = `<div class="desktop-browser" style="display:flex;flex-direction:column;height:100%"><div class="browser-toolbar" style="flex:0 0 auto"><div class="browser-address" data-box-caption>${line}</div></div><div style="flex:1 1 auto;min-height:0;position:relative;overflow:hidden;background:#0b0f13"><iframe data-box-vnc src="${escapeHtml(frameUrl)}" title="Live view of the box" style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe></div></div>`;
      }
      // Put the app on THAT display, not on the shared one.
      fetch(`/box/launch?display=${encodeURIComponent(display)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app }),
      }).catch(() => {});
      window.setTimeout(async () => {
        try {
          const state = await (await fetch(`/box/surface?app=${encodeURIComponent(app)}&display=${encodeURIComponent(display)}`)).json();
          const el = elements.desktopWindow.querySelector("[data-box-caption]");
          if (!state.present && el) el.textContent = `${app} did not start on this screen — what you see is whatever else is running on it.`;
        } catch { /* the check is a courtesy; never let it break the pane */ }
      }, 16_000);
    };

    // The shared seat on display :1, on this page's own origin. The relay proxies the box's noVNC
    // at /vnc/1/, and the absolute 127.0.0.1 this used to be was the VIEWER's own machine, which
    // is the box only when the console happens to be open on the box's host. Same reasoning as
    // ensureDesktop in the adapter, and the same reason this is vnc.html rather than vnc_lite:
    // the lite client ignores resize=scale and renders the framebuffer at native size inside a
    // smaller frame, so you see the top-left corner and nothing else.
    const SHARED = `${window.location.origin}/vnc/1/vnc.html?path=${encodeURIComponent("/vnc/1/websockify")}&autoconnect=1&resize=scale&reconnect=1&bell=0`;
    if (!agentId) { paint(SHARED, 1, true); return; }

    elements.desktopWindow.innerHTML = `<div class="empty-state">Opening ${escapeHtml(contextName())}'s screen… the first time takes about ten seconds while the host allocates one.</div>`;
    mountedDesktop = null;
    ensureDesktop(agentId)
      .then(async (desk) => {
        // A private display can exist with no desktop session on it: on this box image the fork
        // displays come up with an X server but no window manager. That renders as an empty grey
        // rectangle, which reads as "the UI is broken" rather than "this screen has no session".
        // Say which it is, and show the screen that does work rather than nothing.
        if (!desk.shared) {
          try {
            const health = await (await fetch(`/box/surface?app=${encodeURIComponent(app)}&display=${encodeURIComponent(desk.display)}`)).json();
            if (health && health.hasSession === false) {
              paint(SHARED, 1, true);
              const el = elements.desktopWindow.querySelector("[data-box-caption]");
              if (el) el.textContent = `${contextName()}'s own screen (display :${desk.display}) has no desktop session — showing the shared screen instead.`;
              return;
            }
          } catch { /* if the check fails, prefer the agent's own screen */ }
        }
        paint(desk.url, desk.display, desk.shared);
      })
      .catch((error) => {
        elements.desktopWindow.innerHTML = `<div class="empty-state">Could not open a screen for ${escapeHtml(contextName())}: ${escapeHtml(error.message)}</div>`;
      });
  }

  // -- qol/vnc-paste: the operator's clipboard, into the box ------------------------------------
  // The pane is an iframe onto the box's own noVNC and the relay appends a small bridge to that
  // page on the way through (ui/vnc-bridge.mjs, which also hides noVNC's control bar). This is the
  // console half. A paste that belongs to the pane goes to the frame instead of to the page, and
  // what the box copies comes back the other way. Both halves talk in postMessage only: the frame
  // is same-origin so this code COULD reach into its document, and not doing that is the point --
  // the box image owns that client, and a console that pokes at its internals breaks on the next
  // image. Four message types, both directions, nothing else.
  let desktopPointerOver = false;
  let desktopPasteNoteDefault = "";
  let desktopPasteNoteTimer = 0;

  function desktopVncFrame() {
    if (!elements.desktopDialog.open) return null;
    return elements.desktopWindow.querySelector("iframe[data-box-vnc]") ?? null;
  }

  // The desktop dialog is modal, so it sits in the top layer and an ordinary toast fired while it
  // is open renders behind its own backdrop where nobody reads it (the same reason the teach
  // refusal is said in its header). So the pane's one line of copy doubles as its toast: it says
  // what just happened for a few seconds and then goes back to naming the shortcuts.
  function sayInDesktopPanel(message) {
    const note = document.getElementById("desktop-paste-note");
    if (note == null) return;
    window.clearTimeout(desktopPasteNoteTimer);
    note.textContent = message;
    note.classList.add("is-said");
    desktopPasteNoteTimer = window.setTimeout(() => {
      note.textContent = desktopPasteNoteDefault;
      note.classList.remove("is-said");
    }, 3600);
  }

  // A paste belongs to the box when the desktop is open and nothing on the page wants the text
  // more: not a field being typed in, and either the pointer is over the screen or the focus is
  // somewhere in this dialog -- which is where it is from the moment the pane opens until the
  // screen itself is clicked. Once the screen has the focus the browser never delivers a paste
  // here at all; that case is the bridge's Cmd+V chord below.
  function desktopPasteTarget() {
    const frame = desktopVncFrame();
    if (frame == null) return null;
    const active = document.activeElement;
    if (active != null && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return null;
    if (!desktopPointerOver && !(active != null && elements.desktopDialog.contains(active))) return null;
    return frame;
  }

  function sendClipboardToBox(frame, text) {
    if (frame == null || typeof text !== "string" || text.length === 0) return false;
    frame.contentWindow?.postMessage({ type: "titanbot-vnc-paste", text }, window.location.origin);
    return true;
  }

  function handleDesktopPaste(event) {
    const frame = desktopPasteTarget();
    if (frame == null) return;
    const data = event.clipboardData;
    const text = data ? data.getData("text/plain") : "";
    if (typeof text === "string" && text.length > 0) { event.preventDefault(); sendClipboardToBox(frame, text); return; }
    // A screenshot on the clipboard has nowhere to go: clipboardPasteFrom carries text, and the
    // RFB cut-text message it writes has no other kind. Say so rather than swallowing it.
    const items = data ? Array.from(data.items ?? []) : [];
    if (items.some((item) => item.kind === "file")) {
      event.preventDefault();
      sayInDesktopPanel("Only text can be pasted into the box — an image has nowhere to land.");
    }
  }

  // The shortcut that brings noVNC's own control bar back inside the frame. The bridge listens for
  // the same chord on its side; this one covers the half of the time the focus is out here.
  function handleDesktopChord(event) {
    if (!event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
    if (String(event.key).toLowerCase() !== "b") return;
    const frame = desktopVncFrame();
    if (frame == null) return;
    event.preventDefault();
    frame.contentWindow?.postMessage({ type: "titanbot-vnc-bar" }, window.location.origin);
  }

  // Cmd+V with the screen focused never reaches this page -- noVNC stops the keydown on its canvas
  // and forwards it to the box, where Super+V means nothing. The bridge takes that chord back and
  // asks here instead. This is the one place the async clipboard read is worth attempting: a
  // document still counts as focused while a frame inside it holds the focus, so the browser is
  // allowed to answer. When it refuses, the way out is the control bar.
  function serveClipboardRequest(frame) {
    const read = navigator.clipboard?.readText?.();
    if (read == null) { sayInDesktopPanel("This browser will not hand over the clipboard — ⌘/Ctrl + Shift + B shows noVNC’s own clipboard bar."); return; }
    read
      .then((text) => { if (!sendClipboardToBox(frame, text)) sayInDesktopPanel("Nothing on the clipboard to send to the box."); })
      .catch(() => sayInDesktopPanel("The browser refused to read the clipboard — ⌘/Ctrl + Shift + B shows noVNC’s own clipboard bar."));
  }

  function handleVncBridgeMessage(event) {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data == null || typeof data !== "object") return;
    const frame = desktopVncFrame();
    if (frame == null || event.source !== frame.contentWindow) return;
    if (data.type === "titanbot-vnc-pasted") {
      const chars = Number(data.chars) || 0;
      sayInDesktopPanel(`Pasted ${chars} character${chars === 1 ? "" : "s"} into the box`);
    } else if (data.type === "titanbot-vnc-paste-failed") {
      sayInDesktopPanel(`Could not paste into the box: ${String(data.reason ?? "the bridge gave no reason")}`);
    } else if (data.type === "titanbot-vnc-paste-request") {
      serveClipboardRequest(frame);
    } else if (data.type === "titanbot-vnc-clipboard") {
      // The other direction: something copied inside the box. Only while this page has the focus,
      // which is the only time the browser permits the write at all, and never noisily.
      const text = typeof data.text === "string" ? data.text : "";
      if (text.length === 0 || !document.hasFocus() || navigator.clipboard?.writeText == null) return;
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function wireDesktopPaste() {
    const note = document.getElementById("desktop-paste-note");
    desktopPasteNoteDefault = note ? note.textContent : "";
    elements.desktopWindow.addEventListener("mouseenter", () => { desktopPointerOver = true; });
    elements.desktopWindow.addEventListener("mouseleave", () => { desktopPointerOver = false; });
    document.addEventListener("paste", handleDesktopPaste);
    document.addEventListener("keydown", handleDesktopChord);
    window.addEventListener("message", handleVncBridgeMessage);
  }
  // -- end qol/vnc-paste ------------------------------------------------------------------------

  function renderDesktop(appName) {
    activeDesktopApp = appName || activeDesktopApp;
    const context = activeContext();
    const record = contextRecord();
    const lead = contextLead();
    elements.desktopTitle.textContent = context.kind === "worker" ? `${record.name}’s desktop` : `${record.name} · shared desktop`;
    elements.desktopLive.innerHTML = `<span class="status-dot ${lead && lead.status === "working" ? "working" : "ready"}"></span> ${escapeHtml(lead ? lead.name : record.name)} ${state.desktop.paused ? "is paused" : "is working"}`;
    document.querySelectorAll("[data-desktop-app]").forEach((button) => button.classList.toggle("active", button.dataset.desktopApp === activeDesktopApp));
    if (activeDesktopApp === "files") {
      const files = record.files.length
        ? record.files.map((file) => `<div class="file-tile">▱<strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.meta)}</small></div>`).join("")
        : `<div class="empty-state">Nothing has been attached to this conversation yet.</div>`;
      elements.desktopWindow.innerHTML = `<div class="files-view"><div class="browser-page-head"><div><h3>${escapeHtml(record.name)} files</h3><p>Files that passed through the part of this conversation loaded on screen${record.hasOlder ? " — show earlier messages to include older ones" : ""}. This host keeps no per-worker directory — anything a worker writes with Shell goes to one /workspace shared by every agent on the box.</p></div><span class="status-pill">${record.files.length}</span></div><div class="file-grid">${files}</div></div>`;
    } else if (activeDesktopApp === "terminal") {
      mountBoxSurface("terminal", "Terminal");
    } else {
      // Browser and Terminal are the live box, not a drawing of one. noVNC re-runs its whole
      // handshake whenever the element is replaced, so the frame is mounted once and left alone;
      // rebuilding it on every render is what made the old desktop reconnect on every repaint.
      mountBoxSurface("browser", "Browser");
    }
    const runName = document.getElementById("desktop-run-name");
    const working = lead && lead.status === "working";
    if (runName) runName.textContent = working ? `${lead.name} is working` : "No run in progress";
    // MR-11: the host exposes no per-step run progress, but the conversation outline does carry
    // this turn's tool calls, and the adapter has already woven them into the transcript as rows
    // with a `tool-` id. "This turn" is everything after the last thing the operator sent; older
    // rows belong to earlier runs and would read as steps of the one on screen.
    const rows = Array.isArray(record.messages) ? record.messages : [];
    let lastFromYou = -1;
    rows.forEach((m, i) => { if (m.authorId === "you") lastFromYou = i; });
    const steps = rows.slice(lastFromYou + 1).filter((m) => m.type === "system" && String(m.id ?? "").startsWith("tool-"));
    elements.desktopTimeline.innerHTML = steps.length
      ? steps.slice(-12).map((step) => `<li>${escapeHtml(step.text)}</li>`).join("")
      : working
        ? `<li>Started — the outline reports no tool call for this turn yet</li>`
        : `<li class="is-pending">Nothing running for this worker</li>`;
    // Naming it honestly: this hides the view, it does not stop the worker. There is no host
    // command to halt a turn in flight, and a button labelled Pause promises exactly that.
    elements.pauseRun.textContent = state.desktop.paused ? "Resume view" : "Pause view";
    elements.pauseRun.title = "Pauses this view only. The worker keeps running — this host has no command to stop a turn.";
    renderHandBack();
  }

  // GW-10: a request_box_help takeover parks the agent until the operator hands the computer
  // back, and nothing here could. The control exists only while the host reports a pending
  // hand-off for the agent whose screen this is, and says what the agent asked for.
  function renderHandBack() {
    const button = document.getElementById("hand-back");
    const note = document.getElementById("hand-back-note");
    if (!button) return;
    const lead = contextLead();
    const handoff = lead?.handoff ?? null;
    const canHandBack = handoff && typeof adapter.handBack === "function";
    button.hidden = !canHandBack;
    button.dataset.handBack = canHandBack ? lead.id : "";
    if (note) {
      note.hidden = !handoff;
      note.textContent = handoff ? `${lead.name} handed you the computer: ${handoff.instruction || "no instruction given"}` : "";
    }
  }

  function openDesktop(appName) {
    closeOpenDialogs(elements.desktopDialog);
    renderDesktop(appName);
    if (!elements.desktopDialog.open) elements.desktopDialog.showModal();
  }

  const clockText = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };

  // Shared by the button and by the boot-time resume, so a recording already running on the host
  // shows the host's own elapsed time rather than restarting the clock at 00:00.
  function showTeachDialog(worker, startedAt, maxDurationMs) {
    if (elements.desktopDialog.open) elements.desktopDialog.close();
    elements.teachTitle.textContent = `Recording ${worker.name}'s screen`;
    // The dialog used to draw a fake ticket queue. What belongs here is the screen actually being
    // recorded -- but connecting it hands the keyboard to the box, so it starts as a cover and the
    // client is not mounted until the operator clicks it.
    teachScreenUrl = "";
    renderTeachCover("Connecting to this agent's screen takes a moment. Click to work on it once it is ready.");
    ensureDesktop(worker.id).then((desk) => {
      teachScreenUrl = desk.url;
      if (!teachScreenControl) renderTeachCover();
    }).catch((error) => {
      renderTeachCover(`This box gave no screen to show: ${error.message}. The recording is still running.`);
    });
    const cap = Number(maxDurationMs) > 0 ? ` / ${clockText(Number(maxDurationMs))}` : "";
    const tick = () => { elements.teachTimer.textContent = `${clockText(Date.now() - startedAt)}${cap}`; };
    tick();
    if (!elements.teachDialog.open) elements.teachDialog.showModal();
    window.clearInterval(teachInterval);
    teachInterval = window.setInterval(tick, 250);
    window.clearInterval(teachPoll);
    teachPoll = window.setInterval(pollTeachHost, 5000);
    // The note is where the keys should land, and saying so with the caret is clearer than any
    // sentence in the footer.
    document.getElementById("teach-note")?.focus();
  }

  function stopTeachTimers() {
    window.clearInterval(teachInterval);
    teachInterval = null;
    window.clearInterval(teachPoll);
    teachPoll = null;
  }

  // Asked of the host every few seconds while the dialog is open. Only an answer of "not
  // recording" closes anything: a failed read is not evidence the box stopped, and closing on one
  // would take the operator's way out away over a dropped request.
  function pollTeachHost() {
    if (teachStopping || !elements.teachDialog.open) return;
    if (typeof adapter.teachStatus !== "function") return;
    Promise.resolve(adapter.teachStatus()).then((status) => {
      if (status == null || status.active !== false) return;
      if (teachStopping || !elements.teachDialog.open) return;
      stopTeachTimers();
      closeTeachScreen();
      elements.teachDialog.close();
      // Said as what it is. The cap is a save, so calling this "discarded" would be the same lie
      // the stop path used to tell. It is a save the host makes with nothing from this dialog in
      // it, so the note is still in the textarea and was never sent. One sentence, because a toast
      // is a pill that clears itself in under three seconds: anything longer is not read at all.
      showToast("The ten-minute cap ended this recording: the box saved it and handed it to the agent without the note typed here, which is still in the field.");
    }).catch(() => {});
  }

  // The cover the dialog opens on. No VNC client is mounted behind it: while this is what the
  // canvas holds, nothing in the dialog can take the keys, so the note, Escape and the buttons all
  // work. The sentence changes while the box is still allocating the screen.
  function renderTeachCover(note) {
    const live = document.getElementById("teach-live");
    if (!live) return;
    const ready = Boolean(teachScreenUrl);
    const small = note ?? (ready
      ? "The screen is not connected yet, so this dialog has the keyboard: type your note here, and Escape discards the recording. Clicking connects the screen and gives the box the keys, and Escape goes to the box too, so stop the recording with Discard or Finish recording. Click anywhere else in this dialog to take the keyboard back."
      : "Connecting to this agent's screen takes a moment. Click to work on it once it is ready.");
    live.innerHTML = `<div class="teach-screen"><button class="teach-shield" type="button" data-teach-control>`
      + `<strong>${ready ? "Click here to work on this screen" : "Waiting for this agent's screen"}</strong>`
      + `<small>${escapeHtml(small)}</small></button></div>`;
    teachScreenControl = false;
    setTeachKeyboardHint();
  }

  function setTeachKeyboardHint() {
    const hint = document.getElementById("teach-keyboard");
    if (!hint) return;
    hint.textContent = teachScreenControl
      ? "The screen has the keyboard. Escape goes to the box; use Discard or Finish recording to stop."
      : "Escape discards this recording. Clicking outside the dialog does not stop it.";
  }

  // Handing the keyboard over is a deliberate click and taking it back is any click elsewhere in
  // the dialog. Mounting and unmounting the client is what actually moves the keys: an iframe holding a
  // real VNC client keeps them once it has them, whatever this page does to activeElement, so the
  // page takes them back by removing it rather than by blurring it.
  function setTeachScreenControl(on) {
    const live = document.getElementById("teach-live");
    if (!on) {
      if (!teachScreenControl) return;
      renderTeachCover();
      // Deferred by a tick so the click that took the keyboard back keeps whatever it landed on.
      // A click on the footer text lands on nothing, and the note is where the keys belong.
      window.setTimeout(() => {
        if (teachScreenControl || !elements.teachDialog.open) return;
        const active = document.activeElement;
        if (active && active !== document.body && elements.teachDialog.contains(active)) return;
        document.getElementById("teach-note")?.focus();
      }, 0);
      return;
    }
    if (!teachScreenUrl) { renderTeachCover("The box has not given this agent's screen yet. The recording is running; try again in a moment."); return; }
    if (!live) return;
    live.innerHTML = `<div class="teach-screen"><iframe data-teach-vnc src="${escapeHtml(teachScreenUrl)}" title="The screen being recorded"></iframe></div>`;
    teachScreenControl = true;
    setTeachKeyboardHint();
    // Deferred by a tick: the click that hands the screen the keyboard is still being processed,
    // and the browser's own focus handling for that click runs after this listener. Focusing the
    // frame first left the keyboard on the cover's button instead, measured on the gate.
    window.setTimeout(() => {
      if (!teachScreenControl) return;
      elements.teachDialog.querySelector("iframe[data-teach-vnc]")?.focus();
    }, 0);
  }

  // Closing the dialog takes the client down with it: a live VNC frame in a closed dialog is a
  // socket to the box that nothing on screen accounts for.
  function closeTeachScreen() {
    teachScreenControl = false;
    teachScreenUrl = "";
    const live = document.getElementById("teach-live");
    if (live) live.innerHTML = "";
  }

  // The two refusals an operator can do something about, said in words that name the fix. Anything
  // else keeps the host's own sentence: a friendlier invention would hide what actually happened.
  const TEACH_REFUSALS = {
    "gate-off": "Teach mode is off on this host. Set SAND_TEACH to 1 in sand-host-settings.json and try again.",
    // The host allocates a screen for an agent that has never had one, so this is not the
    // first-recording case: it is an agent parked on the shared display, which has no private
    // screen to record. Say the case that actually produces it. Measured on this box: two fresh
    // agents that had never opened a screen were recorded rather than refused, and the Learn
    // button calls ensureDesktop first anyway, so nothing an operator can click produces this
    // sentence here. It stays because the host still has the refusal and can still send it.
    "no-monitor": "The host could not give this agent a screen of its own to record on. Open its Browser once so it gets one, then Learn.",
  };
  const teachRefusalText = (result) => TEACH_REFUSALS[result?.reason]
    ?? (result?.message ? String(result.message) : "The host refused the recording and gave no reason.");

  function showTeachRefusal(text) {
    const line = document.getElementById("teach-refusal");
    if (!line) return;
    line.textContent = text;
    line.hidden = !text;
  }

  function showTeachError(text) {
    const line = document.getElementById("teach-error");
    if (!line) return;
    line.textContent = text;
    line.hidden = !text;
  }

  // startTeachRecording is 6s on a warm screen and 23s on one the box has never opened, and the
  // only thing that used to change on the page in that time was the button's disabled flag, which
  // this stylesheet did not draw. A wait with nothing on screen reads as a click that did nothing.
  function showTeachProgress(text) {
    const line = document.getElementById("teach-progress");
    if (!line) return;
    line.textContent = text;
    line.hidden = !text;
  }

  // Both buttons drive one stop, so both have to be dead while one is in flight -- a second click
  // during a stop is a second stopTeachRecording against a recording that is already going away.
  function setTeachStopBusy(busy, save) {
    const finish = document.getElementById("finish-teach");
    const discard = document.getElementById("discard-teach");
    if (finish) { finish.disabled = busy; finish.textContent = busy && save ? "Saving..." : "■ Finish recording"; }
    if (discard) { discard.disabled = busy; discard.textContent = busy && !save ? "Discarding..." : "Discard"; }
  }

  // The modal is a claim that the box is recording, so it opens only on a status the host
  // confirmed. A refused start is said twice: a toast, and a line that stays on the desktop beside
  // the button that was clicked.
  function openTeachMode(button) {
    const lead = contextLead();
    if (!lead) return;
    showTeachRefusal("");
    showTeachProgress(`Asking the box to start recording ${lead.name}'s screen. A screen it has not opened before takes about half a minute.`);
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "Starting...";
    }
    Promise.resolve(adapter.startTeaching(lead.id))
      .then((result) => {
        showTeachProgress("");
        if (!result || result.ok !== true) {
          const text = teachRefusalText(result);
          showTeachRefusal(text);
          showToast(text);
          return;
        }
        showTeachError("");
        setTeachStopBusy(false, true);
        showTeachDialog(lead, Number(result.startedAt) || Date.now(), result.maxDurationMs);
      })
      .catch((error) => { showTeachProgress(""); showTeachRefusal(error.message); showToast(error.message); })
      .finally(() => {
        if (!button) return;
        button.disabled = false;
        button.removeAttribute("aria-busy");
        button.textContent = "● Learn this task";
      });
  }

  // MR-14: the adapter seeds state.teaching from getTeachRecordingStatus and nothing read it, so a
  // recording still running on the host was invisible after a reload -- and the only way back into
  // the dialog was the button, which starts a second one.
  function resumeTeachMode() {
    const teaching = state.teaching;
    if (!teaching?.active || !teaching.workerId) return;
    const worker = workerById(teaching.workerId);
    if (!worker) return;
    showTeachError("");
    setTeachStopBusy(false, true);
    showTeachDialog(worker, Number(teaching.startedAt) || Date.now(), teaching.maxDurationMs);
    showToast(`${worker.name} is still recording. This is the run the host already has open.`);
  }

  // Save and discard are the same stop with one flag. The dialog and its timer stay up until the
  // host reports the recording idle: closing on the click was the bug -- the modal went away and
  // ffmpeg kept writing, with no way back in but a reload.
  function stopTeachMode(save) {
    if (teachStopping) return;
    teachStopping = true;
    const lead = workerById(state.teaching?.workerId) ?? contextLead();
    const note = document.getElementById("teach-note");
    const text = note ? note.value.trim() : "";
    showTeachError("");
    setTeachStopBusy(true, save);
    Promise.resolve(adapter.finishTeaching(save, text))
      .then((result) => {
        if (!result || result.ok !== true) {
          // A stop the host cannot complete is a dead end from here: it happens when the agent
          // being recorded is gone, and every later click gets the same answer. Say what clears
          // it rather than leaving the operator clicking a button that cannot work.
          const why = result?.message ? `The recording is still running: ${result.message}` : "The host did not answer the stop. The recording is still running.";
          showTeachError(`${why} If it keeps failing, the recording is stuck on the host and only a box restart clears it.`);
          return;
        }
        stopTeachTimers();
        closeTeachScreen();
        // The note is only thrown away once the request carrying it has actually landed. It used
        // to be cleared here on a send that was still in flight, so a failed send left the
        // operator with a toast about text that was already gone.
        if (note && result.noteSent !== false) note.value = "";
        elements.teachDialog.close();
        // The note travels in the stop itself now, so there is no second request that can fail on
        // its own: a stop this page could not complete returned above with the text still here.
        showToast(result.alreadyStopped
          ? result.message
          : save
            ? `Recording saved. ${lead?.name ?? "the agent"} is learning from it now.`
            : "Recording discarded");
      })
      .catch((error) => showTeachError(`The recording is still running: ${error.message}`))
      .finally(() => { teachStopping = false; setTeachStopBusy(false, save); });
  }

  function simulateReply(context, userText) {
    const lead = contextLead(context);
    adapter.setWorkerStatus(lead.id, "working", "Thinking through your request");
    const working = adapter.addMessage(context, { authorId: lead.id, authorName: lead.name, type: "working", text: "" });
    const lower = userText.toLowerCase();
    window.setTimeout(() => {
      adapter.removeMessage(context, working.id);
      let text = context.kind === "room" ? "Understood. I’ll coordinate this room and route each part to the member who owns it. The combined outcome will return here." : "I’ve got it. I’ll keep my work visible here and bring back anything that needs your judgment.";
      if (lower.includes("title") || lower.includes("browser") || lower.includes("desktop")) {
        text = `I’m using ${contextName(context)}’s browser context now. Open the desktop to watch while I verify it.`;
        if (sameContext(context, activeContext())) openDesktop("browser");
      } else if (lower.includes("routine")) {
        text = `Open Routines to see only the routines attached to ${contextName(context)}.`;
      } else if (lower.includes("plugin") || lower.includes("connector")) {
        text = "Plugins are global packages. I can use only the specific tools that policy grants to this context.";
      }
      adapter.addMessage(context, { authorId: lead.id, authorName: lead.name, type: "text", text });
      adapter.setWorkerStatus(lead.id, "ready", "Ready for the next task");
    }, 1150);
  }

  function handleContextCardClick(event) {
    const remove = event.target.closest("[data-remove-member]");
    if (remove && activeContext().kind === "room") {
      adapter.removeMember(activeContext().id, remove.dataset.removeMember);
      return;
    }
    const action = event.target.closest("[data-context-action]");
    if (action) {
      if (action.dataset.contextAction === "routines") renderRoutinesPanel();
      else if (action.dataset.contextAction === "skills") renderSkillsPanel();
      else if (action.dataset.contextAction === "files") openDesktop("files");
      else if (action.dataset.contextAction === "members" && activeContext().kind === "room") openPanel("Room roster", `${contextName()} members`, membersPanel());
      else if (action.dataset.contextAction === "profile" && activeContext().kind === "worker") openAgentProfile(contextRecord());
      return;
    }
  }

  function redrawTriggerStack() {
    const host = document.getElementById("trigger-stack");
    if (host) host.innerHTML = triggerStackMarkup();
  }

  function handleTriggerInput(event) {
    const el = event.target.closest("[data-trig]");
    if (!el) return;
    const t = draftTriggers[Number(el.dataset.trig)];
    if (!t) return;
    if (el.dataset.trigEvent) {
      const events = new Set(t.events ?? []);
      if (el.checked) events.add(el.dataset.trigEvent); else events.delete(el.dataset.trigEvent);
      t.events = [...events];
      redrawTriggerStack();
      return;
    }
    const field = el.dataset.trigField;
    if (field === "type") {
      // Keep only the type: the fields of one trigger kind mean nothing to another, and carrying
      // them over is how a Slack channel ends up on a Sentry trigger. A bare { type } was itself
      // a shape the host drops, so the replacement is the full blank the host will parse.
      draftTriggers[Number(el.dataset.trig)] = blankTrigger(el.value);
      redrawTriggerStack();
      return;
    }
    applyTrigger(t, field, el.value);
    // These two decide which fields exist below them. Both are selects, so redrawing here cannot
    // pull the caret out of a half-typed box.
    if (field === "match" || field === "event") redrawTriggerStack();
  }

  function handlePanelClick(event) {
    if (event.target.closest("[data-add-trigger]")) {
      draftTriggers.push({ type: "cron", schedule: "0 9 * * 1-5" });
      redrawTriggerStack();
      return;
    }
    const drop = event.target.closest("[data-drop-trigger]");
    if (drop) {
      draftTriggers.splice(Number(drop.dataset.dropTrigger), 1);
      redrawTriggerStack();
      return;
    }
    const target = event.target.closest("button");
    if (!target) return;
    // Rows in the unread panel carry a context; clicking one should take you there.
    if (target.dataset.contextKind && target.dataset.contextId) {
      selectContext(target.dataset.contextKind, target.dataset.contextId);
      elements.panelDialog.close();
      return;
    }
    if (target.dataset.useEndpoint) {
      const provider = state.plugins.find((plugin) => plugin.endpointId === target.dataset.useEndpoint);
      adapter.setModel(null, target.dataset.useEndpoint);
      showToast(`${provider?.name ?? "That endpoint"} answers from the next turn`);
      return;
    }
    if (target.dataset.pluginId) {
      selectedPluginId = target.dataset.pluginId;
      // MARKET-1: in the Marketplace a card id opens that plugin's page -- including one no
      // catalog row claims, which is how a custom MCP server is reachable at all.
      if (openPluginSurface === "marketplace") { marketplacePluginId = target.dataset.pluginId; marketplaceArmedUninstall = null; }
      renderPluginsPanel();
    } else if (target.dataset.marketplaceTab) {
      marketplaceTab = target.dataset.marketplaceTab;
      marketplacePluginId = null;
      renderMarketplacePanel();
    } else if (target.dataset.marketplaceCategory) {
      marketplaceCategory = target.dataset.marketplaceCategory;
      paintMarketplaceBody();
    } else if (target.dataset.marketplacePlugin) {
      marketplacePluginId = target.dataset.marketplacePlugin;
      marketplaceArmedUninstall = null;
      paintMarketplaceBody();
    } else if (target.hasAttribute("data-marketplace-back")) {
      marketplacePluginId = null;
      marketplaceArmedUninstall = null;
      paintMarketplaceBody();
    } else if (target.dataset.marketplaceAdd) {
      // Add writes the catalog's entry through addConnector -- the same POST /connectors plus
      // refreshMcp the connector editor makes -- and then opens the plugin page, where the
      // credential card is. A catalog row with no command of its own ("Custom MCP server") is the
      // catalog's door to that editor: there is nothing to write until an operator types one in.
      const item = marketplaceItemById(target.dataset.marketplaceAdd);
      if (!item) { showToast("That plugin is no longer in this host's catalog."); return; }
      // The editor is the catalog's explicit door -- `opensEditor` on a row with no install of its
      // own -- and nothing else. A shell tool's install IS a string (its shell-tool id), so a
      // typeof check on it sent CodeRabbit CLI and TinyFish CLI to the connector editor instead of
      // to installShellTool: two of nine rows whose Add did the wrong thing.
      if (item.opensEditor === true || item.install == null) {
        marketplacePluginId = null;
        paintMarketplaceBody();
        const editor = elements.panelContent.querySelector("[data-connector-editor]");
        if (editor) { editor.setAttribute("open", "open"); editor.scrollIntoView({ block: "center" }); }
        showToast("Fill in the connector editor below — nothing is written until Add connector.");
        return;
      }
      target.disabled = true;
      // Open the page on the click, not when the write's refresh comes back. The entry itself is
      // one fast round trip, but redrawing the cards behind it waits on the host connecting the
      // server it just launched -- and a connector whose key is not stored yet spends the host's
      // full 60s MCP connect timeout failing, which is the normal case for an Add. Holding the
      // page behind that leaves a disabled button and nothing else on screen for a minute, when
      // the credential card that ends the wait is exactly what the operator came here for.
      // Its state pill catches up on the refresh below; a write that is refused takes it back.
      marketplacePluginId = item.id;
      marketplaceArmedUninstall = null;
      paintMarketplaceBody();
      Promise.resolve(adapter.addMarketplacePlugin(item, contextLead()?.id))
        .then((result) => {
          showToast(result?.message ?? `${item.name} added`);
          if (result?.accepted === false) marketplacePluginId = null;
          refreshMarketplace();
        })
        .catch((error) => {
          marketplacePluginId = null;
          paintMarketplaceBody();
          showToast(`${item.name} was not added: ${error.message}`);
        });
    } else if (target.dataset.marketplaceUninstall) {
      const name = target.dataset.marketplaceUninstall;
      // Armed on the label, not on a repaint: redrawing the page here would put the "also clear"
      // box back to its default under the hand of an operator who had just changed it.
      if (marketplaceArmedUninstall !== name) { marketplaceArmedUninstall = name; target.textContent = "Click again to remove"; return; }
      // The stored values go first: deleteConnectorSecret resolves the server through
      // connectors.json, so once the entry is gone the host cannot reach its own store for it and
      // the value would sit there for the life of the box.
      const clear = elements.panelContent.querySelector("[data-marketplace-clear-secrets]");
      const install = marketplaceInstallById(marketplacePluginId);
      const held = install?.storedCredentials ?? [];
      target.disabled = true;
      const cleared = clear?.checked && held.length && typeof adapter.deleteConnectorSecret === "function"
        ? Promise.all(held.map((field) => adapter.deleteConnectorSecret(name, field)))
        : Promise.resolve([]);
      cleared
        .then(() => adapter.removeConnector(name))
        .then((result) => {
          marketplaceArmedUninstall = null;
          marketplacePluginId = null;
          showToast(result?.message ?? `${name} removed`);
          refreshMarketplace();
        })
        .catch((error) => { target.disabled = false; showToast(`${name} was not removed: ${error.message}`); });
    } else if (target.dataset.installPlugin) {
      selectedPluginId = target.dataset.installPlugin;
      // The toast used to fire before the host had answered, on a call that for some cards always
      // fails. It now reports whatever the adapter resolved with.
      // The agent id the card was drawn for, not whatever context is active: on a room these are
      // different agents, and a listener binds to one agent.
      Promise.resolve(adapter.setPluginState(target.dataset.installPlugin, "connect", contextLead()?.id))
        .then((result) => { if (typeof result === "string") showToast(result); })
        .catch((error) => showToast(`Could not connect that plugin: ${error.message}`));
      renderPluginsPanel();
    } else if (target.dataset.toggleTool) {
      // CP-03: the switch is not flipped by the click. The adapter writes
      // toggleMcpToolDisabled, re-reads listMcpServerTools, and the row is redrawn from whatever
      // the host now holds -- so a write the host drops shows as a switch that did not move.
      target.disabled = true;
      Promise.resolve(adapter.togglePluginTool(selectedPluginId, target.dataset.toggleTool))
        .then((result) => {
          renderPluginsPanel();
          if (result && typeof result === "object" && result.message) showToast(result.message);
        })
        .catch((error) => { renderPluginsPanel(); showToast(`That tool was not changed: ${error.message}`); });
    } else if (target.dataset.connectorPreset) {
      // CONNECT-3: fill only. The write is the operator pressing Add connector on what they can
      // see in the fields, and the key is a separate step on the connector's own card afterwards.
      const preset = (typeof adapter.connectorPresets === "function" ? adapter.connectorPresets() : [])
        .find((p) => p.id === target.dataset.connectorPreset) ?? null;
      const form = document.querySelector("[data-add-connector]");
      if (!preset || !form) { showToast("That preset is no longer on this page; nothing was filled in."); return; }
      form.querySelector('[name="name"]').value = preset.name;
      form.querySelector('[name="command"]').value = preset.command;
      form.querySelector('[name="args"]').value = preset.argsText;
      form.querySelector('[name="envNames"]').value = preset.envNames.join(", ");
      // What each of those environment values is, before there is a card to paste it into.
      const hintBox = document.querySelector("[data-connector-preset-hints]");
      if (hintBox) hintBox.innerHTML = preset.envNames
        .map((name) => (preset.hints?.[name]
          ? `<div class="setting-row"><div><strong>${escapeHtml(name)}</strong><small data-credential-hint="${escapeHtml(name)}">${escapeHtml(preset.hints[name])}</small></div></div>`
          : ""))
        .join("");
      // Carried on the form rather than in a variable so that editing the name away from the
      // preset's own takes the replacement with it: only a save of THIS name may overwrite.
      if (preset.replaces) form.dataset.presetName = preset.name; else delete form.dataset.presetName;
      showToast(`${preset.label} filled in — nothing is written until Add connector. ${preset.note ?? ""}`.trim());
    } else if (target.dataset.removeConnector) {
      const name = target.dataset.removeConnector;
      target.disabled = true;
      Promise.resolve(adapter.removeConnector(name))
        .then((result) => { renderPluginsPanel(); showToast(result?.message ?? `${name} removed`); })
        .catch((error) => { target.disabled = false; showToast(`${name} was not removed: ${error.message}`); });
    } else if (target.dataset.installShellTool) {
      // CONNECT-5. The output pane is written from the host's answer, not from a guess about it:
      // an installer that failed shows the box's own last lines here rather than a red toast.
      const id = target.dataset.installShellTool;
      const output = elements.panelContent.querySelector(`[data-shell-tool-output="${id}"]`);
      target.disabled = true;
      const label = target.textContent;
      target.textContent = "Installing…";
      if (output) { output.hidden = false; output.textContent = "Running in the box. This can take a few minutes."; }
      Promise.resolve(adapter.installShellTool(id, contextLead()?.id))
        .then((result) => {
          if (output) { output.hidden = false; output.textContent = result?.output || result?.message || "The host returned no output."; }
          showToast(result?.message ?? `${id} install finished`);
        })
        .catch((error) => {
          if (output) { output.hidden = false; output.textContent = error.message; }
          showToast(`${id} was not installed: ${error.message}`);
        })
        .finally(() => { target.disabled = false; target.textContent = label; });
    } else if (target.dataset.teachShellTool) {
      const id = target.dataset.teachShellTool;
      const lead = contextLead();
      if (!lead) { showToast("Open an agent's conversation first: a skill is imported for one agent."); return; }
      target.disabled = true;
      Promise.resolve(adapter.teachShellTool(id, lead.id))
        .then((result) => showToast(result?.message ?? `${id} skill imported for ${lead.name}`))
        .catch((error) => showToast(`The skill was not imported: ${error.message}`))
        .finally(() => { target.disabled = false; });
    } else if (target.dataset.probeShellSecret) {
      const field = target.dataset.probeShellSecret;
      target.disabled = true;
      Promise.resolve(adapter.probeShellSecret(field))
        .then((result) => showToast(result?.message ?? `The box was asked about ${field}`))
        .catch((error) => showToast(`The box was not asked about ${field}: ${error.message}`))
        .finally(() => { target.disabled = false; });
    } else if (target.dataset.disconnectPlugin) {
      const pluginId = target.dataset.disconnectPlugin;
      target.disabled = true;
      // listenerConnectedMarkup names contextLead(); the unbind has to be the same agent.
      Promise.resolve(adapter.setPluginState(pluginId, "disconnect", contextLead()?.id))
        .then((result) => { renderPluginsPanel(); if (typeof result === "string") showToast(result); })
        .catch((error) => { target.disabled = false; showToast(`That listener was not disconnected: ${error.message}`); });
    } else if (target.dataset.runRoutine) {
      const routineId = target.dataset.runRoutine;
      adapter.runRoutine(routineId).catch((error) => {
        showToast(`Could not run that routine: ${error.message}`);
        return null;
      }).then((routine) => {
        if (!routine) return;
        if (elements.panelDialog.open) renderRoutinesPanel();
        showToast(`${routine.name} dispatched — the outcome appears on the card when the host reports it.`);
      });
      renderRoutinesPanel();
    } else if (target.dataset.toggleRoutine) {
      const routineId = target.dataset.toggleRoutine;
      const isEnabled = target.dataset.routinePaused === "true";
      // The adapter reads the flag back before resolving, so this toast reports the host's state
      // and not the click.
      adapter.setRoutineEnabled(routineId, isEnabled)
        .then((routine) => { renderRoutinesPanel(); showToast(`${routine.name} ${isEnabled ? "resumed" : "paused"}`); })
        .catch((error) => showToast(`Could not ${isEnabled ? "resume" : "pause"} that routine: ${error.message}`));
    } else if (target.dataset.editRoutine) {
      const routine = state.routines.find((entry) => entry.id === target.dataset.editRoutine);
      if (routine) {
        editingRoutineId = routine.id;
        // triggerSpec is the host's own stored trigger, not the sentence on the card: an editor
        // seeded from triggerDescription would rewrite the trigger as whatever it could parse.
        draftTriggers = triggerMembers(routine.triggerSpec);
        renderRoutinesPanel();
      }
    } else if (target.hasAttribute("data-cancel-routine-edit")) {
      resetRoutineForm();
      renderRoutinesPanel();
    } else if (target.dataset.deleteRoutine) {
      const routineId = target.dataset.deleteRoutine;
      // Two clicks rather than confirm(): a native dialog on top of a modal panel is not what the
      // rest of this looks like, and the host removes the routine's folder outright.
      if (armedDeleteId !== routineId) {
        armedDeleteId = routineId;
        target.textContent = "Confirm";
        window.setTimeout(() => {
          if (armedDeleteId !== routineId) return;
          armedDeleteId = null;
          target.textContent = "Delete";
        }, 4000);
        showToast("Click again to delete. The host keeps no copy.");
        return;
      }
      armedDeleteId = null;
      if (editingRoutineId === routineId) resetRoutineForm();
      adapter.deleteRoutine(routineId)
        .then((name) => { renderRoutinesPanel(); showToast(`${name} deleted`); })
        .catch((error) => { renderRoutinesPanel(); showToast(`Could not delete that routine: ${error.message}`); });
    } else if (target.dataset.runSkill) {
      const worker = contextRecord();
      target.disabled = true;
      adapter.runSkill(worker.id, target.dataset.runSkill)
        .then((run) => showToast(`${run.name} dispatched to ${worker.name} — its reply lands in the conversation`))
        .catch((error) => { target.disabled = false; showToast(`Could not run that skill: ${error.message}`); });
    } else if (target.dataset.toggleSkill) {
      const worker = contextRecord();
      const isEnabled = target.getAttribute("aria-pressed") !== "true";
      adapter.setSkillEnabled(worker.id, target.dataset.toggleSkill, isEnabled)
        .then((skill) => { worker.skills = (worker.skills ?? []).map((s) => (s.id === skill.id ? skill : s)); renderSkillsPanel(); showToast(`${skill.name} ${skill.enabled ? "enabled" : "disabled"} on the host`); })
        .catch((error) => showToast(`Could not ${isEnabled ? "enable" : "disable"} that skill: ${error.message}`));
    } else if (target.hasAttribute("data-port-local-skills")) {
      const worker = contextRecord();
      target.disabled = true;
      adapter.portLocalSkills(worker.id)
        .then((outcome) => {
          renderSkillsPanel();
          showToast(outcome.imported.length ? `Ported ${outcome.imported.join(", ")}`
            : outcome.skipped.length ? `Nothing ported — ${outcome.skipped[0].reason} (${outcome.skipped[0].source})`
            : "The host found no local skill file to port");
        })
        .catch((error) => { target.disabled = false; showToast(`Could not port local skills: ${error.message}`); });
    } else if (target.dataset.makeSkillGlobal) {
      // One way only: the host can put an owned skill in the shared library, and this panel offers
      // no control to take it back, so the button says so before it is pressed.
      const worker = contextRecord();
      target.disabled = true;
      adapter.makeSkillGlobal(worker.id, target.dataset.makeSkillGlobal)
        .then((skill) => { renderSkillsPanel(); showToast(`${skill.name} is global — every agent on the box has it now`); })
        .catch((error) => { target.disabled = false; showToast(`Could not make that skill global: ${error.message}`); });
    } else if (target.dataset.editSkill) {
      editingSkillId = target.dataset.editSkill;
      renderSkillsPanel();
    } else if (target.hasAttribute("data-cancel-skill-edit")) {
      editingSkillId = null;
      renderSkillsPanel();
    } else if (target.dataset.deleteSkill) {
      const workflowId = target.dataset.deleteSkill;
      // Two clicks, the same shape as the routine delete: the host removes the folder from the
      // shared library outright, and with it the skill on every agent.
      if (armedDeleteSkillId !== workflowId) {
        armedDeleteSkillId = workflowId;
        target.textContent = "Confirm";
        window.setTimeout(() => {
          if (armedDeleteSkillId !== workflowId) return;
          armedDeleteSkillId = null;
          target.textContent = "Delete";
        }, 4000);
        // An owned skill is nobody else's, so the arming line has to say which delete this is.
        const armed = (contextRecord()?.skills ?? []).find((skill) => skill.id === workflowId) ?? null;
        showToast(armed?.ownerAgentId != null
          ? "Click again to delete this agent's own skill. No other agent has it; the host keeps no copy."
          : "Click again to delete this skill for every agent on the box. The host keeps no copy.");
        return;
      }
      armedDeleteSkillId = null;
      if (editingSkillId === workflowId) editingSkillId = null;
      const worker = contextRecord();
      adapter.deleteSkill(worker.id, workflowId)
        .then((name) => { renderSkillsPanel(); showToast(`${name} deleted`); })
        .catch((error) => { renderSkillsPanel(); showToast(`Could not delete that skill: ${error.message}`); });
    } else if (target.dataset.updateBox || target.dataset.resetBox) {
      // Both recreate the box. Two clicks, and the second is only taken while the first is armed;
      // a repaint of the panel disarms it, so a button reading "Update" is never one click away.
      const action = target.dataset.updateBox ? "update" : "reset";
      const agentId = target.dataset.updateBox || target.dataset.resetBox;
      if (armedBoxAction !== action) {
        armedBoxAction = action;
        target.textContent = "Click again to confirm";
        window.setTimeout(() => {
          if (armedBoxAction !== action) return;
          armedBoxAction = null;
          target.textContent = action === "update" ? "Update" : "Reset";
        }, 6000);
        showToast(action === "update"
          ? "Click again to move the box to a fresh instance. Files and logins are kept."
          : "Click again to restore the box from its last snapshot. Recent unsynced work can be lost.");
        return;
      }
      armedBoxAction = null;
      target.disabled = true;
      target.textContent = action === "update" ? "Updating…" : "Resetting…";
      (action === "update" ? adapter.updateBox(agentId) : adapter.resetBox(agentId))
        .then((result) => showToast(`The host answered: box ${result.state}`))
        .catch((error) => showToast(`The box was not ${action === "update" ? "updated" : "reset"}: ${error.message}`))
        .finally(() => { if (elements.panelDialog.open) fillHostStatus(); });
    } else if (target.dataset.manageMember && activeContext().kind === "room") {
      if (target.dataset.memberAction === "add") adapter.addMember(activeContext().id, target.dataset.manageMember);
      else adapter.removeMember(activeContext().id, target.dataset.manageMember);
      openPanel("Room roster", `${contextName()} members`, membersPanel());
    } else if (target.hasAttribute("data-save-review")) {
      const toggle = document.getElementById("auto-review-toggle");
      const rule = document.getElementById("auto-review-rule");
      // Report the write, not the intent to write. This is the one panel where a premature
      // "saved" tells the operator a safety gate is armed when it is not.
      Promise.resolve(adapter.setAutoReview(toggle.getAttribute("aria-pressed") === "true", rule.value))
        .then(() => showToast("Review policy saved to the host"))
        .catch((error) => showToast(`Policy not saved: ${error.message}`));
    } else if (target.id === "auto-review-toggle") {
      target.setAttribute("aria-pressed", target.getAttribute("aria-pressed") !== "true");
    } else if (target.hasAttribute("data-open-context-browser")) {
      openDesktop("browser");
    } else if (target.dataset.saveRole) {
      const agentId = target.dataset.saveRole;
      const field = (attr) => elements.panelContent.querySelector(`[${attr}="${CSS.escape(agentId)}"]`);
      const roleInput = field("data-role-for");
      const nameInput = field("data-name-for");
      const descriptionInput = field("data-description-for");
      // The adapter reads the saved profile back, so this reports the host's record and not the
      // box. Name and description ride the same updateAgent write (GW-01) where the adapter has it.
      const write = typeof adapter.updateProfile === "function" && nameInput
        ? adapter.updateProfile(agentId, { title: roleInput ? roleInput.value : "", name: nameInput.value, description: descriptionInput ? descriptionInput.value : "" }).then((saved) => saved.title)
        : adapter.setRole(agentId, roleInput ? roleInput.value : "");
      write
        .then((role) => showToast(nameInput ? `Profile saved on the host${role ? ` — role “${role}”` : ""}` : role ? `Role saved as “${role}”` : "Role cleared on the host"))
        .catch((error) => showToast(`Profile not saved: ${error.message}`));
    } else if (target.dataset.toggleNotify) {
      const wanted = target.getAttribute("aria-pressed") !== "true";
      adapter.setNotifications(target.dataset.toggleNotify, wanted)
        .then((on) => { target.setAttribute("aria-pressed", String(on)); showToast(`Notifications ${on ? "on" : "off"} on the host`); })
        .catch((error) => showToast(`Notifications not changed: ${error.message}`));
    } else if (target.dataset.toggleHidden) {
      const wanted = target.getAttribute("aria-pressed") !== "true";
      adapter.setHidden(target.dataset.toggleHidden, wanted)
        .then((hidden) => { target.setAttribute("aria-pressed", String(hidden)); showToast(hidden ? "Moved to the roster's Hidden group" : "Back in the roster"); })
        .catch((error) => showToast(`Not ${wanted ? "hidden" : "unhidden"}: ${error.message}`));
    } else if (target.dataset.duplicateAgent) {
      target.disabled = true;
      adapter.duplicateAgent(target.dataset.duplicateAgent)
        .then((copy) => { elements.panelDialog.close(); rosterMode = "workers"; showToast(`${copy.name} created on the host`); })
        .catch((error) => { target.disabled = false; showToast(`Not duplicated: ${error.message}`); });
    } else if (target.dataset.deleteAgent) {
      const agentId = target.dataset.deleteAgent;
      // Two clicks, the same shape as every other delete on this page: the host keeps no copy.
      if (armedDeleteAgentId !== agentId) {
        armedDeleteAgentId = agentId;
        target.textContent = "Confirm";
        window.setTimeout(() => {
          if (armedDeleteAgentId !== agentId) return;
          armedDeleteAgentId = null;
          target.textContent = "Delete";
        }, 4000);
        showToast("Click again to delete this agent and its conversation. The host keeps no copy.");
        return;
      }
      armedDeleteAgentId = null;
      target.disabled = true;
      adapter.deleteAgent(agentId)
        .then((name) => { elements.panelDialog.close(); showToast(`${name} deleted on the host`); })
        .catch((error) => { target.disabled = false; target.textContent = "Delete"; showToast(`Not deleted: ${error.message}`); });
    } else if (target.dataset.readAudit || target.dataset.moreAudit) {
      const agentId = target.dataset.readAudit || target.dataset.moreAudit;
      const before = target.dataset.moreAudit ? target.dataset.before : null;
      target.disabled = true;
      adapter.getActionAudit(agentId, { limit: 25, ...(before ? { before } : {}) })
        .then((page) => {
          const list = elements.panelContent.querySelector("[data-audit-list]");
          if (!list) return;
          const start = auditHeads.length;
          auditHeads.push(...page.rows.map((row) => maskSecrets(String(row.head ?? "").slice(0, 600))));
          const rows = page.rows.map((row, i) => `<div class="panel-card" data-audit-row="${escapeHtml(String(row.eventId ?? ""))}"><div class="setting-row"><div><strong>${escapeHtml(row.tool ?? row.type ?? "action")}</strong><small>${escapeHtml(String(row.type ?? ""))} · ${row.ok === false ? "failed" : "ok"} · ${Number(row.bytes) || 0} bytes${row.truncated ? " · truncated" : ""} · ${escapeHtml(row.ts ? new Date(row.ts).toLocaleString() : "")}</small></div><span class="status-pill${row.ok === false ? "" : " success"}">${escapeHtml(String(row.sha256 ?? "").slice(0, 12))}</span></div><pre class="evidence-head" data-audit-head-slot="${start + i}">The host kept this output out of model context. It is not on this page until you ask for it.</pre><div class="form-actions"><button class="ghost-button" type="button" data-reveal-audit-head="${start + i}">Show output</button></div></div>`).join("");
          const more = page.nextBefore ? `<div class="form-actions"><button class="ghost-button" type="button" data-more-audit="${escapeHtml(agentId)}" data-before="${escapeHtml(String(page.nextBefore))}">Older rows</button></div>` : "";
          const older = list.querySelector("[data-more-audit]")?.parentElement;
          if (older) older.remove();
          list.insertAdjacentHTML("beforeend", (rows || (before ? "" : `<div class="empty-state">The host holds no action ledger rows for this agent yet.</div>`)) + more);
          if (target.dataset.readAudit) target.remove();
        })
        .catch((error) => { target.disabled = false; showToast(`Could not read the action ledger: ${error.message}`); });
    } else if (target.dataset.revealAuditHead) {
      const slot = elements.panelContent.querySelector(`[data-audit-head-slot="${CSS.escape(target.dataset.revealAuditHead)}"]`);
      if (slot) slot.textContent = auditHeads[Number(target.dataset.revealAuditHead)] || "The host stored no output for this row.";
      target.remove();
    } else if (target.dataset.revealHead) {
      // One attestation at a time, and only on a click: the head goes into the DOM here and
      // nowhere else.
      const slot = elements.panelContent.querySelector(`[data-head-slot="${CSS.escape(target.dataset.revealHead)}"]`);
      if (slot) slot.textContent = evidenceHeads[Number(target.dataset.revealHead)] || "The host stored no output for this attestation.";
      target.remove();
    } else if (target.dataset.forgetMemory) {
      const worker = contextRecord();
      adapter.forgetMemory(worker.id, target.dataset.forgetMemory)
        .then((rows) => {
          const list = elements.panelContent.querySelector("[data-memory-list]");
          if (list) list.innerHTML = memoryRowsMarkup(rows);
          showToast("The host forgot that memory");
        })
        .catch((error) => showToast(`That memory was not forgotten: ${error.message}`));
    } else if (target.dataset.clearMemories) {
      // Two clicks rather than confirm(): the same shape the routine delete uses, and a native
      // dialog on top of a modal panel is not what the rest of this looks like.
      const agentId = target.dataset.clearMemories;
      if (armedClearMemoriesId !== agentId) {
        armedClearMemoriesId = agentId;
        target.textContent = "Confirm";
        window.setTimeout(() => {
          if (armedClearMemoriesId !== agentId) return;
          armedClearMemoriesId = null;
          target.textContent = "Forget all";
        }, 4000);
        showToast("Click again to forget every memory for this agent.");
        return;
      }
      armedClearMemoriesId = null;
      target.textContent = "Forget all";
      adapter.clearMemories(agentId)
        .then((rows) => {
          const list = elements.panelContent.querySelector("[data-memory-list]");
          if (list) list.innerHTML = memoryRowsMarkup(rows);
          showToast("The host forgot every memory for this agent");
        })
        .catch((error) => showToast(`Memories not cleared: ${error.message}`));
    }
  }

  function handlePanelSubmit(event) {
    const form = event.target;
    event.preventDefault();
    if (form.dataset.secretForm) {
      const input = form.elements.secret;
      const plugin = state.plugins.find((item) => item.id === form.dataset.secretForm);
      // Same as the connector key form below: the card can be replaced between render and submit.
      if (!plugin) { showToast("That card is no longer on this page; nothing was sent."); input.value = ""; return; }
      // The adapter awaits the adoption and resolves with what the relay then holds, so the toast
      // reports the outcome. It used to claim the value had been discarded while the relay stored it.
      Promise.resolve(adapter.submitSecret(plugin.id, plugin.secretField, input.value))
        .then((result) => {
          if (!result) return;
          if (result.accepted) { selectedPluginId = plugin.id; renderPluginsPanel(); }
          showToast(result.message ?? (result.accepted
            ? (isLiveGateway() ? `${plugin.name} connected` : `${plugin.name} connected in this offline view — the value was discarded, nothing was stored`)
            : `${plugin.name} was not connected`));
        })
        .catch((error) => showToast(`${plugin.name} was not connected: ${error.message}`));
      input.value = "";
    } else if (form.dataset.connectorSecretForm) {
      // CP-10 item 1: one setConnectorSecret per filled field. Every input is cleared before the
      // calls resolve, so no value sits in a control while the writes are in flight, and none of
      // them is ever written into the markup.
      const plugin = state.plugins.find((item) => item.id === form.dataset.connectorSecretForm);
      // refreshConnectors and refreshSubscriptions replace state.plugins wholesale, so the card
      // can be gone between render and submit. Reading plugin.name after the inputs were cleared
      // threw synchronously out of the .map callback, past Promise.all's .catch: the typed value
      // was lost, the button stayed disabled and nothing was said.
      if (!plugin) { showToast("That connector is no longer on this page; nothing was sent."); return; }
      const entries = Array.from(form.querySelectorAll("input[type=password]"))
        .map((input) => ({ field: input.name, value: input.value }))
        .filter((entry) => entry.value.length > 0);
      form.querySelectorAll("input[type=password]").forEach((input) => { input.value = ""; });
      if (!entries.length) { showToast("Nothing to store — every field was blank"); return; }
      const submit = form.querySelector("button[type=submit]");
      if (submit) submit.disabled = true;
      // CONNECT-5: a shell tool's credential goes to the shell store, a connector's to the
      // connector store. Same form, same clearing, two destinations.
      const store = plugin.shellTool && typeof adapter.setShellSecret === "function"
        ? (field, value) => adapter.setShellSecret(plugin.shellTool.id, field, value)
        : (field, value) => adapter.setConnectorSecret(plugin.name, field, value);
      Promise.all(entries.map((entry) => Promise.resolve(store(entry.field, entry.value))))
        .then((results) => {
          if (submit) submit.disabled = false;
          const bad = results.find((r) => r && r.accepted === false);
          showToast(bad?.message ?? results[0]?.message ?? `${plugin.name} credentials stored on the host`);
        })
        .catch((error) => { if (submit) submit.disabled = false; showToast(`Not stored: ${error.message}`); });
    } else if (form.hasAttribute("data-add-connector")) {
      const data = new FormData(form);
      const submit = form.querySelector("button[type=submit]");
      if (submit) submit.disabled = true;
      // Quotes group, so an argument that holds a space -- a --header value, which is how a remote
      // MCP server takes a key -- survives this field. The adapter owns the rule; a factory that
      // does not have it falls back to the whitespace split this form always did.
      const argsText = String(data.get("args") ?? "");
      const spec = {
        name: String(data.get("name") ?? "").trim(),
        command: String(data.get("command") ?? "").trim(),
        args: typeof adapter.splitConnectorArgs === "function" ? adapter.splitConnectorArgs(argsText) : argsText.trim().split(/\s+/).filter(Boolean),
        envNames: String(data.get("envNames") ?? "").split(",").map((n) => n.trim()).filter(Boolean),
      };
      // Only a preset that owns its name may overwrite an entry already using it, and only while
      // the name in the field is still that one.
      if (form.dataset.presetName && form.dataset.presetName === spec.name) spec.replace = true;
      Promise.resolve(adapter.addConnector(spec))
        .then((result) => {
          if (submit) submit.disabled = false;
          if (result?.accepted) { form.reset(); delete form.dataset.presetName; }
          renderPluginsPanel();
          showToast(result?.message ?? `${spec.name} written to connectors.json`);
        })
        .catch((error) => { if (submit) submit.disabled = false; showToast(`${spec.name} was not added: ${error.message}`); });
    } else if (form.dataset.connectChannel) {
      // CP-04: the token goes straight to connectChannel for the agent on screen and the input is
      // cleared first, so it is never left sitting in a control on a page anyone can walk up to.
      const platform = form.dataset.connectChannel;
      const input = form.elements.token;
      const token = input?.value ?? "";
      if (input) input.value = "";
      if (!token.trim()) { showToast("The host stores nothing for an empty token"); return; }
      const submit = form.querySelector("button[type=submit]");
      if (submit) submit.disabled = true;
      // listenerConnectMarkup says "Connect Slack for <contextLead().name>"; the token must be
      // stored against that same agent, which on a group is a member worker and not the room.
      Promise.resolve(adapter.connectListener(platform, token, contextLead()?.id))
        .then((result) => {
          if (submit) submit.disabled = false;
          renderPluginsPanel();
          showToast(result?.message ?? `${platform} connect sent to the host`);
        })
        .catch((error) => { if (submit) submit.disabled = false; showToast(`${platform} was not connected: ${error.message}`); });
    } else if (form.hasAttribute("data-new-routine") || form.dataset.editRoutineForm) {
      const data = new FormData(form);
      const submit = form.querySelector("button[type=submit]");
      submit.disabled = true;
      const problems = draftTriggers.map(triggerProblem).filter(Boolean);
      if (problems.length) {
        submit.disabled = false;
        showToast(`Fix the trigger first: ${problems[0]}`);
        return;
      }
      const context = activeContext();
      const routineId = form.dataset.editRoutineForm;
      const edited = routineId ? state.routines.find((entry) => entry.id === routineId) : null;
      // One trigger goes as itself; several become the group the host understands.
      const trigger = draftTriggers.length === 1 ? draftTriggers[0] : { type: "group", listeners: draftTriggers };
      const spec = {
        name: String(data.get("name")).trim(),
        prompt: String(data.get("prompt")).trim(),
        trigger,
        // A paused routine stays paused through an edit. Sending a flat true here would restart
        // a routine somebody deliberately stopped, because they fixed a typo in it.
        isEnabled: edited ? edited.status !== "paused" : true,
      };
      const saved = routineId
        ? adapter.updateRoutine(routineId, spec)
        : adapter.createRoutine(context.id, context.kind, spec);
      saved.then((routine) => {
        resetRoutineForm();
        renderRoutinesPanel();
        showToast(`${routine.name} ${routineId ? "saved" : "created"} — ${routine.trigger}`);
      }).catch((error) => {
        submit.disabled = false;
        showToast(`Could not ${routineId ? "save" : "create"} that routine: ${error.message}`);
      });
    } else if (form.hasAttribute("data-skill-form")) {
      const data = new FormData(form);
      const worker = contextRecord();
      const submit = form.querySelector("button[type=submit]");
      submit.disabled = true;
      const spec = { name: String(data.get("name") ?? "").trim(), description: String(data.get("description") ?? "").trim(), body: String(data.get("body") ?? "").trim() };
      const workflowId = form.dataset.skillForm;
      // The adapter reads the list back before resolving, so the toast reports the host's row.
      (workflowId ? adapter.updateSkill(worker.id, workflowId, spec) : adapter.createSkill(worker.id, spec))
        .then((skill) => { editingSkillId = null; renderSkillsPanel(); showToast(`${skill.name} ${workflowId ? "saved" : "created"} on the host`); })
        .catch((error) => { submit.disabled = false; showToast(`Could not ${workflowId ? "save" : "create"} that skill: ${error.message}`); });
    } else if (form.hasAttribute("data-import-skill-text") || form.hasAttribute("data-import-skill-url")) {
      const data = new FormData(form);
      const worker = contextRecord();
      const submit = form.querySelector("button[type=submit]");
      submit.disabled = true;
      const byUrl = form.hasAttribute("data-import-skill-url");
      (byUrl ? adapter.importSkillUrl(worker.id, data.get("url")) : adapter.importSkillText(worker.id, data.get("markdown")))
        .then((outcome) => {
          renderSkillsPanel();
          // The host says what it imported and what it skipped, with the reason; both are shown.
          if (outcome.imported.length) showToast(`Imported ${outcome.imported.join(", ")}`);
          else if (outcome.skipped.length) showToast(`Not imported — ${outcome.skipped[0].reason}`);
          else if (outcome.missing.length) showToast(`The host reported ${outcome.missing.join(", ")} imported but does not list it`);
          else showToast("The host imported nothing and gave no reason");
        })
        .catch((error) => { submit.disabled = false; showToast(`Could not import that skill: ${error.message}`); });
    } else if (form.hasAttribute("data-add-worker")) {
      const data = new FormData(form);
      Promise.resolve(adapter.addWorker({ name: data.get("name"), role: data.get("role") }))
        .then((worker) => { rosterMode = "workers"; elements.panelDialog.close(); showToast(`${worker.name} created with a direct conversation`); })
        .catch((error) => showToast(`Could not create that agent: ${error.message}`));
    } else if (form.hasAttribute("data-add-room")) {
      const data = new FormData(form);
      const memberId = data.get("memberId");
      Promise.resolve(adapter.addRoom({ name: data.get("name"), memberIds: memberId ? [memberId] : [] }))
        .then((room) => { rosterMode = "rooms"; elements.panelDialog.close(); showToast(`${room.name} room created`); })
        .catch((error) => showToast(`Could not create that room: ${error.message}`));
    }

  }

  adapter.subscribe((event) => {
    state = event.snapshot;
    // An older page is the one transcript change that must not move the reader.
    if (event.type === "transcript:older") { renderTranscriptKeepingOffset(); renderContextCard(); return; }
    // A revealed entry: the window may have grown backwards; redraw, then scroll to and flash it.
    if (event.type === "transcript:reveal") {
      // Redrawn without the bottom scroll, and flashed on the next frame, after the redraw has
      // laid out: a scrollIntoView before that frame was undone by the render's own scroll.
      renderAll(true, true);
      const entryId = event.detail?.entryId;
      requestAnimationFrame(() => { if (entryId && !flashEntry(entryId)) showToast("That message is not in the loaded part of the conversation."); });
      return;
    }
    renderAll(event.type === "worker:status" || event.type.startsWith("plugin:") || event.type.startsWith("settings:"));
    refreshOpenSkillsPanel();
    // MARKET-1: the install states are derived from the connector cards, so a connector the host
    // has finished launching moves "Connecting" to "Ready" without the operator reopening the panel.
    if (event.type.startsWith("plugin:") && elements.panelDialog.open && openPluginSurface === "marketplace") refreshMarketplace(true);
    if (event.type === "desktop:pause") renderDesktop();
    // Not renderDesktop: that remounts the VNC frame. Only the hand-back control follows state.
    else if (elements.desktopDialog.open) renderHandBack();
  });

  // On the wheel, not on "scroll": replacing the transcript's markup clamps scrollTop to 0 for a
  // frame and fires a scroll event, which paged the entire history in on every redraw. A wheel
  // upward at the top is the operator asking.
  elements.transcript.addEventListener("wheel", (event) => {
    if (event.deltaY < 0 && elements.transcript.scrollTop <= 40) loadOlderMessages();
  }, { passive: true });

  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.messageInput.value.trim();
    const ready = pendingAttachments.filter((a) => a.path);
    if (!text && ready.length === 0) return;
    if (pendingAttachments.some((a) => a.pending)) { showToast("Still uploading — one moment."); return; }
    const context = { ...activeContext() };
    adapter.sendMessage(context, text, ready);
    pendingAttachments = [];
    renderAttachmentTray();
    elements.messageInput.value = "";
    // Demo-only. Against a live gateway the worker answers for itself and this would talk over it.
    if (!window.__machineRoomLive) simulateReply(context, text);
  });

  elements.rosterList.addEventListener("click", (event) => {
    // The Hidden group's disclosure: remember the state the click is about to set, because the
    // next redraw rebuilds the group from markup.
    const summary = event.target.closest("[data-roster-hidden] > summary");
    if (summary) { hiddenGroupOpen = !summary.parentElement.open; return; }
    const card = event.target.closest("[data-context-kind][data-context-id]");
    if (card) selectContext(card.dataset.contextKind, card.dataset.contextId);
  });

  elements.workspaceList.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-context-kind][data-context-id]");
    if (chip) selectContext(chip.dataset.contextKind, chip.dataset.contextId);
  });

  document.querySelectorAll("[data-roster-tab]").forEach((tab) => tab.addEventListener("click", () => {
    rosterMode = tab.dataset.rosterTab;
    renderRoster();
  }));

  elements.contextCard.addEventListener("click", handleContextCardClick);
  // Agent-to-agent traffic is shown as one blurb; opening it shows the exchange read-only, the
  // way the product does, without it ever bleeding into this conversation.
  function openExchangeViewer(messageId) {
    const message = contextMessages().find((item) => item.id === messageId);
    if (!message || !Array.isArray(message.exchange)) return;
    const rows = message.exchange.map((item) => `<div class="exchange-message${item.peer ? " is-peer" : ""}"><strong>${escapeHtml(item.from)}</strong><time>${escapeHtml(item.time || "")}</time><p>${escapeHtml(item.text)}</p></div>`).join("");
    openPanel("Agent to agent", `${escapeHtml(message.self || "This agent")} ↔ ${escapeHtml(message.peer || "another agent")}`, `<div class="exchange-view">${rows}<div class="exchange-footer">🔒 This chat is view-only</div></div>`);
  }

  // Receipts and attestations are raw host data: a receipt carries the shell command's own argv,
  // and an attestation head is the first 600 chars of a tool result, which the host deliberately
  // keeps out of model context (evidence-registry.ts). `cat ~/.api_keys`, an `env`, or a curl
  // with an Authorization header would otherwise land verbatim on this page. Two rules follow:
  // token-shaped runs are masked everywhere, and a result head is not put in the DOM at all
  // until someone asks for that one attestation.
  const SECRETISH = /(?:sk-|xai-|gsk_|ghp_|AIza|xox[abprs]-)[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|[A-Za-z0-9_\-+/=]{32,}/g;
  const maskSecrets = (value) => String(value ?? "").replace(SECRETISH, (hit) => `${hit.slice(0, 4)}…[redacted, ${hit.length} chars]`);
  // Only shell_command receipts carry `command`; an mcp_tool_call carries toolName and
  // serverIdentifier, a browser_navigation a url, a computer_use_session a toolCallId. Falling
  // straight through to eventId printed a bare UUID for all three -- a receipt disclosing nothing.
  const receiptLabel = (r) => {
    if (r.command) return String(r.command);
    if (r.toolName) return `${r.serverIdentifier ? `${r.serverIdentifier} · ` : ""}${r.toolName}`;
    if (r.url) return String(r.url);
    return String(r.target ?? r.toolCallId ?? r.eventId ?? "");
  };
  // Heads live here rather than in the markup so that the un-revealed ones are never serialised
  // into the page at all.
  let evidenceHeads = [];

  // GW-13: the receipts behind an evidence verdict. Everything shown here is read back from
  // getAgentEvidence for this attempt; nothing is derived from the pill's own sentence.
  function openEvidenceViewer(messageId) {
    const message = contextMessages().find((item) => item.id === messageId);
    const attemptId = message?.evidence?.attemptId;
    if (!attemptId) return;
    const missing = (message.evidence.missing ?? []);
    openPanel("Claim provenance", `Evidence · ${message.evidence.verdict}`,
      `<div class="panel-intro"><p>The host checked this reply against the tool results of attempt <code>${escapeHtml(attemptId)}</code>.</p><span class="status-pill${message.evidence.verdict === "evidenced" ? " success" : ""}">${escapeHtml(message.evidence.verdict)}</span></div><div class="evidence-view" data-evidence-body>Reading the receipts from the host…</div>`);
    adapter.getEvidence(activeContext().id, attemptId).then(({ receipts, attestations }) => {
      const body = elements.panelContent.querySelector("[data-evidence-body]");
      if (!body) return;
      const tools = [...new Set(attestations.map((a) => a.tool).filter(Boolean))];
      const receiptRows = receipts.length
        ? receipts.map((r) => `<div class="context-detail-row"><span>${escapeHtml(r.type ?? "action")}</span><strong>${escapeHtml(maskSecrets(receiptLabel(r)))}</strong></div>`).join("")
        : `<div class="empty-state">No action receipts were written for this attempt.</div>`;
      evidenceHeads = attestations.map((a) => maskSecrets(String(a.head ?? "").slice(0, 600)));
      const attRows = attestations.length
        ? attestations.map((a, i) => `<div class="panel-card"><div class="setting-row"><div><strong>${escapeHtml(a.tool ?? "tool")}</strong><small>${a.ok ? "ok" : "failed"} · ${Number(a.bytes) || 0} bytes${a.truncated ? " · truncated" : ""}</small></div><span class="status-pill${a.ok ? " success" : ""}">${escapeHtml(String(a.sha256 ?? "").slice(0, 12))}</span></div><pre class="evidence-head" data-head-slot="${i}">The host kept this result out of model context. It is not on this page until you ask for it.</pre><div class="form-actions"><button class="ghost-button" type="button" data-reveal-head="${i}">Show output</button></div></div>`).join("")
        : `<div class="empty-state">No tool result was attested for this attempt.</div>`;
      body.innerHTML = `<div class="tag-list"><span class="tag">${receipts.length} receipt${receipts.length === 1 ? "" : "s"}</span><span class="tag">${attestations.length} attestation${attestations.length === 1 ? "" : "s"}</span>${tools.map((t) => `<span class="tag">tool · ${escapeHtml(t)}</span>`).join("")}</div>${missing.length ? `<div class="empty-state">Backed by no tool result this attempt: ${escapeHtml(missing.join(", "))}</div>` : ""}<div class="plugin-section-title"><span>Actions taken</span></div>${receiptRows}<div class="plugin-section-title"><span>Attested tool output</span></div>${attRows}`;
    }).catch((error) => {
      const body = elements.panelContent.querySelector("[data-evidence-body]");
      if (body) body.innerHTML = `<div class="empty-state">The host could not return the receipts for this attempt: ${escapeHtml(error.message)}</div>`;
    });
  }

  elements.transcript.addEventListener("click", (event) => {
    if (event.target.closest("[data-load-older]")) { loadOlderMessages(); return; }
    const dismiss = event.target.closest("[data-dismiss-card]");
    if (dismiss) {
      // No toast: the card reports what the host did once the refresh has read it back.
      if (typeof adapter.dismissCard === "function") adapter.dismissCard(activeContext(), dismiss.dataset.dismissCard).catch(() => {});
      return;
    }
    const more = event.target.closest("[data-attachment-more]");
    if (more) { showMoreAttachment(more.closest("[data-attachment]")); return; }
    const evidence = event.target.closest("[data-evidence]");
    if (evidence) { openEvidenceViewer(evidence.dataset.messageId); return; }
    const exchange = event.target.closest("[data-exchange]");
    if (exchange) { openExchangeViewer(exchange.dataset.messageId); return; }
    const secret = event.target.closest("[data-submit-secret]");
    if (secret) {
      const id = secret.dataset.submitSecret;
      const input = elements.transcript.querySelector(`[data-secret-input="${CSS.escape(id)}"]`);
      const value = input?.value ?? "";
      // Cleared before the call resolves: the value must not sit in a control on screen while a
      // request is in flight, and nothing ever writes it back into the markup.
      if (input) input.value = "";
      if (!value.trim()) { showToast("The host discards an empty value"); return; }
      secret.disabled = true;
      Promise.resolve(adapter.submitSecretRequest(activeContext(), id, value))
        .then((result) => { if (result?.message) showToast(result.message); })
        .catch((error) => { secret.disabled = false; showToast(`That credential was not stored: ${error.message}`); });
      return;
    }
    const action = event.target.closest("[data-decide]");
    if (!action) return;
    // No toast: the card itself reports what the host did, once the host has done it.
    adapter.decideApproval(activeContext(), action.dataset.messageId, action.dataset.decide);
  });

  // Both disclosures carry role="button" tabindex="0", so a keyboard user can focus them; without
  // this they were focusable controls that did nothing on Enter or Space.
  elements.transcript.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    const evidence = event.target.closest?.("[data-evidence]");
    const exchange = evidence ? null : event.target.closest?.("[data-exchange]");
    if (!evidence && !exchange) return;
    event.preventDefault();
    if (evidence) openEvidenceViewer(evidence.dataset.messageId);
    else openExchangeViewer(exchange.dataset.messageId);
  });

  document.querySelectorAll("[data-capability]").forEach((button) => button.addEventListener("click", () => {
    const capability = button.dataset.capability;
    if (capability === "files") openDesktop("files");
    else if (capability === "browser") openDesktop("browser");
    else if (capability === "routines") renderRoutinesPanel();
    else if (capability === "skills") renderSkillsPanel();
    else if (capability === "marketplace") { marketplacePluginId = null; renderMarketplacePanel(); }
    else if (capability === "add") openPanel("Global creation", "Add to the Machine Room", addPanel());
  }));

  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => elements.panelDialog.close()));
  document.querySelectorAll("[data-close-desktop]").forEach((button) => button.addEventListener("click", () => elements.desktopDialog.close()));
  document.querySelectorAll("[data-desktop-app]").forEach((button) => button.addEventListener("click", () => renderDesktop(button.dataset.desktopApp)));
  elements.panelContent.addEventListener("click", handlePanelClick);
  elements.panelContent.addEventListener("input", handleTriggerInput);
  elements.panelContent.addEventListener("input", handleMarketplaceInput);
  elements.panelContent.addEventListener("change", handleTriggerInput);
  // GW-01: the avatar control. A PNG file, base64, to setAgentAvatarBytes; the adapter reads
  // the new version back and the panel's own image follows it.
  elements.panelContent.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-avatar-for]");
    if (!input) return;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!/\.png$/i.test(file.name) && file.type !== "image/png") { showToast("The host stores avatars as PNG — pick a .png file."); return; }
    if (file.size > 2 * 1024 * 1024) { showToast("That PNG is over 2MB — pick a smaller one."); return; }
    const agentId = input.dataset.avatarFor;
    const note = elements.panelContent.querySelector("[data-avatar-note]");
    if (note) note.textContent = "Sending the PNG to the host…";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const saved = await adapter.setAvatar(agentId, btoa(binary));
      elements.panelContent.querySelectorAll(".context-profile-avatar").forEach((img) => { img.src = saved.avatar; });
      if (note) note.textContent = `The host serves this agent's own avatar (version ${saved.version}).`;
      showToast("Avatar stored on the host");
    } catch (error) {
      if (note) note.textContent = `Avatar not stored: ${error.message}`;
      showToast(`Avatar not stored: ${error.message}`);
    }
  });
  elements.panelContent.addEventListener("submit", handlePanelSubmit);

  const openSettings = openSettingsPanel;
  document.getElementById("settings-button").addEventListener("click", openSettings);
  document.getElementById("shelf-settings").addEventListener("click", openSettings);
  document.getElementById("people-button").addEventListener("click", () => {
    if (activeContext().kind === "room") openPanel("Room roster", `${contextName()} members`, membersPanel());
    else openAgentProfile(contextRecord());
  });
  document.getElementById("notifications-button").addEventListener("click", () => openPanel("Recent activity", "Unread", notificationsPanel()));
  // MR-01: this used to open two hardcoded sentences and a button with no handler. Both surfaces
  // it describes are live, so it opens the one that belongs to the context you are in.
  document.getElementById("room-menu").addEventListener("click", () => {
    if (activeContext().kind === "room") openPanel("Room roster", `${contextName()} members`, membersPanel());
    else openAgentProfile(contextRecord());
  });
  // Files staged for the next message. Uploaded on pick, so the send is instant and a failed
  // upload is reported while the operator is still looking at the picker.
  let pendingAttachments = [];

  function renderAttachmentTray() {
    const tray = document.getElementById("attachment-tray");
    if (!tray) return;
    tray.hidden = pendingAttachments.length === 0;
    // QOL-COMPOSER: `note` says how a file got here when it was not picked by hand (a drop, or a
    // paste too big for the box), so the chip explains itself rather than appearing from nowhere.
    tray.innerHTML = pendingAttachments.map((a, i) =>
      `<span class="tag">▱ ${escapeHtml(a.name)}${a.pending ? " · uploading…" : a.note ? ` · ${escapeHtml(a.note)}` : ""}<button class="member-remove" type="button" data-drop-attachment="${i}" aria-label="Remove ${escapeHtml(a.name)}">×</button></span>`).join("");
  }

  document.getElementById("composer-plus").addEventListener("click", () => {
    if (activeContext().kind !== "worker") { showToast("Attach a file in a direct conversation — a room has no attachment store."); return; }
    document.getElementById("composer-file").click();
  });

  document.getElementById("attachment-tray").addEventListener("click", (event) => {
    const drop = event.target.closest("[data-drop-attachment]");
    if (!drop) return;
    pendingAttachments.splice(Number(drop.dataset.dropAttachment), 1);
    renderAttachmentTray();
  });

  // QOL-COMPOSER: lifted out of the picker's handler so the picker, a drop and an oversized paste
  // all stage a file the same way. `note` is what the chip says the file came from.
  async function stageAttachmentFiles(files, note = "") {
    const context = activeContext();
    for (const file of [...(files ?? [])]) {
      // The host reads attachments back in 8MB chunks; refuse anything larger here rather than
      // after a long base64 round trip that fails at the far end.
      if (file.size > 8 * 1024 * 1024) { showToast(`${file.name} is larger than 8MB — the host will not take it.`); continue; }
      const entry = { name: file.name, path: null, pending: true, note };
      pendingAttachments.push(entry);
      renderAttachmentTray();
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const stored = await adapter.uploadAttachment(context.id, file.name, btoa(binary));
        entry.path = stored.path;
        entry.pending = false;
      } catch (error) {
        pendingAttachments = pendingAttachments.filter((a) => a !== entry);
        showToast(`Could not attach ${file.name}: ${error.message}`);
      }
      renderAttachmentTray();
    }
  }

  document.getElementById("composer-file").addEventListener("change", async (event) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    await stageAttachmentFiles(files);
  });

  // ==== QOL-COMPOSER =========================================================================
  // The composer was one <input>: a second line was impossible, a dropped file did nothing (the
  // browser navigated away from the console and opened it), and a pasted document filled a
  // one-line box with a wall nobody could read back. Everything below is that one box growing up.

  // --8<-- QOL-COMPOSER paste helpers (pure; lifted whole by tests/composer-paste.test.mjs)
  // A paste this size is a document, not a sentence. It becomes a file the agent can read rather
  // than a wall of text in a chat bubble.
  const PASTE_MAX_CHARS = 4000;
  const PASTE_MAX_LINES = 40;
  function pasteIsFileSized(text) {
    const value = String(text ?? "");
    if (!value) return false;
    return value.length > PASTE_MAX_CHARS || value.split("\n").length > PASTE_MAX_LINES;
  }
  // Enough of markdown to name the file honestly: a heading, a fence, a list, a quote, a table, a
  // link, or bold. Anything else gets .txt, because .md on a log file is a small lie.
  function looksLikeMarkdown(text) {
    const value = String(text ?? "");
    return /^\s{0,3}#{1,6}\s+\S/m.test(value)
      || /^\s*```/m.test(value)
      || /^\s{0,3}([-*+]|\d+[.)])\s+\S/m.test(value)
      || /^\s{0,3}>\s+\S/m.test(value)
      || /^\s*\|[^\n]*\|\s*$/m.test(value)
      || /\[[^\]\n]+\]\([^)\n]+\)/.test(value)
      || /\*\*\S[^\n]{0,200}?\*\*/.test(value);
  }
  function pastedFileName(text, at = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    return `pasted-${stamp}.${looksLikeMarkdown(text) ? "md" : "txt"}`;
  }
  // --8<-- end QOL-COMPOSER paste helpers

  // Eight lines is where a composer stops being a composer; past that the box scrolls itself.
  const COMPOSER_MAX_LINES = 8;
  function autosizeComposer() {
    const el = elements.messageInput;
    if (!el || el.tagName !== "TEXTAREA") return;
    // The stylesheet gives this box no padding and no border, so scrollHeight is the text's own
    // height and the cap is a plain multiple of the line box.
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(line * COMPOSER_MAX_LINES))}px`;
  }
  elements.messageInput.addEventListener("input", autosizeComposer);
  // After the submit handler above has cleared the value, not before it.
  elements.composer.addEventListener("submit", () => { requestAnimationFrame(autosizeComposer); });
  autosizeComposer();

  elements.messageInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    // An IME candidate window takes the same Enter to commit a character; that is not a send.
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (typeof elements.composer.requestSubmit === "function") elements.composer.requestSubmit();
    else elements.composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  // Drag and drop. The listeners are on the document because a file aimed at the conversation
  // lands on whichever row happens to be under the cursor, and because a drop the page ignores is
  // a drop the browser honours -- it leaves the console and opens the file.
  const dragCarriesFiles = (transfer) => !!transfer && [...(transfer.types ?? [])].includes("Files");
  let dropGlowTimer = 0;
  const showDropGlow = (on) => { if (on) document.body.dataset.composerDrop = "1"; else delete document.body.dataset.composerDrop; };
  document.addEventListener("dragover", (event) => {
    if (!dragCarriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = "copy"; } catch { /* a synthetic drag has no effect to set */ }
    showDropGlow(true);
    // dragleave fires at every child boundary, so the glow is cleared by the drag going quiet
    // rather than by counting enters against leaves and getting it wrong on a fast cursor.
    clearTimeout(dropGlowTimer);
    dropGlowTimer = setTimeout(() => showDropGlow(false), 200);
  });
  document.addEventListener("dragend", () => { clearTimeout(dropGlowTimer); showDropGlow(false); });
  document.addEventListener("drop", (event) => {
    if (!dragCarriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    clearTimeout(dropGlowTimer); showDropGlow(false);
    const files = [...(event.dataTransfer.files ?? [])];
    if (files.length === 0) return;
    if (activeContext().kind !== "worker") { showToast("Drop a file on a direct conversation — a room has no attachment store."); return; }
    stageAttachmentFiles(files);
  });

  elements.messageInput.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!pasteIsFileSized(text)) return;
    // A room has nowhere to put it, so the paste goes in as text rather than being swallowed.
    if (activeContext().kind !== "worker") return;
    event.preventDefault();
    const name = pastedFileName(text);
    const lines = text.split("\n").length;
    stageAttachmentFiles(
      [new File([text], name, { type: name.endsWith(".md") ? "text/markdown" : "text/plain" })],
      // en-US explicitly: the console's copy is English, and the chip's wording is asserted.
      `pasted ${text.length.toLocaleString("en-US")} characters, ${lines} line${lines === 1 ? "" : "s"}`,
    );
  });
  // ==== end QOL-COMPOSER ======================================================================

  // -- GW-09: attachment slots, filled after each transcript render. An image is
  // readAttachmentImage; anything else is a bounded text preview through readAttachmentText
  // (the host's 64 KB head), shown a slice at a time, then readAttachmentChunk once the head is
  // used up. The per-file view state lives here so a transcript rebuild keeps what was expanded.
  const PREVIEW_SLICE = 1500;
  const CHUNK_BYTES = 16 * 1024;
  const attachmentViews = new Map();
  const byteLength = (text) => new TextEncoder().encode(text).length;
  function paintTextPreview(figure, view) {
    const slot = figure.querySelector("[data-attachment-slot]");
    if (!slot) return;
    slot.textContent = maskSecrets(view.text.slice(0, view.shown));
    const remainingHeld = view.text.length > view.shown;
    const remainingFile = view.truncated || view.bytesRead < view.totalSize;
    let more = figure.querySelector("[data-attachment-more]");
    if (remainingHeld || remainingFile) {
      if (!more) { more = document.createElement("button"); more.type = "button"; more.className = "ghost-button attachment-more"; more.dataset.attachmentMore = "1"; figure.appendChild(more); }
      more.textContent = `Show more · ${view.shown.toLocaleString()} of ${view.totalSize ? `${view.totalSize.toLocaleString()} bytes` : "the file"} shown`;
      more.disabled = false;
    } else if (more) more.remove();
  }
  function fillAttachments() {
    if (typeof adapter.readAttachmentImage !== "function") return;
    const agentId = activeContext().kind === "worker" ? activeContext().id : (contextRecord()?.memberIds ?? [])[0] ?? null;
    elements.transcript.querySelectorAll("[data-attachment]").forEach((figure) => {
      const path = figure.dataset.attachment;
      const slot = figure.querySelector("[data-attachment-slot]");
      if (!slot) return;
      if (figure.dataset.attachmentKind === "image") {
        adapter.readAttachmentImage(path, agentId).then((image) => {
          if (!image) { slot.textContent = "The host could not serve this image (not an image it can read, or outside its storage)."; return; }
          slot.innerHTML = `<img class="attachment-image" src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(figure.dataset.attachmentName)}"${image.width ? ` width="${image.width}"` : ""}${image.height ? ` height="${image.height}"` : ""} />`;
        }).catch((error) => { slot.textContent = `The host could not read this image: ${error.message}`; });
        return;
      }
      const held = attachmentViews.get(path);
      if (held) { paintTextPreview(figure, held); return; }
      adapter.readAttachmentText(agentId, path).then((answer) => {
        if (!answer) { slot.textContent = "The host could not read this file (outside this agent's attachments, or gone)."; return; }
        if (answer.kind !== "text") { slot.textContent = `${figure.dataset.attachmentName} · ${Number(answer.bytes) || 0} bytes — not a text file the host previews.`; return; }
        const view = { text: String(answer.text ?? ""), shown: Math.min(PREVIEW_SLICE, String(answer.text ?? "").length), truncated: answer.truncated === true, totalSize: Number(answer.bytes) || 0, bytesRead: byteLength(String(answer.text ?? "")) };
        attachmentViews.set(path, view);
        paintTextPreview(figure, view);
      }).catch((error) => { slot.textContent = `The host could not read this file: ${error.message}`; });
    });
  }
  function showMoreAttachment(figure) {
    if (!figure) return;
    const path = figure.dataset.attachment;
    const view = attachmentViews.get(path);
    if (!view) return;
    if (view.text.length > view.shown) { view.shown = Math.min(view.text.length, view.shown + PREVIEW_SLICE); paintTextPreview(figure, view); return; }
    if (!view.truncated && view.bytesRead >= view.totalSize) return;
    const more = figure.querySelector("[data-attachment-more]");
    if (more) { more.disabled = true; more.textContent = "Reading more from the host…"; }
    const agentId = activeContext().kind === "worker" ? activeContext().id : (contextRecord()?.memberIds ?? [])[0] ?? null;
    adapter.readAttachmentChunk(agentId, path, view.bytesRead, CHUNK_BYTES).then((chunk) => {
      if (!chunk) { view.truncated = false; view.totalSize = view.bytesRead; paintTextPreview(figure, view); return; }
      view.text += chunk.text;
      view.bytesRead += chunk.bytes;
      view.totalSize = chunk.totalSize || view.totalSize;
      view.truncated = view.bytesRead < view.totalSize;
      view.shown = Math.min(view.text.length, view.shown + PREVIEW_SLICE);
      paintTextPreview(figure, view);
    }).catch((error) => { if (more) { more.disabled = false; more.textContent = `Could not read more: ${error.message}`; } });
  }

  // -- GW-14: the search palette. Cmd-K / Ctrl-K, only where isGlobalSearchEnabled answered
  // true at boot (the adapter holds it) and the adapter implements search. Results are the
  // host's own hits; a message row opens that conversation and flashes the entry, a file row
  // opens the conversation and the file's inline preview.
  const palette = document.getElementById("palette");
  const paletteInput = document.getElementById("palette-input");
  const paletteResults = document.getElementById("palette-results");
  let paletteKind = "messages";
  let paletteTimer = null;
  let paletteSeq = 0;
  let paletteHits = { messages: [], bots: [], files: [] };
  const searchAvailable = () => typeof adapter.search === "function" && typeof adapter.searchEnabled === "function" && adapter.searchEnabled();
  function renderPaletteAffordance() {
    const hint = document.getElementById("palette-hint");
    if (hint) hint.hidden = !searchAvailable();
  }
  function renderPaletteResults() {
    if (!paletteResults) return;
    document.querySelectorAll("[data-palette-kind]").forEach((chip) => {
      const n = paletteHits[chip.dataset.paletteKind]?.length ?? 0;
      chip.classList.toggle("is-active", chip.dataset.paletteKind === paletteKind);
      chip.setAttribute("aria-pressed", String(chip.dataset.paletteKind === paletteKind));
      chip.querySelector("b").textContent = String(n);
    });
    const rows = paletteHits[paletteKind] ?? [];
    const row = (kind, id, entryId, title, sub, meta) => `<button class="context-action-row palette-row" type="button" data-palette-open="${kind}" data-context-kind="${escapeHtml(id.kind)}" data-context-id="${escapeHtml(id.id)}"${entryId ? ` data-entry-id="${escapeHtml(entryId)}"` : ""}><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(sub)}</small></span><b>${escapeHtml(meta)}</b></button>`;
    paletteResults.innerHTML = rows.length
      ? rows.map((r) => paletteKind === "messages"
          ? row("message", { kind: r.kind, id: r.agentId }, r.entryId, r.snippet, `${r.agentName} · ${r.role || "message"}`, r.timestampMs ? new Date(r.timestampMs).toLocaleDateString() : "")
          : paletteKind === "bots"
            ? row("bot", { kind: r.kind, id: r.agentId }, null, r.name, r.role || (r.kind === "room" ? "Room" : "Agent"), r.hidden ? "hidden" : "")
            : row("file", { kind: r.kind, id: r.agentId }, r.entryId, r.fileName, `${r.agentName} · ${r.fileKind}`, r.timestampMs ? new Date(r.timestampMs).toLocaleDateString() : "")).join("")
      : `<div class="empty-state">${paletteInput?.value.trim() ? "Nothing on the host matches that." : "Type to search messages, bots and files — the host's own index."}</div>`;
  }
  function runPaletteSearch() {
    const q = paletteInput?.value.trim() ?? "";
    const seq = ++paletteSeq;
    if (!q) { paletteHits = { messages: [], bots: [], files: [] }; renderPaletteResults(); return; }
    adapter.search(q, 20).then((hits) => { if (seq !== paletteSeq) return; paletteHits = hits; renderPaletteResults(); })
      .catch((error) => { if (seq === paletteSeq && paletteResults) paletteResults.innerHTML = `<div class="empty-state">Search failed: ${escapeHtml(error.message)}</div>`; });
  }
  function openPalette() {
    if (!palette || !searchAvailable()) return;
    closeOpenDialogs(palette);
    if (!palette.open) palette.showModal();
    renderPaletteResults();
    paletteInput?.focus();
    paletteInput?.select();
  }
  function openPaletteHit(button) {
    const kind = button.dataset.paletteOpen;
    const context = { kind: button.dataset.contextKind, id: button.dataset.contextId };
    const entryId = button.dataset.entryId || null;
    palette?.close();
    selectContext(context.kind, context.id);
    if (kind === "bot" || !entryId || typeof adapter.revealEntry !== "function") return;
    // selectContext reloads the window asynchronously; revealEntry waits on that read itself.
    adapter.revealEntry(context, entryId).then((found) => {
      if (!found) return;
      if (kind === "file") {
        const figure = elements.transcript.querySelector(`[data-message-id="${CSS.escape(entryId)}"] [data-attachment]`);
        if (figure) figure.classList.add("is-open");
      }
    }).catch((error) => showToast(`Could not open that result: ${error.message}`));
  }
  if (palette) {
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && String(event.key).toLowerCase() === "k") {
        if (!searchAvailable()) return;
        event.preventDefault();
        if (palette.open) palette.close(); else openPalette();
      }
    });
    paletteInput?.addEventListener("input", () => { window.clearTimeout(paletteTimer); paletteTimer = window.setTimeout(runPaletteSearch, 250); });
    palette.addEventListener("click", (event) => {
      if (event.target === palette) { palette.close(); return; }
      const chip = event.target.closest("[data-palette-kind]");
      if (chip) { paletteKind = chip.dataset.paletteKind; renderPaletteResults(); return; }
      const hit = event.target.closest("[data-palette-open]");
      if (hit) openPaletteHit(hit);
    });
    document.getElementById("palette-hint")?.addEventListener("click", openPalette);
    renderPaletteAffordance();
  }

  document.getElementById("open-desktop").addEventListener("click", () => openDesktop("browser"));
  wireDesktopPaste(); // qol/vnc-paste
  elements.scheduleButton.addEventListener("click", renderRoutinesPanel);
  document.getElementById("teach-button").addEventListener("click", (event) => openTeachMode(event.currentTarget));
  document.getElementById("finish-teach").addEventListener("click", () => stopTeachMode(true));
  document.getElementById("discard-teach").addEventListener("click", () => stopTeachMode(false));
  document.getElementById("hand-back").addEventListener("click", (event) => {
    // Captured now: currentTarget is null once dispatch ends, and the .finally below runs after.
    const button = event.currentTarget;
    const agentId = button.dataset.handBack;
    if (!agentId || typeof adapter.handBack !== "function") return;
    button.disabled = true;
    adapter.handBack(agentId)
      .then((result) => { showToast(result.pending ? "The host still reports the hand-off as pending" : "Handed back — the agent resumes on its own"); })
      .catch((error) => showToast(`Could not hand the computer back: ${error.message}`))
      .finally(() => { button.disabled = false; renderHandBack(); });
  });
  document.getElementById("pause-run").addEventListener("click", () => {
    adapter.setRunPaused(!state.desktop.paused);
    showToast(state.desktop.paused ? "Desktop view paused — the worker keeps running" : "Desktop view resumed");
  });
  document.getElementById("dismiss-now").addEventListener("click", () => {
    const routines = routinesForContext();
    const display = routines.find((r) => r.status === "running") || scheduledRoutines()[0];
    nowDismissedId = display ? display.id : null;
    elements.nowIsland.classList.add("is-dismissed");
  });
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "mist" ? "dusk" : "mist";
    showToast(root.dataset.theme === "mist" ? "Mist atmosphere" : "Dusk atmosphere");
  });

  elements.hideRoster.addEventListener("click", () => {
    rosterHidden = !rosterHidden;
    elements.workerRoster.classList.toggle("is-hidden", rosterHidden);
    elements.stage.classList.toggle("roster-hidden", rosterHidden);
    elements.hideRoster.textContent = rosterHidden ? "Show" : "Hide";
  });

  [elements.panelDialog, elements.desktopDialog].forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }));
  // The recording dialog is the one that cannot just close: a way out that dismisses the modal
  // without reaching the host leaves ffmpeg writing with nothing on screen that says so. Escape
  // is that way out, and it is deliberate. A click on the backdrop is not: the dialog is modal,
  // so every click on the page outside its frame lands here, and throwing a live demonstration
  // away on a mis-aimed roster click is how the first run of this flow lost its take.
  elements.teachDialog.addEventListener("click", (event) => {
    if (event.target !== elements.teachDialog) return;
    // Said in the dialog, not in a toast: this modal is in the top layer, so a toast fired while
    // it is open renders behind its own backdrop where nobody reads it.
    showTeachError("Clicking outside does not stop the recording. Stop it with Discard or Finish recording.");
  });
  elements.teachDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    stopTeachMode(false);
  });
  // Which side has the keyboard, decided by where the operator clicks. The cover hands it to the
  // box; anything else in the dialog takes it back, and Escape works again the moment it is back.
  elements.teachDialog.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element)) return;
    // The cover is handled on its click, not here: hiding it under the pointer would take the
    // rest of the gesture with it.
    if (event.target.closest(".teach-screen")) return;
    setTeachScreenControl(false);
  });
  elements.teachDialog.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".teach-shield")) setTeachScreenControl(true);
  });

  countdownInterval = window.setInterval(renderNowAndSchedule, 30_000);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(countdownInterval);
    stopTeachTimers();
    adapter.destroy();
  });

  // ===== Marketplace: the Bots tab's one hook into this file =====
  // marketplace-bots.js renders the Bots tab into whatever element the Marketplace panel hands it.
  // It needs the live adapter for three things and nothing else -- listMarketplace where the
  // adapter carries it, addConnector/installShellTool for an Add on a missing integration, and
  // selectContext/refresh so an imported agent is on screen rather than only on the box. Handing
  // it the adapter here keeps that module out of this file's internals entirely.
  window.__machineRoomAdapter = adapter;
  // ===== end Marketplace hook =====

  renderAll(false);
  renderDesktop("browser");
  resumeTeachMode();
})();
