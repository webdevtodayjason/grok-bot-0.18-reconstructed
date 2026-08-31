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
    if (message.type === "system") return `<article class="message-row is-system" data-message-id="${escapeHtml(message.id)}"><div class="message-bubble">${escapeHtml(message.text)}</div></article>`;
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
      const RUN_LABEL = { passed: "✓ Last run succeeded", running: "● Running now…", failed: "✕ Last run failed", dispatched: "→ Dispatched · outcome not reported yet", unknown: "· Last run outcome not reported" };
      const lastResult = routine.lastRun
        ? `<div class="run-result">${escapeHtml(RUN_LABEL[routine.lastRun.status] ?? RUN_LABEL.unknown)}${routine.lastRun.duration ? ` · ${escapeHtml(routine.lastRun.duration)}` : ""}</div>`
        : `<div class="run-result">Never run</div>`;
      return `<article class="routine-card"><div><div class="routine-header"><h3>${escapeHtml(routine.name)}</h3><span class="status-pill ${running ? "working" : routine.status === "paused" ? "" : "success"}">${escapeHtml(running ? "running" : routine.status)}</span></div><p>${escapeHtml(routine.instruction)}</p><div class="routine-meta"><span class="tag">◷ ${escapeHtml(routine.trigger)}</span><span class="tag">attached · ${escapeHtml(routineScopeLabel(routine))}</span>${coordinator ? `<span class="tag">coordinates · ${escapeHtml(coordinator.name)}</span>` : ""}${delegate ? `<span class="tag">runs as · ${escapeHtml(delegate.name)}</span>` : ""}</div>${routine.nextRunAt ? `<div class="run-result">Next run in ${escapeHtml(formatCountdown(routine.nextRunAt))}</div>` : ""}${lastResult}</div><div><button class="primary-button" type="button" data-run-routine="${escapeHtml(routine.id)}" ${running ? "disabled" : ""}>${running ? "Running…" : "Test run"}</button></div></article>`;
    }).join("") : `<div class="empty-state"><div><strong>No routines attached to ${escapeHtml(name)}</strong><p>Create one here and it will belong to this ${context.kind === "worker" ? "agent" : "room"}—not to the whole system.</p></div></div>`;
    return `<div class="panel-intro"><p>These routines belong only to <strong>${escapeHtml(name)}</strong>. ${context.kind === "room" ? "A room routine can coordinate several members and delegate its execution step." : "An agent routine runs in this agent’s own context."}</p><details class="routine-create"><summary class="secondary-button">＋ New routine</summary><form data-new-routine><div class="field"><label for="routine-name">Name</label><input id="routine-name" name="name" required placeholder="e.g. Morning ticket sweep" /></div><div class="field"><label for="routine-prompt">What it should do</label><textarea id="routine-prompt" name="prompt" rows="3" required placeholder="Written as if you were asking in chat"></textarea></div><div class="field"><label>Triggers</label><div id="trigger-stack">${triggerStackMarkup()}</div></div><div class="form-actions"><button class="primary-button" type="submit">Create routine</button></div></form></details></div><div class="routine-list">${cards}</div>`;
  }

  function renderRoutinesPanel() {
    openPanel(activeContext().kind === "worker" ? "Agent routines" : "Room routines", `${contextName()} routines`, routinesPanel());
  }

  function pluginStatusLabel(status) {
    return status === "connected" ? "connected" : status === "installed" ? "needs account" : "available";
  }

  function pluginDetailMarkup(plugin) {
    if (!plugin) return `<div class="empty-state">Choose a plugin to inspect its tools and account.</div>`;
    const tools = plugin.tools.length
      ? plugin.tools.map((tool) => `<div class="tool-row"><div><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.description)}</small></div><button class="switch" type="button" data-toggle-tool="${escapeHtml(tool.id)}" aria-label="Toggle ${escapeHtml(tool.name)}" aria-pressed="${tool.enabled}"></button></div>`).join("")
      : `<div class="empty-state">This host reports which connectors are attached, but not which tools they expose — so there is nothing to grant or revoke here. The gate that does apply is the review policy in Settings.</div>`;
    const skills = plugin.skills.map((skill) => `<span class="tag">✦ ${escapeHtml(skill)}</span>`).join("");
    let account;
    if (plugin.status === "available") account = `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Connect ${escapeHtml(plugin.name)}</strong><small>Opens ${escapeHtml(plugin.name)}'s own authorisation page. The credential is exchanged there and stored by the host — it never passes through this page.</small></div></div><div class="form-actions"><button class="primary-button" type="button" data-install-plugin="${escapeHtml(plugin.id)}">Connect ${escapeHtml(plugin.name)}</button></div></div>`;
    else if (plugin.status === "installed") account = `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Awaiting authorisation</strong><small>Finish approving ${escapeHtml(plugin.name)} in the tab that opened, then reopen this panel.</small></div></div></div>`;
    else if (plugin.status === "installed") account = `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Secure value required</strong><small>Scoped to ${escapeHtml(plugin.name)} · ${escapeHtml(plugin.secretField)}. It never enters chat or model context.</small></div></div><form data-secret-form="${escapeHtml(plugin.id)}"><div class="field"><label for="secret-${escapeHtml(plugin.id)}">${escapeHtml(plugin.secretField)}</label><input id="secret-${escapeHtml(plugin.id)}" name="secret" type="password" autocomplete="off" required placeholder="Enter securely" /><span class="field-hint">Standalone demo: the entered value is immediately discarded.</span></div><div class="form-actions"><button class="primary-button" type="submit">Connect account</button></div></form></div>`;
    else account = `<div class="demo-note"><strong>${escapeHtml(plugin.account || "Connected account")}</strong><br />The connector holds the credential globally. Contexts receive enabled capabilities, never the key.</div>`;
    return `<div class="plugin-hero"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><div class="plugin-hero-copy"><h3>${escapeHtml(plugin.name)}</h3><p>${escapeHtml(plugin.description)}</p></div><span class="status-pill ${plugin.status === "connected" ? "success" : ""}">${escapeHtml(pluginStatusLabel(plugin.status))}</span></div><div class="plugin-sections"><section><div class="plugin-section-title"><span>Global account</span><span>${escapeHtml(plugin.category)}</span></div>${account}</section><section><div class="plugin-section-title"><span>Tools available for assignment</span><span>${plugin.tools.filter((tool) => tool.enabled).length}/${plugin.tools.length} enabled</span></div><div class="plugin-list">${tools}</div></section><section><div class="plugin-section-title"><span>Skills in package</span></div><div class="tag-list">${skills}</div></section></div>`;
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

  let draftTriggers = [{ type: "cron", schedule: "0 8 * * 1-5" }];

  // Ported from the old operator UI. Each rule is a field the host needs and will not complain
  // about: an incomplete trigger is accepted and then never fires, which is the worst outcome.
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
      if ((t.events ?? []).some((e) => e.startsWith("ci-")) && !String(t.ciBranch ?? "").trim()) return "CI events need a branch";
      return null;
    }
    if (t.type === "slack") {
      if (!String(t.channel ?? "").trim()) return "needs a channel, or * for anywhere";
      return null;
    }
    if (t.type === "microsoftTeams") {
      if (!String(t.tenantId ?? "").trim()) return "needs a tenant id";
      if (!String(t.teamId ?? "").trim()) return "needs a team id";
      return null;
    }
    if (t.type === "linear" && !String(t.teamKey ?? "").trim()) return "needs a Linear team key";
    if (t.type === "sentry" && !String(t.project ?? "").trim()) return "needs a Sentry project";
    if (t.type === "pagerduty" && !String(t.service ?? "").trim()) return "needs a PagerDuty service";
    return null;
  }

  function triggerFields(t, i) {
    const box = (name, label, value, hint) =>
      `<div class="field"><label for="trig-${i}-${name}">${escapeHtml(label)}</label><input id="trig-${i}-${name}" data-trig="${i}" data-trig-field="${name}" value="${escapeHtml(String(value ?? ""))}" placeholder="${escapeHtml(hint ?? "")}" /></div>`;
    if (t.type === "cron") return box("schedule", "Cron expression", t.schedule, "0 8 * * 1-5");
    if (t.type === "slack") return box("channel", "Channel", t.channel, "#support or * for anywhere") + box("keyword", "Only when it mentions (optional)", t.keyword, "");
    if (t.type === "github") return box("repo", "Repository", t.repo, "owner/repo")
      + `<div class="field"><label>Events</label><div class="tag-list">${GITHUB_EVENTS.map(([v, l]) => `<label class="tag"><input type="checkbox" data-trig="${i}" data-trig-event="${v}" ${(t.events ?? []).includes(v) ? "checked" : ""} /> ${escapeHtml(l)}</label>`).join("")}</div></div>`
      + ((t.events ?? []).some((e) => e.startsWith("ci-")) ? box("ciBranch", "CI branch", t.ciBranch, "main") : "");
    if (t.type === "linear") return box("teamKey", "Team key", t.teamKey, "ENG");
    if (t.type === "sentry") return box("project", "Project", t.project, "grok-bot");
    if (t.type === "pagerduty") return box("service", "Service", t.service, "production");
    if (t.type === "microsoftTeams") return box("tenantId", "Tenant id", t.tenantId, "") + box("teamId", "Team id", t.teamId, "");
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
        `<div class="panel-intro"><p>Plugins are installed once for the Machine Room. Their individual tools can then be granted to agents or rooms through policy.</p><span class="status-pill">none installed</span></div><div class="empty-state">This host reports no connectors. When it has some, connecting one opens that platform\u2019s own authorisation page.</div>`);
      return;
    }
    selectedPluginId = selected.id;
    const nav = state.plugins.map((plugin) => `<button class="plugin-nav-button${plugin.id === selected.id ? " is-active" : ""}" type="button" data-plugin-id="${escapeHtml(plugin.id)}"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><span><strong>${escapeHtml(plugin.name)}</strong><small>${escapeHtml(plugin.category)}</small></span><span class="status-dot ${plugin.status === "connected" ? "success" : plugin.status === "installed" ? "attention" : ""}"></span></button>`).join("");
    openPanel("Global capabilities", "Plugins, connectors & skills", `<div class="panel-intro"><p>Plugins are installed once for the Machine Room. Their individual tools can then be granted to agents or rooms through policy.</p><span class="status-pill success">global</span></div><div class="plugin-browser"><aside class="plugin-sidebar">${nav}</aside><section class="plugin-detail">${pluginDetailMarkup(selected)}</section></div>`);
  }

  function agentProfilePanel(worker) {
    const model = modelById(worker.model);
    const routines = routinesForContext({ kind: "worker", id: worker.id });
    return `<div class="panel-grid"><section class="panel-card"><div class="panel-card-header">${avatarMarkup(worker, "context-profile-avatar")}<span class="status-pill ${worker.status === "working" ? "working" : worker.status === "attention" ? "" : "success"}">${escapeHtml(worker.statusText)}</span></div><h3>${escapeHtml(worker.name)}</h3><p>${escapeHtml(worker.role)}</p><div class="tag-list"><span class="tag">${escapeHtml(model ? model.name : worker.model)}</span><span class="tag">${worker.files.length} files</span><span class="tag">${routines.length} routines</span></div></section><section class="settings-section"><h3>Agent-owned context</h3><p>The direct transcript and the routines shown here belong to this agent. The model and the browser belong to the whole box and are shared with every other agent on it.</p><div class="setting-row"><div><strong>Direct conversation</strong><small>Operator-to-agent thread</small></div><span class="status-pill ${worker.status === "working" ? "working" : ""}">${escapeHtml(worker.statusText)}</span></div><div class="setting-row"><div><strong>Browser</strong><small>${escapeHtml(worker.browser.url)}</small></div><button class="ghost-button" type="button" data-open-context-browser>Open</button></div></section></div>`;
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

  function simplePanel(type) {
    const copy = {
      notifications: ["Recent activity", "Notifications", "Atera finished its previous ticket review. Context7 access is waiting for approval in MSP Team."],
      attachments: ["Current context", "Add files", `Attachments added here belong to ${contextName()}.`],
      context: [activeContext().kind === "worker" ? "Agent context" : "Room context", `${contextName()} options`, activeContext().kind === "worker" ? "Manage this agent’s profile, model, direct conversation, files, browser, and routines." : "Rename this room, manage its roster, and review room-owned routines."],
    }[type];
    openPanel(copy[0], copy[1], `<div class="panel-card"><h3>${escapeHtml(copy[1])}</h3><p>${escapeHtml(copy[2])}</p><div class="form-actions"><button class="primary-button" type="button" data-demo-action>Continue in prototype</button></div></div>`);
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
        elements.desktopWindow.innerHTML = `<div class="desktop-browser" style="display:flex;flex-direction:column;height:100%"><div class="browser-toolbar" style="flex:0 0 auto"><div class="browser-address" data-box-caption>${line}</div></div><div style="flex:1 1 auto;min-height:0;position:relative;overflow:hidden;background:#0b0f13"><iframe data-box-vnc src="${escapeHtml(frameUrl)}" title="Live view of the box" style="position:absolute;top:-30px;left:0;width:100%;height:calc(100% + 30px);border:0"></iframe></div></div>`;
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

    if (!agentId) { paint("http://127.0.0.1:6080/vnc_lite.html?autoconnect=1&resize=scale&reconnect=1", 1, true); return; }

    elements.desktopWindow.innerHTML = `<div class="empty-state">Opening ${escapeHtml(contextName())}'s screen… the first time takes about ten seconds while the host allocates one.</div>`;
    mountedDesktop = null;
    adapter.ensureDesktop(agentId)
      .then((desk) => paint(desk.url, desk.display, desk.shared))
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
    } else if (activeDesktopApp === "sheets") {
      elements.desktopWindow.innerHTML = `<div class="files-view"><div class="browser-page-head"><div><h3>${escapeHtml(record.name)} sheet</h3><p>Not wired to this host.</p></div><span class="status-pill">unwired</span></div><div class="empty-state">This gateway exposes no sheet for a worker. Nothing is being tracked here.</div></div>`;
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

  function openTeachMode() {
    const lead = contextLead();
    if (elements.desktopDialog.open) elements.desktopDialog.close();
    adapter.startTeaching(lead.id);
    elements.teachTitle.textContent = `Recording ${lead.name}'s screen`;
    // The dialog used to draw a fake ticket queue. Show the screen actually being recorded.
    adapter.ensureDesktop(lead.id).then((desk) => {
      const live = document.getElementById("teach-live");
      if (live) live.innerHTML = `<iframe src="${escapeHtml(desk.url)}" title="The screen being recorded" style="width:100%;height:100%;border:0;background:#0b0f13"></iframe>`;
    }).catch(() => {});
    elements.teachTimer.textContent = "00:00";
    elements.teachDialog.showModal();
    const startedAt = state.teaching?.startedAt ?? Date.now();
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
      else if (action.dataset.contextAction === "profile" && activeContext().kind === "worker") openPanel("Agent details", contextName(), agentProfilePanel(contextRecord()));
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
      // them over is how a Slack channel ends up on a Sentry trigger.
      draftTriggers[Number(el.dataset.trig)] = el.value === "cron"
        ? { type: "cron", schedule: "0 8 * * 1-5" }
        : el.value === "github" ? { type: "github", events: [] } : { type: el.value };
      redrawTriggerStack();
      return;
    }
    t[field] = el.value;
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
    if (target.dataset.pluginId) {
      selectedPluginId = target.dataset.pluginId;
      renderPluginsPanel();
    } else if (target.dataset.installPlugin) {
      adapter.setPluginState(target.dataset.installPlugin, "connect");
      selectedPluginId = target.dataset.installPlugin;
      renderPluginsPanel();
      showToast("Plugin installed globally. Connect its account to enable tools.");
    } else if (target.dataset.toggleTool) {
      adapter.togglePluginTool(selectedPluginId, target.dataset.toggleTool);
      renderPluginsPanel();
    } else if (target.dataset.runRoutine) {
      const context = activeContext();
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
    } else if (form.hasAttribute("data-new-routine")) {
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
      // One trigger goes as itself; several become the group the host understands.
      const trigger = draftTriggers.length === 1 ? draftTriggers[0] : { type: "group", listeners: draftTriggers };
      adapter.createRoutine(context.id, context.kind, {
        name: String(data.get("name")).trim(),
        prompt: String(data.get("prompt")).trim(),
        trigger,
        isEnabled: true,
      }).then((routine) => {
        draftTriggers = [{ type: "cron", schedule: "0 8 * * 1-5" }];
        renderRoutinesPanel();
        showToast(`${routine.name} created — ${routine.trigger}`);
      }).catch((error) => {
        submit.disabled = false;
        showToast(`Could not create that routine: ${error.message}`);
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
  elements.transcript.addEventListener("click", (event) => {
    const action = event.target.closest("[data-decide]");
    if (!action) return;
    // No toast: the card itself reports what the host did, once the host has done it.
    adapter.decideApproval(activeContext(), action.dataset.messageId, action.dataset.decide);
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
  elements.panelContent.addEventListener("change", handlePanelChange);
  elements.panelContent.addEventListener("submit", handlePanelSubmit);

  document.getElementById("settings-button").addEventListener("click", () => { openPanel("Global router & policy", "Operator settings", settingsPanel()); fillEndpoints(); });
  document.getElementById("shelf-settings").addEventListener("click", () => { openPanel("Global router & policy", "Operator settings", settingsPanel()); fillEndpoints(); });
  document.getElementById("people-button").addEventListener("click", () => {
    if (activeContext().kind === "room") openPanel("Room roster", `${contextName()} members`, membersPanel());
    else openPanel("Agent details", contextName(), agentProfilePanel(contextRecord()));
  });
  document.getElementById("notifications-button").addEventListener("click", () => openPanel("Recent activity", "Unread", notificationsPanel()));
  document.getElementById("room-menu").addEventListener("click", () => simplePanel("context"));
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
    showToast(state.desktop.paused ? "Context run paused" : "Context run resumed");
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
})();
