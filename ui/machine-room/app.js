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
      ? `Agent · ${lead ? lead.statusText : "unknown"}`
      : `Room · ${members.length} ${members.length === 1 ? "member" : "members"}`;
    elements.messageInput.placeholder = `Ask ${name}…`;
    elements.participantCluster.innerHTML = members.slice(0, 4).map((worker) => avatarMarkup(worker, "participant-avatar", worker.name)).join("");
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
        : `Closed by the host — ${card.status}`;
      const accent = card.status === "approved" ? "var(--green-500)" : "var(--amber-500)";
      return `<div class="inline-card" style="--card-accent:${accent}"><div class="inline-card-header"><span class="inline-card-icon">${card.status === "approved" ? "✓" : "✕"}</span><span class="inline-card-copy"><strong>${escapeHtml(card.title)}</strong><small class="approval-result">${escapeHtml(settled)}</small></span></div></div>`;
    }
    const button = (value, label, primary) => `<button class="card-action${primary ? " primary" : ""}" type="button" data-decide="${escapeHtml(String(value))}" data-message-id="${escapeHtml(message.id)}">${escapeHtml(label)}</button>`;
    const actions = DECISION_ACTIONS[card.kind]
      ? DECISION_ACTIONS[card.kind].map(([v, l, p]) => button(v, l, p)).join("")
      : card.kind === "widget"
        ? ((card.options ?? []).length ? card.options : ["Yes", "No"]).map((option, index) => {
            const value = typeof option === "string" ? option : (option.value ?? option.label ?? String(index));
            const label = typeof option === "string" ? option : (option.label ?? option.value ?? String(index));
            return button(value, label, index === 0);
          }).join("")
        : `<span class="field-hint">Answer this in the host app. This UI never carries a credential.</span>`;
    return `<div class="inline-card" style="--card-accent:var(--amber-500)"><div class="inline-card-header"><span class="inline-card-icon">▣</span><span class="inline-card-copy"><strong>${escapeHtml(card.title)}</strong><small>${escapeHtml(card.detail || "The agent is blocked until you answer.")}</small></span></div>${card.rule ? `<div class="tag-list"><span class="tag">would add rule · ${escapeHtml(card.rule)}</span></div>` : ""}<div class="inline-card-actions">${actions}</div></div>`;
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
    const body = isWorking ? `<div class="typing-dots" aria-label="${escapeHtml(message.authorName)} is working"><i></i><i></i><i></i></div>` : `${paragraphMarkup(message.text)}${specialMessageMarkup(message)}`;
    return `<article class="message-row${isUser ? " is-user" : ""}${isWorking ? " working-message" : ""}" data-message-id="${escapeHtml(message.id)}">${!isUser ? avatarMarkup(author, "message-avatar") : ""}<div class="message-block"><div class="message-meta"><strong>${escapeHtml(message.authorName || (author && author.name) || "Worker")}</strong><time>${escapeHtml(message.time || "now")}</time></div><div class="message-bubble">${body}</div></div></article>`;
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
      const paused = routine.status === "paused";
      const RUN_LABEL = { passed: "✓ Last run succeeded", running: "● Running now…", failed: "✕ Last run failed", dispatched: "→ Dispatched · outcome not reported yet", unknown: "· Last run outcome not reported" };
      const lastResult = routine.lastRun
        ? `<div class="run-result">${escapeHtml(RUN_LABEL[routine.lastRun.status] ?? RUN_LABEL.unknown)}${routine.lastRun.duration ? ` · ${escapeHtml(routine.lastRun.duration)}` : ""}</div>`
        : `<div class="run-result">Never run</div>`;
      // Pause, edit and delete are setAgentAutomationEnabled / updateAgentAutomation /
      // deleteAgentAutomation on the gateway. The card had a Test run button and nothing else, so
      // a routine written here could only ever be run, never stopped or corrected.
      const controls = `<button class="primary-button" type="button" data-run-routine="${escapeHtml(routine.id)}" ${running ? "disabled" : ""}>${running ? "Running…" : "Test run"}</button><button class="ghost-button" type="button" data-toggle-routine="${escapeHtml(routine.id)}" data-routine-paused="${paused}">${paused ? "Resume" : "Pause"}</button><button class="ghost-button" type="button" data-edit-routine="${escapeHtml(routine.id)}">Edit</button><button class="ghost-button" type="button" data-delete-routine="${escapeHtml(routine.id)}">Delete</button>`;
      return `<article class="routine-card"><div><div class="routine-header"><h3>${escapeHtml(routine.name)}</h3><span class="status-pill ${running ? "working" : paused ? "" : "success"}">${escapeHtml(running ? "running" : routine.status)}</span></div><p>${escapeHtml(routine.instruction)}</p><div class="routine-meta"><span class="tag">◷ ${escapeHtml(routine.trigger)}</span><span class="tag">attached · ${escapeHtml(routineScopeLabel(routine))}</span>${coordinator ? `<span class="tag">coordinates · ${escapeHtml(coordinator.name)}</span>` : ""}${delegate ? `<span class="tag">runs as · ${escapeHtml(delegate.name)}</span>` : ""}</div>${routine.nextRunAt ? `<div class="run-result">Next run in ${escapeHtml(formatCountdown(routine.nextRunAt))}</div>` : ""}${lastResult}</div><div style="display:grid;gap:6px;align-content:start">${controls}</div></article>`;
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

  function pluginDetailMarkup(plugin) {
    if (!plugin) return `<div class="empty-state">Choose a plugin to inspect its tools and account.</div>`;
    // A tool row carries a switch only where the write exists. Where it does not, the row says
    // what the host holds and the section says why it cannot be changed from here.
    const toolRow = (tool) => `<div class="tool-row"><div><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.description)}</small></div>${tool.togglable === false
      ? `<span class="status-pill${tool.enabled ? " success" : ""}">${tool.enabled ? "enabled" : "disabled"}</span>`
      : `<button class="switch" type="button" data-toggle-tool="${escapeHtml(tool.id)}" aria-label="Toggle ${escapeHtml(tool.name)}" aria-pressed="${tool.enabled}"></button>`}</div>`;
    const tools = plugin.tools.length
      ? plugin.tools.map(toolRow).join("") + (plugin.toolsReadOnlyNote ? `<span class="field-hint">${escapeHtml(plugin.toolsReadOnlyNote)}</span>` : "")
      : `<div class="empty-state">${escapeHtml(plugin.toolsNote || "No tools are reported for this plugin.")}</div>`;
    let account;
    // A card the host cannot connect gets no button. Clicking it ran getListenerConnectUrl with a
    // subscription id, which always errors -- behind a success toast fired before the answer came.
    if (plugin.status === "available" && plugin.connectable === false) account = `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Not connectable from here</strong><small>${escapeHtml(plugin.connectNote || `This host has no connect flow for ${plugin.name}.`)}</small></div></div></div>`;
    else if (plugin.status === "available") account = `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Connect ${escapeHtml(plugin.name)}</strong><small>Opens ${escapeHtml(plugin.name)}'s own authorisation page. The credential is exchanged there and stored by the host — it never passes through this page.</small></div></div><div class="form-actions"><button class="primary-button" type="button" data-install-plugin="${escapeHtml(plugin.id)}">Connect ${escapeHtml(plugin.name)}</button></div></div>`;
    else if (plugin.status === "pending") account = `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Awaiting authorisation</strong><small>Finish approving ${escapeHtml(plugin.name)} in the tab that opened, then reopen this panel.</small></div></div></div>`;
    else if (plugin.status === "installed") account = `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Secure value required</strong><small>Scoped to ${escapeHtml(plugin.name)} · ${escapeHtml(plugin.secretField)}. It never enters chat or model context.</small></div></div><form data-secret-form="${escapeHtml(plugin.id)}"><div class="field"><label for="secret-${escapeHtml(plugin.id)}">${escapeHtml(plugin.secretField)}</label><input id="secret-${escapeHtml(plugin.id)}" name="secret" type="password" autocomplete="off" required placeholder="Enter securely" /><span class="field-hint">${escapeHtml(plugin.secretHint || demoSecretNote)}</span></div><div class="form-actions"><button class="primary-button" type="submit">Connect account</button></div></form></div>`;
    else account = `<div class="demo-note"><strong>${escapeHtml(plugin.account || (plugin.group === "Providers" ? "Adopted on this Mac" : "Connected"))}</strong><br />${escapeHtml(plugin.connectedNote || "The host holds this connection. Contexts receive its capabilities, never the credential.")}</div>`;
    const providerSwitch = plugin.endpointId
      ? `<div class="provider-switch">${plugin.live ? `<span class="status-pill success">answering now</span>` : plugin.status === "connected" ? `<button class="primary-button" type="button" data-use-endpoint="${escapeHtml(plugin.endpointId)}">Use this endpoint</button>` : ""}</div>`
      : "";
    // The Skills section was a heading over an empty div on every card the gateway builds: no
    // plugin here ships skills. It renders only where there are some, or where there is a reason.
    const skillsSection = plugin.skills.length
      ? `<section><div class="plugin-section-title"><span>Skills in package</span></div><div class="tag-list">${plugin.skills.map((skill) => `<span class="tag">✦ ${escapeHtml(skill)}</span>`).join("")}</div></section>`
      : plugin.skillsNote ? `<section><div class="plugin-section-title"><span>Skills in package</span></div><div class="empty-state">${escapeHtml(plugin.skillsNote)}</div></section>` : "";
    return `<div class="plugin-hero"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><div class="plugin-hero-copy"><h3>${escapeHtml(plugin.name)}</h3><p>${escapeHtml(plugin.description)}</p></div><span class="status-pill ${plugin.status === "connected" ? "success" : ""}">${escapeHtml(pluginStatusLabel(plugin.status))}</span></div><div class="plugin-sections"><section><div class="plugin-section-title"><span>${plugin.group === "Providers" ? "Provider account" : "Global account"}</span><span>${escapeHtml(plugin.category)}</span></div>${account}${providerSwitch}</section><section><div class="plugin-section-title"><span>Tools available for assignment</span>${plugin.tools.length ? `<span>${plugin.tools.filter((tool) => tool.enabled).length}/${plugin.tools.length} enabled</span>` : ""}</div><div class="plugin-list">${tools}</div></section>${skillsSection}</div>`;
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
    return draftTriggers.map((t, i) => {
      const problem = triggerProblem(t);
      return `<div class="panel-card" style="${problem ? "outline:1px solid var(--amber-500)" : ""}"><div class="setting-row"><select data-trig="${i}" data-trig-field="type">${TRIGGER_KINDS.map(([v, l]) => `<option value="${v}" ${t.type === v ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select>${draftTriggers.length > 1 ? `<button class="ghost-button" type="button" data-drop-trigger="${i}">Remove</button>` : ""}</div>${triggerFields(t, i)}${problem ? `<span class="field-hint">${escapeHtml(problem)} — the host accepts an incomplete trigger and then never fires it.</span>` : ""}</div>`;
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

  function renderPluginsPanel() {
    const selected = state.plugins.find((plugin) => plugin.id === selectedPluginId) || state.plugins[0];
    // This host reports its connectors through getListenerIntegrations, and a box with none
    // returns an empty list. Reaching for plugins[0] threw and left the panel blank with no
    // explanation -- an empty capability set is a normal state, not an error.
    if (!selected) {
      openPanel("Global capabilities", "Plugins, connectors & skills",
        `<div class="panel-intro"><p>Providers are the endpoints this box can answer through. Connectors are MCP servers the box runs; their tools are listed as the host discovers them. Listeners are chat platforms the host binds to.</p><span class="status-pill">none installed</span></div><div class="empty-state">This box has no providers, connectors or listeners yet. Connectors are added to connectors.json on the box, not from this page; a provider appears here once its CLI holds a login on this Mac or it takes a pasted key.</div>`);
      return;
    }
    selectedPluginId = selected.id;
    const navButton = (plugin) => `<button class="plugin-nav-button${plugin.id === selected.id ? " is-active" : ""}" type="button" data-plugin-id="${escapeHtml(plugin.id)}"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><span><strong>${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.category)}</small></span><span class="status-dot ${plugin.status === "connected" ? "success" : plugin.status === "installed" ? "attention" : ""}"></span></button>`;
    // Providers (subscriptions and endpoints a user connects) lead; the box's own MCP connectors
    // follow; the chat listeners the host reports come last. Anything without a group is a
    // connector, which is what the demo fixtures are.
    const GROUPS = ["Providers", "Connectors", "Listeners"];
    const nav = GROUPS.map((group) => {
      const members = state.plugins.filter((plugin) => (plugin.group ?? "Connectors") === group);
      return members.length ? `<div class="plugin-group-title">${group}</div>${members.map(navButton).join("")}` : "";
    }).join("");
    openPanel("Global capabilities", "Plugins, connectors & skills", `<div class="panel-intro"><p>Providers are the endpoints this box can answer through. Connectors are MCP servers the box runs; their tools are listed as the host discovers them. Listeners are chat platforms the host binds to.</p><span class="status-pill success">global</span></div><div class="plugin-browser"><aside class="plugin-sidebar">${nav}</aside><section class="plugin-detail">${pluginDetailMarkup(selected)}</section></div>`);
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
    const canReadMemories = typeof adapter.getMemories === "function";
    const role = `<div class="setting-row"><div><strong>Role</strong><small>The host's own per-agent title, stored on this agent's profile file. Blank is a real answer — the context card hides the row rather than printing the words 'not set'.</small></div><div class="field" style="margin:0;min-width:220px"><label class="sr-only" for="agent-role">Role</label><input id="agent-role" data-role-for="${escapeHtml(worker.id)}" value="${escapeHtml(worker.role)}"${canWriteRole ? "" : " readonly"} placeholder="e.g. Service desk specialist" /></div>${canWriteRole ? `<button class="ghost-button" type="button" data-save-role="${escapeHtml(worker.id)}">Save</button>` : `<span class="status-pill">read-only offline</span>`}</div>`;
    const browser = `<div class="setting-row"><div><strong>Browser</strong><small data-browser-screen="${escapeHtml(worker.id)}">${escapeHtml(worker.browser.screen || "Asking the host which screen this agent has…")}</small></div><button class="ghost-button" type="button" data-open-context-browser>Open</button></div>`;
    const memories = canReadMemories
      ? `<section class="settings-section" data-memories-for="${escapeHtml(worker.id)}"><div class="setting-row"><div><strong>Memory</strong><small>What the host has remembered about this agent across conversations.</small></div>${typeof adapter.clearMemories === "function" ? `<button class="ghost-button" type="button" data-clear-memories="${escapeHtml(worker.id)}">Forget all</button>` : ""}</div><div class="context-detail-list" data-memory-list>Reading this agent's memories…</div></section>`
      : "";
    return `<div class="panel-grid"><section class="panel-card"><div class="panel-card-header">${avatarMarkup(worker, "context-profile-avatar")}<span class="status-pill ${worker.status === "working" ? "working" : worker.status === "attention" ? "" : "success"}">${escapeHtml(worker.statusText)}</span></div><h3>${escapeHtml(worker.name)}</h3><p>${escapeHtml(worker.role || "No role set on the host.")}</p><div class="tag-list"><span class="tag">endpoint (box-wide) · ${escapeHtml(model ? model.name : worker.model)}</span><span class="tag">${worker.files.length} files</span><span class="tag">${routines.length} routines</span></div></section><section class="settings-section"><h3>Agent-owned context</h3><p>The direct transcript, the role and the routines shown here belong to this agent. The endpoint and the box's screens belong to the whole box and are shared with every other agent on it.</p>${role}<div class="setting-row"><div><strong>Direct conversation</strong><small>Operator-to-agent thread</small></div><span class="status-pill ${worker.status === "working" ? "working" : ""}">${escapeHtml(worker.statusText)}</span></div>${browser}</section>${memories}</div>`;
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

  function settingsPanel() {
    // Per-agent routing does not exist on this host: updateAgent takes only name, description and
    // title, and the model is resolved globally from box-secrets.json on every request. A picker
    // per worker promised something the machine cannot do. One endpoint, switchable, is the truth.
    const rows = `<div class="setting-row"><div><strong>Endpoint</strong><small>Every worker and every subagent on this box answers through this one. Switching takes effect on the next turn.</small></div><select class="model-select" id="endpoint-select" aria-label="Inference endpoint"><option value="">Loading…</option></select></div><div class="setting-row"><div><strong>Currently answering</strong><small id="endpoint-current">Reading from the box…</small></div><span class="status-pill" id="endpoint-health">…</span></div>`;
    return `<div class="panel-intro"><p>Inference and review policy are global on this host. Routines stay attached to individual agents and rooms.</p><span class="status-pill${state.settings.reachable ? " success" : ""}">${state.settings.reachable ? "Host settings loaded" : "Host settings unreachable"}</span></div><div class="settings-list"><section class="settings-section"><h3>Inference</h3><p>This host routes every agent through a single endpoint. Per-agent models are not something it can do.</p>${rows}</section><section class="settings-section"><div class="setting-row"><div><strong>Natural-language auto-review</strong><small>${state.settings.autoReview.enabled ? "Armed. The host checks each action against the instructions below." : "Off. Every tool an agent holds runs without review."}</small></div><button class="switch" type="button" id="auto-review-toggle" aria-pressed="${state.settings.autoReview.enabled}"></button></div><div class="field"><label for="auto-review-rule">Ask me before…</label><textarea id="auto-review-rule" rows="3" placeholder="e.g. sending email, deleting anything, spending money">${escapeHtml((state.settings.autoReview.block ?? []).join("\n"))}</textarea></div>${(state.settings.autoReview.allow ?? []).length ? `<div class="setting-row"><div><strong>Always allowed</strong><small>${escapeHtml((state.settings.autoReview.allow ?? []).join("; "))}</small></div></div>` : ""}${state.settings.localToolPermission ? `<div class="setting-row"><div><strong>Local tool permission</strong><small>The host is set to "${escapeHtml(state.settings.localToolPermission)}" for tools that run on this machine.</small></div><span class="status-pill">${escapeHtml(state.settings.localToolPermission)}</span></div>` : ""}<div class="form-actions"><button class="primary-button" type="button" data-save-review>Save policy</button></div></section></div>`;
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

    const SHARED = "http://127.0.0.1:6080/vnc_lite.html?autoconnect=1&resize=scale&reconnect=1";
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
      elements.desktopWindow.innerHTML = `<div class="files-view"><div class="browser-page-head"><div><h3>${escapeHtml(record.name)} files</h3><p>Files that passed through this conversation. This host keeps no per-worker directory — anything a worker writes with Shell goes to one /workspace shared by every agent on the box.</p></div><span class="status-pill">${record.files.length}</span></div><div class="file-grid">${files}</div></div>`;
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
    // The host does not expose per-step run progress, so inventing four ticks would be the same
    // fiction as the fixture it replaced. Say what is known: working, or not.
    elements.desktopTimeline.innerHTML = working
      ? `<li>Started — no step detail from this host</li>`
      : `<li class="is-pending">Nothing running for this worker</li>`;
    // Naming it honestly: this hides the view, it does not stop the worker. There is no host
    // command to halt a turn in flight, and a button labelled Pause promises exactly that.
    elements.pauseRun.textContent = state.desktop.paused ? "Resume view" : "Pause view";
    elements.pauseRun.title = "Pauses this view only. The worker keeps running — this host has no command to stop a turn.";
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
    // The dialog used to draw a fake ticket queue. Show the screen actually being recorded.
    ensureDesktop(worker.id).then((desk) => {
      const live = document.getElementById("teach-live");
      if (live) live.innerHTML = `<iframe src="${escapeHtml(desk.url)}" title="The screen being recorded" style="width:100%;height:100%;border:0;background:#0b0f13"></iframe>`;
    }).catch(() => {});
    const cap = Number(maxDurationMs) > 0 ? ` / ${clockText(Number(maxDurationMs))}` : "";
    const tick = () => { elements.teachTimer.textContent = `${clockText(Date.now() - startedAt)}${cap}`; };
    tick();
    if (!elements.teachDialog.open) elements.teachDialog.showModal();
    window.clearInterval(teachInterval);
    teachInterval = window.setInterval(tick, 250);
  }

  function openTeachMode() {
    const lead = contextLead();
    adapter.startTeaching(lead.id);
    showTeachDialog(lead, state.teaching?.startedAt ?? Date.now(), state.teaching?.maxDurationMs);
  }

  // MR-14: the adapter seeds state.teaching from getTeachRecordingStatus and nothing read it, so a
  // recording still running on the host was invisible after a reload -- and the only way back into
  // the dialog was the button, which starts a second one.
  function resumeTeachMode() {
    const teaching = state.teaching;
    if (!teaching?.active || !teaching.workerId) return;
    const worker = workerById(teaching.workerId);
    if (!worker) return;
    showTeachDialog(worker, Number(teaching.startedAt) || Date.now(), teaching.maxDurationMs);
    showToast(`${worker.name} is still recording — this is the run the host already has open.`);
  }

  function finishTeachMode() {
    window.clearInterval(teachInterval);
    teachInterval = null;
    const context = activeContext();
    const lead = contextLead();
    const note = document.getElementById("teach-note");
    adapter.finishTeaching(true, note ? note.value.trim() : "");
    if (note) note.value = "";
    elements.teachDialog.close();
    showToast(`Recording saved — ${lead.name} is learning from it now.`);
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
      renderPluginsPanel();
    } else if (target.dataset.installPlugin) {
      selectedPluginId = target.dataset.installPlugin;
      // The toast used to fire before the host had answered, on a call that for some cards always
      // fails. It now reports whatever the adapter resolved with.
      Promise.resolve(adapter.setPluginState(target.dataset.installPlugin, "connect"))
        .then((result) => { if (typeof result === "string") showToast(result); })
        .catch((error) => showToast(`Could not connect that plugin: ${error.message}`));
      renderPluginsPanel();
    } else if (target.dataset.toggleTool) {
      adapter.togglePluginTool(selectedPluginId, target.dataset.toggleTool);
      renderPluginsPanel();
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
      const input = elements.panelContent.querySelector(`[data-role-for="${CSS.escape(target.dataset.saveRole)}"]`);
      // The adapter reads the saved profile back, so this reports the host's title and not the box.
      adapter.setRole(target.dataset.saveRole, input ? input.value : "")
        .then((role) => showToast(role ? `Role saved as “${role}”` : "Role cleared on the host"))
        .catch((error) => showToast(`Role not saved: ${error.message}`));
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
    renderAll(event.type === "worker:status" || event.type.startsWith("plugin:") || event.type.startsWith("settings:"));
    if (event.type === "desktop:pause") renderDesktop();
  });

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
    const evidence = event.target.closest("[data-evidence]");
    if (evidence) { openEvidenceViewer(evidence.dataset.messageId); return; }
    const exchange = event.target.closest("[data-exchange]");
    if (exchange) { openExchangeViewer(exchange.dataset.messageId); return; }
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
    else if (capability === "plugins") renderPluginsPanel();
    else if (capability === "add") openPanel("Global creation", "Add to the Machine Room", addPanel());
  }));

  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => elements.panelDialog.close()));
  document.querySelectorAll("[data-close-desktop]").forEach((button) => button.addEventListener("click", () => elements.desktopDialog.close()));
  document.querySelectorAll("[data-desktop-app]").forEach((button) => button.addEventListener("click", () => renderDesktop(button.dataset.desktopApp)));
  elements.panelContent.addEventListener("click", handlePanelClick);
  elements.panelContent.addEventListener("input", handleTriggerInput);
  elements.panelContent.addEventListener("change", handleTriggerInput);
  elements.panelContent.addEventListener("submit", handlePanelSubmit);

  document.getElementById("settings-button").addEventListener("click", () => { openPanel("Global router & policy", "Operator settings", settingsPanel()); fillEndpoints(); });
  document.getElementById("shelf-settings").addEventListener("click", () => { openPanel("Global router & policy", "Operator settings", settingsPanel()); fillEndpoints(); });
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
    tray.innerHTML = pendingAttachments.map((a, i) =>
      `<span class="tag">▱ ${escapeHtml(a.name)}${a.pending ? " · uploading…" : ""}<button class="member-remove" type="button" data-drop-attachment="${i}" aria-label="Remove ${escapeHtml(a.name)}">×</button></span>`).join("");
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

  document.getElementById("composer-file").addEventListener("change", async (event) => {
    const context = activeContext();
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    for (const file of files) {
      // The host reads attachments back in 8MB chunks; refuse anything larger here rather than
      // after a long base64 round trip that fails at the far end.
      if (file.size > 8 * 1024 * 1024) { showToast(`${file.name} is larger than 8MB — the host will not take it.`); continue; }
      const entry = { name: file.name, path: null, pending: true };
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
  });
  document.getElementById("open-desktop").addEventListener("click", () => openDesktop("browser"));
  elements.scheduleButton.addEventListener("click", renderRoutinesPanel);
  document.getElementById("teach-button").addEventListener("click", openTeachMode);
  document.getElementById("finish-teach").addEventListener("click", finishTeachMode);
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
  resumeTeachMode();
})();
