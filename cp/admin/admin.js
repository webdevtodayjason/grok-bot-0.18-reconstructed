// cp/admin/admin.js -- the super admin console's whole behaviour. ADMIN-1.
//
// No framework and no build step. It fetches eight routes, renders ten panels, and offers the named
// actions below. The session token lives in sessionStorage and nowhere else: it dies with the tab,
// it is never in a URL, and it is never written into a cookie, so nothing carries it to a route
// that did not ask for it.
//
// ADMIN-3 MADE IT A DASHBOARD. One panel is on screen at a time, a left rail names them and the URL
// hash says which, so a link opens a panel. All nine loaders still run together on one Refresh:
// the rail decides what is SHOWN, never what is fetched, because an operator who opens Box health
// during an outage must not wait on a fetch that could have happened a second earlier. TWO of the
// eleven panels cost no route at all: the Overview, whose every figure was already fetched for one of
// the nine and comes out of a registry each loader writes to, and Keys (KEYS-2), whose two blocks
// are drawn by the System health loader that already fetched both their answers. So the numbers on
// this page are eleven panels and nine loaders, and they are different on purpose. SUPPORT-1 added
// the eleventh panel and the ninth loader together, which is the ordinary case: a panel with a route
// of its own moves both numbers.
//
// PROVIDERS-1 ADDED THE ONE THING THIS PAGE HAD NEVER DONE: it takes a secret IN. Every panel
// before it was read-only plus seven actions that carried no value, and the only secret that ever
// moved was a temporary password coming back out once in a banner. A provider key is different. It
// is typed here, it crosses this page, and it must not stop anywhere on the way. So:
//
//   a key field is type=password, it is cleared the moment the request comes back, and nothing
//   ever writes a value back into one. No route on this service answers with a key, and if one
//   ever did, this page would still not have anywhere to put it.
//
//   the banner after a key action names the slot and the short hash the service reports, never a
//   fragment of the value.
//
//   the pass-through headers the proxy holds are NOT rendered here at all. That route answers with
//   them in the clear, unlike the credential list, so the only safe thing to draw is nothing.
//
// Two rules the rendering follows everywhere, and they are the two that make the screen worth
// having:
//
//   Every number carries when it was measured. A health screen whose figures have no timestamp is
//   a screen that quietly shows yesterday.
//
//   A fact that could not be measured says "not measured" and why, and never a zero, a dash or a
//   green tick. Made-up green is how an outage gets missed.

"use strict";

(function () {
  const TOKEN_KEY = "titanbot.admin.token";
  const EMAIL_KEY = "titanbot.admin.email";

  const $ = (id) => document.getElementById(id);
  const door = $("door");
  const panel = $("console");

  // sessionStorage throws outright in some privacy modes, so every touch is wrapped and the page
  // still works with none of it: the operator simply signs in again.
  const stored = {
    get(key) { try { return sessionStorage.getItem(key) ?? ""; } catch { return ""; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* nothing to do */ } },
    clear() { try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(EMAIL_KEY); } catch { /* nothing to do */ } },
  };

  let token = stored.get(TOKEN_KEY);

  // ---- small helpers ---------------------------------------------------------------------------

  const text = (value) => document.createTextNode(String(value ?? ""));
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.appendChild(text(content));
    return node;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  const when = (iso) => {
    if (!iso) return "never";
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return String(iso);
    return at.toLocaleString();
  };

  // "3 minutes ago", because on this screen the gap matters more than the clock time. The absolute
  // time goes in the title attribute so hovering still answers "when exactly".
  const ago = (iso) => {
    const at = Date.parse(String(iso ?? ""));
    if (!Number.isFinite(at)) return "never";
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} days ago`;
  };

  const age = (ageMs) => {
    if (ageMs === null || ageMs === undefined || !Number.isFinite(Number(ageMs))) return "not measured yet";
    const seconds = Math.max(0, Math.round(Number(ageMs) / 1000));
    if (seconds < 60) return seconds < 5 ? "measured just now" : `measured ${seconds} seconds ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `measured ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    return `measured ${hours} hour${hours === 1 ? "" : "s"} ago`;
  };

  const bytes = (value) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = Number(value);
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  };

  const banner = (message, good) => {
    const node = $("banner");
    node.textContent = String(message ?? "");
    node.className = good ? "banner good" : "banner";
    node.hidden = String(message ?? "").length === 0;
  };

  // ---- the rail: which panel is on screen -------------------------------------------------------
  //
  // ADMIN-3. Jason, 2026-09-09: "stuff is all jumbled and there is a lot of scrolling." One panel at
  // a time, named by the URL hash, so a pasted link opens a panel and the browser's own back button
  // walks them. Nothing about what a panel CONTAINS changed: every section, every id and every
  // control is where it was.
  //
  // The hidden ATTRIBUTE and never a style or a class of this file's own. `[hidden]` is settled once,
  // at the top of admin.css, with an !important that beats every display rule under it, so there is
  // exactly one place in this product that decides whether a panel is on the screen. A class here
  // would be a second place, and the day the two disagree every panel is on screen at once.

  const PANELS = [
    "panel-overview", "panel-signins", "panel-clients", "panel-boxes", "panel-system",
    "panel-keys", "panel-spend", "panel-providers", "panel-feedback", "panel-support",
    "panel-marketplace",
  ];

  const wantedPanel = (raw) => {
    const id = String(raw ?? "").replace(/^#/, "");
    return PANELS.includes(id) ? id : PANELS[0];
  };

  function showPanel(raw) {
    const wanted = wantedPanel(raw);
    for (const id of PANELS) {
      const section = $(id);
      if (section) section.hidden = id !== wanted;
      const link = document.querySelector(`.rail a[href="#${id}"]`);
      if (link == null) continue;
      if (id === wanted) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    // Each panel scrolls inside itself, so a panel left half way down must not hand its scroll
    // position to the next one an operator opens. Sideways as well as down: everything wide on this
    // page has its own scrolling box, so a panel that has been nudged right is a panel with its
    // first column of text off the screen and no sign of why.
    const open = $(wanted);
    if (open) { open.scrollTop = 0; open.scrollLeft = 0; }
  }

  window.addEventListener("hashchange", () => showPanel(location.hash));

  // ---- the summary strips and the Overview -------------------------------------------------------
  //
  // ADMIN-3 asked for a strip of figures at the top of each panel and an Overview that links into
  // them. Neither fetches anything: every number was already in one of the nine answers, so each
  // loader writes its own strip and registers its one headline figure, and the Overview is drawn
  // from that registry once the nine have settled. It is NOT a tenth loader, and Refresh runs the
  // same nine requests the panels need.
  //
  // A panel that threw registers nothing and its Overview chip says "not measured" with the reason
  // the loader gave. That is the whole reason the Overview reads a registry rather than making its
  // own request: a chip that fetched separately could show a green figure for a panel that is dark.

  const OVERVIEW = [
    { key: "clients", label: "Clients running", hash: "#panel-clients" },
    { key: "boxes", label: "Boxes answering", hash: "#panel-boxes" },
    { key: "spend", label: "Spend this month", hash: "#panel-spend" },
    { key: "feedback", label: "Reports waiting", hash: "#panel-feedback" },
    // SUPPORT-1. The one figure an operator needs off this panel before opening it: how many people
    // have written to the support address and not been answered.
    { key: "support", label: "Support unanswered", hash: "#panel-support" },
    { key: "verification", label: "Needs re-verification", hash: "#panel-marketplace" },
    { key: "attacks", label: "Sign-in attacks", hash: "#panel-signins" },
  ];
  const headlines = new Map();

  /** One figure: a caption, the number, and a line under it. A null is "not measured" and why. */
  function statNode(tag, chip) {
    const node = document.createElement(tag);
    node.className = `stat${chip.tone ? ` ${chip.tone}` : ""}`;
    node.appendChild(el("div", "k", chip.label));
    const value = el("div", "v");
    if (chip.value === null || chip.value === undefined) {
      value.className = "v unmeasured";
      value.appendChild(text("not measured"));
    } else {
      value.appendChild(text(String(chip.value)));
    }
    node.appendChild(value);
    if (chip.detail) node.appendChild(el("div", "d", chip.detail));
    if (chip.why) node.title = String(chip.why);
    return node;
  }

  /**
   * A panel's own strip, and the one figure it lends the Overview.
   *
   * Called where each loader has its answer and BEFORE that loader's own early return, not at the
   * end of it: five of the nine return early on an empty answer, and a strip written after that
   * return is a strip nobody with no customers, no boxes, no reports or no support mail would ever
   * see.
   */
  function summarise(sectionId, chips, headline) {
    const host = document.querySelector(`#${sectionId} .strip`);
    if (host) {
      clear(host);
      for (const chip of chips) host.appendChild(statNode("div", chip));
    }
    if (headline == null) return;
    headlines.set(headline.key, headline);
    // Redrawn here and not only after a full Refresh. Four of these panels reload on their own when
    // a filter beside them changes -- the sign-in window, the feedback tier -- and an Overview that
    // only moved on a Refresh sat there saying one attack in the last day while the panel behind the
    // link said none. Two numbers for the same fact on the same screen is the failure this whole
    // page is built to avoid, and it costs six nodes to draw.
    renderOverview();
  }

  function renderOverview() {
    const host = $("overview");
    if (host == null) return;
    clear(host);
    for (const row of OVERVIEW) {
      const chip = headlines.get(row.key) ?? { label: row.label, value: null, why: "this panel did not load" };
      const node = statNode("a", { ...chip, label: chip.label ?? row.label });
      node.href = row.hash;
      host.appendChild(node);
    }
  }

  // A time an operator can compare with a log line, which is what a failure timestamp is for. The
  // rest of this page says "3 h ago" because the gap is what matters there; here the clock is.
  const utcMinute = (iso) => {
    const at = new Date(String(iso ?? ""));
    if (Number.isNaN(at.getTime())) return String(iso ?? "");
    return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  };

  // ---- the wire --------------------------------------------------------------------------------

  async function api(method, pathname, body) {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed = null;
    if (raw.length > 0) { try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 300) }; } }
    if (response.status === 401) {
      // The session expired or the flag was taken away while this tab was open. Back to the door
      // rather than a screen of half-loaded panels.
      signOut("That session is no longer valid. Sign in again.");
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      const error = new Error(String(parsed?.message ?? parsed?.error ?? `that request answered ${response.status}`));
      error.status = response.status;
      // The refusal's own body, carried through. Some refusals are a QUESTION -- push-label answers
      // 409 with the workspaces it would touch and changes nothing -- and a caller that only got
      // the sentence could not draw the list the operator has to choose from.
      error.body = parsed ?? {};
      throw error;
    }
    return parsed ?? {};
  }

  // ---- the door --------------------------------------------------------------------------------

  function showDoor(message) {
    door.hidden = false;
    panel.hidden = true;
    $("doorMessage").textContent = String(message ?? "");
  }

  function showConsole(email) {
    door.hidden = true;
    panel.hidden = false;
    $("whoami").textContent = email ? `signed in as ${email}` : "signed in with the operator token";
    // The hash, so a link straight to a panel opens that panel rather than the Overview and then
    // jumping. An empty or unknown hash lands on the Overview.
    showPanel(location.hash);
  }

  function signOut(message) {
    token = "";
    stored.clear();
    showDoor(message ?? "");
  }

  $("signin").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("signinButton");
    const email = $("email").value.trim();
    const password = $("password").value;
    $("doorMessage").textContent = "";
    button.disabled = true;
    try {
      const response = await fetch("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const answer = await response.json().catch(() => ({}));
      if (response.status === 429) {
        // The same lockout every other door on this service has: ten in ten minutes, counted
        // against the email and against the address.
        const seconds = Number(answer?.retryAfter ?? 0);
        $("doorMessage").textContent = seconds > 0
          ? `Too many attempts. Wait ${seconds} seconds and try again.`
          : "Too many attempts. Wait a moment and try again.";
        return;
      }
      if (!response.ok) {
        $("doorMessage").textContent = String(answer?.message ?? "That email or password is not right.");
        return;
      }
      if (answer?.account?.superAdmin !== true) {
        // Their password was right and this console is not theirs. Said plainly, and the token is
        // dropped on the floor rather than kept.
        $("doorMessage").textContent = "That sign-in works, and it is not a super admin. This console is for the person who runs the whole system.";
        return;
      }
      token = String(answer.token ?? "");
      stored.set(TOKEN_KEY, token);
      stored.set(EMAIL_KEY, String(answer.account.email ?? ""));
      $("password").value = "";
      showConsole(String(answer.account.email ?? ""));
      await loadAll();
    } catch {
      $("doorMessage").textContent = "This service is not answering right now.";
    } finally {
      button.disabled = false;
    }
  });

  $("signout").addEventListener("click", () => signOut("Signed out."));
  $("refresh").addEventListener("click", () => {
    // ADMIN-2. Refresh takes the new-client card away with everything else on the screen, because it
    // is the only sight of a temporary password there will ever be and it must not sit around after
    // the operator has moved on. It also stops the step poll: a fresh load is about to answer the
    // same question the poll was asking.
    stopWatchingSteps();
    clear($("addClientResult"));
    void loadAll();
  });
  $("hours").addEventListener("change", () => { void loadSignIns(); });
  $("outcome").addEventListener("change", () => { void loadSignIns(); });

  // ---- panel 1: sign-in attempts ---------------------------------------------------------------

  // SIGNIN-1. Jason, 2026-09-09 11:43, holding two screenshots of this panel: 147.136.44.142 marked
  // "Attack", 101 tries, 58 locked out, 23 different passwords, one of the accounts named being his
  // own. Every one of those bursts was our own deploy gate spending the relay's lockout on purpose.
  //
  // A gate row is labelled by the ROUTE, not here, and after the review of 2026-09-09 the label
  // COUNTS FOR NOTHING BUT INK: a labelled row is still in its address's attempts, in the
  // distinct-password window, in the Attack rule and in the spray table. It has to be. The header
  // that carries the label is a string anyone can write, and the earlier rule -- which took the
  // labelled rows out of the counts when the address had also signed in as an operator that hour --
  // was measured turning eight distinct passwords in eight minutes from Attack into silence for
  // anyone sharing an office NAT with the operator. So: grey ink, a name, and a count beside the
  // number ("116 tries, 11 of them our own gate"). Nothing is subtracted.
  const gateRowsIn = (answer) => Number(answer?.gates?.rows ?? 0);
  const attacksIn = (answer) => (answer.addresses ?? []).filter((row) => row.attack).length;

  function signInChips(answer) {
    const rows = answer.rows ?? [];
    const attacks = attacksIn(answer);
    const chips = [
      { label: "Attempts", value: rows.length },
      { label: "Refused", value: rows.filter((row) => row.outcome === "refused").length },
      { label: "Locked out", value: rows.filter((row) => row.outcome === "locked").length },
      { label: "Attacks", value: attacks, tone: attacks > 0 ? "bad" : "good" },
    ];
    const gates = gateRowsIn(answer);
    if (gates > 0) {
      chips.push({
        label: "Look like our own gates",
        value: gates,
        detail: "counted like everything else, marked in grey below",
        why: String(answer.gates?.setAsideNote || (answer.gates?.scripts ?? []).join(", ")),
      });
    }
    return chips;
  }

  const signInHeadline = (answer) => {
    const hours = String($("hours").value);
    const attacks = attacksIn(answer);
    const gates = gateRowsIn(answer);
    return {
      key: "attacks",
      label: "Sign-in attacks",
      value: attacks,
      tone: attacks > 0 ? "bad" : "good",
      detail: [
        hours === "1" ? "in the last hour" : hours === "24" ? "in the last day" : `in the last ${hours} hours`,
        gates > 0 ? `${gates} row${gates === 1 ? "" : "s"} look like our own gates, and are counted anyway` : "",
      ].filter(Boolean).join(", "),
    };
  };

  /**
   * The note beside a labelled row, and the two clauses do NOT get the same sentence.
   *
   * A named row said titanbot-gate/<script> at the door, which is a self-declared hint. An older
   * row said nothing: it matched a dated, shape-based clause for attempts written before any gate
   * carried a header, and calling that "your own verification gate" was reading one clause's
   * evidence as the other's.
   */
  function gateNote(row) {
    const script = String(row.gateScript ?? "").trim();
    const named = String(row.gateWhy ?? "") === "named" || script.length > 0;
    const node = el("span", "quiet", named
      ? `says it is our own verification gate${script.length > 0 ? ` (${script})` : ""}`
      : "an older row, from before gates named themselves");
    node.title = named
      ? "This attempt arrived with a user agent saying it was one of this product's own verification gates. A user agent is a string anyone can write, so it is marked here and still counted in everything above, including the Attack rule."
      : "This attempt was written before any gate said its own name at the door. It matched on its shape alone -- the instance door, turned away, the bare agent, from an address that was signing in as you at the time -- and it is still counted in everything above.";
    return node;
  }

  /** "N of them look like our own gates" under a summary figure, beside the number, never instead of it. */
  const gateSetAside = (count) => el("div", "quiet", `${count} of ${count === 1 ? "them looks" : "them look"} like our own gate${count === 1 ? "" : "s"}, and ${count === 1 ? "is" : "are"} counted above`);

  async function loadSignIns() {
    const hours = $("hours").value;
    const outcome = $("outcome").value;
    const answer = await api("GET", `/v1/admin/sign-ins?hours=${encodeURIComponent(hours)}&outcome=${encodeURIComponent(outcome)}&limit=500`);
    summarise("panel-signins", signInChips(answer), signInHeadline(answer));

    const note = [];
    note.push(`${answer.rows.length} attempt${answer.rows.length === 1 ? "" : "s"}`);
    note.push(`measured ${when(answer.measuredAt)}`);
    // The console's own ledger is half the picture. If it could not be read, the panel says so
    // rather than showing a shorter list as though it were the whole story.
    if (answer.relay && answer.relay.reachable === false) {
      note.push(`the console's own ledger could not be read: ${answer.relay.why}`);
    }
    if (answer.gates?.setAsideNote) note.push(String(answer.gates.setAsideNote));
    $("signInsNote").textContent = note.join(" - ");

    const addresses = $("addresses").querySelector("tbody");
    clear(addresses);
    if (answer.addresses.length === 0) {
      addresses.appendChild(rowSpanning(8, "Nobody has tried to sign in during this window."));
    }
    for (const row of answer.addresses) {
      const tr = document.createElement("tr");
      const ip = el("td", "mono");
      ip.appendChild(text(row.ip));
      if (row.attack) {
        ip.appendChild(text(" "));
        const chip = el("span", "chip attack", "Attack");
        chip.title = answer.rule;
        ip.appendChild(chip);
      }
      // SIGNIN-1. An address that also signed in as an operator or a super admin inside the hour is
      // one of ours, and saying so is what stops an operator reading their own laptop as an attacker.
      if (row.yourAddress === true) {
        const mine = el("div", "quiet", "your address");
        mine.title = "Somebody signed in successfully from this address as an operator or a super admin inside the hour.";
        ip.appendChild(mine);
      }
      if (Number(row.gateRows ?? 0) > 0) ip.appendChild(gateSetAside(Number(row.gateRows)));
      tr.appendChild(ip);
      tr.appendChild(el("td", "num", row.attempts));
      tr.appendChild(el("td", "num", row.refused));
      tr.appendChild(el("td", "num", row.locked));
      tr.appendChild(el("td", "num", row.ok));
      tr.appendChild(el("td", null, row.passwordStory));
      tr.appendChild(el("td", null, row.emails.length === 0 ? "none" : row.emails.join(", ")));
      const last = el("td", null, ago(row.lastAt));
      last.title = when(row.lastAt);
      tr.appendChild(last);
      addresses.appendChild(tr);
    }

    const accounts = $("accounts").querySelector("tbody");
    clear(accounts);
    const accountRows = answer.accounts ?? [];
    if (accountRows.length === 0) {
      accounts.appendChild(rowSpanning(8, "No account was named during this window."));
    }
    for (const row of accountRows) {
      const tr = document.createElement("tr");
      const who = el("td", "mono");
      who.appendChild(text(row.email));
      if (row.sprayed) {
        who.appendChild(text(" "));
        const chip = el("span", "chip attack", "Spray");
        chip.title = answer.sprayRule ?? "";
        who.appendChild(chip);
      }
      if (row.yourAddress === true) {
        const mine = el("div", "quiet", "your address");
        mine.title = "This account signed in successfully as an operator or a super admin inside the hour.";
        who.appendChild(mine);
      }
      if (Number(row.gateRows ?? 0) > 0) who.appendChild(gateSetAside(Number(row.gateRows)));
      tr.appendChild(who);
      tr.appendChild(el("td", "num", row.attempts));
      tr.appendChild(el("td", "num", row.refused));
      tr.appendChild(el("td", "num", row.locked));
      tr.appendChild(el("td", "num", row.ok));
      tr.appendChild(el("td", null, row.passwordStory));
      tr.appendChild(el("td", null, row.addresses.length === 0 ? "through the console" : row.addresses.join(", ")));
      const seen = el("td", null, ago(row.lastAt));
      seen.title = when(row.lastAt);
      tr.appendChild(seen);
      accounts.appendChild(tr);
    }

    const attempts = $("attempts").querySelector("tbody");
    clear(attempts);
    if (answer.rows.length === 0) {
      attempts.appendChild(rowSpanning(7, "Nothing during this window."));
    }
    for (const row of answer.rows) {
      const tr = document.createElement("tr");
      // Greyed and named, never dropped. Left out of the Attack rule and out of the counts, and
      // still in the list, because the operator has to be able to see what was set aside.
      if (row.gate === true) tr.className = "gateRow";
      const at = el("td", null, ago(row.at));
      at.title = when(row.at);
      tr.appendChild(at);
      tr.appendChild(el("td", null, row.door === "account" ? "account" : "instance password"));
      tr.appendChild(el("td", "mono", row.email || "-"));
      // A row this service wrote for a sign-in that came through a customer's console carries that
      // machine's address, not the visitor's, so printing it would name the wrong place.
      tr.appendChild(row.via === "relay"
        ? el("td", null, "through the console")
        : el("td", "mono", row.ip || "unknown"));
      tr.appendChild(el("td", null, row.tenant || "-"));
      const outcomeCell = document.createElement("td");
      outcomeCell.appendChild(el("span", `chip ${row.outcome}`, row.outcome === "ok" ? "signed in" : row.outcome === "locked" ? "locked out" : "refused"));
      tr.appendChild(outcomeCell);
      const seenBy = el("td", null, row.source === "relay" ? "the console" : "this service");
      if (row.gate === true) { seenBy.appendChild(document.createElement("br")); seenBy.appendChild(gateNote(row)); }
      tr.appendChild(seenBy);
      attempts.appendChild(tr);
    }
  }

  const rowSpanning = (columns, message) => {
    const tr = document.createElement("tr");
    const td = el("td", "empty", message);
    td.colSpan = columns;
    tr.appendChild(td);
    return tr;
  };

  // ---- panel 2: clients and users --------------------------------------------------------------

  // How many workspaces are still coming up, recorded where the strip is built so the add-client
  // poll below knows when to stop without a second pass over the same answer.
  let clientsBuilding = 0;

  function clientChips(answer) {
    const clients = answer.clients ?? [];
    const running = clients.filter((one) => String(one.status) === "running").length;
    clientsBuilding = clients.filter((one) => /provision|building|pending/i.test(String(one.status))).length;
    const people = clients.reduce((sum, one) => sum + (one.users ?? []).length, 0);
    const supers = clients.reduce((sum, one) => sum + (one.users ?? []).filter((user) => user.superAdmin).length, 0);
    return [
      { label: "Workspaces", value: clients.length },
      {
        label: "Running",
        value: `${running} of ${clients.length}`,
        tone: running === clients.length ? "good" : "warn",
        detail: clientsBuilding > 0 ? `${clientsBuilding} still building` : "",
      },
      { label: "People", value: people },
      { label: "Super admins", value: supers },
    ];
  }

  const clientHeadline = (answer) => {
    const clients = answer.clients ?? [];
    const running = clients.filter((one) => String(one.status) === "running").length;
    return {
      key: "clients",
      label: "Clients running",
      value: `${running} of ${clients.length}`,
      tone: running === clients.length ? "good" : "warn",
      detail: clientsBuilding > 0 ? `${clientsBuilding} still building` : "",
    };
  };

  // The two numbers on this screen that are money, formatted once. A null is never a zero: it goes
  // through `measured` below and comes out as the reason it could not be read.
  const dollars = (value) => (Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : null);
  const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const compactInteger = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const countWords = (value, compact = false) => {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(Number(value))) return null;
    const number = Number(value);
    return compact && Math.abs(number) >= 1_000_000 ? compactInteger.format(number) : integer.format(number);
  };

  // WHERE 80 AND 100 ARE DECIDED, and they are decided here rather than by the proxy, because until
  // CP_PROXY_ENFORCE is set the proxy does not fail anything: observe mode mints a soft budget,
  // which produces the number and never the refusal. So this chip is the whole of the warning today
  // and the wording has to be the wording a customer's own agent will use on the day it is armed.
  const ALLOWANCE_WARN_PCT = 80;

  function allowanceChips(spend) {
    const nodes = [];
    if (spend == null) return nodes;
    if (spend.minted !== true) {
      const chip = el("span", "quiet", "no plan key");
      chip.title = String(spend.why || "this workspace has no key at the proxy");
      nodes.push(chip);
      return nodes;
    }
    if (spend.pct === null || spend.pct === undefined) {
      const chip = el("span", "quiet", "allowance not measured");
      chip.title = String(spend.spendToDateWhy || spend.why || (spend.allowance == null ? "no allowance is set on this server (CP_PROXY_ALLOWANCE_USD)" : "the proxy did not answer"));
      nodes.push(chip);
      return nodes;
    }
    const pct = Number(spend.pct);
    const chip = el("span", pct >= 100 ? "chip attack" : pct >= ALLOWANCE_WARN_PCT ? "chip locked" : "chip ok",
      `${pct}% of the plan`);
    // The sentence, in the customer's words rather than ours. At 100 it is what their Titan tells
    // them; below it, it is what this number means.
    chip.title = pct >= 100
      ? (spend.enforced
        ? "They have used everything their plan includes this month. Their agent is telling them: You have used everything your plan includes this month. Add your own key under Settings and I will keep going, or ask for more."
        : "They are past what their plan includes. Nothing is being stopped, because this server is in observe mode (CP_PROXY_ENFORCE is not set).")
      : `${dollars(spend.spendToDate) ?? "not measured"} of ${dollars(spend.allowance) ?? "not measured"} this month`;
    nodes.push(chip);
    return nodes;
  }

  /**
   * One workspace's model, on its own row under the customer.
   *
   * Three honest states and no fourth. Not reported at all, which reads as not measured with the
   * reason on it. Pinned in that workspace's own environment, which reads as pinned and offers no
   * control, because the control would not do anything. Or settable, which is a picker built from
   * the plan models a customer can actually be put on, showing the name they would see and never
   * the routing alias.
   */
  function clientModelRow(client) {
    const row = el("div", "row modelRow");
    row.appendChild(el("span", "quiet", "Runs on"));
    const model = client.model;
    if (model == null) {
      row.appendChild(measured(null, "this control plane did not report a model for this workspace"));
      return row;
    }
    const label = String(model.label ?? "").length > 0 ? model.label : String(model.current ?? "");
    if (model.pinned === true) {
      row.appendChild(el("strong", null, label || "not measured"));
      row.appendChild(el("span", "chip locked", "pinned"));
      row.appendChild(el("span", "clock", model.why
        || "This workspace's model is fixed in its own environment, so changing it here would record a different answer and change nothing the customer sees. Change it where it is pinned, or unpin it first."));
      return row;
    }
    const select = document.createElement("select");
    select.className = "clientModel";
    const options = (model.choices ?? []).map((one) => ({ value: one.alias, label: one.name || one.alias }));
    if (options.length === 0) options.push({ value: String(model.current ?? ""), label: label || "not measured" });
    fill(select, options, model.current ?? "");
    row.appendChild(select);
    const save = el("button", "ghost small", "Save");
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const result = await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/model`, { planModel: select.value });
        banner(String(result.message || `${client.slug} runs on the new model from its next turn.`), true);
        // Both panels, because this change is made here and recorded down there. Reloading only
        // this one leaves What changed a row short of the truth until somebody hits Refresh, and a
        // ledger that is behind the screen it sits on is worse than no ledger.
        await Promise.all([loadClients(), loadProviders()]);
      } catch (error) { banner(String(error.message)); }
      finally { save.disabled = false; }
    });
    row.appendChild(save);
    row.appendChild(el("span", "clock", CLOCK.proxy));
    return row;
  }

  function clientRouterPinRow(client) {
    const row = el("div", "row routerPinRow");
    row.appendChild(el("span", "quiet", "Model router"));
    const select = document.createElement("select");
    select.className = "clientRouterPin";
    fill(select, [
      { value: "auto", label: "Auto" },
      { value: "work", label: "Always work" },
      { value: "talk", label: "Always talk" },
    ], client.routerPin ?? "auto");
    row.appendChild(select);
    const save = el("button", "ghost small", "Save");
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const result = await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/router-pin`, { pin: select.value });
        banner(String(result.message || `${client.slug}'s router pin was saved.`), true);
        await loadClients();
      } catch (error) { banner(String(error.message)); }
      finally { save.disabled = false; }
    });
    row.appendChild(save);
    row.appendChild(el("span", "clock", "This workspace-wide pin wins over automatic upgrades and the conversation switch."));
    return row;
  }

  /**
   * How many bots this workspace may hold, on its own row under the customer. AGENTS-CAP-2.
   *
   * The same three honest states clientModelRow above has, and for the same reason. Not reported,
   * which is the box that could not be asked and reads as the sentence saying so. Pinned in the
   * container environment, which draws a chip and NO control, because a field that writes a file
   * the host then ignores is worse than no field. Or settable, which is a number and a Save.
   *
   * THE NUMBER SHOWN IS THE ONE THE BOX REPORTED. Nothing here is read out of a store: the control
   * plane asked each box on this page load, so what is on screen is what that box will enforce on
   * its next turn rather than what somebody once typed.
   */
  function clientCeilingRow(client) {
    // Its own class rather than modelRow's, even though the layout is identical: the gate selects
    // `.client .modelRow` in strict mode and a second element under that name is a red gate on a
    // correct page.
    const row = el("div", "row capRow");
    row.appendChild(el("span", "quiet", "Bots allowed"));
    const ceiling = client.ceiling;
    if (ceiling == null || ceiling.read !== true) {
      row.appendChild(measured(null, String(ceiling?.why || "this control plane did not report a ceiling for this workspace")));
      return row;
    }
    const holding = Number.isFinite(Number(ceiling.bots)) ? `${ceiling.bots} in use` : "";
    if (ceiling.pinned === true) {
      row.appendChild(el("strong", null, String(ceiling.maxAgents)));
      if (holding) row.appendChild(el("span", "quiet", holding));
      row.appendChild(el("span", "chip locked", "pinned"));
      row.appendChild(el("span", "clock", String(ceiling.pinnedBy
        || "This workspace's ceiling is fixed in its own environment, so changing it here would record a different answer and change nothing. Change it where it is pinned, or unpin it first.")));
      return row;
    }
    const field = document.createElement("input");
    field.type = "number";
    field.min = "1";
    field.max = "1000";
    field.step = "1";
    field.className = "clientCeiling";
    field.value = String(ceiling.maxAgents);
    row.appendChild(field);
    if (holding) row.appendChild(el("span", "quiet", holding));
    const save = el("button", "ghost small", "Save");
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const result = await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/ceiling`, { maxAgents: Number(field.value) });
        banner(String(result.message || `${client.slug} holds ${result.maxAgents} bots.`), result.pinned !== true);
        await loadClients();
      } catch (error) { banner(String(error.message)); }
      finally { save.disabled = false; }
    });
    row.appendChild(save);
    row.appendChild(el("span", "clock", "The box takes this from its next turn. Their own page shows it the next time that page loads."));
    return row;
  }

  /**
   * ONBOARD-2. Where this customer's invite got to, on their own row.
   *
   * A workspace that predates the job has no steps and reads as one sentence rather than five
   * waiting rows: there were no steps, which is a different fact from "none of them have happened".
   */
  function clientOnboardingRow(client) {
    const row = el("div", "row onboardRow");
    row.appendChild(el("span", "quiet", "Invite"));
    const state = client.onboarding;
    if (state == null) {
      row.appendChild(el("span", "quiet", "this workspace was made before the console ran invites, so there are no steps to show"));
      return row;
    }
    if (state.done === true) {
      row.appendChild(el("span", "chip ok", "done"));
      const last = (state.steps ?? [])[4];
      if (last?.at) {
        const clock = el("span", "quiet", ago(last.at));
        clock.title = when(last.at);
        row.appendChild(clock);
      }
      return row;
    }
    const strip = el("div", "steps");
    drawSteps(strip, state, { onRetry: (button) => retryOnboarding(client.slug, button, null) });
    row.appendChild(strip);
    return row;
  }

  /**
   * ONBOARD-2. What went out to this customer, and the two ways to send it again.
   *
   * Who, whom, when, the outcome and the provider's id. There is no link and no password in that
   * record and there is none on this row: a sign-in link is a bearer credential the relay never
   * checks for revocation, so it is answered once into a banner and written down nowhere.
   */
  function clientWelcomeRow(client) {
    const row = el("div", "row welcomeRow");
    row.appendChild(el("span", "quiet", "Welcome"));
    const welcome = client.welcome ?? { rows: [], read: false, why: "" };
    // The invite's own fifth step, used when the send record cannot be read. It says less than the
    // record does -- no provider id, no second send -- and it says something true, which beats "not
    // measured" beside a welcome that plainly went.
    const step = (client.onboarding?.steps ?? []).find((one) => one.key === "welcome") ?? null;
    if (welcome.read !== true && step != null && step.state !== "waiting") {
      row.appendChild(el("span", step.state === "ok" ? "chip ok" : step.state === "failed" ? "chip attack" : "chip locked",
        step.state === "ok" ? `sent to ${String(step.detail?.to ?? "the owner")}` : String(step.why || step.state)));
      if (step.at) {
        const clock = el("span", "quiet", ago(step.at));
        clock.title = `${when(step.at)} -- ${String(welcome.why || "this control plane keeps no record of welcome sends, so this is the invite's own step")}`;
        row.appendChild(clock);
      }
    } else if (welcome.read !== true) {
      row.appendChild(measured(null, String(welcome.why || "this control plane keeps no record of welcome sends")));
    } else if ((welcome.rows ?? []).length === 0) {
      row.appendChild(el("span", "quiet", "nothing has been sent to this customer"));
    } else {
      for (const send of welcome.rows.slice(0, 3)) {
        const chip = el("span", send.outcome === "sent" ? "chip ok" : "chip attack", `${send.outcome || "sent"} to ${send.to}`);
        chip.title = `${when(send.at)}${send.resendId ? ` -- provider id ${send.resendId}` : ""}${send.actor ? ` -- sent by ${send.actor}` : ""}${send.shape ? ` -- ${send.shape}` : ""}`;
        row.appendChild(chip);
      }
    }

    const fresh = document.createElement("label");
    fresh.className = "check";
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.className = "welcomeNewPassword";
    fresh.appendChild(tick);
    fresh.appendChild(text(" with a new password"));
    row.appendChild(fresh);

    const send = el("button", "ghost small", "Send again");
    send.type = "button";
    send.addEventListener("click", async () => {
      send.disabled = true;
      try {
        const answer = await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/welcome`, { withNewPassword: tick.checked === true });
        // A new password is shown ONCE, here, and nowhere else ever again.
        banner(tick.checked === true && answer.temporaryPassword
          ? `${answer.message} New temporary password: ${answer.temporaryPassword}`
          : String(answer.message || "The welcome went."), answer.sent === true);
        await loadClients().catch(() => {});
      } catch (error) { banner(String(error.message)); }
      finally { send.disabled = false; }
    });
    row.appendChild(send);

    const link = el("button", "ghost small", "Copy a sign-in link");
    link.type = "button";
    link.addEventListener("click", async () => {
      link.disabled = true;
      try {
        const answer = await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/sign-in-link`, {});
        try {
          await navigator.clipboard.writeText(String(answer.url ?? ""));
          banner(`A sign-in link for ${answer.email} is on the clipboard. ${answer.message}`, true);
        } catch {
          // The link is put on the screen only when the clipboard refused, because a link on a screen
          // is a link in a screenshot.
          banner(`${answer.message} It could not be put on the clipboard, so here it is once: ${answer.url}`);
        }
        await loadClients().catch(() => {});
      } catch (error) { banner(String(error.message)); }
      finally { link.disabled = false; }
    });
    row.appendChild(link);
    return row;
  }

  /**
   * One of a removal's nine effects, drawn the way cp/decommission.mjs actually writes it.
   *
   * THE SHAPE IS `{step, status, detail}` AND NOTHING ELSE. The first cut of this panel read
   * `effect.name` and `effect.ok`, which cp/decommission.mjs has never emitted, so every chip on the
   * one screen where an operator finds out what a removal did was drawn with an EMPTY LABEL, and
   * `effect.ok === false` was never true, so a failed service delete and a container Coolify forgot
   * were both painted in the colour for success. `name`/`ok` are still read as a fallback, because a
   * panel that goes blank on an older answer is the same failure again.
   *
   * The colour follows the status and not a boolean: `failed` and `carried-on` are both things the
   * operator has to go and finish, `skipped` and `kept` are deliberate non-events, and `queued` is
   * Coolify taking a request rather than having done it -- which is amber by design, because a queued
   * delete looks exactly like a successful one.
   */
  function effectLine(effect) {
    const label = String(effect?.step ?? effect?.name ?? "");
    const status = String(effect?.status ?? "");
    const bad = effect?.ok === false || status === "failed" || status === "carried-on";
    const muted = status === "skipped" || status === "kept";
    const chip = bad ? "chip attack" : status === "queued" ? "chip locked" : muted ? "chip" : "chip ok";
    const line = el("div", "row");
    // The status is on the chip beside the name. "data" on its own does not say whether a customer's
    // files are gone; "data carried-on" does, and it is the difference between reading this card and
    // having to ask somebody.
    line.appendChild(el("span", chip, status.length > 0 ? `${label} ${status}` : label));
    line.appendChild(el("span", "quiet", String(effect?.detail ?? effect?.what ?? "")));
    return line;
  }

  /**
   * ONBOARD-2 / ADMIN-5. Remove a customer, for a test and for churn.
   *
   * Three gates in front of it and they are not ceremony. Click again to confirm, then the workspace
   * name typed to match, then a switch for their data that is OFF by default. The data switch says
   * what is TRUE when it is off: the files are kept and nothing deletes them on a timer, because
   * nothing in this product counts days and a card claiming thirty of them would be the product lying
   * to the operator.
   */
  function clientRemoveRow(client) {
    const row = el("div", "row removeRow");
    row.appendChild(el("span", "quiet", "Remove"));

    const confirm = document.createElement("input");
    confirm.type = "text";
    confirm.className = "removeConfirm";
    confirm.placeholder = `type ${client.slug}`;
    confirm.autocomplete = "off";
    confirm.hidden = true;

    const data = document.createElement("label");
    data.className = "check";
    const wipe = document.createElement("input");
    wipe.type = "checkbox";
    wipe.className = "removeData";
    data.appendChild(wipe);
    data.appendChild(text(" delete their data"));
    data.hidden = true;

    const said = el("span", "clock", "");
    said.hidden = true;

    const result = el("div", "removeResult");

    const button = el("button", "ghost small", "Remove");
    button.type = "button";
    let armed = false;
    const disarm = () => {
      armed = false;
      button.textContent = "Remove";
      button.className = "ghost small";
      confirm.hidden = true;
      data.hidden = true;
      said.hidden = true;
    };
    const saySwitch = () => {
      said.textContent = wipe.checked === true
        ? "Their files at /data/titanbot will be deleted and there is no undo."
        : "Their files are kept at /data/titanbot. Nothing deletes them on a timer, so somebody has to remove them by hand when the time comes.";
    };
    wipe.addEventListener("change", saySwitch);

    button.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        button.textContent = "Click again to remove";
        button.className = "ghost small danger";
        confirm.hidden = false;
        data.hidden = false;
        said.hidden = false;
        saySwitch();
        confirm.focus();
        return;
      }
      button.disabled = true;
      clear(result);
      try {
        const answer = await api("DELETE", `/v1/admin/clients/${encodeURIComponent(client.slug)}`, {
          confirm: confirm.value.trim(),
          deleteData: wipe.checked === true,
        });
        banner(String(answer.message || `${client.slug} was removed.`), answer.ok !== false);
        // THE EFFECTS GO ON THE PANEL AND NOT ON THE ROW, because the row is about to stop existing:
        // the customer has been removed, the list reloads, and effects drawn inside their own card
        // would be thrown away before anybody read them. This card is the panel's own result area,
        // which survives a list reload and is cleared by Refresh like everything else on this screen.
        const card = el("div", "newClient removedClient");
        card.appendChild(el("strong", null, `${client.name || client.slug} was removed.`));
        card.appendChild(el("p", "quiet", String(answer.message ?? "")));
        for (const effect of answer.effects ?? []) card.appendChild(effectLine(effect));
        const host = $("addClientResult");
        clear(host);
        host.appendChild(card);
        disarm();
        await loadClients().catch(() => {});
      } catch (error) {
        // The route's own sentence: a confirm that does not match, an adopted workspace, the
        // operator's own workspace, a container Coolify forgot while it kept running.
        banner(String(error.message));
        for (const effect of error.body?.effects ?? []) result.appendChild(effectLine(effect));
      } finally { button.disabled = false; }
    });

    row.appendChild(button);
    row.appendChild(confirm);
    row.appendChild(data);
    row.appendChild(said);
    const wrap = el("div", "removeWrap");
    wrap.appendChild(row);
    wrap.appendChild(result);
    return wrap;
  }

  async function loadClients() {
    const answer = await api("GET", "/v1/admin/clients");
    summarise("panel-clients", clientChips(answer), clientHeadline(answer));
    const host = $("clients");
    clear(host);
    if (answer.clients.length === 0) {
      host.appendChild(el("p", "empty", "No customers yet."));
      return;
    }
    for (const client of answer.clients) {
      const card = el("div", "client");
      const head = el("div", "head");
      head.appendChild(el("strong", null, client.name || client.slug));
      head.appendChild(el("span", "quiet", client.slug));
      head.appendChild(el("span", "chip", client.status));
      head.appendChild(el("span", "quiet", `Coolify says ${client.coolify && client.coolify.reachable ? client.coolify.status : "not measured"}`));
      // PROXY-1. What this customer's plan includes, and how close to it they are. The chip is the
      // only thing on this card that is ever red, and the words on it are the words their own agent
      // will say to them, so an operator reading the console and a customer reading their screen
      // are looking at the same fact.
      for (const node of allowanceChips(client.spend)) head.appendChild(node);

      const actions = el("div", "actions");
      for (const action of ["stop", "start", "restart", "provision"]) {
        const button = el("button", "ghost small", action);
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const result = await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/${action}`, {});
            banner(String(result.message || `${action} was asked for on ${client.slug}.`), true);
            await loadClients();
          } catch (error) { banner(String(error.message)); }
          finally { button.disabled = false; }
        });
        actions.appendChild(button);
      }
      head.appendChild(actions);
      card.appendChild(head);

      if (client.lastError) card.appendChild(el("p", "quiet", `last error: ${client.lastError}`));

      // PROVIDERS-1. What this one workspace runs on, and the way to change it.
      //
      // A workspace can have its model PINNED in its own environment, and when it is, saving a
      // different one here changes a record and changes nothing a customer would notice. That case
      // gets said out loud rather than a select that appears to work: a control that silently does
      // nothing is worse than no control.
      card.appendChild(clientModelRow(client));
      card.appendChild(clientRouterPinRow(client));
      card.appendChild(clientAllowanceRow(client, answer.allowanceLevels));
      // AGENTS-CAP-2. And how many bots it may hold, read off the box the same way.
      card.appendChild(clientCeilingRow(client));
      // ONBOARD-2. Where their invite got to, what went out to them, and the way to take them away.
      card.appendChild(clientOnboardingRow(client));
      card.appendChild(clientWelcomeRow(client));
      card.appendChild(clientRemoveRow(client));

      const wrap = el("div", "scroll users");
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const label of ["Email", "Name", "Added", "Last signed in", "Role", ""]) headRow.appendChild(el("th", null, label));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const body = document.createElement("tbody");
      if (client.users.length === 0) body.appendChild(rowSpanning(6, "Nobody can sign in to this workspace yet."));
      for (const user of client.users) {
        const tr = document.createElement("tr");
        tr.appendChild(el("td", "mono", user.email));
        tr.appendChild(el("td", null, user.name || "-"));
        const added = el("td", null, ago(user.createdAt));
        added.title = when(user.createdAt);
        tr.appendChild(added);
        const seen = el("td", null, user.lastSignInAt ? ago(user.lastSignInAt) : "never");
        seen.title = user.lastSignInAt ? when(user.lastSignInAt) : "no successful sign-in is on record";
        tr.appendChild(seen);
        const role = document.createElement("td");
        if (user.superAdmin) role.appendChild(el("span", "chip super", "super admin"));
        if (user.disabled) role.appendChild(el("span", "chip off", "sign-in off"));
        if (!user.superAdmin && !user.disabled) role.appendChild(text("customer"));
        tr.appendChild(role);

        const cell = document.createElement("td");
        const toggle = el("button", "ghost small", user.disabled ? "enable" : "disable");
        toggle.type = "button";
        toggle.addEventListener("click", async () => {
          toggle.disabled = true;
          try {
            const result = await api("POST", `/v1/admin/users/${encodeURIComponent(user.id)}/${user.disabled ? "enable" : "disable"}`, {});
            banner(String(result.message ?? ""), true);
            await loadClients();
          } catch (error) { banner(String(error.message)); }
          finally { toggle.disabled = false; }
        });
        cell.appendChild(toggle);

        const reset = el("button", "ghost small", "reset password");
        reset.type = "button";
        reset.addEventListener("click", async () => {
          reset.disabled = true;
          try {
            const result = await api("POST", `/v1/admin/users/${encodeURIComponent(user.id)}/reset-password`, {});
            // Shown once, in the banner, and nowhere else. There is no route that can be asked for
            // it again and nothing on this page keeps it.
            banner(`Temporary password for ${user.email}: ${result.temporaryPassword} - ${result.message}`, true);
            await loadClients();
          } catch (error) { banner(String(error.message)); }
          finally { reset.disabled = false; }
        });
        cell.appendChild(reset);
        tr.appendChild(cell);
        body.appendChild(tr);
      }
      table.appendChild(body);
      wrap.appendChild(table);
      card.appendChild(wrap);
      host.appendChild(card);
    }
  }

  function allowanceBar(answer, className = "") {
    const wrap = el("span", `tokenAllowance ${className}`.trim());
    const bar = el("span", "tokenAllowanceTrack");
    const fill = el("span", `tokenAllowanceFill ${answer?.state ?? "not-recorded"}`);
    fill.style.width = `${Math.max(0, Math.min(100, Number(answer?.pct) || 0))}%`;
    bar.appendChild(fill);
    wrap.appendChild(bar);
    wrap.appendChild(el("span", "quiet", answer?.pct == null ? "not recorded" : `${Math.round(answer.pct)}%`));
    return wrap;
  }

  function clientAllowanceRow(client, levels) {
    const current = client.allowance;
    const row = el("div", "capRow allowanceRow");
    row.appendChild(el("strong", null, "5-day token allowance"));
    row.appendChild(allowanceBar(current));
    const select = document.createElement("select");
    select.className = "clientAllowanceLevel";
    for (const level of Array.isArray(levels) ? levels : []) {
      const option = document.createElement("option");
      option.value = level.id;
      option.textContent = level.name;
      option.selected = level.id === current?.levelId;
      select.appendChild(option);
    }
    const override = document.createElement("input");
    override.className = "clientAllowanceOverride";
    override.type = "number";
    override.min = "1";
    override.step = "1";
    override.placeholder = "cap override";
    override.value = current?.capOverride == null ? "" : String(current.capOverride);
    const save = el("button", "ghost small", "Save allowance");
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await api("POST", `/v1/admin/clients/${encodeURIComponent(client.slug)}/allowance`, {
          level: select.value, capOverride: override.value,
        });
        await loadClients();
      } catch (error) { banner(String(error.message)); }
      finally { save.disabled = false; }
    });
    row.appendChild(select);
    row.appendChild(override);
    row.appendChild(save);
    const detail = current?.used == null
      ? `usage not recorded${current?.why ? `: ${current.why}` : ""}`
      : current.cap == null
        ? `${countWords(current.used)} tokens this cycle, no limit on this level; resets in ${current.cycle.daysLeft} days`
        : `${countWords(current.used)} of ${countWords(current.cap)} tokens; resets in ${current.cycle.daysLeft} days`;
    row.appendChild(el("span", "why", detail));
    return row;
  }

  // ---- ADMIN-2: adding a client from the screen --------------------------------------------------
  //
  // Jason, 2026-09-09 11:43: "if I was going to onboard a new client, would that be something I would
  // do from this console or is this console merely reporting?" It is not merely reporting from here
  // on. This runs the same sequence `node cp/cli.mjs signup add` runs -- the account, the workspace
  // slug derived from the company name, the box -- and the command line stays as the second door.
  //
  // THE SUBMIT IS A FETCH AND NEVER A NATIVE ONE. This page's own CSP says form-action 'none', so a
  // native submit is blocked by the browser with nothing on the screen to explain it, which reads as
  // a dead button. preventDefault comes first, always.
  //
  // THE WELCOME MAIL IS NOT DRAWN AS A GREEN LIGHT. This control plane sends no mail at all today.
  // The checkbox is present, unchecked and disabled with the reason beside it, the route is told
  // sendWelcome false, and the card offers a note to copy instead. A tick that quietly sends nothing
  // is worse than no tick, and this is the panel where that mistake costs a customer their password.

  const addClientForm = $("addClientForm");

  /**
   * The plan model picker, filled from what the providers panel already fetched.
   *
   * If that answer failed there is nothing to choose from, so the select is swapped for a field the
   * operator types a routing name into. An empty picker is a control that looks broken and gives the
   * operator no way past it.
   */
  function fillAddClientModels() {
    const select = $("acPlanModel");
    const typed = $("acPlanModelText");
    if (select == null || typed == null) return;
    // Only the models a customer can actually be put on. plan-zai-vision and its kind are what other
    // models fall back TO: they carry no customer name, so offering one here would put a routing
    // alias in a picker and a workspace on a model its own Settings page could not name.
    const models = (providersAnswer.planModels ?? []).filter((one) =>
      String(one.alias ?? "").length > 0 && one.shownToCustomers === true);
    if (models.length === 0) {
      select.hidden = true;
      typed.hidden = false;
      return;
    }
    select.hidden = false;
    typed.hidden = true;
    const keep = select.value;
    const fallback = String(providersAnswer.defaults?.planModel ?? models[0].alias);
    fill(select, models.map((one) => ({ value: one.alias, label: one.customerName || one.alias })),
      models.some((one) => one.alias === keep) ? keep : fallback);
  }

  const chosenPlanModel = () => ($("acPlanModel").hidden ? $("acPlanModelText").value : $("acPlanModel").value).trim();

  // ---- ONBOARD-2: the five steps, drawn live -----------------------------------------------------
  //
  // The invite answers before the box exists, so the card is a list of five named steps that fills
  // itself in. Two seconds apart for the first minute, then five, to a ten minute ceiling, and it
  // stops the moment the job finishes, the panel is left or Refresh is pressed. A page that polls for
  // ever is a page that keeps a laptop awake all night.
  //
  // GREEN, AMBER AND STOPPED ARE DRAWN APART, and nothing is ever half-green. A step that is done
  // with a caveat says the caveat under its own row in plain words; a step that stopped says the one
  // thing to press and offers the button that does it. Every verdict is a quiet chip: a prefixed,
  // underlined line reads as a failure even when it is a note.
  const STEP_CHIP = { ok: "chip ok", amber: "chip locked", failed: "chip attack", running: "chip", waiting: "quiet" };
  const STEP_WORD = { ok: "done", amber: "needs you", failed: "stopped", running: "working", waiting: "waiting" };

  let stepWatch = null;
  const stopWatchingSteps = () => {
    if (stepWatch != null) { clearTimeout(stepWatch); stepWatch = null; }
  };

  /** One step's row: the label, a chip, when it was written down, and the caveat or the stop. */
  function stepRow(step, { onRetry = null } = {}) {
    const row = el("div", "stepRow");
    const state = String(step.state ?? "waiting");
    row.dataset.step = String(step.key ?? "");
    row.dataset.state = step.stalled === true ? "stalled" : state;
    row.appendChild(el("span", STEP_CHIP[state] ?? "quiet", STEP_WORD[state] ?? state));
    row.appendChild(el("strong", null, String(step.label ?? "")));
    if (step.at) {
      const clock = el("span", "quiet", ago(step.at));
      clock.title = when(step.at);
      row.appendChild(clock);
    }
    const said = step.stalled === true
      ? String(step.next || "This step has not written anything down for three minutes. Press Retry.")
      : String(step.why || "");
    if (said.length > 0) row.appendChild(el("span", "clock", said));
    else if (step.next) row.appendChild(el("span", "clock", String(step.next)));
    if (onRetry != null && (state === "failed" || state === "amber" || step.stalled === true)) {
      const retry = el("button", "ghost small", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => { void onRetry(retry); });
      row.appendChild(retry);
    }
    return row;
  }

  /** The whole strip, redrawn in place so the card does not jump under the operator's cursor. */
  function drawSteps(host, state, { onRetry = null } = {}) {
    clear(host);
    for (const step of state.steps ?? []) host.appendChild(stepRow(step, { onRetry }));
    const skippedWelcome = (state.steps ?? []).some((one) => one.key === "welcome" && one.skipped === true);
    if (state.done === true) host.appendChild(el("p", "quiet", "All five steps are done. Their workspace is up, Titan is awake, their bots have addresses, and the welcome has gone."));
    else if (state.stopped == null && skippedWelcome) {
      // Every step that was asked for is done. A welcome nobody asked for is not a stop and must not
      // be drawn as one, or the operator goes looking for a fault they turned off themselves.
      host.appendChild(el("p", "quiet", "Their workspace is up, Titan is awake and their bots have addresses. No welcome was asked for, so send them the note from this card."));
    } else if (state.stopped) {
      const stopped = (state.steps ?? []).find((one) => one.key === state.stopped);
      host.appendChild(el("p", "quiet", `Stopped at ${stopped ? stopped.label : state.stopped}. Nothing after it has run.`));
    }
  }

  /**
   * Poll one workspace's steps into one element until the job is finished or the operator leaves.
   *
   * Only ONE of these runs at a time, because only one add is ever in front of somebody. The deadline
   * matches the job's own: past it the strip stops polling and says so rather than spinning silently.
   */
  function watchSteps(slug, host) {
    stopWatchingSteps();
    const opened = Date.now();
    const deadline = opened + 600_000;
    const tick = async () => {
      stepWatch = null;
      if (Date.now() > deadline) {
        host.appendChild(el("p", "quiet", "This card stopped watching after ten minutes. Refresh the panel to read where it got to."));
        return;
      }
      if ($("panel-clients")?.hidden === true) return;
      let state;
      try { state = await api("GET", `/v1/admin/clients/${encodeURIComponent(slug)}/onboarding`); }
      catch { return; }
      drawSteps(host, state, { onRetry: (button) => retryOnboarding(slug, button, host) });
      // The row in the list below carries the same five steps, so it is refreshed with them.
      await loadClients().catch(() => {});
      if (state.done === true || state.running !== true) {
        if (state.done !== true && state.retryable === true) return;
        if (state.done === true) return;
      }
      const every = Date.now() - opened < 60_000 ? 2_000 : 5_000;
      stepWatch = setTimeout(() => { void tick(); }, every);
    };
    stepWatch = setTimeout(() => { void tick(); }, 500);
  }

  async function retryOnboarding(slug, button, host) {
    if (button != null) button.disabled = true;
    try {
      const answer = await api("POST", `/v1/admin/clients/${encodeURIComponent(slug)}/onboard`, {});
      banner(String(answer.message || `${slug} picked up where it stopped.`), true);
      if (host != null) watchSteps(slug, host);
      else await loadClients().catch(() => {});
    } catch (error) { banner(String(error.message)); }
    finally { if (button != null) button.disabled = false; }
  }

  /**
   * What came back, shown ONCE, with the five steps under it.
   *
   * The temporary password is minted by the route, stored as a hash and readable from nowhere after
   * this, so this card is the only sight of it there will ever be. It is drawn ALWAYS, whatever
   * happens to the box, the model, the addresses or the mail: the one failure this card cannot have
   * is a customer with an account nobody can open. Nothing writes it anywhere else, no re-render
   * brings it back, and Refresh takes the card away.
   */
  function showNewClient(result) {
    const host = $("addClientResult");
    clear(host);
    const tenant = result.tenant ?? {};
    const name = String(tenant.name || tenant.slug || "The workspace");
    const slug = String(result.slug || tenant.slug || "");
    const card = el("div", "newClient");
    card.appendChild(el("strong", null, `${name} was created. Their computer is being built now.`));

    const password = String(result.temporaryPassword ?? "");
    if (password.length > 0) card.appendChild(el("p", "once", "This password is shown once. Copy it now."));

    const rows = [
      ["Workspace", String(tenant.slug ?? "")],
      ["Sign in at", String(result.signIn ?? "")],
      ["Email", String(result.account?.email ?? "")],
    ];
    if (password.length > 0) rows.push(["Temporary password", password]);
    const list = document.createElement("dl");
    for (const [label, value] of rows) {
      if (value.length === 0) continue;
      list.appendChild(el("dt", null, label));
      list.appendChild(el("dd", null, value));
    }
    card.appendChild(list);

    // What each of the two answers about themselves, in their own words, because "the plan model was
    // not applied" and "the plan model is what you asked for" look the same on a card that says
    // neither.
    //
    // `applied` is a BOOLEAN on the route. Printing it straight put the word "false" on the
    // operator's success card once; the `??` never fired, because false is not null.
    for (const [label, applied, asked] of [
      ["Plan model", result.planModel, String(result.planModel?.alias ?? "").length > 0],
      ["Agent ceiling", result.ceiling, result.ceiling?.asked != null],
    ]) {
      if (applied == null) continue;
      // "not applied yet" is only honest about something somebody ASKED for. Saying it about a
      // field nobody filled in reads as a failure of a thing that was never going to happen.
      const said = applied.applied === true ? "applied" : asked ? "not applied yet" : "none asked for";
      card.appendChild(el("p", "quiet", `${label}: ${said}${applied.why ? ` -- ${applied.why}` : ""}`));
    }
    if (result.welcomeMail != null) {
      const mail = result.welcomeMail;
      card.appendChild(el("p", "quiet", mail.asked === true
        ? `Welcome email: ${mail.overridden === true
          ? `it goes to ${String(mail.to ?? "")} and NOT to the owner's address, because a different address was asked for`
          : `it goes to ${String(mail.to ?? "")}`}. Replies come back to ${String(mail.replyTo ?? "the support address")}.`
        : `Welcome email: ${String(mail.why ?? "none was asked for")}`));
    }

    // The five steps, live.
    const strip = el("div", "steps");
    strip.id = "addClientSteps";
    drawSteps(strip, { steps: result.steps ?? [] });
    card.appendChild(strip);

    if (password.length > 0) {
      const copy = el("button", "ghost small", "Copy the welcome note");
      copy.type = "button";
      const note = [
        `Your Titanium Bot workspace is ready.`,
        `Sign in at ${result.signIn ?? ""}`,
        `Email: ${result.account?.email ?? ""}`,
        `Temporary password: ${password}`,
        `Change the password after the first sign-in.`,
      ].join("\n");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note);
          banner("The welcome note is on the clipboard. It carries the password, so paste it somewhere the customer and nobody else will read.", true);
        } catch {
          banner("This browser would not give the page the clipboard. Select the four lines above and copy them by hand.");
        }
      });
      card.appendChild(copy);
    }
    host.appendChild(card);
    if (slug.length > 0) watchSteps(slug, strip);
  }

  // The override field is only there when a welcome is actually going, because a field that cannot
  // do anything is a question the operator has to answer for nothing.
  const syncWelcomeTo = () => {
    const row = $("acWelcomeToRow");
    if (row != null) row.hidden = $("acWelcome")?.checked !== true;
  };
  $("acWelcome")?.addEventListener("change", syncWelcomeTo);
  syncWelcomeTo();

  $("addClientShow").addEventListener("click", () => {
    addClientForm.hidden = !addClientForm.hidden;
    if (!addClientForm.hidden) { fillAddClientModels(); syncWelcomeTo(); $("acName").focus(); }
  });
  $("addClientCancel").addEventListener("click", () => { addClientForm.hidden = true; });

  addClientForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("addClientSave");
    const ceiling = Number($("acCeiling").value);
    const sendWelcome = $("acWelcome").checked === true;
    const body = {
      email: $("acEmail").value.trim(),
      company: $("acCompany").value.trim(),
      name: $("acName").value.trim(),
      planModel: chosenPlanModel(),
      ceiling: Number.isFinite(ceiling) && ceiling > 0 ? Math.round(ceiling) : null,
      sendWelcome,
      // Only when there is one, and only when a welcome is going at all.
      welcomeTo: sendWelcome ? $("acWelcomeTo").value.trim() : "",
    };
    clear($("addClientResult"));
    banner("");
    button.disabled = true;
    try {
      const result = await api("POST", "/v1/admin/clients", body);
      showNewClient(result);
      banner(String(result.message || `${body.company} was added.`), true);
      addClientForm.reset();
      $("acCeiling").value = "40";
      $("acWelcome").checked = true;
      syncWelcomeTo();
      fillAddClientModels();
      addClientForm.hidden = true;
      await loadClients().catch(() => {});
    } catch (error) {
      // THE ROUTE'S OWN SENTENCE, UNCHANGED. Every refusal this form can produce -- an address that
      // already has an account, a company name with nothing in it to name a workspace after, a slug
      // that is taken or reserved, new workspaces switched off on this server -- is already written
      // there in words a person reads. Rewording it here would put two explanations of the same
      // refusal in the same product, and the operator would meet whichever one they happened to hit.
      banner(String(error.message));
      // The account exists and the build did not: the password still has to be shown, once, or the
      // customer has an account nobody can open.
      if (error.body?.temporaryPassword) {
        showNewClient(error.body);
        await loadClients().catch(() => {});
      }
    } finally { button.disabled = false; }
  });

  // ---- panel 3: box health ---------------------------------------------------------------------

  // The one function that keeps the screen honest: a value that was not measured renders as the
  // reason it was not, in plain words, and never as a zero or a dash.
  const measured = (value, why, format) => {
    if (value === null || value === undefined || value === "not measured") {
      const node = el("span", "quiet", "not measured");
      if (why) node.title = String(why);
      return node;
    }
    return text(format ? format(value) : String(value));
  };

  function boxChips(answer) {
    const boxes = answer.boxes ?? [];
    const answering = boxes.filter((one) => one.gatewayAnswering === true).length;
    const unknown = boxes.filter((one) => one.gatewayAnswering === null || one.gatewayAnswering === undefined).length;
    const up = boxes.filter((one) => String(one.containerState) === "running").length;
    return [
      { label: "Workspaces", value: boxes.length },
      {
        label: "Answering",
        value: `${answering} of ${boxes.length}`,
        tone: answering === boxes.length ? "good" : "bad",
        detail: unknown > 0 ? `${unknown} not measured` : "",
      },
      { label: "Containers up", value: `${up} of ${boxes.length}` },
    ];
  }

  const boxHeadline = (answer) => {
    const boxes = answer.boxes ?? [];
    const answering = boxes.filter((one) => one.gatewayAnswering === true).length;
    // A container can be running while the thing inside it is not answering, which is the whole
    // reason this panel asks twice, so the Overview counts the half that a customer would notice.
    return {
      key: "boxes",
      label: "Boxes answering",
      value: `${answering} of ${boxes.length}`,
      tone: answering === boxes.length ? "good" : "bad",
      detail: "their gateway answered when this page loaded",
    };
  };

  async function loadBoxes() {
    const answer = await api("GET", "/v1/admin/boxes");
    summarise("panel-boxes", boxChips(answer), boxHeadline(answer));
    const body = $("boxes").querySelector("tbody");
    clear(body);
    if (answer.boxes.length === 0) {
      body.appendChild(rowSpanning(7, "No workspaces yet."));
      return;
    }
    for (const box of answer.boxes) {
      const tr = document.createElement("tr");
      const name = el("td", null, box.slug);
      name.title = box.boxContainer || "no container recorded";
      name.appendChild(el("div", "quiet", age(box.ageMs)));
      tr.appendChild(name);

      const state = document.createElement("td");
      state.appendChild(measured(box.containerState === "not measured" ? null : box.containerState, box.containerStateWhy));
      tr.appendChild(state);

      const gateway = document.createElement("td");
      if (box.gatewayAnswering === null || box.gatewayAnswering === undefined) {
        gateway.appendChild(measured(null, box.gatewayWhy || "the console did not report this workspace"));
      } else {
        gateway.appendChild(el("span", `chip ${box.gatewayAnswering ? "ok" : "refused"}`, box.gatewayAnswering ? "answering" : "silent"));
        if (box.gatewayMs !== null && box.gatewayMs !== undefined) gateway.appendChild(text(` ${box.gatewayMs} ms`));
        if (!box.gatewayAnswering && box.gatewayWhy) gateway.title = box.gatewayWhy;
      }
      tr.appendChild(gateway);

      const activity = document.createElement("td");
      activity.appendChild(measured(box.lastActivityAt, box.lastActivityWhy, ago));
      if (box.lastActivityAt) activity.title = when(box.lastActivityAt);
      tr.appendChild(activity);

      const disk = el("td", "num");
      disk.appendChild(measured(box.diskKb, box.diskWhy, (kb) => bytes(Number(kb) * 1024)));
      tr.appendChild(disk);

      const memory = el("td", "num");
      memory.appendChild(measured(box.memoryBytes, box.memoryWhy, bytes));
      tr.appendChild(memory);

      const backup = document.createElement("td");
      backup.appendChild(measured(box.lastBackupStamp, box.lastBackupWhy));
      tr.appendChild(backup);

      body.appendChild(tr);
    }
    $("measuredAt").textContent = answer.measuredAt
      ? `fleet last swept ${when(answer.measuredAt)}`
      : "fleet sweep has not finished yet";
  }

  // ---- panel 4: system health ------------------------------------------------------------------

  const card = (title, value, detail, tone) => {
    const node = el("div", `card${tone ? ` ${tone}` : ""}`);
    node.appendChild(el("div", "title", title));
    const line = el("div", "value");
    if (value === null || value === undefined) {
      line.className = "value unmeasured";
      line.appendChild(text("not measured"));
    } else {
      line.appendChild(text(String(value)));
    }
    node.appendChild(line);
    if (detail) node.appendChild(el("div", "detail", detail));
    return node;
  };

  // A SUMMARY AND NOT A SECOND COPY. The cards below already say Coolify, the relay and the stuck
  // builds one by one, and repeating four of them in a strip above is furniture. What the card grid
  // cannot say is how much of ITSELF is real: this container reads some of these facts off the host
  // and cannot see the rest, so "9 of 12 measured" is the number that tells an operator whether the
  // screen below is a health report or mostly a list of reasons.
  function systemChips(answer) {
    const stuck = (answer.stuckProvisioning ?? []).length;
    const facts = [
      answer.load?.one != null,
      answer.memory?.availableBytes != null,
      ...(answer.disks ?? []).map((one) => one.freeBytes != null),
      answer.backup?.measured === true,
      answer.isolation?.measured === true,
      answer.signInRecord?.signing === true,
    ];
    const read = facts.filter(Boolean).length;
    const down = [answer.coolify?.reachable, answer.relay?.reachable].filter((one) => one !== true).length;
    return [
      {
        label: "Facts measured", value: `${read} of ${facts.length}`,
        tone: read === facts.length ? "good" : "warn",
        detail: read === facts.length ? "" : "the rest say why on their own card",
      },
      {
        label: "Not answering", value: down, tone: down === 0 ? "good" : "bad",
        detail: "Coolify and the console relay",
      },
      { label: "Builds stuck", value: stuck, tone: stuck === 0 ? "good" : "bad" },
      { label: "Sign-ins in the last day", value: answer.counts?.signInsLastDay ?? null },
    ];
  }

  async function loadSystem() {
    // KEYS-2b: THE KEYS ARE DRAWN WHATEVER THE HOST READ DOES. Both key blocks live on the Keys panel
    // and are drawn from this loader, so for one wave a 503 on /v1/admin/system -- a route that has
    // nothing to do with either credential -- left the Keys panel holding a heading and no paste
    // forms at all, while System health's own pointer went on telling the operator the keys were over
    // there. That is KEYS-2's failure shape again: the thing he came for is not where he was sent. So
    // the host read is allowed to fail on its own, the keys are drawn either way, and the host's
    // failure is re-thrown afterwards for the banner and the Overview chip that count on it.
    sayOnKeysPanel("Reading the keys...");
    let answer;
    try { answer = await api("GET", "/v1/admin/system"); }
    catch (error) { await drawKeysBlocks(); throw error; }
    summarise("panel-system", systemChips(answer));
    const host = $("system");
    clear(host);

    host.appendChild(card("Host load",
      answer.load.one === null ? null : `${answer.load.one} ${answer.load.five} ${answer.load.fifteen}`,
      answer.load.why || "one, five and fifteen minutes, read from /proc/loadavg"));

    host.appendChild(card("Host memory free",
      answer.memory.availableBytes === null ? null : bytes(answer.memory.availableBytes),
      answer.memory.why || (answer.memory.totalBytes ? `of ${bytes(answer.memory.totalBytes)}` : "")));

    for (const disk of answer.disks) {
      host.appendChild(card(`Free on ${disk.path}`,
        disk.freeBytes === null ? null : bytes(disk.freeBytes),
        disk.why || (disk.totalBytes ? `of ${bytes(disk.totalBytes)}` : "")));
    }

    host.appendChild(card("Coolify",
      answer.coolify.reachable ? "reachable" : "not answering",
      answer.coolify.why || answer.coolify.url || "",
      answer.coolify.reachable ? "good" : "bad"));

    host.appendChild(card("Console relay",
      answer.relay.reachable ? "reachable" : "not answering",
      answer.relay.why || answer.relay.url || "",
      answer.relay.reachable ? "good" : "bad"));

    host.appendChild(card("Mail webhook", null, answer.mailWebhook.why));

    // Without this card, a ledger that cannot sign looks exactly like a quiet day: every address
    // reads "no password reached the check" and nothing is flagged.
    if (answer.signInRecord) {
      host.appendChild(card("Sign-in record",
        answer.signInRecord.signing ? "being written" : "not being written",
        answer.signInRecord.why,
        answer.signInRecord.signing ? "good" : "bad"));
    }

    host.appendChild(card("Nightly backup",
      answer.backup.measured ? answer.backup.stamp : null,
      answer.backup.measured
        ? `${answer.backup.mode === "consistent" ? "everything was paused for the copy" : "taken while things were running"}, ${answer.backup.tenantCount} workspace${answer.backup.tenantCount === 1 ? "" : "s"}, ${answer.backup.storeDbCount} agent databases, taken ${when(answer.backup.takenAt)}`
        : answer.backup.why,
      answer.backup.measured && answer.backup.mode === "consistent" ? "good" : ""));

    host.appendChild(card("Box isolation check",
      answer.isolation.measured ? (answer.isolation.ok ? "no box reaches another" : "a box-to-box path is open") : null,
      answer.isolation.measured ? `checked ${when(answer.isolation.at)}` : answer.isolation.why,
      answer.isolation.measured ? (answer.isolation.ok ? "good" : "bad") : ""));

    host.appendChild(card("Builds that never finished",
      answer.stuckProvisioning.length,
      answer.stuckProvisioning.length === 0
        ? "no workspace has been stuck building"
        : answer.stuckProvisioning.map((row) => `${row.slug} since ${when(row.since)} at step ${row.lastStep}`).join("; "),
      answer.stuckProvisioning.length === 0 ? "good" : "bad"));

    host.appendChild(card("Sign-ins in the last day", answer.counts.signInsLastDay,
      `${answer.counts.tenants} workspaces, ${answer.counts.accounts} people, ${answer.counts.superAdmins} super admin${answer.counts.superAdmins === 1 ? "" : "s"}`));

    $("version").textContent = `control plane ${answer.version} - measured ${when(answer.measuredAt)}`;

    // KEYS-2 MOVED BOTH BLOCKS OFF THIS PANEL AND LEFT THEM DRAWN FROM HERE. They belong on the Keys
    // panel, which is where Jason went looking for them and could not find them, but they are still
    // drawn by this loader and out of this loader's own answer: the push doors and the product keys
    // each cost one request that only loadSystem makes, and giving the Keys panel a loader of its own
    // would be a second fetch of the same two answers plus a ninth thing for the readiness flag to
    // wait on. So the only thing that changed is WHERE they are appended.
    //
    // Both blocks are built in script rather than written into cp/admin/index.html for the reason
    // PUSH-1 recorded: three worktrees were open on this repo the week it landed and index.html was
    // one of them. That still holds, so the page file carries the shell and nothing else.
    //
    // ORDER IS PAINT ORDER AND IT IS THE POINT. Each function ends in host.parentNode.appendChild,
    // so whichever is called first is the one on top, and the keys are what an operator came to the
    // panel for: drawProductKeys before drawPushDoors puts the three paste rows above the two phone
    // forms. Swap these two lines and the xAI field goes back under a .p8 textarea, which is the
    // whole of what KEYS-2 was.
    //
    // The fallback is one token and it keeps a missing container from throwing on .parentNode. It is
    // reachable only from a build where index.html and admin.js are one deploy apart, which this
    // service makes impossible on purpose (cp/admin.mjs serves all three files no-store), so it is a
    // belt and not a behaviour.
    await drawKeysBlocks();
  }

  // The two blocks, onto the Keys panel, and the one line that panel carries while neither is there
  // yet. Its own function because loadSystem calls it on BOTH paths (KEYS-2b above): a panel that only
  // draws when an unrelated route succeeds is a panel that reads as empty-by-design.
  async function drawKeysBlocks() {
    const keys = $("keys");
    // The fallback is one token and it keeps a missing container from throwing on .parentNode. It is
    // reachable only from a build where index.html and admin.js are one deploy apart, which this
    // service makes impossible on purpose (cp/admin.mjs serves all three files no-store), so it is a
    // belt and not a behaviour.
    const keysHost = keys ?? $("system");
    // Only the real container. The error card each draw function falls back to is appended to the
    // HOST rather than to its own block, and nothing else clears #keys, so without this a control
    // plane whose key route is down would stack one more card on every Refresh and on every
    // successful paste. Clearing the fallback instead would wipe System health's own cards.
    if (keys != null) clear(keys);
    await drawProductKeys(keysHost);
    await drawPushDoors(keysHost);
    // By now the panel holds either the blocks or each draw's own card saying why it does not, and
    // both of those say more than this line does.
    sayOnKeysPanel(null);
  }

  // One line above the Keys panel's cards, for the window in which neither block is drawn yet. null
  // takes it away. Written here rather than in cp/admin/index.html for the reason PUSH-1 recorded:
  // the page file carries the shell and nothing that changes.
  const KEYS_WAITING_ID = "keysWaiting";

  function sayOnKeysPanel(text) {
    const panel = document.getElementById("panel-keys");
    if (panel == null) return;
    const line = document.getElementById(KEYS_WAITING_ID);
    if (text == null) { if (line != null) line.remove(); return; }
    if (line != null) { line.textContent = text; return; }
    const made = el("p", "quiet", text);
    made.id = KEYS_WAITING_ID;
    const cards = $("keys");
    if (cards != null && cards.parentNode === panel) panel.insertBefore(made, cards);
    else panel.appendChild(made);
  }

  // ---- PUSH-1: the two push credentials ---------------------------------------------------------
  //
  // TWO PASTE FORMS, shaped exactly like the Feedback panel's repository-token form, because they
  // are the same kind of thing and a second shape for the same act is how one of them grows a habit
  // the other does not have. The rules, stated on the forms themselves so nobody has to find this
  // comment:
  //
  //   Nothing here ever shows a stored value again. What comes back is a length and eight characters
  //   of a digest, which is the same string the ledger keeps forever.
  //   The vendor is asked whether it takes the credential BEFORE anything is stored, and one it
  //   refuses is not kept. Apple is asked by sending to a deliberately malformed device token, where
  //   400 BadDeviceToken means the key worked and a 403 means it did not; Firebase is asked with
  //   validate_only, which is a free dry run.
  //   Neither credential is ever pushed into a customer's box.
  //   With neither stored the relay still runs the whole mechanism and records what it WOULD have
  //   sent, which is what this wave's gates measured. That is said on the screen, not assumed.

  const PUSH_BLOCK_ID = "pushDoors";

  function pushPasteForm({ id, fields, submit, why, onSave }) {
    const form = el("form", "keyForm");
    form.id = `${id}Form`;
    const inputs = new Map();
    for (const field of fields) {
      const node = document.createElement(field.rows ? "textarea" : "input");
      node.id = `${id}-${field.name}`;
      if (!field.rows) node.type = field.secret ? "password" : "text";
      else node.rows = field.rows;
      node.autocomplete = "off";
      node.placeholder = field.placeholder;
      if (field.value) node.value = field.value;
      inputs.set(field.name, { node, field });
      form.appendChild(node);
    }
    const button = el("button", "ghost small", submit);
    button.type = "submit";
    form.appendChild(button);
    form.appendChild(el("span", "why", why));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {};
      for (const [name, held] of inputs) payload[name] = held.node.value;
      const missing = [...inputs.values()].filter((held) => held.field.required !== false && String(held.node.value).trim().length === 0);
      if (missing.length > 0) { banner(`Fill in ${missing.map((held) => held.field.placeholder).join(" and ")} before storing anything.`); return; }
      // Cleared on the way OUT, not on the way back, so a failed request leaves nothing in the field
      // either. Nothing on this page ever writes a secret value back into one.
      for (const held of inputs.values()) if (held.field.secret || held.field.rows) held.node.value = "";
      button.disabled = true;
      try {
        const result = await onSave(payload);
        banner(`${String(result.message)} It is stored as ${result.evidence}, checked against ${result.checkedWith}.`, true);
        await loadSystem();
      } catch (error) { banner(String(error.message)); }
      finally { button.disabled = false; }
    });
    return form;
  }

  async function drawPushDoors(host) {
    let door;
    try { door = await api("GET", "/v1/admin/push"); }
    catch (error) {
      host.appendChild(card("Waking a phone", null, `the push credentials could not be read: ${String(error.message)}`));
      return;
    }
    const old = document.getElementById(PUSH_BLOCK_ID);
    if (old) old.remove();
    const block = el("section", "pushDoors");
    block.id = PUSH_BLOCK_ID;
    block.appendChild(el("h3", null, "Waking a phone"));
    block.appendChild(el("p", "quiet", door.stub
      ? door.stub
      : "A card that needs a person reaches their phone through these two. Each is checked with the vendor before it is stored and neither is ever pushed into a customer's box."));

    block.appendChild(el("h4", null, "Apple, for iPhones and Macs"));
    block.appendChild(el("p", "quiet", door.apns.stored
      ? `Stored for ${door.apns.bundleId}, key ${door.apns.keyId}, team ${door.apns.teamId}. The key is ${door.apns.evidence}, and nothing here can show it. Paste a new one to replace it.`
      : String(door.apns.why)));
    block.appendChild(pushPasteForm({
      id: "apns",
      submit: "Check it with Apple and store it",
      fields: [
        { name: "keyId", placeholder: "key id", value: door.apns.keyId },
        { name: "teamId", placeholder: "team id", value: door.apns.teamId },
        { name: "bundleId", placeholder: "bundle id, like bot.titanium.app", value: door.apns.bundleId },
        { name: "key", placeholder: "paste the whole .p8 file, including the BEGIN PRIVATE KEY line", rows: 4, secret: true },
      ],
      why: "Apple is sent one notification addressed to a token that cannot be a real device. It has to answer"
        + " BadDeviceToken, which means it read the key and refused only the address; a refusal of the key itself"
        + " is not stored. The key never leaves this service except to the console relay, and never into a box.",
      onSave: (payload) => api("POST", "/v1/admin/push/apns", payload),
    }));

    block.appendChild(el("h4", null, "Firebase, for Android phones"));
    block.appendChild(el("p", "quiet", door.fcm.stored
      ? `Stored for project ${door.fcm.projectId}. The service account is ${door.fcm.evidence}, and nothing here can show it. Paste a new one to replace it.`
      : String(door.fcm.why)));
    block.appendChild(pushPasteForm({
      id: "fcm",
      submit: "Check it with Firebase and store it",
      fields: [
        { name: "projectId", placeholder: "project id (or leave it, the JSON carries one)", value: door.fcm.projectId, required: false },
        { name: "serviceAccount", placeholder: "paste the service account JSON Firebase downloaded", rows: 4, secret: true },
      ],
      why: "Firebase is sent one message with validate_only, which is a free dry run it never delivers."
        + " A service account it will not mint a messaging token for is not stored. The JSON never leaves this"
        + " service except to the console relay, and never into a box.",
      onSave: (payload) => api("POST", "/v1/admin/push/fcm", payload),
    }));

    host.parentNode.appendChild(block);
  }

  // ---- end PUSH-1 ------------------------------------------------------------------------------

  // ---- KEYS-1: the keys the product uses -------------------------------------------------------
  //
  // THREE PASTE FORMS, and the reason they are here at all is a thing Jason said on 2026-09-10,
  // looking at a customer's own settings panel: "A user is never going to put a resend key in. That's
  // on the backend." Until this block, two vendor keys were typed by a CUSTOMER into their own
  // console -- the realtime voice key and the mail sending key. They are the operator's now. They are
  // pasted here once, stored write-only, and read by one thing: the console relay, behind its own
  // credential, in memory, never into a box.
  //
  // The shape is pushPasteForm's, unchanged, which is the same shape the Feedback panel's repository
  // token uses, because they are the same act and a second shape for one act is how one of them grows
  // a habit the other does not have. It clears the field on the way OUT, so a failed request leaves
  // nothing behind either, and nothing on this page ever writes a value back into a field.
  //
  // VENDOR NAMES ARE ALLOWED HERE AND NOWHERE A CUSTOMER CAN READ. This is the operator's screen and
  // he has to know which account a key comes from.
  //
  // NOT HERE: the inbound mail signing secret. It looks like the fourth member of this set and it is
  // not -- it is a routing discriminator, not a vendor credential (when two workspaces claim one mail
  // domain the one whose secret verifies THIS body gets the message), so one global value in front of
  // every edge would let the first claimant read another customer's mail. It stays on each
  // workspace's own file. cp/secrets.mjs and docs/MAIL.md both say so.

  const KEYS_BLOCK_ID = "productKeys";

  async function drawProductKeys(host) {
    let door;
    try { door = await api("GET", "/v1/keys"); }
    catch (error) {
      host.appendChild(card("Keys the product uses", null, `the keys could not be read: ${String(error.message)}`));
      return;
    }
    const old = document.getElementById(KEYS_BLOCK_ID);
    if (old) old.remove();
    const block = el("section", "pushDoors");
    block.id = KEYS_BLOCK_ID;
    block.appendChild(el("h3", null, "Keys the product uses"));
    block.appendChild(el("p", "quiet", "Paste each one once. They are stored write-only: this page never shows one again,"
      + " and the only thing that reads them is the product itself. No customer ever sees a key field."
      + " Each is checked with the vendor before it is stored, and a key the vendor refuses is not kept."));

    for (const row of door.keys ?? []) {
      block.appendChild(el("h4", null, String(row.label)));
      block.appendChild(el("p", "quiet", row.stored
        ? `Stored ${Number(row.at) > 0 ? when(new Date(Number(row.at)).toISOString()) : "at some point"}${row.actor ? ` by ${row.actor}` : ""}. It is ${row.evidence}, and nothing here can show it. Paste a new one to replace it.`
        : `Not set. ${String(row.why)}`));
      block.appendChild(pushPasteForm({
        id: String(row.name).replace(/[^a-z0-9]+/gi, "-"),
        submit: "Check it with the vendor and store it",
        fields: [{ name: "value", placeholder: String(row.placeholder), secret: true }],
        why: "The vendor is asked one cheap authenticated question before anything is stored. The key"
          + " leaves this service only to the console relay, which holds it in memory and never writes"
          + " it beside a file or pushes it into a box.",
        onSave: (payload) => api("POST", `/v1/keys/${encodeURIComponent(String(row.name))}`, payload),
      }));
    }

    host.parentNode.appendChild(block);
  }

  // ---- end KEYS-1 ------------------------------------------------------------------------------

  // ---- panel 5: spend --------------------------------------------------------------------------

  // THE ONE PLACE A TOTAL COULD LIE. Summing dollars across workspaces turns every unmeasured one
  // into a zero, and a total that quietly left three customers out reads exactly like a quiet month.
  // So a window where NOTHING was measured says so, and a window where only some were carries the
  // count of the ones missing from it.
  function spendChips(answer) {
    if (answer.configured === false) {
      const why = String(answer.why ?? "the proxy could not be asked");
      return [
        { label: "Tokens in", value: null, why },
        { label: "Tokens out", value: null, why },
        { label: "Cost", value: null, why },
        { label: "This month", value: null, why },
      ];
    }
    const clients = answer.clients ?? [];
    const total = (pick) => {
      const seen = clients.map(pick).filter((one) => Number.isFinite(Number(one)));
      return seen.length === 0 ? null : dollars(seen.reduce((sum, one) => sum + Number(one), 0));
    };
    const missing = clients.filter((one) => !Number.isFinite(Number(one.thisMonth?.dollars))).length;
    const providers = Array.isArray(answer.byProvider) ? answer.byProvider : [];
    const top = (field) => providers
      .filter((row) => Number(row[field]) > 0)
      .sort((a, b) => Number(b[field]) - Number(a[field]) || String(a.provider).localeCompare(String(b.provider)))[0]?.provider ?? "no usage recorded";
    const cost = {
      label: "Cost",
      value: clients.length === 0 ? dollars(0) : total((one) => one.thisMonth?.dollars),
      detail: top("cost"),
    };
    const monthlyCost = {
      label: "This month",
      value: cost.value,
      detail: missing > 0 ? `${missing} workspace${missing === 1 ? "" : "s"} not measured` : "",
      why: missing > 0 ? "This total leaves out the workspaces the proxy could not be asked about." : "",
      tone: missing > 0 ? "warn" : "",
    };
    return [
      {
        label: "Tokens in",
        value: countWords(answer.totals?.tokensIn, true),
        detail: top("tokensIn"),
      },
      {
        label: "Tokens out",
        value: countWords(answer.totals?.tokensOut, true),
        detail: top("tokensOut"),
      },
      cost,
      monthlyCost,
      { label: "Today", value: clients.length === 0 ? dollars(0) : total((one) => one.today?.dollars) },
      { label: "Workspaces", value: clients.length },
    ];
  }

  const spendHeadline = (answer) => {
    const cost = spendChips(answer).find((chip) => chip.label === "This month") ?? spendChips(answer)[0];
    return { ...cost, key: "spend", label: "Spend this month" };
  };

  /** Provider/model usage nested under a workspace without changing the Spend table's six columns. */
  function usageTable(client) {
    if (client.usage === null) return el("div", "quiet spend-no-usage", "usage not measured this month");
    const usage = Array.isArray(client.usage) ? client.usage : [];
    if (usage.length === 0) return el("div", "quiet spend-no-usage", "no usage recorded this month");
    const table = el("table", "spend-usage");
    const head = document.createElement("thead");
    const heading = document.createElement("tr");
    for (const label of ["Provider", "Model", "In", "Out", "Calls", "Cost"]) heading.appendChild(el("th", null, label));
    heading.appendChild(el("th", null, "List price"));
    head.appendChild(heading);
    table.appendChild(head);
    const body = document.createElement("tbody");
    const totals = new Map();
    for (const line of usage) {
      const tr = document.createElement("tr");
      const listPrice = line.listPrice == null ? "not recorded" : `$${Number(line.listPrice.input).toFixed(2)} / $${Number(line.listPrice.output).toFixed(2)} per 1M in/out`;
      const model = line.tier === "talk" || line.tier === "work" ? `${line.model} · ${line.tier}` : line.model;
      for (const value of [
        line.provider, model, countWords(line.tokensIn), countWords(line.tokensOut), countWords(line.calls), money.format(Number(line.cost) || 0), listPrice,
      ]) tr.appendChild(el("td", null, value));
      body.appendChild(tr);
      const sum = totals.get(line.provider) ?? { tokensIn: 0, tokensOut: 0, calls: 0, cost: 0 };
      sum.tokensIn += Number(line.tokensIn) || 0;
      sum.tokensOut += Number(line.tokensOut) || 0;
      sum.calls += Number(line.calls) || 0;
      sum.cost += Number(line.cost) || 0;
      totals.set(line.provider, sum);
    }
    for (const [provider, sum] of totals) {
      const tr = el("tr", "spend-provider-total");
      for (const value of [
        // The list-price cell is EMPTY on a rollup row rather than a dash. A rollup covers several
        // models at several prices, so there is no one price to print, and this page's own rule is
        // that a figure nobody can state says so in words and never "a zero, a dash, or a green
        // tick" (docs/ADMIN.md). It held an em dash, which was also the one em dash on the console
        // and a latent failure of verify-admin's own sweep for them. Found and fixed while adding
        // the Support panel; nothing else on this row moved.
        provider, "by provider", countWords(sum.tokensIn), countWords(sum.tokensOut), countWords(sum.calls), money.format(sum.cost), "",
      ]) tr.appendChild(el("td", null, value));
      body.appendChild(tr);
    }
    table.appendChild(body);
    return table;
  }

  // CODE-1. What a workspace's coding tasks cost, as ONE QUIET LINE inside the Client cell of the
  // Spend table and not as a seventh column: a column would mean editing cp/admin/index.html and the
  // literal 6 in three rowSpanning calls, and three waves are in this file this week.
  //
  // It is its own fetch rather than a field on /v1/admin/spend, because that route lives in
  // cp/admin.mjs and this wave does not edit that file. A second request on one panel is the cost of
  // that, and it is paid on a panel the operator opens rather than on anything a customer waits for.
  //
  // THE PANEL'S OWN HONESTY RULE IS KEPT. A read that failed says so and why; a task whose key could
  // not be asked about is counted and named rather than summed as a zero; and an E2B task says its
  // model spend is not metered here at all. None of those three ever draws $0.00.
  async function codeLines() {
    try {
      const answer = await api("GET", "/v1/code/tasks");
      const byTenant = new Map();
      for (const row of Array.isArray(answer?.tenants) ? answer.tenants : []) byTenant.set(String(row.slug), row);
      return { ok: true, byTenant };
    } catch (error) {
      return { ok: false, why: String(error?.message ?? error), byTenant: new Map() };
    }
  }

  /**
   * One line of words about one workspace's coding tasks, or nothing at all when it has had none.
   *
   * A FAILED READ IS SAID ONCE, on the panel's own note below, and not on every row: the failure is
   * about the whole read rather than about one client, and six copies of one sentence down a column
   * is the noise that makes a person stop reading the column.
   */
  function codeLine(code, slug) {
    if (code.ok !== true) return null;
    const row = code.byTenant.get(String(slug));
    if (row == null) return null;
    const measured = Number(row.tasks) - Number(row.spendUnmeasured ?? 0);
    const parts = [`${row.tasks} coding task${Number(row.tasks) === 1 ? "" : "s"}`, `${row.minutes} minute${Number(row.minutes) === 1 ? "" : "s"}`];
    // A dollar figure only where a key was really read. Where none was, the words say which, because
    // "$0.21" beside four tasks of which two were never measured is a number an operator would
    // budget against.
    parts.push(measured > 0 ? `${dollars(row.spendUsd)}${measured < Number(row.tasks) ? ` over ${measured} of them` : ""}` : "spend not measured");
    const node = el("div", "quiet", parts.join(", "));
    const notes = [];
    if (Number(row.running) > 0) notes.push(`${row.running} running now`);
    if (row.e2bNote) notes.push(row.e2bNote);
    if (Number(row.minutesUnmeasured ?? 0) > 0) notes.push(`${row.minutesUnmeasured} carry no minutes, so that total is a floor`);
    if (notes.length > 0) node.title = notes.join("; ");
    return node;
  }

  async function loadSpend() {
    const answer = await api("GET", "/v1/admin/spend");
    const code = await codeLines();
    summarise("panel-spend", spendChips(answer), spendHeadline(answer));
    const body = document.querySelector("#spend tbody");
    clear(body);
    $("spendNote").textContent = (answer.configured
      ? `${answer.note} Month is ${answer.window.month} UTC.${answer.enforced ? "" : " This server is in observe mode, so an allowance is recorded and nothing is stopped."}`
      : `Not measured: ${answer.why}`)
      // CODE-1. Coding tasks are a line under each client in the table. When THAT read failed the
      // words say so here, once, rather than a zero or a silent gap where minutes should be.
      + (code.ok === true ? "" : ` Sandbox minutes not measured: ${code.why}.`);
    if (answer.clients.length === 0) {
      body.appendChild(rowSpanning(6, "No customers yet."));
      return;
    }
    for (const client of answer.clients) {
      const tr = document.createElement("tr");
      const who = document.createElement("td");
      who.appendChild(el("strong", null, client.name || client.slug));
      who.appendChild(el("div", "quiet", client.slug));
      if (client.tokenAllowance != null) {
        who.appendChild(allowanceBar(client.tokenAllowance, "spendCycleAllowance"));
        const cycle = client.tokenAllowance.cycle;
        who.appendChild(el("div", "quiet", client.tokenAllowance.used == null
          ? "this cycle: not recorded"
          : `this cycle: ${Math.round(client.tokenAllowance.pct)}% of ${countWords(client.tokenAllowance.cap)}, resets in ${cycle.daysLeft} days`));
      }
      // CODE-1's one additive line. Nothing at all for a workspace that has run no coding task: an
      // empty row of zeroes on every client would be five-sixths noise.
      const coding = codeLine(code, client.slug);
      if (coding != null) who.appendChild(coding);
      who.appendChild(usageTable(client));
      tr.appendChild(who);

      // A ZERO FROM A PROXY NOBODY ASKED IS NOT A ZERO. With no proxy configured this route still
      // answers a row per customer with 0.00 on it, and the table drew $0.00 and "0 requests" beside
      // a note that says in words that nothing was measured. Two answers to one question an inch
      // apart, and the wrong one is the one that looks like data. Found on this Mac 2026-09-09 in a
      // screenshot of this panel, with the summary strip above it reading not measured.
      const asked = answer.configured !== false;
      const window = (one) => {
        const cell = document.createElement("td");
        cell.appendChild(measured(asked ? dollars(one.dollars) : null, one.why || client.why || answer.why));
        cell.appendChild(el("div", "quiet", !asked || one.requests === null || one.requests === undefined
          ? "requests not measured"
          : `${one.requests} request${one.requests === 1 ? "" : "s"}`));
        return cell;
      };
      tr.appendChild(window(client.thisMonth));
      tr.appendChild(window(client.today));

      const against = document.createElement("td");
      for (const node of allowanceChips(client)) against.appendChild(node);
      if (client.allowance != null) against.appendChild(el("div", "quiet", `plan includes ${dollars(client.allowance)} a month`));
      tr.appendChild(against);

      // Requests and never dollars. The web tools are priced per request on our side and an agent
      // run's real credits vary, so a dollar figure here would look precise and would not be.
      const web = document.createElement("td");
      web.appendChild(measured(client.tinyfish.requests, client.tinyfish.why, (value) => `${value} request${value === 1 ? "" : "s"}`));
      tr.appendChild(web);

      const key = document.createElement("td");
      key.appendChild(el("div", "mono", client.alias || "not minted"));
      // The alias and the key id. Never the key: it is a live credential for that customer's box,
      // and this page is a browser.
      if (client.keyId) key.appendChild(el("div", "quiet mono", `${String(client.keyId).slice(0, 12)}...`));
      if (client.mintedAt) key.appendChild(el("div", "quiet", `minted ${ago(client.mintedAt)}`));
      tr.appendChild(key);
      body.appendChild(tr);
    }
    await loadVoiceSpend();
  }

  // ---- VOICE-1: what each workspace spent talking ----------------------------------------------
  //
  // A BLOCK UNDER THE TABLE AND NOT A SEVENTH COLUMN. rowSpanning(6) above and every row build in
  // loadSpend depend on that six, and a spoken minute is not a dollar anyway: nothing in this product
  // prices voice yet, so a number in the money table would be read as money.
  //
  // THREE METERS, AND EVERY LINE SAYS WHICH. Wall clock is what the caps count and what a person can
  // predict; audio seconds in and out are what a vendor's invoice is built from; billable text events
  // are a flat fee each on the default provider and free for a tool result. A single "minutes" figure
  // reconciles against neither invoice, so there is no single figure here.
  //
  // NOT MEASURED IS WORDS, NEVER 0 MINUTES, for the reason written over the table above after a real
  // screenshot bug: a zero from a meter nobody has ever reported looks exactly like a zero from a
  // meter that was read, and the wrong one of those is the one that looks like data.
  const minutesWords = (seconds) => {
    const whole = Math.max(0, Math.round(Number(seconds) || 0));
    if (whole < 60) return `${whole} second${whole === 1 ? "" : "s"}`;
    const minutes = Math.round(whole / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  };

  async function loadVoiceSpend() {
    // The block makes its own node on first load and reuses it afterwards, so this adds nothing to
    // cp/admin/index.html and no class that admin.css has never heard of: h3, p.quiet and strong are
    // all already styled, which is why there is no new rule in that file either.
    const host = $("spendVoice") ?? (() => {
      const node = document.createElement("div");
      node.id = "spendVoice";
      document.querySelector("#panel-spend")?.appendChild(node);
      return node;
    })();
    clear(host);
    host.appendChild(el("h3", null, "Voice"));

    let answer = null;
    try { answer = await api("GET", "/v1/voice/usage"); }
    catch (error) {
      host.appendChild(el("p", "quiet", `Not measured: ${String(error?.message ?? error)}`));
      return;
    }
    if (answer?.everMeasured !== true) {
      host.appendChild(el("p", "quiet",
        `Not measured: ${String(answer?.why ?? "no voice session has been reported to this service yet")}.`
        + " Nobody has talked to their team yet, which is not the same thing as nought minutes."));
      return;
    }
    const month = String(answer?.window?.month ?? "");
    host.appendChild(el("p", "quiet",
      `One line per workspace for ${month || "this window"} UTC. Wall clock is what the caps count;`
      + " audio seconds are what a provider bills on; billable events are the flat per-message fee on"
      + " the default provider and are free for a tool result."));
    const tenants = Array.isArray(answer.tenants) ? answer.tenants : [];
    if (tenants.length === 0) {
      host.appendChild(el("p", "quiet", "No workspace has talked this month. Earlier months have rows."));
      return;
    }
    for (const line of tenants) {
      const row = el("p", "quiet");
      row.appendChild(el("strong", null, line.slug));
      row.appendChild(text(
        ` ${minutesWords(line.wallSeconds)} of wall clock`
        + ` · ${minutesWords(line.audioInSeconds)} heard and ${minutesWords(line.audioOutSeconds)} spoken (a provider's meter)`
        + ` · ${line.billedItemEvents} billable event${line.billedItemEvents === 1 ? "" : "s"}`
        + ` · ${line.sessions} session${line.sessions === 1 ? "" : "s"}`
        + `, ${line.toolCalls} handed to the team`
        + (line.open > 0 ? ` · ${line.open} still open, counted at what it has run so far` : "")));
      host.appendChild(row);
    }
  }

  // ---- panel 6: providers, keys and plan models ------------------------------------------------
  //
  // THE ROUTE CONTRACT THIS PANEL IS WRITTEN AGAINST. PROVIDERS-1, version 2. The whole panel is
  // one GET, because every part of it is read together and a page that fired six requests would
  // render in six stages on a bad connection.
  //
  //   GET /v1/admin/providers
  //     { configured, why, db: { on, why }, measuredAt,
  //       providers: [{ id, name, kind, baseUrl, fromPreset, bootstrapEnv,
  //                     health: { reachable, why, checkedAt, how, requests, failures },
  //                     catalog: { models: [id], live, readAt, why, note, ready, liveNeedsKey,
  //                                leftoverDoor },
  //                     keys: [{ slot, label, order, masked, parked,
  //                              serves: [alias], lastError: { at, why } | null,
  //                              spend: { month, requests, tokens, priced, why },
  //                              quota: { unit, window, used, total, remaining, pct, resetAt,
  //                                       warn, live, why, byWorkspace: [{ slug, requests,
  //                                       tokens, dollars }] } }] }],
  //       planModels: [{ alias, provider, vendorModel, customerName, customerLabel, servedBy,
  //                      contextWindow, inputCostPerToken, outputCostPerToken, priced, pricedWhy,
  //                      supportsVision, visionFallback, vision: { ok, at, why },
  //                      plans, customerVisible, shownToCustomers,
  //                      deployments: [{ id, keySlot, fromDb, healthy, why }],
  //                      workspaces, workspaceSlugs, workspacesWhy, runningHere,
  //                      labelBehind, labelBehindSlugs, labelBehindWhy }],
  //       pricing: { unpriced: [alias], why },
  //       defaults: { planModel, why },
  //       actions: [{ at, actor, via, ip, action, target, detail, outcome }] }
  //
  //   POST /v1/admin/providers                                   { id, name, kind, baseUrl,
  //                                                                catalogBaseUrl?, catalogPath? }
  //   POST /v1/admin/providers/:id/keys                          { label, apiKey, slot?, order? }
  //   POST /v1/admin/providers/:id/keys/:slot/roll               { apiKey, force? }
  //   POST /v1/admin/providers/:id/keys/:slot/park               { parked }
  //   POST /v1/admin/providers/:id/keys/:slot/remove             { confirm: "<slot>" }
  //   POST /v1/admin/providers/:id/keys/:slot/quota              { total, unit, window, resetAt }
  //   POST /v1/admin/providers/:id/catalog/refresh               { apiKey? }
  //   POST /v1/admin/providers/:id/health                        {}
  //   POST /v1/admin/plan-models                                 { alias, provider, keySlots: [],
  //                                                                vendorModel, customerName,
  //                                                                customerLabel, servedBy,
  //                                                                customerVisible, supportsVision,
  //                                                                visionFallback, contextWindow,
  //                                                                inputCostPerToken?,
  //                                                                outputCostPerToken?, plans }
  //   POST /v1/admin/plan-models/:alias/update                   any of the above but alias
  //   POST /v1/admin/plan-models/:alias/keys                     { keySlots: [] }
  //   POST /v1/admin/plan-models/:alias/vision-check             {}
  //   POST /v1/admin/plan-models/:alias/apply                    {}
  //   POST /v1/admin/plan-models/:alias/push-label               { slugs: [] }; an empty body
  //                                                                answers 409 with `candidates`
  //                                                                and changes nothing, and this
  //                                                                page always sends the empty one
  //                                                                first. { all: true } exists for
  //                                                                cp/cli.mjs, where the operator
  //                                                                has typed the alias.
  //   POST /v1/admin/defaults                                    { planModel }
  //   POST /v1/admin/clients/:slug/model                         { planModel, pushLabel? }
  //
  // Every write answers { message } and never a key value. The names above are cp/admin.mjs's own
  // and cp/PROVIDERS-ROUTES.md's: the panel and the route were written in parallel against that
  // document, and where this file once used a different word for the same field the panel drew an
  // empty card against a route that was answering perfectly.

  // The three clocks, in the words the operator reads. There is no fourth, and there is no bare
  // "takes effect immediately" anywhere on this page: the proxy, a box and a customer's open tab
  // each pick a change up at a different moment and saying otherwise is how PROXY-10 cost a day.
  const CLOCK = {
    proxy: "The proxy uses this on the next request. A workspace picks it up on its next turn.",
    label: "A workspace picks this up on its next turn, once you push it. A customer's open page shows it the next time that page loads.",
    added: "A new model reaches a customer's list within a minute, and only once every workspace has been given access to it.",
    customerPage: "A customer's open page shows this the next time that page loads.",
  };

  // What the panel holds between renders. Only the answer: no key value is ever kept here, and no
  // form value survives a reload of the panel.
  let providersAnswer = { providers: [], planModels: [], defaults: {}, actions: [] };
  let editingAlias = "";

  // The one wrapper every action on this panel goes through: disabled in flight, a banner either
  // way, the panel reloaded, and the button put back in a finally. Exactly the shape the client
  // and user actions above already use.
  const act = async (button, run) => {
    button.disabled = true;
    try {
      const result = await run();
      banner(String(result?.message ?? "Done."), true);
      await loadProviders();
    } catch (error) {
      banner(String(error.message));
    } finally {
      button.disabled = false;
    }
  };

  const option = (value, label) => {
    const node = document.createElement("option");
    node.value = String(value ?? "");
    node.appendChild(text(label ?? value));
    return node;
  };
  const fill = (select, options, selected) => {
    clear(select);
    for (const one of options) select.appendChild(option(one.value, one.label));
    select.value = String(selected ?? "");
    if (select.value !== String(selected ?? "") && select.options.length > 0) select.selectedIndex = 0;
  };

  // A count that might not have been measured. Never a zero standing in for "nobody asked".
  const countWord = (value, one, many) => (value === 1 ? one : many.replace("{n}", String(value)));

  /**
   * ONE SUBSCRIPTION'S PLAN WINDOW. The vendor sells a window (Alibaba a 7-day token plan, Z.AI
   * prompts in a 5-hour window and a month, MiniMax its own), and the number that matters is how
   * much of THAT is gone. Nothing on this build reads it from the vendor, so the total and the
   * reset are typed in off the vendor's own page and what we count against them is our own count
   * out of the proxy's request log. The cell says which half is which rather than drawing a bar
   * that looks measured when half of it was typed.
   */
  function quotaCell(key) {
    const cell = document.createElement("td");
    const quota = key.quota ?? null;
    if (quota == null || quota.total == null) {
      const none = el("span", "quiet", "not set");
      none.title = String(quota?.why || "No plan size is recorded for this subscription, so there is no window to draw.");
      cell.appendChild(none);
      return cell;
    }
    const bar = el("div", "quotaBar");
    const fill = el("div", quota.warn ? "quotaFill warn" : "quotaFill");
    fill.style.width = `${Math.min(100, Math.max(0, Number(quota.pct ?? 0)))}%`;
    bar.appendChild(fill);
    cell.appendChild(bar);
    const line = el("div", "quiet", `${Number(quota.remaining ?? 0).toLocaleString()} of ${Number(quota.total).toLocaleString()} ${quota.unit} left`);
    line.title = String(quota.why || "");
    cell.appendChild(line);
    if (quota.resetAt) cell.appendChild(el("div", "quiet", `resets ${ago(quota.resetAt)}`));
    if (quota.warn) cell.appendChild(el("span", "chip refused", `${quota.pct}% used`));
    // WHICH CUSTOMER used it, inside the same window. The second half of what this was asked for:
    // a shared subscription with no per-workspace split is a bill nobody can explain.
    const share = Array.isArray(quota.byWorkspace) ? quota.byWorkspace : [];
    if (share.length > 0) {
      const who = el("div", "quiet", share.slice(0, 3).map((one) => `${one.slug} ${one.requests}`).join(", "));
      who.title = share.map((one) => `${one.slug}: ${one.requests} requests, ${one.tokens.toLocaleString()} tokens`).join("\n");
      cell.appendChild(who);
    }
    return cell;
  }

  /** The quiet line under a plan model that names the routing alias, captioned so it reads as one. */
  const aliasLine = (alias) => {
    const line = el("div", "aliasLine");
    line.appendChild(text("what the routing calls it: "));
    line.appendChild(el("span", "alias", alias));
    return line;
  };

  function renderProviderCard(provider) {
    const card = el("div", "provider");
    card.dataset.provider = provider.id;

    const head = el("div", "head");
    head.appendChild(el("strong", null, provider.name || provider.id));
    head.appendChild(el("span", "quiet", provider.kind || "kind not recorded"));
    head.appendChild(el("span", "quiet mono", provider.baseUrl || "no address recorded"));
    const health = provider.health ?? {};
    if (health.reachable === true) {
      const chip = el("span", "chip ok", "answering");
      // WHERE THE GREEN CAME FROM, on the chip itself. Nothing on this install checks health in the
      // background, so "answering" means either the last requests went through, or somebody pressed
      // the button beside it. A green light with no source behind it is worse than none.
      chip.title = String(health.how || health.why || "");
      head.appendChild(chip);
    } else if (health.reachable === false) {
      const chip = el("span", "chip refused", "not answering");
      chip.title = String(health.why || "");
      head.appendChild(chip);
    } else {
      const chip = el("span", "quiet", "not checked");
      chip.title = String(health.why || "nothing has checked this provider, so there is nothing to report");
      head.appendChild(chip);
    }

    // PROVIDERS-8. THE MONTH'S FAILURES, BESIDE THE CHIP AND NEVER INSTEAD OF IT.
    //
    // Measured on the R750 2026-09-09 12:02: plan-qwen answered HTTP 200 in 2,357 ms through the
    // proxy while this panel said "not answering", because the health rule went red on ANY failure
    // inside the month window and three of that key's 220 requests had failed the previous evening,
    // before the key moved endpoints. A colour that cannot go back to green until the calendar turns
    // is a colour an operator learns to ignore.
    //
    // So the chip answers "is it working now" and this line answers "has it ever not", and both are
    // on the screen at once whatever the colour. Drawn whenever the month holds a failure, including
    // beside a green chip, because a green chip that hides three failures is the half of this that
    // nobody can act on.
    const month = health.month ?? null;
    if (month != null && Number(month.failures) > 0) {
      const note = el("span", "monthFail", `${Number(month.failures)} of ${Number(month.requests ?? 0)} failed this month${month.lastFailureAt ? `, last ${utcMinute(month.lastFailureAt)}` : ""}`);
      note.title = String(month.lastFailureWhy || "The most recent failure inside the month window. The chip beside this reads the most recent requests, which is a different question.");
      head.appendChild(note);
    }

    const actions = el("div", "actions");
    // A LIVE MODEL LIST NEEDS THE KEY, and this console keeps no copy of one: the key is held for
    // the one request that reads the vendor and stored nowhere. Left blank, Refresh returns the
    // names last read with the date they were read on, and says so.
    const catalogKey = document.createElement("input");
    catalogKey.type = "password";
    catalogKey.className = "catalogKey";
    catalogKey.autocomplete = "off";
    catalogKey.placeholder = "paste the key to read their live list";
    catalogKey.title = "Optional. With a key this reads the vendor's own model list right now; without one it shows the names last read and when. Nothing is stored either way.";
    actions.appendChild(catalogKey);
    const refresh = el("button", "ghost small", "Refresh the model list");
    refresh.type = "button";
    refresh.addEventListener("click", () => act(refresh, async () => {
      const value = catalogKey.value.trim();
      const answer = await api("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/catalog/refresh`, value.length > 0 ? { apiKey: value } : {});
      catalogKey.value = "";
      return answer;
    }));
    actions.appendChild(refresh);
    const check = el("button", "ghost small", "Check now");
    check.type = "button";
    check.title = "Sends one real request to this provider on every model it serves, and records what came back. It costs the vendor a request, which is why it is a button and not a timer.";
    check.addEventListener("click", () => act(check, () => api("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/health`, {})));
    actions.appendChild(check);
    // PROVIDERS-8. A check sends one real request on every model this provider serves, and there is
    // nothing to send it with until a key is in. Said beside the button rather than in a tooltip: a
    // disabled control cannot be hovered in every browser, and a button that does nothing with no
    // reason on the screen is read as broken.
    const keyCount = (provider.keys ?? []).length;
    if (keyCount === 0) {
      check.disabled = true;
      check.title = "Add a key first, then this can check it.";
    }

    // PROVIDERS-9. REMOVING A PROVIDER.
    //
    // Measured on the R750 2026-09-09: the Alibaba token plan was listed TWICE. `qwen`, the preset
    // with the override, the key and 254 requests behind it, and `qwen-plan`, a leftover of the
    // 2026-09-08 recovery carrying the same name and the same address with no key and nothing ever
    // run through it. Two identical cards is two chances to point a plan model at the dead one.
    //
    // Off unless the card holds no key AND serves no deployment, because a provider with either
    // behind it is a provider whose removal takes a customer off the air on the next request. The
    // reason why it is off is beside it, for the same reason as above.
    const servedBy = (providersAnswer.planModels ?? []).filter((model) =>
      String(model.provider ?? "") === provider.id
      || (model.deployments ?? []).some((one) => String(one.keySlot ?? "").startsWith(`${provider.id}-`)));
    const removeProvider = el("button", "ghost small removeProvider", "Remove");
    removeProvider.type = "button";
    // BOTH REASONS, when both are true. Naming only the first one sends the operator off to remove a
    // key and back to a button that is still off, with a second reason they were never told about.
    const blocking = [
      keyCount > 0 ? `This provider still holds ${keyCount === 1 ? "a key" : `${keyCount} keys`}. Remove the keys first.` : "",
      servedBy.length > 0
        ? `${servedBy.map((one) => one.alias).join(", ")} still ${servedBy.length === 1 ? "runs" : "run"} on it. Point ${servedBy.length === 1 ? "it" : "them"} somewhere else first.`
        : "",
    ].filter(Boolean).join(" ");
    if (blocking.length > 0) {
      removeProvider.disabled = true;
      removeProvider.title = blocking;
    }
    actions.appendChild(removeProvider);
    head.appendChild(actions);
    // Under the row of buttons and never in it. A sentence inside a flex row of controls sets that
    // row's width to the sentence, and this card then ran 83 px wider than the panel: everything on
    // this panel slid sideways and the left edge of every heading went off the screen. Measured on
    // this Mac 2026-09-09 in a screenshot, while every other check on the panel passed.
    for (const line of [keyCount === 0 ? "add a key first, then this can check it" : "", blocking]) {
      if (line.length > 0) head.appendChild(el("div", "whyOff", line));
    }
    card.appendChild(head);

    // WHERE THE MODEL LIST CAME FROM, in those words, because the two are not the same thing and
    // an operator picking a vendor model needs to know which one they are looking at.
    const catalog = provider.catalog ?? {};
    const models = Array.isArray(catalog.models) ? catalog.models : [];
    const where = models.length === 0
      ? "no model list yet"
      : catalog.live === true
        ? `${models.length} model${models.length === 1 ? "" : "s"}, read from the provider ${catalog.readAt ? ago(catalog.readAt) : "at some point"}`
        : `${models.length} model${models.length === 1 ? "" : "s"}, from our own list`;
    const line = el("p", "quiet", where);
    if (catalog.why) line.title = String(catalog.why);
    card.appendChild(line);
    // The refresh button cannot do anything until the vendor's list has somewhere to be read from
    // and a key to read it with, and a button that answers "nothing happened" is worse than one
    // that says why before it is pressed.
    if (catalog.ready === false) {
      refresh.disabled = true;
      refresh.title = "This provider has no model list address recorded, so there is nothing to read. Add one when you register it.";
    }
    card.appendChild(el("p", "quiet", String(catalog.note || "A model list is names and nothing else. The context window, whether it takes a screenshot and what a customer sees it called are set by you on the plan model below.")));

    const wrap = el("div", "scroll");
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["Key", "Order", "Value", "Used by", "This month", "Requests", "Plan window", "Last error", ""]) headRow.appendChild(el("th", null, label));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const body = document.createElement("tbody");
    const keys = Array.isArray(provider.keys) ? provider.keys : [];
    if (keys.length === 0) body.appendChild(rowSpanning(9, "This provider has no key yet, so nothing can run on it."));
    for (const key of keys) {
      const tr = document.createElement("tr");
      tr.dataset.key = key.slot;
      const name = document.createElement("td");
      name.appendChild(el("div", null, key.label || key.slot));
      name.appendChild(el("div", "quiet mono", key.slot));
      if (key.parked) name.appendChild(el("span", "chip locked", "parked"));
      tr.appendChild(name);
      tr.appendChild(el("td", "num", key.order ?? "-"));
      // The mask the service reported and nothing else. This page never sees a key value.
      tr.appendChild(el("td", "mono", key.masked || "not shown"));
      tr.appendChild(el("td", null, (key.serves ?? []).length === 0 ? "nothing yet" : (key.serves ?? []).join(", ")));
      const month = el("td", "num");
      // "not priced" and "$0.00" look identical to a reader and mean opposite things: one is a model
      // nobody has given a cost per token, the other is a customer who has spent nothing. On the
      // R750 2026-09-08 every Z.AI row was the first while the page drew the second.
      if (key.spend?.priced === false) {
        const chip = el("span", "quiet", "not priced");
        chip.title = String(key.spend?.why || "No cost per token is set on this key's deployments, so what ran through it cannot be turned into money.");
        month.appendChild(chip);
      } else {
        month.appendChild(measured(dollars(key.spend?.month), key.spend?.why));
      }
      tr.appendChild(month);
      const requests = el("td", "num");
      requests.appendChild(measured(key.spend?.requests, key.spend?.why));
      tr.appendChild(requests);
      tr.appendChild(quotaCell(key));
      const error = document.createElement("td");
      if (key.lastError != null && String(key.lastError.why ?? "").length > 0) {
        const chip = el("span", "chip refused", "an error");
        chip.title = `${key.lastError.why}${key.lastError.at ? ` (${when(key.lastError.at)})` : ""}`;
        error.appendChild(chip);
      } else {
        error.appendChild(el("span", "quiet", "none"));
      }
      tr.appendChild(error);

      const cell = document.createElement("td");
      const roll = el("button", "ghost small", "Roll");
      roll.type = "button";
      roll.className = "ghost small rollKey";
      const park = el("button", "ghost small", key.parked ? "Use again" : "Park");
      park.type = "button";
      park.className = "ghost small parkKey";
      park.addEventListener("click", () => act(park, () => api(
        "POST",
        `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.slot)}/park`,
        { parked: !key.parked },
      )));
      const remove = el("button", "ghost small", "Remove");
      remove.type = "button";
      remove.className = "ghost small removeKey";
      const window_ = el("button", "ghost small", "Plan size");
      window_.type = "button";
      window_.className = "ghost small quotaKey";
      cell.appendChild(roll);
      cell.appendChild(park);
      cell.appendChild(window_);
      cell.appendChild(remove);
      tr.appendChild(cell);
      body.appendChild(tr);

      // The roll. One row below the key, revealed by the button above it, and the value in it never
      // comes back: the field is cleared whether the roll worked or not.
      //
      // The row itself is hidden until one of the two forms in it is open, or every key on the
      // screen sits above an empty stripe the height of a row. `showRow` below is what keeps the
      // two in step, because either form can be the one that is open.
      const rollRow = document.createElement("tr");
      rollRow.hidden = true;
      const rollCell = document.createElement("td");
      rollCell.colSpan = 9;
      const rollForm = el("form", "keyForm rollForm");
      rollForm.hidden = true;
      const rollField = document.createElement("input");
      rollField.type = "password";
      rollField.autocomplete = "off";
      rollField.placeholder = "the new key";
      rollField.className = "keyValue";
      const rollGo = el("button", "ghost small", "Replace this key");
      rollGo.type = "submit";
      rollForm.appendChild(rollField);
      rollForm.appendChild(rollGo);
      rollForm.appendChild(el("span", "why", `The new key goes in beside the old one, the old one comes out once the new one has answered, and nothing in between fails. ${CLOCK.proxy}`));
      rollForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = rollField.value;
        if (value.length === 0) { banner("Type the new key first. Rolling to an empty key would take every workspace on this provider down."); return; }
        rollField.value = "";
        await act(rollGo, () => api(
          "POST",
          `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.slot)}/roll`,
          { apiKey: value },
        ));
      });
      rollCell.appendChild(rollForm);

      // The remove. The one destructive control on this page, and the only one anywhere in this
      // console that takes a typed confirmation: one stray click here takes every workspace on this
      // provider off the air, and there is no undo because the value is gone.
      const removeForm = el("form", "keyForm danger");
      removeForm.hidden = true;
      const confirmField = document.createElement("input");
      confirmField.type = "text";
      confirmField.autocomplete = "off";
      confirmField.placeholder = key.slot;
      confirmField.className = "confirmField";
      const removeGo = el("button", "ghost small", "Remove this key for good");
      removeGo.type = "submit";
      removeForm.appendChild(confirmField);
      removeForm.appendChild(removeGo);
      // The slot and not the provider's name, because the slot is what the route checks and a
      // confirmation the service will refuse is a confirmation that teaches nothing.
      removeForm.appendChild(el("span", "why", `Type ${key.slot} to confirm. The key value is gone after this and cannot be read back from anywhere, so if it is the last key on this provider every workspace using it stops on the next request.`));
      removeForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const typed = confirmField.value.trim();
        if (typed !== String(key.slot)) {
          banner(`Type ${key.slot} in the box to remove this key. Nothing was removed.`);
          return;
        }
        confirmField.value = "";
        await act(removeGo, () => api(
          "POST",
          `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.slot)}/remove`,
          { confirm: typed },
        ));
      });
      rollCell.appendChild(removeForm);

      // The vendor's plan window, typed in once off their own page. No endpoint on this build
      // reports it, which the form says rather than implying the numbers came from the vendor.
      const quotaForm = el("form", "keyForm quotaForm");
      quotaForm.hidden = true;
      const quotaTotal = document.createElement("input");
      quotaTotal.type = "number";
      quotaTotal.min = "0";
      quotaTotal.placeholder = "the plan's total";
      quotaTotal.className = "quotaTotal";
      quotaTotal.value = key.quota?.total != null ? String(key.quota.total) : "";
      const quotaUnit = document.createElement("input");
      quotaUnit.type = "text";
      quotaUnit.placeholder = "what it is counted in";
      quotaUnit.className = "quotaUnit";
      quotaUnit.value = String(key.quota?.unit ?? "");
      const quotaReset = document.createElement("input");
      quotaReset.type = "text";
      quotaReset.placeholder = "when it resets, e.g. 2026-09-09T22:37:00Z";
      quotaReset.className = "quotaReset";
      quotaReset.value = String(key.quota?.resetAt ?? "");
      const quotaGo = el("button", "ghost small", "Record this plan window");
      quotaGo.type = "submit";
      quotaForm.appendChild(quotaTotal);
      quotaForm.appendChild(quotaUnit);
      quotaForm.appendChild(quotaReset);
      quotaForm.appendChild(quotaGo);
      quotaForm.appendChild(el("span", "why", "Read the total and the reset off the provider's own plan page and type them here. What is counted against them is our own count of what went through this key, which is why the bar says so."));
      quotaForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await act(quotaGo, () => api(
          "POST",
          `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys/${encodeURIComponent(key.slot)}/quota`,
          {
            total: Number(quotaTotal.value) || 0,
            unit: quotaUnit.value.trim(),
            window: String(key.quota?.window ?? ""),
            resetAt: quotaReset.value.trim(),
          },
        ));
      });
      rollCell.appendChild(quotaForm);
      rollRow.appendChild(rollCell);
      body.appendChild(rollRow);

      // The one place the row and the two forms inside it are kept in step. Opening either closes
      // the other, because a key row with a roll field and a delete confirmation open at once is
      // two ways to type into the wrong one.
      const showRow = () => { rollRow.hidden = rollForm.hidden && removeForm.hidden && quotaForm.hidden; };
      roll.addEventListener("click", () => {
        rollForm.hidden = !rollForm.hidden;
        if (!rollForm.hidden) { removeForm.hidden = true; quotaForm.hidden = true; }
        showRow();
        if (!rollForm.hidden) rollField.focus();
      });
      remove.addEventListener("click", () => {
        removeForm.hidden = !removeForm.hidden;
        if (!removeForm.hidden) { rollForm.hidden = true; quotaForm.hidden = true; }
        showRow();
        if (!removeForm.hidden) confirmField.focus();
      });
      window_.addEventListener("click", () => {
        quotaForm.hidden = !quotaForm.hidden;
        if (!quotaForm.hidden) { rollForm.hidden = true; removeForm.hidden = true; }
        showRow();
        if (!quotaForm.hidden) quotaTotal.focus();
      });
    }
    table.appendChild(body);
    wrap.appendChild(table);
    card.appendChild(wrap);

    // Add a key to this provider. Same masked field, same rule: it goes out once and is cleared.
    const addForm = el("form", "keyForm addKeyForm");
    const addLabel = document.createElement("input");
    addLabel.type = "text";
    addLabel.autocomplete = "off";
    addLabel.placeholder = "what to call this key";
    addLabel.className = "keyLabel";
    const addValue = document.createElement("input");
    addValue.type = "password";
    addValue.autocomplete = "off";
    addValue.placeholder = "the key itself";
    addValue.className = "keyValue";
    const addGo = el("button", "ghost small", "Add this key");
    addGo.type = "submit";
    addForm.appendChild(addLabel);
    addForm.appendChild(addValue);
    addForm.appendChild(addGo);
    addForm.appendChild(el("span", "why", `A second, third or fourth key on the same provider shares the load and covers the others when one is rate limited. ${CLOCK.proxy}`));
    addForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = addValue.value;
      const label = addLabel.value.trim();
      if (value.length === 0) { banner("Type the key before adding it."); return; }
      addValue.value = "";
      addLabel.value = "";
      await act(addGo, () => api("POST", `/v1/admin/providers/${encodeURIComponent(provider.id)}/keys`, { label, apiKey: value }));
    });
    card.appendChild(addForm);

    // The typed confirmation. The same shape the key removal uses, because it is the same decision
    // one size up, and the same rule: the word typed is the word the route checks, so a confirmation
    // this console would accept and the service would refuse cannot exist.
    const removeForm = el("form", "keyForm danger providerRemoveForm");
    removeForm.hidden = true;
    const confirmProvider = document.createElement("input");
    confirmProvider.type = "text";
    confirmProvider.autocomplete = "off";
    confirmProvider.placeholder = provider.id;
    confirmProvider.className = "confirmProvider";
    const removeGo = el("button", "ghost small", "Remove this provider");
    removeGo.type = "submit";
    removeForm.appendChild(confirmProvider);
    removeForm.appendChild(removeGo);
    // A built-in is never really removed: what goes is the override this console put on top of it,
    // and the built-in underneath comes back. Saying "removed" about that would be a lie the next
    // page load exposes.
    removeForm.appendChild(el("span", "why", provider.fromPreset === true
      ? `Type ${provider.id} to confirm. This is one of the built-in providers; removing it only takes the override off and puts the built-in back.`
      : `Type ${provider.id} to confirm. It holds no key and nothing runs on it, so nothing stops when it goes.`));
    removeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const typed = confirmProvider.value.trim();
      if (typed !== String(provider.id)) {
        banner(`Type ${provider.id} in the box to remove this provider. Nothing was removed.`);
        return;
      }
      confirmProvider.value = "";
      await act(removeGo, () => api("DELETE", `/v1/admin/providers/${encodeURIComponent(provider.id)}`, {
        confirm: typed,
        // Only for a built-in, and only because the operator read the sentence above saying that is
        // what removing one means. The route refuses a preset without it.
        andOverride: provider.fromPreset === true,
      }));
    });
    removeProvider.addEventListener("click", () => {
      removeForm.hidden = !removeForm.hidden;
      if (!removeForm.hidden) confirmProvider.focus();
    });
    card.appendChild(removeForm);
    return card;
  }

  function renderPlanModelCard(model, answer) {
    const card = el("div", "planModel");
    card.dataset.alias = model.alias;
    const head = el("div", "head");
    // The customer's name for it is the prominent one. The routing alias is below, captioned.
    head.appendChild(el("span", "name", model.customerName || model.alias));
    head.appendChild(el("span", "quiet", model.provider || "no provider"));
    head.appendChild(el("span", "quiet mono", model.vendorModel || "no vendor model"));
    // shownToCustomers is the route's own answer to the one question that keeps a routing target
    // off a customer's Settings card: visible AND named on both sides. A row that fails it is drawn
    // here plainly, because the operator's page is where the reason has to be visible.
    const stale = Number(model.labelBehind);
    if (Number.isFinite(stale) && stale > 0) {
      const chip = el("span", "chip refused", `${stale} behind on the name`);
      chip.title = String(model.labelBehindWhy || "");
      head.appendChild(chip);
    }
    if (model.priced === false) {
      const chip = el("span", "chip locked", "not priced");
      chip.title = String(model.pricedWhy || "");
      head.appendChild(chip);
    }
    if (model.shownToCustomers === false) {
      const chip = el("span", "chip locked", "not shown to customers");
      chip.title = model.customerVisible === false
        ? "This model is marked as not for customers, so it stays off their Settings card."
        : "This model has no customer name or no label, so it would show up as its routing alias. It is kept off the customer's card until both are set.";
      head.appendChild(chip);
    }

    const actions = el("div", "actions");
    const edit = el("button", "ghost small", "Edit");
    edit.type = "button";
    edit.addEventListener("click", () => openPlanModelForm(model));
    actions.appendChild(edit);

    const running = model.workspaces;
    const known = Number.isFinite(Number(running));
    const grant = el("button", "ghost small", known
      ? `Give all ${running} workspace${running === 1 ? "" : "s"} access to this model`
      : "Give every workspace access to this model");
    grant.type = "button";
    grant.title = CLOCK.added;
    grant.addEventListener("click", () => act(grant, () => api("POST", `/v1/admin/plan-models/${encodeURIComponent(model.alias)}/apply`, {})));
    actions.appendChild(grant);

    const behind = Number(model.labelBehind);
    const push = el("button", "ghost small", Number.isFinite(behind) && behind > 0
      ? `Fix what ${behind} workspace${behind === 1 ? "" : "s"} call it`
      : (known ? `Update what ${running} workspace${running === 1 ? "" : "s"} call it` : "Update what their Titan calls it"));
    push.type = "button";
    push.title = CLOCK.label;
    // AN EMPTY BODY FIRST, ALWAYS. This used to send { all: true } on one click, which is exactly
    // the safety the route was rewritten to add and this page defeating it: `all` resolves to every
    // workspace that ran the alias inside the month window, the door it drives sets the MODEL as
    // well as the label, and so a customer moved onto another plan model earlier in the same month
    // would have been silently moved back. The route answers 409 with the candidates and changes
    // nothing; the operator ticks the ones they mean.
    push.addEventListener("click", async () => {
      push.disabled = true;
      try {
        const done = await api("POST", `/v1/admin/plan-models/${encodeURIComponent(model.alias)}/push-label`, {});
        banner(String(done?.message ?? "Done."), true);
        await loadProviders();
      } catch (error) {
        const candidates = Array.isArray(error?.body?.candidates) ? error.body.candidates : [];
        if (error?.status === 409 && candidates.length > 0) askWhichWorkspaces(card, model, candidates, String(error.message));
        else banner(String(error.message));
      } finally { push.disabled = false; }
    });
    actions.appendChild(push);

    // Whether this model takes an image is the one fact a model list can never tell us, and getting
    // it wrong is a fleet-wide screenshot outage rather than a cosmetic error. So it is asked.
    const check = el("button", "ghost small", "Check screenshots");
    check.type = "button";
    check.title = "Sends one image through this model and records what came back.";
    check.addEventListener("click", () => act(check, () => api("POST", `/v1/admin/plan-models/${encodeURIComponent(model.alias)}/vision-check`, {})));
    actions.appendChild(check);
    head.appendChild(actions);
    card.appendChild(head);

    card.appendChild(aliasLine(model.alias));

    const facts = [];
    facts.push(`their Titan says it runs ${model.customerLabel || "nothing, because no label is set"}`);
    facts.push(model.contextWindow ? `${Number(model.contextWindow).toLocaleString()} tokens of context` : "no context window set");
    const slots = [...new Set((model.deployments ?? []).map((one) => String(one.keySlot)).filter((one) => one.length > 0))];
    facts.push(slots.length === 0 ? "no key behind it" : `${slots.length === 1 ? "key" : "keys"} ${slots.join(", ")}`);
    facts.push((model.plans ?? []).length > 0 ? `part of ${(model.plans ?? []).join(", ")}` : "no plan named");
    card.appendChild(el("p", "quiet", facts.join(" . ")));

    const visionName = (answer.planModels ?? []).find((one) => one.alias === model.visionFallback);
    const vision = el("p", "quiet");
    // Three states, and the middle one is the reason this is not a two-branch check. The model every
    // other one falls back TO has no fallback of its own and never will, so a bare "is there a
    // fallback" test shouts an outage warning at the one model that is working exactly as designed,
    // on every load, forever. The save handler already knows the difference; the screen has to as
    // well, or the operator learns to read the warning as furniture and misses the real one.
    if (String(model.visionFallback ?? "").length > 0) {
      vision.appendChild(text(`a screenshot falls back to ${visionName?.customerName || model.visionFallback}`));
    } else if (model.supportsVision === true) {
      vision.appendChild(text("this one takes screenshots itself, so nothing falls back"));
      if (model.vision?.ok === false) {
        const chip = el("span", "chip refused", "it refused an image when asked");
        chip.title = String(model.vision?.why || "");
        vision.appendChild(chip);
      }
    } else {
      vision.appendChild(el("span", "chip off", "no screenshot route"));
      vision.appendChild(text(" Every Titan conversation carries screenshots, so a workspace on this model fails on its next turn."));
    }
    card.appendChild(vision);

    const runs = el("p", "quiet");
    runs.appendChild(text("running this right now: "));
    runs.appendChild(measured(known ? running : null, model.workspacesWhy, (value) => countWord(Number(value), "one workspace", "{n} workspaces")));
    card.appendChild(runs);
    return card;
  }

  /**
   * The workspaces a label push would touch, ticked one at a time.
   *
   * This exists because the push writes INSIDE a customer's box and the relay door it drives writes
   * the base url, the key, the model, the endpoint name, the served-by line, the context window and
   * the label in one call. So it does not just correct what a Titan calls itself: it MOVES that
   * workspace onto this plan model. Doing that to a list the operator never saw is how a customer
   * who was deliberately put on something else gets quietly moved back.
   *
   * The boxes that are actually behind are ticked to start with; a box already saying the right
   * thing is left unticked, because pushing at it is a write into a customer's box for no change.
   */
  function askWhichWorkspaces(card, model, candidates, why) {
    const existing = card.querySelector(".pushPicker");
    if (existing) existing.remove();
    const box = el("div", "pushPicker");
    box.appendChild(el("p", "quiet", why));
    const behind = new Set(Array.isArray(model.labelBehindSlugs) ? model.labelBehindSlugs.map(String) : []);
    const list = el("div", "row");
    const inputs = [];
    for (const slug of candidates) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(slug);
      input.checked = behind.size === 0 || behind.has(String(slug));
      label.appendChild(input);
      label.appendChild(text(behind.has(String(slug)) ? `${slug} (behind)` : String(slug)));
      list.appendChild(label);
      inputs.push(input);
    }
    box.appendChild(list);
    const go = el("button", "ghost small", "Update the ticked workspaces");
    go.type = "button";
    go.addEventListener("click", () => act(go, () => {
      const slugs = inputs.filter((one) => one.checked).map((one) => one.value);
      if (slugs.length === 0) throw new Error("Tick at least one workspace, or cancel. Nothing was changed.");
      return api("POST", `/v1/admin/plan-models/${encodeURIComponent(model.alias)}/push-label`, { slugs });
    }));
    const stop = el("button", "ghost small", "Cancel");
    stop.type = "button";
    stop.addEventListener("click", () => box.remove());
    const buttons = el("div", "actions");
    buttons.appendChild(go);
    buttons.appendChild(stop);
    box.appendChild(buttons);
    card.appendChild(box);
  }

  function openPlanModelForm(model) {
    const form = $("planModelForm");
    const answer = providersAnswer;
    editingAlias = String(model?.alias ?? "");
    $("planModelWhich").textContent = editingAlias
      ? `Editing ${model.customerName || editingAlias}. The routing name cannot change: every workspace already on it names it.`
      : "A new plan model. Pick the routing name carefully, because it is the one field that can never change afterwards.";
    $("pmCustomerName").value = String(model?.customerName ?? "");
    $("pmCustomerLabel").value = String(model?.customerLabel ?? "");
    $("pmContext").value = model?.contextWindow ? String(model.contextWindow) : "";
    $("pmInputCost").value = model?.inputCostPerToken != null ? String(model.inputCostPerToken) : "";
    $("pmOutputCost").value = model?.outputCostPerToken != null ? String(model.outputCostPerToken) : "";
    $("pmPlans").value = (model?.plans ?? []).join(", ");
    $("pmAlias").value = editingAlias;
    $("pmAlias").readOnly = editingAlias.length > 0;
    $("pmVisible").checked = model ? model.customerVisible !== false : true;
    $("pmAliasNote").hidden = false;
    $("pmSelfVision").checked = model ? model.supportsVision === true : false;

    const providers = answer.providers ?? [];
    fill($("pmProvider"), providers.map((one) => ({ value: one.id, label: one.name || one.id })), model?.provider ?? providers[0]?.id ?? "");
    const refreshKeys = () => {
      const chosen = providers.find((one) => one.id === $("pmProvider").value);
      // EVERY KEY, PRESELECTED. A plan model is a pool: one deployment per key, all sharing the
      // alias. That is what makes a second subscription carry load and what makes a rate limit on
      // one key survivable. A single-key picker here is how a pool quietly becomes one key.
      const keySelect = $("pmKey");
      const running = new Set((model?.deployments ?? []).map((one) => String(one.keySlot)));
      clear(keySelect);
      for (const one of chosen?.keys ?? []) {
        const node = document.createElement("option");
        node.value = one.slot;
        node.appendChild(text(`${one.label || one.slot} (${one.slot})`));
        node.selected = running.size === 0 ? !one.parked : running.has(String(one.slot));
        keySelect.appendChild(node);
      }
      // Live on an edit as well, because the pool IS the thing an operator most often changes:
      // a second subscription arrives and the model it is for already exists.
      keySelect.disabled = false;
      const catalogModels = Array.isArray(chosen?.catalog?.models) ? chosen.catalog.models : [];
      const options = catalogModels.map((one) => ({ value: one, label: one }));
      options.push({ value: "__other__", label: "something else, typed in" });
      const current = String(model?.vendorModel ?? "");
      const inList = catalogModels.includes(current);
      fill($("pmVendorModel"), options, inList ? current : (current.length > 0 ? "__other__" : options[0]?.value ?? ""));
      $("pmVendorOther").value = inList ? "" : current;
      $("pmVendorOtherWrap").hidden = $("pmVendorModel").value !== "__other__";
    };
    refreshKeys();
    $("pmProvider").onchange = refreshKeys;
    $("pmVendorModel").onchange = () => { $("pmVendorOtherWrap").hidden = $("pmVendorModel").value !== "__other__"; };

    // The screenshot route. Every plan model the panel knows about is a candidate except this one,
    // because a model cannot fall back to itself.
    const visionOptions = [{ value: "", label: "nothing, this model has no screenshot route" }];
    for (const one of answer.planModels ?? []) {
      if (one.alias === editingAlias) continue;
      visionOptions.push({ value: one.alias, label: one.customerName || one.alias });
    }
    fill($("pmVision"), visionOptions, model?.visionFallback ?? "");
    // The keys a model runs on are its pool at the proxy. Changing that is adding or removing a
    // deployment, which is not what this form does, so on an edit the picker shows what is really
    // there and does not pretend to change it.
    $("pmKeyNote").textContent = editingAlias.length > 0
      ? "These are the keys it runs on. Select another and it starts using it on the next request; the new one goes in before any old one comes out, so the pool is never short."
      : "It runs on every key selected here, one deployment each. That is what makes a second subscription share the load.";

    form.hidden = false;
    $("pmCustomerName").focus();
  }

  $("addPlanModelShow").addEventListener("click", () => openPlanModelForm(null));
  $("planModelCancel").addEventListener("click", () => { $("planModelForm").hidden = true; editingAlias = ""; });
  $("addProviderShow").addEventListener("click", () => { $("addProviderForm").hidden = false; $("providerName").focus(); });
  $("addProviderCancel").addEventListener("click", () => { $("addProviderForm").hidden = true; });

  $("addProviderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("providerName").value.trim();
    const kind = $("providerKind").value.trim() || "openai";
    const baseUrl = $("providerBase").value.trim();
    // The short name is the handle every key slot is named after (zai-1, zai-2) and it is on every
    // spend row forever, so it is typed rather than guessed from a display name.
    const id = $("providerId").value.trim().toLowerCase();
    const catalogPath = $("providerCatalog").value.trim();
    if (name.length === 0 || baseUrl.length === 0) { banner("A provider needs a name and an address."); return; }
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) { banner("The short name is lower case letters, numbers and dashes, and it is what every key slot on this provider is named after."); return; }
    const button = $("addProviderSave");
    await act(button, () => api("POST", "/v1/admin/providers", { id, name, kind, baseUrl, catalogPath }));
    $("providerId").value = "";
    $("providerName").value = "";
    $("providerKind").value = "";
    $("providerBase").value = "";
    $("providerCatalog").value = "";
    $("addProviderForm").hidden = true;
  });

  $("planModelForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const alias = $("pmAlias").value.trim();
    const visionFallback = $("pmVision").value;
    const vendorModel = $("pmVendorModel").value === "__other__" ? $("pmVendorOther").value.trim() : $("pmVendorModel").value;
    const supportsVision = $("pmSelfVision").checked;
    // THE ONE FIELD THIS FORM WILL NOT LET THROUGH. A plan model with no screenshot route is a
    // fleet-wide outage on the next turn, not a missing nicety: every Titan conversation carries
    // screenshots and the flagship models refuse them. The refusal says that, in those words.
    //
    // The one model that legitimately has no route is the one everything else falls back TO, which
    // is why the box beside it exists. Making the route flatly mandatory would make that model
    // unsaveable and would push somebody into pointing it at itself, which is worse than the hole
    // it was meant to close.
    if (visionFallback.length === 0 && !supportsVision) {
      banner("Pick where a screenshot falls back to before saving. Every conversation on this product carries screenshots, and a plan model that cannot take one fails the next turn for every workspace on it.");
      return;
    }
    if (alias.length === 0) { banner("A plan model needs a routing name."); return; }
    if (vendorModel.length === 0) { banner("Pick the vendor model this points at, or type one in."); return; }
    const customerLabel = $("pmCustomerLabel").value.trim();
    const shared = {
      provider: $("pmProvider").value,
      vendorModel,
      customerName: $("pmCustomerName").value.trim(),
      customerLabel,
      // What the customer's Titan says it is served by follows the label unless somebody says
      // otherwise. One less field on the form, and never an empty string reaching a box.
      servedBy: customerLabel,
      customerVisible: $("pmVisible").checked,
      supportsVision,
      visionFallback,
      contextWindow: $("pmContext").value.trim().length > 0 ? Number($("pmContext").value) : null,
      // Sent only when typed. A blank field is NOT zero: writing zero would be a real price of
      // nothing, which reads on every page as "spent nothing".
      ...($("pmInputCost").value.trim().length > 0 ? { inputCostPerToken: $("pmInputCost").value.trim() } : {}),
      ...($("pmOutputCost").value.trim().length > 0 ? { outputCostPerToken: $("pmOutputCost").value.trim() } : {}),
      plans: $("pmPlans").value.split(",").map((one) => one.trim()).filter((one) => one.length > 0),
    };
    const button = $("planModelSave");
    // AN EDIT IS AN EDIT. The alias is a contract with every box already pointed at it, so the
    // create route refuses one that exists; sending an edit there answered 409 and changed nothing.
    if (editingAlias.length > 0) {
      const keySlots = [...$("pmKey").selectedOptions].map((one) => one.value);
      if (keySlots.length === 0) { banner("A plan model needs at least one key to run on."); return; }
      // Two calls, because they are two different things at the proxy: an edit changes what the
      // deployments say, and the pool is which deployments there are. The pool goes first, so a key
      // added in the same save carries the labels this edit is about to set rather than the old ones.
      await act(button, async () => {
        const pool = await api("POST", `/v1/admin/plan-models/${encodeURIComponent(editingAlias)}/keys`, { keySlots });
        const edit = await api("POST", `/v1/admin/plan-models/${encodeURIComponent(editingAlias)}/update`, shared);
        return { message: `${pool.message} ${edit.message}` };
      });
    } else {
      const keySlots = [...$("pmKey").selectedOptions].map((one) => one.value);
      if (keySlots.length === 0) { banner("Pick at least one key for it to run on."); return; }
      await act(button, () => api("POST", "/v1/admin/plan-models", { alias, keySlots, ...shared }));
    }
    $("planModelForm").hidden = true;
    editingAlias = "";
  });

  function renderDefaults(answer) {
    const host = $("providerDefaults");
    clear(host);
    const row = el("div", "row");
    row.appendChild(el("span", "quiet", "A new workspace starts on"));
    const select = document.createElement("select");
    select.id = "defaultModel";
    const options = (answer.planModels ?? []).map((one) => ({ value: one.alias, label: one.customerName || one.alias }));
    if (options.length === 0) options.push({ value: "", label: "nothing, because there is no plan model yet" });
    fill(select, options, answer.defaults?.planModel ?? "");
    row.appendChild(select);
    const save = el("button", "ghost small", "Save");
    save.type = "button";
    save.id = "defaultModelSave";
    save.addEventListener("click", () => act(save, () => api("POST", "/v1/admin/defaults", { planModel: select.value })));
    row.appendChild(save);
    host.appendChild(row);
    const note = el("p", "quiet", `This is what a workspace provisioned from now on runs on. It changes nothing about a workspace that already exists: those are set one at a time on their own row under Clients and users. ${CLOCK.customerPage}`);
    if (answer.defaults?.why) note.title = String(answer.defaults.why);
    host.appendChild(note);

    const settings = [
      { name: "allowance.levels", label: "Allowance levels", value: answer.allowanceLevels ?? [] },
      { name: "spend.prices", label: "List prices per 1M input/output tokens", value: answer.listPrices ?? [] },
    ];
    for (const setting of settings) {
      const block = el("div", "row allowanceSetting");
      const label = el("label", null, setting.label);
      const field = document.createElement("textarea");
      field.rows = 3;
      field.value = JSON.stringify(setting.value);
      label.appendChild(field);
      block.appendChild(label);
      const button = el("button", "ghost small", "Save");
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api("POST", `/v1/admin/settings/${encodeURIComponent(setting.name)}`, { value: field.value });
          await loadProviders();
        } catch (error) { banner(String(error.message)); }
        finally { button.disabled = false; }
      });
      block.appendChild(button);
      host.appendChild(block);
    }
  }

  function renderLedger(rows) {
    const body = $("adminLedger").querySelector("tbody");
    clear(body);
    if (rows.length === 0) {
      body.appendChild(rowSpanning(7, "Nothing has been changed from this console yet."));
      return;
    }
    for (const row of rows) {
      const tr = document.createElement("tr");
      const at = el("td", null, ago(row.at));
      at.title = when(row.at);
      tr.appendChild(at);
      tr.appendChild(el("td", "mono", row.actor || "the operator token"));
      tr.appendChild(row.via === "relay" ? el("td", null, "through the console") : el("td", "mono", row.ip || "not recorded"));
      tr.appendChild(el("td", null, row.action || "-"));
      tr.appendChild(el("td", "mono", row.target || "-"));
      tr.appendChild(el("td", null, row.detail || ""));
      const outcome = document.createElement("td");
      outcome.appendChild(el("span", `chip ${row.outcome === "ok" ? "ok" : "refused"}`, row.outcome === "ok" ? "done" : String(row.outcome || "failed")));
      tr.appendChild(outcome);
      body.appendChild(tr);
    }
  }

  function providerChips(answer) {
    if (answer.configured === false) {
      return [{ label: "Providers", value: null, why: String(answer.why ?? "the proxy could not be asked") }];
    }
    const providers = answer.providers ?? [];
    const keys = providers.reduce((sum, one) => sum + (one.keys ?? []).length, 0);
    const down = providers.filter((one) => one.health?.reachable === false).length;
    return [
      { label: "Providers", value: providers.length },
      { label: "Plan models", value: (answer.planModels ?? []).length },
      { label: "Keys", value: keys },
      { label: "Not answering", value: down, tone: down === 0 ? "good" : "bad" },
    ];
  }

  async function loadProviders() {
    const answer = await api("GET", "/v1/admin/providers");
    providersAnswer = answer;
    summarise("panel-providers", providerChips(answer));

    const note = [];
    if (answer.configured === false) {
      note.push(`Not measured: ${answer.why}`);
    } else {
      note.push(`${(answer.providers ?? []).length} provider${(answer.providers ?? []).length === 1 ? "" : "s"}`);
      note.push(`${(answer.planModels ?? []).length} plan model${(answer.planModels ?? []).length === 1 ? "" : "s"}`);
      note.push(`measured ${when(answer.measuredAt)}`);
      // THE HALF-STATE, SAID OUT LOUD. With the proxy reading its models out of its file, a key
      // added here really persists and a plan model refuses, so half of what this page does works
      // and the page would otherwise look fine. null is "cannot be told apart yet", not false.
      if (answer.db?.on === false) {
        note.push(`the proxy is still reading its models out of its own file, so a change made here will not stick: ${answer.db.why || "store_model_in_db is off"}`);
      } else if (answer.db?.on == null && answer.db?.why) {
        note.push(String(answer.db.why));
      }
    }
    // WHERE THE VOICE KEY WENT, said on the panel somebody would look for it on. This page used to
    // carry two rows called "xAI realtime (voice)" and "OpenAI realtime (voice)", and pasting a key
    // on one of them answered that the vendor could not be reached -- MEASURED by Jason at 07:49 on
    // 2026-09-10 -- because this panel proves a key by fetching the row's catalog and a realtime
    // address is a websocket. Those rows are deleted (cp/proxy.mjs says why). One line here so the
    // operator who goes looking is sent to the block that does take it, rather than concluding the
    // feature is broken. KEYS-2 moved that block to its own rail entry, so this line names the entry
    // he can see rather than the panel he would have had to scroll.
    note.push("the key the product talks with is under Keys the product uses, on the Keys panel, not here");
    $("providersNote").textContent = note.join(" - ");

    const host = $("providers");
    clear(host);
    const providers = answer.providers ?? [];
    if (providers.length === 0) host.appendChild(el("p", "empty", "No provider yet. Add one, add a key to it, then point a plan model at that key."));
    for (const provider of providers) host.appendChild(renderProviderCard(provider));

    const models = $("planModels");
    clear(models);
    const planModels = answer.planModels ?? [];
    if (planModels.length === 0) models.appendChild(el("p", "empty", "No plan model yet, so no workspace has anything to run on."));
    for (const model of planModels) models.appendChild(renderPlanModelCard(model, answer));

    renderDefaults(answer);
    renderLedger(answer.actions ?? []);
    // ADMIN-2's picker is filled from this answer and from nothing else, so the two panels can never
    // offer different plan models.
    fillAddClientModels();
  }

  // ---- panel 7: feedback (FEEDBACK-1) ----------------------------------------------------------
  //
  // The second of two gates, and the page says so out loud under the heading. Everything listed
  // here was written by an agent, shown to the workspace operator in their own console, and sent by
  // that person. This screen is what the developers do next.
  //
  // No key value and no token ever renders here. The paste row is the masked field the providers
  // panel already uses, cleared on the way back, and what comes out of the service is a length and
  // eight characters of a digest.

  const TIER_LABEL = { critical: "critical", quality: "quality of life", observation: "observation" };
  const STATE_CHIP = { new: "chip", approved: "chip ok", filed: "chip super", suppressed: "chip off", closed: "chip locked" };
  const STATE_LABEL = { new: "new", approved: "approved", filed: "issue filed", suppressed: "suppressed", closed: "closed" };

  function renderFeedbackCard(report) {
    // Not the client card's own class, though it is drawn the same way: the gate counts `.client`
    // in strict mode to say the Clients panel drew one workspace, and a report wearing that name
    // makes a correct page read as three customers.
    const card = el("div", "feedbackCard");
    const head = el("div", "head");
    head.appendChild(el("strong", null, report.title || "(no title)"));
    head.appendChild(el("span", "quiet", report.tenant || "no workspace"));
    // Critical is the only chip on this panel that is ever red, because it is the only tier that
    // means somebody is stopped right now.
    head.appendChild(el("span", report.tier === "critical" ? "chip attack" : "chip", TIER_LABEL[report.tier] ?? report.tier));
    head.appendChild(el("span", STATE_CHIP[report.state] ?? "chip", STATE_LABEL[report.state] ?? report.state));
    if (report.category) head.appendChild(el("span", "quiet", report.category));
    const seen = el("span", "quiet", ago(report.at));
    seen.title = when(report.at);
    head.appendChild(seen);
    card.appendChild(head);

    const who = [report.agentName || report.agent || "", report.payload?.evidence?.hostVersion || "", report.payload?.evidence?.consoleVersion || ""]
      .filter((one) => String(one).length > 0).join(" - ");
    if (who) card.appendChild(el("p", "quiet", who));

    const body = el("textarea");
    body.className = "feedbackBody";
    body.rows = 6;
    body.value = String(report.body ?? "");
    card.appendChild(body);

    const steps = report.payload?.steps ?? [];
    const calls = report.payload?.evidence?.calls ?? [];
    if (steps.length > 0 || calls.length > 0) {
      const detail = document.createElement("details");
      detail.appendChild(el("summary", "quiet", `what the agent sent: ${steps.length} step${steps.length === 1 ? "" : "s"}, ${calls.length} call${calls.length === 1 ? "" : "s"}`));
      const pre = el("pre", "mono");
      pre.appendChild(text([
        ...steps.map((step, index) => `${index + 1}. ${step}`),
        ...calls.map((call) => `${call.name} answered ${call.status || "nothing"}\n${call.output || call.summary || ""}`),
      ].join("\n")));
      detail.appendChild(pre);
      card.appendChild(detail);
    }

    if (report.issueUrl) {
      const link = document.createElement("a");
      link.href = report.issueUrl;
      link.target = "_blank";
      link.rel = "noreferrer noopener";
      link.appendChild(text(report.issueUrl));
      const line = el("p", "quiet");
      line.appendChild(text("filed as "));
      line.appendChild(link);
      card.appendChild(line);
    }
    if (report.decidedBy) card.appendChild(el("p", "quiet", `last decided by ${report.decidedBy} ${ago(report.decidedAt)}`));

    const actions = el("div", "controls");
    const run = async (button, verb, payload) => {
      button.disabled = true;
      try {
        const result = await api("POST", `/v1/admin/feedback/${report.id}/${verb}`, payload);
        // The prepared body, when there is no token yet. Shown rather than swallowed: the door is
        // proven and the operator can paste the issue by hand today.
        if (verb === "issue" && result.filed === false) {
          banner(String(result.message), false);
          const pre = el("pre", "mono");
          pre.appendChild(text(`${result.title}\n\n${result.body}`));
          card.appendChild(pre);
          return;
        }
        banner(String(result.message ?? "Done."), true);
        await loadFeedback();
      } catch (error) { banner(String(error.message)); }
      finally { button.disabled = false; }
    };
    for (const [verb, label] of [["edit", "Save this wording"], ["approve", "Approve"], ["issue", "Create GitHub issue"], ["suppress", "Suppress"], ["close", "Close"]]) {
      const button = el("button", "ghost small", label);
      button.type = "button";
      button.addEventListener("click", () => run(button, verb, verb === "edit" ? { title: report.title, body: body.value } : {}));
      actions.appendChild(button);
    }
    card.appendChild(actions);
    return card;
  }

  function feedbackChips(answer) {
    const counts = answer.counts ?? {};
    const unread = Number(counts.criticalNew ?? 0);
    return [
      { label: "On record", value: answer.total ?? 0 },
      { label: "New", value: counts.new ?? 0, tone: Number(counts.new ?? 0) > 0 ? "warn" : "good" },
      { label: "Critical and unread", value: unread, tone: unread > 0 ? "bad" : "good" },
      { label: "Filed", value: counts.filed ?? 0 },
    ];
  }

  const feedbackHeadline = (answer) => {
    const counts = answer.counts ?? {};
    const unread = Number(counts.criticalNew ?? 0);
    return {
      key: "feedback",
      label: "Reports waiting",
      value: counts.new ?? 0,
      tone: unread > 0 ? "bad" : Number(counts.new ?? 0) > 0 ? "warn" : "good",
      detail: unread > 0 ? `${unread} critical and unread` : "nobody is stopped right now",
    };
  };

  async function loadFeedback() {
    const tier = $("feedbackTier").value;
    const state = $("feedbackState").value;
    const answer = await api("GET", `/v1/admin/feedback?tier=${encodeURIComponent(tier)}&state=${encodeURIComponent(state)}&limit=200`);
    summarise("panel-feedback", feedbackChips(answer), feedbackHeadline(answer));
    $("feedbackGates").textContent = String(answer.gates ?? "");
    const note = [
      `${answer.total} report${answer.total === 1 ? "" : "s"} on record`,
      `${answer.counts.new} new`,
      `${answer.counts.criticalNew} critical and unread`,
      `${answer.counts.filed} filed`,
      `measured ${when(answer.measuredAt)}`,
    ];
    // Wave B's hook. The filter appears when the table behind it exists and is absent, rather than
    // empty, when it does not: an empty filter reads as "nothing needs re-verification", which is a
    // green light nobody measured.
    if (answer.verification?.table) note.push(`verification records are in ${answer.verification.table}`);
    $("feedbackNote").textContent = note.join(" - ");

    const door = answer.github ?? {};
    $("feedbackTokenNote").textContent = door.stored
      ? `Issues are filed in ${door.repo}. The stored token is ${door.evidence}, and nothing here can show it. Paste a new one to replace it.`
      : String(door.why ?? "no repository token is stored yet.");
    $("githubRepo").value = String(door.repo ?? "");

    const host = $("feedbackRows");
    clear(host);
    const rows = answer.rows ?? [];
    if (rows.length === 0) {
      host.appendChild(el("p", "empty", "Nothing reported in this filter. That is a real answer: no workspace has sent anything of this kind."));
      return;
    }
    for (const report of rows) host.appendChild(renderFeedbackCard(report));
  }

  for (const id of ["feedbackTier", "feedbackState"]) {
    $(id).addEventListener("change", () => { void loadFeedback().catch((error) => banner(String(error.message))); });
  }

  $("githubTokenForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const repo = $("githubRepo").value.trim();
    const value = $("githubToken").value;
    if (value.length === 0) { banner("Type the token before storing it."); return; }
    // Cleared on the way out, not on the way back, so a failed request leaves nothing in the field
    // either. Nothing on this page ever writes a value back into it.
    $("githubToken").value = "";
    const button = $("githubTokenSave");
    button.disabled = true;
    try {
      const result = await api("POST", "/v1/admin/feedback/github-token", { repo, token: value });
      banner(`${String(result.message)} The token is ${result.evidence}.`, true);
      await loadFeedback();
    } catch (error) { banner(String(error.message)); }
    finally { button.disabled = false; }
  });

  // ---- panel 8: support (SUPPORT-1) ------------------------------------------------------------
  //
  // Mail that arrived at the operator's support address, forwarded here by their own Cloudflare Email
  // Worker. The panel's one structural rule is the one it prints under its heading: NOTHING IS SENT
  // FROM HERE. The operator answers from their own mail client and presses Mark replied, which is a
  // record of what they did rather than an action that did it.
  //
  // EVERY FIELD ON A CARD WAS WRITTEN BY A STRANGER -- anybody on the internet can write to a support
  // address -- so every one of them reaches the page through el()/text(), which is textContent, and
  // not one of them is ever assigned to innerHTML. The html part of a mail arrives already flattened
  // to words by cp/support.mjs and is drawn as text like the rest.

  const SUPPORT_STATE_CHIP = { new: "chip", replied: "chip ok", closed: "chip locked" };
  const SUPPORT_STATE_LABEL = { new: "new", replied: "replied", closed: "closed" };

  function renderSupportCard(message) {
    // Its own class and not `.client`, for the reason the feedback card has its own: a gate counts
    // `.client` in strict mode to say how many workspaces the Clients panel drew, and a support
    // message wearing that name makes a correct page read as an extra customer.
    const card = el("div", "supportCard");
    const head = el("div", "head");
    head.appendChild(el("strong", null, message.subject || "(no subject)"));
    head.appendChild(el("span", "quiet", message.from || "no address"));
    head.appendChild(el("span", SUPPORT_STATE_CHIP[message.state] ?? "chip", SUPPORT_STATE_LABEL[message.state] ?? message.state));
    const seen = el("span", "quiet", ago(message.receivedAt));
    seen.title = when(message.receivedAt);
    head.appendChild(seen);
    card.appendChild(head);

    // Whether the operator's workspace was actually told. A message that is here and was never
    // announced is a thing to SEE rather than infer, which is why the row carries the receipt: a
    // notification that silently failed for a fortnight would otherwise look exactly like one that
    // worked every time.
    card.appendChild(message.notifiedAt
      ? el("p", "quiet", `${message.notifyDetail || "your workspace was told"} ${ago(message.notifiedAt)}`)
      : el("p", "quiet bad", `nobody was told about this one: ${message.notifyDetail || "this control plane did not say why"}`));

    // The body on click. Collapsed, because the panel is a list of who is waiting and the text is
    // what you open when you decide to answer one.
    const body = String(message.text || message.htmlText || "").trim();
    const detail = document.createElement("details");
    const words = body.length > 0 ? body.split(/\s+/).length : 0;
    detail.appendChild(el("summary", "quiet", body.length === 0
      ? "this message had no words in it"
      : `read it: ${words} word${words === 1 ? "" : "s"}${message.text ? "" : ", from the html part"}`));
    const pre = el("pre", "mono");
    pre.appendChild(text(body));
    detail.appendChild(pre);
    if (message.to) detail.appendChild(el("p", "quiet", `addressed to ${message.to}`));
    if (message.messageId) detail.appendChild(el("p", "quiet", `message id ${message.messageId}`));
    card.appendChild(detail);

    if (message.notes) card.appendChild(el("p", "quiet", `note: ${message.notes}`));
    if (message.decidedBy) card.appendChild(el("p", "quiet", `last moved by ${message.decidedBy} ${ago(message.decidedAt)}`));

    const actions = el("div", "controls");
    const note = document.createElement("input");
    note.type = "text";
    note.className = "supportNote";
    note.autocomplete = "off";
    note.placeholder = "a note for whoever reads this next";
    note.value = String(message.notes ?? "");
    actions.appendChild(note);

    const move = async (button, state) => {
      button.disabled = true;
      try {
        const result = await api("POST", `/v1/admin/support/${message.id}/state`, { state, notes: note.value });
        banner(String(result.message ?? "Done."), true);
        await loadSupport();
      } catch (error) { banner(String(error.message)); }
      finally { button.disabled = false; }
    };
    // Two buttons on an open message, and a third only on one that has been moved. Reopen is not a
    // fourth state: it puts the row back to new, which is what "this is not actually dealt with"
    // means, and it is absent on a new message because there is nothing to undo.
    const buttons = message.state === "new"
      ? [["replied", "Mark replied"], ["closed", "Close"]]
      : [["replied", "Mark replied"], ["closed", "Close"], ["new", "Reopen"]];
    for (const [state, label] of buttons) {
      if (state === message.state) continue;
      const button = el("button", "ghost small", label);
      button.type = "button";
      button.addEventListener("click", () => move(button, state));
      actions.appendChild(button);
    }
    card.appendChild(actions);
    return card;
  }

  function supportChips(answer) {
    const counts = answer.counts ?? {};
    const waiting = Number(counts.new ?? 0);
    return [
      { label: "On record", value: answer.total ?? 0 },
      { label: "Unanswered", value: waiting, tone: waiting > 0 ? "warn" : "good" },
      { label: "Replied", value: counts.replied ?? 0 },
      { label: "Closed", value: counts.closed ?? 0 },
    ];
  }

  const supportHeadline = (answer) => {
    const waiting = Number(answer.counts?.new ?? 0);
    const door = answer.token ?? {};
    return {
      key: "support",
      label: "Support unanswered",
      value: waiting,
      tone: !door.stored ? "bad" : waiting > 0 ? "warn" : "good",
      // A zero with no token minted is not good news, it is a door nothing can deliver through, and
      // the chip has to say which of the two it is looking at.
      detail: door.stored
        ? (waiting > 0 ? "somebody is waiting on an answer" : "nobody is waiting")
        : "no inbound token, so nothing can be delivered",
    };
  };

  async function loadSupport() {
    const state = $("supportState").value;
    const answer = await api("GET", `/v1/admin/support?state=${encodeURIComponent(state)}&limit=200`);
    summarise("panel-support", supportChips(answer), supportHeadline(answer));
    $("supportGates").textContent = String(answer.gates ?? "");

    const notify = answer.notify ?? {};
    const note = [
      `${answer.total} message${answer.total === 1 ? "" : "s"} on record`,
      `${answer.counts.new} unanswered`,
      notify.on === false
        ? "announcing is switched off, so nothing is told about a new message"
        : notify.workspace
          ? `announced in ${notify.workspace} (${notify.how})`
          : `nothing is announced: ${notify.why || "this control plane did not say why"}`,
      `measured ${when(answer.measuredAt)}`,
    ];
    $("supportNote").textContent = note.join(" - ");

    const door = answer.token ?? {};
    $("supportTokenNote").textContent = door.stored
      ? `An inbound token is stored. It is ${door.evidence}, and nothing here can show it again. Mint a new one to replace it.`
      : String(door.why ?? "no inbound token is stored yet.");

    // A minted token is shown once and is gone on the next load of this panel. It is written here
    // rather than left on screen for ever because it is a live credential on a shared machine's
    // display, and the operator's own copy of it belongs in the worker's secret.
    $("supportTokenValue").textContent = "";

    const host = $("supportRows");
    clear(host);
    const rows = answer.rows ?? [];
    if (rows.length === 0) {
      host.appendChild(el("p", "empty", door.stored
        ? "Nothing in this filter. That is a real answer: nobody has written to the support address."
        : "Nothing here, and nothing could arrive yet: mint an inbound token below and paste it into the email worker."));
      return;
    }
    for (const message of rows) host.appendChild(renderSupportCard(message));
  }

  $("supportState").addEventListener("change", () => { void loadSupport().catch((error) => banner(String(error.message))); });

  $("supportTokenForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("supportTokenMint");
    button.disabled = true;
    try {
      const result = await api("POST", "/v1/admin/support/token", {});
      banner(String(result.message), true);
      // The reload FIRST and the value after it, in that order: the load clears this line, so writing
      // the token before it would show the operator their one copy of a credential for a few hundred
      // milliseconds and then take it away again.
      await loadSupport();
      // Shown once, in one place, and never written into an input: a value in a field is a value a
      // password manager offers to save and a form re-post can repeat.
      $("supportTokenValue").textContent = String(result.token ?? "");
    } catch (error) { banner(String(error.message)); }
    finally { button.disabled = false; }
  });

  // ---- panel 9: the marketplace ----------------------------------------------------------------
  //
  // MARKET-26 and CLOUD-BROWSER-1, on one screen because they are the two ways the Marketplace goes
  // wrong without anybody noticing: a row that has drifted from what its vendor documents, and a
  // cloud browsing session nobody counted.
  //
  // The screen's own rules, the same two the rest of this page follows. Every state carries when it
  // was measured, and a number that could not be measured says so in words. The second one is why
  // proxy traffic is drawn the way it is below: one of the two cloud-browser vendors publishes no
  // per-session traffic figure at all, and printing 0 for it would read as free when it is in fact
  // the most expensive line on the page.

  const MARKETPLACE_STATE_WORDS = {
    verified: "verified",
    "needs-re-verification": "needs re-verification",
    "not-measured": "not measured",
  };

  function marketplaceStateChip(state) {
    if (state == null) return el("span", "quiet", "never run here");
    const word = MARKETPLACE_STATE_WORDS[state] ?? String(state);
    const tone = state === "verified" ? "ok" : state === "needs-re-verification" ? "refused" : "";
    return el("span", `chip${tone ? ` ${tone}` : ""}`, word);
  }

  function marketplaceChips(answer) {
    const stale = (answer.records ?? []).filter((one) => String(one.state) === "needs-re-verification").length;
    const ledger = answer.ledger ?? {};
    return [
      { label: "Catalog rows", value: (answer.catalog ?? []).length },
      { label: "Needs re-verification", value: stale, tone: stale === 0 ? "good" : "warn" },
      {
        label: "Cloud sessions",
        // Never a zero for a relay that could not be asked: no session opened and nobody counted
        // look identical on a screen and one of them is the expensive half of a bill.
        value: ledger.measured === true ? (ledger.tenants ?? []).reduce((sum, one) => sum + Number(one.sessions ?? 0), 0) : null,
        why: ledger.measured === true ? "" : String(ledger.why ?? "the relay could not be asked"),
      },
    ];
  }

  const marketplaceHeadline = (answer) => {
    const stale = (answer.records ?? []).filter((one) => String(one.state) === "needs-re-verification").length;
    return {
      key: "verification",
      label: "Needs re-verification",
      value: stale,
      tone: stale === 0 ? "good" : "warn",
      detail: stale === 0 ? "every row still matches its vendor's page" : "a vendor moved something under a marketing row",
    };
  };

  async function loadMarketplace() {
    const answer = await api("GET", "/v1/admin/marketplace");
    summarise("panel-marketplace", marketplaceChips(answer), marketplaceHeadline(answer));
    const records = new Map((answer.records ?? []).map((record) => [String(record.rowId), record]));

    const rows = $("marketplaceRows").querySelector("tbody");
    clear(rows);
    if (answer.catalogProblem) {
      rows.appendChild(rowSpanning(5, String(answer.catalogProblem)));
    } else if ((answer.catalog ?? []).length === 0) {
      rows.appendChild(rowSpanning(5, "No catalog row carries vendor facts to re-read."));
    }
    for (const row of answer.catalog ?? []) {
      const record = records.get(row.id);
      const tr = document.createElement("tr");
      const name = el("td", null, row.name);
      name.title = `${row.id} · ${row.category}`;
      tr.appendChild(name);

      const last = document.createElement("td");
      last.appendChild(measured(record?.checkedAt ?? null, "this job has not run in this container yet", ago));
      if (record?.checkedAt) last.title = when(record.checkedAt);
      tr.appendChild(last);

      const state = document.createElement("td");
      state.appendChild(marketplaceStateChip(record?.state));
      tr.appendChild(state);

      tr.appendChild(el("td", "num", String((row.docs ?? []).length)));

      // What the CUSTOMER is being told right now, which is a different fact from the one above it:
      // their console reads the dates compiled into the released bundle, so between releases it goes
      // by age and can honestly disagree with this screen.
      const seen = el("td", null, row.customerSees);
      seen.title = `their page goes by age: these facts were read ${row.oldestCheckedOn} and this row is re-read every ${row.recheckDays} days`;
      tr.appendChild(seen);
      rows.appendChild(tr);
    }

    // What actually moved, with both sides quoted, so nobody has to go and read the vendor's page
    // to find out what the word "changed" meant.
    const changes = $("marketplaceChanges");
    clear(changes);
    for (const record of answer.records ?? []) {
      for (const change of record.changed ?? []) {
        const node = el("div", "card changed");
        node.appendChild(el("div", "title", `${record.name}: ${change.what}`));
        node.appendChild(el("div", "detail", `we expect: ${change.expected}`));
        node.appendChild(el("div", "detail", `the page now says: ${String(change.found).slice(0, 400)}`));
        node.appendChild(el("div", "detail", change.url));
        changes.appendChild(node);
      }
      for (const missed of record.unreadable ?? []) {
        const node = el("div", "card");
        node.appendChild(el("div", "title", `${record.name}: not measured`));
        node.appendChild(el("div", "detail", missed.reason));
        node.appendChild(el("div", "detail", missed.url));
        changes.appendChild(node);
      }
    }

    const ledger = answer.ledger ?? {};
    const ledgerBody = $("marketplaceLedger").querySelector("tbody");
    clear(ledgerBody);
    if (ledger.measured !== true) {
      ledgerBody.appendChild(rowSpanning(5, `not measured: ${ledger.why || "the relay could not be asked"}`));
    } else if ((ledger.tenants ?? []).length === 0) {
      ledgerBody.appendChild(rowSpanning(5, "No cloud browsing session has been opened yet."));
    }
    for (const row of ledger.tenants ?? []) {
      const tr = document.createElement("tr");
      tr.appendChild(el("td", null, row.tenant));
      tr.appendChild(el("td", "num", String(row.sessions)));
      tr.appendChild(el("td", "num", `${Math.round(Number(row.minutes) * 10) / 10} min`));

      // THE CELL THIS PANEL EXISTS FOR. A null is a vendor that publishes no traffic figure, and it
      // renders as that sentence. Never a zero: browser time is cents an hour and residential proxy
      // traffic is dollars a gigabyte, so a zero here hides the larger of the two numbers.
      const proxy = el("td", "num");
      if (row.proxyBytes === null || row.proxyBytes === undefined) {
        const node = el("span", "quiet", "not reported by this vendor");
        node.title = `${(row.proxyUnreportedBy ?? []).join(", ")} publishes no per-session traffic figure`;
        proxy.appendChild(node);
      } else {
        proxy.appendChild(text(bytes(row.proxyBytes) ?? "not measured"));
        // A PARTIAL FIGURE SAYS SO ON THE SCREEN, not only in a tooltip. This workspace has run
        // sessions on both vendors and only one of them reports traffic, so "10 MB" on its own is a
        // number an operator would reasonably read as the total and budget against. Nobody hovers a
        // cell that looks complete.
        if ((row.proxyUnreportedBy ?? []).length > 0) {
          const rest = el("div", "quiet", `plus ${row.proxyUnreportedBy.join(", ")}, not reported`);
          rest.title = `${row.proxyUnreportedBy.join(", ")} publishes no per-session traffic figure, so this total is only the part that is measured`;
          proxy.appendChild(rest);
        }
      }
      tr.appendChild(proxy);
      tr.appendChild(el("td", null, (row.vendors ?? []).join(", ")));
      ledgerBody.appendChild(tr);
    }
    $("marketplaceLedgerNote").textContent = ledger.note
      ?? "One row per session a workspace has opened on a cloud browser.";

    const rollup = answer.rollup;
    $("marketplaceDelivery").textContent = [
      rollup == null
        ? "This re-read has not run in this container yet."
        : `Last run ${when(rollup.ranAt)} (${rollup.source}), ${rollup.meteredRuns} metered runs: it reads documentation pages and never starts a browser.`,
      "A flip lands here immediately and on a customer's page at the next release, because nothing pushes this state into a running box. `marketplace verify --write` is what moves the dates they see.",
      (answer.ignores ?? []).length > 0 ? `Ignored as boilerplate when comparing: ${answer.ignores.join("; ")}.` : "",
    ].filter(Boolean).join(" ");
  }

  // ---- everything at once ----------------------------------------------------------------------

  // Which Overview chip each loader owns, in the order they are started below. The Overview is drawn
  // from what the nine registered, so a loader that threw has to have its chip written back to
  // "not measured": otherwise the number it registered on the last successful Refresh would sit
  // there looking current while the panel behind it is dark.
  const LOADER_HEADLINE = ["attacks", "clients", "boxes", null, "spend", null, "feedback", "support", "verification"];

  async function loadAll() {
    banner("");
    const button = $("refresh");
    button.disabled = true;
    // Each panel loads on its own and reports its own failure into its own space, so one route
    // being down does not blank the other eight. `allSettled`, deliberately.
    //
    // ALL NINE, WHICHEVER PANEL IS ON SCREEN. The rail decides what is shown and never what is
    // fetched: an operator who opens Box health during an outage must not then wait on a request
    // that could have been made a second earlier, and the Overview's figures all come from these
    // nine, so loading them lazily would leave it half drawn.
    const results = await Promise.allSettled([loadSignIns(), loadClients(), loadBoxes(), loadSystem(), loadSpend(), loadProviders(), loadFeedback(), loadSupport(), loadMarketplace()]);
    button.disabled = false;
    const broken = results.filter((result) => result.status === "rejected" && String(result.reason?.message) !== "unauthorized");
    if (broken.length > 0) banner(`${broken.length} panel${broken.length === 1 ? "" : "s"} could not be loaded: ${broken.map((row) => row.reason.message).join("; ")}`);
    results.forEach((result, index) => {
      const key = LOADER_HEADLINE[index];
      if (key == null || result.status !== "rejected") return;
      const row = OVERVIEW.find((one) => one.key === key);
      headlines.set(key, { key, label: row?.label ?? key, value: null, why: String(result.reason?.message ?? "this panel did not load") });
    });
    renderOverview();
    // The one flag a browser gate waits on, rather than a fixed sleep. It says the render finished,
    // not that everything in it succeeded, which is exactly what a gate wants to inspect. It counts
    // the LOADERS the refresh runs, which is nine; the page carries ELEVEN panels, because two of them
    // fetch nothing: the Overview is drawn from what the nine registered, and Keys (KEYS-2) is drawn
    // by the System health loader out of the two answers it already had.
    window.__adminLive = { panels: 9, at: new Date().toISOString() };
    document.body.setAttribute("data-admin-loaded", "true");
  }

  // A tab reopened with a session still in sessionStorage goes straight in. A token that has since
  // expired lands on the 401 above and comes back to the door.
  if (token.length > 0) {
    showConsole(stored.get(EMAIL_KEY));
    void loadAll();
  } else {
    showDoor("");
  }
})();
