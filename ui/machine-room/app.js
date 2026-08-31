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
  let countdownInterval = null;
  let toastTimer = null;
  let rosterHidden = false;

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
      <span class="worker-copy"><span class="worker-name"><i class="status-dot ${statusClass(worker.status)}"></i>${escapeHtml(worker.name)}</span><span class="worker-status">${escapeHtml(worker.statusText)}</span></span>
      <span class="voice-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    </button>`;
  }

  function roomCardMarkup(room) {
    const selected = sameContext(activeContext(), { kind: "room", id: room.id });
    const routineCount = routinesForContext({ kind: "room", id: room.id }).length;
    return `<button class="worker-card room-card${selected ? " is-active" : ""}" type="button" data-context-kind="room" data-context-id="${escapeHtml(room.id)}" style="--accent:${escapeHtml(room.accent)}" aria-pressed="${selected}">
      ${roomAvatarsMarkup(room)}
      <span class="worker-copy"><span class="worker-name"><i class="status-dot ready"></i>${escapeHtml(room.name)}</span><span class="worker-status">${room.memberIds.length} workers · ${routineCount} ${routineCount === 1 ? "routine" : "routines"}</span></span>
      <span class="room-count">›</span>
    </button>`;
  }

  function renderRoster() {
    renderRosterTabs();
    elements.rosterList.innerHTML = rosterMode === "workers"
      ? state.workers.map(workerCardMarkup).join("")
      : state.rooms.map(roomCardMarkup).join("");
  }

  function renderConversationHeader() {
    const context = activeContext();
    const name = contextName();
    const members = contextMembers();
    const lead = contextLead();
    elements.roomTitle.textContent = name;
    elements.roomSubtitle.textContent = context.kind === "worker"
      ? `Agent · ${lead.status === "working" ? "working" : "ready"}`
      : `Room · ${members.length} ${members.length === 1 ? "member" : "members"}`;
    elements.messageInput.placeholder = `Ask ${name}…`;
    elements.participantCluster.innerHTML = members.slice(0, 4).map((worker) => avatarMarkup(worker, "participant-avatar", worker.name)).join("");
  }

  function agentContextCard(worker) {
    const model = modelById(worker.model);
    const routineCount = routinesForContext({ kind: "worker", id: worker.id }).length;
    return `<div class="context-profile">
      <div class="island-heading"><div><span class="status-dot ${statusClass(worker.status)}"></span><strong>Agent</strong></div><button class="icon-button compact" type="button" data-context-menu aria-label="Agent options">•••</button></div>
      <div class="context-profile-header">${avatarMarkup(worker, "context-profile-avatar")}<div class="context-profile-copy"><span class="context-kind-label">Direct conversation</span><strong>${escapeHtml(worker.name)}</strong><small>${escapeHtml(worker.statusText)}</small></div></div>
      <div class="context-divider"></div>
      <div class="context-detail-list"><div class="context-detail-row"><span>Role</span><strong>${escapeHtml(worker.role)}</strong></div><div class="context-detail-row"><span>Model</span><strong>${escapeHtml(model ? model.name : worker.model)}</strong></div></div>
      <button class="context-action-row" type="button" data-context-action="profile"><span>Agent details</span><b>›</b></button>
      <button class="context-action-row" type="button" data-context-action="routines"><span>Routines</span><b>${routineCount}</b></button>
      <button class="context-action-row" type="button" data-context-action="files"><span>Files</span><b>${worker.files.length}</b></button>
    </div>`;
  }

  function roomContextCard(room) {
    const members = room.memberIds.map(workerById).filter(Boolean);
    const routineCount = routinesForContext({ kind: "room", id: room.id }).length;
    const memberRows = members.map((worker) => `<div class="member-row">${avatarMarkup(worker, "member-avatar")}<span>${escapeHtml(worker.name)}</span><button class="member-remove" type="button" data-remove-member="${escapeHtml(worker.id)}" aria-label="Remove ${escapeHtml(worker.name)}">×</button></div>`).join("");
    return `<div class="context-profile">
      <div class="island-heading"><div><span class="status-dot success"></span><strong>Room</strong></div><button class="icon-button compact" type="button" data-context-menu aria-label="Room options">•••</button></div>
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

  function paragraphMarkup(text) {
    return String(text || "").split("\n").map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  }

  function approvalMarkup(message) {
    if (message.decision) {
      const label = message.decision === "once" ? "Allowed once" : "Always allowed for this connector";
      return `<div class="inline-card" style="--card-accent:var(--green-500)"><div class="inline-card-header"><span class="inline-card-icon">✓</span><span class="inline-card-copy"><strong>${escapeHtml(message.approval.title)}</strong><small class="approval-result">${escapeHtml(label)}</small></span></div></div>`;
    }
    return `<div class="inline-card" style="--card-accent:var(--teal-500)"><div class="inline-card-header"><span class="inline-card-icon">▣</span><span class="inline-card-copy"><strong>${escapeHtml(message.approval.title)} <span title="Scoped connector request">ⓘ</span></strong><small>${escapeHtml(message.approval.description)}</small></span></div><div class="inline-card-actions"><button class="card-action primary" type="button" data-approval="once" data-message-id="${escapeHtml(message.id)}">✓ Allow once</button><button class="card-action" type="button" data-approval="always" data-message-id="${escapeHtml(message.id)}">↗ Always allow</button></div></div>`;
  }

  function specialMessageMarkup(message) {
    if (message.type === "approval") return approvalMarkup(message);
    if (message.type === "routine-result") return `<div class="inline-card" style="--card-accent:var(--green-500)"><div class="inline-card-header"><span class="inline-card-icon">✓</span><span class="inline-card-copy"><strong>${escapeHtml(message.title)}</strong><small>Test run passed · ${escapeHtml(message.duration)}</small></span></div></div>`;
    if (message.type === "skill") return `<div class="inline-card" style="--card-accent:var(--violet-500)"><div class="inline-card-header"><span class="inline-card-icon">✦</span><span class="inline-card-copy"><strong>${escapeHtml(message.title)}</strong><small>${escapeHtml(message.description)}</small></span></div><div class="tag-list"><span class="tag">skill draft</span><span class="tag">recording attached</span><span class="tag">review required</span></div></div>`;
    return "";
  }

  function messageMarkup(message) {
    if (message.type === "system") return `<article class="message-row is-system" data-message-id="${escapeHtml(message.id)}"><div class="message-bubble">${escapeHtml(message.text)}</div></article>`;
    const isUser = message.authorId === "you";
    const author = workerById(message.authorId);
    const isWorking = message.type === "working";
    const body = isWorking ? `<div class="typing-dots" aria-label="${escapeHtml(message.authorName)} is working"><i></i><i></i><i></i></div>` : `${paragraphMarkup(message.text)}${specialMessageMarkup(message)}`;
    return `<article class="message-row${isUser ? " is-user" : ""}${isWorking ? " working-message" : ""}" data-message-id="${escapeHtml(message.id)}">${!isUser ? avatarMarkup(author, "message-avatar") : ""}<div class="message-block"><div class="message-meta"><strong>${escapeHtml(message.authorName || (author && author.name) || "Worker")}</strong><time>${escapeHtml(message.time || "now")}</time></div><div class="message-bubble">${body}${isUser && message.status ? `<span class="message-status">${message.status === "read" ? "✓✓" : "✓"}</span>` : ""}</div></div></article>`;
  }

  function renderTranscript(keepScroll) {
    const wasNearBottom = elements.transcript.scrollHeight - elements.transcript.scrollTop - elements.transcript.clientHeight < 90;
    elements.transcript.innerHTML = contextMessages().map(messageMarkup).join("");
    if (!keepScroll || wasNearBottom) requestAnimationFrame(() => { elements.transcript.scrollTop = elements.transcript.scrollHeight; });
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
      elements.nowIsland.classList.remove("is-dismissed");
      elements.nowHeading.textContent = running ? "Now" : "Up next";
      elements.routineTitle.textContent = display.name;
      const performer = workerById(display.delegatedToId || display.coordinatorId || (display.scope.kind === "worker" ? display.scope.id : null));
      elements.routineWorker.textContent = running ? `${performer ? performer.name : contextName()} is working` : `Attached to ${contextName()}`;
      elements.routineMeta.textContent = running ? "Started moments ago" : `Scheduled in ${formatCountdown(display.nextRunAt)}`;
    } else {
      elements.nowIsland.classList.add("is-dismissed");
    }
    if (next) {
      elements.countdown.textContent = formatCountdown(next.nextRunAt);
      elements.countdownLabel.textContent = "next routine";
      elements.scheduleButton.setAttribute("aria-label", `${next.name} runs in ${formatCountdown(next.nextRunAt)}`);
      elements.scheduleButton.title = `${next.name} · ${contextName()}`;
    } else {
      elements.countdown.textContent = "trigger";
      elements.countdownLabel.textContent = "event routine";
      elements.scheduleButton.setAttribute("aria-label", `${contextName()} has no timed routine; open event-triggered routines`);
      elements.scheduleButton.title = `${contextName()} routines`;
    }
  }

  function renderAll(keepScroll) {
    renderRoster();
    renderConversationHeader();
    renderContextCard();
    renderTranscript(keepScroll);
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
      const lastResult = routine.lastRun && routine.lastRun.status === "passed" ? `<div class="run-result">✓ Last run passed · ${escapeHtml(routine.lastRun.duration)}</div>` : routine.lastRun ? `<div class="run-result">● Running now…</div>` : "";
      return `<article class="routine-card"><div><div class="routine-header"><h3>${escapeHtml(routine.name)}</h3><span class="status-pill ${running ? "working" : "success"}">${running ? "running" : "ready"}</span></div><p>${escapeHtml(routine.instruction)}</p><div class="routine-meta"><span class="tag">◷ ${escapeHtml(routine.trigger)}</span><span class="tag">attached · ${escapeHtml(routineScopeLabel(routine))}</span>${coordinator ? `<span class="tag">coordinates · ${escapeHtml(coordinator.name)}</span>` : ""}${delegate ? `<span class="tag">runs as · ${escapeHtml(delegate.name)}</span>` : ""}</div>${routine.nextRunAt ? `<div class="run-result">Next run in ${escapeHtml(formatCountdown(routine.nextRunAt))}</div>` : ""}${lastResult}</div><div><button class="primary-button" type="button" data-run-routine="${escapeHtml(routine.id)}" ${running ? "disabled" : ""}>${running ? "Running…" : "Test run"}</button></div></article>`;
    }).join("") : `<div class="empty-state"><div><strong>No routines attached to ${escapeHtml(name)}</strong><p>Create one here and it will belong to this ${context.kind === "worker" ? "agent" : "room"}—not to the whole system.</p></div></div>`;
    return `<div class="panel-intro"><p>These routines belong only to <strong>${escapeHtml(name)}</strong>. ${context.kind === "room" ? "A room routine can coordinate several members and delegate its execution step." : "An agent routine runs in this agent’s own context."}</p><button class="secondary-button" type="button" data-create-routine>＋ New routine</button></div><div class="routine-list">${cards}</div>`;
  }

  function renderRoutinesPanel() {
    openPanel(activeContext().kind === "worker" ? "Agent routines" : "Room routines", `${contextName()} routines`, routinesPanel());
  }

  function pluginStatusLabel(status) {
    return status === "connected" ? "connected" : status === "installed" ? "needs account" : "available";
  }

  function pluginDetailMarkup(plugin) {
    if (!plugin) return `<div class="empty-state">Choose a plugin to inspect its tools and account.</div>`;
    const tools = plugin.tools.map((tool) => `<div class="tool-row"><div><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.description)}</small></div><button class="switch" type="button" data-toggle-tool="${escapeHtml(tool.id)}" aria-label="Toggle ${escapeHtml(tool.name)}" aria-pressed="${tool.enabled}"></button></div>`).join("");
    const skills = plugin.skills.map((skill) => `<span class="tag">✦ ${escapeHtml(skill)}</span>`).join("");
    let account;
    if (plugin.status === "available") account = `<button class="primary-button" type="button" data-install-plugin="${escapeHtml(plugin.id)}">Install package</button>`;
    else if (plugin.status === "installed") account = `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Secure value required</strong><small>Scoped to ${escapeHtml(plugin.name)} · ${escapeHtml(plugin.secretField)}. It never enters chat or model context.</small></div></div><form data-secret-form="${escapeHtml(plugin.id)}"><div class="field"><label for="secret-${escapeHtml(plugin.id)}">${escapeHtml(plugin.secretField)}</label><input id="secret-${escapeHtml(plugin.id)}" name="secret" type="password" autocomplete="off" required placeholder="Enter securely" /><span class="field-hint">Standalone demo: the entered value is immediately discarded.</span></div><div class="form-actions"><button class="primary-button" type="submit">Connect account</button></div></form></div>`;
    else account = `<div class="demo-note"><strong>${escapeHtml(plugin.account || "Connected account")}</strong><br />The connector holds the credential globally. Contexts receive enabled capabilities, never the key.</div>`;
    return `<div class="plugin-hero"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><div class="plugin-hero-copy"><h3>${escapeHtml(plugin.name)}</h3><p>${escapeHtml(plugin.description)}</p></div><span class="status-pill ${plugin.status === "connected" ? "success" : ""}">${escapeHtml(pluginStatusLabel(plugin.status))}</span></div><div class="plugin-sections"><section><div class="plugin-section-title"><span>Global account</span><span>${escapeHtml(plugin.category)}</span></div>${account}</section><section><div class="plugin-section-title"><span>Tools available for assignment</span><span>${plugin.tools.filter((tool) => tool.enabled).length}/${plugin.tools.length} enabled</span></div><div class="plugin-list">${tools}</div></section><section><div class="plugin-section-title"><span>Skills in package</span></div><div class="tag-list">${skills}</div></section></div>`;
  }

  function renderPluginsPanel() {
    const selected = state.plugins.find((plugin) => plugin.id === selectedPluginId) || state.plugins[0];
    selectedPluginId = selected.id;
    const nav = state.plugins.map((plugin) => `<button class="plugin-nav-button${plugin.id === selected.id ? " is-active" : ""}" type="button" data-plugin-id="${escapeHtml(plugin.id)}"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><span><strong>${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.category)}</small></span><span class="status-dot ${plugin.status === "connected" ? "success" : plugin.status === "installed" ? "attention" : ""}"></span></button>`).join("");
    openPanel("Global capabilities", "Plugins, connectors & skills", `<div class="panel-intro"><p>Plugins are installed once for the Machine Room. Their individual tools can then be granted to agents or rooms through policy.</p><span class="status-pill success">global</span></div><div class="plugin-browser"><aside class="plugin-sidebar"><input class="search-input" type="search" placeholder="Find a capability…" aria-label="Find a capability" />${nav}</aside><section class="plugin-detail">${pluginDetailMarkup(selected)}</section></div>`);
  }

  function agentProfilePanel(worker) {
    const model = modelById(worker.model);
    const routines = routinesForContext({ kind: "worker", id: worker.id });
    return `<div class="panel-grid"><section class="panel-card"><div class="panel-card-header">${avatarMarkup(worker, "context-profile-avatar")}<span class="status-pill ${worker.status === "working" ? "working" : "success"}">${escapeHtml(worker.status)}</span></div><h3>${escapeHtml(worker.name)}</h3><p>${escapeHtml(worker.role)}</p><div class="tag-list"><span class="tag">${escapeHtml(model ? model.name : worker.model)}</span><span class="tag">${worker.files.length} files</span><span class="tag">${routines.length} routines</span></div></section><section class="settings-section"><h3>Agent-owned context</h3><p>The direct transcript, files, browser session, model, and routines shown here belong to this agent. They are not a one-person room.</p><div class="setting-row"><div><strong>Direct conversation</strong><small>Private operator-to-agent thread</small></div><span class="status-pill success">active</span></div><div class="setting-row"><div><strong>Browser</strong><small>${escapeHtml(worker.browser.url)}</small></div><button class="ghost-button" type="button" data-open-context-browser>Open</button></div></section></div>`;
  }

  function membersPanel() {
    const room = contextRecord();
    const rows = state.workers.map((worker) => {
      const member = room.memberIds.includes(worker.id);
      return `<div class="member-manager-row"><div class="member-row">${avatarMarkup(worker, "member-avatar")}<span>${escapeHtml(worker.name)}</span></div><button class="${member ? "ghost-button" : "primary-button"}" type="button" data-manage-member="${escapeHtml(worker.id)}" data-member-action="${member ? "remove" : "add"}">${member ? "Remove" : "Add"}</button></div>`;
    }).join("");
    return `<div class="panel-intro"><p>This is a real group-chat roster. Only these workers receive a turn or appear with sender labels in <strong>${escapeHtml(room.name)}</strong>.</p><span class="status-pill success">${room.memberIds.length} members</span></div><div class="member-manager-list">${rows}</div>`;
  }

  function settingsPanel() {
    const rows = state.workers.map((worker) => {
      const options = state.models.available.map((model) => `<option value="${escapeHtml(model.id)}" ${worker.model === model.id ? "selected" : ""}>${escapeHtml(model.name)} · ${escapeHtml(model.provider)}</option>`).join("");
      return `<div class="setting-row"><div><strong>${escapeHtml(worker.name)}</strong><small>${escapeHtml(worker.role)}</small></div><select class="model-select" data-model-worker="${escapeHtml(worker.id)}" aria-label="Model for ${escapeHtml(worker.name)}">${options}</select></div>`;
    }).join("");
    return `<div class="panel-intro"><p>Model routing and review policy are global operator controls. Routine ownership remains attached to individual agents and rooms.</p><span class="status-pill success">Router online</span></div><div class="settings-list"><section class="settings-section"><h3>Per-agent model routing</h3><p>Changes apply on the next agent turn.</p>${rows}</section><section class="settings-section"><div class="setting-row"><div><strong>Natural-language auto-review</strong><small>Keep external writes and irreversible actions behind a human gate.</small></div><button class="switch" type="button" id="auto-review-toggle" aria-pressed="${state.settings.autoReview.enabled}"></button></div><div class="field"><label for="auto-review-rule">Review rule</label><textarea id="auto-review-rule" rows="3">${escapeHtml(state.settings.autoReview.rule)}</textarea></div><div class="form-actions"><button class="primary-button" type="button" data-save-review>Save rule</button></div></section></div>`;
  }

  function addPanel() {
    const options = state.workers.map((worker) => `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.name)}</option>`).join("");
    return `<div class="panel-grid"><section class="panel-card"><div class="panel-card-header"><span class="panel-card-icon">♙</span><span class="status-pill">agent</span></div><h3>Create an agent</h3><p>An agent gets its own direct conversation, model, files, browser session, and routines.</p><form data-add-worker><div class="field"><label for="worker-name">Name</label><input id="worker-name" name="name" required placeholder="e.g. Finance Reviewer" /></div><div class="field"><label for="worker-role">Role</label><input id="worker-role" name="role" placeholder="What this agent owns" /></div><div class="form-actions"><button class="primary-button" type="submit">Create agent</button></div></form></section><section class="panel-card"><div class="panel-card-header"><span class="panel-card-icon">◌</span><span class="status-pill">room</span></div><h3>Create a room</h3><p>A room is a group chat with a truthful roster and its own shared routines, files, and browser context.</p><form data-add-room><div class="field"><label for="room-name-input">Name</label><input id="room-name-input" name="name" required placeholder="e.g. Finance close" /></div><div class="field"><label for="room-first-member">First member</label><select id="room-first-member" name="memberId">${options}</select></div><div class="form-actions"><button class="primary-button" type="submit">Create room</button></div></form></section></div>`;
  }

  function simplePanel(type) {
    const copy = {
      notifications: ["Recent activity", "Notifications", "Atera finished its previous ticket review. Context7 access is waiting for approval in MSP Team."],
      attachments: ["Current context", "Add files", `Attachments added here belong to ${contextName()}.`],
      context: [activeContext().kind === "worker" ? "Agent context" : "Room context", `${contextName()} options`, activeContext().kind === "worker" ? "Manage this agent’s profile, model, direct conversation, files, browser, and routines." : "Rename this room, manage its roster, and review room-owned routines."],
    }[type];
    openPanel(copy[0], copy[1], `<div class="panel-card"><h3>${escapeHtml(copy[1])}</h3><p>${escapeHtml(copy[2])}</p><div class="form-actions"><button class="primary-button" type="button" data-demo-action>Continue in prototype</button></div></div>`);
  }

  function renderDesktop(appName) {
    activeDesktopApp = appName || activeDesktopApp;
    const context = activeContext();
    const record = contextRecord();
    const lead = contextLead();
    elements.desktopTitle.textContent = context.kind === "worker" ? `${record.name}’s desktop` : `${record.name} · shared desktop`;
    elements.desktopLive.innerHTML = `<span class="status-dot ${lead && lead.status === "working" ? "working" : "ready"}"></span> ${escapeHtml(lead ? lead.name : record.name)} ${state.desktop.paused ? "is paused" : "is working"}`;
    document.querySelectorAll("[data-desktop-app]").forEach((button) => button.classList.toggle("active", button.dataset.desktopApp === activeDesktopApp));
    if (activeDesktopApp === "files") {
      const files = record.files.length ? record.files.map((file) => `<div class="file-tile">▱<strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.meta)}</small></div>`).join("") : `<div class="empty-state">No files in this context yet.</div>`;
      elements.desktopWindow.innerHTML = `<div class="files-view"><div class="browser-page-head"><div><h3>${escapeHtml(record.name)} files</h3><p>${context.kind === "worker" ? "Private agent working files." : "Files shared with this room."}</p></div><span class="status-pill">${context.kind === "worker" ? "agent" : "room"} context</span></div><div class="file-grid">${files}</div></div>`;
    } else if (activeDesktopApp === "sheets") {
      elements.desktopWindow.innerHTML = `<div class="sheets-view"><div class="browser-page-head"><div><h3>${escapeHtml(record.name)} working sheet</h3><p>Changes appear in this context’s run timeline.</p></div><span class="status-pill success">saved</span></div><div class="sheet-grid"><div class="sheet-row"><span>#</span><span>Task</span><span>Owner</span><span>Status</span></div><div class="sheet-row"><span>1</span><span>Review current state</span><span>${escapeHtml(lead ? lead.name : "Chief")}</span><span>Active</span></div><div class="sheet-row"><span>2</span><span>Return outcome</span><span>${escapeHtml(record.name)}</span><span>Queued</span></div></div></div>`;
    } else {
      elements.desktopWindow.innerHTML = `<div class="desktop-browser"><div class="browser-toolbar"><div class="browser-controls">‹ › ↻</div><div class="browser-address">${escapeHtml(record.browser.url)}</div><span>⋮</span></div><div class="browser-page"><div class="browser-page-head"><div><h3>${escapeHtml(record.browser.label)}</h3><p>${context.kind === "worker" ? `Browser session owned by ${escapeHtml(record.name)}.` : `Shared browser state for ${escapeHtml(record.name)}.`}</p></div><span class="status-pill ${context.kind === "room" ? "working" : "success"}">${context.kind === "room" ? "shared" : "private"}</span></div><table class="ticket-table"><thead><tr><th>Work item</th><th>Context</th><th>Priority</th><th>Status</th></tr></thead><tbody><tr><td>Current request</td><td>${escapeHtml(record.name)}</td><td class="priority-review">Review</td><td>In progress</td></tr><tr><td>Return outcome</td><td>Conversation</td><td>Normal</td><td>Queued</td></tr></tbody></table></div></div>`;
    }
    elements.desktopTimeline.innerHTML = state.desktop.timeline.map((item) => `<li class="${item.status === "pending" ? "is-pending" : ""}">${escapeHtml(item.label)}</li>`).join("");
    elements.pauseRun.textContent = state.desktop.paused ? "Resume" : "Pause";
  }

  function openDesktop(appName) {
    closeOpenDialogs(elements.desktopDialog);
    renderDesktop(appName);
    if (!elements.desktopDialog.open) elements.desktopDialog.showModal();
  }

  function openTeachMode() {
    const lead = contextLead();
    if (elements.desktopDialog.open) elements.desktopDialog.close();
    adapter.startTeaching(lead.id);
    elements.teachTitle.textContent = `${lead.name} is watching and learning`;
    elements.teachTimer.textContent = "00:00";
    elements.teachDialog.showModal();
    const startedAt = Date.now();
    window.clearInterval(teachInterval);
    teachInterval = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      elements.teachTimer.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
    }, 250);
  }

  function finishTeachMode() {
    window.clearInterval(teachInterval);
    teachInterval = null;
    const context = activeContext();
    const lead = contextLead();
    adapter.finishTeaching();
    elements.teachDialog.close();
    adapter.addMessage(context, { authorId: "you", authorName: "You", type: "text", text: "The recording is finished. Learn the task from it.", status: "sent" });
    adapter.addMessage(context, { authorId: lead.id, authorName: lead.name, type: "skill", text: "I’ve attached the recording to a new skill draft.", title: "Task learned from screen recording", description: `Analyzing actions and decision points inside ${contextName()}.` });
    showToast(`Recording handed to ${lead.name} as a skill draft`);
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
      else if (action.dataset.contextAction === "files") openDesktop("files");
      else if (action.dataset.contextAction === "members" && activeContext().kind === "room") openPanel("Room roster", `${contextName()} members`, membersPanel());
      else if (action.dataset.contextAction === "profile" && activeContext().kind === "worker") openPanel("Agent details", contextName(), agentProfilePanel(contextRecord()));
      return;
    }
    if (event.target.closest("[data-context-menu]")) simplePanel("context");
  }

  function handlePanelClick(event) {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.pluginId) {
      selectedPluginId = target.dataset.pluginId;
      renderPluginsPanel();
    } else if (target.dataset.installPlugin) {
      adapter.setPluginState(target.dataset.installPlugin, "installed");
      selectedPluginId = target.dataset.installPlugin;
      renderPluginsPanel();
      showToast("Plugin installed globally. Connect its account to enable tools.");
    } else if (target.dataset.toggleTool) {
      adapter.togglePluginTool(selectedPluginId, target.dataset.toggleTool);
      renderPluginsPanel();
    } else if (target.dataset.runRoutine) {
      const context = activeContext();
      const routineId = target.dataset.runRoutine;
      adapter.runRoutine(routineId).then((routine) => {
        adapter.addMessage(context, { authorId: routine.coordinatorId || routine.delegatedToId, authorName: (workerById(routine.coordinatorId || routine.delegatedToId) || {}).name || contextName(), type: "routine-result", text: `Tested ${routine.name}.`, title: routine.name, duration: routine.lastRun.duration });
        if (elements.panelDialog.open) renderRoutinesPanel();
        showToast(`✓ ${routine.name} passed in ${routine.lastRun.duration}`);
      });
      renderRoutinesPanel();
    } else if (target.hasAttribute("data-create-routine")) {
      showToast(`New routine will be attached to ${contextName()}`);
    } else if (target.dataset.manageMember && activeContext().kind === "room") {
      if (target.dataset.memberAction === "add") adapter.addMember(activeContext().id, target.dataset.manageMember);
      else adapter.removeMember(activeContext().id, target.dataset.manageMember);
      openPanel("Room roster", `${contextName()} members`, membersPanel());
    } else if (target.hasAttribute("data-save-review")) {
      const toggle = document.getElementById("auto-review-toggle");
      const rule = document.getElementById("auto-review-rule");
      adapter.setAutoReview(toggle.getAttribute("aria-pressed") === "true", rule.value);
      showToast("Global auto-review rule saved");
    } else if (target.id === "auto-review-toggle") {
      target.setAttribute("aria-pressed", target.getAttribute("aria-pressed") !== "true");
    } else if (target.hasAttribute("data-open-context-browser")) {
      openDesktop("browser");
    } else if (target.hasAttribute("data-demo-action")) {
      showToast("This control is mapped in the handoff adapter");
    }
  }

  function handlePanelChange(event) {
    const select = event.target.closest("[data-model-worker]");
    if (!select) return;
    adapter.setModel(select.dataset.modelWorker, select.value);
    const worker = workerById(select.dataset.modelWorker);
    const model = modelById(select.value);
    showToast(`${worker.name} will use ${model.name} on the next turn`);
  }

  function handlePanelSubmit(event) {
    const form = event.target;
    event.preventDefault();
    if (form.dataset.secretForm) {
      const input = form.elements.secret;
      const plugin = state.plugins.find((item) => item.id === form.dataset.secretForm);
      const result = adapter.submitSecret(plugin.id, plugin.secretField, input.value);
      input.value = "";
      if (result.accepted) {
        selectedPluginId = plugin.id;
        renderPluginsPanel();
        showToast(`${plugin.name} connected; the entered value was discarded by this demo`);
      }
    } else if (form.hasAttribute("data-add-worker")) {
      const data = new FormData(form);
      const worker = adapter.addWorker({ name: data.get("name"), role: data.get("role") });
      rosterMode = "workers";
      elements.panelDialog.close();
      showToast(`${worker.name} created with a direct conversation`);
    } else if (form.hasAttribute("data-add-room")) {
      const data = new FormData(form);
      const room = adapter.addRoom({ name: data.get("name"), memberIds: [data.get("memberId")] });
      rosterMode = "rooms";
      elements.panelDialog.close();
      showToast(`${room.name} room created`);
    }
  }

  adapter.subscribe((event) => {
    state = event.snapshot;
    renderAll(event.type === "worker:status" || event.type.startsWith("plugin:") || event.type.startsWith("settings:"));
    if (event.type === "desktop:pause") renderDesktop();
  });

  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.messageInput.value.trim();
    if (!text) return;
    const context = { ...activeContext() };
    adapter.sendMessage(context, text);
    elements.messageInput.value = "";
    simulateReply(context, text);
  });

  elements.rosterList.addEventListener("click", (event) => {
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
  elements.transcript.addEventListener("click", (event) => {
    const action = event.target.closest("[data-approval]");
    if (!action) return;
    adapter.decideApproval(activeContext(), action.dataset.messageId, action.dataset.approval);
    showToast(action.dataset.approval === "once" ? "Approved for this run only" : "Approval rule saved for Context7");
  });

  document.querySelectorAll("[data-capability]").forEach((button) => button.addEventListener("click", () => {
    const capability = button.dataset.capability;
    if (capability === "files") openDesktop("files");
    else if (capability === "browser") openDesktop("browser");
    else if (capability === "routines") renderRoutinesPanel();
    else if (capability === "plugins") renderPluginsPanel();
    else if (capability === "add") openPanel("Global creation", "Add to the Machine Room", addPanel());
  }));

  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => elements.panelDialog.close()));
  document.querySelectorAll("[data-close-desktop]").forEach((button) => button.addEventListener("click", () => elements.desktopDialog.close()));
  document.querySelectorAll("[data-desktop-app]").forEach((button) => button.addEventListener("click", () => renderDesktop(button.dataset.desktopApp)));
  elements.panelContent.addEventListener("click", handlePanelClick);
  elements.panelContent.addEventListener("change", handlePanelChange);
  elements.panelContent.addEventListener("submit", handlePanelSubmit);

  document.getElementById("settings-button").addEventListener("click", () => openPanel("Global router & policy", "Operator settings", settingsPanel()));
  document.getElementById("shelf-settings").addEventListener("click", () => openPanel("Global router & policy", "Operator settings", settingsPanel()));
  document.getElementById("people-button").addEventListener("click", () => {
    if (activeContext().kind === "room") openPanel("Room roster", `${contextName()} members`, membersPanel());
    else openPanel("Agent details", contextName(), agentProfilePanel(contextRecord()));
  });
  document.getElementById("notifications-button").addEventListener("click", () => simplePanel("notifications"));
  document.getElementById("room-menu").addEventListener("click", () => simplePanel("context"));
  document.getElementById("composer-plus").addEventListener("click", () => simplePanel("attachments"));
  document.getElementById("open-desktop").addEventListener("click", () => openDesktop("browser"));
  elements.scheduleButton.addEventListener("click", renderRoutinesPanel);
  document.getElementById("teach-button").addEventListener("click", openTeachMode);
  document.getElementById("finish-teach").addEventListener("click", finishTeachMode);
  document.getElementById("pause-run").addEventListener("click", () => {
    adapter.setRunPaused(!state.desktop.paused);
    showToast(state.desktop.paused ? "Context run paused" : "Context run resumed");
  });
  document.getElementById("dismiss-now").addEventListener("click", () => elements.nowIsland.classList.add("is-dismissed"));
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

  [elements.panelDialog, elements.desktopDialog, elements.teachDialog].forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }));
  elements.teachDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishTeachMode();
  });

  countdownInterval = window.setInterval(renderNowAndSchedule, 30_000);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(countdownInterval);
    window.clearInterval(teachInterval);
    adapter.destroy();
  });

  renderAll(false);
  renderDesktop("browser");
})();
