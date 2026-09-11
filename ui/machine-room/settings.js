/*
 * Settings, the whole surface (SETTINGS-2, docs/SETTINGS.md).
 * =========================================================
 * Jason, 2026-09-10, looking at what shipped: "this modal in the center, going down, does not make
 * a lot of sense. It's so busy, with so much stuff ... A user is never going to put a resend key in.
 * That's on the backend ... it's just supposed to be user-friendly and very simple. Now it's getting
 * to the point where you've got to be a developer to understand what's going on."
 *
 * Measured before anything was written, on grok-bot-local-vm at 1440x900: ONE dialog, 10 sections,
 * 6936 px of scroll at 1440x900 and 11332 px at 390x844, 90 controls, 4 password fields, 8 of 23
 * rows and 5 of 10 headings carrying a word a customer has no business reading. This file replaces
 * that with the shape the original product uses: a wide panel, a left nav, one section at a time,
 * and every row a label, one explanation line and ONE control.
 *
 * FOUR RULES, and each of them is a test rather than a habit:
 *
 *   1. A customer's settings hold only choices about their own workspace, in plain words. No
 *      customer-visible label or line may carry key, token, secret, endpoint, relay, proxy, webhook
 *      or a vendor name. Pinned by tests/machine-room-settings.test.mjs over the pure row
 *      definitions below and swept again on the live page by scripts/verify-settings.mjs.
 *   2. Keys the product uses belong to the operator and live in the super admin console. Nothing on
 *      this surface is a key field. The operator's own section says where they are instead.
 *   3. The surface is a wide panel with a left nav -- a full-height sheet on a phone -- and never a
 *      stack of ten cards in the middle of the screen.
 *   4. Nothing is lost. Every capability the old panel held still works; what a customer must never
 *      see moved into OPERATOR, which app.js still draws with settingsPanel(). docs/SETTINGS.md
 *      section 2 is the row-by-row map.
 *
 * HOW IT GETS ON SCREEN, and why there is no second dialog. renderMarketplacePanel is the
 * precedent (app.js): openPanel() ONCE, then a shell that owns its own body and swaps it. So this
 * module calls __mrUi.openPanel("Your workspace", "Settings", shell) and then paints one section at
 * a time into [data-settings-body]. The dialog is sized by settings.css through the .is-settings
 * class this file puts on it, which is the push-settings.css precedent of a module owning its sheet:
 * styles.css is not touched.
 *
 * THE MOUNT CONTRACT, which is what stops a sibling module painting into a section nobody is
 * looking at:
 *
 *   - ONLY the Notifications body carries [data-push-mount], and push-settings.js aims at that
 *     attribute, so it finds Notifications and nowhere else. The class .settings-list, which that
 *     module used to mount on, belongs to the OPERATOR stack and to no body this file draws: it is
 *     the selector voice.js hunts for, and a customer body carrying it would take the Voice card onto
 *     a customer's screen. Two slots, one each, and neither can land on the other's section. Its
 *     observer watches #panel-content's own children and a body swap is two levels below that, so
 *     this file calls the module's own public mount() after painting that section -- the same
 *     function, the same idempotence guard, no second card when the observer fires too.
 *   - Every section paint dispatches document CustomEvent "titanbot:settings-section"
 *     {detail:{id, host}}. backgrounds.js listens for it and mounts its tile grid into
 *     General -> Appearance. It used to key on the panel's TITLE, which this wave renames, and the
 *     picker would have vanished with no error and no test.
 *
 * WHAT THIS FILE NEVER DOES: it holds no credential, it reads no secret, and it writes nothing the
 * adapter or the relay does not already expose. Absent, the console boots exactly as before and
 * app.js falls back to the panel that shipped -- a gate leg, not a claim.
 */
(function attachSettings(global) {
  "use strict";

  // ---- the seams this file reads, all of them lazily ---------------------------------------------
  const ui = () => global.__mrUi ?? {};
  const host = () => ui().settingsHost ?? {};
  const adapter = () => global.__machineRoomAdapter ?? null;
  const voice = () => global.__voice ?? null;
  const doc = () => global.document ?? null;

  const esc = (value) => (ui().escapeHtml ?? ((v) => String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")))(value);
  const toast = (words) => { const say = ui().showToast; if (typeof say === "function") say(words); };

  // Same-origin, the session the page already holds, and a bound timeout: a route that never answers
  // must cost one absent row rather than a surface that never paints.
  async function ask(method, pathname, body) {
    const response = await global.fetch(pathname, {
      method,
      headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: global.AbortSignal?.timeout ? global.AbortSignal.timeout(12000) : undefined,
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) throw new Error(String(parsed?.message ?? parsed?.error ?? `answered ${response.status}`));
    return parsed ?? {};
  }

  // ================================================================================================
  // THE PURE HALF. Everything from here to the markup banner is a function of facts and nothing
  // else: no document, no fetch, no adapter. It is what the unit test walks.
  // ================================================================================================

  // The words a customer's own rows may never carry, and the vendor names that go with them. A key
  // is "a key the product uses", and only on the operator's side; a vendor's name is the operator's
  // word, not the customer's.
  const BANNED_WORDS = ["key", "keys", "token", "tokens", "secret", "secrets", "endpoint", "endpoints", "relay", "proxy", "webhook"];
  const BANNED_VENDORS = ["resend", "openai", "xai", "anthropic", "z.ai", "glm", "grok", "firebase", "apns", "coolify", "s3", "github", "slack", "browser-use"];
  const BANNED = new RegExp(`\\b(?:${[...BANNED_WORDS, ...BANNED_VENDORS].map((word) => word.replace(/\./g, "\\.")).join("|")})\\b`, "i");

  // ---- the registry other modules build against --------------------------------------------------
  //
  // A contributed row is a row like any other: a label, at most one grey line and exactly one
  // control, put into a named section and group by the module that owns its behaviour. This is what
  // replaces three separate MutationObservers hunting for a panel by its TITLE -- the failure mode
  // that would have deleted the background picker silently the moment this wave renamed the panel.
  //
  // register({id, section, group, order, markup, fill, operatorOnly}) is idempotent by id, so a
  // module that registers on every load, or twice, ends up with one row. markup() returns the row's
  // inner HTML; fill(root) is called with the painted section body after every paint of that
  // section, which is how a live value gets in. A contributor whose section is not on screen is not
  // filled, because there is nothing to fill.
  const CONTRIBUTORS = new Map();

  function register(entry) {
    if (entry == null || typeof entry.id !== "string" || entry.id.length === 0) return false;
    CONTRIBUTORS.set(entry.id, {
      id: entry.id,
      section: typeof entry.section === "string" ? entry.section : "general",
      group: typeof entry.group === "string" ? entry.group : null,
      order: Number.isFinite(entry.order) ? entry.order : 100,
      markup: typeof entry.markup === "function" ? entry.markup : () => "",
      fill: typeof entry.fill === "function" ? entry.fill : null,
      operatorOnly: entry.operatorOnly === true,
    });
    // Registered while its own section is on screen: repaint, so a module that loads late is not
    // invisible until the person navigates away and back.
    if (shown() === (typeof entry.section === "string" ? entry.section : "general")) paint(current, null);
    return true;
  }

  const contributorsFor = (sectionId, groupId, isOperator) => [...CONTRIBUTORS.values()]
    .filter((one) => one.section === sectionId && one.group === groupId && (one.operatorOnly !== true || isOperator === true))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  /** One contributed row, wrapped the way every other row on this surface is wrapped. */
  const contributedRow = (one) =>
    `<div class="setting-row" data-setting-row="${esc(one.id)}" data-settings-contributed="${esc(one.id)}">${one.markup()}</div>`;

  /**
   * Every contributed row of one section, in the order it will be drawn. The id list is what tells a
   * repaint whether the SET of rows changed, which is the only thing that may rebuild a mounts
   * section's contributed container.
   */
  const contributedFor = (section, isOperator) => (section.groups ?? [])
    .flatMap((group) => contributorsFor(section.id, group.id, isOperator));

  /**
   * VOICE-8. THE CONTRIBUTED GROUPS OF A SECTION WHOSE BODY BELONGS TO SOMEBODY ELSE.
   *
   * Notifications is push-settings.js's and Operator is app.js's, and both are painted as empty shells
   * this file never rebuilds while they are on screen. So a sibling module's rows cannot go inside
   * them: they go in a container of their own, immediately after the owner's, in the same group-and-card
   * shape as every other row on this surface. The owner's markup stays byte-identical, which is what
   * keeps app.js's own controls and every gate that reads them untouched.
   *
   * Empty when nothing is contributed, so a section nobody has registered a row on draws exactly what
   * it drew before -- no stray heading, no empty card.
   */
  function contributedMarkup(section, facts_) {
    const isOperator = facts_?.operator === true;
    const groups = (section.groups ?? []).map((group) => {
      const mine = contributorsFor(section.id, group.id, isOperator);
      if (mine.length === 0) return "";
      return `<div class="settings-group" data-settings-group="${esc(group.id)}">`
        + `<p class="settings-group-label">${esc(group.label)}</p>`
        + `<div class="settings-card">${mine.map(contributedRow).join("")}</div></div>`;
    }).join("");
    if (groups.length === 0) return "";
    return `<div class="settings-rows settings-contributed" data-settings-contributed-host="${esc(section.id)}">${groups}</div>`;
  }

  // The original's four, then the one this product adds, then the operator's. The order is the
  // screenshots' order and the nav draws it as given.
  const SECTIONS = [
    {
      id: "general", label: "General", icon: "◉",
      title: "General",
      subtitle: "Your account, how the console looks, and what your assistant is called.",
      keywords: ["account", "sign out", "email", "theme", "dark", "light", "language", "background", "picture", "microphone", "talk", "name"],
      groups: [
        { id: "account", label: "Account" },
        { id: "appearance", label: "Appearance" },
        { id: "system", label: "System" },
        { id: "bot", label: "Bot" },
      ],
    },
    {
      id: "computer", label: "Computer", icon: "▣",
      title: "Computer",
      subtitle: "The computer your assistants share.",
      keywords: ["computer", "files", "tasks", "review", "ask me before", "answers", "model"],
      groups: [{ id: "computers", label: "Computers" }],
    },
    {
      id: "usage", label: "Usage & Billing", icon: "◷",
      title: "Usage & Billing",
      subtitle: "What this workspace has used, and who to ask about the bill.",
      keywords: ["usage", "minutes", "plan", "billing", "invoice", "spend"],
      groups: [{ id: "usage", label: "Usage" }, { id: "plan", label: "Manage plan" }],
    },
    {
      id: "updates", label: "Updates", icon: "↑",
      title: "Updates",
      subtitle: "The console you are using, and the computer your assistants share.",
      keywords: ["update", "version", "upgrade"],
      groups: [{ id: "console", label: "Titanium Bot updates" }, { id: "box", label: "Titan's computer" }],
    },
    {
      id: "notifications", label: "Notifications", icon: "◔",
      title: "Notifications",
      subtitle: "What wakes your phone, and the devices that get it.",
      keywords: ["notifications", "quiet hours", "quiet", "phone", "devices", "alerts", "badge"],
      // Drawn by push-settings.js into the one body that carries [data-push-mount]. No rows of its own.
      mounts: "push",
      groups: [],
    },
    {
      id: "operator", label: "Operator", icon: "⚙",
      title: "Operator",
      subtitle: "Everything technical. Only you see this section.",
      keywords: ["operator", "technical", "job bus", "mail", "host", "providers", "answering"],
      operatorOnly: true,
      // Drawn by app.js's settingsPanel(), unchanged in behaviour. No rows OF ITS OWN -- and since
      // VOICE-8 one group for the rows a sibling module contributes, which is the only reason this
      // array is not empty. The contributed groups are painted BESIDE app.js's stack and never inside
      // it: that stack is somebody else's markup, and the one rule a mounts section has is that its
      // owner's body is not rebuilt under them.
      mounts: "operator",
      groups: [{ id: "talking", label: "Talking" }],
    },
  ];

  /** The nav, for this person. Fail closed: an identity nobody could read is not the operator. */
  const sectionsFor = (isOperator) => SECTIONS.filter((section) => section.operatorOnly !== true || isOperator === true);

  const sectionById = (id) => SECTIONS.find((section) => section.id === id) ?? null;

  // One control per row, and the kind says which. `machine: true` marks a value the MACHINE supplied
  // rather than words the product wrote -- a model id, a plan name, a version -- so the banned-word
  // sweep reads the copy it is about and never fails on a name a vendor chose.
  const pill = (text, machine = true) => ({ kind: "pill", text, machine });
  const toggle = (on, options = {}) => ({ kind: "switch", on: on === true, disabled: options.disabled === true, action: options.action });
  const choose = (value, options, action) => ({ kind: "select", value, options, action });
  const press = (text, options = {}) => ({ kind: "button", text, variant: options.variant ?? "ghost", disabled: options.disabled === true, action: options.action, armed: options.armed === true });

  /**
   * Every row of one section, in order, as data.
   *
   * A fact the machine could not answer OMITS its row rather than drawing a zero or the words "not
   * set": the PROXY-1 precedent. `facts` is whatever readFacts() could gather, and every field on it
   * is optional.
   */
  function rowsFor(id, facts = {}) {
    const f = facts ?? {};
    const rows = [];
    const add = (row) => { if (row != null) rows.push(row); };

    if (id === "general") {
      // Sign out is drawn only where signing out means something: the relay says whether this
      // install has a password at all, and on a loopback console it does not.
      if (f.passwordConfigured === true) {
        add({ id: "sign-out", group: "account", label: "Sign out", line: "Signs this browser out of your workspace.", control: press("Sign out", { action: "sign-out" }) });
      }
      if (Array.isArray(f.devices)) {
        add({
          id: "devices", group: "account",
          label: "Devices signed in",
          line: "Phones and computers that stay signed in. Revoke one and it has to sign in again.",
          control: {
            kind: "list",
            empty: "Only this browser is signed in.",
            items: f.devices.map((device) => ({ id: device.id, label: device.name, line: device.detail, button: "Revoke", action: "revoke-device" })),
          },
        });
      }
      add({
        id: "theme", group: "appearance",
        label: "Theme",
        line: "Light, dark, or whatever this device is set to.",
        control: choose(f.theme ?? "system", [
          { value: "system", label: "Follow system" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ], "theme"),
      });
      add({
        id: "language", group: "appearance",
        label: "Language",
        line: "English for now. More are coming.",
        // Disabled and honest. The reference product has the row; an empty promise would be worse
        // than a row that says what it is.
        control: choose("en", [{ value: "en", label: "English" }], null),
      });
      add({
        id: "background", group: "appearance",
        label: "Background",
        line: "The picture behind your conversations.",
        // backgrounds.js fills this on titanbot:settings-section. One control slot, one module.
        control: { kind: "mount", mount: "background" },
      });
      if (Array.isArray(f.microphones)) {
        add({
          id: "microphone", group: "system",
          label: "Microphone",
          line: "The microphone this browser uses when you press Talk.",
          control: choose(f.microphone ?? "", [{ value: "", label: "System default" },
            ...f.microphones.map((device) => ({ value: device.id, label: device.label, machine: true }))], "microphone"),
        });
      }
      // VOICE-7. HOW THE TALK BUTTON BEHAVES, which is the person's own choice and not the
      // workspace's. One row, one control, two choices in plain words. It is drawn wherever the voice
      // module is loaded, whether or not talking is switched on for the workspace: somebody who wants
      // to hold the button rather than toggle it should be able to say so before the first press.
      //
      // Remembered for the PERSON since VOICE-10, with this browser as the fallback: the voice module
      // writes its own stored copy first -- the button is live before any route answers -- and also puts
      // the value on the person's own key on /voice/settings, which is the same key the device list and
      // the notification settings use. The file there is still one per workspace; the choice inside it is
      // one per person, which is what stops two people sharing a workspace fighting over their own
      // button. docs/VOICE.md 13 says which half is which. This row reaches all of it through one door.
      if (f.talkMode != null) {
        add({
          id: "talk-mode", group: "system",
          label: "Talk mode",
          line: "How the Talk button works when you press it.",
          control: choose(f.talkMode, [
            { value: "push", label: "Push to talk: hold the button while you speak" },
            { value: "always", label: "Always listening: press once to start, press again to stop" },
          ], "talk-mode"),
        });
      }
      if (f.voice != null) {
        add({
          id: "voice", group: "system",
          label: "Let me talk to Titan",
          line: f.voice.available === true
            ? "Turn this on and the Talk button beside the message box works."
            : "Your operator has not switched talking on yet.",
          control: toggle(f.voice.enabled === true, { disabled: f.voice.available !== true, action: "voice" }),
        });
      }
      // NO hardware-acceleration row. This console is a web page and has no such setting; the
      // reference's row is a desktop-app fact. docs/SETTINGS.md says so, so nobody re-adds it.
      if (f.botName != null) {
        add({
          id: "bot-name", group: "bot",
          label: "Titan's name",
          line: "What your assistant is called, everywhere in the product.",
          control: { kind: "text", value: f.botName, placeholder: "Titan", save: "Save", action: "bot-name" },
        });
      }
      if (f.botEmail) {
        add({
          id: "bot-email", group: "bot",
          label: "Titan's email address",
          line: "Send him an email and he reads it. He replies from this address.",
          control: { kind: "copy", text: f.botEmail, machine: true, action: "copy-bot-email" },
        });
      }
      if (Number.isFinite(f.botCount) && Number.isFinite(f.botCap)) {
        add({
          id: "bots", group: "bot",
          label: "Bots",
          line: "Ask your operator if you need more.",
          control: pill(`${f.botCount} of ${f.botCap}`),
        });
      }
      return rows;
    }

    if (id === "computer") {
      if (f.boxName) {
        add({
          id: "box", group: "computers",
          label: "Titan's computer",
          line: "This is the computer your assistants share.",
          control: pill(f.boxRunning === false ? `${f.boxName} · asleep` : `${f.boxName} · running`),
        });
      }
      if (f.localToolPermission != null) {
        // source/shared/local-tool-permission.ts exports exactly these three with default "ask", and
        // source/host/host-gateway-api.ts takes localToolPermission on setHostSettings. The console
        // has never been able to SET it -- it drew a read-only pill.
        add({
          id: "execution", group: "computers",
          label: "Execution on this computer",
          line: f.localToolCapped === true
            ? "Let Titan open files and run tasks on this computer. Auto-review still checks everything first. Your operator caps this at Ask every time."
            : "Let Titan open files and run tasks on this computer. Auto-review still checks everything first.",
          control: choose(f.localToolPermission, [
            { value: "always", label: "Always allow" },
            { value: "ask", label: "Ask every time" },
            { value: "never", label: "Never allow" },
          ], "local-tool"),
        });
      }
      if (f.askBefore != null) {
        add({
          id: "ask-before", group: "computers",
          label: "Ask me before…",
          line: "The things Titan checks with you first.",
          control: { kind: "textarea", value: f.askBefore, placeholder: "e.g. sending email, deleting anything, spending money", save: "Save", action: "ask-before" },
        });
      }
      // Drawn ONLY where the plan group has members. pluginGroupSection's own rule: a heading over an
      // empty box is a promise with nothing behind it, and on a console with no plan there is none.
      if (Array.isArray(f.planChoices) && f.planChoices.length > 0) {
        add({
          id: "answers", group: "computers",
          label: "How Titan answers",
          line: "The model your plan already pays for.",
          control: choose(f.planCurrent ?? "", f.planChoices.map((choice) => ({ value: choice.id, label: choice.name, machine: true })), "plan-model"),
        });
      }
      return rows;
    }

    if (id === "usage") {
      if (f.voiceMinutes != null) {
        add({
          id: "voice-minutes", group: "usage",
          label: "Talking time today",
          line: "Minutes of spoken conversation used today.",
          // The call ceiling travels with the day pair, because the old card said both on one line
          // and a person reading "4 of 30 minutes" has no way to know a single call also ends (VOICE-8).
          control: {
            kind: "meter", used: f.voiceMinutes.used, cap: f.voiceMinutes.cap, machine: true,
            text: `${f.voiceMinutes.used} of ${f.voiceMinutes.cap} minutes${Number.isFinite(f.voiceMinutes.perCall) ? `, up to ${f.voiceMinutes.perCall} in one call` : ""}`,
          },
        });
      }
      if (f.codingMinutes != null) {
        add({
          id: "coding-minutes", group: "usage",
          label: "Coding time this month",
          line: "Minutes of cloud coding used this month.",
          // A bar needs two numbers. With no monthly ceiling on this product the honest control is the
          // figure itself; the bar appears the day a ceiling does.
          control: Number.isFinite(f.codingMinutes.cap)
            ? { kind: "meter", used: f.codingMinutes.used, cap: f.codingMinutes.cap, text: `${f.codingMinutes.used} of ${f.codingMinutes.cap} minutes`, machine: true }
            : pill(`${f.codingMinutes.used} minutes`),
        });
      }
      if (f.plan) {
        add({ id: "plan", group: "usage", label: "Your plan", line: "What this workspace is signed up for.", control: pill(f.plan) });
      }
      add({
        id: "billing", group: "plan",
        label: "Billing",
        line: "Your operator handles billing. Ask them to change your plan or send an invoice.",
        control: press("Manage billing", { action: "billing" }),
      });
      return rows;
    }

    if (id === "updates") {
      add({
        id: "version", group: "console",
        label: "Version",
        line: f.updateAvailable === true
          ? `${f.version ?? "This console"}. A newer version is ready.`
          : f.updateAvailable === false
            ? `${f.version ?? "This console"}. You're up to date.`
            : `${f.version ?? "This console"}.`,
        control: press("Check for updates", { action: "check-updates" }),
      });
      // WHICH COMMAND THIS IS, because the two are easy to confuse and only one of them matches the
      // words on the row. It is updateBox -> updateForeverBox, the box SWAP: a fresh instance with
      // the same volume, which is exactly "your files and logins stay, but installed apps and
      // packages are removed". It is NOT updateHostNow, which moves the host bundle and which no
      // adapter in this console exposes; wiring that here would have been new gateway surface behind
      // a button whose copy describes something else.
      //
      // Enabled only when getHostStatus reports hostUpdateAvailable, so a box carrying a local patch
      // is never offered one: since cc2de54 a swap installs the bundle's own box-scripts and the
      // window repair patches that copy, so the swap is safe exactly when a newer bundle is what is
      // being swapped to. No customer Reset row -- a rebuild is BOX-6's own hazard, and the operator
      // keeps both of his on the Operator section.
      // THE SECOND PRESS NAMES WHAT IT DOES AND WHOSE IT IS. The armed state is not a quieter copy of
      // the same row: this control replaces the running computer for THIS workspace, nobody has ever
      // pressed it on a live tenant, and "Click Again to Confirm" on its own does not say which
      // computer is about to restart. So while it is armed the explanation line is the consequence,
      // with the workspace in it.
      add({
        id: "update-box", group: "box",
        label: "Update Titan's computer",
        line: f.updateArmed === true
          ? `Press again and the computer ${f.workspaceName ? `for ${f.workspaceName}` : "for this workspace"} is replaced with a fresh one and restarts. Your files and logins stay. Installed apps and packages are removed, and every assistant goes with it.`
          : "Updates the computer your assistants share. Your files and logins stay, but installed apps and packages are removed. All assistants update together.",
        control: press(f.updateArmed === true ? "Click Again to Confirm" : "Update", {
          variant: f.updateArmed === true ? "armed" : "ghost",
          disabled: f.updateAvailable !== true || f.canUpdateBox !== true,
          action: "update-box",
          armed: f.updateArmed === true,
        }),
      });
      return rows;
    }

    return rows;
  }

  /** The account menu at the foot of the roster, in the original's order. */
  function accountMenuRows(facts = {}) {
    const f = facts ?? {};
    const rows = [];
    if (f.updateAvailable === true) rows.push({ id: "update-banner", kind: "banner", label: "New update available", button: "Install", action: "install-update" });
    // NO PERCENTAGE. The original's row reads "Weekly usage 42%", a percentage OF A PLAN'S WEEKLY
    // ALLOWANCE, and this product has no plan allowance for anything to be a percentage of: no route
    // answers one and no ledger counts a week. The label carried a conditional for a field nothing
    // ever wrote, which is a promise with nothing behind it; the row opens Usage & Billing, where the
    // numbers that DO exist are drawn. The percentage comes back with the plan (row ME-PLAN-1).
    rows.push({ id: "usage", kind: "link", label: "Weekly usage", chevron: true, action: "open-usage" });
    rows.push({ id: "mobile", kind: "link", label: "Get the app for mobile", action: "get-the-app" });
    rows.push({ id: "support", kind: "submenu", label: "Support", chevron: true, items: [
      { id: "feedback", label: "Send feedback", action: "send-feedback" },
      { id: "self-test", label: "Run a self-test", action: "self-test" },
      { id: "about", label: "About", action: "about" },
    ] });
    rows.push({ id: "settings", kind: "link", label: "Settings", action: "open-settings" });
    rows.push({ id: "rule", kind: "rule" });
    // The same visibility rule the Sign out row follows: a log out that would do nothing is not drawn.
    if (f.passwordConfigured === true) rows.push({ id: "log-out", kind: "link", label: "Log out", action: "sign-out" });
    return rows;
  }

  /** Every label and line a customer can read, for the sweep. Operator rows are exempt by design. */
  function customerCopy(facts = {}) {
    const out = [];
    for (const section of sectionsFor(false)) {
      out.push({ where: `nav ${section.id}`, text: section.label });
      out.push({ where: `${section.id} title`, text: section.title });
      out.push({ where: `${section.id} subtitle`, text: section.subtitle });
      for (const group of section.groups) out.push({ where: `${section.id}/${group.id} label`, text: group.label });
      for (const row of rowsFor(section.id, facts)) {
        out.push({ where: `${section.id}/${row.id} label`, text: row.label });
        if (row.line) out.push({ where: `${section.id}/${row.id} line`, text: row.line });
        if (row.control?.kind === "button") out.push({ where: `${section.id}/${row.id} button`, text: row.control.text });
      }
    }
    for (const row of accountMenuRows(facts)) {
      out.push({ where: `account-menu/${row.id}`, text: row.label ?? "" });
      for (const item of row.items ?? []) out.push({ where: `account-menu/${row.id}/${item.id}`, text: item.label });
    }
    return out;
  }

  // ================================================================================================
  // THE MARKUP. Strings handed to innerHTML, the way every other panel on this console is built, so
  // the surface looks like its neighbours without a second stylesheet arguing with the first.
  // ================================================================================================

  const navButton = (section, active) =>
    `<button class="settings-nav-button${section.id === active ? " is-active" : ""}" type="button" role="tab"`
    + ` aria-selected="${section.id === active}" data-settings-nav="${esc(section.id)}">`
    + `<span class="settings-nav-icon" aria-hidden="true">${esc(section.icon)}</span><span>${esc(section.label)}</span></button>`;

  function shellMarkup(active, isOperator) {
    const entries = sectionsFor(isOperator);
    // data-settings-operator is part of the DOM contract the gates read: one attribute that says
    // which of the two surfaces this is, so a leg does not have to infer it from whether a nav entry
    // happens to be present.
    return `<div class="settings-surface" data-settings-surface data-settings-operator="${isOperator === true}">`
      + `<nav class="settings-nav" aria-label="Settings sections">`
      + `<label class="sr-only" for="settings-search">Search settings</label>`
      + `<input class="settings-search" id="settings-search" type="search" placeholder="Search settings" autocomplete="off" data-settings-search />`
      + `<div class="settings-nav-list" role="tablist">${entries.map((section) => navButton(section, active)).join("")}</div>`
      + `<p class="settings-nav-empty" data-settings-nav-empty hidden>Nothing here matches that.</p>`
      + `</nav>`
      + `<div class="settings-body" data-settings-body><header class="settings-head"><h2 data-settings-title></h2><p data-settings-subtitle></p></header></div>`
      + `</div>`;
  }

  function controlMarkup(row) {
    const control = row.control ?? {};
    const act = control.action ? ` data-settings-action="${esc(control.action)}"` : "";
    const machine = control.machine === true ? " data-machine-value" : "";
    if (control.kind === "pill") return `<div class="setting-control"><span class="status-pill"${machine}>${esc(control.text)}</span></div>`;
    if (control.kind === "switch") {
      return `<div class="setting-control"><button class="switch" type="button" aria-pressed="${control.on}"${control.disabled ? " disabled" : ""}${act}`
        + ` aria-label="${esc(row.label)}"></button></div>`;
    }
    if (control.kind === "select") {
      const options = (control.options ?? []).map((option) =>
        `<option value="${esc(option.value)}"${String(option.value) === String(control.value) ? " selected" : ""}${option.machine ? " data-machine-value" : ""}>${esc(option.label)}</option>`).join("");
      return `<div class="setting-control"><select aria-label="${esc(row.label)}"${control.action ? "" : " disabled"}${act}>${options}</select></div>`;
    }
    if (control.kind === "button") {
      const klass = control.variant === "primary" ? "primary-button"
        : control.variant === "danger" ? "danger-button"
          : control.variant === "armed" ? "ghost-button is-armed" : "ghost-button";
      return `<div class="setting-control"><button class="${klass}" type="button"${control.disabled ? " disabled" : ""}${act}>${esc(control.text)}</button></div>`;
    }
    if (control.kind === "text" || control.kind === "textarea") {
      const field = control.kind === "text"
        ? `<input type="text" value="${esc(control.value)}" placeholder="${esc(control.placeholder ?? "")}" aria-label="${esc(row.label)}" data-settings-value />`
        : `<textarea rows="3" placeholder="${esc(control.placeholder ?? "")}" aria-label="${esc(row.label)}" data-settings-value>${esc(control.value)}</textarea>`;
      return `<div class="setting-control setting-control-field">${field}<button class="ghost-button" type="button"${act}>${esc(control.save ?? "Save")}</button></div>`;
    }
    if (control.kind === "copy") {
      return `<div class="setting-control setting-control-field"><input type="text" readonly value="${esc(control.text)}" aria-label="${esc(row.label)}"${machine} data-settings-value />`
        + `<button class="ghost-button" type="button" aria-label="Copy ${esc(row.label)}"${act}>⧉</button></div>`;
    }
    if (control.kind === "meter") {
      const share = Number(control.cap) > 0 ? Math.min(100, Math.round((Number(control.used) / Number(control.cap)) * 100)) : 0;
      return `<div class="setting-control setting-control-meter"><span class="settings-meter" role="img" aria-label="${esc(control.text)}">`
        + `<span class="settings-meter-fill" style="width:${share}%"></span></span><small${machine}>${esc(control.text)}</small></div>`;
    }
    if (control.kind === "list") {
      const items = (control.items ?? []).map((item) =>
        `<div class="settings-subrow" data-settings-subrow="${esc(item.id)}"><div><strong>${esc(item.label)}</strong>${item.line ? `<small>${esc(item.line)}</small>` : ""}</div>`
        + `<button class="ghost-button" type="button" data-settings-action="${esc(item.action)}" data-settings-id="${esc(item.id)}">${esc(item.button)}</button></div>`).join("");
      return `<div class="setting-control setting-control-block">${items.length > 0 ? items : `<p class="settings-note">${esc(control.empty ?? "")}</p>`}</div>`;
    }
    if (control.kind === "mount") return `<div class="setting-control setting-control-block" data-settings-mount="${esc(control.mount)}"></div>`;
    return `<div class="setting-control"></div>`;
  }

  const rowMarkup = (row) =>
    `<div class="setting-row" data-setting-row="${esc(row.id)}">`
    + `<div><strong>${esc(row.label)}</strong>${row.line ? `<small>${esc(row.line)}</small>` : ""}</div>`
    + controlMarkup(row)
    + `</div>`;

  function accountHeaderMarkup(facts) {
    const initial = String(facts.workspaceName ?? "W").trim().slice(0, 1).toUpperCase();
    return `<div class="settings-identity" data-settings-identity>`
      + `<span class="settings-avatar" aria-hidden="true">${esc(initial)}</span>`
      + `<div><strong data-machine-value>${esc(facts.workspaceName ?? "This workspace")}</strong>`
      + (facts.email ? `<small data-machine-value>${esc(facts.email)}</small>` : "")
      + `</div>`
      + (facts.email ? `<button class="ghost-button" type="button" aria-label="Copy your email address" data-settings-action="copy-email">⧉</button>` : "")
      + `</div>`;
  }

  /**
   * BG-PICKER-1's SUB-VIEW. One module's whole body for one section: a back control that says where it
   * goes, a title, and markup that module drew. It carries data-settings-section like an ordinary body
   * so everything that asks "which section is on screen" keeps answering, and data-settings-subview so
   * a gate and paint() can tell the two apart.
   *
   * The background gallery is what this exists for: 18 tile faces in one row's control slot is the
   * busiest thing left on the surface, and a row should be a label, a line and one control. Behind a
   * Choose button the gallery becomes the whole body, which is also why settings.css's 300 px and
   * 220 px caps on the inline grid do not apply here -- in a sub-view the gallery IS the section.
   */
  function subviewMarkup(view, section) {
    return `<div class="settings-subview" data-settings-subview="${esc(view.id)}" data-settings-section="${esc(section.id)}">`
      + `<header class="settings-head settings-subview-head">`
      + `<button class="ghost-button settings-back" type="button" data-settings-back>`
      + `<span aria-hidden="true">&#8592;</span> Back to ${esc(section.title)}</button>`
      + `<h2 data-settings-title>${esc(view.title)}</h2>`
      + `</header>`
      + `<div class="settings-subview-body" data-settings-subview-body>${view.markup()}</div>`
      + `</div>`;
  }

  /** One section's body. The Notifications and Operator bodies are filled by their own owners. */
  function bodyMarkup(section, facts) {
    const head = `<header class="settings-head"><h2 data-settings-title>${esc(section.title)}</h2><p data-settings-subtitle>${esc(section.subtitle)}</p></header>`;
    if (section.mounts === "push") {
      // data-push-mount is the slot push-settings.js aims at, and it is the ONLY thing that decides
      // where that card lands. It is deliberately not the .settings-list class: that class belongs to
      // the OPERATOR body's stack of cards, which is what it has always described, and voice.js finds
      // its own card's home by exactly that selector. One class, one owner, two cards that cannot
      // land on each other's section.
      return head + `<div class="settings-rows" data-push-mount data-settings-section="${esc(section.id)}"></div>`
        + contributedMarkup(section, facts);
    }
    if (section.mounts === "operator") {
      const markup = typeof host().operatorMarkup === "function" ? host().operatorMarkup() : "";
      // BYTE-IDENTICAL, on purpose. app.js owns every control in here and the gates read them by id;
      // VOICE-8's four rows are the SIBLING below it and not a thing inserted into it.
      return head + `<div class="settings-rows settings-operator" data-settings-section="${esc(section.id)}">${markup}</div>`
        + contributedMarkup(section, facts);
    }
    const rows = rowsFor(section.id, facts);
    const groups = section.groups.map((group) => {
      const mine = rows.filter((row) => row.group === group.id);
      const header = group.id === "account" ? accountHeaderMarkup(facts) : "";
      const extra = contributorsFor(section.id, group.id, facts.operator === true).map(contributedRow).join("");
      if (mine.length === 0 && header === "" && extra === "") return "";
      return `<div class="settings-group" data-settings-group="${esc(group.id)}">`
        + `<p class="settings-group-label">${esc(group.label)}</p>`
        + `<div class="settings-card">${header}${mine.map(rowMarkup).join("")}${extra}</div></div>`;
    }).join("");
    return head + `<div class="settings-rows" data-settings-section="${esc(section.id)}">${groups}</div>`;
  }

  // ================================================================================================
  // THE LIVE HALF.
  // ================================================================================================

  let facts = {};
  let current = null;
  let armedUpdate = null;
  let wired = false;
  // BG-PICKER-1. The one sub-view that can be open, and the section it belongs to. Null almost always.
  let subview = null;

  // ---- SETTINGS-3: a read that started before a person's change may not paint over it -------------
  //
  // MEASURED on grok-bot-local-vm, real Chrome, 2026-09-10: at 390x844, with `always` stored, opening
  // Settings and choosing *Push to talk* the instant the sheet painted left the select reading `always`
  // in 10 of 10 runs while the voice module and this browser both read `push`. With a 2.5 s settle
  // first: 0 of 10. At 1440x900: 0 of 10 either way. So it is not a cache and not a wrong read -- it is
  // an ORDER. open() paints, then fires its own readFacts(); that read snapshots the live values
  // SYNCHRONOUSLY before its first await; the person changes a control while it is in flight; and when
  // it lands it repaints from its own older snapshot and puts the old value back under their hand. The
  // account menu's refresh 2.5 s after boot is a second, slower producer of the same paint.
  //
  // The fix is at the mechanism and not at the one row, because three rows were measured reverting
  // together (talk mode, theme and microphone) and a fourth writes through a route:
  //
  //   1. EVERY ACT THAT CHANGES A VALUE WRITES IT INTO THE FACTS. This is already this file's own habit
  //      -- act("update-box") sets facts.updateArmed before it paints -- and it makes the next paint,
  //      whoever triggers it, draw what the person chose.
  //   2. AND A GENERATION GUARD, so a read that STARTED before the change cannot undo step 1 when it
  //      lands. Each change takes the next number; readFacts remembers the number it started at and,
  //      before it publishes its snapshot, re-applies every change newer than that. A read that starts
  //      AFTER the change has no newer change to re-apply and the route's own answer wins, which is
  //      what has to happen for a value the relay is the authority on.
  //
  // refresh(id) -- the contributor form -- paints WITHOUT re-reading, so it was never a producer and
  // stays correct under this.
  const CHANGE_LOG = [];
  const CHANGE_LOG_MAX = 32;
  let changeSeq = 0;

  /** A value the person just changed: into the facts now, and into the log so a late read cannot win. */
  function noteChange(key, value) {
    changeSeq += 1;
    facts = { ...facts, [key]: value };
    CHANGE_LOG.push({ seq: changeSeq, key, value });
    if (CHANGE_LOG.length > CHANGE_LOG_MAX) CHANGE_LOG.splice(0, CHANGE_LOG.length - CHANGE_LOG_MAX);
    return value;
  }

  const panel = () => doc()?.getElementById("panel-content") ?? null;
  const surface = () => panel()?.querySelector("[data-settings-surface]") ?? null;
  const dialog = () => doc()?.getElementById("panel-dialog") ?? null;

  const PLATFORM_WORDS = { ios: "iPhone or iPad", android: "Android phone", desktop: "Desktop app" };
  const when = (ms) => { const at = Number(ms); if (!Number.isFinite(at) || at <= 0) return ""; try { return new Date(at).toLocaleDateString(); } catch { return ""; } };
  const deviceDetail = (device) => [PLATFORM_WORDS[device.platform] ?? String(device.platform ?? ""), when(device.createdAt) ? `added ${when(device.createdAt)}` : ""]
    .filter((part) => part.length > 0).join(" · ");

  // A label per microphone needs permission in most browsers. Asked for, never demanded: a list of
  // unlabelled devices is worse than the row not being drawn, so an empty or label-less list omits it.
  async function readMicrophones() {
    try {
      const devices = await global.navigator?.mediaDevices?.enumerateDevices?.();
      const mics = (devices ?? []).filter((device) => device.kind === "audioinput" && String(device.label ?? "").length > 0);
      return mics.length > 0 ? mics.map((device) => ({ id: device.deviceId, label: device.label })) : null;
    } catch { return null; }
  }

  /** Everything the surface can know, gathered once per open. Every read degrades on its own. */
  async function readFacts() {
    // SETTINGS-3. The number this read was born at. Everything the person changes from here until it
    // lands is newer than this snapshot and wins over it.
    const bornAt = changeSeq;
    const api = adapter();
    const h = host();
    const next = {
      operator: null,
      passwordConfigured: doc()?.getElementById("logout-button")?.hidden === false,
      theme: currentTheme(),
      workspaceName: typeof h.workspaceName === "function" ? h.workspaceName() : null,
      botCount: typeof h.botCount === "function" ? h.botCount() : null,
      botCap: typeof h.botCap === "function" ? h.botCap() : null,
      botName: typeof h.leadName === "function" ? h.leadName() : null,
      askBefore: typeof h.askBefore === "function" ? h.askBefore() : null,
      localToolPermission: typeof h.localToolPermission === "function" ? h.localToolPermission() : null,
      planChoices: typeof h.planChoices === "function" ? h.planChoices() : null,
      planCurrent: typeof h.planCurrent === "function" ? h.planCurrent() : null,
      canUpdateBox: typeof api?.updateBox === "function",
      updateArmed: armedUpdate != null,
      microphone: typeof voice()?.micDeviceId === "function" ? voice().micDeviceId() : "",
      // VOICE-7. Read from the voice module rather than from a route, because this one is the
      // browser's own. A console without the module draws no row at all, the PROXY-1 rule.
      talkMode: typeof voice()?.talkMode === "function" ? voice().talkMode() : null,
    };

    const reads = [];
    // WHO IS LOOKING. Never a page heuristic: "the job bus adapter method exists" is a customer one
    // deploy away from the operator's rows. GET /auth/state answers it server-side -- the relay is
    // the only thing that can tell an operator from a customer -- and an answer with no operator
    // field, or none at all, draws no Operator section whatsoever. ABSENT MEANS FALSE.
    // WHAT THIS ONE READ IS. getWorkspaceIdentity is GET /auth/state merged with GET /me: the session
    // half says who is looking, the below-the-gate half counts what this workspace has used. Reading
    // only the session half is what left the usage rows undrawable, so a field arriving here is a
    // field one of those two routes actually answers, and nothing else is read off it.
    if (typeof api?.getWorkspaceIdentity === "function") {
      reads.push(Promise.resolve(api.getWorkspaceIdentity()).then((me) => {
        if (me == null) return;
        next.operator = me.operator === true;
        // /auth/state already carries whether a password is configured at all, which is a better
        // source for the Sign out row than reading another control's hidden flag off the page.
        if (typeof me.required === "boolean") next.passwordConfigured = me.required;
        if (me.workspace?.name) next.workspaceName = me.workspace.name;
        // The computer is the workspace's, and the control plane is what mints its name. There is no
        // other name for it on this console, which is why the row is omitted where the session answer
        // carries no workspace rather than being given one this page made up.
        if (me.workspace?.slug || me.workspace?.name) next.boxName = me.workspace.slug ?? me.workspace.name;
        if (me.person?.email) next.email = me.person.email;
        // No route on this relay names a plan, so this row is drawn on a field nothing answers yet and
        // is the one thing here waiting on plumbing rather than on a read (row ME-PLAN-1).
        if (me.plan) next.plan = me.plan;
        if (Number.isFinite(me.botCap) && me.botCap > 0) next.botCap = me.botCap;
        // MERGED, not replaced: the voice module's own read arrives on the same Promise.all and is the
        // only one carrying the per-call ceiling, and whichever of the two lands second must not wipe
        // what the other knew.
        if (Number.isFinite(me.voiceMinutesToday) && Number.isFinite(me.voiceMinutesCap)) {
          next.voiceMinutes = { ...(next.voiceMinutes ?? {}), used: me.voiceMinutesToday, cap: me.voiceMinutesCap };
        }
        // A MONTH'S CODING MINUTES WITH NO CEILING, and that is not an omission. Nothing on this
        // product caps coding by the month -- cp/code.mjs caps one TASK's wall clock and nothing else
        // -- so the row is a figure rather than a bar, and it becomes a bar the day a monthly ceiling
        // exists. Requiring a cap here is what kept the row off the screen while the minutes were
        // being counted.
        if (Number.isFinite(me.codingMinutesThisMonth)) {
          next.codingMinutes = { used: me.codingMinutesThisMonth, cap: Number.isFinite(me.codingMinutesCap) ? me.codingMinutesCap : null };
        }
      }).catch(() => {}));
    }
    if (typeof api?.getHostStatus === "function") {
      reads.push(Promise.resolve(api.getHostStatus()).then((status) => {
        next.version = status?.hostVersion ?? null;
        next.updateAvailable = status?.hostUpdateAvailable ?? null;
        // The host answered, so the computer is up. Said as a pill rather than a claim about
        // anything the console cannot see.
        next.boxRunning = true;
      }).catch(() => { next.boxRunning = false; }));
    }
    if (typeof api?.getLocalToolPermission === "function") {
      reads.push(Promise.resolve(api.getLocalToolPermission()).then((answer) => {
        if (answer?.value != null) next.localToolPermission = answer.value;
        if (answer?.capped === true) next.localToolCapped = true;
      }).catch(() => {}));
    }
    // The bot's own address, and only when mail is switched on for this workspace. The row is about
    // where a person writes to him, not about how the mail plane is configured.
    if (typeof api?.getMailSettings === "function") {
      reads.push(Promise.resolve(api.getMailSettings()).then((mail) => {
        if (mail?.enabled !== true) return;
        const lead = typeof h.leadName === "function" ? h.leadName() : null;
        const rows = Array.isArray(mail.addresses) ? mail.addresses : [];
        const mine = rows.find((row) => row.name === lead) ?? rows[0] ?? null;
        if (mine?.address) next.botEmail = mine.address;
      }).catch(() => {}));
    }
    reads.push(ask("GET", "/auth/devices").then((answer) => {
      next.devices = (answer.devices ?? []).filter((device) => device.revokedAt == null).map((device) => ({
        id: device.id,
        name: String(device.name ?? "").trim() || PLATFORM_WORDS[device.platform] || "A signed-in device",
        detail: deviceDetail(device),
      }));
    }).catch(() => {}));
    // Talking, from the module that owns it. Absent module, absent row.
    const v = voice();
    if (v != null && typeof v.getSettings === "function") {
      reads.push(Promise.resolve(v.getSettings()).then((answer) => {
        if (answer == null) return;
        next.voice = { enabled: answer.enabled === true, available: answer.available === true };
        if (Number.isFinite(answer.minutesUsedToday) && Number.isFinite(answer.minutesCapToday)) {
          next.voiceMinutes = {
            used: answer.minutesUsedToday,
            cap: answer.minutesCapToday,
            // How long ONE call may run, which the old card said beside the day pair and nothing said
            // after it was replaced (VOICE-8). Absent where this workspace has no per-call ceiling.
            perCall: Number.isFinite(answer.minutesCapPerCall) ? answer.minutesCapPerCall : null,
          };
        }
      }).catch(() => {}));
    }
    if (v != null && v.supportsMicChoice === true) reads.push(readMicrophones().then((list) => { if (list != null) next.microphones = list; }));

    await Promise.all(reads);
    // SETTINGS-3. A person changed something while these reads were in flight, so this snapshot is
    // older than what is on screen: those fields keep the value they were given rather than being
    // painted over with the one this read started with.
    for (const one of CHANGE_LOG) if (one.seq > bornAt) next[one.key] = one.value;
    facts = next;
    return facts;
  }

  // ---- the theme, which nothing persisted before this file ---------------------------------------
  //
  // FOLLOW SYSTEM IS A CHOICE, NOT THE DEFAULT. index.html ships data-theme="dusk" and this console
  // has always come up dark; making "system" the default would have flipped it to light for
  // everybody whose machine is set light, which nobody asked for. So with nothing stored, the theme
  // is whatever the page already carries and the row simply reads it back.
  const THEME_KEY = "titanbot.theme";
  const storedTheme = () => { try { return global.localStorage?.getItem(THEME_KEY) ?? null; } catch { return null; } };
  const systemDark = () => global.matchMedia?.("(prefers-color-scheme: dark)")?.matches !== false;
  const currentTheme = () => storedTheme() ?? (doc()?.documentElement?.dataset?.theme === "mist" ? "light" : "dark");
  function applyTheme(choice) {
    const root = doc()?.documentElement;
    if (root == null) return;
    const dark = choice === "dark" || (choice === "system" && systemDark());
    root.dataset.theme = dark ? "dusk" : "mist";
    try { global.localStorage?.setItem(THEME_KEY, choice); } catch { /* a private window is not a fault */ }
  }

  // ---- painting ----------------------------------------------------------------------------------

  /**
   * VOICE-8. The one thing a repaint may change on a section whose body belongs to somebody else.
   *
   * The owner's markup is never touched. The contributed container beside it is rebuilt ONLY when the
   * set of rows in it is not the set that should be there -- a module registering late, an operator
   * fact arriving and making an operatorOnly row eligible -- and left alone on every other paint, so a
   * field somebody is typing into is not taken out of their hands by the account menu's own refresh.
   */
  function syncContributed(body, section) {
    const wanted = contributedFor(section, facts.operator === true).map((one) => one.id);
    const standing = body.querySelector(`[data-settings-contributed-host="${section.id}"]`);
    const have = standing == null ? [] : [...standing.querySelectorAll("[data-settings-contributed]")]
      .map((node) => node.dataset.settingsContributed);
    if (have.join("|") === wanted.join("|")) return false;
    if (standing != null) standing.remove();
    if (wanted.length === 0) return true;
    const anchor = body.querySelector(`[data-settings-section="${section.id}"]`);
    if (anchor == null) return false;
    anchor.insertAdjacentHTML("afterend", contributedMarkup(section, facts));
    return true;
  }

  function paint(sectionId, rowId) {
    const shell = surface();
    const body = shell?.querySelector("[data-settings-body]");
    const section = sectionById(sectionId) ?? SECTIONS[0];
    if (body == null) return false;
    if (section.operatorOnly === true && facts.operator !== true) return paint("general", null);
    current = section.id;
    // A SECTION WHOSE BODY BELONGS TO ANOTHER MODULE IS NOT REBUILT WHILE IT IS ON SCREEN, and this
    // is a correctness rule rather than a saving. Notifications and Operator are empty shells that
    // push-settings.js and app.js fill; throwing the shell away and mounting a fresh card throws away
    // whatever the person had flipped or typed and NOT YET SAVED, and puts the stored value back
    // under their hands with no sign anything happened. Measured on grok-bot-local-vm at 390x844,
    // real Chrome, 2026-09-10: the account menu's own read of the facts 2.5 s after boot repainted
    // the open section, and a notification switch turned off a moment earlier came back on and saved
    // as on. Their fills below run either way, so live values still land -- fillEndpoints, fillJobBus
    // and fillMail have always written into a card that was already there.
    // BG-PICKER-1. A SUB-VIEW IS NOT REBUILT WHILE IT IS ON SCREEN either, and for the same reason the
    // two mounts shells are not: it is another module's body, and throwing it away takes whatever the
    // person was doing in it with no sign anything happened. Measured on grok-bot-local-vm at 390x844:
    // account-menu.js calls refresh() 2.5 s after boot, refresh() calls paint(), and paint() rebuilds
    // every body that is not already somebody's -- which is the same mechanism that was caught putting
    // a stored notification switch back under a person's hand. A sub-view belongs to ONE section, so a
    // paint of any other section ends it.
    if (subview != null && subview.section !== section.id) subview = null;
    const standing = body.querySelector(`[data-settings-section="${section.id}"]`);
    const keep = section.mounts != null && standing != null;
    // BG-PICKER-1 and VOICE-8 meet on this one branch, so the three cases are spelled out in order.
    // A sub-view that is already on screen is left alone; otherwise it is drawn. With no sub-view up,
    // an ordinary body is rebuilt, and an owner's body is kept -- in which case the rows OTHER modules
    // contributed to it are reconciled on their own, and only when the SET of them changed, never
    // merely because a repaint happened. A module that registers while its section is already open
    // gets its markup here; a repaint a second later leaves a half-typed field where the person left it.
    if (subview != null) {
      if (body.querySelector(`[data-settings-subview="${subview.id}"]`) == null) body.innerHTML = subviewMarkup(subview, section);
    } else if (!keep) body.innerHTML = bodyMarkup(section, facts);
    else syncContributed(body, section);
    for (const button of shell.querySelectorAll("[data-settings-nav]")) {
      const active = button.dataset.settingsNav === section.id;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    if (subview != null) {
      // The owner's fill, exactly as a mounts shell gets one, and nothing else: the contributed rows,
      // the mount slots and the section event all belong to the section body, which is not on screen.
      try { subview.fill?.(body.querySelector("[data-settings-subview-body]") ?? body); }
      catch { /* one sub-view short beats a blank body */ }
      return true;
    }
    const mount = body.querySelector(`[data-settings-section="${section.id}"]`);
    // Where the contributed rows really are. On an ordinary section that is inside the body's own
    // [data-settings-section] and `mount` is it; on a mounts section the owner's body is somebody
    // else's and the contributed rows are the container beside it, so a fill handed `mount` would be
    // handed a root its own controls are not in. That is the difference between a row that fills and a
    // row that is drawn and never gets a value.
    const contributedHost = body.querySelector(`[data-settings-contributed-host="${section.id}"]`);
    // The two bodies their owners fill. Notifications through push-settings.js's own public mount --
    // its observer watches #panel-content's children and a body swap is two levels below that -- and
    // Operator through app.js, which still owns every control on it.
    if (section.mounts === "push") global.__pushSettings?.mount?.(panel());
    if (section.mounts === "operator" && typeof host().operatorFill === "function") host().operatorFill();
    // And every contributed row on this section, with the body that was just painted. A fill that
    // throws is that module's problem and must not take the section down with it.
    for (const one of CONTRIBUTORS.values()) {
      if (one.section !== section.id || one.fill == null) continue;
      if (one.operatorOnly === true && facts.operator !== true) continue;
      try { one.fill(contributedHost ?? mount ?? body); } catch { /* one row short beats a blank section */ }
    }
    if (rowId) {
      const row = body.querySelector(`[data-setting-row="${rowId}"]`);
      if (row != null) { row.classList.add("is-pointed"); row.scrollIntoView({ block: "center" }); }
    }
    // The seam every other module mounts on. backgrounds.js listens for exactly this.
    try {
      doc().dispatchEvent(new global.CustomEvent("titanbot:settings-section", { detail: { id: section.id, host: mount ?? body } }));
    } catch { /* a browser with no CustomEvent is not one this console runs in */ }
    return true;
  }

  /**
   * With no argument: re-reads every fact and repaints the section on screen, keeping the nav and
   * the search box. With a contributor's id: re-fills that one row in place, and repaints its
   * section only if the person is looking at it. A module with a new value to show calls the second
   * form so a background change updates one card rather than throwing the person back to General.
   */
  async function refresh(id = null) {
    if (typeof id === "string" && id.length > 0) {
      const one = CONTRIBUTORS.get(id);
      if (one == null) return false;
      if (shown() !== one.section) return true;
      paint(current, null);
      return true;
    }
    await readFacts();
    if (shown() != null) paint(current, null);
    return true;
  }

  /**
   * BG-PICKER-1's seam, and the smallest one that works.
   *
   * openSubview({ id, section, title, markup, fill, onBack }) paints the section's body as a sub-view
   * and remembers it, so paint() leaves it alone until something ends it. closeSubview() forgets it
   * and repaints the section. A nav press, a search that lands somewhere else, and open() all end it,
   * so a person can never be left with a body the nav says is something else.
   *
   * register() is untouched: a module that wants a sub-view draws its own control in its own mount
   * slot and wires its own press, which is what backgrounds.js already does for its tiles. That keeps
   * this out of act() and out of the registry.
   */
  function openSubview(entry) {
    if (entry == null || typeof entry.id !== "string" || entry.id.length === 0) return false;
    const sectionId = typeof entry.section === "string" ? entry.section : (current ?? "general");
    const section = sectionById(sectionId);
    if (section == null) return false;
    subview = {
      id: entry.id,
      section: sectionId,
      title: typeof entry.title === "string" && entry.title.length > 0 ? entry.title : section.title,
      markup: typeof entry.markup === "function" ? entry.markup : () => "",
      fill: typeof entry.fill === "function" ? entry.fill : null,
      onBack: typeof entry.onBack === "function" ? entry.onBack : null,
    };
    return paint(sectionId, null);
  }

  function closeSubview() {
    const was = subview;
    subview = null;
    if (was == null) return false;
    if (was.onBack != null) { try { was.onBack(); } catch { /* the owner's problem, not the surface's */ } }
    if (surface() != null) paint(was.section, null);
    return true;
  }

  function open(sectionId = "general", rowId = null) {
    const openPanel = ui().openPanel;
    if (typeof openPanel !== "function" || doc() == null) return false;
    if (typeof host().markOpen === "function") host().markOpen();
    // BG-PICKER-1. A surface that opens fresh opens on the section, never on a sub-view somebody left
    // open the last time.
    subview = null;
    openPanel("Your workspace", "Settings", shellMarkup(sectionId, facts.operator === true));
    dialog()?.classList.add("is-settings");
    current = sectionId;
    wire();
    paint(sectionId, rowId);
    // Then the facts, and a repaint when they land: a surface that waited for six reads before
    // drawing anything is a surface that looks broken on a cold box.
    void readFacts().then(() => {
      const shell = surface();
      if (shell == null) return;
      // The nav may have grown an Operator entry now that the session answer has landed, so the
      // attribute that says which surface this is moves with it.
      const list = shell.querySelector(".settings-nav-list");
      if (list != null) list.innerHTML = sectionsFor(facts.operator === true).map((section) => navButton(section, current)).join("");
      shell.dataset.settingsOperator = String(facts.operator === true);
      paint(current, rowId);
    }).catch(() => {});
    return true;
  }

  const shown = () => (surface() == null ? null : current);

  // ---- the search -------------------------------------------------------------------------------
  function filterNav(query) {
    const needle = String(query ?? "").trim().toLowerCase();
    const shell = surface();
    const list = shell?.querySelector(".settings-nav-list");
    const empty = shell?.querySelector("[data-settings-nav-empty]");
    if (list == null) return;
    const matches = [];
    for (const button of list.querySelectorAll("[data-settings-nav]")) {
      const section = sectionById(button.dataset.settingsNav);
      const haystack = [section?.label, section?.title, section?.subtitle, ...(section?.keywords ?? []),
        ...rowsFor(section?.id ?? "", facts).map((row) => `${row.label} ${row.line ?? ""}`)].join(" ").toLowerCase();
      const hit = needle.length === 0 || haystack.includes(needle);
      button.hidden = !hit;
      if (hit) matches.push(button.dataset.settingsNav);
    }
    if (empty != null) empty.hidden = matches.length > 0;
    // One match left is an answer, not a filter: typing "quiet" should land on Notifications rather
    // than leave the person with one more button to press.
    // BG-PICKER-1: a search that lands somewhere else ends a sub-view, the same as a nav press.
    if (needle.length > 1 && matches.length === 1 && matches[0] !== current) { subview = null; paint(matches[0], null); }
  }

  // ---- the controls -----------------------------------------------------------------------------

  function rowValue(node) {
    const row = node.closest("[data-setting-row]");
    return row?.querySelector("[data-settings-value]")?.value ?? "";
  }

  async function act(action, node) {
    const api = adapter();
    const h = host();
    if (action === "sign-out") {
      try { await global.fetch("/logout", { method: "POST" }); } catch { /* going anyway */ }
      global.location?.assign?.("/login");
      return;
    }
    if (action === "revoke-device") {
      const id = node.dataset.settingsId;
      node.disabled = true;
      try { await ask("DELETE", `/auth/devices/${encodeURIComponent(id)}`); toast("That device has to sign in again."); await refresh(); }
      catch (error) { node.disabled = false; toast(`That device was not revoked: ${error.message}`); }
      return;
    }
    if (action === "theme") {
      applyTheme(node.value);
      // SETTINGS-3. Into the facts, so the next paint -- whoever fires it -- draws what was chosen.
      noteChange("theme", node.value);
      toast(node.value === "system" ? "Following this device." : `${node.options[node.selectedIndex].text} it is.`);
      return;
    }
    if (action === "microphone") {
      voice()?.setMicDeviceId?.(node.value);
      noteChange("microphone", node.value);
      toast("That microphone is the one Talk uses.");
      return;
    }
    if (action === "talk-mode") {
      // Painted back from the module rather than left as typed, so a value it refused shows what it
      // really is rather than what was asked for. Changing it while a call is up ends that call, which
      // is why the words say so out loud rather than leaving a microphone in a state nobody can
      // account for.
      const was = voice()?.talkMode?.();
      const next = voice()?.setTalkMode?.(node.value) ?? was;
      node.value = next ?? node.value;
      // SETTINGS-3. The row used to lie about itself from here on: the module, this browser's stored
      // value and the control were all correct and a refresh already in flight painted the old value
      // back over the control. The value goes into the facts, and the guard in readFacts stops a read
      // that started earlier from undoing it.
      if (next != null) noteChange("talkMode", next);
      toast(next === "always" ? "Press Talk once to start, once more to stop." : "Hold Talk while you speak.");
      return;
    }
    if (action === "voice") {
      const on = node.getAttribute("aria-pressed") !== "true";
      node.setAttribute("aria-pressed", String(on));
      // SETTINGS-3 again, and this one travels through a route, which is why the guard and not only the
      // write-back is needed: the switch is noted BEFORE the await so a read already in flight cannot
      // land between the press and the answer and put the old position back.
      noteChange("voice", { ...(facts.voice ?? {}), enabled: on });
      try { await voice()?.setEnabled?.(on); toast(on ? "Talking is on." : "Talking is off."); }
      catch (error) {
        node.setAttribute("aria-pressed", String(!on));
        noteChange("voice", { ...(facts.voice ?? {}), enabled: !on });
        toast(`That was not saved: ${error.message}`);
      }
      return;
    }
    if (action === "bot-name") {
      const name = rowValue(node).trim();
      const id = typeof h.leadId === "function" ? h.leadId() : null;
      if (name.length === 0 || id == null || typeof api?.updateProfile !== "function") { toast("Type a name first."); return; }
      node.disabled = true;
      try {
        const saved = await api.updateProfile(id, { name });
        toast(`He is ${saved.name} now.`);
        if (typeof ui().renderAll === "function") ui().renderAll();
        await refresh();
      } catch (error) { toast(`That name was not saved: ${error.message}`); }
      finally { node.disabled = false; }
      return;
    }
    if (action === "copy-bot-email" || action === "copy-email") {
      const field = action === "copy-email"
        ? surface()?.querySelector("[data-settings-identity] small")
        : node.closest(".setting-control")?.querySelector("[data-settings-value]");
      const text = field?.value ?? field?.textContent ?? "";
      try { await global.navigator?.clipboard?.writeText?.(text); toast("Copied."); }
      catch { toast("This browser would not let the page copy. Select it and copy it yourself."); }
      return;
    }
    if (action === "local-tool") {
      if (typeof api?.setLocalToolPermission !== "function") { toast("This computer cannot be set from here."); return; }
      const wanted = node.value;
      node.disabled = true;
      try {
        // Written, then READ BACK: the host applies the operator's ceiling, so what came back is the
        // truth and a pick it refused has to say so rather than sit there looking saved.
        const answer = await api.setLocalToolPermission(wanted);
        toast(answer?.value !== wanted ? "Your operator caps this lower than that." : "Saved on the computer.");
        await refresh();
      } catch (error) { toast(`That was not saved: ${error.message}`); await refresh(); }
      finally { node.disabled = false; }
      return;
    }
    if (action === "ask-before") {
      if (typeof api?.setAutoReview !== "function") { toast("This computer cannot be set from here."); return; }
      node.disabled = true;
      try { await api.setAutoReview(true, rowValue(node)); toast("Titan will check those with you."); }
      catch (error) { toast(`That was not saved: ${error.message}`); }
      finally { node.disabled = false; }
      return;
    }
    if (action === "plan-model") {
      if (typeof h.usePlanChoice !== "function") return;
      node.disabled = true;
      try { await h.usePlanChoice(node.value); await refresh(); }
      catch (error) { toast(`That was not changed: ${error.message}`); }
      finally { node.disabled = false; }
      return;
    }
    if (action === "billing") { if (typeof h.openReport === "function") h.openReport(); else toast("Ask your operator about billing."); return; }
    if (action === "check-updates") {
      node.disabled = true;
      await refresh();
      toast(facts.updateAvailable === true ? "A newer version is ready." : "You're up to date.");
      return;
    }
    if (action === "update-box") {
      // Two presses, and the first disarms itself after six seconds. A repaint disarms it too, so a
      // button reading Update is never one press away from recreating the computer.
      if (armedUpdate == null) {
        armedUpdate = global.setTimeout(() => { armedUpdate = null; noteChange("updateArmed", false); paint(current, null); }, 6000);
        // SETTINGS-3. The same write this file already did, through the one door that also tells a read
        // in flight it is out of date -- otherwise a refresh landing in the six second window disarms
        // the button under a finger that is about to press it again.
        noteChange("updateArmed", true);
        paint(current, null);
        toast(`Press it again to replace the computer ${typeof h.workspaceName === "function" && h.workspaceName() ? `for ${h.workspaceName()}` : "for this workspace"} with a fresh one.`);
        return;
      }
      global.clearTimeout(armedUpdate);
      armedUpdate = null;
      noteChange("updateArmed", false);
      const id = typeof h.leadId === "function" ? h.leadId() : null;
      if (id == null || typeof api?.updateBox !== "function") { paint(current, null); toast("This computer cannot be updated from here."); return; }
      node.disabled = true;
      if (typeof h.raiseUpdateToast === "function") h.raiseUpdateToast();
      try { const answer = await api.updateBox(id); toast(`The computer answered: ${answer.state}`); }
      catch (error) { toast(`The computer was not updated: ${error.message}`); }
      finally { if (typeof h.clearUpdateToast === "function") h.clearUpdateToast(); await refresh(); }
      return;
    }
  }

  function wire() {
    if (wired) return;
    const node = panel();
    if (node == null) return;
    wired = true;
    node.addEventListener("click", (event) => {
      // BG-PICKER-1's back control. It carries no action name on purpose: act() has no default branch,
      // so a control that went through it would be swallowed in silence.
      if (event.target.closest?.("[data-settings-back]") != null) { closeSubview(); return; }
      const nav = event.target.closest?.("[data-settings-nav]");
      // A nav press ends a sub-view even when it names the section the sub-view belongs to: somebody
      // pressing General is asking for General.
      if (nav != null) { subview = null; paint(nav.dataset.settingsNav, null); return; }
      const control = event.target.closest?.("[data-settings-action]");
      if (control == null || control.tagName === "SELECT") return;
      if (surface() == null) return;
      void act(control.dataset.settingsAction, control);
    });
    node.addEventListener("change", (event) => {
      const control = event.target.closest?.("select[data-settings-action]");
      if (control == null || surface() == null) return;
      void act(control.dataset.settingsAction, control);
    });
    node.addEventListener("input", (event) => {
      const search = event.target.closest?.("[data-settings-search]");
      if (search != null) filterNav(search.value);
    });
  }

  // The stored choice, applied before the first paint, and kept in step with the atmosphere button
  // in the window bar: that button writes documentElement.dataset.theme and nothing persisted it, so
  // a person's choice was gone on every reload. Observed rather than intercepted, so app.js's own
  // handler is left exactly as it is.
  function persistTheme() {
    const root = doc()?.documentElement;
    if (root == null) return;
    // Only a stored choice is applied. Nothing stored leaves the page exactly as index.html shipped
    // it, which is the console coming up dark, the way it always has.
    const choice = storedTheme();
    if (choice != null) applyTheme(choice);
    try {
      new global.MutationObserver(() => {
        const dark = root.dataset.theme === "dusk";
        const held = storedTheme();
        // Following the system and then pressing the button is a person choosing: the press becomes
        // the explicit choice rather than being thrown away on the next reload.
        if (held === "system" && dark === systemDark()) return;
        try { global.localStorage?.setItem(THEME_KEY, dark ? "dark" : "light"); } catch { /* not a fault */ }
      }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    } catch { /* no observer, no persistence; the surface still works */ }
  }

  function ensureStylesheet() {
    const document_ = doc();
    if (document_?.head == null || document_.querySelector('link[href$="settings.css"]')) return;
    const link = document_.createElement("link");
    link.rel = "stylesheet";
    link.href = "settings.css";
    document_.head.appendChild(link);
  }

  if (doc() != null) {
    ensureStylesheet();
    if (doc().readyState === "loading") doc().addEventListener("DOMContentLoaded", persistTheme);
    else persistTheme();
  }

  global.__mrSettings = {
    // The pure pieces, importable with no document at all -- the contract marketplace-bots.js and
    // push-settings.js already keep -- so the unit test and the gate read these rather than
    // re-implementing them.
    SECTIONS,
    sectionsFor,
    rowsFor,
    accountMenuRows,
    customerCopy,
    BANNED,
    BANNED_WORDS,
    BANNED_VENDORS,
    // The registry a sibling module contributes a row through, so nothing has to hunt for this
    // panel by its title ever again.
    register,
    // The live half.
    open,
    shown,
    refresh,
    paint,
    // BG-PICKER-1. A module's own body for one section, with a way back. backgrounds.js is the one
    // caller; item B's Talking card does not use this, which is what keeps the two edits apart.
    openSubview,
    closeSubview,
    facts: () => facts,
    _readFacts: readFacts,
    // SETTINGS-3. What the guard knows, so a gate can tell "the control agrees" from "the control
    // agrees because nothing ever raced it".
    _changeLog: () => CHANGE_LOG.map((one) => ({ ...one })),
    _noteChange: noteChange,
    _subview: () => (subview == null ? null : { id: subview.id, section: subview.section }),
    _subviewMarkup: subviewMarkup,
    _shellMarkup: shellMarkup,
    _bodyMarkup: bodyMarkup,
    _rowMarkup: rowMarkup,
    _filterNav: filterNav,
    _applyTheme: applyTheme,
  };
})(typeof window !== "undefined" ? window : globalThis);
