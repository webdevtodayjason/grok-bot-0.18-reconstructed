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
          {
            id: "chief-ask-queue",
            authorId: "you",
            authorName: "You",
            type: "text",
            text: "Read the overnight queue and tell me where it stands.",
            time: "5:34 PM",
          },
          // Both claim-provenance verdicts, so the offline console shows the chip in each of its
          // two tones without a gateway (docs/EVIDENCE-CONTRACT.md, Presentation).
          {
            id: "chief-queue-report",
            authorId: "chief",
            authorName: "Chief of Staff",
            type: "text",
            text: "The queue holds 42 rows this morning and 3 of them are marked urgent. The counts come from ticket-audit.csv.",
            time: "5:35 PM",
            evidence: { attemptId: "demo-attempt-queue", verdict: "evidenced", receipts: 2, attestations: ["demo-att-queue-1", "demo-att-queue-2", "demo-att-queue-3"], missing: [], checkedBy: "containment@1" },
          },
          // SECRET-1: the inline credential card, in the shape the original product uses --
          // connector "shell", so the value lands as an environment variable of this agent's own
          // box. Offline it is the only place the masked field, its custody hint and the collapsed
          // "Saved" state can be read with no gateway, which is what verify-dashboard --offline
          // measures. The token itself is a name, never a value: nothing here is a credential.
          {
            id: "chief-secret-request",
            authorId: "chief",
            authorName: "Chief of Staff",
            type: "decision",
            text: "I need the Job Bus token before I can run the dry-run. Put it in the field below rather than in the chat.",
            time: "5:37 PM",
            card: {
              kind: "secret",
              requestId: null,
              entryId: "chief-secret-request",
              status: "pending",
              field: "TITAN_JOB_TOKEN",
              platform: "shell",
              title: "The agent asked for Titan Job Bus token",
              detail: "Temporary Titan Job Bus bearer token for the CoS dry-run. Never share it in chat. It lands as env TITAN_JOB_TOKEN for this box.",
              rule: null,
              options: [],
            },
          },
          {
            id: "chief-queue-link",
            authorId: "chief",
            authorName: "Chief of Staff",
            type: "text",
            text: "The walkthrough clip the client sent has captions at https://captions.example.com/captions/4821.vtt if you want the transcript.",
            time: "5:36 PM",
            evidence: {
              attemptId: "demo-attempt-link",
              verdict: "unsupported",
              receipts: 2,
              attestations: ["demo-att-link-1"],
              missing: ["https://captions.example.com/captions/4821.vtt"],
              checkedBy: "containment@1",
            },
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
    scheduleButton: document.getElementById("schedule-button"),
    countdown: document.getElementById("next-routine-countdown"),
    countdownLabel: document.getElementById("next-routine-label"),
    nowIsland: document.querySelector(".now-island"),
    nowHeading: document.getElementById("now-heading"),
    routineTitle: document.getElementById("routine-title"),
    routineWorker: document.getElementById("routine-worker"),
    routineMeta: document.getElementById("routine-meta"),
    panelDialog: document.getElementById("panel-dialog"),
    onboardingDialog: document.getElementById("onboarding-dialog"),
    onboardingContent: document.getElementById("onboarding-content"),
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
    // AVATAR-1. Every face on this page comes through here, so this is the one place the Titan
    // crew has to be taught about: mascots.js answers with a live <titan-mascot> at the size the
    // static mark had, and answers with nothing when it should not draw one -- an agent whose own
    // avatar the host is serving, an operator who chose the classic mark, or a browser that cannot
    // run the canvas. The <img> below is what is left in every one of those cases.
    const crewFace = typeof window.titanAvatarMarkup === "function" ? window.titanAvatarMarkup(worker, className, title) : "";
    if (crewFace) return crewFace;
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
  // ---- end QOL-NEEDS-YOU ---------------------------------------------------------------

  // ---- BOX-6b: an agent whose conversation store needs repair --------------------------
  // The same pill shape, its own class and its own words, and deliberately NOT in the "N need you"
  // count: that count is a queue of things a person has been asked, and this is a machine that has
  // stopped. It reads off needsRepair, which gateway-adapter.js carries from the host's own
  // transcriptNeedsRepair and raises the moment a failed turn names a store that needs repairing.
  function needsRepair(record) {
    return record != null && record.needsRepair === true;
  }

  function needsRepairPillMarkup(record, className) {
    if (!needsRepair(record)) return "";
    const reason = typeof record.needsRepairReason === "string" ? record.needsRepairReason.trim() : "";
    return `<span class="${className}" title="${escapeHtml(reason || "This agent's conversation store needs repair. Open Agent details to repair it.")}">Needs repair</span>`;
  }
  // ---- end BOX-6b ----------------------------------------------------------------------

  // ---- QOL-NEEDS-YOU, continued --------------------------------------------------------

  function renderNeedsYouCount() {
    const slot = document.querySelector("[data-needs-you-count]");
    if (!slot) return;
    const count = needsYouCount();
    // CONSOLE-ATTR-1. The NUMBER, as the attribute's value, and it is not decoration. The desktop
    // shell's injected reader tries the attribute's value, then a number anywhere in the text, then --
    // failing both -- the number of elements its selector matched. This pill is always in the markup
    // and matches even while it is hidden and empty, so with the attribute carrying nothing a console
    // with ZERO agents waiting reported 1, indistinguishable from a real 1. Measured on this Mac
    // 2026-09-10 by running that reader verbatim against the shipped markup: 0 -> 1, 3 -> 3; with the
    // value written, 0 -> 0 and 3 -> 3. This is called at the end of renderRoster, so it is written on
    // first paint and on every roster change. docs/APPS.md section 6 is the contract.
    slot.dataset.needsYouCount = String(count);
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
      <span class="worker-copy"><span class="worker-name"><i class="status-dot ${statusClass(worker.status)}"></i>${escapeHtml(worker.name)}${needsYouPillMarkup(worker, "needs-you-pill")}${needsRepairPillMarkup(worker, "needs-repair-pill")}</span><span class="worker-status">${escapeHtml(worker.statusText)}</span></span>
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
    renderAgentCount();
    renderNeedsYouCount();
  }

  // ---- AGENTS-CAP-1: Titan and thirty-nine more ----------------------------------------------
  // The box holds a fixed number of bots and the host refuses the next one (SAND_MAX_AGENTS).
  // Rooms are not bots and are not counted, so the number drawn here is the roster's own bot count
  // rather than countAgents, which counts a room as an agent. The host's own number is kept on the
  // tooltip, because when the two disagree that is worth being able to see.
  //
  // AGENTS-CAP-2, decided by Jason 2026-09-09 06:34: the default is 40, not 100. Titan's own
  // reasoning, which Jason took: flat coordination holds to roughly fifty bots, and the hierarchy
  // tooling that would carry more (TEAMS-1) does not exist yet, so a hundred is a ceiling that
  // promises something the product cannot yet do well. A workspace that wants more gets it from the
  // super admin, who raises that one client's ceiling from its row in the admin console.
  //
  // This number is the FALLBACK and nothing else. Every box reports its own ceiling through
  // getOnboardingState, and applyReportedCap below installs it on every load, so a workspace whose
  // ceiling was raised draws its own number within one reload and never this one. The three live
  // R750 boxes each pin SAND_MAX_AGENTS to "100" in their own settings file, so this default cannot
  // move them.
  const AGENT_CAP_DEFAULT = 40;
  const agentCap = () => (Number.isFinite(state.agentCap) && state.agentCap > 0 ? state.agentCap : AGENT_CAP_DEFAULT);
  const botCount = () => state.workers.length;
  // Titan is one of the hundred, so what is left to add is ninety-nine. This is the number the Add
  // button carries, and the one the refusal talks about.
  const extraBotCount = () => Math.max(0, botCount() - 1);
  const extraBotCap = () => Math.max(0, agentCap() - 1);

  function renderAgentCount() {
    const count = document.querySelector("[data-agent-count]");
    if (count) {
      const bots = botCount();
      count.hidden = state.workers.length === 0 && !Number.isFinite(state.agentCount);
      count.textContent = count.hidden ? "" : `${bots} / ${agentCap()} bots`;
      const host = Number.isFinite(state.agentCount) ? `The host counts ${state.agentCount}, rooms included. ` : "";
      count.title = count.hidden ? "" : `${host}This box holds Titan and ${extraBotCap()} more bots. Rooms do not count.`;
    }
    // The Add button says how much room is left before it is clicked, so the refusal is never the
    // first time anyone hears about the cap.
    const add = document.querySelector('[data-capability="add"] [data-add-count]');
    if (add) {
      add.textContent = `${extraBotCount()} of ${extraBotCap()}`;
      // AGENTS-CAP-2: a full roster is not a dead end any more. The ceiling is one setting the
      // super admin changes from this workspace's row, so the tooltip says who to ask rather than
      // leaving the person to guess whether the number is a licence, a bug or the machine's limit.
      add.title = extraBotCount() >= extraBotCap() ? CAP_RAISE_SENTENCE : "";
    }
  }

  // The host's own words when it refuses. It sends this sentence back as {error}; the console says
  // it as it stands rather than wrapping it in one of its own, and falls back to the same sentence
  // when an older host refuses with something less readable. Read at the moment of the refusal, not
  // once at load: the cap can arrive from the host after this file has been evaluated, and a
  // sentence baked in at load would then name a number the box no longer holds to.
  // AGENTS-CAP-2. One sentence, used by the refusal and by the Add tile's tooltip, so the person is
  // told the same thing whichever of the two they meet first.
  const CAP_RAISE_SENTENCE = "Ask the operator to raise this workspace's ceiling if you need more.";
  const agentCapRefusalText = () => `This workspace holds Titan and ${extraBotCap()} more bots. Remove one to add another, or ask the operator to raise this workspace's ceiling.`;
  function agentCapRefusal(error) {
    const said = String(error?.message ?? error ?? "").trim();
    if (/Titan and \d+ more bots/.test(said)) return said;
    if (/limit|maximum|cap/i.test(said)) return agentCapRefusalText();
    return "";
  }
  // ---- end AGENTS-CAP-1 ----------------------------------------------------------------------

  // ---- FEEDBACK-1: report a problem ------------------------------------------------------------
  //
  // Jason, 2026-09-07: "Titan tried to cover up failure. We need to instill in the agents that
  // failure must be reported... 'Would you like to submit this feedback to the developers?'"
  //
  // TWO GATES, and the first of them is the person reading this page. Nothing an agent writes down
  // leaves this workspace until they have seen it, edited it or dropped it. That is topology and
  // not policy: the agent's tool writes a pending report into the box's own file and returns a
  // sentence; this page, which is already signed in as the tenant, is the only thing that POSTs.
  // The developers are the SECOND gate and see only what was sent.
  //
  // Everything here is page-local by construction, which is the honest cost: an offer nobody
  // answers dies with the tab. That is exactly why the always-present Report a problem control
  // beside the composer exists, and why the box's own pending file is re-read on every load.
  const PROBLEM_TIERS = [
    ["critical", "Blocks the work"],
    ["quality", "Slowed me down"],
    ["observation", "Worth noting"],
  ];
  const tierLabel = (tier) => (PROBLEM_TIERS.find((row) => row[0] === tier) ?? PROBLEM_TIERS[2])[1];

  // What is sent, said as a promise the product can actually keep. The claim is deliberately the
  // strongest one available -- what is on the card is what goes -- because the alternative, shipping
  // an uneditable copy of something the person just deleted, is a custody lie of exactly the kind
  // the secret card was rewritten to stop making.
  const REPORT_CUSTODY = "What you see below is what is sent, along with this workspace's name, which agent it came from, and the build numbers of the box and this page. Your keys, your files and your other conversations are not sent. Edit anything you would rather not share; if you change the text, only your version goes.";

  // The self-test, as Titan wrote it on Jason's box. Shipped as a constant rather than a saved
  // skill so a box with no skills of its own still has it, and so the known-limitation line stays
  // in step with the Read tool's refusal wording -- an out-of-date checklist is how an agent came
  // to file a deliberate boundary as a bug.
  const SELF_TEST_PROMPT = [
    "Run a tool self-test and report what you find. Work through these six sections in order, one real call each, and do not skip a section because you expect it to pass:",
    "",
    "1. Shell and file I/O: run a command, write a file, read it back, delete it.",
    "2. Web tools: fetch a public page and run one search.",
    "3. Connectors: list what is connected and call one read-only tool on one of them.",
    "4. Desktop and browser: take a screenshot and open one page, if you have a desktop.",
    "5. State and memory: write one note to memory and read it back.",
    "6. Agent management: report what you could do here. Do NOT create, change or delete any agent without being asked.",
    "",
    "Then give me one table with a row per tool: Tool | Status | Error. Quote each error word for word rather than summarising it.",
    "",
    "Known and not a fault: your Read tool refuses paths under your own sand-data store. That store holds this workspace's own settings and credentials, and keeping it out of what you read is deliberate. Your own working files live under /home/box and read normally. Do not report that refusal as a bug.",
    "",
    "When the table is done, use your reporting tool once, at tier observation, with the table as the description, so I can decide whether to send it on.",
  ].join("\n");

  // The console's own build number, which did not exist before this. The first eight hex of a
  // sha256 over this very file, computed once at load: self-maintaining and true, where a
  // hand-kept literal goes stale on the first ship. It needs nothing from the relay.
  let consoleBuildValue = null;
  function consoleBuild() { return consoleBuildValue; }
  function loadConsoleBuild() {
    try {
      return Promise.resolve(fetch("app.js"))
        .then((response) => response.text())
        .then((text) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
        .then((digest) => {
          consoleBuildValue = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
          return consoleBuildValue;
        })
        .catch(() => null);
    } catch { return Promise.resolve(null); }
  }

  let hostBuildValue = null;
  function loadHostBuild() {
    if (typeof adapter.getHostStatus !== "function") return Promise.resolve(null);
    return Promise.resolve(adapter.getHostStatus())
      .then((status) => { hostBuildValue = status?.hostVersion ?? null; return hostBuildValue; })
      .catch(() => null);
  }

  let problemOffers = [];
  let problemOfferSeq = 0;
  /**
   * FEEDBACK-2b. An offer whose conversation does not exist on this page is drawn in whatever
   * conversation IS open, not nowhere.
   *
   * A subagent writes a report, a background worker does, or the agent it belongs to has since
   * been deleted: `offer.agentId` then matches no row of the roster, so the old filter -- agentId
   * equals the open context, and nothing else -- drew it in no conversation at all. Measured on
   * grok-bot-local-vm in real Chrome, with two rows in the box's pending file for "some-other-agent"
   * and a deleted "deleted-agent-9": the open console drew neither, switching conversations drew
   * neither, and the drain had already marked both seen, so nothing drew them for the rest of the
   * session. That is FEEDBACK-1b one step over -- the report Jason lost happened to belong to the
   * conversation he had open.
   *
   * An empty roster is not the same thing as an unknown agent. Before listAgents answers, every
   * offer would look homeless and land in whatever context the page booted with, so the fallback
   * waits for a roster to exist.
   */
  function offerHasNoHome(offer) {
    if (!offer.agentId) return true;
    if (state.workers.length === 0 && state.rooms.length === 0) return false;
    return !workerById(offer.agentId) && !roomById(offer.agentId);
  }

  const problemOffersFor = (context = activeContext()) =>
    problemOffers.filter((offer) => offer.agentId === context.id || offerHasNoHome(offer));

  // FEEDBACK-2. How long a settled card says what happened before it folds itself into the
  // transcript. Jason, 2026-09-09, on a card he had already answered: "that green box is not going
  // away. It just stays there." Long enough to read one sentence, short enough that the next
  // report is not queued behind a card nobody is looking at any more.
  const REPORT_FOLD_MS = 6000;

  /**
   * FEEDBACK-2. What this conversation's report band holds: the offers that have already folded, for
   * ordering, and then AT MOST ONE live card. reportCardsMarkup draws only the live one -- a folded
   * offer's row is spliced into the message sequence at the place the report happened, by
   * withFoldedReportRows, because appending it here left it pinned above the composer for the life of
   * the tab (FEEDBACK-2b).
   *
   * One at a time is the whole point. Two reports drawn as a stack of editable cards is what a
   * reload used to show -- measured on grok-bot-local-vm, a page reloaded with two pending rows
   * drew both at once, each with its own Send -- and a person answering the second has already
   * lost track of which body belongs to which title. The rest wait their turn and arrive as soon
   * as the one in front of them is answered.
   *
   * One exception, and it is the same failure this item is about: a card the person opened
   * themselves with "Report a problem" goes first. A button that draws nothing because an agent's
   * report happens to be queued in front of it is exactly the "I pressed it and nothing happened"
   * that started this.
   */
  function problemOfferQueue(context = activeContext()) {
    const mine = problemOffersFor(context);
    const rows = mine.filter((offer) => offer.status === "folded");
    const waiting = mine.filter((offer) => offer.status !== "folded");
    const head = waiting.find((offer) => offer.source === "manual") ?? waiting[0];
    if (head) rows.push(head);
    return rows;
  }

  // Everything an offer is minted from goes through this on the way in. The regex is the page's own
  // (maskSecrets, further down), so a token pasted into a shell command and echoed back by the box
  // is masked here for the same reason it is masked on an evidence receipt.
  const reportRedact = (value) => maskSecrets(String(value ?? ""));

  // What the conversation can say about a failure without opening a single file. Only what is
  // already on this page: the tool rows the outline wove in, and the last few things that were
  // said. No environment, no file, and nothing from the two secret stores.
  function reportEvidence(context = activeContext()) {
    const rows = contextMessages(context);
    const calls = rows
      .filter((row) => row.type === "system" && row.kind)
      .slice(-12)
      .map((row) => ({
        name: String(row.kind),
        status: / · failed(?: ·|$)/.test(String(row.text ?? "")) ? "failed" : "done",
        summary: reportRedact(row.text).slice(0, 400),
        output: reportRedact(row.detail).slice(0, 1200),
      }));
    const messages = rows
      .filter((row) => (row.type === "text" || row.type === "attachment") && String(row.text ?? "").trim())
      .slice(-6)
      .map((row) => ({ role: row.authorId === "you" ? "you" : "agent", text: reportRedact(row.text).slice(0, 800) }));
    return { calls, messages };
  }

  // The report as the person reads it. One block of plain text, because that is what they are
  // being asked to check and edit, and because a form with nine fields is not something anyone
  // fills in at the moment a thing has just broken.
  function reportBodyText(seed) {
    const lines = [seed.description ?? ""];
    if ((seed.steps ?? []).length) lines.push("", "Steps:", ...seed.steps.map((step, i) => `${i + 1}. ${step}`));
    if ((seed.tools ?? []).length) {
      lines.push("", "Tools:");
      for (const tool of seed.tools) lines.push(`- ${tool.name} · ${tool.status}${tool.error ? ` · ${tool.error}` : ""}`);
    }
    if ((seed.calls ?? []).length) {
      lines.push("", "What ran just before:");
      for (const call of seed.calls) lines.push(`- ${call.summary}${call.output ? `\n  ${call.output.split("\n").join("\n  ")}` : ""}`);
    }
    if ((seed.messages ?? []).length) {
      lines.push("", "Last said:");
      for (const message of seed.messages) lines.push(`- ${message.role}: ${message.text}`);
    }
    return lines.join("\n").trim();
  }

  /**
   * Mints one offer and puts it in front of the person. `pendingId` is set when the box already
   * holds this report in its own file: resolving the card then clears it there too, so the same
   * report is not offered again on the next load.
   */
  function offerProblemReport(seed) {
    const context = seed.agentId ? { kind: "worker", id: seed.agentId } : activeContext();
    // FEEDBACK-2b. Where this report happened, as a message id rather than a clock: chat rows carry
    // a display time ("5:38 PM") and nothing sortable, and the ids come from the host's own entries
    // so they survive the adapter replacing `record.messages` wholesale on every tick. A transient
    // "working" row is skipped -- it is replaced by the reply and would take the anchor with it.
    const timeline = contextMessages(context).filter((row) => row.type !== "working");
    const afterMessageId = timeline.length ? timeline[timeline.length - 1].id : null;
    const evidence = seed.calls || seed.messages
      ? {
        calls: (seed.calls ?? []).map((call) => ({ ...call, summary: reportRedact(call.summary), output: reportRedact(call.output) })),
        messages: (seed.messages ?? []).map((message) => ({ ...message, text: reportRedact(message.text) })),
      }
      : reportEvidence(context);
    // MASKED ONCE, HERE, AND NOWHERE ELSE. The fields an agent wrote -- the title, the description,
    // the steps and each tool's answer -- go through the page's masker before they are put on the
    // offer, so the card, the body the person edits and the payload the relay is handed are the
    // same already-masked bytes. Masking at draw time instead meant a token quoted by an agent was
    // starred on screen and sent whole, which is the one thing the custody line promises cannot
    // happen.
    const title = reportRedact(seed.title ?? "Something went wrong");
    const description = reportRedact(seed.description ?? "");
    const steps = (seed.steps ?? []).map((step) => reportRedact(step));
    const tools = (seed.tools ?? []).map((tool) => ({
      ...tool,
      ...(tool?.error == null ? {} : { error: reportRedact(tool.error) }),
    }));
    const full = { ...seed, title, description, steps, tools, ...evidence };
    const offer = {
      id: `offer-${problemOfferSeq += 1}`,
      agentId: seed.agentId ?? context.id,
      agentName: seed.agentName ?? "",
      pendingId: seed.pendingId ?? null,
      tier: seed.tier ?? "quality",
      category: seed.category ?? "console",
      title,
      steps,
      tools,
      calls: evidence.calls,
      messages: evidence.messages,
      body: reportBodyText(full),
      status: "pending",
      note: "",
      source: seed.source ?? "console",
      afterMessageId,
    };
    problemOffers.push(offer);
    return offer;
  }

  const problemOfferById = (id) => problemOffers.find((offer) => offer.id === id);

  // The payload the relay is handed. ProblemReport v1, minted the same way whether it came from the
  // agent's tool, the automatic offer or the self-test. `workspace` is absent on purpose: the relay
  // stamps it from its own registry, so this page can neither name its own tenant nor anyone else's.
  function problemReportPayload(offer, body) {
    const edited = String(body).trim() !== String(offer.body).trim();
    return {
      version: 1,
      tier: offer.tier,
      category: offer.category,
      title: offer.title,
      description: String(body),
      // Edited means the person removed or reworded something, so the structured copies of what
      // they were shown do not ride along behind their back. Untouched means what they approved is
      // exactly what the agent wrote, and the developers get it in both forms.
      steps: edited ? [] : offer.steps,
      tools: (offer.tools ?? []).map((tool) => (edited ? { name: tool.name, status: tool.status } : tool)),
      evidence: {
        agent: offer.agentId,
        agentName: offer.agentName,
        conversation: offer.agentId,
        hostVersion: hostBuildValue,
        consoleVersion: consoleBuild(),
        ...(edited ? {} : { calls: offer.calls, messages: offer.messages }),
      },
      at: new Date().toISOString(),
    };
  }

  // The four honest states, in the manner of the decision card: sending, settled, pending with
  // buttons, and pending again with one sentence saying why the last try did not land.
  // FEEDBACK-2b: a report drawn in a conversation that is not its own says whose it was. Without
  // the name the person reads a card about a failure that looks like it happened in front of them.
  const reportCardTitle = (offer) => (offerHasNoHome(offer) && String(offer.agentName ?? "").trim()
    ? `${String(offer.agentName).trim()}: ${offer.title}`
    : offer.title);

  function reportCardMarkup(offer) {
    const title = reportCardTitle(offer);
    const chip = `<span class="tag">${escapeHtml(tierLabel(offer.tier))}</span><span class="tag">${escapeHtml(offer.category)}</span>`;
    if (offer.status === "sending") {
      return `<article class="message-row is-system" data-message-id="${escapeHtml(offer.id)}"><div class="inline-card" style="--card-accent:var(--teal-500)"><div class="inline-card-header"><span class="inline-card-icon">◌</span><span class="inline-card-copy"><strong>${escapeHtml(title)}</strong><small class="approval-result">Sending this to the developers…</small></span></div></div></article>`;
    }
    // FEEDBACK-2b: a folded offer is not drawn from here at all. It is spliced into the message
    // sequence at the place the report happened (withFoldedReportRows) and rendered by
    // messageMarkup like any other quiet system row, which is what "a row like any other" has to
    // mean if a later message is to land below it.
    if (offer.status === "sent" || offer.status === "dropped") {
      // Not "you can see what you sent in your own copy above": that sentence was only true while
      // this card was on screen, and this card is about to fold itself away.
      const settled = offer.status === "sent"
        ? "Sent. The developers have it."
        : "Kept to yourself. Nothing left this workspace.";
      // And when the box refused to take the row back, say so instead of folding on a promise it
      // never heard. A card that folds while the box still holds its copy shows a decision the box
      // has no record of, and the same report is offered again on the next load with nothing on
      // the page explaining why.
      const held = offer.boxKept ? " This box still holds its own copy, so it will be offered again next time you open the console." : "";
      const accent = offer.status === "sent" ? "var(--green-500)" : "var(--amber-500)";
      return `<article class="message-row is-system" data-message-id="${escapeHtml(offer.id)}"><div class="inline-card" style="--card-accent:${accent}"><div class="inline-card-header"><span class="inline-card-icon">${offer.status === "sent" ? "✓" : "✕"}</span><span class="inline-card-copy"><strong>${escapeHtml(title)}</strong><small class="approval-result">${escapeHtml(settled + held)}</small></span></div><div class="inline-card-actions"><button class="card-action" type="button" data-report-dismiss="${escapeHtml(offer.id)}">Dismiss</button></div></div></article>`;
    }
    const note = offer.note ? `<small class="field-hint">${escapeHtml(offer.note)}</small>` : "";
    // CONSOLE-ATTR-1, the sixth kind, and only on this branch: the returns above are sending, sent
    // and dropped. The durable id is `pendingId` -- the problem-report ROW id, which is exactly what
    // ui/push-edge.mjs uses as this card's entry id -- and NOT `offer.id`, which is the page-local
    // `offer-<seq>` that dies with the page and that the relay says in so many words it never pushes.
    // An offer with no pendingId is a card the relay will never send, so it carries nothing. The title
    // is the relay's own -- the report's title -- rather than the copy this card prefixes with the
    // agent's name when it is drawn in a conversation that is not its own.
    const hook = needsYouCardAttrs(escapeHtml, { kind: "report", agentId: offer.agentId, entryId: offer.pendingId, agentName: offer.agentName, title: offer.title });
    return `<article class="message-row is-system" data-message-id="${escapeHtml(offer.id)}"><div class="inline-card problem-report-card"${hook} style="--card-accent:var(--amber-500)"><div class="inline-card-header"><span class="inline-card-icon">▣</span><span class="inline-card-copy"><strong>${escapeHtml(title)}</strong><small>Would you like to send this to the developers?</small></span></div><div class="tag-list">${chip}</div><div class="field"><label class="sr-only" for="report-body-${escapeHtml(offer.id)}">What is sent to the developers</label><textarea id="report-body-${escapeHtml(offer.id)}" data-report-body="${escapeHtml(offer.id)}" rows="8" aria-describedby="report-custody-${escapeHtml(offer.id)}">${escapeHtml(offer.body)}</textarea><small class="field-hint" id="report-custody-${escapeHtml(offer.id)}">${escapeHtml(REPORT_CUSTODY)}</small>${note}</div><div class="inline-card-actions"><button class="card-action primary" type="button" data-report-send="${escapeHtml(offer.id)}">Send</button><button class="card-action" type="button" data-report-drop="${escapeHtml(offer.id)}">Not now</button></div></div></article>`;
  }

  // FEEDBACK-2b: drawing is what marks a pending row seen, and the only card appended after the
  // last message is the live one -- every folded row is spliced back into the transcript where it
  // happened (withFoldedReportRows).
  const reportCardsMarkup = () => problemOfferQueue()
    .filter((offer) => offer.status !== "folded")
    .map((offer) => {
      if (offer.pendingId) seenPendingReports.add(offer.pendingId);
      return reportCardMarkup(offer);
    })
    .join("");

  /**
   * FEEDBACK-2b. A folded report is a row OF the transcript, not a tail stuck after it.
   *
   * It used to be concatenated after every message on every render, so it stayed the last row above
   * the composer for the life of the tab and one more arrived per answered report -- a quieter form
   * of the card that would not go away. Measured on this Mac in real Chrome at 1440x900: a report
   * sent and folded sat at index 5 of #transcript's children, and after a further message and its
   * reply it was STILL the last child.
   *
   * Each offer remembers the message it was offered after, and its row is spliced back in there, so
   * a later message lands below it. An offer whose anchor is not in the window any more -- paged
   * out, or a working row that has since been replaced -- falls to the end, which is the truthful
   * place for a row whose neighbours are not on the page.
   *
   * The row is PAGE-LOCAL either way. It is not a transcript entry, the box has no record of it,
   * and a reload does not bring it back; what survives a reload is the agent's own "Reported a
   * problem to the developers" row and the report in the control plane.
   */
  const foldedReportRow = (offer) => ({
    id: offer.id,
    authorId: "system",
    authorName: "Machine Room",
    type: "system",
    text: offer.foldText,
  });

  function withFoldedReportRows(rows, context = activeContext()) {
    const left = problemOffersFor(context).filter((offer) => offer.status === "folded" && offer.foldText);
    if (left.length === 0) return rows;
    const out = [];
    const take = (id) => {
      if (id == null) return;
      for (let i = 0; i < left.length;) {
        if (left[i].afterMessageId === id) out.push(foldedReportRow(left.splice(i, 1)[0]));
        else i += 1;
      }
    };
    for (const row of rows) { out.push(row); take(row.id); }
    for (const offer of left) out.push(foldedReportRow(offer));
    return out;
  }

  /**
   * FEEDBACK-2. Settling is not the end of the card, it is the start of the last few seconds of it.
   *
   * The box is told first and the fold waits for that answer. `resolveProblemReport` used to be
   * fire-and-forget, which was harmless while a settled card sat there for ever; with a fold it is
   * not. Taking the row off the screen while the box still held it would show a decision the box
   * has no record of, and the next load would offer the same report again with nothing said.
   */
  function settleProblemOffer(offer, status, note) {
    offer.status = status;
    offer.note = note ?? "";
    const told = offer.pendingId && (status === "sent" || status === "dropped") && typeof adapter.resolveProblemReport === "function"
      ? Promise.resolve(adapter.resolveProblemReport(offer.pendingId, status)).then(() => true, () => false)
      : Promise.resolve(true);
    renderTranscript();
    return told.then((cleared) => {
      // Dismissed by hand, or answered again, while the box was being told.
      if (offer.status !== status) return offer;
      if (!cleared) {
        // The box kept its row. The card stays up saying so; folding here would take the decision
        // off the screen and then hand the same report back on the next load.
        offer.boxKept = true;
        renderTranscript();
        return offer;
      }
      scheduleProblemOfferFold(offer);
      return offer;
    });
  }

  function scheduleProblemOfferFold(offer) {
    if (offer.foldTimer != null || offer.status === "folded") return;
    offer.foldTimer = setTimeout(() => foldProblemOffer(offer), REPORT_FOLD_MS);
  }

  // Also the Dismiss button's own path: a person who has read the sentence does not have to wait
  // out the timer to get the space back.
  function foldProblemOffer(offer) {
    if (!offer) return;
    if (offer.foldTimer != null) { clearTimeout(offer.foldTimer); offer.foldTimer = null; }
    if (offer.status !== "sent" && offer.status !== "dropped") return;
    const title = reportCardTitle(offer);
    offer.foldText = offer.status === "sent"
      ? `Sent to the developers: ${title}`
      : `Kept to yourself: ${title}`;
    offer.status = "folded";
    renderTranscript();
  }

  function sendProblemOffer(id, body) {
    const offer = problemOfferById(id);
    if (!offer || offer.status === "sending") return Promise.resolve(null);
    if (typeof adapter.sendProblemReport !== "function") {
      offer.note = "This console cannot reach the developers from here. Nothing was sent.";
      renderTranscript();
      return Promise.resolve(null);
    }
    const payload = problemReportPayload(offer, body);
    offer.body = String(body);
    offer.status = "sending";
    renderTranscript();
    // No toast: the card reports what happened, once it has happened.
    return Promise.resolve(adapter.sendProblemReport(payload))
      .then((answer) => settleProblemOffer(offer, "sent").then(() => answer))
      .catch((error) => {
        offer.status = "pending";
        // The relay's sentences end in a full stop of their own, so one is taken off before this
        // one is added rather than showing the person two in a row.
        const said = String(error?.message ?? "").trim().replace(/\s*\.$/, "");
        offer.note = `That did not send: ${said}. It is still here, so you can try again.`;
        renderTranscript();
        return null;
      });
  }

  // Trigger one: a failed turn. Measured on grok-bot-local-vm 2026-09-09, a model-endpoint failure
  // writes no turn-failed row at all, so the adapter's tray queue is the only live signal there is.
  // BOX-6b. A failed turn is not always "ask again". Measured on the demo tenant's box 2026-09-09,
  // one agent had failed EVERY turn for two days on a conversation store that needed repairing, and
  // the console told the person to ask again each time. This turns one seed into the words that
  // failure deserves: the repair sentence FIRST when the box named a store that needs repairing,
  // and the old sentence otherwise.
  //
  // The predicate and the sentence are the adapter's (gateway-adapter.js, the BOX-6b block), read
  // through the global rather than copied here, because two copies of a predicate drift and then
  // the card and the conversation line say different things about the same failure. With no
  // adapter on the page — the offline demo — nothing named a store and the old words are right.
  function failedTurnWords(seed) {
    const words = (typeof window !== "undefined" ? window.__transcriptRepair : null) ?? null;
    const who = String(seed?.agentName ?? "").trim() || "This agent";
    const recorded = `What the box recorded: ${seed?.title ?? "error"}${seed?.detail ? ` — ${seed.detail}` : ""}`;
    const needsRepair = seed?.needsRepair === true
      || (words != null && words.wordsSeen(seed?.title, seed?.detail));
    if (!needsRepair) {
      return {
        needsRepair: false,
        title: `${who} could not finish that one`,
        description: `${who} was asked something and the turn ended without an answer. ${recorded}`,
      };
    }
    const sentence = words?.SENTENCE
      ?? "This agent's conversation store needs repair. Repair it from the agent's details panel.";
    return {
      needsRepair: true,
      title: `${who} needs its conversation store repaired`,
      // The clause first, because it is the only sentence here that tells the person what to do,
      // and because asking again — which the old wording invited — fails the same way every time.
      description: `${sentence} Until it is repaired, every turn for ${who} will end this way. ${recorded}`,
    };
  }

  function drainFailedTurnOffers() {
    if (typeof adapter.takeFailedTurnReports !== "function") return [];
    const seeds = adapter.takeFailedTurnReports() ?? [];
    // MEASURED in scripts/verify-feedback.mjs: the quiet note the adapter pushes into the
    // conversation does NOT survive for the conversation you are looking at. reloadTrays runs
    // first, then loadContext replaces that record's messages wholesale, so the note lives for one
    // tick on the active agent and until its next load on any other. That was equally true of the
    // raw line it replaced, so nothing was lost -- but it does mean the CARD has to carry the plain
    // words as well, because the card is the part that stays.
    return seeds.map((seed) => {
      const words = failedTurnWords(seed);
      return offerProblemReport({
        agentId: seed.agentId,
        agentName: seed.agentName,
        tier: "critical",
        category: "turn",
        title: words.title,
        description: words.description,
        source: "failed-turn",
      });
    });
  }

  // Trigger two: the same tool failing three times in one conversation. Counted off the woven tool
  // rows, which carry the tool's kind and say "failed" in their own text. Fired ONCE per kind per
  // conversation, not once per failure -- three cards for one bad afternoon is its own fault.
  const repeatedFailureOffered = new Set();
  function noteRepeatedToolFailures(context = activeContext()) {
    const counts = new Map();
    for (const row of contextMessages(context)) {
      if (row.type !== "system" || !row.kind) continue;
      if (!/ · failed(?: ·|$)/.test(String(row.text ?? ""))) continue;
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    }
    const made = [];
    for (const [kind, count] of counts) {
      const key = `${context.id}:${kind}`;
      if (count < 3 || repeatedFailureOffered.has(key)) continue;
      repeatedFailureOffered.add(key);
      made.push(offerProblemReport({
        agentId: context.id,
        agentName: contextName(context),
        tier: "quality",
        category: String(kind).toLowerCase(),
        title: `${kind} has failed ${count} times here`,
        description: `The same tool has failed ${count} times in this conversation. What it answered each time is below.`,
        source: "repeat",
      }));
    }
    return made;
  }

  // The always-present control. Prefilled from whatever this conversation can say, which on a good
  // day is nothing much -- and that is fine, because the person is about to type the part that
  // matters into a box that is already open.
  function openProblemReportCard() {
    const context = activeContext();
    offerProblemReport({
      agentId: context.id,
      agentName: contextName(context),
      tier: "quality",
      category: "console",
      title: "A problem with this product",
      description: "Say what happened, what you expected, and what you were doing at the time.",
      source: "manual",
    });
    // FEEDBACK-2: and take the person to it. The card is appended at the end of the transcript, and
    // renderTranscript only follows a reader who is already at the bottom (CONSOLE-4), so pressing
    // this while scrolled back drew the card below the fold with nothing saying where it went.
    // Measured on grok-bot-local-vm at 390x844: the card was on the page, 333 px wide and correct,
    // and its Send was off screen. Pressing a button that opens a card is one of the moments a
    // person expects to be taken to the newest line, so it uses the same one-shot pin the roster
    // click and a send use, and nothing else moves the reader.
    pinTranscriptToBottom();
    renderTranscript();
  }

  // The self-test. The same six sections Titan ran by hand, sent as a prompt; the answer comes back
  // as an ordinary message and the agent's own reporting tool offers it at tier observation.
  function runSelfTest() {
    const context = activeContext();
    if (typeof adapter.sendMessage !== "function") return null;
    adapter.sendMessage({ ...context }, SELF_TEST_PROMPT, []);
    return SELF_TEST_PROMPT;
  }

  // The box's own pending file, read on load and after each reload. A report an agent wrote while
  // nobody had the console open is still waiting here.
  const seenPendingReports = new Set();
  function drainPendingProblemReports() {
    if (typeof adapter.listProblemReports !== "function") return Promise.resolve([]);
    return Promise.resolve(adapter.listProblemReports())
      // FEEDBACK-2b. A row is SEEN once it has been drawn, not once it has been read off the box.
      // `seenPendingReports.add` used to run here, unconditionally, so a report whose conversation
      // was not the one on screen was consumed into invisibility and nothing offered it again for
      // the rest of the session. The guard against minting the same row twice is the offer list
      // itself, which is the thing that actually knows.
      .then((rows) => (Array.isArray(rows) ? rows : []).filter((row) => row?.id
        && !seenPendingReports.has(row.id)
        && !problemOffers.some((offer) => offer.pendingId === row.id)))
      .then((rows) => rows.map((row) => {
        const report = row.report ?? {};
        return offerProblemReport({
          agentId: row.agentId,
          agentName: row.agentName ?? "",
          pendingId: row.id,
          tier: report.tier,
          category: report.category,
          title: report.title,
          description: report.description,
          steps: report.steps ?? [],
          tools: report.tools ?? [],
          source: "tool",
        });
      }))
      .catch(() => []);
  }

  /**
   * FEEDBACK-1b. The pending file is WATCHED, not read once.
   *
   * `drainPendingProblemReports` used to be called from exactly one place: after first paint. So an
   * agent that used its reporting tool while the person was sitting in front of the console drew
   * its quiet "Reported a problem to the developers" row inside the turn and no card behind it,
   * until the page was loaded again. Jason, 2026-09-09, on the second of two reports Titan filed
   * in one turn: the row was there, the card never came, and the control plane has one report
   * where the console said two. Measured on grok-bot-local-vm the same day: both rows were in the
   * box's file at t+12 s and the open page drew nothing for thirty seconds.
   *
   * This rides the beat the console already runs -- the adapter's own subscribe, which fires on
   * the 900 ms debounced re-read and on the 15 s heartbeat -- with a floor under it, because a
   * drain is a gateway round trip and a busy conversation would otherwise ask the box for its
   * pending file several times a second. The floor is what makes this cheap; the cards are still
   * drawn one at a time, in the order the agent wrote them.
   *
   * The subscribe beat ALONE is not enough, and this was measured rather than reasoned: the
   * adapter's heartbeat re-reads the box every 15 s but only EMITS when something changed, so on
   * an idle console -- a person reading, nobody typing, the agent's turn already over -- no event
   * fires at all. Instrumented on grok-bot-local-vm in real Chrome, the subscribe handler on its
   * own made exactly ONE listProblemReports call in the forty seconds after a second report landed
   * in the box's file, and drew no card. So there is a standing beat at the adapter's own cadence
   * as well, and both paths go through the one floor below rather than asking twice.
   */
  const PENDING_POLL_MS = 4000;
  const PENDING_BEAT_MS = 15000;
  let pendingPolledAt = 0;
  let pendingPolling = false;
  function watchPendingProblemReports(now = Date.now()) {
    if (typeof adapter.listProblemReports !== "function") return Promise.resolve([]);
    if (pendingPolling || now - pendingPolledAt < PENDING_POLL_MS) return Promise.resolve([]);
    pendingPolling = true;
    pendingPolledAt = now;
    return drainPendingProblemReports()
      .then((made) => { if (made.length) renderTranscript(); return made; })
      .finally(() => { pendingPolling = false; });
  }
  // ---- end FEEDBACK-1 --------------------------------------------------------------------------

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
      // BOX-6b shares this one capsule rather than adding a second: two pills side by side on the
      // header would be two states competing for the same glance, and only one of them can be
      // acted on from here. Blocked on you wins when both are true -- that one is a person's job
      // and it is answerable in the composer right below it.
      const repair = !needsYou(record) && needsRepair(record);
      headerPill.hidden = !needsYou(record) && !repair;
      headerPill.textContent = repair ? "Needs repair" : "Waiting on you";
      headerPill.classList.toggle("needs-repair-pill", repair);
      headerPill.title = repair
        ? (typeof record.needsRepairReason === "string" && record.needsRepairReason.trim())
          || "This agent's conversation store needs repair. Open Agent details to repair it."
        : reason || "This agent is waiting on you";
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
    // CONSOLE-5: a backticked span is a chip a person can copy, not just monospace text. The class
    // is what the stylesheet hangs on; role and tabindex are what put the copy within reach of a
    // keyboard, and the delegated keydown handler further down answers them.
    //
    // THE CODE COMES OUT OF THE LINE BEFORE THE EMPHASIS PASSES AND GOES BACK AFTER THEM. Running
    // the chip replace first left the chip's own contents in front of the bold and italic patterns,
    // so `chmod +x *.sh *.py` came out as <code>chmod +x <em>.sh </em>.py</code> and the click
    // copied "chmod +x .sh .py" -- a command a person would paste and run. Two globs in one command
    // and a quoted draft holding **bold** are exactly what the persona sentence asks an agent to
    // backtick, so this was the common case, not a corner. A chip's text is the agent's text.
    //
    // The placeholder is a NUL either side of the index, and any NUL the agent wrote is dropped
    // first: a sentence that already held one could otherwise name a chip that is not there.
    const codes = [];
    return escapeHtml(line)
      .replace(/\u0000/g, "")
      .replace(/`([^`]+)`/g, (whole, code) => `\u0000${codes.push(code) - 1}\u0000`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      // The label is built from the code itself. "Copy this" was the element's whole accessible
      // name, which replaced its contents -- so every chip in a transcript announced itself as the
      // same anonymous button and the address, channel or hostname inside it was unreachable.
      .replace(/\u0000(\d+)\u0000/g, (whole, index) => {
        const code = codes[Number(index)] ?? "";
        return `<code class="code-chip" tabindex="0" role="button" aria-label="Copy ${code}">${code}</code>`;
      });
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

  // CONSOLE-5, the copy. Everything below here is deliberately AFTER paragraphMarkup's closing
  // brace: tests/machine-room-markdown.test.mjs and tests/machine-room-files.test.mjs both lift the
  // renderer out of this file by slicing from "  function inlineMarkup(line) {" to the first
  // "\n  }\n" after "  function paragraphMarkup(text) {", so a helper wedged between the two would
  // be pulled into their sandbox and both loaders would break.
  const CHIP_TICK_MS = 1200;

  // A screen reader hears the tick because the tick itself is generated content, which not every
  // reader announces. One polite region, made once, off screen, shared by every chip.
  let chipSpeaker = null;
  function announceChipCopy(said) {
    if (!chipSpeaker) {
      chipSpeaker = document.createElement("div");
      chipSpeaker.className = "chip-copy-live";
      chipSpeaker.setAttribute("role", "status");
      chipSpeaker.setAttribute("aria-live", "polite");
      document.body.appendChild(chipSpeaker);
    }
    // Set NOW when the word is changing, because a region that is empty for even a frame is a
    // region something else can read as nothing said -- the gate caught exactly that. Only a repeat
    // needs the clear first, since a reader announces a change and the same identifier copied twice
    // in a row is the ordinary case.
    if (chipSpeaker.textContent === said) {
      chipSpeaker.textContent = "";
      window.setTimeout(() => { if (chipSpeaker) chipSpeaker.textContent = said; }, 30);
      return;
    }
    chipSpeaker.textContent = said;
  }

  // navigator.clipboard needs a secure context. https and 127.0.0.1 have one; a relay reached over
  // plain http on a LAN address does not, and there the promise never arrives. This is the fallback
  // the composer's own paste path uses, and it works in both.
  function copyThroughSelection(text) {
    try {
      const pad = document.createElement("textarea");
      pad.value = text;
      pad.setAttribute("readonly", "readonly");
      pad.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
      document.body.appendChild(pad);
      pad.select();
      const done = document.execCommand("copy");
      pad.remove();
      return done === true;
    } catch { return false; }
  }

  function markChipCopied(chip, ok) {
    const flag = ok ? "data-copied" : "data-copy-failed";
    chip.setAttribute(flag, "");
    window.setTimeout(() => chip.removeAttribute(flag), CHIP_TICK_MS);
    // Said, not shouted: no global toast for a copy the person just asked for by clicking the
    // thing they wanted. The failure says what happened rather than showing a tick that lied.
    announceChipCopy(ok ? "Copied" : "This browser would not let the page copy that");
  }

  function copyCodeChip(chip) {
    // textContent, never a data attribute: escapeHtml runs before the backtick pass, so the markup
    // holds &amp; and &lt; while textContent is the original the agent wrote.
    const text = chip?.textContent ?? "";
    if (!text) return;
    const fallback = () => markChipCopied(chip, copyThroughSelection(text));
    if (navigator.clipboard?.writeText) {
      Promise.resolve(navigator.clipboard.writeText(text))
        .then(() => markChipCopied(chip, true), fallback);
      return;
    }
    fallback();
  }

  const chipFromEvent = (event) => event.target?.closest?.("code.code-chip") ?? null;
  const isActivationKey = (event) => event.key === "Enter" || event.key === " " || event.key === "Spacebar";


  // COMMAND-CARD-1: the auto-review row is Allow / Always allow / Refuse, in the person's words.
  // "Always allow" is drawn only when the host proposed a rule to add, because with no rule there
  // is nothing to write into the settings and a button that cannot do its own name is worse than a
  // button that is absent. The host's own vocabulary is still only approved|denied
  // (source/host/runner/sand-auto-review.ts): "always" is this console's word for a settings write
  // followed by an approve, and the adapter is where those two calls live.
  const DECISION_ACTIONS = {
    "auto-review": [["approved", "✓ Allow", true], ["always", "↗ Always allow", false], ["denied", "✕ Refuse", false]],
    "local-tool": [["allow-once", "✓ Allow once", true], ["always", "↗ Always allow", false], ["deny", "✕ Deny", false]],
  };

  // SECRET-1: the custody line under the masked field is NOT one sentence for every destination.
  // A connector or chat credential really does land somewhere the agent cannot read back, so
  // "never shown to your agent" is true there. The reserved "shell" connector is the opposite by
  // construction: the whole point is that the value becomes an environment variable of the shell
  // the agent runs its commands in, so `echo $FIELD` returns it. Printing the same promise on that
  // card is a custody claim the product cannot keep, so the shell card says where the value really
  // ends up and stops at what IS true, that it never enters this chat.
  const isShellSecretCard = (card) => typeof card.platform === "string" && card.platform.trim().toLowerCase() === "shell";
  function secretCustodyHint(card) {
    if (!isShellSecretCard(card)) return "Stored securely, never shown to your agent.";
    return `Stored securely and never shown in this chat. It becomes $${String(card.field ?? "credential")} in this agent's shell, so commands it runs can read it.`;
  }

  // ---- COMMAND-CARD-1: the approval card, in the shape Jason kept a screenshot of ---------------
  //
  // The original's card for a shell command, top to bottom: a title naming what the bot wants, a
  // pill in the top right carrying the decision, a grey line saying whose computer it runs on, the
  // request as one plain sentence, a grey paragraph naming the standing rule when one decided it,
  // and a "Show the command" disclosure holding the command with its middle elided. Jason, on the
  // screenshot: "which I thought was cool." Our card carried the request and two buttons and none
  // of the rest, so a person could not see what they were allowing, could not see it afterwards,
  // and had no way to say yes to this shape of thing once and for all.
  //
  // WHERE EACH LINE COMES FROM. The title is the surface. The request sentence is the host's own
  // approval.summary with its trailing location clause taken off. The grey line is that clause,
  // rewritten with this agent's name. The command and the reason are approval.command and
  // approval.reason, which the adapter now carries separately instead of joining them into one
  // string. The rule is approval.proposedRule, which most approvals do not have.
  const APPROVAL_COMMAND_CAP = 400;

  // The host's surface tokens are snake_case at the request sites (host_shell, box_shell, mcp,
  // computer, browser, automation_write, cloud_agent, subagent) whatever the type union says, and
  // none of them is a word to put on a customer's screen.
  const APPROVAL_WANTS = {
    host_shell: "wants to run a command",
    box_shell: "wants to run a command",
    mcp: "wants to use a connector",
    computer: "wants to use the computer",
    browser: "wants to use the browser",
    automation_write: "wants to change a routine",
    cloud_agent: "wants to run a cloud agent",
    subagent: "wants to start a task",
  };
  const approvalWants = (surface) => APPROVAL_WANTS[String(surface ?? "")] ?? "wants your review";

  // host_shell is the person's own machine; everything else is the box the agent lives on.
  const approvalWhere = (surface, who) => (String(surface ?? "") === "host_shell"
    ? "Runs on your computer"
    : `Runs on ${who}'s computer`);

  // The host writes the location into its own summary, and it writes it with the OLD product's name
  // in it -- "… on Grok Bot's computer" appears five times in
  // source/host/runner/sand-auto-review-summaries.ts, and it lands in this card's title and in the
  // title a push notification puts on a lock screen. The clause is the grey line's job here, so it
  // comes off the sentence, which both restores the original's shape and takes a dead vendor's name
  // off a customer's screen. The five host strings are their own row; this is the console half.
  // Not end-anchored: TWO of the host's summaries write the location mid-sentence. The subagent one
  // writes "Run a task on Grok Bot's computer: “<instruction>”", and the shell one appends the working
  // directory AFTER the clause -- describeSandShellAutoReviewAction builds `${head} ${location} from
  // ${cwd}` whenever the agent passed a cwd, which is the ordinary shell call, so the commonest card
  // of all read "Echo hello on Grok Bot's computer from /workspace" while an end anchor, and then an
  // anchor that only looked for a colon or a comma, both walked past it. The clause comes off at the
  // end of the sentence (taking its full stop with it), before a colon or a comma, and before the
  // " from <cwd>" the host writes after it. Those are the three shapes the host has; a following word
  // it does NOT write is left alone, so "Walk on Titan's computer floor" keeps every word.
  const APPROVAL_WHERE_CLAUSE = /\s+on\s+(?:your local computer|[A-Za-z0-9 ._-]{1,40}'s computer)(?:\.?$|(?=\s*[:,])|(?=\s+from\s))/i;
  const approvalRequestSentence = (card) => String(card.title ?? "").replace(APPROVAL_WHERE_CLAUSE, "").trim()
    || "This action needs your review";

  // What goes on a lock screen. Only the auto-review card has a clause to strip; every other kind
  // keeps the title the relay already pushes for it.
  const cardPushTitle = (card) => (card.kind === "auto-review" ? approvalRequestSentence(card) : card.title);

  // The original elides the middle and counts what it dropped: "...[353 chars omitted]...". The cap
  // is what is SHOWN, so the count is the real remainder and adding the two back gives the command.
  function approvalCommandShown(command) {
    const text = String(command ?? "");
    if (text.length <= APPROVAL_COMMAND_CAP) return text;
    const head = Math.ceil(APPROVAL_COMMAND_CAP / 2);
    const tail = APPROVAL_COMMAND_CAP - head;
    return `${text.slice(0, head)}\n...[${text.length - APPROVAL_COMMAND_CAP} chars omitted]...\n${text.slice(text.length - tail)}`;
  }

  // Five states, and the two green ones are not the same sentence. "Always allowed" is claimed only
  // when a standing rule really is in the person's Auto-review settings -- the adapter hands the
  // saved allow list in, and the claim is that this approval's own proposed rule is on it. Anything
  // else that was approved was approved by hand, once.
  //
  // ONLY "denied" READS REFUSED. "expired" is a status the HOST writes by itself and in bulk:
  // expireAllPendingAutoReviewApprovalCards() runs at host start, so a bundle swap, a restart, a
  // session end, a settings change or a cancel all turn every unanswered card in a transcript into
  // one -- and telling a person they refused something they never saw is a lie the page tells about
  // them. Everything that is not pending, approved or denied is the host closing the question.
  function approvalPill(status, ruleSaved) {
    if (status === "pending") return '<span class="status-pill attention" data-approval-pill>Needs your yes</span>';
    if (status === "approved") {
      return ruleSaved
        ? '<span class="status-pill success" data-approval-pill>Always allowed</span>'
        : '<span class="status-pill success" data-approval-pill>Allowed once</span>';
    }
    if (status === "denied") return '<span class="status-pill muted" data-approval-pill>Refused</span>';
    return '<span class="status-pill muted" data-approval-pill>No longer waiting</span>';
  }

  // The whole card, in every state. A settled card keeps the request, the rule and the command:
  // the branch this replaced threw all three away and left "You approved this", so a person had no
  // way to see afterwards what it was they had allowed.
  function approvalCardMarkup(message, card, hook, allowRules, escapeHtml) {
    const status = String(card.status ?? "pending");
    const pending = status === "pending";
    const who = String(message.authorName ?? "").trim() || "your agent";
    const rule = typeof card.rule === "string" && card.rule.trim().length > 0 ? card.rule.trim() : "";
    const ruleSaved = rule.length > 0 && (allowRules ?? []).some((entry) => String(entry).trim() === rule);
    const accent = pending ? "var(--amber-500)" : status === "approved" ? "var(--green-500)" : "var(--stone-500)";
    const command = typeof card.command === "string" ? card.command : "";
    // The other half of the pill above: a card the host closed says so in words, the way the
    // sibling kinds in decisionMarkup have always said "Closed by the host".
    const closed = !pending && status !== "approved" && status !== "denied"
      ? '<p class="approval-closed">The host closed this without an answer.</p>'
      : "";
    // Only while it is still a question. Once it is settled the reason is why it was ASKED, and on a
    // card the person already answered it reads as a complaint about their answer.
    const reason = pending && typeof card.reason === "string" ? card.reason.trim() : "";
    // No script behind the toggle: <details> already opens and closes, and the two words swap on
    // [open] in the stylesheet. The transcript wipes its own innerHTML on every render, so a handler
    // bound to this element would not survive anyway.
    const disclosure = command.length === 0 ? ""
      : `<details class="tool-receipt approval-command"><summary><span class="approval-more-show">Show the command</span><span class="approval-more-hide">Hide the command</span></summary><pre>${escapeHtml(approvalCommandShown(command))}</pre></details>`;
    // Past tense only when it is true. A pending card says what the button WOULD do; a settled card
    // whose rule was never saved says nothing at all, rather than implying a standing rule exists.
    const rulePara = rule.length === 0 ? ""
      : ruleSaved
        ? `<p class="approval-rule">A rule always allowing this was added to your Auto-review settings: “${escapeHtml(rule)}”</p>`
        : pending
          ? `<p class="approval-rule">Always allow adds this rule to your Auto-review settings: “${escapeHtml(rule)}”</p>`
          : "";
    const actions = !pending ? ""
      : `<div class="inline-card-actions">${DECISION_ACTIONS["auto-review"]
        .filter(([value]) => value !== "always" || rule.length > 0)
        .map(([value, label, primary]) => `<button class="card-action${primary ? " primary" : ""}" type="button" data-decide="${escapeHtml(value)}" data-message-id="${escapeHtml(message.id)}">${escapeHtml(label)}</button>`)
        .join("")}</div>`;
    return `<div class="inline-card approval-card"${hook} data-approval-card data-approval-state="${escapeHtml(status)}" data-approval-surface="${escapeHtml(String(card.surface ?? ""))}" style="--card-accent:${accent}">`
      + `<div class="approval-card-head"><strong>${escapeHtml(`${who} ${approvalWants(card.surface)}`)}</strong>${approvalPill(status, ruleSaved)}</div>`
      + `<p class="approval-where">${escapeHtml(approvalWhere(card.surface, who))}</p>`
      + `<p class="approval-request">${escapeHtml(approvalRequestSentence(card))}</p>`
      + (reason.length > 0 ? `<p class="approval-why">${escapeHtml(reason)}</p>` : "")
      + closed + rulePara + disclosure + actions
      + `</div>`;
  }

  // ---- CONSOLE-ATTR-1: the hooks a shell reads off this page when it has no bearer yet ----------
  //
  // The desktop shell loads this console in its window and, until a device is signed in, has no token
  // and no route -- so an injected script reads the DOM. Three attributes are the whole contract
  // (docs/APPS.md section 6): the count on the roster pill, this set on every PENDING card, and
  // data-talk-button on the talk button in index.html.
  //
  // A SIGNED-IN SHELL SHOULD ASK GET /push/pending INSTEAD. This page only ever draws the open
  // conversation, so the marked nodes are a partial list by construction and the number moves as the
  // person clicks around. The route is the authority; this is the fallback.
  //
  // WHAT THIS IS CAREFUL ABOUT, because each one is a way to be wrong quietly:
  //
  //   A DEAD DEEP LINK. The shell opens /?agent=&entry=, so an agent id that is really the literal
  //   "agent" (gateway-adapter.js's fallback when the host sent no author), the person's own "you",
  //   or an index-based `entry-<n>` id (the adapter's fallback when the host sent no entry id, which
  //   is not stable across a re-read and is not an id the relay knows) has to carry NO attribute
  //   rather than a link that lands nowhere. The whole set goes or none of it does, so absence means
  //   "the relay cannot push this", never "this is not pending".
  //
  //   data-card-id IS REQUIRED BY THE READER. It drops any card without one, so emitting
  //   data-needs-you-card alone would be a node the shell counts and cannot open.
  //
  //   data-title IS THE RELAY'S OWN TITLE. For a hand-off that is "Take the keyboard for <agent>" and
  //   never entry.boxInstruction, which is the agent-written sentence this card displays on screen and
  //   which ui/push-edge.mjs rule 5 exists to keep off a lock screen. A tray is a lock screen with a
  //   different shape.
  //
  //   THE AGENT IS THE CONVERSATION, not the entry's author. The link's job is to open the card where
  //   the person can answer it, and that is the conversation they are looking at. In a room the
  //   author is a member agent and the first member is not the room, so both of those mint a link to
  //   somewhere the card is not; the context id opens the room, which is where the card is drawn.
  //
  // escapeHtml is an argument so this stays sliceable for a test, the way handoffCardMarkup is.
  function needsYouCardAttrs(escapeHtml, { kind, agentId, entryId, agentName, title }) {
    // The six kinds the relay pushes, in push-edge.mjs's own order. The seventh thing that looks like
    // a card here is the skill draft, which is not a question and is never pushed.
    const PUSHED_KINDS = ["auto-review", "local-tool", "widget", "secret", "box-handoff", "report"];
    if (!PUSHED_KINDS.includes(typeof kind === "string" ? kind : "")) return "";
    const agent = typeof agentId === "string" ? agentId.trim() : "";
    const entry = typeof entryId === "string" ? entryId.trim() : "";
    if (agent.length === 0 || agent === "agent" || agent === "you") return "";
    if (entry.length === 0 || /^entry-\d+$/.test(entry)) return "";
    // One id in one spelling on both attributes: the marker carries the agent and the entry the brief
    // asks for, and the reader's required data-card-id is the same string, so neither side parses.
    const id = `${agent}:${entry}`;
    // A console path, which is the only href shape the shell's reader accepts; anything else it drops.
    const href = `/?agent=${encodeURIComponent(agent)}&entry=${encodeURIComponent(entry)}`;
    const named = typeof title === "string" ? title.trim() : "";
    const who = (typeof agentName === "string" ? agentName.trim() : "") || agent;
    return ` data-needs-you-card="${escapeHtml(id)}" data-card-id="${escapeHtml(id)}"`
      + ` data-card-kind="${escapeHtml(kind)}" data-agent="${escapeHtml(who)}"`
      + (named.length > 0 ? ` data-title="${escapeHtml(named)}"` : "")
      + ` data-href="${escapeHtml(href)}"`;
  }
  // ---- end CONSOLE-ATTR-1 --------------------------------------------------------------

  function decisionMarkup(message, allowRules = []) {
    const card = message.card;
    // CONSOLE-ATTR-1, hoisted so there is still exactly ONE call site in this function: every
    // return below that draws a settled card or an answer in flight gets the empty string, because a
    // shell counting those would be a tray showing work nobody has to do. Four of the six push kinds
    // come through here (auto-review, local-tool, widget, secret) and the title is the one the relay
    // puts in the notification -- with the auto-review card's location clause taken off it, so the
    // old product's name does not travel to a lock screen.
    const hook = card.status && card.status !== "pending"
      ? ""
      : needsYouCardAttrs(escapeHtml, { kind: card.kind, agentId: activeContext().id, entryId: message.id, agentName: contextName(), title: cardPushTitle(card) });
    if (card.status === "sending") {
      // cardPushTitle, not card.title: on an auto-review card the raw title is the host's own summary
      // with "on Grok Bot's computer" in it, which is the one string the rest of this card exists to
      // clean up. This state is held for a whole round trip on Allow and Refuse and for three
      // gateway calls on Always allow, so it is a screen a person reads, not a flicker.
      return `<div class="inline-card" style="--card-accent:var(--teal-500)"><div class="inline-card-header"><span class="inline-card-icon">◌</span><span class="inline-card-copy"><strong>${escapeHtml(cardPushTitle(card))}</strong><small class="approval-result">Sending your answer…</small></span></div></div>`;
    }
    // SECRET-1: the answered credential card collapses to one line and a green pill, the way the
    // original product's card does. Nothing about the value is on screen -- the card says the value
    // was kept private, and the only thing the page ever held was the input's `value`, cleared on
    // submit and never written into markup.
    if (card.kind === "secret" && card.status === "provided") {
      return `<div class="inline-card secret-card" style="--card-accent:var(--green-500)"><div class="inline-card-header"><span class="inline-card-icon">\u2713</span><span class="inline-card-copy"><strong>${escapeHtml(card.title)}</strong><small class="approval-result">Saved securely and kept private.</small></span><span class="status-pill success secret-saved-pill">\u2713 Saved</span></div></div>`;
    }
    // COMMAND-CARD-1: the auto-review card is drawn whole, in every state, by one function. It is
    // taken before the generic settled branch below on purpose -- that branch collapses a card to a
    // title and "You approved this", and what a person needs afterwards is the command they allowed
    // and the rule they granted.
    if (card.kind === "auto-review") return approvalCardMarkup(message, card, hook, allowRules, escapeHtml);
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
          // SECRET-1: the copy is the original product's, word for word -- the masked field, the
          // hint that says where the value does NOT go, and "Save securely" on the button. The
          // hint is `aria-describedby` on the input so a screen reader reads the custody promise
          // with the field rather than after it.
          ? `<div class="field"><label class="sr-only" for="secret-input-${escapeHtml(message.id)}">${escapeHtml(card.field ?? "credential")}</label><input id="secret-input-${escapeHtml(message.id)}" data-secret-input="${escapeHtml(message.id)}" type="password" autocomplete="off" aria-describedby="secret-hint-${escapeHtml(message.id)}" placeholder="${escapeHtml(card.field ?? "credential")}" /><small class="field-hint secret-hint" id="secret-hint-${escapeHtml(message.id)}">${escapeHtml(secretCustodyHint(card))}</small></div><button class="card-action primary" type="button" data-submit-secret="${escapeHtml(message.id)}">Save securely</button>`
          : `<span class="field-hint">Answer this in the host app. This page has no command to carry a credential to it.</span>`;
    return `<div class="inline-card"${hook} style="--card-accent:var(--amber-500)"><div class="inline-card-header"><span class="inline-card-icon">▣</span><span class="inline-card-copy"><strong>${escapeHtml(card.title)}</strong><small>${escapeHtml(card.detail || "The agent is blocked until you answer.")}</small></span>${dismiss}</div>${card.rule ? `<div class="tag-list"><span class="tag">would add rule · ${escapeHtml(card.rule)}</span></div>` : ""}<div class="inline-card-actions">${actions}</div></div>`;
  }

  // Whose attachments these are. The host's read commands take the agent, and a room's files
  // belong to whichever member the conversation leads with -- one expression, used by the markup
  // that offers the controls and by every read behind them, so a file cannot be listed under one
  // agent and fetched under another.
  function attachmentAgentId() {
    const context = activeContext();
    if (context.kind === "worker") return context.id;
    return (contextRecord()?.memberIds ?? [])[0] ?? "";
  }

  // GW-09: a file in the transcript. The markup is a slot; fillAttachments asks the host for the
  // bytes after the render (readAttachmentImage for an image, readAttachmentText for anything
  // else) so nothing here is drawn from the path alone.
  function attachmentMarkup(message) {
    const a = message.attachment;
    const body = a.kind === "image"
      ? `<div class="attachment-slot" data-attachment-slot>Reading ${escapeHtml(a.name)} from the host…</div>`
      : `<pre class="attachment-preview" data-attachment-slot>Reading ${escapeHtml(a.name)} from the host…</pre>`;
    // CONSOLE-4 seam: Open and Download, beside the caption. Jason, 2026-09-08: "I can't click,
    // open, or view it." Both route to the file viewer (files-viewer.js, item D) through the same
    // delegated funnel as the desktop's file tiles, so one place decides what opening a file means.
    const controls = `<span class="attachment-controls">`
      + `<button class="ghost-button attachment-open" type="button" data-attachment-open="${escapeHtml(a.path)}" data-attachment-agent="${escapeHtml(attachmentAgentId())}" data-attachment-name="${escapeHtml(a.name)}">Open</button>`
      + `<button class="ghost-button attachment-download" type="button" data-attachment-download="${escapeHtml(a.path)}" data-attachment-agent="${escapeHtml(attachmentAgentId())}" data-attachment-name="${escapeHtml(a.name)}">Download</button>`
      + `</span>`;
    return `<figure class="message-attachment" data-attachment="${escapeHtml(a.path)}" data-attachment-kind="${escapeHtml(a.kind)}" data-attachment-name="${escapeHtml(a.name)}"><figcaption><span class="tag">▱ ${escapeHtml(a.name)}</span>${controls}</figcaption>${body}</figure>`;
  }

  // ---- HANDBACK-1: the computer hand-off ------------------------------------------------------
  // request_box_help parks the agent and asks a person to do one thing on its screen. The durable
  // half is one transcript entry (boxRequestId / boxInstruction / boxResolution); the live half is
  // the host's pending record, which reaches this page as the open agent's `handoff`. The card
  // trusts neither alone, because they disagree in the two cases that matter: a host restart loses
  // the live record while the entry is still unresolved, and a second request silently resolves the
  // first entry as dismissed. So the state is f(resolution, live), and there are four of them.
  //
  //   live hand-off with this entry's requestId          -> pending  "Action needed"
  //   no live match, resolution handed_back | completed  -> done     "Done"
  //   no live match, resolution dismissed  | cancelled   -> skipped  "Skipped"
  //   no live match, no resolution, or a word nobody set -> closed   "No longer waiting"
  //
  // completed and cancelled are the words the old code path wrote for a done and a skip that were
  // indistinguishable; they are aliased here rather than migrated on disk. The fourth state is not
  // decoration: without it the card either offers buttons aimed at a host that has forgotten the
  // request, or reads Done on a step nobody did.
  function boxHandoffState(handoff, live) {
    if (!handoff) return "closed";
    if (live && live.requestId === handoff.requestId) return "pending";
    const resolution = handoff.resolution;
    if (resolution === "handed_back" || resolution === "completed") return "done";
    if (resolution === "dismissed" || resolution === "cancelled") return "skipped";
    return "closed";
  }

  // Fixed 390x244 -- the plate is the same size whether or not a frame has landed, so a thumbnail
  // arriving three seconds into a read cannot reflow the transcript under the reader.
  const BOX_HANDOFF_THUMB_W = 390;
  const BOX_HANDOFF_THUMB_H = 244;

  // escapeHtml and the flags come in as arguments so this stays testable on its own: the harness
  // slices the function out of this file and evals it in a bare Function. `skipSupported` is false
  // on a host that does not know skipBoxHandoff, where no Skip control is drawn at all rather than
  // one that would lie. `view` is what only the live page can answer: {live} the open agent's
  // pending hand-off or null, {frame} the newest thumbnail data URL or "", {agentId} whose screen
  // this is, {hasScreen} false only when the box has told us it has none.
  function handoffCardMarkup(message, escapeHtml, skipSupported, view = {}) {
    const handoff = message.handoff ?? {};
    const state = boxHandoffState(handoff, view.live ?? null);
    const requestId = handoff.requestId ?? "";
    const agentId = view.agentId ?? "";
    const frame = view.frame ?? "";
    const instruction = handoff.instruction || "It did not say what it needs done.";
    const pill = state === "pending"
      ? '<span class="status-pill attention" data-handoff-pill><span class="status-dot working"></span>Action needed</span>'
      : state === "done"
        ? '<span class="status-pill success" data-handoff-pill>Done</span>'
        : state === "skipped"
          ? '<span class="status-pill muted" data-handoff-pill>Skipped</span>'
          : '<span class="status-pill muted" data-handoff-pill>No longer waiting</span>';
    const attrs = `data-agent-id="${escapeHtml(agentId)}" data-request-id="${escapeHtml(requestId)}"`;
    // The image is ALWAYS in the markup, hidden until a frame lands, with the plate behind it --
    // exactly the shape the rail tile uses. Drawing the plate alone until the first frame meant the
    // reader had nowhere to put that frame: it writes into the img and there was none, so the card
    // stayed empty until some unrelated redraw happened to rebuild it. Measured on
    // grok-bot-local-vm: the picture reached the rail tile in seconds and the card not at all
    // inside a minute, then late on a heartbeat.
    //
    // The plate is chosen from the STATE, the way the pill is. It used to be chosen from hasScreen
    // alone, so a finished step in a browser that never captured a frame -- a reload, or an I'm
    // done pressed inside the first three seconds -- sat on "Bringing the screen up" for good, on a
    // card whose own pill said Done. Nothing was coming. Telling a person to wait for something
    // that will never arrive is the kind of line that gets read as a fault in the product.
    const plateText = state === "pending"
      ? (view.hasScreen === false ? "This computer did not say which screen this agent is on" : "Bringing the screen up")
      : "No picture of this step was kept";
    const plate = `<span class="handoff-thumb-plate" data-handoff-thumb-plate${frame ? " hidden" : ""}>${escapeHtml(plateText)}</span>`
      + `<img class="handoff-thumb" data-handoff-thumb data-agent-id="${escapeHtml(agentId)}" data-request-id="${escapeHtml(requestId)}" width="${BOX_HANDOFF_THUMB_W}" height="${BOX_HANDOFF_THUMB_H}"${frame ? ` src="${escapeHtml(frame)}"` : ""}${frame ? "" : " hidden"} alt="What is on this agent's screen right now" />`;
    const actions = state === "pending"
      ? `<button class="card-action primary" type="button" data-handoff-action="take-over" ${attrs}>Take over</button>`
        + `<button class="card-action" type="button" data-handoff-action="done" ${attrs}>I'm done</button>`
        + (skipSupported ? `<button class="handoff-skip-link" type="button" data-handoff-action="skip" ${attrs}>Skip</button>` : "")
      : `<button class="card-action" type="button" data-handoff-action="open" ${attrs}><span aria-hidden="true">&#9635;</span> Open computer</button>`;
    // CONSOLE-ATTR-1. Only a pending hand-off is a card a person still has to act on, and the title is
    // the RELAY's own fixed sentence rather than `instruction`, which the agent wrote and which
    // ui/push-edge.mjs deliberately never sends. The entry id is message.id, not requestId: the relay
    // keys a box-handoff card on the transcript entry and carries the requestId separately.
    // The rail's copy of this same hand-off (renderHandoffRail) carries nothing, or every open
    // hand-off would count twice.
    const agentName = view.agentName ?? "";
    const hook = state === "pending"
      ? needsYouCardAttrs(escapeHtml, {
        kind: "box-handoff",
        agentId: view.contextId ?? "",
        entryId: message.id,
        agentName,
        title: `Take the keyboard for ${String(agentName).trim() || "your agent"}`,
      })
      : "";
    return `<div class="inline-card handoff-card" data-handoff-card${hook} data-state="${escapeHtml(state)}" data-request-id="${escapeHtml(requestId)}" data-agent-id="${escapeHtml(agentId)}" style="--card-accent:${state === "pending" ? "var(--amber-500)" : state === "done" ? "var(--green-500)" : "var(--stone-500)"}">`
      + `<div class="handoff-card-head"><strong>Computer</strong>${pill}</div>`
      + `<p class="handoff-instruction" data-handoff-instruction>${escapeHtml(instruction)}</p>`
      + `<div class="handoff-thumb-frame" style="width:${BOX_HANDOFF_THUMB_W}px;height:${BOX_HANDOFF_THUMB_H}px">${plate}</div>`
      + `<div class="inline-card-actions handoff-card-actions">${actions}</div>`
      + `</div>`;
  }

  // The standing Always-allowed rules the host is holding right now, as this page last read them
  // (gateway-adapter.js fills them from getHostSettings on every load). An empty list is the honest
  // answer for a host that could not be reached: the card then says "Allowed once", which claims
  // less than the truth rather than more.
  const savedAllowRules = () => state.settings?.autoReview?.allow ?? [];

  function specialMessageMarkup(message) {
    // COMMAND-CARD-1: the allow list is read at RENDER time, not when the transcript was mapped.
    // A person who presses Always allow gets the settings write, then the approve, then a reload;
    // the card that comes back has to say "Always allowed" on that first repaint, and only the live
    // settings can tell it so. decisionMarkup itself stays a pure function of what it is handed.
    if (message.type === "decision") return decisionMarkup(message, savedAllowRules());
    if (message.type === "handoff") return handoffCardMarkup(message, escapeHtml, boxHandoffSkipSupported(), boxHandoffView(message));
    if (message.type === "skill") return `<div class="inline-card" style="--card-accent:var(--violet-500)"><div class="inline-card-header"><span class="inline-card-icon">✦</span><span class="inline-card-copy"><strong>${escapeHtml(message.title)}</strong><small>${escapeHtml(message.description)}</small></span></div><div class="tag-list"><span class="tag">skill draft</span><span class="tag">recording attached</span><span class="tag">review required</span></div></div>`;
    return "";
  }

  // What the claim-provenance check is, in one sentence, on every chip. The operator who found
  // the old system line read it as an error, so the chip has to say what it is on hover.
  const EVIDENCE_CHECK = "Titanbot compares the names, paths and links in a reply with what its tools returned in the same turn.";
  const EVIDENCE_COPY = {
    evidenced: (stamp) => {
      // The verdict is decided against the attested tool results, never the action receipts:
      // receipts count shell and MCP actions only, so a reply backed by read or browser results
      // has receipts 0 and would have read "Backed by 0 tool results" here. decideVerdict returns
      // "unverified" when nothing was attested, so on this verdict the count is never 0; the
      // wordless form is only for a stamp too old to carry the list.
      const n = (stamp.attestations ?? []).length;
      return { text: n ? `\u2713 Backed by ${n} tool result${n === 1 ? "" : "s"}` : "\u2713 Backed by the tool results", title: "" };
    },
    unsupported: (stamp) => {
      const n = (stamp.missing ?? []).length;
      return {
        text: n ? `${n} detail${n === 1 ? "" : "s"} not backed by a tool result` : "A detail not backed by a tool result",
        title: "The reply was delivered. A link, path or value in it was not found in any tool result of this turn. Open to see which.",
      };
    },
    unverified: () => ({ text: "Nothing ran to check this", title: "" }),
    // Not the reply: this verdict fires when an attestation head ran past the length the check
    // reads (evidence-verdict.ts), so what was cut is a tool result. Saying "output" left the
    // operator reading it as the reply itself having been truncated.
    undecidable: () => ({
      text: "A tool result was too long to check",
      title: "The reply itself is complete. One tool result ran past the length the check reads, so part of the reply could not be matched against it.",
    }),
  };

  // GW-13 / EVID-UX-1: the verdict, drawn inside the reply's own row. Never the missing token
  // itself -- the line this replaced printed a signed caption URL under the reply and an operator
  // read the whole row as an error. The tokens live in the Claim provenance panel the chip opens.
  // "conversational" means the reply asserted nothing checkable, so it carries no chip at all.
  function evidenceChipMarkup(message) {
    const stamp = message.evidence;
    const copy = stamp && EVIDENCE_COPY[stamp.verdict];
    if (!copy) return "";
    const { text, title } = copy(stamp);
    const attrs = `class="evidence-chip" data-verdict="${escapeHtml(stamp.verdict)}" title="${escapeHtml(title ? `${title} ${EVIDENCE_CHECK}` : EVIDENCE_CHECK)}"`;
    // No attemptId means the host stamped a verdict whose receipts it cannot serve, so the chip
    // states the verdict and is not a control that would open an empty panel.
    if (!stamp.attemptId) return `<span ${attrs}><span>${escapeHtml(text)}</span></span>`;
    return `<button type="button" ${attrs} data-evidence="1" data-message-id="${escapeHtml(message.id)}"><span>${escapeHtml(text)}</span></button>`;
  }

  // In a room the face sits at the foot of a long bubble and the small name line at its head, so a
  // reader looking at the face does not know who spoke (Jason, 2026-09-07 13:38). The speaker's
  // name goes under the face there. A direct conversation has one speaker and needs no caption.
  function roomSpeakerMarkup(author, message) {
    const face = avatarMarkup(author, "message-avatar");
    if (activeContext()?.kind !== "room" || message.type === "working") return face;
    const who = message.authorName || (author && author.name) || "";
    if (!who) return face;
    return `<div class="message-side">${face}<small class="message-who">${escapeHtml(who)}</small></div>`;
  }

  // A subagent at work draws one "Computer · running" row per step, and a tab-reading job drew
  // seventeen of them in a column (Jason, 2026-09-07 22:11: "It could just be one badge ... add a
  // count"). Consecutive system rows that say the same thing and carry no receipt fold into one row
  // that says how many. A row with a receipt (a shell command and its output) stays its own row,
  // because folding it would hide a receipt; so does a peer exchange.
  function foldRepeatedRows(messages) {
    const out = [];
    for (const message of messages) {
      const last = out[out.length - 1];
      const foldable = message.type === "system" && !message.detail && !message.exchange;
      if (foldable && last && last.type === "system" && !last.detail && !last.exchange && last.text === message.text) {
        out[out.length - 1] = { ...message, count: (last.count ?? 1) + 1 };
      } else {
        out.push(message);
      }
    }
    return out;
  }

  function messageMarkup(message) {
    // UX-ERR-1. A failed turn, in one quiet line under the message it failed on.
    //
    // Jason's report was "it popped up like he was talking, then it went away. I don't see any
    // errors" -- the failure existed only in the host log. This is deliberately not a toast and
    // not a red banner: it stays in the transcript where the conversation is, so it is still there
    // when he scrolls back tomorrow. The host wrote the sentence; nothing is composed here, and
    // there is no stack to reveal.
    if (message.type === "turn-failed") {
      return `<article class="message-row is-turn-failed" data-message-id="${escapeHtml(message.id)}" data-turn-failed="1"><div class="message-bubble turn-failed-note">${escapeHtml(message.text)}</div></article>`;
    }
    if (message.type === "system") {
      // SHOT-4: a tool row the adapter summarised in words carries the verbatim command and output
      // as its detail. The row opens to show them, so the receipt is one click away and never gone.
      if (message.detail) {
        return `<article class="message-row is-system" data-message-id="${escapeHtml(message.id)}"><details class="message-bubble tool-receipt"><summary>${escapeHtml(message.text)}</summary><pre>${escapeHtml(message.detail)}</pre></details></article>`;
      }
      return `<article class="message-row is-system${message.exchange ? " is-exchange" : ""}" data-message-id="${escapeHtml(message.id)}"${message.exchange ? ' data-exchange="1" role="button" tabindex="0"' : ""}><div class="message-bubble">${escapeHtml(message.count > 1 ? `${message.text} · ${message.count} steps` : message.text)}</div></article>`;
    }
    const isUser = message.authorId === "you";
    const author = workerById(message.authorId);
    const isWorking = message.type === "working";
    const body = isWorking ? `<div class="typing-dots" aria-label="${escapeHtml(message.authorName)} is working"><i></i><i></i><i></i></div>`
      // CONSOLE-4: a message can carry more than one file. Ten of Titan's eleven transcript files
      // ride the {type:"text", images:[…]} carrier that SendMessage's own tool description tells
      // the model to use, and that carrier is a LIST. Each figure gets its own [data-attachment]
      // path, which is what fillAttachments and the file viewer key off, so nothing else changes.
      : message.type === "attachment" && message.attachment
        ? `${paragraphMarkup(message.text)}${(message.attachments ?? [message.attachment]).map((a) => attachmentMarkup({ ...message, attachment: a })).join("")}`
      : `${paragraphMarkup(message.text)}${specialMessageMarkup(message)}`;
    return `<article class="message-row${isUser ? " is-user" : ""}${isWorking ? " working-message" : ""}" data-message-id="${escapeHtml(message.id)}">${!isUser ? roomSpeakerMarkup(author, message) : ""}<div class="message-block"><div class="message-meta"><strong>${escapeHtml(message.authorName || (author && author.name) || "Worker")}</strong><time>${escapeHtml(message.time || "now")}</time></div><div class="message-bubble">${body}</div>${message.spoken ? `<span class="voice-spoken-chip">Spoken</span>` : ""}${evidenceChipMarkup(message)}</div></article>`;
  }

  // The transcript is a tail window; the row above it says the host holds more and offers to
  // page it in (GW-03). Scrolling to the top asks for the same page.
  function transcriptMarkup() {
    const record = contextRecord();
    const older = record?.hasOlder && typeof adapter.loadOlderMessages === "function"
      ? `<div class="transcript-older"><button class="ghost-button" type="button" data-load-older>Show earlier messages</button></div>`
      : "";
    // CONSOLE-4 seam: everything between two chat messages folds into one badge per gap
    // (gap-badge.js, item B). DASH-FOLD-1's step-count folding runs first and stays inside the
    // expanded view. With the module absent this is today's transcript, row for row.
    // FEEDBACK-2b: the folded report rows go in with the messages, before the repeat fold and the
    // gap badge see them, so each is laid out where the report happened and a later message lands
    // below it. They carry an authorId, which is what gap-badge.js reads to tell a thing said to
    // the person from a step done for them, so neither folds one into a gap.
    const rows = foldRepeatedRows(withFoldedReportRows(contextMessages()));
    const gaps = window.__gapBadge;
    // FEEDBACK-1: the offer cards for this conversation sit at the end, under the message that
    // caused them. They are page-local and are not transcript entries, which is the honest cost of
    // building the offer on the only failure signal that actually fires (see the block above).
    return older + (gaps && typeof gaps.render === "function"
      ? gaps.render(rows, messageMarkup, { agentId: contextLead()?.id ?? null, working: (record?.status ?? "") === "working" })
      : rows.map(messageMarkup).join("")) + reportCardsMarkup();
  }

  // A row just revealed (a search hit) holds the reader on it: a refresh that lands in the next
  // moments must not scroll the transcript back to the bottom under the flash.
  let holdScrollUntil = 0;
  // CONSOLE-4. One deliberate jump to the bottom, consumed by the next render. Set on first paint,
  // on a conversation change, and on the reader's own send -- the three moments a person expects
  // to be taken to the newest line. Nothing else may move them.
  let pinToBottomOnce = true;
  const pinTranscriptToBottom = () => { pinToBottomOnce = true; };
  /**
   * CONSOLE-4: the transcript follows a reader who is already at the bottom, and never moves one
   * who is not.
   *
   * This used to read `if (!keepScroll || wasNearBottom)`, which computed wasNearBottom and then
   * threw it away: every message:created arrives with keepScroll false, so every SSE tick dragged
   * the reader to the bottom whatever they were reading. With .transcript carrying
   * scroll-behavior:smooth each of those was an ANIMATION across the full height. Measured on
   * grok-bot-local-vm in real Chrome, on Atera Triage (190 rows, 15,908 px in a 668 px viewport):
   * a reader parked at 5,334 was dragged 9,830 px to 15,164 inside five seconds, with the
   * transcript in motion on 27.9 % of 301 animation frames and never settling. After this change,
   * the same reader on the same conversation: 0 px of drift, 0.0 % of 301 frames. Jason,
   * 2026-09-08: "the chat for Titan just scrolls forever."
   *
   * Ruled out by measurement, so none of them is fixed here: scroll-to-top paging (already on
   * wheel, fired zero times), image height shift (scrollHeight constant), the foldRepeatedRows
   * rebuild.
   *
   * `keepScroll` is still in the signature and is deliberately no longer consulted. Five call
   * sites pass it and it distinguished nothing worth keeping -- the pin above is what those sites
   * actually meant, set explicitly at the three moments that deserve it, rather than inferred from
   * a flag that was false on every stream event.
   */
  function renderTranscript(keepScroll, pinToRevealed) {
    const box = elements.transcript;
    const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.innerHTML = transcriptMarkup();
    fillAttachments();
    // A revealed row, or a flash still holding: the reader is being held on a line on purpose, so
    // the pin is spent rather than fired under them.
    if (pinToRevealed || Date.now() < holdScrollUntil) { pinToBottomOnce = false; return; }
    const pin = pinToBottomOnce;
    pinToBottomOnce = false;
    if (pin || wasNearBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
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
    // CONSOLE-4: the one scroll a person actually asked for, so it is the one that animates. The
    // stylesheet no longer smooths the container -- that made every SSE tick an animation across
    // the whole conversation -- so smoothness is opted into here, and only where a reduced-motion
    // reader has not asked for the opposite.
    const gently = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    row.scrollIntoView({ block: "center", ...(gently ? { behavior: "smooth" } : {}) });
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

  // SHOT-5: the strip scrolls sideways when more chips are open than fit beside the composer, so
  // the chip you are actually talking to is brought into view rather than left severed at the clip.
  // fade-start / fade-end say which ends still hold chips; the CSS masks those edges, so a cut chip
  // reads as "there is more this way" instead of a chip sliced through its label.
  function renderWorkspaces() {
    elements.workspaceList.innerHTML = state.openContexts.map(contextChipMarkup).join("");
    const strip = elements.workspaceList;
    const edges = () => {
      const room = strip.scrollWidth - strip.clientWidth;
      strip.classList.toggle("fade-start", room > 1 && strip.scrollLeft > 1);
      strip.classList.toggle("fade-end", room > 1 && strip.scrollLeft < room - 1);
    };
    const sync = () => {
      const active = strip.querySelector(".workspace-chip.is-active");
      if (active) active.scrollIntoView({ inline: "nearest", block: "nearest" });
      edges();
    };
    if (!strip.dataset.edgeWatch) { strip.dataset.edgeWatch = "1"; strip.addEventListener("scroll", edges, { passive: true }); }
    sync();
    requestAnimationFrame(sync);
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
      // AVATAR-1: the same face the roster shows, beside the line that names it. Empty when the
      // host has not said who is performing -- a blank is honest, a stand-in face is not.
      const performerSlot = document.getElementById("routine-performer");
      if (performerSlot) performerSlot.innerHTML = performer ? avatarMarkup(performer, "now-avatar", performer.name) : "";
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
    renderBoxHandoffSurfaces();
    renderTranscript(keepScroll, pinToRevealed);
    renderComposerStatus();
    renderWorkspaces();
    renderCapabilities();
    renderNowAndSchedule();
    renderOnboarding();
  }

  function selectContext(kind, id) {
    rosterMode = kind === "worker" ? "workers" : "rooms";
    // CONSOLE-4: a different conversation opens at its newest line. This is one of the three
    // moments that earn a jump to the bottom; a stream tick is not one of them.
    pinTranscriptToBottom();
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

  // Which panel is on screen, counted rather than named. Four host actions close the panel when
  // they answer -- duplicate, delete, add a bot, add a room -- and the host can take seconds over
  // any of them. In that gap the person can open something else, and the close then takes away
  // whatever they are looking at NOW: a delete that landed shut the Marketplace out from under a
  // gate run, with no way to tell from the page that anything had happened. An action closes the
  // panel it was started from, or it closes nothing.
  let panelGeneration = 0;

  function openPanel(eyebrow, title, content) {
    closeOpenDialogs(elements.panelDialog);
    panelGeneration += 1;
    elements.panelEyebrow.textContent = eyebrow;
    elements.panelTitle.textContent = title;
    elements.panelContent.innerHTML = content;
    if (!elements.panelDialog.open) elements.panelDialog.showModal();
  }

  /** Closes the panel only if it is still the one this action was started from. */
  const closePanelFrom = (generation) => {
    if (panelGeneration === generation && elements.panelDialog.open) elements.panelDialog.close();
  };

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
      return `<article class="routine-card"><div><div class="routine-header"><h3>${escapeHtml(routine.name)}</h3><span class="status-pill ${running ? "working" : paused ? "" : lastFailed ? "attention" : "success"}">${escapeHtml(running ? "running" : paused ? "paused" : lastFailed ? "last run failed" : routine.status)}</span></div><p>${escapeHtml(routine.instruction)}</p><div class="routine-meta"><span class="tag">◷ ${escapeHtml(routine.trigger)}</span><span class="tag">attached · ${escapeHtml(routineScopeLabel(routine))}</span>${coordinator ? `<span class="tag">coordinates · ${escapeHtml(coordinator.name)}</span>` : ""}${delegate ? `<span class="tag">runs as · ${escapeHtml(delegate.name)}</span>` : ""}</div>${routine.nextRunAt ? `<div class="run-result next-run">Next run in ${escapeHtml(formatCountdown(routine.nextRunAt))}</div>` : ""}${lastResult}</div><div style="display:grid;gap:6px;align-content:start">${controls}</div></article>`;
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
  // agent on screen. There is no second route: the token form is the only way in.
  function listenerConnectMarkup(plugin, lead) {
    const who = lead ? escapeHtml(lead.name) : "the agent on screen";
    if (!lead) return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Connect ${escapeHtml(plugin.name)}</strong><small>A listener binds to one agent. Open an agent's conversation first, then connect it here.</small></div></div></div>`;
    return `<div class="secure-card"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Connect ${escapeHtml(plugin.name)} for ${who}</strong><small>The token goes to the host as this agent's ${escapeHtml(plugin.name)} credential and is read back from getAgentChannels. It never enters chat or model context, and this page keeps no copy.</small></div></div><form data-connect-channel="${escapeHtml(plugin.id)}"><div class="field"><label for="channel-token-${escapeHtml(plugin.id)}">${escapeHtml(plugin.name)} token</label><input id="channel-token-${escapeHtml(plugin.id)}" name="token" type="password" autocomplete="off" required placeholder="Enter securely" /></div><div class="form-actions"><button class="primary-button" type="submit">Connect for ${who}</button></div></form></div>`;
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
  // MARKET-23. The key goes with the entry, and the row says so before it is pressed.
  //
  // Measured on the R750 demo box on 8 September 2026: this button sent removeLocalConnector with
  // no options, which answers `cleared: []` and leaves the value in the 0600 store -- so a connector
  // removed from its own card left its key behind, visible only in the Plugins panel's orphan
  // strip, while the Marketplace's Uninstall next door cleared it. Three removal doors, one
  // behaviour now.
  const connectorRemoveRow = (plugin) => (plugin.group === "Connectors" && plugin.removable && typeof adapter.removeConnector === "function"
    ? `<div class="setting-row"><div><strong>Remove this connector</strong><small>Drops ${escapeHtml(plugin.name)} from connectors.json on the box${(plugin.storedFields ?? []).length ? `, clears the ${(plugin.storedFields ?? []).length} value${(plugin.storedFields ?? []).length === 1 ? "" : "s"} the host stores for it` : ""} and asks the host to re-read the file.</small></div><button class="ghost-button" type="button" data-remove-connector="${escapeHtml(plugin.name)}">Remove</button></div>`
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
    // form is the only route: the old vendor-hosted connect page is gone from the card.
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

  // MODELS-1. The model picker on a provider card the person brought themselves.
  //
  // Drawn only where there is a list and only on a card that is connected: an unadopted provider
  // has no stored row to point at a model, and a picker over a credential that does not exist yet
  // is a control that cannot do anything. The source line is not decoration -- "this is what your
  // provider says it has" and "this is the list we ship" are different claims and a person acts on
  // them differently -- so it is always drawn, in plain words, right under the field.
  //
  // The two clocks are said apart, because they are genuinely different: the box takes the new
  // model on its NEXT TURN (the host re-reads box-secrets.json on every stream, nothing restarts),
  // and this page does not redraw itself until it next hydrates, because the console only refreshes
  // after something is done on it and nothing pushes at it.
  function providerModelMarkup(plugin) {
    const choices = plugin?.modelChoices ?? null;
    if (!choices || !Array.isArray(choices.options) || choices.options.length === 0) return "";
    if (plugin.status !== "connected") return "";
    if (typeof adapter.setEndpointModel !== "function") return "";
    const options = choices.options.map((row) => {
      const window = Number.isFinite(row.contextWindow) && row.contextWindow > 0
        ? ` · ${Math.round(row.contextWindow / 1000)}k context` : "";
      return `<option value="${escapeHtml(row.id)}"${row.id === choices.current ? " selected" : ""}>${escapeHtml(row.label || row.id)}${escapeHtml(window)}</option>`;
    }).join("");
    const effect = plugin.live
      ? "This box answers through this provider, so a change here is what every agent runs on from the next turn."
      : "This box is answering somewhere else, so a change here waits until you pick this provider above.";
    const warning = choices.warning
      ? `<small data-model-warning="${escapeHtml(plugin.id)}">${escapeHtml(choices.warning)}</small>` : "";
    return `<div class="setting-row" data-model-row="${escapeHtml(plugin.id)}"><div><strong>Model</strong><small>${escapeHtml(choices.sourceNote)} ${escapeHtml(effect)}</small>${warning}</div><div class="field" style="margin:0"><label class="sr-only" for="provider-model-${escapeHtml(plugin.id)}">Model</label><select class="model-select" id="provider-model-${escapeHtml(plugin.id)}" data-provider-model="${escapeHtml(plugin.id)}">${options}</select></div></div>`;
  }

  function pluginDetailMarkup(plugin) {
    if (!plugin) return `<div class="empty-state">Choose a plugin to inspect its tools and account.</div>`;
    const tools = pluginToolsMarkup(plugin);
    const lead = contextLead();
    const account = pluginAccountMarkup(plugin, lead);
    const connectorSecrets = pluginSecretsMarkup(plugin);
    const channelRow = pluginChannelRowMarkup(plugin, lead);
    // PROXY-1: the same switch, in the words of whichever group the card is in. "Use this one" on a
    // plan card, because there is no endpoint for the customer to think about -- it is one of the
    // models their plan already includes, and the only decision is which.
    const providerSwitch = plugin.endpointId
      ? `${providerModelMarkup(plugin)}<div class="provider-switch">${plugin.live ? `<span class="status-pill success">answering now</span>` : plugin.status === "connected" ? `<button class="primary-button" type="button" data-use-endpoint="${escapeHtml(plugin.endpointId)}">${plugin.group === "Plan" ? "Use this one" : "Use this endpoint"}</button>` : ""}</div>`
      : "";
    // The Skills section was a heading over an empty div on every card the gateway builds: no
    // plugin here ships skills. It renders only where there are some, or where there is a reason.
    const skillsSection = plugin.skills.length
      ? `<section><div class="plugin-section-title"><span>Skills in package</span></div><div class="tag-list">${plugin.skills.map((skill) => `<span class="tag">✦ ${escapeHtml(skill)}</span>`).join("")}</div></section>`
      : plugin.skillsNote ? `<section><div class="plugin-section-title"><span>Skills in package</span></div><div class="empty-state">${escapeHtml(plugin.skillsNote)}</div></section>` : "";
    return `<div class="plugin-hero"><span class="plugin-icon">${escapeHtml(plugin.icon)}</span><div class="plugin-hero-copy"><h3>${escapeHtml(plugin.name)}</h3><p>${escapeHtml(plugin.description)}</p></div><span class="status-pill ${plugin.status === "connected" ? "success" : ""}">${escapeHtml(pluginStatusLabel(plugin.status))}</span></div><div class="plugin-sections"><section><div class="plugin-section-title"><span>${plugin.group === "Providers" ? "Provider account" : plugin.group === "Plan" ? "Included with your plan" : "Global account"}</span><span>${escapeHtml(plugin.category)}</span></div>${account}${connectorSecrets}${providerSwitch}${channelRow}${connectorRemoveRow(plugin)}</section>${plugin.shellTool ? shellToolMarkup(plugin, lead) : ""}<section><div class="plugin-section-title"><span>Tools available for assignment</span>${plugin.tools.length ? `<span>${plugin.tools.filter((tool) => tool.enabled).length}/${plugin.tools.length} enabled</span>` : ""}</div><div class="plugin-list">${tools}</div></section>${skillsSection}</div>`;
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
      // PROXY-1: the plan's rows are computed by the relay and answered in their own array, so a
      // list built from catalog.endpoints alone left a box pointed at the plan with an empty
      // picker and a Currently answering row naming a container on our bridge. Both groups, plan
      // first, and one lookup used for the row, the pill and the selection.
      const list = [...(catalog.included ?? []), ...(catalog.endpoints ?? [])];
      // PROVIDERS-1: the same name the agent context card and the agent profile panel print, built
      // the same way, because a customer reading two different names for one endpoint on two
      // screens has to work out which of them is lying. modelLabel is what the operator named the
      // model; a row with no label falls back to its own model, which for a plan row is the
      // routing alias and is the visible symptom of a model nobody has named yet.
      const named = (e) => `${e.name} · ${e.modelLabel || e.model}`;
      select.innerHTML = list.map((e) => {
        const on = live.model && e.model === live.model;
        const reach = e.health?.reachable ? "" : " · unreachable";
        return `<option value="${escapeHtml(e.id)}" ${on ? "selected" : ""}>${escapeHtml(named(e))}${escapeHtml(reach)}</option>`;
      }).join("") || `<option value="">No endpoints configured</option>`;
      const chosen = list.find((e) => live.model && e.model === live.model);
      // A plan row is named, never located: `live.endpoint` is the base URL's host, which for a
      // plan is the proxy's container name -- our plumbing, on a customer's screen.
      //
      // It used to append "(included with your plan)" to a name that already ended in those exact
      // words, so this row read "Z.AI GLM (included with your plan) (included with your plan)" for
      // every customer on a plan. Measured in a real browser on this Mac 2026-09-08 by
      // scripts/verify-models.mjs, which is what a gate that opens the page and reads it is for.
      if (current) current.textContent = !live.model
        ? "The box reports no model. Agents cannot answer until one is set."
        : chosen?.included
          ? named(chosen)
          : `${live.model} · ${live.endpoint ?? "unknown host"} (from ${live.source ?? "unknown"})`;
      if (health) {
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
        // A relay that cannot switch models answers {error, detail}. Show the sentence, not the
        // machine word, and never claim a switch that did not happen. TENANT-2.
        .then((answer) => {
          if (answer?.error) { showToast(answer.detail ?? `Could not switch endpoint: ${answer.error}`); fillEndpoints(); return; }
          showToast(`Now answering through ${answer.using ?? id}`);
          fillEndpoints();
        })
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
  // and nothing else, and both were polled out of a relay this product no longer has, so no
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
      return `Nothing delivers ${platform} events to this workspace yet, so a routine on this trigger would save and then wait forever.`;
    const row = listenerRow(kind);
    if (row && row.status === "connected") return null;
    return `${platform} events are not wired into this workspace yet (${row ? `the ${platform} listener is ${row.category.toLowerCase()}` : `there is no ${platform} listener`}), so a routine on this trigger would save and then wait forever. A schedule works today.`;
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
      "Slack and GitHub event triggers are not wired into this workspace yet.",
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
  // MR-37: whether the first catalog read has ANSWERED, either way. Without it the panel drew
  // "There is no catalog to draw" the instant it opened -- a claim about the host made before the
  // host had been asked, and the operator's first sight of the Marketplace on every fresh page.
  // On a loaded box that read takes seconds, and an empty catalog with one chip is what was on
  // screen for all of them.
  let marketplaceRead = false;
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
    // CONNECT-11: values the host still holds for a plugin this box no longer has. Asked once when
    // the panel opens rather than on every heartbeat -- it is a store read, and an orphan does not
    // appear on its own.
    refreshByoOrphans();
  }

  // The catalog is read once through the gateway and cached by the adapter; the install states are
  // re-derived every time, because a connector added a second ago is still connecting.
  function refreshMarketplace(live) {
    if (typeof adapter.listMarketplace !== "function" || typeof adapter.installedPlugins !== "function") {
      marketplaceNote = "This view has no gateway behind it, so there is no catalog to read.";
      marketplaceRead = true;
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
        marketplaceRead = true;
        if (!elements.panelDialog.open || openPluginSurface !== "marketplace") return;
        if (live === true) paintMarketplaceLive(); else paintMarketplaceBody();
      });
  }

  // What paintMarketplaceLive last wrote into the two live regions, so a heartbeat that changed
  // nothing writes nothing.
  const marketplacePainted = { strip: null, sections: null };

  // The operator asked for this one, so it redraws everything.
  function paintMarketplaceBody() {
    const body = elements.panelContent.querySelector("[data-marketplace-body]");
    if (!body) return;
    body.innerHTML = marketplaceBodyMarkup();
    // Record what the full repaint just drew, so the next heartbeat compares against it and writes
    // nothing rather than redrawing the same catalog once more.
    marketplacePainted.strip = body.querySelector("[data-marketplace-installed]") ? marketplaceInstalledStripMarkup() : null;
    marketplacePainted.sections = body.querySelector("[data-marketplace-sections]") ? marketplaceSectionsMarkup() : null;
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
    // MR-37: and it must not repaint markup that did not move. Every write here throws away the
    // catalog's <img> tiles and makes the browser decode them again, so a heartbeat that changed
    // nothing still blinked every logo on the page -- and a tile caught mid-decode is a tile that
    // is not drawn. The comparison is against what this function last WROTE, not against the DOM's
    // own serialisation of it, which normalises `<img ... />` and would never compare equal.
    const strip = body.querySelector("[data-marketplace-installed]");
    const sections = body.querySelector("[data-marketplace-sections]");
    if (strip) { const next = marketplaceInstalledStripMarkup(); if (next !== marketplacePainted.strip) { strip.outerHTML = next; marketplacePainted.strip = next; } }
    if (sections) { const next = marketplaceSectionsMarkup(); if (next !== marketplacePainted.sections) { sections.innerHTML = next; marketplacePainted.sections = next; } }
    // Neither region is on the page (the plugin page or the Bots tab is open): that view has no
    // half to update, so it is redrawn whole -- through paintMarketplaceBody, which is what keeps
    // the cache above describing what is actually on screen.
    if (!strip && !sections) paintMarketplaceBody();
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
  // A plugin that installs two things -- one provider's connector and its shell tool -- used to
  // put two tiles in this strip under one name, and clicking either opened a different half of it.
  // The catalog says which card is the plugin's front door (`cardId`) and which are the rest
  // (`cardIds`), so the rest are folded away here and the strip has one tile per plugin again.
  function marketplaceFoldedCardIds() {
    const folded = new Set();
    for (const install of marketplaceInstalls) {
      const ids = Array.isArray(install?.cardIds) ? install.cardIds.map(String) : [];
      if (ids.length < 2) continue;
      for (const id of ids) if (id !== String(install.cardId)) folded.add(id);
    }
    return folded;
  }

  function marketplaceInstalledStripMarkup() {
    const folded = marketplaceFoldedCardIds();
    const cards = marketplaceCards().filter((card) => !folded.has(String(card.id)));
    const connected = cards.filter((card) => card.status === "connected").length;
    // QOL-LOGOS: the strip's tiles are the catalog's tiles, at the same 40px as a card's. A card
    // the catalog does not carry (a custom MCP server, a gate's throwaway) keeps the character it
    // has always had, on the default tile.
    const icons = cards
      .map((card) => {
        const icon = marketplaceIconForCard(card);
        const catalogId = marketplaceInstalls.find((install) => String(install.cardId) === String(card?.id))?.id ?? null;
        const background = icon?.color ? ` style="background:${escapeHtml(marketplaceColor(icon.color))}"` : "";
        const face = icon ? marketplaceTileFaceMarkup(icon, card.name, catalogId) : escapeHtml(card.icon);
        return `<button class="plugin-icon marketplace-tile" type="button" data-plugin-id="${escapeHtml(card.id)}" title="${escapeHtml(card.name)}" aria-label="${escapeHtml(card.name)}"${background}>${face}</button>`;
      })
      .join("");
    return `<div class="marketplace-installed" data-marketplace-installed><span><strong>${cards.length} installed</strong> · ${connected} connected</span><div class="marketplace-installed-icons">${icons || `<small>Nothing is installed on this box yet.</small>`}</div></div>`;
  }

  function marketplaceCategories() {
    const items = marketplaceItems();
    if (!items.length) return [MARKETPLACE_ALL];
    // The adapter now keeps the host's { plugins, bots } shape rather than flattening it to the
    // plugin half, so the Bots tab can draw ITS chips. This is the Plugins tab, so it reads the
    // plugin half by name. A flat array is still accepted: an older adapter answered one.
    const categories = marketplaceCatalog?.categories;
    const declared = (Array.isArray(categories) ? categories : (categories?.plugins ?? [])).map(String);
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
  // SHOT-6: a catalog row that names no logo file falls back to a letter tile, and the installed
  // strip then shows bare letters beside real marks. Where a row is plainly the same vendor as a
  // row that DOES carry a mark, the mark is reused rather than left as an initial. Nothing is
  // invented here: this maps a catalog id to a file already in marketplace/logos/.
  const MARKETPLACE_LOGO_ALIASES = { "github-cli": "marketplace/logos/github.svg" };
  const marketplaceLogoSrc = (file) => {
    const value = String(file ?? "").trim();
    if (!value.startsWith(MARKETPLACE_LOGO_PREFIX)) return "";
    if (value.split("/").includes("..")) return "";
    return /^[\w./-]+\.(svg|png)$/i.test(value) ? value : "";
  };

  // The tile's face: the logo when the catalog names one, the letter otherwise. The letter rides
  // along in data-marketplace-letter so a broken image can be turned back into the letter tile
  // without a second read of the catalog.
  function marketplaceTileFaceMarkup(icon, name, id) {
    const letter = String(icon?.letter ?? String(name ?? "?").slice(0, 1)).toUpperCase();
    const src = marketplaceLogoSrc(icon?.file) || marketplaceLogoSrc(MARKETPLACE_LOGO_ALIASES[String(id ?? "")]);
    if (!src) return escapeHtml(letter);
    return `<img class="marketplace-tile-img" src="${escapeHtml(src)}" alt="" data-marketplace-logo="${escapeHtml(src)}" data-marketplace-letter="${escapeHtml(letter)}" />`;
  }

  // The whole tile, at one of the two standard sizes: 40px on a card and in the installed strip,
  // 64px on the plugin page. The size is CSS, not markup, so nothing here can invent a third one.
  function marketplaceTileMarkup(icon, name, large, id) {
    const color = marketplaceColor(icon?.color);
    return `<span class="plugin-icon marketplace-tile${large === true ? " is-large" : ""}" style="background:${escapeHtml(color)}">${marketplaceTileFaceMarkup(icon, name, id)}</span>`;
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

  // The same filter the catalog's own SearchPlugins tool applies: name, tagline, category -- and
  // now the row's own keywords. A business owner types "crm", "invoice" or "database", none of
  // which belong in a tagline a person reads, and the catalog carries them beside it instead.
  function marketplaceMatches(item) {
    const q = marketplaceQuery.trim().toLowerCase();
    if (!q) return true;
    const keywords = Array.isArray(item?.keywords) ? item.keywords.map((word) => String(word ?? "")) : [];
    return [item.name, item.tagline, item.category, ...keywords].some((field) => String(field ?? "").toLowerCase().includes(q));
  }

  function marketplaceCardMarkup(item) {
    const install = marketplaceInstallById(item.id);
    // A ROW THAT INSTALLS NOTHING GETS NO ADD, ON THE CARD EITHER. Its plugin page already draws
    // none, and the card was still drawing one -- measured on screen 2026-09-09, where Add on the
    // Meta card opened the custom-MCP editor, which is a door that would write an entry nothing
    // connects to. Meta, X and LinkedIn install nothing because there is nothing honest to install:
    // no official server publishes an organic post anywhere, so the row is a page that tells a
    // person what to go and do. Clicking the card opens that page, which is the whole action.
    const action = item?.installsNothing === true
      ? ""
      : install?.installed === true
        ? `<span class="status-pill success marketplace-card-action" data-marketplace-added="${escapeHtml(item.id)}">✓ Added</span>`
        : `<button class="primary-button marketplace-card-action" type="button" data-marketplace-add="${escapeHtml(item.id)}">Add</button>`;
    // QOL-LOGOS: one tile at one size (the catalog's logo when it names one, its letter when not),
    // and the action carries its own class so the "✓ Added" pill cannot be squeezed to a clip.
    return `<div class="plugin-card marketplace-card" data-marketplace-card="${escapeHtml(item.id)}"><button class="marketplace-card-open" type="button" data-marketplace-plugin="${escapeHtml(item.id)}">${marketplaceTileMarkup(item?.icon, item?.name, false, item?.id)}<span class="marketplace-card-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.tagline ?? "")}</small></span></button>${action}</div>`;
  }

  function marketplaceSectionsMarkup() {
    const items = marketplaceItems().filter(marketplaceMatches);
    if (!items.length) {
      // Until the first read answers, the honest line is that the host is being asked -- not that
      // it serves nothing.
      if (!marketplaceRead) return `<div class="empty-state" data-marketplace-loading>Reading the host’s catalog…</div>`;
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
      ? marketplaceTileMarkup(item.icon, name, true, item.id)
      : `<span class="plugin-icon marketplace-tile is-large">${escapeHtml(String(card?.icon ?? name.slice(0, 1)).toUpperCase())}</span>`;
    const description = String(item?.description ?? card?.description ?? "");
    // A catalog row carries the contract's three states. A card with no catalog row keeps the
    // status pill it has always had rather than being forced into a vocabulary it never used.
    const label = install ? install.label : pluginStatusLabel(card?.status ?? "available");
    const ready = install ? install.ready === true : card?.status === "connected";
    const source = item?.source?.url
      ? `<a class="ghost-button" href="${escapeHtml(String(item.source.url))}" target="_blank" rel="noreferrer noopener" data-marketplace-source>View source ↗</a>`
      : "";
    // MARKET-26. The dates and the steps go ABOVE the sections, because they are what somebody
    // reads before they decide to spend an afternoon on a developer app, and the accounts section
    // below is what they use afterwards.
    return `${back}<section class="plugin-detail"><div class="plugin-hero">${hero}<div class="plugin-hero-copy"><h3>${escapeHtml(name)}</h3><p>${escapeHtml(description)}</p>${marketplaceVerificationMarkup(item)}</div><span class="status-pill${ready ? " success" : ""}">${escapeHtml(label)}</span></div><div class="form-actions marketplace-actions">${source}${marketplaceInstallControlMarkup(item, install, card)}</div><div class="plugin-sections">${marketplaceFirstStepsMarkup(item)}${marketplaceContradictionMarkup(item)}${marketplaceDocFactsMarkup(item)}${marketplaceAccountsSectionMarkup(item, install, card, lead)}${card?.shellTool ? shellToolMarkup(card, lead) : ""}${marketplaceConnectorsSectionMarkup(item, card)}</div></section>`;
  }

  // ---- MARKET-26: what the vendor requires, and when we last checked ----------------------------
  //
  // The catalog has carried a `verification` stamp on every row since MARKET-1 and the wire has
  // always sent it. THIS PAGE HAS NEVER DRAWN IT. A person deciding whether to spend an afternoon
  // creating a developer app had no way to tell whether the instructions in front of them were read
  // last week or last year, and on Meta, X and LinkedIn that is the difference between a working
  // sign-up and a dead one.
  //
  // Two dates, kept apart on the screen the way they are kept apart in the catalog, because they
  // answer different questions:
  //
  //   VERIFIED  we ran this against the vendor on that date, from a box.
  //   CHECKED   the vendor still documented what this page says, on that date.
  //
  // And one honest limitation said out loud. Nothing pushes control-plane state into a running box,
  // so between releases this page cannot know that a re-read has since found something. What it can
  // know is HOW OLD its own facts are, so once they are older than the row's own recheck interval
  // it says the row is under review and to hold off -- before the person commits, and without
  // blocking Install, which is theirs to press.

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function marketplaceDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
    if (!match) return "";
    const month = MONTHS[Number(match[2]) - 1];
    return month ? `${Number(match[3])} ${month} ${match[1]}` : "";
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  /** How old this row's own dated facts are, and whether that is past what the row asked for. */
  function marketplaceRowAge(item, at = Date.now()) {
    const docs = Array.isArray(item?.docs) ? item.docs : [];
    const days = docs
      .map((doc) => Date.parse(`${String(doc?.checkedOn ?? "")}T00:00:00Z`))
      .filter((value) => Number.isFinite(value));
    if (!days.length) return { oldest: "", days: null, stale: false, recheckDays: 0 };
    const oldest = Math.min(...days);
    const recheckDays = Number.isFinite(Number(item?.recheckDays)) && Number(item.recheckDays) > 0 ? Number(item.recheckDays) : 7;
    return {
      oldest: new Date(oldest).toISOString().slice(0, 10),
      days: Math.floor((at - oldest) / DAY_MS),
      stale: at - oldest > recheckDays * DAY_MS,
      recheckDays,
    };
  }

  /**
   * Has the recurring check already found that this row moved?
   *
   * A doc fact the job could not confirm comes back as `state: "changed"`, and the catalog carries
   * that per fact. The page used to decide "under review" from AGE alone, so a row the job had
   * flagged this morning still read "Checked today" in the hero while the operator's own panel said
   * NEEDS RE-VERIFICATION -- measured on the R750 on 2026-09-09 against the Browserbase row, whose
   * recheck interval is thirty days, so the customer's page would have kept saying it for a month
   * on an installable row with two credential boxes on it. The flip is delivered; it was only ever
   * drawn one disclosure down, in the collapsed section nobody opens before installing.
   */
  function marketplaceRowFlagged(item) {
    const docs = Array.isArray(item?.docs) ? item.docs : [];
    return docs.some((doc) => String(doc?.state ?? "verified") === "changed");
  }

  function marketplaceVerificationMarkup(item) {
    if (!item) return "";
    const verification = item.verification ?? null;
    const age = marketplaceRowAge(item);
    const flagged = marketplaceRowFlagged(item);
    const lines = [];
    if (verification?.checkedOn) {
      // A DATE AND NOTHING ELSE. `verification.how` is a sentence written for us -- it names an
      // endpoint, a container and an HTTP status, and a customer reading "HTTP 403 Unsupported
      // Authentication" under a plugin's title reads it as this page telling them something is
      // broken. It is real evidence and it stays on the page, one disclosure down, with the rest of
      // the working.
      const ran = marketplaceDay(verification.checkedOn);
      lines.push(`<p class="field-hint" data-marketplace-verified>Verified ${escapeHtml(ran || String(verification.checkedOn))}</p>`);
    }
    if (age.oldest || flagged) {
      // Flagged first. An out-of-date row is a row nobody has looked at; a flagged row is one
      // somebody looked at and found had moved, which is the worse of the two and the one a person
      // must not read a reassuring date on.
      if (flagged) {
        lines.push(`<p class="field-hint" data-marketplace-under-review data-marketplace-flagged><strong>Under review</strong> — this vendor has changed something since we last wrote these steps down, and we are working out what. Hold off setting it up until this page says checked again; what is below may send you round a loop that no longer exists.</p>`);
      } else if (age.stale) {
        lines.push(`<p class="field-hint" data-marketplace-under-review><strong>Under review</strong> — we are re-reading this vendor's own documentation. What is below was true on ${escapeHtml(marketplaceDay(age.oldest))} and these vendors change their requirements often, so hold off installing until this page says checked again.</p>`);
      } else {
        lines.push(`<p class="field-hint" data-marketplace-checked>Checked ${escapeHtml(marketplaceDay(age.oldest))} against ${escapeHtml(String(item.source?.label ?? "the vendor's own documentation"))}.</p>`);
      }
    }
    return lines.join("");
  }

  /** The steps that come BEFORE the key box is any use. Numbered, because they are in order. */
  function marketplaceFirstStepsMarkup(item) {
    const steps = Array.isArray(item?.firstSteps) ? item.firstSteps.filter((step) => String(step ?? "").trim().length > 0) : [];
    if (!steps.length) return "";
    // Styled inline rather than through styles.css, which belongs to nobody in this wave: this is
    // one list in one section, and the alternative was an ordered list with the browser's own 40px
    // indent inside a card that has none.
    const list = steps.map((step) => `<li style="margin:0 0 8px">${escapeHtml(String(step))}</li>`).join("");
    return `<section data-marketplace-first-steps><div class="plugin-section-title"><span>What you must do first</span><span>${steps.length} step${steps.length === 1 ? "" : "s"}</span></div><div class="secure-card"><ol class="marketplace-first-steps" style="margin:0;padding-left:20px;line-height:1.5">${list}</ol></div></section>`;
  }

  /**
   * Where the vendor's own documentation says two different things. Not a bug in this row: a fact
   * about the vendor, and the person is better off being told than discovering it against a rate
   * limiter. Behind a disclosure so the page is not shouting at somebody who does not need it.
   */
  function marketplaceContradictionMarkup(item) {
    const line = String(item?.knownContradiction ?? "").trim();
    if (!line) return "";
    return `<details class="panel-card" data-marketplace-contradiction><summary>One thing this vendor documents twice, differently</summary><p class="field-hint">${escapeHtml(line)}</p></details>`;
  }

  /**
   * The dated facts themselves, behind a disclosure: what we depend on, where it is published, and
   * what it said when we last read it. Any fact the last read could not confirm shows BOTH SIDES,
   * because "something changed" without the two strings is a sentence that sends the reader to go
   * and do the work again.
   */
  function marketplaceDocFactsMarkup(item) {
    const docs = Array.isArray(item?.docs) ? item.docs : [];
    if (!docs.length) return "";
    // The working behind "Verified <date>" in the hero: what was actually run, against which
    // address, and what came back. It belongs here rather than up there for the reason written
    // beside that line.
    const how = String(item?.verification?.how ?? "").trim();
    const ran = how
      ? `<div class="setting-row" data-marketplace-verified-how><div><strong>What we ran, and what it answered</strong><small>${escapeHtml(how)}</small></div><span class="status-pill success">${escapeHtml(marketplaceDay(item?.verification?.checkedOn) || String(item?.verification?.checkedOn ?? ""))}</span></div>`
      : "";
    const rows = docs.map((doc) => {
      const state = String(doc?.state ?? "verified");
      const word = state === "not-published"
        ? "the vendor does not publish this"
        : state === "changed" ? "this one has moved" : `read ${marketplaceDay(doc?.checkedOn) || String(doc?.checkedOn ?? "")}`;
      const both = state === "changed"
        ? `<div class="field-hint" data-marketplace-doc-sides="${escapeHtml(String(doc?.id ?? ""))}">we expect: ${escapeHtml(String(doc?.expected ?? ""))}<br />the page now says something else, so this row is being re-read</div>`
        : "";
      return `<div class="setting-row" data-marketplace-doc="${escapeHtml(String(doc?.id ?? ""))}"><div><strong>${escapeHtml(String(doc?.what ?? ""))}</strong><small>${escapeHtml(String(doc?.url ?? ""))}</small>${both}</div><span class="status-pill${state === "verified" ? " success" : ""}">${escapeHtml(word)}</span></div>`;
    }).join("");
    return `<details class="panel-card" data-marketplace-doc-facts><summary>What this page depends on, and where it is published</summary><div class="plugin-list">${ran}${rows}</div></details>`;
  }

  // Add, or Uninstall with the offer to clear what the host stores for it. The clear has to happen
  // BEFORE the entry leaves connectors.json: deleteConnectorSecret resolves the server through
  // that file, so once the row is gone the host cannot reach its own store for it.
  function marketplaceInstallControlMarkup(item, install, card) {
    const stored = (install?.storedCredentials ?? card?.storedFields ?? []).length;
    const installed = install?.installed === true || (install == null && card?.removable === true);
    // MARKET-26. A row that puts nothing on the box has no Add: Meta, X and LinkedIn have nothing
    // honest to install, and Browserbase's key is read by the host itself. Offering the button
    // would call a host command with no entry behind it, and the person would press it once, get
    // nothing, and reasonably conclude the page is broken.
    if (item?.installsNothing === true) return "";
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

  // ---- MARKET-5: one credential home per provider ----------------------------------------------
  // The complaint was literal: the TinyFish page carried two key forms for one provider, each
  // warning that the other's value did not reach it. They are genuinely two processes -- the
  // connector the host launches and the shell the agent runs commands in -- but they are two
  // CONSUMERS of one key, which is a different thing, and a page that makes the person hold that
  // distinction has made its problem theirs.
  //
  // So the catalog row declares its credentials and who eats each one, this draws ONE masked box
  // per credential, and one save fans out. Where the row declares nothing, the card's own fields
  // are still drawn the way they always were -- a box added by hand knows its env names and
  // nothing else, and that is a real case, not a gap.
  const CREDENTIAL_CONSUMER_WORDS = {
    connector: "the connector",
    shell: "the agent's shell",
    header: "the server's own header",
    url: "the address it opens",
  };
  function credentialConsumerLine(consumers) {
    const words = [...new Set((Array.isArray(consumers) ? consumers : [])
      .map((consumer) => CREDENTIAL_CONSUMER_WORDS[String(consumer?.kind ?? "")])
      .filter(Boolean))];
    if (!words.length) return "Stored once, on the host, in its own 0600 store. It never enters this page, chat, or the file on the box.";
    const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and by ${words[words.length - 1]}`;
    return `Stored once. Used by ${list}.`;
  }

  // The credentials this page draws a box for: the catalog's declaration first, because it is the
  // only place that knows a field feeds two processes, and the card's own field list otherwise.
  function pluginCredentials(item, card) {
    const declared = Array.isArray(item?.credentials) ? item.credentials : [];
    if (declared.length) {
      return declared.map((credential) => ({
        field: String(credential?.field ?? ""),
        label: String(credential?.label ?? credential?.field ?? ""),
        hint: String(credential?.hint ?? ""),
        consumers: Array.isArray(credential?.consumers) ? credential.consumers : [],
      })).filter((credential) => credential.field.length > 0);
    }
    const hints = card?.secretHints ?? item?.credentialHints ?? {};
    return (Array.isArray(card?.secretFields) ? card.secretFields : Object.keys(item?.credentialHints ?? {}))
      .map((field) => ({ field: String(field), label: String(field), hint: String(hints[field] ?? ""), consumers: [] }));
  }

  function pluginCredentialHomeMarkup(item, install, card) {
    // PROXY-7's shape: where the box carries this provider on its plan there is no key to put
    // anywhere, so the page says so and draws no box at all rather than an input nobody should use.
    if (install?.includedWithPlan === true) {
      return `<div class="secure-card" data-plugin-credential-included><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Included with your plan</strong><small>Your plan already carries this one, so there is no key to put in. Add it and it works.</small></div></div></div>`;
    }
    const credentials = pluginCredentials(item, card);
    if (!credentials.length) return "";
    const pluginId = String(item?.id ?? card?.id ?? "");
    const stored = new Set((card?.storedFields ?? install?.storedCredentials ?? []).map(String));
    const boxes = credentials.map((credential) => {
      const id = `plugin-credential-${escapeHtml(pluginId)}-${escapeHtml(credential.field)}`;
      const held = stored.has(credential.field);
      return `<div class="field"><label for="${id}">${escapeHtml(credential.label)}</label>`
        + `<input id="${id}" name="${escapeHtml(credential.field)}" type="password" autocomplete="off" placeholder="${held ? "The host holds a value — type to replace it" : "Enter securely"}" />`
        + (credential.hint ? `<span class="field-hint" data-credential-hint="${escapeHtml(credential.field)}">${escapeHtml(credential.hint)}</span>` : "")
        + `<span class="field-hint" data-credential-consumers="${escapeHtml(credential.field)}">${escapeHtml(credentialConsumerLine(credential.consumers))}</span></div>`;
    }).join("");
    return `<div class="secure-card" data-plugin-credential-card="${escapeHtml(pluginId)}"><div class="secure-card-header"><span class="secure-shield">◈</span><div><strong>Key for ${escapeHtml(String(item?.name ?? card?.name ?? pluginId))}</strong><small>One place to put it. The host stores it and hands it to everything that needs it.</small></div></div>`
      + `<form data-plugin-credential-form="${escapeHtml(pluginId)}">${boxes}<div class="form-actions"><button class="primary-button" type="submit">Store on the host</button></div>`
      + `<span class="field-hint">Leave a box blank to leave what the host already holds untouched. Nothing typed here is written into this page.</span></form>`
      + `<div class="field-hint" data-plugin-credential-result hidden></div></div>`;
  }

  // One row per thing this plugin installs, so a folded row (a connector AND a shell tool for one
  // provider) says what it put where instead of appearing twice on the page under one name.
  function pluginComponentRowsMarkup(install) {
    const components = Array.isArray(install?.components) ? install.components : [];
    if (components.length < 2) return "";
    const rows = components.map((component) => {
      const what = component.kind === "shell-tool" ? "a command in the box" : "a connector the host launches";
      const state = component.installed ? (component.ready ? "working" : component.needsAuth ? "needs its key" : "starting") : "not installed";
      const name = component.kind === "shell-tool" ? component.shellToolId : component.connectorName;
      return `<div class="setting-row" data-plugin-component="${escapeHtml(String(name))}"><div><strong>${escapeHtml(String(name))}</strong><small>${escapeHtml(what)}</small></div><span class="status-pill${component.ready ? " success" : ""}">${escapeHtml(state)}</span></div>`;
    }).join("");
    return `<div class="plugin-list" data-plugin-components>${rows}</div>`;
  }

  function marketplaceAccountsSectionMarkup(item, install, card, lead) {
    // MARKET-26. A row that installs nothing has no account state to report and must not be told it
    // is "not installed": there is nothing to install. Where it carries a key the host reads for
    // itself, the key box is still exactly the box every other row has.
    if (item?.installsNothing === true) {
      const home = pluginCredentialHomeMarkup(item, install, card);
      const line = (item.credentials ?? []).length > 0
        ? "The host stores this key in its own 0600 store and reads it itself. It is put into no connector, no request from this page, and no environment the agent's shell can read."
        : "There is no account to connect from here. Everything this vendor needs is on your side of the line, and the steps above are it.";
      return `<section data-marketplace-accounts><div class="plugin-section-title"><span>Accounts</span><span>${(item.credentials ?? []).length > 0 ? "1 key" : "nothing to connect"}</span></div><div class="setting-row" data-marketplace-account="${escapeHtml(String(item.id ?? ""))}"><div><strong>${escapeHtml(String(item.name ?? item.id ?? ""))}</strong><small>${escapeHtml(line)}</small></div></div>${home}</section>`;
    }
    const label = install ? install.label : pluginStatusLabel(card?.status ?? "available");
    const ready = install ? install.ready === true : card?.status === "connected";
    const line = install?.includedWithPlan === true
      ? "Your plan carries this one, so there is no key to enter."
      : install?.installed === false
        ? "Add it and its key box appears here; the host stores the value, never this page."
        : install?.needsAuth
          ? `The host holds no value for ${install.missingCredentials.join(", ")}. Enter it below and the host stores it.`
          : "The host holds this account's credentials in its own 0600 store and hands them to the process it launches.";
    const account = `<div class="setting-row" data-marketplace-account="${escapeHtml(String(item?.id ?? card?.id ?? ""))}"><div><strong>default</strong><small>${escapeHtml(line)}</small></div><span class="status-pill${ready ? " success" : ""}">${escapeHtml(label)}</span></div>`;
    const components = pluginComponentRowsMarkup(install);
    // ONE credential block, whether the plugin is on the box yet or not: an operator reads the hint
    // before they go and mint a key, and types it in the same box afterwards. The second card is
    // gone -- pluginSecretsMarkup is drawn only for a card the catalog does not carry, which is a
    // connector somebody added by hand and the one case with nothing to fan out to.
    const home = item ? pluginCredentialHomeMarkup(item, install, card) : "";
    // And the card's own account block only where there is no home to draw: otherwise this is the
    // second thing on the page saying where the key goes, which is the whole of MARKET-5.
    const fallback = home ? "" : (card ? `${pluginAccountMarkup(card, lead)}${pluginSecretsMarkup(card)}` : "");
    return `<section data-marketplace-accounts><div class="plugin-section-title"><span>Accounts</span><span>1 account</span></div>${account}${components}${home}${fallback}</section>`;
  }

  // What an operator saw when a connector failed was several hundred characters of Node stack:
  // "MCP error -32000: Connection closed; stderr: … SseError … at EventSource.failConnection_fn".
  // The host maps its own status to ONE plain sentence and this draws it verbatim. The browser
  // must never match on a statusDetail to work out what happened -- the day it starts guessing
  // from that string is the day the sentence stops being true -- so a host with no sentence for
  // this state draws no line at all, and the raw text sits behind a disclosure either way.
  function connectorHealthMarkup(card) {
    const sentence = typeof card?.statusSentence === "string" ? card.statusSentence.trim() : "";
    const detail = typeof card?.statusDetail === "string" ? card.statusDetail.trim() : "";
    if (!sentence && !detail) return "";
    const raw = detail ? `<details class="panel-card" data-connector-health-detail><summary>What the box actually said</summary><pre class="shell-tool-output">${escapeHtml(detail)}</pre></details>` : "";
    const line = sentence ? `<p class="field-hint" data-connector-health="${escapeHtml(String(card?.name ?? ""))}">${escapeHtml(sentence)}</p>` : "";
    return `${line}${raw}`;
  }

  function marketplaceConnectorsSectionMarkup(item, card) {
    // MARKET-26, and this branch comes FIRST on purpose. A row that installs nothing derives
    // `kind: "shell-tool"` on the wire, because the wire's vocabulary is older than this shape, and
    // without this the Meta page would tell a person "a shell tool is not an MCP server: the agent
    // runs its command itself" about a row that has no command and never will.
    if (item?.installsNothing === true) {
      return `<section data-marketplace-connectors><div class="plugin-section-title"><span>Connectors</span><span>nothing to install</span></div><div class="empty-state">${escapeHtml(
        (item.credentials ?? []).length > 0
          ? "There is no server to install for this one. What it needs is the key above, which the host reads itself."
          : "There is nothing to install here. This page is the part that takes the time: what the vendor requires of you before anything can post on your behalf.",
      )}</div></section>`;
    }
    const shellTool = item?.kind === "shell-tool" || card?.shellTool != null;
    const count = `<span>${!shellTool && card?.tools?.length ? `${card.tools.filter((tool) => tool.enabled).length}/${card.tools.length} enabled` : !shellTool && card ? "1 connector" : "0 connectors"}</span>`;
    if (!card || shellTool) {
      return `<section data-marketplace-connectors><div class="plugin-section-title"><span>Connectors</span>${count}</div><div class="empty-state">${escapeHtml(shellTool ? "A shell tool is not an MCP server: the agent runs its command itself, so there is no connector here. Its command and its key are above." : "Not on this box yet. Add it and the host launches its server, discovers its tools, and lists them here.")}</div></section>`;
    }
    const status = String(card.boxStatus ?? card.status ?? "unknown");
    const server = `<div class="setting-row" data-connector-status="${escapeHtml(card.name)}"><div><strong>${escapeHtml(card.name)}</strong><small>${escapeHtml(card.description)}</small></div><span class="status-pill${card.status === "connected" ? " success" : ""}">${escapeHtml(status)}</span></div>`;
    return `<section data-marketplace-connectors><div class="plugin-section-title"><span>Connectors</span>${count}</div>${server}${connectorHealthMarkup(card)}<div class="plugin-list">${pluginToolsMarkup(card)}</div></section>`;
  }

  // Typing filters the sections in place: repainting the whole body would take the focus and the
  // caret out of the field on every keystroke.
  function handleMarketplaceInput(event) {
    const field = event.target.closest?.("[data-marketplace-search]");
    if (!field) return;
    marketplaceQuery = field.value;
    const sections = elements.panelContent.querySelector("[data-marketplace-sections]");
    if (sections) { const next = marketplaceSectionsMarkup(); sections.innerHTML = next; marketplacePainted.sections = next; }
  }

  // The Marketplace, or Settings, or neither: a card control re-renders the panel it is drawn in.
  function renderPluginsPanel() {
    // SETTINGS-2: the provider and listener cards live in the Operator section, so a control on one
    // of them reopens THAT section rather than dropping the operator back on General.
    if (openPluginSurface === "settings") { openSettingsPanel("operator"); return; }
    renderMarketplacePanel();
  }

  // ===== end Marketplace ==============================================================

  // CP-11: adding a connector used to mean an operator editing connectors.json inside the
  // container by hand. The relay owns that file (GET/POST /connectors) and the host re-reads it
  // on refreshMcp, so this form is the whole round trip. Environment VALUES are deliberately not
  // collected here -- the file is plaintext on the box; the values go through the key form on the
  // connector's own card, which hands them to the host's store.
  // ---- MARKET-6: Add your own -----------------------------------------------------------------
  // "We've got to get more of the plugins added, along with the ability for people to add
  // third-party MCP servers easily." The catalog is the first half; this is the second. The old
  // editor asked for a command, its arguments and its environment names -- which is one of the
  // three shapes a server actually arrives in, and the least common one now. A hosted server could
  // not be added from this console at all.
  //
  // So the card asks ONE question first, the way every other client that does this asks it: is
  // this a LINK or a PROGRAM. A third door takes the vendor's own config block, because that is
  // what is in the operator's clipboard when they get here, and turns it into one of the other
  // two so they can read it before it is written.
  //
  // A value never enters this form. A header ticked as a secret mints an environment NAME and an
  // empty value; the key goes in the masked box on the server's own page afterwards, into the
  // host's 0600 store. That is what keeps it out of connectors.json, which is plaintext on the box.
  const BYO_DOORS = [
    { id: "link", label: "A link", blurb: "The server runs somewhere else and you have its address." },
    { id: "program", label: "A program", blurb: "The box runs the server itself, from a command." },
    { id: "paste", label: "Paste their config", blurb: "You copied a block out of the server's own page." },
  ];
  let byoDoor = "link";
  let byoHeaders = [{ name: "Authorization", secret: true, env: "", value: "" }];
  let byoRefusalText = null;
  let byoNote = null;
  let byoPreview = null;
  // What the link door holds. Adding a header row or ticking one repaints the door, and a door
  // drawn from constants would take the address someone had typed with it -- so the fields are
  // read out of the DOM into this before every repaint and drawn back from it after.
  let byoLink = { url: "", name: "", transport: "http", named: false };

  const byoField = (id, label, value, placeholder, hint) => `<div class="field"><label for="${id}">${escapeHtml(label)}</label><input id="${id}" name="${escapeHtml(id.replace(/^byo-/, ""))}" value="${escapeHtml(String(value ?? ""))}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" />${hint ? `<span class="field-hint">${escapeHtml(hint)}</span>` : ""}</div>`;

  // One header row. The tick is what decides whether a value is ever typed here at all: ticked, the
  // row carries a NAME the host will store the key under and no value box; unticked, it carries a
  // literal, which is what an "X-MCP-Readonly: true" is.
  function byoHeaderRowMarkup(row, index) {
    const env = String(row.env ?? "");
    const secret = row.secret === true;
    return `<div class="setting-row byo-header-row" data-byo-header="${index}">`
      + `<div class="field"><label for="byo-header-name-${index}">Header</label><input id="byo-header-name-${index}" data-byo-header-name="${index}" value="${escapeHtml(String(row.name ?? ""))}" placeholder="Authorization" autocomplete="off" /></div>`
      + `<label class="tag"><input type="checkbox" data-byo-header-secret="${index}"${secret ? " checked" : ""} /> this value is a secret</label>`
      + (secret
        ? `<div class="field"><label for="byo-header-env-${index}">Stored under</label><input id="byo-header-env-${index}" data-byo-header-env="${index}" value="${escapeHtml(env)}" placeholder="NAME_THE_HOST_STORES_IT_UNDER" autocomplete="off" /><span class="field-hint">The key itself goes in the masked box on this server's page once it is added. Nothing you type here is stored.</span></div>`
        : `<div class="field"><label for="byo-header-value-${index}">Value</label><input id="byo-header-value-${index}" data-byo-header-value="${index}" value="${escapeHtml(String(row.value ?? ""))}" placeholder="true" autocomplete="off" /></div>`)
      + `<button class="ghost-button" type="button" data-byo-header-remove="${index}">Remove</button></div>`;
  }

  // The exact entry that will be written, before Add. Where the host can be asked it is the host's
  // own answer; where it cannot, it is what was typed, with a line saying the box decides how it
  // opens the address. Either way there is no key in it: a secret header shows the name it is
  // stored under, never a value.
  function byoPreviewMarkup() {
    if (!byoPreview) return "";
    const body = escapeHtml(JSON.stringify(byoPreview.entry, null, 2));
    const line = byoPreview.fromHost
      ? "This is the entry the box will write."
      : (byoPreview.note ?? "This is what will be written.");
    return `<div class="demo-note" data-byo-preview><strong>What will be written</strong><br />${escapeHtml(line)}<pre class="shell-tool-command">${body}</pre></div>`;
  }

  function byoLinkDoorMarkup() {
    const transports = (typeof adapter.byoTransports === "function" ? adapter.byoTransports() : [{ id: "http", label: "Streamable HTTP" }]);
    const options = transports.map((t) => `<option value="${escapeHtml(t.id)}"${byoLink.transport === t.id ? " selected" : ""}>${escapeHtml(t.label)}</option>`).join("");
    const named = byoLink.named ? ` data-touched="1"` : "";
    return `<form data-byo-link>`
      + byoField("byo-url", "Address", byoLink.url, "https://mcp.example.com/mcp", "The whole address from the server's own page, starting with https://.")
      + `<div class="field"><label for="byo-transport">How it talks</label><select id="byo-transport" name="transport">${options}</select></div>`
      + byoField("byo-name", "Name", byoLink.name, "filled in from the address", "What the box files it under and what the agent will see. Leave it blank and the address names it.").replace('id="byo-name"', `id="byo-name"${named}`)
      + `<div class="plugin-section-title"><span>Headers</span><span>only if the server asks for one</span></div>`
      + `<div class="plugin-list" data-byo-headers>${byoHeaders.map(byoHeaderRowMarkup).join("")}</div>`
      + `<div class="form-actions"><button class="ghost-button" type="button" data-byo-header-add>Add a header</button><button class="ghost-button" type="button" data-byo-show>Show what will be written</button><button class="primary-button" type="submit">Add server</button></div>`
      + `</form>`;
  }

  function byoProgramDoorMarkup() {
    return `<form data-add-connector><div class="field"><label for="connector-name">Name</label><input id="connector-name" name="name" required placeholder="e.g. localfiles" /></div><div class="field"><label for="connector-command">Command</label><input id="connector-command" name="command" required placeholder="e.g. npx" /></div><div class="field"><label for="connector-args">Arguments</label><input id="connector-args" name="args" placeholder="space separated; quote one that holds a space, e.g. --header &quot;Name:Value&quot;" /></div><div class="field"><label for="connector-env">Environment variable names</label><input id="connector-env" name="envNames" placeholder="comma separated, names only" /></div><div class="form-actions"><button class="primary-button" type="submit">Add connector</button></div></form>`;
  }

  function byoPasteDoorMarkup() {
    return `<form data-byo-paste><div class="field"><label for="byo-paste">Their config block</label><textarea id="byo-paste" name="block" rows="7" placeholder='{ "mcpServers": { "example": { "url": "https://mcp.example.com/mcp" } } }'></textarea><span class="field-hint">Paste it whole, braces included. It is read into the form above so you can see what it will do; nothing is written until you press Add there. A key inside the block is dropped rather than kept.</span></div><div class="form-actions"><button class="primary-button" type="submit">Read it</button></div></form>`;
  }

  // CONNECT-11: values the host still holds for a connector nobody has any more. The old resolver
  // went through connectors.json for list, set AND delete, so once an entry left the file its
  // stored value could not even be named. A host without the command draws no strip at all rather
  // than an empty one claiming everything is clean.
  let byoOrphans = null;
  function byoOrphanStripMarkup() {
    if (!Array.isArray(byoOrphans) || byoOrphans.length === 0) return "";
    const rows = byoOrphans.map((row) => `<div class="setting-row"><div><strong>${escapeHtml(row.server)}</strong><small>${escapeHtml(`${row.fields.length} value${row.fields.length === 1 ? "" : "s"} the host still holds, for a plugin this box no longer has.`)}</small></div><button class="ghost-button" type="button" data-byo-clear-orphan="${escapeHtml(row.server)}">Clear</button></div>`).join("");
    return `<div class="panel-card" data-byo-orphans><div class="plugin-section-title"><span>Stored keys with no plugin</span><span>${byoOrphans.length}</span></div>${rows}</div>`;
  }

  function connectorEditorMarkup() {
    if (typeof adapter.addConnector !== "function") return "";
    const configured = state.plugins.filter((p) => p.group === "Connectors" && p.removable);
    const rows = configured.length
      ? configured.map((p) => `<div class="setting-row"><div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.category)}</small></div><button class="ghost-button" type="button" data-remove-connector="${escapeHtml(p.name)}">Remove</button></div>`).join("")
      : `<div class="empty-state">No connector is configured on this box yet.</div>`;
    // CONNECT-3: a preset is a button that FILLS a form, not one that installs anything. The
    // operator sees the entry before it is written, and the credential still goes through the key
    // form on the connector's own card afterwards. The row sits above the doors because a preset
    // is a program, so pressing one takes you to that door with the fields already filled.
    const presets = typeof adapter.connectorPresets === "function" ? adapter.connectorPresets() : [];
    const presetRow = presets.length
      ? `<div class="form-actions" data-connector-presets>${presets.map((p) => `<button class="ghost-button" type="button" data-connector-preset="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`).join("")}</div><span class="field-hint">A preset fills the fields below with that service's connector entry, so it can be read before it is written. Nothing is written until Add connector, and a credential is a separate step on the connector's own card.</span>`
      : "";
    // Filled by the preset click below with one line per credential the filled entry will want:
    // what it is, where it is created, the least it needs. An operator reading the form before
    // pressing Add connector can see what they have to go and get, rather than finding out at the
    // key form on the card afterwards.
    const presetHints = presets.length ? `<div class="plugin-list" data-connector-preset-hints></div>` : "";
    const doors = BYO_DOORS
      .map((door) => `<button class="roster-tab${byoDoor === door.id ? " is-active" : ""}" type="button" data-byo-door="${door.id}" title="${escapeHtml(door.blurb)}">${escapeHtml(door.label)}</button>`)
      .join("");
    const panel = byoDoor === "program" ? byoProgramDoorMarkup() : byoDoor === "paste" ? byoPasteDoorMarkup() : byoLinkDoorMarkup();
    const refusal = byoRefusalText ? `<div class="empty-state" data-byo-refusal>${escapeHtml(byoRefusalText)}</div>` : "";
    const note = byoNote ? `<div class="demo-note" data-byo-note>${escapeHtml(byoNote)}</div>` : "";
    return `<details class="panel-card" data-connector-editor><summary>Add your own</summary>`
      + `<p class="field-hint">Anything this catalog does not carry, you add here. The box starts it, lists its tools, and it appears on the Plugins page like any other. A key it needs goes in the masked box on its own page afterwards, where the host stores it — never in the file on the box.</p>`
      + `${presetRow}${presetHints}`
      + `<div class="roster-tabs" data-byo-doors>${doors}</div>`
      + `<div data-byo-panel>${panel}${refusal}${note}${byoPreviewMarkup()}</div>`
      + `<div class="plugin-list">${rows}</div>${byoOrphanStripMarkup()}</details>`;
  }

  // The link form as a spec, read out of the DOM at the moment it is used rather than tracked in a
  // variable per keystroke: the fields are the truth, and a mirror of them is one more thing that
  // can be wrong.
  function byoLinkSpec(form) {
    const root = form ?? elements.panelContent.querySelector("[data-byo-link]");
    if (!root || typeof adapter.byoRemoteSpec !== "function") return null;
    const value = (selector) => root.querySelector(selector)?.value ?? "";
    const headers = byoHeaders.map((row, index) => ({
      name: root.querySelector(`[data-byo-header-name="${index}"]`)?.value ?? row.name,
      secret: row.secret === true,
      env: root.querySelector(`[data-byo-header-env="${index}"]`)?.value ?? row.env,
      value: root.querySelector(`[data-byo-header-value="${index}"]`)?.value ?? row.value,
    })).filter((row) => String(row.name ?? "").trim().length > 0);
    return adapter.byoRemoteSpec({
      name: value("#byo-name"),
      url: value("#byo-url"),
      transport: value("#byo-transport"),
      headers,
    });
  }

  // What the link door's own three fields hold right now, kept so a repaint can put them back.
  // Adding a header row redraws the door; without this it redrew an empty one, and the address
  // someone had just pasted was gone.
  function byoCaptureLink() {
    const root = elements.panelContent.querySelector("[data-byo-link]");
    if (!root) return;
    const nameBox = root.querySelector("#byo-name");
    byoLink = {
      url: root.querySelector("#byo-url")?.value ?? byoLink.url,
      name: nameBox?.value ?? byoLink.name,
      transport: root.querySelector("#byo-transport")?.value ?? byoLink.transport,
      named: byoLink.named || nameBox?.dataset.touched === "1",
    };
  }

  // Repaint the doors alone. The whole panel would take the operator's typing with it, and this is
  // called while they are typing.
  function repaintByoPanel() {
    const panel = elements.panelContent.querySelector("[data-byo-panel]");
    if (!panel) { paintMarketplaceBody(); return; }
    byoCaptureLink();
    const door = byoDoor === "program" ? byoProgramDoorMarkup() : byoDoor === "paste" ? byoPasteDoorMarkup() : byoLinkDoorMarkup();
    const refusal = byoRefusalText ? `<div class="empty-state" data-byo-refusal>${escapeHtml(byoRefusalText)}</div>` : "";
    const note = byoNote ? `<div class="demo-note" data-byo-note>${escapeHtml(byoNote)}</div>` : "";
    panel.innerHTML = `${door}${refusal}${note}${byoPreviewMarkup()}`;
  }

  // Everything below the form: the refusal, the note and the preview. Repainted on its own so the
  // fields keep their values and the caret keeps its place.
  function repaintByoVerdict() {
    const panel = elements.panelContent.querySelector("[data-byo-panel]");
    if (!panel) return;
    for (const stale of panel.querySelectorAll("[data-byo-refusal], [data-byo-note], [data-byo-preview]")) stale.remove();
    const refusal = byoRefusalText ? `<div class="empty-state" data-byo-refusal>${escapeHtml(byoRefusalText)}</div>` : "";
    const note = byoNote ? `<div class="demo-note" data-byo-note>${escapeHtml(byoNote)}</div>` : "";
    panel.insertAdjacentHTML("beforeend", `${refusal}${note}${byoPreviewMarkup()}`);
  }

  // Ask the host what it would write, then draw it. A refusal stops before the ask, because the
  // sentence an operator needs is the one about what is wrong, not one about a preview.
  function showByoPreview(spec) {
    byoRefusalText = typeof adapter.byoRefusal === "function" ? adapter.byoRefusal(spec) : null;
    if (byoRefusalText) { byoPreview = null; repaintByoVerdict(); return Promise.resolve(false); }
    if (typeof adapter.byoPreview !== "function") { byoPreview = null; repaintByoVerdict(); return Promise.resolve(true); }
    return Promise.resolve(adapter.byoPreview(spec))
      .then((preview) => { byoPreview = preview; repaintByoVerdict(); return true; })
      .catch(() => { byoPreview = null; repaintByoVerdict(); return true; });
  }

  function refreshByoOrphans() {
    if (typeof adapter.listConnectorSecretOrphans !== "function") return;
    Promise.resolve(adapter.listConnectorSecretOrphans())
      .then((rows) => {
        byoOrphans = rows;
        const strip = elements.panelContent.querySelector("[data-byo-orphans]");
        const next = byoOrphanStripMarkup();
        if (strip) { if (next) strip.outerHTML = next; else strip.remove(); return; }
        if (next) elements.panelContent.querySelector("[data-connector-editor]")?.insertAdjacentHTML("beforeend", next);
      })
      .catch(() => { byoOrphans = null; });
  }
  // The controls on the card, in one place. Each returns true when it took the click, so the long
  // chain in handlePanelClick never has to know these exist.
  function handleByoClick(target) {
    if (target.dataset.byoDoor) {
      // Switching doors throws away the last door's verdict rather than leaving a refusal about an
      // address sitting under a form asking for a command.
      byoDoor = target.dataset.byoDoor;
      byoRefusalText = null;
      byoNote = null;
      byoPreview = null;
      repaintByoPanel();
      return true;
    }
    if (target.hasAttribute("data-byo-header-add")) {
      byoHeaders = [...byoLiveHeaders(), { name: "", secret: false, env: "", value: "" }];
      repaintByoPanel();
      return true;
    }
    if (target.dataset.byoHeaderRemove) {
      const index = Number(target.dataset.byoHeaderRemove);
      byoHeaders = byoLiveHeaders().filter((row, at) => at !== index);
      repaintByoPanel();
      return true;
    }
    if (target.hasAttribute("data-byo-show")) {
      const spec = byoLinkSpec();
      if (spec) showByoPreview(spec);
      return true;
    }
    if (target.dataset.byoClearOrphan) {
      const server = target.dataset.byoClearOrphan;
      if (typeof adapter.clearConnectorSecretOrphan !== "function") return true;
      target.disabled = true;
      Promise.resolve(adapter.clearConnectorSecretOrphan(server))
        .then((result) => { showToast(result?.message ?? `${server} cleared from the host's store.`); refreshByoOrphans(); })
        .catch((error) => { target.disabled = false; showToast(`${server} was not cleared: ${error.message}`); });
      return true;
    }
    return false;
  }

  // What the header rows hold RIGHT NOW, fields included. Adding or removing a row repaints the
  // list, and repainting from the variable alone would put every other row back to what it was
  // when the form was drawn, which is how a form eats what someone typed.
  function byoLiveHeaders() {
    const root = elements.panelContent.querySelector("[data-byo-link]");
    if (!root) return byoHeaders;
    return byoHeaders.map((row, index) => ({
      name: root.querySelector(`[data-byo-header-name="${index}"]`)?.value ?? row.name,
      secret: row.secret === true,
      env: root.querySelector(`[data-byo-header-env="${index}"]`)?.value ?? row.env,
      value: root.querySelector(`[data-byo-header-value="${index}"]`)?.value ?? row.value,
    }));
  }

  // Typing the address fills in the name a secret header will be stored under, so the box is
  // already right rather than looking like one more thing to invent. Only a box the operator has
  // not written in: once they have named it, it is theirs.
  function handleByoInput(event) {
    const named = event.target.closest?.("[data-byo-link] #byo-name");
    if (named) { named.dataset.touched = "1"; return; }
    const field = event.target.closest?.("[data-byo-link] #byo-url");
    if (!field || typeof adapter.byoEnvNameFor !== "function") return;
    const url = field.value ?? "";
    const root = elements.panelContent.querySelector("[data-byo-link]");
    if (!root) return;
    const taken = [];
    byoHeaders.forEach((row, index) => {
      const box = root.querySelector(`[data-byo-header-env="${index}"]`);
      if (!box) return;
      const name = root.querySelector(`[data-byo-header-name="${index}"]`)?.value ?? row.name;
      if (box.value && box.value !== row.env) { taken.push(box.value); return; }
      const minted = adapter.byoEnvNameFor(url, name, taken);
      box.value = minted;
      row.env = minted;
      taken.push(minted);
    });
    // The name the box files the server under follows the address too, until it is typed in.
    const nameBox = root.querySelector("#byo-name");
    if (nameBox && !nameBox.dataset.touched && typeof adapter.byoNameFromUrl === "function") nameBox.value = adapter.byoNameFromUrl(url);
  }

  // The tick. Turning it ON mints the name the host will store the key under, from the address and
  // the header, and DROPS whatever was in the value box: a literal must not survive as one.
  function handleByoHeaderToggle(event) {
    const box = event.target.closest?.("[data-byo-header-secret]");
    if (!box) return;
    const index = Number(box.dataset.byoHeaderSecret);
    const live = byoLiveHeaders();
    const row = live[index];
    if (!row) return;
    const url = elements.panelContent.querySelector("[data-byo-link] #byo-url")?.value ?? "";
    const taken = live.filter((other, at) => at !== index).map((other) => String(other.env ?? "")).filter(Boolean);
    live[index] = box.checked
      ? { name: row.name, secret: true, env: typeof adapter.byoEnvNameFor === "function" ? adapter.byoEnvNameFor(url, row.name, taken) : "", value: "" }
      : { name: row.name, secret: false, env: "", value: "" };
    byoHeaders = live;
    repaintByoPanel();
  }

  // Add, from the link door. The refusal is checked first and drawn on the card rather than fired
  // as a toast: it names something to change in a field that is still on screen.
  function submitByoLink(form) {
    const spec = byoLinkSpec(form);
    if (!spec) { showToast("This console has no gateway behind it, so there is nothing to add a server to."); return; }
    byoRefusalText = typeof adapter.byoRefusal === "function" ? adapter.byoRefusal(spec) : null;
    if (byoRefusalText) { byoPreview = null; repaintByoVerdict(); return; }
    const submit = form.querySelector("button[type=submit]");
    if (submit) submit.disabled = true;
    Promise.resolve(adapter.addLocalConnector(spec))
      .then((result) => {
        if (submit) submit.disabled = false;
        if (result?.accepted === false) {
          byoRefusalText = result?.message ?? null;
          repaintByoVerdict();
          showToast(result?.message ?? `${spec.name} was not added`);
          return;
        }
        byoRefusalText = null;
        byoPreview = null;
        byoHeaders = [{ name: "Authorization", secret: true, env: "", value: "" }];
        byoLink = { url: "", name: "", transport: "http", named: false };
        showToast(result?.message ?? `${spec.name} added`);
        // Straight to its own page, where the key box and the tools list are. The health line
        // catches up on the refresh; waiting for it here leaves a blank card for the host's full
        // sixty-second connect timeout, which is the normal case for a server with no key yet.
        marketplacePluginId = `mcp:${spec.name}`;
        marketplaceArmedUninstall = null;
        paintMarketplaceBody();
        refreshMarketplace();
      })
      .catch((error) => { if (submit) submit.disabled = false; showToast(`${spec.name} was not added: ${error.message}`); });
  }

  // Paste. Reads the vendor's block into whichever door fits it and stops there: the operator
  // presses Add on a form they can read, which is the whole point of taking the block at all.
  function submitByoPaste(form) {
    const text = form.querySelector("[name=block]")?.value ?? "";
    const read = typeof adapter.byoParsePasted === "function" ? adapter.byoParsePasted(text) : null;
    if (!read) { showToast("This console cannot read a config block on its own."); return; }
    if (!read.ok) { byoRefusalText = read.message; byoNote = null; byoPreview = null; repaintByoVerdict(); return; }
    byoRefusalText = null;
    byoNote = read.note;
    byoDoor = read.door;
    if (read.door === "link") {
      byoHeaders = (read.spec.headers ?? []).map((row) => ({ name: row.name, secret: row.secret === true, env: row.env ?? "", value: row.value ?? "" }));
    }
    repaintByoPanel();
    byoFillFromSpec(read.spec);
    showByoPreview(read.spec);
  }

  // The block that was read, written into the door's fields. Done after the repaint so it is
  // writing into the form that is actually on screen.
  function byoFillFromSpec(spec) {
    const set = (selector, value) => { const field = elements.panelContent.querySelector(selector); if (field) field.value = value; };
    if (spec?.shape === "remote") {
      // Into the variable as well as into the fields: the next repaint draws from the variable.
      byoLink = { url: spec.url ?? "", name: spec.name ?? "", transport: spec.transport ?? "http", named: true };
      set("[data-byo-link] #byo-url", byoLink.url);
      set("[data-byo-link] #byo-name", byoLink.name);
      set("[data-byo-link] #byo-transport", byoLink.transport);
      const nameBox = elements.panelContent.querySelector("[data-byo-link] #byo-name");
      if (nameBox) nameBox.dataset.touched = "1";
      return;
    }
    set("[data-add-connector] [name=name]", spec?.name ?? "");
    set("[data-add-connector] [name=command]", spec?.command ?? "");
    set("[data-add-connector] [name=args]", typeof adapter.joinConnectorArgs === "function"
      ? adapter.joinConnectorArgs(spec?.args ?? [])
      : (spec?.args ?? []).join(" "));
    set("[data-add-connector] [name=envNames]", (spec?.envNames ?? []).join(", "));
  }
  // ---- end MARKET-6: Add your own ---------------------------------------------------------------

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
    // BOX-6b. The repair itself, where the failed turn's line sends the person. Drawn only when
    // this box's host has the verb AND this agent is in that state: a button offered to a healthy
    // agent is an invitation to run a recovery on a store that does not need one. Nothing here is
    // armed twice like Delete is -- a repair keeps every entry it can and quarantines rather than
    // deletes, so the cost of pressing it is a few seconds, not a conversation.
    const canRepair = typeof adapter.repairTranscript === "function"
      && (typeof adapter.canRepairTranscript !== "function" || adapter.canRepairTranscript() === true);
    const repair = canRepair && needsRepair(worker)
      ? `<section class="settings-section" data-repair-for="${escapeHtml(worker.id)}"><div class="setting-row"><div><strong>Conversation store</strong><small>${escapeHtml(
        (typeof worker.needsRepairReason === "string" && worker.needsRepairReason.trim())
          || "This agent's conversation store needs repair, so every turn ends without an answer. Repairing turns the stuck state off and sets aside anything unreadable so the next message can rebuild the conversation. Nothing is deleted.",
      )}</small></div><button class="primary-button" type="button" data-repair-transcript="${escapeHtml(worker.id)}">Repair</button></div><p class="field-hint" data-repair-note hidden></p></section>`
      : "";
    return `<div class="panel-grid"><section class="panel-card"><div class="panel-card-header">${avatarMarkup(worker, "context-profile-avatar")}<span class="status-pill ${worker.status === "working" ? "working" : worker.status === "attention" ? "" : "success"}">${escapeHtml(worker.statusText)}</span></div><h3>${escapeHtml(worker.name)}</h3><p>${escapeHtml(worker.role || "No role set on the host.")}</p><div class="tag-list"><span class="tag">endpoint (box-wide) · ${escapeHtml(model ? model.name : worker.model)}</span><span class="tag">${worker.files.length} files</span><span class="tag">${routines.length} routines</span></div></section>${repair}<section class="settings-section"><h3>Agent-owned context</h3><p>The direct transcript, the role and the routines shown here belong to this agent. The endpoint and the box's screens belong to the whole box and are shared with every other agent on it.</p>${identity}${role}${avatar}${switches}<div class="setting-row"><div><strong>Direct conversation</strong><small>Operator-to-agent thread</small></div><span class="status-pill ${worker.status === "working" ? "working" : ""}">${escapeHtml(worker.statusText)}</span></div>${browser}${hygiene}</section>${memories}${audit}</div>`;
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

  // ---- BOX-6b: pressing Repair -----------------------------------------------------------------
  // The host answers {before, after, quarantined, outcome}. Two things this must not do. It must
  // not read `quarantined: null` as a failure -- the one real case in production, the demo tenant's
  // Titan, had two healthy databases and nothing to move aside, so a null there is the normal
  // answer for the commonest damage shape. And it must not decide for itself that a repair worked:
  // an outcome word it does not recognise is printed as the host said it, not translated into
  // success.
  //
  // The judge of "did it work" is the adapter's, read through the global rather than copied. The
  // adapter uses the same one to decide whether to forget the failure this page saw, and a console
  // whose button says "Repaired" while its pill still says "Needs repair" has told the person two
  // different things about one press. There is no fallback on purpose: the control is only drawn
  // where `adapter.repairTranscript` exists, and the file that defines it is the file that
  // publishes the judge, so one cannot be on the page without the other.
  function repairOutcomeWords(answer) {
    const kept = Number.isFinite(answer.after) ? answer.after : null;
    const judge = typeof window !== "undefined" ? window.__transcriptRepair : null;
    const worked = judge?.worked(answer) === true;
    const moved = (answer.quarantined ?? []).length;
    // The host could only turn the stuck state off. Nothing was repaired and no count was kept, so
    // this says what it did and what to do next instead of claiming a repair. The control and the
    // pill still go -- the state really is off -- and the next message either works or puts it back.
    if (judge?.cleared?.(answer) === true) {
      const why = (answer.reason || "").trim();
      return {
        worked: true,
        text: `Cleared the stuck state. Send this agent one message: if it answers, it is back. If it fails the same way, this store needs a person${why ? `, and the reason it gave was: ${why}` : ""}.`,
      };
    }
    if (!worked) {
      const said = (answer.reason || answer.outcome || "").trim();
      // The host's own sentence, with no prefix and no status word in front of it.
      return { worked: false, text: said ? `That did not repair it: ${said}` : "That did not repair it, and the box did not say why. The host log on this box has the detail." };
    }
    // MEASURED on grok-bot-local-vm: a store with nothing wrong with it answers `already-healthy`
    // with before and after both 0. "Repaired, 0 entries kept" would be a strange thing to read
    // after pressing Repair on an agent that was refusing every turn, so that case says what
    // actually happened.
    const headline = answer.outcome.toLowerCase() === "already-healthy" && !kept
      ? "There was nothing to repair here."
      : kept == null ? "Repaired." : `Repaired, ${kept} ${kept === 1 ? "entry" : "entries"} kept.`;
    const set = moved === 0
      ? ""
      : moved === 1
        ? ` The damaged file was set aside as ${answer.quarantined[0]}; nothing was deleted.`
        : ` ${moved} damaged files were set aside; nothing was deleted.`;
    const lost = kept != null && Number.isFinite(answer.before) && answer.before > kept
      ? ` ${answer.before - kept} could not be read back.`
      : "";
    return { worked: true, text: `${headline}${lost}${set} Ask this agent something and it should answer now.` };
  }

  function repairTranscriptFromPanel(button, agentId) {
    const note = elements.panelContent.querySelector("[data-repair-note]");
    const say = (text) => { if (note) { note.hidden = false; note.textContent = text; } };
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Repairing…";
    say("Repairing this agent's conversation store. On a long conversation this takes a moment.");
    return Promise.resolve(adapter.repairTranscript(agentId))
      .then((answer) => {
        if (answer == null) {
          // The box runs a bundle without the verb. Say so and take the button away rather than
          // leaving a control that can only ever do nothing.
          button.remove();
          say("This box's software does not have the repair yet. It arrives with the next update.");
          return null;
        }
        const words = repairOutcomeWords(answer);
        say(words.text);
        if (!words.worked) { button.disabled = false; button.textContent = label; return answer; }
        button.remove();
        // The pill and the status line go now rather than on the next 15 s heartbeat. The host's
        // own verdict overwrites this on the next roster read either way, so a repair that only
        // half worked does not stay hidden behind an optimistic console.
        const record = workerById(agentId) ?? contextRecord();
        if (record) { record.needsRepair = false; record.needsRepairReason = ""; }
        renderRoster();
        renderConversationHeader();
        return answer;
      })
      .catch((error) => {
        button.disabled = false;
        button.textContent = label;
        say(`That did not repair it: ${String(error?.message ?? error).replace(/\s*\.$/, "")}. Nothing was changed.`);
        return null;
      });
  }
  // ---- end BOX-6b ------------------------------------------------------------------------------

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
    // PROXY-1: an empty string for `empty` means draw nothing at all. A console with no plan --
    // a developer Mac, a single-box install, a customer whose control plane has no proxy -- must
    // not show a heading called "Included with your plan" over an empty box, because that heading
    // is a promise and there is nothing behind it. Every other group keeps its sentence, which is
    // information rather than a promise: the relay looked and there were none.
    if (!members.length) return empty ? `<section class="settings-section" data-plugin-group="${escapeHtml(group)}">${head}<div class="empty-state">${escapeHtml(empty)}</div></section>` : "";
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

  /**
   * SETTINGS-2: this function is now the OPERATOR section's body and nothing else.
   *
   * Everything it draws is what it drew before -- the endpoint picker, the three provider groups,
   * the review policy, the job bus card, the mail card, the host's version with Update and Reset --
   * because none of it has changed in behaviour. What changed is who sees it: a customer's Settings
   * is six plain sections built by ui/machine-room/settings.js, and this is the one section only the
   * operator is given, gated server-side on the operator field of GET /auth/state.
   * docs/SETTINGS.md section 2 is the row-by-row map of where every old card went.
   *
   * ONE structural change: the wrapper carries .settings-operator-list beside the .settings-list it
   * always had. It KEEPS .settings-list on purpose. That selector is how voice.js finds where to put
   * its own card -- "#panel-content .settings-list", then after [data-mail] -- and the operator's
   * stack is exactly where the voice service, model and voice rows belong. push-settings.js no longer
   * shares that class: it aims at [data-push-mount], the Notifications body's own slot, so the two
   * cards can never land on each other's section.
   */
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
      ? `<section class="settings-section" data-updates-panel><h3>Updates</h3><p>The host bundle this box runs, as getHostStatus reports it. Moving a box onto a newer bundle is the Update button below, and it is enabled only while a newer bundle is actually published: since cc2de54 a swap installs the bundle&#39;s own box-scripts and the window repair patches that copy too, so a box carrying a local patch is not offered one and nothing hand-applied is silently thrown away.</p><div class="setting-row"><div><strong>Host version</strong><small data-host-version>Reading from the host…</small></div><span class="status-pill" data-host-update>…</span></div>${boxAgent ? `<div class="setting-row"><div><strong>Update ${escapeHtml(boxAgent.name)}'s computer</strong><small>Moves the box to a fresh instance and keeps files and logins. Two clicks.</small></div><button class="ghost-button" type="button" data-update-box="${escapeHtml(boxAgent.id)}"${typeof adapter.updateBox === "function" ? "" : " disabled"}>Update</button></div><div class="setting-row"><div><strong>Reset ${escapeHtml(boxAgent.name)}'s computer</strong><small>Restores the box from its last snapshot. Recent unsynced work can be lost — prefer Update. Two clicks.</small></div><button class="danger-button" type="button" data-reset-box="${escapeHtml(boxAgent.id)}"${typeof adapter.resetBox === "function" ? "" : " disabled"}>Reset</button></div>` : ""}</section>`
      : "";
    // SETTINGS-2: where the keys went, said once at the top of the operator's own section so nobody
    // goes looking for the two fields that used to be on the cards below.
    const keysLine = `<section class="settings-section" data-operator-session><h3>This session</h3><p>You are signed in as the operator, which is why you can see this section at all. A customer's Settings has the five plain sections above it and nothing here.</p><div class="setting-row"><div><strong>Keys the product uses</strong><small>The key the product talks with and the key it sends mail with are pasted once in the admin console, not per workspace.</small></div><a class="ghost-button" href="https://api.titanium.bot/admin" target="_blank" rel="noopener">Open the admin console</a></div></section>`;
    return `<div class="panel-intro"><p>Inference and review policy are global on this host. Routines stay attached to individual agents and rooms.</p><span class="status-pill${state.settings.reachable ? " success" : ""}">${state.settings.reachable ? "Host settings loaded" : "Host settings unreachable"}</span></div><div class="settings-list settings-operator-list"><section class="settings-section"><h3>Inference</h3><p>This host routes every agent through a single endpoint. Per-agent models are not something it can do.</p>${rows}</section>${pluginGroupSection("Plan", "Included with your plan", "Models your plan already pays for. There is no key to paste and nothing to connect \u2014 pick one and every agent on this box answers through it from the next message.", "")}${pluginGroupSection("Providers", "Your own keys", "A provider you bring yourself. Adopting one stores its credential in the relay's 0600 store; switching one is the endpoint row above. Your own key always wins over what your plan includes.", "The relay reports no providers for this box.")}${pluginGroupSection("Listeners", "Chat listeners", "The chat platforms the host binds to. A listener binds to one agent at a time — the agent whose conversation is on screen.", "This host reports no chat listeners.")}<section class="settings-section"><div class="setting-row"><div><strong>Natural-language auto-review</strong><small>${state.settings.autoReview.enabled ? "Armed. The host checks each action against the instructions below." : "Off. Every tool an agent holds runs without review."}</small></div><button class="switch" type="button" id="auto-review-toggle" aria-pressed="${state.settings.autoReview.enabled}"></button></div><div class="field"><label for="auto-review-rule">Ask me before…</label><textarea id="auto-review-rule" rows="3" placeholder="e.g. sending email, deleting anything, spending money">${escapeHtml((state.settings.autoReview.block ?? []).join("\n"))}</textarea></div>${(state.settings.autoReview.allow ?? []).length ? `<div class="setting-row"><div><strong>Always allowed</strong><small>${escapeHtml((state.settings.autoReview.allow ?? []).join("; "))}</small></div></div>` : ""}${state.settings.localToolPermission ? `<div class="setting-row"><div><strong>Local tool permission</strong><small>The host is set to "${escapeHtml(state.settings.localToolPermission)}" for tools that run on this machine.</small></div><span class="status-pill">${escapeHtml(state.settings.localToolPermission)}</span></div>` : ""}<div class="form-actions"><button class="primary-button" type="button" data-save-review>Save policy</button></div></section>${jobBusSection()}${mailSection()}${updates}${keysLine}</div>`;
  }

  // Which settings section is on screen right now, in the openPluginSurface mould. The two live
  // refills below read it: with one body painted at a time, a heartbeat that refilled the job bus or
  // the endpoint rows while General was showing would paint into a section that is not drawn.
  // settings.js is the only writer -- it dispatches the event on every paint -- so this stays true
  // however the person got there.
  let settingsSection = null;
  document.addEventListener("titanbot:settings-section", (event) => { settingsSection = event.detail?.id ?? null; });

  /** Fills every live value on the operator section, which is where all four of these cards live. */
  function fillOperatorSettings() {
    fillEndpoints();
    fillHostStatus();
    fillJobBus();
    fillMail();
  }

  function openSettingsPanel(section = "general") {
    openPluginSurface = "settings";
    // SETTINGS-2: the surface is ui/machine-room/settings.js, a sibling module on the CONSOLE-4
    // seam. It reads the operator body and its fill out of __mrUi.settingsHost below, so this file
    // still owns every control on that section.
    if (window.__mrSettings?.open?.(section) === true) return;
    // ABSENT-MODULE BEHAVIOUR, AND IT IS GATED ON WHO IS LOOKING. With settings.js not served -- a
    // deploy fault, and a gate leg -- the old panel is the operator body: two password fields, the
    // endpoint picker, the job bus, the mail plane and the red Reset. Painting that for a customer
    // because one file failed to load hands them every row this wave exists to hide, so the fallback
    // asks the relay who this is first and a customer gets one plain line instead.
    //
    // FAIL CLOSED, the same rule settings.js's own nav follows: the answer is the operator field of
    // GET /auth/state and nothing else. Absent, unreadable, or no such field means not the operator.
    openPanel("Your workspace", "Settings", `<div class="panel-intro"><p>Settings could not load. Reload the page.</p></div>`);
    settingsSection = null;
    if (typeof adapter.getWorkspaceIdentity !== "function") return;
    Promise.resolve(adapter.getWorkspaceIdentity()).then((me) => {
      // The person may have moved on while that was in flight; repainting the panel under them would
      // be the same bug as a heartbeat filling a section nobody is looking at.
      if (me?.operator !== true || openPluginSurface !== "settings") return;
      openPanel("Your workspace", "Settings", settingsPanel());
      settingsSection = "operator";
      fillOperatorSettings();
    }).catch(() => {});
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

  // ---- JOBBUS-3: Settings -> Job bus (docs/JOB-BUS.md §7, hardened by §10.7) -------------------
  // Every value on this card is read back from the relay and the host after the panel opens, the
  // way the endpoint rows are. A click never paints its own outcome: the card refills from what
  // answered, so it cannot say a token is configured because a button was pressed.
  //
  // The settings half goes through jobBusGetSettings / jobBusSetSettings, the bus's own file, not
  // getHostSettings: §10.7 retired the SAND_JOB_BUS_* names, and a bus that read its policy from
  // the host settings map would be armed by anything that writes that map.
  const JOB_STATUS_PILL = {
    queued: "status-pill", running: "status-pill", needs_human: "status-pill attention",
    done: "status-pill success", failed: "status-pill bad", cancelled: "status-pill muted",
  };
  // The shape §10.7 fixes. It is what the card draws over a host that answered a partial object,
  // and never what it draws when the host answered nothing at all: that case says so instead.
  const JOB_BUS_DEFAULTS = {
    enabled: false,
    workers: { "nextgen.chapter": "Scribe" },
    repos: ["webdevtodayjason/nextgen-training"],
    allowedConnectors: ["github"],
    timeoutMin: 120,
    queueTimeoutMin: 60,
    maxOpen: 20,
    allowUnattested: false,
  };
  // The full id is on the row's title; the table shows enough of it to match a CoS log line.
  const shortJobId = (id) => (String(id).length > 15 ? `${String(id).slice(0, 15)}…` : String(id));
  const jobWhen = (at) => {
    const ms = Date.parse(String(at ?? ""));
    return Number.isFinite(ms) ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms) : "";
  };
  // One line per job: what it produced, or what a person has to go and do.
  function jobLine(job) {
    if (job.status === "needs_human" && job.needs_human) return `${job.needs_human.reason ?? "blocked"}: ${job.needs_human.detail ?? ""}`;
    if (job.status === "failed") return job.error ?? job.result?.summary ?? "the job failed";
    if (job.result?.summary) return job.result.summary;
    return "";
  }

  // §10.2 stores an agent id and accepts a name only while exactly one agent carries it. The card
  // does the same resolution on the way in, so a mapping written as "Scribe" selects that agent
  // and is saved back as its id, and an ambiguous or absent name is left exactly as it was found.
  function jobBusAgentId(value) {
    const roster = state.workers ?? [];
    if (roster.some((worker) => worker.id === value)) return value;
    const named = roster.filter((worker) => worker.name === value);
    return named.length === 1 ? named[0].id : value;
  }

  function jobBusAgentOptions(selected) {
    const roster = state.workers ?? [];
    const options = roster.map((worker) =>
      `<option value="${escapeHtml(worker.id)}"${worker.id === selected ? " selected" : ""}>${escapeHtml(worker.name)}</option>`);
    // A mapping naming an agent this box does not have is kept on screen and kept on save: the
    // bus stops those jobs on needs_human no_worker, which is the honest outcome. Repointing it
    // at whoever happens to be first in the roster would run the work somewhere nobody chose.
    if (!selected) options.unshift(`<option value="" selected>Choose an agent</option>`);
    else if (!roster.some((worker) => worker.id === selected)) {
      options.unshift(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (not an agent on this box)</option>`);
    }
    return options.join("");
  }

  function jobBusWorkerRow(type, agent) {
    return `<div class="job-bus-worker-row" data-job-bus-worker><input type="text" aria-label="Job type" placeholder="nextgen.chapter" data-job-bus-worker-type value="${escapeHtml(type)}" /><span class="job-bus-arrow" aria-hidden="true">&rarr;</span><select aria-label="Worker agent" data-job-bus-worker-agent>${jobBusAgentOptions(agent)}</select><button class="ghost-button" type="button" data-job-bus-row-remove aria-label="Remove this job type">Remove</button></div>`;
  }

  // The repos allowlist and the connectors the per-job clone keeps are both plain lists of
  // strings, so one row builder draws them rather than two that drift apart.
  function jobBusListRow(kind, value) {
    const label = kind === "repo" ? "Allowed repository" : "Allowed connector";
    const placeholder = kind === "repo" ? "owner/name" : "github";
    return `<div class="job-bus-list-row" data-job-bus-${kind}><input type="text" aria-label="${label}" placeholder="${placeholder}" data-job-bus-${kind}-value value="${escapeHtml(String(value ?? ""))}" /><button class="ghost-button" type="button" data-job-bus-row-remove aria-label="Remove this entry">Remove</button></div>`;
  }

  function jobBusSection() {
    if (typeof adapter.getJobBusStatus !== "function") return "";
    return `<section class="settings-section" data-job-bus><h3>Job bus</h3><p>An allowlisted job API for the Chief of Staff. It publishes no shell, no browser and no desktop: a caller posts a job of an allowed type and reads back a result the host checked against the receipts of the tools its worker actually ran, and against GitHub itself. The contract is docs/JOB-BUS.md.</p>`
      + `<div class="setting-row"><div><strong>Enabled</strong><small data-job-bus-enabled-note>Reading from the host…</small></div><button class="switch" type="button" data-job-bus-enabled aria-pressed="false"></button></div>`
      + `<div class="setting-row"><div><strong>Store integrity</strong><small data-job-bus-integrity>Reading from the host…</small></div></div>`
      + `<div class="setting-row"><div><strong>Token</strong><small data-job-bus-state>Reading from the relay…</small></div><span class="status-pill" data-job-bus-pill>…</span></div>`
      + `<div class="setting-row"><div><strong>Base URL</strong><small data-job-bus-base>…</small></div></div>`
      + `<div class="setting-row"><div><strong>Set the bearer</strong><small>Generate one here, or paste the value you set on the deployment. It is compared in constant time and never written to a log, an audit row or a job body. Generating or setting one also turns the bus on.</small></div><div class="field"><input id="job-bus-token" type="password" autocomplete="off" placeholder="At least 32 characters" data-job-bus-input /></div></div>`
      + `<div class="form-actions"><button class="primary-button" type="button" data-job-bus-generate>Generate</button><button class="ghost-button" type="button" data-job-bus-set>Set</button><button class="danger-button" type="button" data-job-bus-clear>Clear</button></div>`
      + `<div class="job-bus-minted" data-job-bus-minted hidden><label for="job-bus-minted-value">The new token</label><div class="job-bus-copy-row"><input id="job-bus-minted-value" type="text" readonly data-job-bus-minted-value /><button class="ghost-button" type="button" data-job-bus-copy>Copy</button></div><small class="field-hint">Copy it now. This is the only time it is shown, and nothing on this box can read it back.</small></div>`
      + `<div class="job-bus-block"><strong>Try it</strong><pre class="job-bus-curl" data-job-bus-curl></pre></div>`
      + `<div class="job-bus-block"><strong>Workers</strong><small class="field-hint">Which agent runs each job type. The bus never sends the prompt into that agent's own conversation: it clones the agent per job, strips every connector but the ones below, and deletes the clone when the job ends. A type pointing at no agent on this box stops its jobs on needs_human rather than running them somewhere else.</small><div data-job-bus-workers></div><div class="form-actions"><button class="ghost-button" type="button" data-job-bus-worker-add>Add a type</button></div></div>`
      + `<div class="job-bus-block"><strong>Repositories</strong><small class="field-hint">The only repositories a job may name. A payload pointing anywhere else is refused with 400 before any worker sees it.</small><div data-job-bus-repos></div><div class="form-actions"><button class="ghost-button" type="button" data-job-bus-repo-add>Add a repository</button></div></div>`
      + `<div class="job-bus-block"><strong>Connectors the clone keeps</strong><small class="field-hint">Everything else is stripped from the per-job clone before the prompt is sent. If they cannot be stripped the job stops on needs_human rather than running with them.</small><div data-job-bus-connectors></div><div class="form-actions"><button class="ghost-button" type="button" data-job-bus-connector-add>Add a connector</button></div></div>`
      + `<div class="setting-row"><div><strong>Unattested jobs</strong><small data-job-bus-allow-unattested-note>Off. A job body asking for <code>require_attestation:false</code> is refused with 400 “attestation is required”, so nothing reaches done on the model's word alone.</small></div><button class="switch" type="button" data-job-bus-allow-unattested aria-pressed="false"></button></div>`
      + `<div class="job-bus-block"><strong>Limits</strong><small class="field-hint">Minutes for the two timeouts, a count for the open jobs. Queued past the first, a job fails as queued too long; running past the second it fails as timed out; a create beyond the third answers 429 queue full.</small><div class="job-bus-limits"><label>Queue timeout (min)<input type="number" min="1" step="1" data-job-bus-queue-timeout /></label><label>Run timeout (min)<input type="number" min="1" step="1" data-job-bus-timeout /></label><label>Max open jobs<input type="number" min="1" step="1" data-job-bus-max-open /></label></div></div>`
      + `<div class="form-actions"><button class="primary-button" type="button" data-job-bus-settings-save>Save job bus settings</button></div>`
      + `<div class="job-bus-block"><strong>Jobs</strong><div class="job-bus-table-wrap"><table class="job-bus-table"><thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Worker</th><th>Created</th><th>Result</th></tr></thead><tbody data-job-bus-rows><tr><td colspan="6">Reading from the host…</td></tr></tbody></table></div></div>`
      + `</section>`;
  }

  function fillJobBus() {
    const root = elements.panelContent.querySelector("[data-job-bus]");
    if (!root || typeof adapter.getJobBusStatus !== "function") return;
    const line = root.querySelector("[data-job-bus-state]");
    const pill = root.querySelector("[data-job-bus-pill]");
    const base = root.querySelector("[data-job-bus-base]");
    const curl = root.querySelector("[data-job-bus-curl]");
    adapter.getJobBusStatus().then((status) => {
      const where = status.source === "env"
        ? " from the TITAN_JOB_TOKEN environment variable on this deployment, which wins over anything written here"
        : status.source === "file" ? " from the token file the console wrote beside the relay's profile" : "";
      line.textContent = status.configured
        ? `Configured${where}.`
        : "No token, so every /v1 request is refused with 401. Generate one, or set TITAN_JOB_TOKEN on the deployment.";
      pill.textContent = status.configured ? (status.source === "env" ? "env" : "configured") : "not configured";
      pill.className = status.configured ? "status-pill success" : "status-pill attention";
      const url = status.base_url ?? "";
      base.textContent = url || "The relay did not report one.";
      // A placeholder, never the real token: this page is a screen share away from anywhere.
      curl.textContent = `curl -sS -H "Authorization: Bearer $TITAN_JOB_TOKEN" ${url}/health`;
      // Clear is offered only against a token the console can actually remove.
      const clear = root.querySelector("[data-job-bus-clear]");
      if (clear) clear.disabled = !status.configured || status.source === "env";
      const set = root.querySelector("[data-job-bus-set]");
      const generate = root.querySelector("[data-job-bus-generate]");
      if (set) set.disabled = status.source === "env";
      if (generate) generate.disabled = status.source === "env";
    }).catch((error) => {
      line.textContent = `The relay did not answer for the job bus: ${error.message}`;
      pill.textContent = "unknown";
      pill.className = "status-pill";
    });
    fillJobBusSettings(root);
    fillJobBusRows();
  }

  // Only the switch and its line, so arming the bus does not throw away an edit somebody is part
  // way through in the lists below it.
  // §10.9. The one switch a job body must never be able to flip for itself, so it is drawn beside
  // the arm switch and saved with the rest of the card rather than on the click.
  function fillJobBusUnattested(root, settings) {
    const note = root.querySelector("[data-job-bus-allow-unattested-note]");
    const toggle = root.querySelector("[data-job-bus-allow-unattested]");
    if (!note || !toggle) return;
    const on = settings?.allowUnattested === true;
    toggle.setAttribute("aria-pressed", String(on));
    toggle.disabled = settings == null;
    note.innerHTML = on
      ? `On. A job may send <code>policy.require_attestation:false</code>, and one that does is marked done without either attestation layer. Leave this off unless you are debugging a worker.`
      : `Off. A job body asking for <code>require_attestation:false</code> is refused with 400 “attestation is required”, so nothing reaches done on the model's word alone.`;
  }

  // §10.9. Whether the host trusted jobs.json, its audit chain and settings.json when it started.
  // A quarantined file is why every create is answering 503 with a bearer that is perfectly good,
  // so it is said here rather than left for whoever reads the audit log.
  function fillJobBusIntegrity(root, settings) {
    const line = root.querySelector("[data-job-bus-integrity]");
    if (!line) return;
    const integrity = settings?.integrity;
    if (integrity == null) {
      line.textContent = "This host does not report it. A bundle older than §10.9 does not quarantine its own files.";
      return;
    }
    line.textContent = integrity.ok === true
      ? "The host verified its own job store at start: jobs.json, the audit chain and settings.json."
      // The quarantine survives a restart now, so the way out has to be said out loud: restarting
      // the host is no longer it.
      : `A file did not verify at start and was moved aside, so the bus stays off until you look: ${integrity.detail || "see the audit log"}. `
        + "Read the .quarantined- copies in job-bus/, then delete job-bus/quarantine.json to clear it. A restart will not.";
  }

  function fillJobBusEnabled(root, settings) {
    const note = root.querySelector("[data-job-bus-enabled-note]");
    const toggle = root.querySelector("[data-job-bus-enabled]");
    if (!note || !toggle) return;
    if (settings == null) {
      toggle.setAttribute("aria-pressed", "false");
      toggle.disabled = true;
      note.textContent = "This box's host has no job bus settings. Ship a bundle that carries jobBusGetSettings.";
      return;
    }
    const on = settings.enabled === true;
    toggle.setAttribute("aria-pressed", String(on));
    toggle.disabled = false;
    note.textContent = on
      ? "On. A job of an allowed type is accepted from the bearer."
      : "Off. Every create answers 503 job bus is disabled, whatever the token says.";
  }

  function fillJobBusSettings(root) {
    if (typeof adapter.getJobBusSettings !== "function") { fillJobBusEnabled(root, null); return; }
    Promise.resolve(adapter.getJobBusSettings()).then((answer) => {
      fillJobBusEnabled(root, answer);
      fillJobBusUnattested(root, answer);
      fillJobBusIntegrity(root, answer);
      // null is a host older than §10.7. The editors below are left empty rather than filled with
      // the defaults, because a filled form is a claim about what the box holds.
      if (answer == null) return;
      const settings = { ...JOB_BUS_DEFAULTS, ...answer };
      const workers = root.querySelector("[data-job-bus-workers]");
      const mapping = Object.entries(settings.workers ?? {});
      workers.innerHTML = (mapping.length ? mapping : Object.entries(JOB_BUS_DEFAULTS.workers))
        .map(([type, agent]) => jobBusWorkerRow(type, jobBusAgentId(String(agent ?? "")))).join("");
      const repos = root.querySelector("[data-job-bus-repos]");
      const repoList = Array.isArray(settings.repos) ? settings.repos : [];
      repos.innerHTML = repoList.length ? repoList.map((repo) => jobBusListRow("repo", repo)).join("")
        : `<p class="field-hint">No repository is allowed, so every nextgen.chapter create is refused.</p>`;
      const connectors = root.querySelector("[data-job-bus-connectors]");
      const connectorList = Array.isArray(settings.allowedConnectors) ? settings.allowedConnectors : [];
      connectors.innerHTML = connectorList.length ? connectorList.map((id) => jobBusListRow("connector", id)).join("")
        : `<p class="field-hint">The clone keeps no connector at all.</p>`;
      const number = (selector, value) => { const field = root.querySelector(selector); if (field) field.value = String(value); };
      number("[data-job-bus-queue-timeout]", settings.queueTimeoutMin);
      number("[data-job-bus-timeout]", settings.timeoutMin);
      number("[data-job-bus-max-open]", settings.maxOpen);
    }).catch((error) => {
      const note = root.querySelector("[data-job-bus-enabled-note]");
      if (note) note.textContent = `The host did not answer for the job bus settings: ${error.message}`;
    });
  }

  // Everything the operator can edit on this card, read out of the DOM in one place so the save
  // and the gate are looking at the same fields.
  function jobBusSettingsFromCard(root) {
    const workers = {};
    for (const row of root.querySelectorAll("[data-job-bus-worker]")) {
      const type = row.querySelector("[data-job-bus-worker-type]").value.trim();
      const agent = row.querySelector("[data-job-bus-worker-agent]").value.trim();
      if (type && agent) workers[type] = agent;
    }
    const list = (kind) => Array.from(root.querySelectorAll(`[data-job-bus-${kind}-value]`))
      .map((field) => field.value.trim()).filter((value) => value.length > 0);
    const number = (selector, fallback) => {
      const raw = Number(root.querySelector(selector)?.value);
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
    };
    return {
      workers,
      repos: list("repo"),
      allowedConnectors: list("connector"),
      allowUnattested: root.querySelector("[data-job-bus-allow-unattested]")?.getAttribute("aria-pressed") === "true",
      queueTimeoutMin: number("[data-job-bus-queue-timeout]", JOB_BUS_DEFAULTS.queueTimeoutMin),
      timeoutMin: number("[data-job-bus-timeout]", JOB_BUS_DEFAULTS.timeoutMin),
      maxOpen: number("[data-job-bus-max-open]", JOB_BUS_DEFAULTS.maxOpen),
    };
  }

  // ---- the Email card (docs/MAIL.md) ------------------------------------------------------------
  // Every agent gets an address at your domain, and mail sent to it arrives in that agent's own
  // conversation. The relay owns the receiving end, so this card is relay-local like the endpoint
  // catalog: one GET fills it, one POST saves it, and the two secrets are write-only -- the card
  // can set one or clear one and can never read one back.
  const MAIL_OUTCOME = {
    delivered: "delivered", no_route: "nobody was named for it",
    fetch_failed: "could not be read back from Resend", send_failed: "did not reach the agent",
    // KEYS-1. The key the product sends and reads mail with moved to the admin console, so the relay
    // now has an outcome it never had: it HAS somewhere to ask and could not reach it. That is not
    // "you have no key" -- the difference matters, because one is a thing to go and fix and the other
    // is a thing to wait out -- and a row that said the first about the second would send an
    // operator to paste a key that is already there.
    key_unreachable: "could not be read back, the key could not be fetched",
  };
  // MAIL-3, the other direction. `sending` is the row the relay opens BEFORE it calls Resend and
  // closes after, so a row still reading `sending` is a send nobody can say went or did not: it
  // says exactly that rather than guessing either way. And `sent` means Resend accepted it, which
  // is not the same as it arriving -- a bounce an hour later is invisible here (MAIL-3e).
  const MAIL_SEND_OUTCOME = {
    sent: "sent", sending: "not confirmed",
    rate_limited: "held back, too many in the hour", no_key: "not sent, the mail key is missing",
    // KEYS-1 again, the outbound half. `refused` stops naming a vendor: the key is the install's now,
    // so the thing that refused a send is not the thing this operator configured, and a vendor's name
    // here sent the last reader off to check a dashboard that was fine.
    refused: "not accepted by the mail service", failed: "did not send",
    key_unreachable: "not sent, the key could not be fetched",
  };
  const mailWhen = (at) => {
    const ms = Date.parse(String(at ?? ""));
    return Number.isFinite(ms) ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms) : "";
  };
  const mailAgentOptions = (selected) => {
    const roster = state.workers ?? [];
    const options = roster.map((worker) =>
      `<option value="${escapeHtml(worker.id)}"${worker.id === selected ? " selected" : ""}>${escapeHtml(worker.name)}</option>`);
    // "Nobody" is a real choice: with no catch-all, mail for a name no agent answers to goes to
    // Titan, and with no Titan it is recorded and left alone rather than handed to a stranger.
    options.unshift(`<option value=""${selected ? "" : " selected"}>Nobody (mail with no owner goes to Titan)</option>`);
    if (selected && !roster.some((worker) => worker.id === selected)) {
      options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (not an agent on this box)</option>`);
    }
    return options.join("");
  };

  function mailSection() {
    if (typeof adapter.getMailSettings !== "function") return "";
    return `<section class="settings-section" data-mail><h3>Email</h3><p>Give every agent an email address at your own domain. Mail sent to one of them arrives in that agent's conversation, and the agent can write back from the same address. You set this up once in Resend; the sending key is in the admin console and the signing secret is below. Receiving only works once the domain is verified in Resend and its MX record is added at your DNS provider; the runbook lists the steps.</p>`
      + `<div class="setting-row"><div><strong>Receiving</strong><small data-mail-enabled-note>Reading from the relay…</small></div><button class="switch" type="button" data-mail-enabled aria-pressed="false"></button></div>`
      + `<div class="mail-grid"><label>Your domain<input type="text" placeholder="titanium.bot" data-mail-domain /></label><label>Sender name<input type="text" placeholder="Titanium Bot" data-mail-from-name /></label></div>`
      + `<div class="field"><label for="mail-catch-all">Who gets mail nobody else is named for</label><select id="mail-catch-all" data-mail-catch-all></select><small class="field-hint">An address that matches an agent's name always goes to that agent. Everything else comes here.</small></div>`
      + `<div class="mail-block"><strong>The address to paste into Resend</strong><small class="field-hint">In Resend, make a webhook for the event email.received and give it this address. It is the only address Resend needs.</small><div class="mail-copy-row"><input type="text" readonly data-mail-webhook-url /><button class="ghost-button" type="button" data-mail-copy>Copy</button></div></div>`
      // KEYS-1: the sending key's field is GONE from here. The key the product sends and reads mail
      // with belongs to the operator of the whole install, not to one workspace, and it is pasted
      // once at api.titanium.bot/admin under "Keys the product uses". The relay prefers the control
      // plane's value and falls back to its own file until one is pasted, so mail keeps working
      // through the move and nothing here has to push a secret anywhere. Whether one is set at all
      // is still read back, because that is what decides whether receiving can be on.
      + `<div class="mail-block"><strong>The key the product sends mail with</strong><small class="field-hint" data-mail-key-note>Reading from the relay…</small><small class="field-hint">It lives in the admin console at <a href="https://api.titanium.bot/admin" target="_blank" rel="noopener">api.titanium.bot/admin</a>, under “Keys the product uses”. No workspace holds one of its own.</small></div>`
      // This one STAYS on files and stays here, deliberately. It is not a vendor credential the
      // relay fetches; it is how one inbound message is matched to the workspace that owns the
      // domain it arrived on, so a single global value in front of every edge would let the first
      // claimant read another customer's mail. MAIL-WEBHOOK-1 carries the reasoning.
      + `<div class="mail-block"><strong>Webhook signing secret</strong><small class="field-hint" data-mail-secret-note>Reading from the relay…</small><div class="mail-secret-row"><input type="password" autocomplete="off" placeholder="whsec_…" data-mail-secret /><button class="ghost-button" type="button" data-mail-secret-set>Save secret</button><button class="danger-button" type="button" data-mail-secret-clear>Clear</button></div><small class="field-hint">Resend shows this when you create the webhook. Without it nothing is accepted, because it is the only proof a message really came from Resend. It belongs to this workspace and is not shared with any other.</small></div>`
      + `<div class="form-actions"><button class="primary-button" type="button" data-mail-save>Save email settings</button></div>`
      + `<div class="mail-block"><strong>Addresses</strong><small class="field-hint">One per agent, made from its name. Renaming an agent changes its address.</small><div data-mail-addresses><p class="field-hint">Reading from the relay…</p></div></div>`
      + `<div class="mail-block"><strong>Mail that arrived</strong><div class="mail-table-wrap"><table class="mail-table"><thead><tr><th>When</th><th>From</th><th>Subject</th><th>Went to</th></tr></thead><tbody data-mail-rows><tr><td colspan="4">Reading from the relay…</td></tr></tbody></table></div></div>`
      // MAIL-3. What your bots sent, beside what arrived. The subject is here and nowhere else:
      // the control plane keeps who wrote to whom and whether it went, and never what it said.
      + `<div class="mail-block"><strong>Sent</strong><small class="field-hint">What your bots sent, each from its own address. Only this workspace can read this list.</small><div class="mail-table-wrap"><table class="mail-table"><thead><tr><th>When</th><th>Bot</th><th>To</th><th>Subject</th><th>Outcome</th></tr></thead><tbody data-mail-sends><tr><td colspan="5">Reading from the relay…</td></tr></tbody></table></div></div>`
      + `</section>`;
  }

  // Everything the card can save in one write. The two secrets are deliberately not in here: they
  // have buttons of their own, so a Save cannot send a secret the operator never retyped and a
  // half-typed key cannot replace a working one.
  function mailSettingsFromCard(root) {
    return {
      domain: root.querySelector("[data-mail-domain]")?.value.trim() ?? "",
      fromName: root.querySelector("[data-mail-from-name]")?.value.trim() ?? "",
      catchAllAgentId: root.querySelector("[data-mail-catch-all]")?.value ?? "",
    };
  }

  function paintMail(root, settings) {
    const set = (selector, value) => { const field = root.querySelector(selector); if (field) field.value = value ?? ""; };
    set("[data-mail-domain]", settings.domain);
    set("[data-mail-from-name]", settings.fromName);
    set("[data-mail-webhook-url]", settings.webhookUrl ?? "");
    const catchAll = root.querySelector("[data-mail-catch-all]");
    if (catchAll) catchAll.innerHTML = mailAgentOptions(settings.catchAllAgentId ?? "");

    const toggle = root.querySelector("[data-mail-enabled]");
    const note = root.querySelector("[data-mail-enabled-note]");
    const ready = settings.webhookSecretSet === true && settings.apiKeySet === true && String(settings.domain ?? "").length > 0;
    if (toggle) toggle.setAttribute("aria-pressed", String(settings.enabled === true));
    if (note) {
      note.textContent = settings.enabled !== true
        ? "Off. Mail sent to your agents is not being taken in."
        : ready
          ? "On. Mail sent to an agent's address arrives in its conversation."
          : "On, but not finished. Fill in your domain and save both values below before mail can arrive.";
    }
    // KEYS-1: read, never written, from here. The relay answers whether it HAS one, wherever it got
    // it from -- the control plane first, its own file while the admin console is still empty.
    const keyNote = root.querySelector("[data-mail-key-note]");
    if (keyNote) keyNote.textContent = settings.apiKeySet ? "Set. Mail can be sent and read back." : "Not set yet, so nothing can be sent or read back.";
    const secretNote = root.querySelector("[data-mail-secret-note]");
    if (secretNote) secretNote.textContent = settings.webhookSecretSet ? "Saved." : "Not saved yet.";
    const secretClear = root.querySelector("[data-mail-secret-clear]");
    if (secretClear) secretClear.disabled = settings.webhookSecretSet !== true;

    const addresses = root.querySelector("[data-mail-addresses]");
    if (addresses) {
      const rows = Array.isArray(settings.addresses) ? settings.addresses : [];
      addresses.innerHTML = rows.length === 0
        ? `<p class="field-hint">Type your domain above and save, and every agent's address appears here.</p>`
        // A row with a note has something the operator has to fix: two agents whose names make the
        // same address, or a name there is no address to make from. Saying it here is the only way
        // they find out before somebody's mail goes to the wrong agent.
        : rows.map((row) => {
          const note = String(row.note ?? "");
          const said = String(row.address ?? "").length > 0 ? row.address : "no address yet";
          return `<div class="mail-address-row"><span class="mail-address-name">${escapeHtml(row.name)}</span><span class="mail-address">${escapeHtml(said)}</span>${note.length > 0 ? `<small class="field-hint">${escapeHtml(note)}</small>` : ""}</div>`;
        }).join("");
    }
    const rows = root.querySelector("[data-mail-rows]");
    if (rows) {
      const recent = Array.isArray(settings.recent) ? settings.recent : [];
      rows.innerHTML = recent.length === 0
        ? `<tr><td colspan="4">No mail has arrived yet.</td></tr>`
        : recent.map((row) => {
          const went = escapeHtml(row.agentName ?? "");
          const outcome = escapeHtml(MAIL_OUTCOME[row.outcome] ?? String(row.outcome ?? ""));
          // Mail nobody was named for has no agent to put in the column, so the reason goes there
          // instead of a name and a reason that read as the same word twice.
          const said = went.length === 0 ? outcome : row.outcome === "delivered" ? went : `${went}, ${outcome}`;
          return `<tr><td>${escapeHtml(mailWhen(row.at))}</td><td class="mail-cell">${escapeHtml(row.from ?? "")}</td><td class="mail-cell">${escapeHtml(row.subject ?? "")}</td><td>${said}</td></tr>`;
        }).join("");
    }
    // MAIL-3. ABSENT is not EMPTY. A relay that has not been swapped answers no `sends` field at
    // all, and painting "nothing sent yet" from a field that was never there would tell the
    // operator something the relay never said. So the table is only touched when the array is real.
    const sendRows = root.querySelector("[data-mail-sends]");
    if (sendRows && Array.isArray(settings.sends)) {
      sendRows.innerHTML = settings.sends.length === 0
        ? `<tr><td colspan="5">Nothing has been sent yet.</td></tr>`
        : settings.sends.map((row) => {
          const outcome = escapeHtml(MAIL_SEND_OUTCOME[row.outcome] ?? String(row.outcome ?? ""));
          return `<tr><td>${escapeHtml(mailWhen(row.at))}</td><td>${escapeHtml(row.agentName ?? "")}</td>`
            + `<td class="mail-cell">${escapeHtml(row.to ?? "")}</td><td class="mail-cell">${escapeHtml(row.subject ?? "")}</td><td>${outcome}</td></tr>`;
        }).join("");
    }
  }

  function fillMail() {
    const root = elements.panelContent.querySelector("[data-mail]");
    if (!root || typeof adapter.getMailSettings !== "function") return null;
    return Promise.resolve(adapter.getMailSettings())
      .then((settings) => paintMail(root, settings ?? {}))
      .catch((error) => {
        const note = root.querySelector("[data-mail-enabled-note]");
        if (note) note.textContent = `The relay did not answer for email: ${error.message}`;
      });
  }

  // One write, then the card repaints from whatever the relay actually stored.
  function saveMail(target, patch, said) {
    const root = elements.panelContent.querySelector("[data-mail]");
    target.disabled = true;
    // The chain is returned so a caller can wait for it; nothing on the page does, but a test that
    // could not wait would be measuring the click instead of what the relay answered.
    return Promise.resolve(adapter.setMailSettings(patch))
      .then((settings) => { paintMail(root, settings ?? {}); showToast(said); })
      .catch((error) => showToast(`Email settings were not saved: ${error.message}`))
      .finally(() => { target.disabled = false; });
  }

  // Every control on the card, in one place, so the click chain carries two lines and the card's
  // own behaviour can be driven in a test rather than only in a browser.
  const MAIL_CONTROLS = [
    "data-mail-enabled", "data-mail-save", "data-mail-secret-set",
    "data-mail-secret-clear", "data-mail-copy",
  ];
  const isMailControl = (target) => MAIL_CONTROLS.some((name) => target.hasAttribute(name));

  function mailClick(target) {
    const root = elements.panelContent.querySelector("[data-mail]");
    if (target.hasAttribute("data-mail-enabled")) {
      // Written on the click and repainted from the relay's answer, the way the job bus switch is:
      // a switch with a Save under it would sit there saying mail is coming in when it is not.
      const turningOn = target.getAttribute("aria-pressed") !== "true";
      return saveMail(target, { enabled: turningOn }, turningOn ? "Receiving is on." : "Receiving is off.");
    }
    if (target.hasAttribute("data-mail-save")) {
      return saveMail(target, mailSettingsFromCard(root), "Email settings saved.");
    }
    // KEYS-1: the sending key's Save and Clear are gone with its field. What is left is the inbound
    // signing secret, which is this workspace's own routing value and stays here.
    if (target.hasAttribute("data-mail-secret-set")) {
      const input = root.querySelector("[data-mail-secret]");
      const value = input.value.trim();
      // Nothing typed is not a save. Writing an empty string here would clear a working value, which
      // is what the Clear button is for and is never what an empty field meant.
      if (value.length === 0) return showToast("Type the signing secret first.");
      // Emptied before the write, not after it: the value is on its way to the relay and this page
      // is not the place it lives.
      input.value = "";
      return saveMail(target, { webhookSecret: value }, "The signing secret is saved on the relay.");
    }
    if (target.hasAttribute("data-mail-secret-clear")) {
      return saveMail(target, { webhookSecret: null }, "The signing secret is cleared, so nothing will be accepted.");
    }
    const field = root.querySelector("[data-mail-webhook-url]");
    return Promise.resolve(navigator.clipboard?.writeText?.(field.value)).then(() => showToast("Address copied."))
      .catch(() => { field.focus(); field.select(); showToast("This browser would not let the page write the clipboard. It is selected, so copy it."); });
  }
  // ---- end the Email card ------------------------------------------------------------------------

  function fillJobBusRows() {
    const body = elements.panelContent.querySelector("[data-job-bus-rows]");
    if (!body || typeof adapter.listJobBusJobs !== "function") return;
    adapter.listJobBusJobs().then((jobs) => {
      if (jobs == null) { body.innerHTML = `<tr><td colspan="6">This box's host has no job bus yet. Ship a bundle that carries it.</td></tr>`; return; }
      if (jobs.length === 0) { body.innerHTML = `<tr><td colspan="6">No jobs yet.</td></tr>`; return; }
      body.innerHTML = jobs.map((job) => {
        const summary = jobLine(job);
        // The Worker column is the per-job clone, the agent that actually held the tools. Its
        // source is on the cell's title, because "Scribe · job 4f1c0b" on its own does not say
        // which Scribe it came from once the clone has been deleted.
        const worker = job.worker?.agentName ?? "";
        const from = job.worker?.sourceAgentId ? `cloned from ${job.worker.sourceAgentId}` : "";
        return `<tr data-job-bus-row="${escapeHtml(job.id)}"><td class="job-bus-id" title="${escapeHtml(job.id)}">${escapeHtml(shortJobId(job.id))}</td><td>${escapeHtml(job.type ?? "")}</td><td><span class="${JOB_STATUS_PILL[job.status] ?? "status-pill"}">${escapeHtml(String(job.status ?? "").replace("_", " "))}</span></td><td class="job-bus-worker" title="${escapeHtml(from)}">${escapeHtml(worker)}</td><td>${escapeHtml(jobWhen(job.created_at))}</td><td class="job-bus-line" title="${escapeHtml(summary)}">${escapeHtml(summary)}</td></tr>`;
      }).join("");
    }).catch((error) => { body.innerHTML = `<tr><td colspan="6">The host did not answer for the job list: ${escapeHtml(error.message)}</td></tr>`; });
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
      // HANDBACK-1: the one funnel every desktop mount goes through, so the picture beside the card
      // and the screen this view paints can never be two different displays.
      noteBoxHandoffSeat(agentId, display, shared);
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
      // TENANT-2: an instance with no docker of its own cannot open a desktop at all, and the
      // relay says so with a 409 not_available instead of a 200 for a window that was never
      // coming. Put its sentence in the pane rather than leaving an empty grey frame.
      fetch(`/box/launch?display=${encodeURIComponent(display)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app }),
      }).then(async (res) => {
        if (res.status !== 409) return;
        const body = await res.json().catch(() => null);
        if (body?.error !== "not_available") return;
        mountedDesktop = null;
        elements.desktopWindow.innerHTML = `<div class="empty-state">${escapeHtml(body.detail ?? "The desktop view is not available on this instance yet.")}</div>`;
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

  // ---- HANDBACK-1: the thumbnail engine, the rail, and the one click funnel --------------------
  // The picture in the card and in the rail tile is the box's own screen, read through the relay.
  // The relay proxies the box's noVNC at /vnc/<display>/, so a frame there is SAME ORIGIN as this
  // page and its canvas is untainted -- which is the whole reason this works without a screenshot
  // command. Measured on grok-bot-local-vm: 1,350 ms to a painted framebuffer, 5 ms and about 7 KB
  // per 390x244 webp at q0.6, 5.8% of one core for a live client, and a display:none client keeps
  // painting.
  //
  // Three rules this engine exists to keep:
  //   1. It never mounts inside the transcript. transcriptMarkup rebuilds the whole list and noVNC
  //      re-runs its handshake whenever its element is replaced -- the exact scar mountBoxSurface
  //      already carries. So one hidden client lives off-screen on the page and the card holds a
  //      plain <img> that this writes into.
  //   2. It has its OWN 3 s timer. Never the render path, never the 15 s heartbeat, never the
  //      900 ms SSE debounce. A picture that repaints the page is a picture that fights the reader.
  //   3. It never allocates a seat. ensureForeverBox measured 16,277 ms cold and hands out a
  //      display; Take over is what should cost that, not a thumbnail. No display means no frame
  //      and a plate that says so.
  let boxHandoffThumb = null;
  const boxHandoffFrames = new Map();
  const BOX_HANDOFF_FRAME_PREFIX = "mr-box-handoff-frame:";
  const BOX_HANDOFF_FRAME_INDEX = "mr-box-handoff-frames";
  const BOX_HANDOFF_FRAME_KEEP = 8;
  const boxHandoffFrameKey = (agentId, requestId) => `${agentId}::${requestId}`;

  // A host that does not know skipBoxHandoff gets no Skip control anywhere -- not a control that
  // would fall back to the hand-back command and stamp the step "done" when nobody did it.
  let boxHandoffSkipMissing = false;
  function boxHandoffSkipSupported() {
    return typeof adapter.skipHandoff === "function" && !boxHandoffSkipMissing;
  }

  // The frozen frame. Kept in memory and mirrored to this origin's storage so a reload still shows
  // the last thing the screen looked like rather than an empty plate; every read and write is
  // wrapped, because a browser with site data blocked throws on the accessor itself.
  function boxHandoffFrame(agentId, requestId) {
    if (!agentId || !requestId) return "";
    const key = boxHandoffFrameKey(agentId, requestId);
    const held = boxHandoffFrames.get(key);
    if (held) return held;
    try {
      const stored = window.localStorage.getItem(BOX_HANDOFF_FRAME_PREFIX + key);
      if (stored) { boxHandoffFrames.set(key, stored); return stored; }
    } catch { /* no storage: a live frame lands in a few seconds anyway */ }
    return "";
  }

  function rememberBoxHandoffFrame(agentId, requestId, dataUrl) {
    const key = boxHandoffFrameKey(agentId, requestId);
    boxHandoffFrames.set(key, dataUrl);
    try {
      const store = window.localStorage;
      store.setItem(BOX_HANDOFF_FRAME_PREFIX + key, dataUrl);
      // Newest eight, in an index of our own: storage has no ordering to read. About 7 KB each, so
      // an unbounded set would fill the origin's quota with pictures of steps nobody will reopen.
      let order = [];
      try { order = JSON.parse(store.getItem(BOX_HANDOFF_FRAME_INDEX) ?? "[]"); } catch { order = []; }
      order = [key, ...(Array.isArray(order) ? order : []).filter((k) => k !== key)];
      order.slice(BOX_HANDOFF_FRAME_KEEP).forEach((old) => { try { store.removeItem(BOX_HANDOFF_FRAME_PREFIX + old); } catch { /* nothing to do */ } });
      order = order.slice(0, BOX_HANDOFF_FRAME_KEEP);
      store.setItem(BOX_HANDOFF_FRAME_INDEX, JSON.stringify(order));
    } catch { /* the in-memory copy is still the frame this session draws */ }
  }

  // The screen this card shows is the screen Take over would open, and nothing else. That is the
  // whole point of the picture: the caption says "<name>'s screen" and a person decides on what it
  // shows. It was not true. An agent whose screen nobody has opened reports state "absent" with a
  // null vncUrl, and this fell back to the shared seat :1 for it -- so on the R750 the card and the
  // rail tile painted :1 while the agent was working on :5, Take over then opened :5, and the
  // agent's own reply ("the browser is sitting on a blank page") disagreed with the picture the
  // person had just decided on.
  //
  // The host answers the question directly now. getForeverBoxStatus carries `boxSeat`, read out of
  // the box's own assignment map without allocating anything:
  //
  //   a number    the agent's own seat; the picture is that display
  //   null        no seat of its own, which IS the shared screen -- and the caption says so, rather
  //               than calling somebody else's wallpaper this agent's screen
  //   undefined   this host cannot say. Nothing is drawn and the plate says why. A wrong screen is
  //               worse than no screen, which is the rule Skip already follows.
  //
  // The last answer for an agent is kept, because a roster record is briefly a placeholder between
  // listAgents and loadContext and a caption that flickers through three wordings is its own bug.
  // Opening the desktop writes into the same memory, so a seat allocated by Take over is what the
  // thumbnail reads from the moment it exists rather than 15 s later on the next heartbeat.
  const BOX_HANDOFF_SHARED_DISPLAY = 1;
  const boxHandoffSeats = new Map();
  function rememberBoxHandoffSeat(agentId, seat) {
    if (agentId && seat) boxHandoffSeats.set(agentId, seat);
    return seat;
  }
  function boxHandoffSeatOf(record) {
    const agentId = record?.id ?? "";
    const own = Number(record?.boxDisplay);
    if (Number.isFinite(own) && own > BOX_HANDOFF_SHARED_DISPLAY) return rememberBoxHandoffSeat(agentId, { display: own, shared: false });
    const seat = record?.boxSeat;
    if (seat !== undefined) {
      const index = Number(seat);
      return rememberBoxHandoffSeat(agentId, Number.isFinite(index) && index > BOX_HANDOFF_SHARED_DISPLAY
        ? { display: index, shared: false }
        : { display: BOX_HANDOFF_SHARED_DISPLAY, shared: true });
    }
    return boxHandoffSeats.get(agentId) ?? null;
  }
  // The desktop view's own funnel calls this with the display it really mounted, so the picture and
  // the view can never name two different screens.
  function noteBoxHandoffSeat(agentId, display, shared) {
    const index = Number(display);
    if (!agentId || !Number.isFinite(index)) return;
    const seat = shared || index <= BOX_HANDOFF_SHARED_DISPLAY
      ? { display: BOX_HANDOFF_SHARED_DISPLAY, shared: true }
      : { display: index, shared: false };
    const held = boxHandoffSeats.get(agentId);
    boxHandoffSeats.set(agentId, seat);
    if (!held || held.display !== seat.display || held.shared !== seat.shared) renderBoxHandoffSurfaces();
  }
  // What the caption over the picture is allowed to say. Three wordings, one per answer above.
  function boxHandoffScreenCaption(record, seat) {
    if (seat == null) return "No screen to show";
    return seat.shared
      ? "The shared screen — every agent on this box sees it"
      : `${record?.name ?? "This agent"}'s screen`;
  }

  // What only the live page can answer, handed to handoffCardMarkup so that function stays pure.
  function boxHandoffView(message) {
    const lead = contextLead();
    const agentId = lead?.id ?? "";
    const requestId = message?.handoff?.requestId ?? "";
    return {
      live: lead?.handoff ?? null,
      agentId,
      // CONSOLE-ATTR-1: the name the RELAY puts in the notification title for this card, so a shell
      // reading the page and a shell reading a push are told the same sentence, and the conversation
      // the card's deep link has to open. In a room `agentId` is the lead member, which is who the
      // hand-off commands are addressed to and is NOT where the card is drawn.
      agentName: lead?.name ?? "",
      contextId: activeContext().id,
      frame: boxHandoffFrame(agentId, requestId),
      // False only where the host has not said which seat this agent is on. That is the one case
      // where no picture is drawn at all, because the alternative is a confident picture of the
      // wrong screen under a caption naming this agent.
      hasScreen: boxHandoffSeatOf(lead) != null,
    };
  }

  function boxHandoffTeardown() {
    if (!boxHandoffThumb) return;
    window.clearInterval(boxHandoffThumb.timer);
    // SEAT-FOCUS-1. The hand-back goes out with the frame it was armed for.
    try { boxHandoffThumb.keyboard?.(); } catch { /* nothing to do */ }
    boxHandoffThumb.frame?.remove();
    boxHandoffThumb = null;
  }

  function boxHandoffEnsureThumb(agentId, requestId, display) {
    if (boxHandoffThumb
      && boxHandoffThumb.agentId === agentId
      && boxHandoffThumb.requestId === requestId
      && boxHandoffThumb.display === display) return;
    boxHandoffTeardown();
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("data-box-handoff-thumb-source", "1");
    frame.tabIndex = -1;
    frame.title = "Off-screen reader for this agent's screen";
    // Off-screen rather than display:none, and a real framebuffer size: noVNC scales what it is
    // given, and a 1px client would hand back a 1px picture.
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;pointer-events:none;opacity:0;";
    // view_only: this client must never take a keystroke from anywhere. The URL is built on the
    // PAGE's origin, never the host's own 127.0.0.1 form -- that address is the viewer's machine
    // through the relay, which is the bug VNC-2 closed. vnc.html and not vnc_lite, because the
    // lite client ignores resize=scale and paints the top-left corner of the screen only.
    frame.src = `${window.location.origin}/vnc/${display}/vnc.html`
      + `?path=${encodeURIComponent(`/vnc/${display}/websockify`)}`
      + "&autoconnect=1&resize=scale&reconnect=1&bell=0&view_only=1";
    document.body.appendChild(frame);
    // SEAT-FOCUS-1. noVNC focuses its own canvas a couple of seconds after this client connects, and
    // from that moment document.activeElement is this IFRAME: Escape stops leaving talk mode and the
    // space bar stops talking, silently, because voice.js's handlers are on the document. The rule is
    // screen-tile.js's, which owns the other reader of exactly this shape, so this mount arms it for
    // its own frame rather than keeping a second copy of it. No pointer can ever reach this frame
    // (off-screen, pointer-events:none, view_only), so it never has any business holding keys.
    const keyboard = window.__screenTile?.keepKeyboardOff?.(frame) ?? null;
    boxHandoffThumb = { agentId, requestId, display, frame, keyboard, timer: window.setInterval(boxHandoffTick, 3000) };
  }

  function boxHandoffTick() {
    const held = boxHandoffThumb;
    if (!held) return;
    // The person is looking at the real thing; reading a second copy of it every three seconds is
    // work for nobody.
    if (elements.desktopDialog.open) return;
    let source = null;
    try { source = held.frame.contentDocument?.querySelector("canvas") ?? null; } catch { source = null; }
    if (!source || !source.width || !source.height) return;
    let dataUrl = "";
    try {
      const canvas = document.createElement("canvas");
      canvas.width = BOX_HANDOFF_THUMB_W;
      canvas.height = BOX_HANDOFF_THUMB_H;
      canvas.getContext("2d").drawImage(source, 0, 0, source.width, source.height, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL("image/webp", 0.6);
    } catch { return; }
    // A browser without webp encoding answers a PNG data URL, which is still a picture; only an
    // empty answer is nothing worth writing.
    if (!dataUrl || dataUrl.length < 64) return;
    rememberBoxHandoffFrame(held.agentId, held.requestId, dataUrl);
    paintBoxHandoffFrame(held.agentId, held.requestId, dataUrl);
  }

  // Straight into the elements, never through a render: rebuilding the transcript to show a new
  // frame would throw the reader back to the bottom every three seconds.
  function paintBoxHandoffFrame(agentId, requestId, dataUrl) {
    if (!agentId || !requestId) return;
    document
      .querySelectorAll(`img[data-handoff-thumb][data-agent-id="${CSS.escape(agentId)}"][data-request-id="${CSS.escape(requestId)}"]`)
      .forEach((img) => {
        img.src = dataUrl;
        img.hidden = false;
        const plate = img.parentElement?.querySelector("[data-handoff-thumb-plate]");
        if (plate) plate.hidden = true;
      });
    // CONSOLE-4, rail tile only (the card's own thumbs above are untouched): the tile no longer
    // ships an <img> it has nothing to put in, because a hidden one painted Chrome's broken-image
    // glyph. So the first frame for an agent arrives with no element to write into, and the tile
    // is redrawn instead -- rememberBoxHandoffFrame has already run one line up the call site, so
    // that redraw finds the frame. Redrawing #rail-screen is cheap and does not touch the
    // transcript, which is the thing the note above is protecting.
    const tile = document.querySelector("img[data-rail-screen]");
    if (tile && tile.dataset.agentId === agentId) {
      tile.src = dataUrl;
      tile.hidden = false;
      const plate = document.querySelector("#rail-screen [data-rail-screen-plate]");
      if (plate) plate.hidden = true;
      return;
    }
    if (!tile && document.querySelector("#rail-screen [data-rail-screen-plate]")) renderScreenTile();
  }

  // The amber card at the top of the rail, drawn only while the host reports a pending hand-off
  // for the agent whose conversation is open. record.handoff is null for every other agent, so
  // this is per-conversation by construction -- the roster pill and the header pill keep running
  // off awaitingUserResponse, which is the only cross-agent signal there is.
  function renderHandoffRail() {
    const card = document.getElementById("rail-handoff");
    if (!card) return;
    const lead = activeContext()?.kind === "worker" ? contextRecord() : null;
    const live = lead?.handoff ?? null;
    card.hidden = !live;
    if (!live) { card.innerHTML = ""; return; }
    const attrs = `data-agent-id="${escapeHtml(lead.id)}" data-request-id="${escapeHtml(live.requestId ?? "")}"`;
    const skip = boxHandoffSkipSupported()
      ? `<button class="card-action" type="button" data-handoff-action="skip" ${attrs}>Skip this step</button>`
      : "";
    card.innerHTML = `<div class="island-heading"><div><span class="status-dot attention"></span><strong>Needs your attention</strong></div></div>`
      + `<p class="handoff-instruction" data-handoff-instruction>${escapeHtml(live.instruction || "It did not say what it needs done.")}</p>`
      + `<div class="rail-handoff-actions">${skip}<button class="card-action primary" type="button" data-handoff-action="done" ${attrs}>I'm done, continue</button></div>`;
  }

  // The screen tile under it. Live while a hand-off is pending, the frozen last frame otherwise,
  // and a plate in plain words when there is no picture yet. Clicking it opens the desktop view.
  function renderScreenTile() {
    const tile = document.getElementById("rail-screen");
    if (!tile) return;
    const context = activeContext();
    if (context?.kind !== "worker") {
      // A room has no screen of its own. Borrowing a member's here would invent an ownership the
      // host does not have, and the caption would then be a lie about whose screen this is.
      tile.innerHTML = `<p class="rail-screen-note">A room has no screen of its own — open a member's conversation to see theirs.</p>`;
      return;
    }
    const lead = contextRecord();
    if (!lead) { tile.innerHTML = ""; return; }
    const live = lead.handoff ?? null;
    // CONSOLE-4 seam, corrected by SCREEN-TILE-1. Two frame sources: a hand-off's own frozen still
    // (HANDBACK-1 owns those, keyed by request id) and the rail reader's live one (screen-tile.js).
    //
    // WHICH ONE WINS DEPENDS ON WHETHER THE HAND-OFF IS STILL PENDING, and it has to. While a step
    // is pending the frozen still is the picture of the thing the person is being asked to do, and
    // this module stands down off that agent anyway. Once the step is resolved the hand-off still is
    // a photograph of the past -- and preferring it unconditionally meant that for any agent that
    // had EVER handed something back, every render put the old still back over the live frame, for
    // ever. That is Jason's "it gets recorded once and stays that way" for a subset of agents, and
    // it was measured on grok-bot-local-vm while building SCREEN-TILE-1: a 2,511-character hand-off
    // still re-painted over a moving 4,200-character live frame on every heartbeat.
    const tileFrame = typeof window.__screenTile?.frameFor === "function" ? window.__screenTile.frameFor(lead.id) : "";
    const handoffFrame = boxHandoffFrame(lead.id, live?.requestId ?? boxHandoffLastRequestId(lead) ?? "");
    const frame = (live ? (handoffFrame || tileFrame) : (tileFrame || handoffFrame)) || "";
    const seat = boxHandoffSeatOf(lead);
    // "Connecting" only while a reader for THIS agent is actually running. It used to be said
    // whenever the box had handed out a seat, so an idle agent with a screen sat on "Connecting"
    // for ever with nothing connecting -- the exact failure the line above it warns about. When
    // nothing is reading, the tile says what clicking it does; when the host cannot say which
    // screen this agent is on, it says that instead of drawing one.
    const reading = boxHandoffThumb != null && boxHandoffThumb.agentId === lead.id;
    const plate = seat == null
      ? "This computer did not say which screen this agent is on"
      : reading ? "Connecting" : "Click to open this computer's screen";
    const caption = boxHandoffScreenCaption(lead, seat);
    // CONSOLE-4. Jason, 2026-09-08: "The Titan screen at the top right says 'Click to open,' but
    // there's a broken image there." The <img> used to be emitted always and marked hidden -- and
    // `.rail-screen-button img { display: block }` outranks the UA sheet's [hidden] on
    // specificity, so Chrome painted its own broken-image glyph and the alt text instead.
    // Reproduced on grok-bot-local-vm in real Chrome across the first eight agents on the box:
    // 8 of 8 tiles carried an <img> with src null, naturalWidth 0 and computed display block, and
    // the tile painted the glyph over the alt text. After: 0 broken, 8 plates. (The same defect
    // was read on Jason's console at 231x75 during the design pass.) It is the same trap the
    // .handoff-island[hidden] rule exists for, one screen up in styles.css.
    //
    // So: no <img> unless there is something to put in it. With no frame the tile is the plate
    // alone, which is a real placeholder that says what clicking does.
    tile.innerHTML = `<button class="rail-screen-button" type="button" data-handoff-action="open" data-agent-id="${escapeHtml(lead.id)}" data-request-id="${escapeHtml(live?.requestId ?? "")}">`
      + (frame
        ? `<img data-rail-screen data-agent-id="${escapeHtml(lead.id)}" alt="${escapeHtml(caption)}" src="${escapeHtml(frame)}" />`
        : `<span class="rail-screen-plate" data-rail-screen-plate>${escapeHtml(plate)}</span>`)
      + `</button>`
      + `<small class="rail-screen-caption" id="rail-screen-caption">${escapeHtml(caption)}</small>`;
  }

  // SCREEN-TILE-1. The newest tool row in the open conversation, which is the only signal the
  // console has for "this agent was just doing something on a screen". A tool row is a system
  // message carrying `kind` off TOOL_LABELS ("Computer" for computerUseToolCall, "Shell" for a
  // command, and so on); its text is the headline, which is where `Opened <host>` lands for a
  // `box-chrome <url>` call. No timestamp: the outline these rows are woven from carries none, so
  // screen-tile.js stamps the moment it first saw the row rather than trusting one that is not there.
  function newestToolRow(record) {
    const rows = Array.isArray(record?.messages) ? record.messages : [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row?.type === "system" && row.kind) return { id: row.id ?? "", kind: row.kind, text: String(row.text ?? "") };
    }
    return null;
  }

  // The newest hand-off this conversation has on screen, so a finished step still shows its own
  // frozen frame in the rail once the live record is gone.
  function boxHandoffLastRequestId(record) {
    const rows = Array.isArray(record?.messages) ? record.messages : [];
    for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].handoff) return rows[i].handoff.requestId;
    return null;
  }

  // One pass, called where renderContextCard is called. It also owns the engine's life: a pending
  // hand-off with a display starts the hidden client, and anything else stops it.
  function renderBoxHandoffSurfaces() {
    const lead = activeContext()?.kind === "worker" ? contextRecord() : null;
    const live = lead?.handoff ?? null;
    const openId = lead?.id ?? null;
    const seat = boxHandoffSeatOf(lead);
    if (live && seat) boxHandoffEnsureThumb(openId, live.requestId, seat.display);
    // A render that happens to carry no display is NOT the hand-off ending. The roster is rebuilt
    // from listAgents and the box status is a separate read, so the record is briefly without a
    // display between the two -- and tearing the reader down there restarted noVNC's 1.3 s
    // handshake on every heartbeat. Measured on grok-bot-local-vm before this: 33 s to the first
    // frame on a box that hands one over in about 1.4 s. Only the hand-off ending, or the
    // conversation moving to another agent, stops the reader.
    else if (!live || (boxHandoffThumb && boxHandoffThumb.agentId !== openId)) boxHandoffTeardown();
    // CONSOLE-4 seam: the idle agent's own reader (screen-tile.js, item C). It owns starting,
    // stopping and pausing itself from this one call; nothing here reaches into it. `visible` is
    // false while the desktop dialog is open, because that dialog already has the live screen and
    // a second client on the same seat is a second handshake for the same pixels.
    window.__screenTile?.sync?.({
      agentId: openId,
      seat,
      status: lead?.status ?? null,
      visible: !document.hidden && !elements.desktopDialog.open,
      // SCREEN-TILE-1: the one property this wave added here. `status` is agent.isRunning, so it is
      // only ever true DURING a turn -- and Jason looks at the tile between turns. The newest tool
      // row says whether the last thing this agent did was on a screen; screen-tile.js decides what
      // to do about it, and stamps first sight itself, because a tool row carries no time.
      activity: newestToolRow(lead),
    });
    renderHandoffRail();
    renderScreenTile();
  }

  // Every hand-off control on the page goes through here -- the transcript card, the rail card and
  // the takeover banner all carry [data-handoff-action], so there is one place that decides what a
  // click means and one place to read to know.
  function handleBoxHandoffAction(event) {
    const button = event.target.closest?.("[data-handoff-action]");
    if (!button) return;
    const action = button.dataset.handoffAction;
    const agentId = button.dataset.agentId || contextLead()?.id || "";
    if (!agentId) return;
    if (action === "take-over") { openDesktop("browser", true); return; }
    if (action === "open") { openDesktop("browser", false); return; }
    // Captured now, and the dialog is closed on the click rather than on the answer: handBack ends
    // the hand-off on the host before it returns, so hanging the view's disappearance on the RPC
    // left the person staring at a banner offering the thing they had just done.
    if (action === "done") { boxHandoffDone(agentId, button); return; }
    if (action === "skip") { boxHandoffSkip(agentId, button); return; }
  }

  function boxHandoffDone(agentId, button) {
    if (typeof adapter.handBack !== "function") return;
    if (elements.desktopDialog.open) elements.desktopDialog.close();
    if (button) button.disabled = true;
    Promise.resolve(adapter.handBack(agentId))
      .then((result) => { showToast(result?.pending ? "The computer still lists this as waiting on you" : "Handed back — the agent picks it up from here"); })
      // An RPC rejection is not evidence the hand-off failed: the host clears it before it answers,
      // and the status poll running alongside is what actually settles this. So the person is told
      // what is known, never that something went wrong that may well have worked.
      .catch(() => showToast("Handed back — waiting for the computer to confirm"))
      .finally(() => { if (button) button.disabled = false; settleBoxHandoff(); });
  }

  function boxHandoffSkip(agentId, button) {
    if (typeof adapter.skipHandoff !== "function") return;
    if (elements.desktopDialog.open) elements.desktopDialog.close();
    if (button) button.disabled = true;
    Promise.resolve(adapter.skipHandoff(agentId))
      .then((result) => {
        if (result && result.supported === false) {
          boxHandoffSkipMissing = true;
          // The rail and the banner are redrawn by settleBoxHandoff below, but the card lives in
          // the transcript and nothing here rebuilds that: measured on grok-bot-local-vm, two of
          // the three Skip controls went and the card's stayed, still offering a command the host
          // had just said it does not have. The whole page is redrawn, keeping the scroll.
          renderAll(true);
          showToast("This computer's software is too old to skip a step. Update it, or do the step and press I'm done.");
          return;
        }
        showToast("Skipped — the agent has been told the step was not done");
      })
      .catch(() => showToast("Skipped — waiting for the computer to confirm"))
      .finally(() => { if (button) button.disabled = false; settleBoxHandoff(); });
  }

  // The half of a hand-off's end that only the transcript carries. The host stamps the entry's
  // resolution when the hand-off ends, but the conversation is otherwise only re-read on the 15 s
  // heartbeat -- so between the click and that tick the card had a cleared live record and an
  // unstamped entry, which is the fourth state, and it read "No longer waiting" on a step the
  // person had just finished. Measured on grok-bot-local-vm 2026-09-08: still saying it nine
  // seconds after the click. One read closes the gap, and it is the host's own answer, not a
  // guess made on this page.
  function settleBoxHandoff() {
    renderHandBack();
    renderBoxHandoffSurfaces();
    if (typeof adapter.refresh === "function") Promise.resolve(adapter.refresh()).catch(() => {});
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

  // The one message that brings noVNC's own control bar -- and the clipboard panel in it -- back
  // inside the frame. Two ways to send it, because the bar is this feature's fallback and a
  // fallback reachable only by a keyboard chord is not one: a browser can swallow ⌘/Ctrl+Shift+B
  // (Chrome reads it as Show Bookmarks Bar), and hiding the bar's anchor takes noVNC's own drag
  // handle with it, so the client has no pointer route of its own left.
  function showVncControlBar(frame) {
    frame.contentWindow?.postMessage({ type: "titanbot-vnc-bar" }, window.location.origin);
  }

  // The chord. The bridge listens for the same one on its side; this covers the half of the time
  // the focus is out here. Nothing is prevented when the pane is closed -- the browser keeps it.
  function handleDesktopChord(event) {
    if (!event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
    if (String(event.key).toLowerCase() !== "b") return;
    const frame = desktopVncFrame();
    if (frame == null) return;
    event.preventDefault();
    showVncControlBar(frame);
  }

  // And the button in the pane's footer, which works with a mouse and on every platform.
  function handleVncBarButton() {
    const frame = desktopVncFrame();
    if (frame == null) { sayInDesktopPanel("The box’s screen is not on this view — open Browser first."); return; }
    showVncControlBar(frame);
  }

  // Cmd+V with the screen focused never reaches this page -- noVNC stops the keydown on its canvas
  // and forwards it to the box, where Super+V means nothing. The bridge takes that chord back and
  // asks here instead. This is the one place the async clipboard read is worth attempting: a
  // document still counts as focused while a frame inside it holds the focus, so the browser is
  // allowed to answer. When it refuses, the way out is the control bar.
  function serveClipboardRequest(frame) {
    const read = navigator.clipboard?.readText?.();
    if (read == null) { sayInDesktopPanel("This browser will not hand over the clipboard — ⌘/Ctrl + Shift + B shows the box’s own clipboard bar."); return; }
    read
      .then((text) => { if (!sendClipboardToBox(frame, text)) sayInDesktopPanel("Nothing on the clipboard to send to the box."); })
      .catch(() => sayInDesktopPanel("The browser refused to read the clipboard — ⌘/Ctrl + Shift + B shows the box’s own clipboard bar."));
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
    document.getElementById("desktop-vnc-bar")?.addEventListener("click", handleVncBarButton);
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
      // CONSOLE-4. Jason, 2026-09-08: "it shows me files we've created, but I can't click, open,
      // or view it." It was a <div>, with no handler anywhere. Every row is a button now, and all
      // of them go through the same funnel as the transcript's Open, so the two lists open the one
      // viewer.
      const fileAgent = attachmentAgentId();
      const files = record.files.length
        ? record.files.map((file) => `<button class="file-tile" type="button" data-file-open="${escapeHtml(file.path)}" data-file-agent="${escapeHtml(fileAgent)}" data-file-name="${escapeHtml(file.name)}">▱<strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.meta)}</small></button>`).join("")
        : `<div class="empty-state">Nothing has been attached to this conversation yet.</div>`;
      // The old sentence here described /workspace, which is not where any of these files are:
      // every row in this list came out of this agent's own transcript and lives under its
      // attachments. Saying the host keeps no per-worker directory, directly above a list of that
      // agent's files, argued with the list.
      elements.desktopWindow.innerHTML = `<div class="files-view"><div class="browser-page-head"><div><h3>${escapeHtml(record.name)} files</h3><p>Files that passed through the part of this conversation loaded on screen${record.hasOlder ? " — show earlier messages to include older ones" : ""}. Open one to read it here, or download it. Files a worker writes with Shell go to a /workspace shared by every agent on the box and are not listed.</p></div><span class="status-pill">${record.files.length}</span></div><div class="file-grid">${files}</div></div>`;
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
        ? `<li>Started — no tool call reported for this turn yet</li>`
        : `<li class="is-pending">Nothing running for this worker</li>`;
    // Naming it honestly: this hides the view, it does not stop the worker. There is no host
    // command to halt a turn in flight, and a button labelled Pause promises exactly that.
    elements.pauseRun.textContent = state.desktop.paused ? "Resume view" : "Pause view";
    elements.pauseRun.title = "Pauses this view only. The worker keeps running — this host has no command to stop a turn.";
    renderHandBack();
  }

  // GW-10, superseded by HANDBACK-1: a request_box_help takeover parks the agent until the person
  // hands the computer back. The control keeps its exact contract -- #hand-back hidden unless a
  // hand-off is pending, dataset.handBack carrying the agent id, #hand-back-note carrying the
  // instruction -- because that pair is what verify-dashboard's GW-10 leg looks for. What changed
  // is where they live: they are the right-hand end of the amber banner across the top of the
  // takeover view now, not two controls in the footer 719 px from the screen they are about. The
  // same call drives the rail card and the card in the transcript, so all three follow one state.
  function renderHandBack() {
    const button = document.getElementById("hand-back");
    const note = document.getElementById("hand-back-note");
    const banner = document.getElementById("handoff-banner");
    const skip = document.getElementById("handoff-skip");
    if (!button) return;
    const lead = contextLead();
    const handoff = lead?.handoff ?? null;
    const canHandBack = handoff && typeof adapter.handBack === "function";
    button.hidden = !canHandBack;
    button.dataset.handBack = canHandBack ? lead.id : "";
    if (canHandBack) button.dataset.agentId = lead.id; else delete button.dataset.agentId;
    if (note) {
      note.hidden = !handoff;
      // The full sentence is in the title: a model writes this text and a long one would push the
      // banner into the desktop it is describing (MR-33 was exactly that overflow, once).
      note.title = handoff ? handoff.instruction || "" : "";
      // The instruction and nothing else, the way the card and the rail carry it. The agent's name
      // is in the dialog title directly above this, and prefixing it here made one step read three
      // different ways in the three places a person meets it.
      note.textContent = handoff ? (handoff.instruction || "It did not say what it needs done.") : "";
    }
    if (skip) {
      skip.hidden = !(canHandBack && boxHandoffSkipSupported());
      if (canHandBack) skip.dataset.agentId = lead.id; else delete skip.dataset.agentId;
    }
    if (banner) banner.hidden = !handoff;
  }

  // SEAT-FOCUS-1b: ESCAPE STILL CLOSES THIS DIALOG ONCE THE SEAT HAS THE KEYBOARD.
  //
  // The seat inside this dialog is the one frame that is MEANT to hold the keys: the person opened it
  // to work on that screen, the paste bridge depends on it, and screen-tile.js's hand-back is scoped
  // by attribute to the two off-screen readers precisely so it never touches this one. But Escape is
  // the dialog's own way out, and a <dialog> only closes on Escape when the key reaches the document
  // the dialog is in. Once noVNC focuses its canvas the parent document sees nothing, so the keyboard
  // way out of the agent's screen was gone: measured on grok-bot-local-vm, a real Escape reached a
  // capture-phase document listener 0 times and the dialog stayed open.
  //
  // The seat is SAME ORIGIN by construction -- its src is built on window.location.origin, because the
  // relay proxies the box's noVNC at /vnc/<display>/ -- so its document is readable and a capture
  // keydown on it catches the key the parent never gets. Escape and nothing else: every other key,
  // the space bar included, stays with the box, which is the whole reason this frame is exempt from
  // the readers' rule. The poll is for the same reason keepKeyboardOff has one: the client's document
  // arrives after the mount returns, and the frame is replaced whenever the display changes.
  let desktopEscapeDisarm = null;

  function armDesktopEscape() {
    disarmDesktopEscape();
    let inner = null;
    let seen = null;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (!elements.desktopDialog.open) return;
      elements.desktopDialog.close();
    };
    const drop = () => {
      if (inner == null) return;
      try { inner.removeEventListener("keydown", onKey, true); } catch { /* gone with the frame */ }
      inner = null;
      seen = null;
    };
    const reachIn = () => {
      const frame = elements.desktopWindow.querySelector("iframe[data-box-vnc]");
      if (frame == null) { drop(); return; }
      let document_ = null;
      // Reading contentDocument on a frame this page may not read throws on the property access
      // itself. That is not an error here -- it is the case a future image serving the client from the
      // box's own address would put this in, and then there is nothing to install and nothing to do.
      try { document_ = frame.contentDocument; } catch { return; }
      if (document_ == null || typeof document_.addEventListener !== "function") return;
      if (document_ === inner && frame === seen) return;
      drop();
      try { document_.addEventListener("keydown", onKey, true); inner = document_; seen = frame; } catch { /* nothing to do */ }
    };
    reachIn();
    let poll = null;
    try {
      poll = window.setInterval(() => {
        if (!elements.desktopDialog.open) { disarmDesktopEscape(); return; }
        reachIn();
      }, 250);
    } catch { poll = null; }
    desktopEscapeDisarm = () => {
      if (poll != null) { try { window.clearInterval(poll); } catch { /* nothing to do */ } }
      drop();
      desktopEscapeDisarm = null;
    };
  }

  function disarmDesktopEscape() {
    if (desktopEscapeDisarm != null) desktopEscapeDisarm();
  }

  // AND THE KEYBOARD COMES BACK WHEN THE PANE CLOSES, which is the second half of the same defect and
  // the half one machine would have got wrong. MEASURED on grok-bot-local-vm: after a real Escape the
  // browser handed it back on its own inside a quarter second, and a blur() at the close event fired
  // against BODY and changed nothing. MEASURED on the live R750 through console.titanium.bot as a
  // throwaway customer, same commit, same gate: `document.activeElement` was STILL the
  // `[data-box-vnc]` frame six seconds after the pane closed and the next real Escape reached the
  // page's own document 0 times, so talk mode could not be left at all. So it is handed back here
  // rather than hoped for: blur now, and again on a 250 ms poll for two seconds, because the client
  // can re-focus its own canvas after the dialog has stopped being rendered. Bounded on purpose -- a
  // frame nobody can see is not worth an interval for the life of the page -- and it stops early if
  // the pane is opened again. blur() is what screen-tile.js's hand-back uses on the readers, for the
  // same reason and with the same measured result: activeElement goes to BODY and stays there.
  function handSeatKeyboardBack() {
    const frame = elements.desktopWindow.querySelector("iframe[data-box-vnc]");
    if (frame == null) return;
    const give = () => {
      if (document.activeElement !== frame) return;
      try { frame.blur(); } catch { /* the frame went with the pane */ }
    };
    give();
    let tries = 8;
    let poll = null;
    const stop = () => { if (poll != null) { try { window.clearInterval(poll); } catch { /* nothing to do */ } poll = null; } };
    try {
      poll = window.setInterval(() => {
        tries -= 1;
        if (tries <= 0 || elements.desktopDialog.open || frame.isConnected === false) { stop(); return; }
        give();
      }, 250);
    } catch { poll = null; }
  }

  // takeover is Take over, and only Take over: the view goes full window with the app dimmed
  // behind it and the banner across the top. The rail capsule and Open computer keep the centred
  // dialog the rest of the console has always had, so nothing regresses for ordinary use.
  function openDesktop(appName, takeover = false) {
    closeOpenDialogs(elements.desktopDialog);
    if (takeover) elements.desktopDialog.dataset.takeover = "1";
    else delete elements.desktopDialog.dataset.takeover;
    renderDesktop(appName);
    if (!elements.desktopDialog.open) elements.desktopDialog.showModal();
    armDesktopEscape();
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
    // MARKET-6: the Add-your-own doors, their header rows, the preview button and the orphan
    // strip's Clear. Handled before the long chain below because none of them belongs in it: they
    // are one card's own controls, and threading five more branches through a list every other
    // panel also walks is how that list became unreadable.
    if (handleByoClick(target)) return;
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
        showToast("Add your own is open below. Pick a link or a program, or paste the server's own config block; nothing is written until you press Add.");
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
      // CONNECT-11: the ordering is no longer this page's private knowledge. The values have to go
      // before the entry, because the host resolves a connector's store through connectors.json
      // and cannot reach it once the row has left the file -- so the host does both, in that
      // order, under one call. All this says is whether the operator asked for the clear.
      const clear = elements.panelContent.querySelector("[data-marketplace-clear-secrets]");
      target.disabled = true;
      Promise.resolve(adapter.removeConnector(name, { clearSecrets: clear?.checked === true }))
        .then((result) => {
          marketplaceArmedUninstall = null;
          marketplacePluginId = null;
          showToast(result?.message ?? `${name} removed`);
          refreshMarketplace();
          refreshByoOrphans();
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
      // MARKET-6: a preset IS a program, and the card now opens on the link door. Take the
      // operator to the door the fields are on before filling them, or the toast would say the
      // form was filled and there would be no form on screen.
      if (preset && byoDoor !== "program") { byoDoor = "program"; byoRefusalText = null; byoNote = null; byoPreview = null; repaintByoPanel(); }
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
      // The value goes with the entry (MARKET-23). The host does both under one call, in the order
      // that works -- the store is resolved through connectors.json, so a clear after the row has
      // left the file cannot find it -- and its answer names what it cleared, which is what the
      // toast reads.
      Promise.resolve(adapter.removeConnector(name, { clearSecrets: true }))
        .then((result) => { renderPluginsPanel(); refreshByoOrphans(); showToast(result?.message ?? `${name} removed`); })
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
    } else if (target.hasAttribute("data-job-bus-generate") || target.hasAttribute("data-job-bus-set") || target.hasAttribute("data-job-bus-clear")) {
      const root = elements.panelContent.querySelector("[data-job-bus]");
      const input = root.querySelector("[data-job-bus-input]");
      const minted = root.querySelector("[data-job-bus-minted]");
      const generating = target.hasAttribute("data-job-bus-generate");
      const write = generating
        ? adapter.generateJobBusToken()
        : target.hasAttribute("data-job-bus-set") ? adapter.setJobBusToken(input.value) : adapter.clearJobBusToken();
      target.disabled = true;
      Promise.resolve(write).then((answer) => {
        if (!answer.accepted) { showToast(answer.message ?? "The relay refused that."); return; }
        input.value = "";
        // The one place a token is on screen. It is put there only by the route that minted it,
        // and it is gone from the page the moment anything else is done on this card.
        if (generating && answer.token) {
          minted.hidden = false;
          minted.querySelector("[data-job-bus-minted-value]").value = answer.token;
        } else {
          minted.hidden = true;
          minted.querySelector("[data-job-bus-minted-value]").value = "";
        }
        showToast(answer.message ?? "The relay stored it.");
      }).catch((error) => showToast(`The job bus token was not changed: ${error.message}`))
        .finally(() => { target.disabled = false; fillJobBus(); });
    } else if (target.hasAttribute("data-job-bus-copy")) {
      const value = elements.panelContent.querySelector("[data-job-bus-minted-value]");
      const copy = navigator.clipboard?.writeText?.(value.value);
      // Selecting it is the fallback when the clipboard is not ours to write, which is every
      // page served over plain http to anything but localhost.
      Promise.resolve(copy).then(() => showToast("Token copied."))
        .catch(() => { value.focus(); value.select(); showToast("This browser would not let the page write the clipboard. It is selected, so copy it."); });
    } else if (target.hasAttribute("data-job-bus-enabled")) {
      // The one control on this card that writes on the click, because it is the arm and disarm
      // and a switch that needed a Save underneath it would sit there lying about the bus. What
      // is painted afterwards is the host's answer, read back, not the position it was dragged to.
      const root = elements.panelContent.querySelector("[data-job-bus]");
      const enabled = target.getAttribute("aria-pressed") !== "true";
      target.disabled = true;
      Promise.resolve(adapter.setJobBusSettings({ enabled }))
        .then(() => showToast(enabled ? "The job bus is on." : "The job bus is off. Every create answers 503."))
        .catch((error) => showToast(`The job bus was not switched: ${error.message}`))
        .finally(() => {
          target.disabled = false;
          // Only the switch, so a toggle does not wipe an edit in the lists under it.
          Promise.resolve(adapter.getJobBusSettings()).then((settings) => fillJobBusEnabled(root, settings)).catch(() => {});
        });
    } else if (target.hasAttribute("data-job-bus-allow-unattested")) {
      // Not written on the click: this one goes with Save, so an accidental tap on a phone does not
      // silently take the checking off a bus that is already running work.
      const root = elements.panelContent.querySelector("[data-job-bus]");
      const on = target.getAttribute("aria-pressed") !== "true";
      target.setAttribute("aria-pressed", String(on));
      fillJobBusUnattested(root, { allowUnattested: on });
    } else if (target.hasAttribute("data-job-bus-worker-add")) {
      const rows = elements.panelContent.querySelector("[data-job-bus-workers]");
      rows.insertAdjacentHTML("beforeend", jobBusWorkerRow("", ""));
    } else if (target.hasAttribute("data-job-bus-repo-add") || target.hasAttribute("data-job-bus-connector-add")) {
      const repo = target.hasAttribute("data-job-bus-repo-add");
      const rows = elements.panelContent.querySelector(repo ? "[data-job-bus-repos]" : "[data-job-bus-connectors]");
      // The empty-list hint is a paragraph, not a row, so it is cleared rather than appended to.
      if (rows.querySelector(".field-hint")) rows.innerHTML = "";
      rows.insertAdjacentHTML("beforeend", jobBusListRow(repo ? "repo" : "connector", ""));
    } else if (target.hasAttribute("data-job-bus-row-remove")) {
      target.closest("[data-job-bus-worker], [data-job-bus-repo], [data-job-bus-connector]")?.remove();
    } else if (target.hasAttribute("data-job-bus-settings-save")) {
      const root = elements.panelContent.querySelector("[data-job-bus]");
      const settings = jobBusSettingsFromCard(root);
      target.disabled = true;
      // `enabled` is deliberately not in this write: the switch owns it, so a Save cannot arm a
      // bus the operator only meant to re-point.
      Promise.resolve(adapter.setJobBusSettings(settings))
        .then(() => showToast(`Job bus settings saved: ${Object.keys(settings.workers).length} type(s), ${settings.repos.length} repo(s)`))
        .catch((error) => showToast(`The job bus settings were not saved: ${error.message}`))
        .finally(() => { target.disabled = false; fillJobBus(); });
    } else if (isMailControl(target)) {
      mailClick(target);
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
      const from = panelGeneration;
      adapter.duplicateAgent(target.dataset.duplicateAgent)
        .then((copy) => { closePanelFrom(from); rosterMode = "workers"; showToast(`${copy.name} created on the host`); })
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
      const from = panelGeneration;
      adapter.deleteAgent(agentId)
        .then((name) => { closePanelFrom(from); showToast(`${name} deleted on the host`); })
        .catch((error) => { target.disabled = false; target.textContent = "Delete"; showToast(`Not deleted: ${error.message}`); });
    } else if (target.dataset.repairTranscript) {
      // BOX-6b. No toast: host-notes-read-as-errors.md. The note lands in the panel, in plain
      // words, next to the button that caused it, and stays there to be read.
      repairTranscriptFromPanel(target, target.dataset.repairTranscript);
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
    } else if (form.dataset.pluginCredentialForm) {
      // MARKET-5: one write per credential, through setPluginCredential, which fans it out to
      // every consumer the catalog row declares. The boxes are cleared before the call resolves,
      // so no value sits in a control while the write is in flight, and the answer says where the
      // value actually went rather than this page guessing.
      const pluginId = form.dataset.pluginCredentialForm;
      const item = marketplaceItemById(pluginId);
      const entries = Array.from(form.querySelectorAll("input[type=password]"))
        .map((input) => ({ field: input.name, value: input.value }))
        .filter((entry) => entry.value.length > 0);
      form.querySelectorAll("input[type=password]").forEach((input) => { input.value = ""; });
      if (!entries.length) { showToast("Nothing to store — every box was blank"); return; }
      const submit = form.querySelector("button[type=submit]");
      if (submit) submit.disabled = true;
      const result = form.parentElement?.querySelector("[data-plugin-credential-result]");
      Promise.all(entries.map((entry) => Promise.resolve(adapter.setPluginCredential(pluginId, entry.field, entry.value, item))))
        .then((answers) => {
          if (submit) submit.disabled = false;
          const bad = answers.find((answer) => answer && answer.accepted === false);
          const wentTo = [...new Set(answers.flatMap((answer) => (Array.isArray(answer?.wentTo) ? answer.wentTo : [])))];
          const pending = [...new Set(answers.flatMap((answer) => (Array.isArray(answer?.pendingWindows) ? answer.pendingWindows : [])))];
          if (result) {
            result.hidden = false;
            result.textContent = bad
              ? bad.message
              : `Stored on the host${wentTo.length ? ` and handed to ${wentTo.join(" and ")}` : ""}.`
                + (pending.length ? ` ${pending.length} open window${pending.length === 1 ? "" : "s"} still ${pending.length === 1 ? "has" : "have"} the old value until ${pending.length === 1 ? "it is" : "they are"} restarted.` : "");
          }
          showToast(bad?.message ?? answers[0]?.message ?? "Stored on the host");
          refreshMarketplace();
        })
        .catch((error) => {
          if (submit) submit.disabled = false;
          if (result) { result.hidden = false; result.textContent = `Not stored: ${error.message}`; }
          showToast(`Not stored: ${error.message}`);
        });
    } else if (form.hasAttribute("data-byo-link")) {
      submitByoLink(form);
    } else if (form.hasAttribute("data-byo-paste")) {
      submitByoPaste(form);
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
      const from = panelGeneration;
      Promise.resolve(adapter.addWorker({ name: data.get("name"), role: data.get("role") }))
        .then((worker) => { rosterMode = "workers"; closePanelFrom(from); showToast(`${worker.name} created with a direct conversation`); })
        .catch((error) => showToast(agentCapRefusal(error) || `Could not create that agent: ${error.message}`));
    } else if (form.hasAttribute("data-add-room")) {
      const data = new FormData(form);
      const memberId = data.get("memberId");
      const from = panelGeneration;
      Promise.resolve(adapter.addRoom({ name: data.get("name"), memberIds: memberId ? [memberId] : [] }))
        .then((room) => { rosterMode = "rooms"; closePanelFrom(from); showToast(`${room.name} room created`); })
        .catch((error) => showToast(`Could not create that room: ${error.message}`));
    }

  }

  adapter.subscribe((event) => {
    state = event.snapshot;
    // FEEDBACK-1: both automatic triggers run on the tick the conversation changed and before the
    // redraw below, so an offer is drawn with the messages that caused it rather than one tick
    // behind them. Both are cheap array reads over what is already on the page.
    drainFailedTurnOffers();
    noteRepeatedToolFailures();
    // FEEDBACK-1b: and the box's own pending file, on the same beat, behind its own floor.
    watchPendingProblemReports();
    // CONSOLE-4: every route into another conversation, not only the roster click -- the palette's
    // jump, and landOn after a create, both reach the page through this event and nothing else.
    if (event.type === "context:selected") pinTranscriptToBottom();
    // An older page is the one transcript change that must not move the reader.
    if (event.type === "transcript:older") { renderTranscriptKeepingOffset(); renderContextCard(); renderBoxHandoffSurfaces(); return; }
    // A revealed entry: the window may have grown backwards; redraw, then scroll to and flash it.
    if (event.type === "transcript:reveal") {
      // Redrawn without the bottom scroll, and flashed on the next frame, after the redraw has
      // laid out: a scrollIntoView before that frame was undone by the render's own scroll.
      renderAll(true, true);
      const entryId = event.detail?.entryId;
      requestAnimationFrame(() => { if (entryId && !flashEntry(entryId)) showToast("That message is not in the loaded part of the conversation."); });
      return;
    }
    // JOBBUS-3: a job transition redraws the jobs table and nothing else. Repainting the whole
    // page for it would throw away whatever the operator is typing into the token or worker
    // fields on the very card the event is about.
    if (event.type === "job-bus:changed") {
      // SETTINGS-2: and only when the Operator section is the one on screen. One body is painted
      // at a time now, so a refill aimed at a card that is not drawn writes into nothing.
      if (elements.panelDialog.open && openPluginSurface === "settings" && settingsSection === "operator") fillJobBusRows();
      return;
    }
    renderAll(event.type === "worker:status" || event.type.startsWith("plugin:") || event.type.startsWith("settings:"));
    refreshOpenSkillsPanel();
    // MARKET-1: the install states are derived from the connector cards, so a connector the host
    // has finished launching moves "Connecting" to "Ready" without the operator reopening the panel.
    if (event.type.startsWith("plugin:") && elements.panelDialog.open && openPluginSurface === "marketplace") refreshMarketplace(true);
    // A provider or plan card's own switch goes through adapter.setModel, which re-reads the box
    // and then emits. The endpoint row is not redrawn by renderAll, so without this it kept saying
    // what the box was on before the click: true a second ago, wrong now, on the one row whose
    // whole job is to say what is actually answering.
    if ((event.type.startsWith("plugin:") || event.type === "settings:model") && elements.panelDialog.open && openPluginSurface === "settings" && settingsSection === "operator") fillEndpoints();
    if (event.type === "desktop:pause") renderDesktop();
    // Not renderDesktop: that remounts the VNC frame. Only the hand-off banner follows state.
    else if (elements.desktopDialog.open) renderHandBack();
  });

  // FEEDBACK-1: the two controls that are there whether or not anything has gone wrong. Both are
  // optional in the DOM so a page that has not shipped them yet still boots.
  document.querySelector("[data-report-open]")?.addEventListener("click", () => openProblemReportCard());
  document.querySelector("[data-run-self-test]")?.addEventListener("click", () => {
    if (runSelfTest() == null) showToast("This console cannot send a prompt from here.");
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
    // CONSOLE-4: your own send takes you to the bottom, wherever you were reading. The third and
    // last of the moments that earn the jump.
    pinTranscriptToBottom();
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
    // Masked like the heads: the missing list is where a signed URL the reply quoted would land.
    const missing = (message.evidence.missing ?? []).map((token) => maskSecrets(String(token)));
    // The subtitle is the chip's own sentence, not the internal verdict word. Printing that word
    // here, and again in a pill, put back the "Evidence: unsupported" line the chip exists to
    // remove, one click behind it.
    const summary = EVIDENCE_COPY[message.evidence.verdict];
    openPanel("Claim provenance", summary ? summary(message.evidence).text : "Checked against the tool results",
      `<div class="panel-intro"><p>Checked against what the tools returned while writing this reply. Attempt <code>${escapeHtml(attemptId)}</code></p></div><div class="evidence-view" data-evidence-body>Reading the receipts from the host…</div>`);
    adapter.getEvidence(activeContext().id, attemptId).then(({ receipts, attestations }) => {
      const body = elements.panelContent.querySelector("[data-evidence-body]");
      if (!body) return;
      const tools = [...new Set(attestations.map((a) => a.tool).filter(Boolean))];
      const receiptRows = receipts.length
        ? receipts.map((r) => `<div class="context-detail-row"><span>${escapeHtml(r.type ?? "action")}</span><strong>${escapeHtml(maskSecrets(receiptLabel(r)))}</strong></div>`).join("")
        : `<div class="empty-state">No action receipts were written for this attempt.</div>`;
      evidenceHeads = attestations.map((a) => maskSecrets(String(a.head ?? "").slice(0, 600)));
      const attRows = attestations.length
        ? attestations.map((a, i) => `<div class="panel-card"><div class="setting-row"><div><strong>${escapeHtml(a.tool ?? "tool")}</strong><small>${a.ok ? "ok" : "failed"} · ${Number(a.bytes) || 0} bytes${a.truncated ? " · truncated" : ""}</small></div><span class="status-pill${a.ok ? " success" : ""}">${escapeHtml(String(a.sha256 ?? "").slice(0, 12))}</span></div><pre class="evidence-head" data-head-slot="${i}">Held by the host, apart from the model's own record. Not on this page until you ask for it.</pre><div class="form-actions"><button class="ghost-button" type="button" data-reveal-head="${i}">Show output</button></div></div>`).join("")
        : `<div class="empty-state">No tool result was attested for this attempt.</div>`;
      body.innerHTML = `<div class="tag-list"><span class="tag">${receipts.length} receipt${receipts.length === 1 ? "" : "s"}</span><span class="tag">${attestations.length} attestation${attestations.length === 1 ? "" : "s"}</span>${tools.map((t) => `<span class="tag">tool · ${escapeHtml(t)}</span>`).join("")}</div>${missing.length ? `<div class="plugin-section-title"><span>Named in the reply, found in no tool result</span></div><div class="empty-state">${escapeHtml(missing.join(", "))}</div>` : ""}<div class="plugin-section-title"><span>Actions taken</span></div>${receiptRows}<div class="plugin-section-title"><span>Attested tool output</span></div>${attRows}`;
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
    // FEEDBACK-1: Send and Not now on a report card, through the same one handler every other
    // in-transcript control goes through.
    const reportSend = event.target.closest("[data-report-send]");
    if (reportSend) {
      const id = reportSend.dataset.reportSend;
      const field = elements.transcript.querySelector(`[data-report-body="${CSS.escape(id)}"]`);
      sendProblemOffer(id, field?.value ?? "");
      return;
    }
    const reportDrop = event.target.closest("[data-report-drop]");
    if (reportDrop) {
      const offer = problemOfferById(reportDrop.dataset.reportDrop);
      if (offer) settleProblemOffer(offer, "dropped");
      return;
    }
    // FEEDBACK-2: fold the settled card now rather than waiting out its own few seconds.
    const reportDismiss = event.target.closest("[data-report-dismiss]");
    if (reportDismiss) {
      foldProblemOffer(problemOfferById(reportDismiss.dataset.reportDismiss));
      return;
    }
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
    // CONSOLE-5. Ahead of the decide branch: a chip drawn inside a card's own request sentence
    // would otherwise fall through and be read as a press on the card.
    const chip = chipFromEvent(event);
    if (chip) { copyCodeChip(chip); return; }
    const action = event.target.closest("[data-decide]");
    if (!action) return;
    // No toast: the card itself reports what the host did, once the host has done it.
    adapter.decideApproval(activeContext(), action.dataset.messageId, action.dataset.decide);
  });

  // An agent-to-agent blurb carries role="button" tabindex="0", so a keyboard user can focus it;
  // without this it was a focusable control that did nothing on Enter or Space. The evidence chip
  // is a real <button>, whose native activation already fires the click handler above.
  elements.transcript.addEventListener("keydown", (event) => {
    if (!isActivationKey(event)) return;
    // CONSOLE-5: the chip carries tabindex="0" and role="button", so a focusable control that did
    // nothing on Enter would be exactly the bug this listener was written to fix.
    const chip = chipFromEvent(event);
    if (chip) { event.preventDefault(); copyCodeChip(chip); return; }
    const evidence = event.target.closest?.("[data-evidence]");
    if (evidence && evidence.tagName === "BUTTON") return;
    const exchange = evidence ? null : event.target.closest?.("[data-exchange]");
    if (!evidence && !exchange) return;
    event.preventDefault();
    if (evidence) openEvidenceViewer(evidence.dataset.messageId);
    else openExchangeViewer(exchange.dataset.messageId);
  });

  // CONSOLE-5: the files viewer draws a markdown file through this same renderer (files-viewer.js
  // pulls paragraphMarkup off window.__mrUi), so chips appear inside the panel too. They copy there
  // as well. The alternative was a chip that carries role="button" in one place and is inert in the
  // other, which is a control that lies to a keyboard.
  elements.panelContent.addEventListener("click", (event) => {
    const chip = chipFromEvent(event);
    if (chip) copyCodeChip(chip);
  });
  elements.panelContent.addEventListener("keydown", (event) => {
    if (!isActivationKey(event)) return;
    const chip = chipFromEvent(event);
    if (!chip) return;
    event.preventDefault();
    copyCodeChip(chip);
  });

  document.querySelectorAll("[data-capability]").forEach((button) => button.addEventListener("click", () => {
    const capability = button.dataset.capability;
    if (capability === "files") openDesktop("files");
    else if (capability === "browser") openDesktop("browser");
    else if (capability === "routines") renderRoutinesPanel();
    else if (capability === "skills") renderSkillsPanel();
    else if (capability === "marketplace") { marketplacePluginId = null; renderMarketplacePanel(); }
    else if (capability === "add") openPanel("Global creation", "Add to the Machine Room", addPanel());
    // PHONE-CONSOLE-1: the entry that only exists in the + menu, doing exactly what the + button
    // does above the breakpoint -- the same guard, the same picker, one function.
    else if (capability === "attach") pickAttachment();
  }));

  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => elements.panelDialog.close()));
  document.querySelectorAll("[data-close-desktop]").forEach((button) => button.addEventListener("click", () => elements.desktopDialog.close()));
  // SEAT-FOCUS-1b's reach-in goes out with the dialog, however it was closed: the button, Escape
  // itself, closeOpenDialogs, or the backdrop click. A <dialog> fires close on every one of those.
  elements.desktopDialog.addEventListener("close", () => {
    disarmDesktopEscape();
    handSeatKeyboardBack();
  });
  document.querySelectorAll("[data-desktop-app]").forEach((button) => button.addEventListener("click", () => renderDesktop(button.dataset.desktopApp)));
  elements.panelContent.addEventListener("click", handlePanelClick);
  elements.panelContent.addEventListener("input", handleTriggerInput);
  elements.panelContent.addEventListener("input", handleMarketplaceInput);
  elements.panelContent.addEventListener("input", handleByoInput);
  elements.panelContent.addEventListener("change", handleTriggerInput);
  // MARKET-6: ticking "this value is a secret" swaps a value box for the env NAME the host will
  // store the key under. A checkbox is not a button, so the click handler never sees it.
  elements.panelContent.addEventListener("change", handleByoHeaderToggle);
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
  // MODELS-1: the provider card's model picker. The adapter does the writing; this only reports
  // what it says happened, and puts the select back where it was if it did not happen -- a picker
  // showing a model the box is not on is the exact failure this wave exists to end.
  elements.panelContent.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-provider-model]");
    if (!select) return;
    const pluginId = select.dataset.providerModel;
    const before = state.plugins.find((plugin) => plugin.id === pluginId)?.modelChoices?.current ?? "";
    const chosen = select.value;
    if (!chosen || chosen === before) return;
    select.disabled = true;
    try {
      const answer = await adapter.setEndpointModel(pluginId, chosen);
      showToast(answer?.message ?? `${chosen} saved`);
      if (answer?.accepted !== true && before) select.value = before;
    } catch (error) {
      showToast(`That model could not be set: ${error.message}`);
      if (before) select.value = before;
    } finally {
      select.disabled = false;
    }
  });
  elements.panelContent.addEventListener("submit", handlePanelSubmit);

  // A click event is not a section id, so the two gears go through a wrapper rather than being
  // handed straight to a function whose first argument names a section.
  const openSettings = () => openSettingsPanel("general");
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

  function pickAttachment() {
    if (activeContext().kind !== "worker") { showToast("Attach a file in a direct conversation — a room has no attachment store."); return; }
    document.getElementById("composer-file").click();
  }

  document.getElementById("composer-plus").addEventListener("click", () => {
    // PHONE-CONSOLE-1: on a phone the capabilities live behind this button, so the first press opens
    // the menu and "Attach a file" is the first row of it. Above the breakpoint nothing changes.
    if (isPhoneWidth()) { setCapabilityMenu(!document.body.dataset.capabilityMenu); return; }
    pickAttachment();
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

  // ---- PHONE-CONSOLE-1: the + menu, the transcript's pin, and the keyboard's ceiling ------------
  // Three things a person could not do on an iPhone, all of them about where the newest line is.
  // MEASURED in WebKit at 390x844 with the phone's insets restated: a reader at the newest line was
  // left 132 px from it by typing a long message (the composer grows 44 to 176 px under him) and
  // 336 px from it by the keyboard arriving, with nothing to re-pin him and no control to take him
  // back. The keyboard's own padding was written with no ceiling, which left a 54 px band of chat.
  //
  // WHAT IS NOT CHANGED HERE. renderTranscript's rule (CONSOLE-4, :2222) is correct and a tapped
  // Send still lands 0 to 1 px from the bottom; the report that it did not does not reproduce. What
  // was missing is that nothing watched the box's own HEIGHT -- a rebuild is not the only thing that
  // moves a reader away from the newest line.
  function isPhoneWidth() {
    return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 690px)").matches;
  }

  // THE + MENU. The capability dock is the same markup at both widths (styles.css draws it as a
  // sheet above the shelf on a phone), so there is no second set of buttons to wire: all this owns
  // is whether the sheet is open.
  function setCapabilityMenu(open) {
    if (open) document.body.dataset.capabilityMenu = "open";
    else delete document.body.dataset.capabilityMenu;
    document.getElementById("composer-plus")?.setAttribute("aria-expanded", String(Boolean(open)));
  }
  // A press acts and the sheet goes: one left standing over the composer, behind the panel it just
  // opened, is one more thing to dismiss by hand.
  document.querySelector(".capability-dock")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-capability]")) setCapabilityMenu(false);
  });
  document.getElementById("drawer-scrim")?.addEventListener("click", () => setCapabilityMenu(false));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") setCapabilityMenu(false); });

  // The same 90 px CONSOLE-4's renderTranscript uses, so the two agree on what "at the bottom" is.
  const NEAR_NEWEST = 90;
  // What the conversation keeps whatever the keyboard and the composer do to it. 180 px is five
  // lines of chat at this font, which is the least that is worth reading.
  const TRANSCRIPT_FLOOR = 180;
  const KEYBOARD_COMPOSER_LINES = 3;
  let transcriptPinned = true;
  let unseenWhileParked = 0;
  let transcriptRowCount = 0;
  let lastScrollTop = 0;
  let repinFrame = 0;

  const atNewest = () => {
    const box = elements.transcript;
    return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_NEWEST;
  };
  const keyboardTaken = () => parseFloat(document.documentElement.style.getPropertyValue("--kb")) || 0;
  function keyboardUp() { return keyboardTaken() > 0; }

  // A WAY BACK TO THE NEWEST LINE, which this console has never had. In .conversation-space, which
  // is position: relative and which renderTranscript never rebuilds -- and NOT in .voice-overlay,
  // which is pointer-events: none and could not be pressed.
  const jumpNewest = document.createElement("button");
  jumpNewest.className = "jump-newest";
  jumpNewest.type = "button";
  jumpNewest.dataset.jumpNewest = "";
  jumpNewest.hidden = true;
  jumpNewest.textContent = "Newest";
  document.querySelector(".conversation-space")?.appendChild(jumpNewest);

  // `hidden`, never style.display, and written only when it changes: this is called from inside an
  // observer's callback, and an unguarded write there is the 60 Hz loop console-flicker paid for.
  function paintJumpNewest() {
    const wanted = !transcriptPinned && unseenWhileParked > 0;
    if (jumpNewest.hidden === !wanted) return;
    jumpNewest.hidden = !wanted;
  }

  function repinTranscript() {
    if (!transcriptPinned || repinFrame) return;
    repinFrame = requestAnimationFrame(() => {
      repinFrame = 0;
      const box = elements.transcript;
      box.scrollTop = box.scrollHeight;
    });
  }

  // HOW MUCH OF THE SCREEN THE KEYBOARD MAY TAKE: whatever leaves the conversation its floor with
  // the composer at its own keyboard cap. It reads the band as it stands and adds back what it has
  // already taken, so repeated calls settle rather than ratchet.
  function keyboardCeiling() {
    const box = elements.transcript;
    if (!box) return Infinity;
    const input = elements.messageInput;
    const line = input ? parseFloat(getComputedStyle(input).lineHeight) || 22 : 22;
    const room = input ? Math.max(0, Math.round(line * KEYBOARD_COMPOSER_LINES) - input.getBoundingClientRect().height) : 0;
    return Math.max(0, Math.round(box.getBoundingClientRect().height + keyboardTaken() - TRANSCRIPT_FLOOR - room));
  }

  // A SCROLL EVENT IS NOT ALWAYS THE READER MOVING, and reading it as one is what made the first cut
  // of this fail. MEASURED in WebKit at 390x844: typing a long message fired 22 scroll events and 26
  // re-pins that each landed at 0 px from the bottom, and the reader still ended 132 px away. The
  // box shrinks under him as the composer grows, which leaves his scrollTop where it was and the
  // bottom further down; the scroll event that follows reports a gap, the first cut read that as
  // "he scrolled up", and every re-pin after it was skipped.
  //
  // SO THE ONLY WAY TO LOSE THE PIN IS TO SCROLL UP. scrollTop going DOWN is the reader's own drag
  // and nothing else does it; a gap that opens while scrollTop stands still is the floor moving,
  // and the answer to that is to take him back rather than to leave him behind.
  elements.transcript.addEventListener("scroll", () => {
    const box = elements.transcript;
    const top = box.scrollTop;
    const draggedUp = top < lastScrollTop - 1;
    lastScrollTop = top;
    if (draggedUp) transcriptPinned = atNewest();
    else if (atNewest()) transcriptPinned = true;
    else if (transcriptPinned) repinTranscript();
    if (transcriptPinned) unseenWhileParked = 0;
    paintJumpNewest();
  }, { passive: true });

  jumpNewest.addEventListener("click", () => {
    const box = elements.transcript;
    box.scrollTop = box.scrollHeight;
    transcriptPinned = true;
    unseenWhileParked = 0;
    paintJumpNewest();
  });

  // A row that ARRIVED while the reader was parked up is what the button counts. renderTranscript
  // rewrites the whole list on every tick, so the count of rows is the only honest signal: a rebuild
  // that lands the same rows is not news.
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => {
      const rows = elements.transcript.querySelectorAll(".message-row").length;
      const grew = rows - transcriptRowCount;
      transcriptRowCount = rows;
      if (grew > 0 && !transcriptPinned) unseenWhileParked += grew;
      paintJumpNewest();
    }).observe(elements.transcript, { childList: true });
  }

  // THE BOX'S OWN HEIGHT, watched rather than a list of the things that change it: the composer
  // growing, the keyboard arriving, a furniture row appearing in the shelf and a rotation all come
  // through here. The re-pin is a frame later and writes scrollTop only, which resizes nothing --
  // WebKit throws "ResizeObserver loop completed with undelivered notifications" at a callback that
  // resizes anything, and the deferral plus the repinFrame guard keep this out of that class.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => repinTranscript()).observe(elements.transcript);
  }
  // ---- end PHONE-CONSOLE-1 ---------------------------------------------------------------------

  // Eight lines is where a composer stops being a composer; past that the box scrolls itself.
  const COMPOSER_MAX_LINES = 8;
  function autosizeComposer() {
    const el = elements.messageInput;
    if (!el || el.tagName !== "TEXTAREA") return;
    // The stylesheet gives this box no padding and no border, so scrollHeight is the text's own
    // height and the cap is a plain multiple of the line box.
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = "auto";
    // PHONE-CONSOLE-1: eight lines is the cap with the keyboard down. With it up there is no room
    // for eight -- growing 44 to 176 px took the reader 132 px away from the newest line and left
    // the band under the floor -- so the box stops at KEYBOARD_LINES and scrolls itself.
    const lines = keyboardUp() ? KEYBOARD_COMPOSER_LINES : COMPOSER_MAX_LINES;
    el.style.height = `${Math.min(el.scrollHeight, Math.round(line * lines))}px`;
    repinTranscript();
  }
  elements.messageInput.addEventListener("input", autosizeComposer);
  // After the submit handler above has cleared the value, not before it.
  elements.composer.addEventListener("submit", () => { requestAnimationFrame(autosizeComposer); });
  autosizeComposer();

  // ---- MOBILE-1: the two drawers, and the keyboard ---------------------------------------------
  // The rails are off-canvas panels at phone widths and ordinary columns above the breakpoint, and
  // the stylesheet does the sliding, the scrim and the visibility. What is here is only what CSS
  // cannot do: which drawer is open, Escape and a scrim tap closing it, and handing the keyboard
  // back to the button that opened it.
  let drawerOpener = null;
  const drawerButtons = () => document.querySelectorAll("[data-drawer-toggle]");
  function setDrawer(name) {
    const open = name && document.body.dataset.drawer !== name ? name : "";
    if (open) document.body.dataset.drawer = open; else delete document.body.dataset.drawer;
    for (const button of drawerButtons()) button.setAttribute("aria-expanded", String(button.dataset.drawerToggle === open));
    if (open) drawerOpener = document.querySelector(`[data-drawer-toggle="${open}"]`);
    else if (drawerOpener) { drawerOpener.focus(); drawerOpener = null; }
  }
  for (const button of drawerButtons()) button.addEventListener("click", () => setDrawer(button.dataset.drawerToggle));
  document.getElementById("drawer-scrim")?.addEventListener("click", () => setDrawer(""));
  // Choosing a conversation is the reason the roster drawer was opened, so it closes behind you.
  document.getElementById("worker-roster")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-context-id]")) setDrawer("");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.dataset.drawer) setDrawer("");
  });

  // The composer above the keyboard. Chrome honours interactive-widget=resizes-content in the
  // viewport meta and shrinks the layout viewport for it; iOS Safari does not, so the shelf reads
  // the visual viewport itself and pads by the difference. THE IPHONE'S OWN KEYBOARD IS UNMEASURED
  // -- Chrome cannot raise one -- so this is built to the platform rule and asserted against a
  // simulated visualViewport resize, and docs/CONSOLE.md section 7 says exactly that.
  if (typeof window !== "undefined" && window.visualViewport) {
    const trackKeyboard = () => {
      const view = window.visualViewport;
      const kb = Math.max(0, Math.round(window.innerHeight - view.height - view.offsetTop));
      // PHONE-CONSOLE-1: never more than the conversation can spare. Unclamped this wrote 336 px of
      // shelf padding on a 390x844 phone and left a 54 px band of chat.
      document.documentElement.style.setProperty("--kb", `${Math.min(kb, keyboardCeiling())}px`);
    };
    window.visualViewport.addEventListener("resize", trackKeyboard);
    window.visualViewport.addEventListener("scroll", trackKeyboard);
    trackKeyboard();
  }
  // ---- end MOBILE-1 ----------------------------------------------------------------------------

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
  // ONBOARD-1: the root is a parameter because the onboarding dialog paints the same messages into
  // a container of its own. Called with nothing it walks the stage's transcript, as it always did.
  function fillAttachments(root = elements.transcript) {
    if (typeof adapter.readAttachmentImage !== "function") return;
    const agentId = attachmentAgentId() || null;
    root.querySelectorAll("[data-attachment]").forEach((figure) => {
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
    const agentId = attachmentAgentId() || null;
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

  wireDesktopPaste(); // qol/vnc-paste
  elements.scheduleButton.addEventListener("click", renderRoutinesPanel);
  document.getElementById("teach-button").addEventListener("click", (event) => openTeachMode(event.currentTarget));
  document.getElementById("finish-teach").addEventListener("click", () => stopTeachMode(true));
  document.getElementById("discard-teach").addEventListener("click", () => stopTeachMode(false));
  // HANDBACK-1: one delegated funnel for every hand-off control on the page -- the transcript
  // card, the rail card and the banner's own pair. #hand-back and #handoff-skip carry
  // data-handoff-action like the rest, so they are handled here rather than by a listener of their
  // own, and the element is captured out of the event before any await for the same reason the
  // old listener captured currentTarget: dispatch is over by the time .finally runs.
  document.addEventListener("click", handleBoxHandoffAction);
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


  // ===== ONBOARD-1: the first-run setup with Titan =============================================
  // On a box that has never been set up, the console opens a dialog under the window bar, the
  // width of the stage, with the chat still behind it. Titan's own face is in it, large and live;
  // the conversation inside it is his conversation, sent and read through the same adapter the
  // stage uses; and the five things he asks fill in as the host records each answer.
  //
  // Everything here is drawn from two facts and nothing else: what the box says about its own
  // setup (getOnboardingState), and the roster. A host too old to answer the command opens
  // nothing at all -- the adapter answers null and this file leaves the console alone.
  //
  // The transcript and the composer are singletons in the stage, and showModal() makes everything
  // outside this dialog inert, so the dialog carries its own of each. Both are built from the same
  // functions the stage uses (messageMarkup, adapter.sendMessage), so a message reads the same in
  // both places.

  // The five things Titan is keeping, in the order the chips read. `field` is the key the host
  // stores an answer under (save_onboarding_answer), so this list and docs/ONBOARDING.md are the
  // same contract.
  //
  // FIRSTRUN-2: these are slots, not questions, and the labels say so. They read "Your name",
  // "Where you are", "What kind of work", "Whether you own it", "How you want to work" -- five
  // labels for five closed questions asked in a fixed order. Jason, 2026-09-11: "This should be
  // more open-ended: 'Tell me about your work and how you work'. It should be 'Tell me about your
  // background'." He then answered the work question with a paragraph covering his role, his
  // company, four sites he writes on, two addresses and the calendar his day runs on, and expected
  // Titan to absorb all of it. The seeded skill now asks three open questions and fills every slot
  // an answer covers at once, so a chip can tick without a question of its own ever being asked --
  // which is why each one now names what it holds rather than a question that may never be put.
  const ONBOARDING_STEPS = [
    { field: "name", label: "What to call you" },
    { field: "location", label: "Where you are" },
    { field: "business", label: "Your background and what you do" },
    { field: "ownsBusiness", label: "Whether you own it" },
    { field: "workingStyle", label: "How you want me to work" },
  ];
  // How long Titan looks pleased after an answer goes in. The crew's own celebration is 6s
  // (mascot-crew.js CELEBRATION_MS); this is the same beat, so the dialog does not feel like a
  // different product from the roster behind it.
  const ONBOARDING_EXCITED_MS = 6000;
  // While the dialog is open the box is asked what it has captured. Titan writes an answer the
  // moment he gets it, and nothing pushes that to this page.
  const ONBOARDING_POLL_MS = 2500;

  let onboardingState = null;
  let onboardingPoll = null;
  let onboardingExcitedUntil = 0;
  let onboardingStarted = false;
  let onboardingPaintedSig = "";

  const onboardingAnswers = () => (onboardingState && typeof onboardingState.answers === "object" && onboardingState.answers) || {};
  const onboardingAnswered = (field) => {
    const value = onboardingAnswers()[field];
    return typeof value === "string" ? value.trim().length > 0 : value != null && value !== "";
  };
  const onboardingAnsweredCount = () => ONBOARDING_STEPS.filter((step) => onboardingAnswered(step.field)).length;
  // Whether there is anything left to skip. Titan closes the dialog himself when he is done talking
  // (finish_onboarding, which the box answers on the next poll), so this is only about the button:
  // a person who has answered all five and clicks the way out has not skipped anything, and the
  // label and the reason the box records both follow this one answer so they cannot disagree.
  const onboardingFinished = () => onboardingAnsweredCount() === ONBOARDING_STEPS.length;

  // Titan is the crew's first face and the box's first agent, and mascot-crew.js settles who that
  // is the same way: the agent actually named Titan, else the oldest one on the box. Reading it
  // the same way here means the face in this dialog is the face on the first roster card.
  function onboardingTitan() {
    const bots = state.workers.filter((worker) => worker.isGroup !== true);
    if (bots.length === 0) return null;
    const named = bots.find((worker) => String(worker.name || "").trim().toLowerCase() === "titan");
    if (named) return named;
    const dated = bots.filter((worker) => Number.isFinite(worker.createdAt));
    if (dated.length) return dated.reduce((oldest, worker) => (worker.createdAt < oldest.createdAt ? worker : oldest));
    return bots[0];
  }

  // Curious while he waits for an answer, pleased for a few seconds after one lands. Those are two
  // of the crew's three moods (mascot-crew.js moodFor); calm is the resting face and is not one
  // this conversation ever sits on.
  const onboardingMood = () => (Date.now() < onboardingExcitedUntil ? "excited" : "curious");

  function onboardingStepsMarkup() {
    const answers = onboardingAnswers();
    return ONBOARDING_STEPS.map((step) => {
      const done = onboardingAnswered(step.field);
      const said = done ? String(answers[step.field]) : "";
      return `<li class="onboarding-step${done ? " is-done" : ""}" data-onboarding-step="${escapeHtml(step.field)}" data-done="${done}">
        <span class="onboarding-tick" aria-hidden="true">${done ? "✓" : ""}</span>
        <span>${escapeHtml(step.label)}</span>
        ${done ? `<span class="onboarding-answer">${escapeHtml(said)}</span>` : ""}
      </li>`;
    }).join("");
  }

  function onboardingMarkup(titan) {
    const face = titan ? avatarMarkup(titan, "onboarding-face", titan.name) : "";
    const answered = onboardingAnsweredCount();
    return `<div class="onboarding-lede">
        ${face}
        <p>This is Titan, the bot that leads the rest of them on this box. He wants to hear a bit about you and your work, then he will show you what he can take off your hands. It takes about a minute.</p>
      </div>
      <ul class="onboarding-progress" aria-label="What Titan still needs">${onboardingStepsMarkup()}</ul>
      <p class="onboarding-count" data-onboarding-count>${answered} of ${ONBOARDING_STEPS.length} answered</p>
      <div class="onboarding-transcript" id="onboarding-transcript" data-onboarding-transcript aria-live="polite"></div>
      <form class="composer onboarding-composer" data-onboarding-composer>
        <label class="sr-only" for="onboarding-input">Answer Titan</label>
        <textarea id="onboarding-input" name="message" rows="1" autocomplete="off" placeholder="Answer Titan…"></textarea>
        <button class="send-button" type="submit"><span>➤</span> Send</button>
      </form>
      <p class="onboarding-note">Your answers stay in this workspace. Titan sends them to the model you set up, the same as any other message. You can close this and finish later.</p>`;
  }

  // The face is drawn by mascots.js, which also keeps every face on the page in step with its
  // agent's status. That is right for the roster and wrong here: this face answers to the
  // conversation in front of it, not to whether Titan is mid-turn. Dropping the marker mascots.js
  // looks for leaves this one element to this file.
  function paintOnboardingFace() {
    const frame = elements.onboardingContent.querySelector(".onboarding-face");
    if (!frame) return;
    // The hook docs/ONBOARDING.md section 6 names, set here rather than woven into avatarMarkup:
    // that function draws every face on the page and has no business knowing about this dialog.
    frame.setAttribute("data-onboarding-face", "");
    delete frame.dataset.titanAgent;
    const mood = onboardingMood();
    if (frame.dataset.titanMood === mood) return;
    frame.dataset.titanMood = mood;
    const mascot = frame.querySelector("titan-mascot");
    if (mascot) { mascot.setAttribute("mood", mood); return; }
    // The still, under prefers-reduced-motion. Same character, different frame.
    const still = frame.querySelector("img");
    const crew = window.TitanCrew;
    const index = crew ? crew.indexOfCharacter(frame.dataset.titanCharacter || "Titan") : -1;
    if (still && crew && index >= 0) still.src = crew.stillFor(index, mood);
  }

  // CONSOLE-6. The rows are written only when they have changed. This used to rebuild on every call,
  // and the call arrives on the dialog's own 2.5 s poll whether or not Titan has said anything, so
  // the only chat on screen during setup was thrown away and rebuilt four times a minute under the
  // person reading it. Jason, 2026-09-11, inside the Meet Titan window: "only the text chat area is
  // flashing, refreshing every 3 seconds or so."
  //
  // The markup is the signature, because the markup is the whole of what is on screen: a row whose
  // time changed from "now" to a clock reading is a real change and gets drawn, and a poll that
  // brought nothing new writes nothing at all.
  // The element is half the signature, not only the markup: renderOnboarding rebuilds the dialog's
  // whole body when an answer lands, so the box this last painted into can be a node that is no
  // longer on the page, and comparing markup alone would then leave the new one empty for ever.
  let onboardingPaintedRows = null;
  let onboardingPaintedBox = null;
  function paintOnboardingTranscript() {
    const box = elements.onboardingContent.querySelector("#onboarding-transcript");
    if (!box) return;
    const rows = contextMessages().map(messageMarkup).join("");
    if (onboardingPaintedBox === box && onboardingPaintedRows === rows) return;
    onboardingPaintedBox = box;
    onboardingPaintedRows = rows;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.innerHTML = rows;
    fillAttachments(box);
    if (nearBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }

  // Called from renderAll, so the dialog follows the same events the stage does. The body is
  // rebuilt only when something in it actually moved: a rebuild on every tick would take the
  // composer's half-typed answer with it.
  function renderOnboarding() {
    if (!elements.onboardingDialog?.open) return;
    const titan = onboardingTitan();
    const sig = `${titan ? titan.id : ""}|${ONBOARDING_STEPS.map((step) => String(onboardingAnswers()[step.field] ?? "")).join("")}`;
    if (sig !== onboardingPaintedSig) {
      onboardingPaintedSig = sig;
      // Whose conversation this is. On the dialog rather than inside it, so anything reading the
      // page can tell which agent the modal is bound to without walking the transcript.
      if (titan) elements.onboardingDialog.dataset.onboardingAgent = titan.id;
      else delete elements.onboardingDialog.dataset.onboardingAgent;
      const draft = elements.onboardingContent.querySelector("#onboarding-input")?.value ?? "";
      elements.onboardingContent.innerHTML = onboardingMarkup(titan);
      const input = elements.onboardingContent.querySelector("#onboarding-input");
      if (input && draft) input.value = draft;
      if (typeof window.__titanMascots?.afterRender === "function") window.__titanMascots.afterRender();
    }
    paintOnboardingFace();
    paintOnboardingExit();
    paintOnboardingTranscript();
  }

  // The way out, in the person's own words. The button lives in index.html rather than in the body
  // this file rebuilds, so it is painted here instead of in onboardingMarkup.
  function paintOnboardingExit() {
    const button = elements.onboardingDialog?.querySelector("[data-onboarding-skip]");
    if (!button) return;
    const label = onboardingFinished() ? "Done" : "Skip for now";
    if (button.textContent !== label) button.textContent = label;
  }

  function sendOnboardingMessage(text) {
    const clean = String(text || "").trim();
    if (!clean) return;
    const context = { ...activeContext() };
    adapter.sendMessage(context, clean, []);
    // He has just been told something. The face says so before the answer is anywhere near the box.
    onboardingExcitedUntil = Date.now() + ONBOARDING_EXCITED_MS;
    paintOnboardingFace();
    window.setTimeout(paintOnboardingFace, ONBOARDING_EXCITED_MS + 60);
    // Demo-only, the same rule the stage composer follows: against a live gateway Titan answers
    // for himself and a simulated reply would talk over him.
    if (!window.__machineRoomLive) simulateReply(context, clean);
  }

  // The ceiling the box is actually holding to, as it reports it. Read here rather than at boot
  // from a second command: getOnboardingState carries it on every box, first run or not, so the
  // roster header and the Add button draw the operator's own number instead of the built-in 13.
  function applyReportedCap(next) {
    const cap = Number(next?.maxAgents);
    if (!Number.isFinite(cap) || cap <= 0 || cap === state.agentCap) return;
    state.agentCap = cap;
    renderAgentCount();
  }

  function refreshOnboardingState() {
    if (typeof adapter.getOnboardingState !== "function") return Promise.resolve(null);
    return Promise.resolve(adapter.getOnboardingState())
      .then((next) => {
        if (!next || typeof next !== "object") return null;
        onboardingState = next;
        applyReportedCap(next);
        if (next.done === true) { closeOnboarding(); return next; }
        renderOnboarding();
        return next;
      })
      .catch(() => null);
  }

  function openOnboarding() {
    const titan = onboardingTitan();
    if (!titan || elements.onboardingDialog.open) return;
    // His conversation, not whichever one the console happened to open on -- and the console is
    // left on it when the dialog closes, which is where the person should land.
    if (!sameContext(activeContext(), { kind: "worker", id: titan.id })) selectContext("worker", titan.id);
    onboardingPaintedSig = "";
    onboardingExcitedUntil = 0;
    elements.onboardingDialog.showModal();
    renderOnboarding();
    // The dialog is filled after showModal, so the browser's own first focus lands on Skip for now
    // -- the one control in it at that moment. Put the caret where the person is meant to type.
    elements.onboardingContent.querySelector("#onboarding-input")?.focus();
    // The opening line is the console's to ask for: the fresh-box first agent never gets the
    // host's own kickstart (agent-lifecycle.ts mints it without setIntroductionPending), so
    // without this the dialog would open on an empty conversation and wait forever.
    if (!onboardingStarted && typeof adapter.startOnboarding === "function") {
      onboardingStarted = true;
      Promise.resolve(adapter.startOnboarding(titan.id)).catch(() => { onboardingStarted = false; });
    }
    window.clearInterval(onboardingPoll);
    onboardingPoll = window.setInterval(refreshOnboardingState, ONBOARDING_POLL_MS);
  }

  function closeOnboarding() {
    window.clearInterval(onboardingPoll);
    onboardingPoll = null;
    if (elements.onboardingDialog?.open) elements.onboardingDialog.close();
  }

  // The button, and Escape, which is the same act. The box is told setup is over and it keeps
  // whatever Titan captured before the click. A host that refuses the write leaves the dialog open
  // and says why, because closing it on a flag that did not move would bring it back on the next
  // load.
  //
  // The ordinary ending is not this: Titan calls finish_onboarding when he has finished talking,
  // the box answers done:true on the next poll, and refreshOnboardingState closes the dialog. This
  // is the person's own way out, whether they are skipping or finishing ahead of him, and the box
  // is told which of the two it was.
  function closeOnboardingFromButton(button) {
    const finished = onboardingFinished();
    if (typeof adapter.completeOnboarding !== "function") { closeOnboarding(); return; }
    if (button) button.disabled = true;
    Promise.resolve(adapter.completeOnboarding(onboardingAnswers(), { skipped: !finished }))
      .then((next) => {
        if (next && typeof next === "object") onboardingState = next;
        closeOnboarding();
        showToast(finished
          ? "Setup is done. Titan is on the roster and the chat carries on where you left it."
          : "Setup closed. Titan is on the roster whenever you want to finish it.");
      })
      .catch((error) => {
        if (button) button.disabled = false;
        showToast(`Setup was not closed: ${error.message}`);
      });
  }

  // The one read at boot. A box that says it is done, a host that cannot answer, and a roster with
  // nobody on it all mean the same thing here: open nothing.
  function maybeOpenOnboarding() {
    if (typeof adapter.getOnboardingState !== "function") return;
    Promise.resolve(adapter.getOnboardingState())
      .then((next) => {
        if (!next || typeof next !== "object") return;
        applyReportedCap(next);
        if (next.done !== false) return;
        onboardingState = next;
        openOnboarding();
      })
      .catch(() => { /* a box that will not say is not a box in its first run */ });
  }

  elements.onboardingDialog?.addEventListener("click", (event) => {
    const skip = event.target instanceof Element ? event.target.closest("[data-onboarding-skip]") : null;
    if (skip) { closeOnboardingFromButton(skip); return; }
  });
  elements.onboardingDialog?.addEventListener("submit", (event) => {
    if (!(event.target instanceof Element) || !event.target.hasAttribute("data-onboarding-composer")) return;
    event.preventDefault();
    const input = elements.onboardingContent.querySelector("#onboarding-input");
    if (!input) return;
    const text = input.value;
    input.value = "";
    sendOnboardingMessage(text);
  });
  // Enter sends, Shift+Enter opens a line -- the stage composer's rule (QOL-COMPOSER), so the two
  // boxes do not behave differently.
  elements.onboardingDialog?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const form = event.target instanceof Element ? event.target.closest("[data-onboarding-composer]") : null;
    if (!form) return;
    event.preventDefault();
    form.requestSubmit();
  });
  // Escape is the same act as Skip for now: it has to reach the box, or the dialog comes back on
  // the next load with nothing recorded about why it was dismissed.
  elements.onboardingDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeOnboardingFromButton(elements.onboardingDialog.querySelector("[data-onboarding-skip]"));
  });
  // ===== end ONBOARD-1 =========================================================================

  countdownInterval = window.setInterval(renderNowAndSchedule, 30_000);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(countdownInterval);
    window.clearInterval(onboardingPoll);
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

  // ===== CONSOLE-4: the seam the three sibling modules build against =====
  // gap-badge.js, screen-tile.js and files-viewer.js are separate files so that four builders can
  // share this console without four of them sharing this file. They need five things out of it and
  // nothing else: the modal every other viewer already opens, the markdown renderer the transcript
  // already uses, the redaction already applied to attachment text, the escaper, and a way to ask
  // for a repaint. Publishing them here keeps those modules out of this file's internals entirely,
  // exactly as window.__marketplaceBots and window.__titanMascots already do.
  window.__mrUi = {
    openPanel, paragraphMarkup, maskSecrets, escapeHtml, renderAll, showToast,
    // THE ONE WAY INTO SETTINGS from another module, and the reason it exists: voice.js used to
    // synthesise a click on #shelf-settings, which computes display:none at 390x844 -- so "Open
    // voice settings" was dead on every phone, silently, because a click on a hidden element is not
    // an error. openSettings(sectionId) takes a section rather than an event and works at every
    // width. It is the wrapper below, so a module calling it gets General unless it names a section.
    openSettings: (sectionId) => openSettingsPanel(typeof sectionId === "string" ? sectionId : "general"),
    // ===== SETTINGS-2: the seam settings.js and account-menu.js build against =====
    // Six facts this file already holds and two bodies it still owns. Publishing them here keeps the
    // settings surface out of this file's internals entirely, the same way __marketplaceBots and the
    // three CONSOLE-4 modules already work. settings.js reads the adapter itself for everything the
    // adapter can answer; this object is only what lives in app.js's own closure.
    settingsHost: {
      operatorMarkup: settingsPanel,
      operatorFill: fillOperatorSettings,
      markOpen: () => { openPluginSurface = "settings"; },
      // This console has never held a workspace name of its own: the control plane mints it and the
      // relay answers it on GET /auth/state, which is where settings.js reads it. Left here as an
      // explicit null rather than omitted, so the next reader can see it was looked for, not missed.
      workspaceName: () => null,
      leadId: () => contextLead()?.id ?? null,
      leadName: () => contextLead()?.name ?? null,
      botCount: () => botCount(),
      botCap: () => agentCap(),
      askBefore: () => (state.settings.autoReview.block ?? []).join("\n"),
      localToolPermission: () => state.settings.localToolPermission ?? null,
      // The Plan group, which is what "How Titan answers" is drawn from. Empty on a console with no
      // plan, and pluginGroupSection's rule applies: no members, no row.
      planChoices: () => state.plugins.filter((plugin) => (plugin.group ?? "Connectors") === "Plan")
        .map((plugin) => ({ id: plugin.endpointId ?? plugin.id, name: plugin.name })),
      planCurrent: () => state.plugins.find((plugin) => (plugin.group ?? "Connectors") === "Plan" && plugin.status === "connected")?.endpointId ?? "",
      usePlanChoice: (endpointId) => Promise.resolve(adapter.setModel(null, endpointId)),
      openReport: () => openProblemReportCard(),
      runSelfTest: () => runSelfTest(),
      // The toast the reference raises at the top of the transcript while a computer updates.
      raiseUpdateToast: () => showToast("Updating Titan's computer. Transferring your data."),
      clearUpdateToast: () => {},
    },
  };

  // The badge's own control. Delegated at the document because the transcript is rebuilt wholesale
  // on every render, so a listener bound to a row would be thrown away with it.
  document.addEventListener("click", (event) => {
    const toggle = event.target.closest?.("[data-gap-toggle]");
    if (!toggle) return;
    window.__gapBadge?.toggle?.(toggle);
  });

  // Every route to a file: the desktop's Files list, and Open and Download on a transcript
  // attachment. One funnel, so a file cannot open one way from one list and another way from the
  // other -- which is the whole of what Jason reported on 2026-09-08.
  document.addEventListener("click", (event) => {
    const tile = event.target.closest?.("[data-file-open]");
    if (tile) {
      window.__filesViewer?.open?.({ path: tile.dataset.fileOpen, agentId: tile.dataset.fileAgent || null, name: tile.dataset.fileName || "" });
      return;
    }
    const open = event.target.closest?.("[data-attachment-open]");
    if (open) {
      window.__filesViewer?.open?.({ path: open.dataset.attachmentOpen, agentId: open.dataset.attachmentAgent || null, name: open.dataset.attachmentName || "" });
      return;
    }
    const download = event.target.closest?.("[data-attachment-download]");
    if (download) {
      window.__filesViewer?.open?.({ path: download.dataset.attachmentDownload, agentId: download.dataset.attachmentAgent || null, name: download.dataset.attachmentName || "", download: true });
    }
  });
  // ===== end CONSOLE-4 seam =====

  // HANDBACK-1: the two things about a hand-off a gate cannot see from the DOM. Reads only, no
  // writes, and nothing in the app calls them. `skipSupported` is here because the blocker it
  // catches is invisible on screen: a Skip that WORKED could turn Skip off for the rest of the
  // session, and every surface looked right afterwards because the step really had been skipped.
  // `screen` is here for the other one: which display the picture is actually of, next to the one
  // the desktop view opens.
  window.__machineRoomHandoff = {
    skipSupported: () => boxHandoffSkipSupported(),
    screen: () => {
      const lead = activeContext()?.kind === "worker" ? contextRecord() : null;
      const seat = boxHandoffSeatOf(lead);
      return {
        agentId: lead?.id ?? null,
        seat,
        caption: boxHandoffScreenCaption(lead, seat),
        readerDisplay: boxHandoffThumb?.display ?? null,
      };
    },
  };

  renderAll(false);
  renderDesktop("browser");
  resumeTeachMode();
  maybeOpenOnboarding();
  // FEEDBACK-1. The two build numbers a report has to carry, read once, and the box's own pending
  // file, which holds anything an agent wrote down while nobody had this page open. All three are
  // fire-and-forget: none of them may hold up the first paint, and a box too old for the pending
  // command simply has nothing to offer.
  loadConsoleBuild();
  loadHostBuild();
  // FEEDBACK-1b: the same drain the subscribe beat runs, so the first read and the watch share one
  // floor and the page does not ask the box twice in the first second. Then a standing beat, which
  // is the half the subscribe handler cannot cover: an idle console emits no events at all, so
  // without this a report written while the person is sitting still would wait for the next thing
  // that happened to change.
  watchPendingProblemReports();
  setInterval(() => { watchPendingProblemReports(); }, PENDING_BEAT_MS);
})();
