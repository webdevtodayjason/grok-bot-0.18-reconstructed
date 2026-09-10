// cp/voice.mjs -- the minutes ledger and the caps behind spoken work (VOICE-1, docs/VOICE.md).
//
// WHAT THIS SERVICE OWNS, and it is only this: the vendor table a person picks from, the numbers
// that say how long a workspace may talk, and the row that says it did. It holds no realtime key, it
// opens no socket to a vendor, and it never sees a frame of audio. The relay does all three: it
// holds the browser's socket and the vendor's socket, it reads that workspace's own key off its own
// disk, and it counts the seconds on its own clock. This service answers numbers and writes down
// what happened.
//
// WHY THE CAP IS HERE AND NOT IN THE CONSOLE, which is the whole reason this file exists. A cap a
// customer can raise is not a cap. The Voice card in a customer's own console writes the KEY and
// nothing else; the minutes live in admin_settings on this side, reachable only with the operator's
// bearer, exactly as mail's two send caps do (cp/mail.mjs, sendCaps). A customer raising their own
// day cap is unbounded spend on somebody else's invoice, and it would be one fetch away if the
// number lived in their own state file beside the key.
//
// WHY THE RELAY STILL COUNTS. The enforcement truth is the relay's own jsonl on the relay's own
// disk, because this service can be down and a session in flight must still end on time. What this
// service gives the relay is the POLICY -- three numbers and an allowlist, cached sixty seconds,
// with the constants below as the fallback -- and what it takes back is a REPORT. A control plane
// outage costs a Spend line and never a cap. That is also how it behaves on grok-bot-local-vm, where
// there is no control plane at all.
//
// WHY THE ROW IS CLAIMED BEFORE THE DIAL. The rule is already written in this tree at the mail send
// routes (cp/server.mjs, "TWO ROUTES AND NOT ONE"): the claim happens before the thing happens and
// the outcome is only known after. A voice row written on close does not exist for a relay that
// crashed or a tab closed mid-sentence, and the day cap is read out of these same rows, so getting
// it backwards is unbounded spend rather than a missing report. An open row counts at its CURRENT
// elapsed, which is the only way a session that is running right now counts toward the day at all.
//
// WHAT IS NOT IN A ROW: no transcript, no audio, no key, no recipient, nothing a person said. The
// same rule mail's ledger lives by (ui/mail-edge.mjs). A row is who, when, how long, and how much of
// each meter.

/** The shape of a vendor's session frame. One transport, two session builders; the relay picks. */
export const WIRE_FLAT = "flat";
export const WIRE_TYPED = "typed";

/**
 * The authoritative realtime vendor table. The CLI, the Voice card and docs/VOICE.md all name these
 * rows; cp/proxy.mjs's two preset rows feed NOTHING the relay reads and are there only so the
 * super-admin panel does not look like it has never heard of realtime.
 *
 * THE BRIEF'S PREMISE THAT BOTH VENDORS SPEAK THE SAME WIRE IS FALSE as of 2026-09-09, and `wire`
 * is where that correction lives. xAI takes the FLAT session -- `session.voice` and
 * `session.turn_detection` at the top level, no `session.type`. OpenAI's GA realtime REFUSES that
 * exact body with `Unknown parameter: 'session.voice'` and wants `session.type: "realtime"`,
 * `audio.output.voice`, `audio.input.transcription` and no `OpenAI-Beta` header. So a URL swap is
 * not a provider swap, and anything in this product that says otherwise is out of date.
 *
 * `price` carries the published number, WITH the date it was read and what kind of source it was,
 * because a price with no date is a price that will be wrong and will still look authoritative.
 * Nothing here is computed from a bill. The two meters a row records are wall seconds and audio
 * seconds, and these numbers are what turns either into money by hand.
 *
 * AND THE SECOND CORRECTION: xAI is the default for PREDICTABILITY and not for the headline rate.
 * Its current realtime model is $0.08 a minute of audio; the $0.05 figure people quote belongs to
 * grok-voice-think-fast-1.0, which is deprecated. What xAI actually buys is a flat per-minute rate
 * with no context re-billing and a free `function_call_output`, which is the event this design sends
 * most.
 */
export const REALTIME_VENDORS = Object.freeze({
  xai: Object.freeze({
    id: "xai",
    name: "xAI realtime",
    wire: WIRE_FLAT,
    url: "wss://api.x.ai/v1/realtime",
    defaultModel: "grok-voice-think-fast-2.0",
    voices: Object.freeze(["eve", "leo", "rex", "gork"]),
    price: Object.freeze({
      audioPerMinuteUsd: 0.08,
      audioPerHourUsd: 4.8,
      // Every `conversation.item.create` this bridge sends is billed at this flat rate EXCEPT a
      // function_call_output and an audio item, which are free. That is why Titan's reply goes back
      // as function_call_output pieces and why the "still going" nudges are bounded: each nudge is a
      // billed event, not just a word.
      perBilledItemEventUsd: 0.004,
      readAt: "2026-09-09",
      source: "vendor page",
      deprecated: Object.freeze({ model: "grok-voice-think-fast-1.0", audioPerMinuteUsd: 0.05 }),
    }),
  }),
  openai: Object.freeze({
    id: "openai",
    name: "OpenAI realtime",
    wire: WIRE_TYPED,
    url: "wss://api.openai.com/v1/realtime",
    defaultModel: "gpt-realtime-2.1",
    voices: Object.freeze(["alloy", "cedar", "marin", "shimmer"]),
    price: Object.freeze({
      // Per million tokens: audio in, text in, audio out. There is no per-minute number on the
      // vendor's page, so there is none here: a per-minute band for this vendor is third-party
      // analysis and docs/VOICE.md marks it as that rather than quoting it as a price.
      audioInPerMillionUsd: 32.0,
      textInPerMillionUsd: 0.4,
      audioOutPerMillionUsd: 64.0,
      mini: Object.freeze({ model: "gpt-realtime-2.1-mini", audioInPerMillionUsd: 10.0, textInPerMillionUsd: 0.3, audioOutPerMillionUsd: 20.0 }),
      readAt: "2026-09-09",
      source: "vendor page",
      // The single most expensive mistake available on this vendor: the base instructions are
      // written ONCE at session.update and are byte-identical for the life of the socket. Rewriting
      // them invalidates the cached prefix and re-bills the whole conversation every turn.
      note: "the whole prefix is re-read every turn, so the instructions are written once and never edited",
    }),
  }),
});

/** The vendor ids this product knows how to dial, in the order a person is offered them. */
export const REALTIME_VENDOR_IDS = Object.freeze(Object.keys(REALTIME_VENDORS));

/** xAI, for the reason written on the table above: a flat minute, not a cheaper one. */
export const REALTIME_VENDOR_DEFAULT = "xai";

// ---- the caps ------------------------------------------------------------------------------------
//
// WALL SECONDS, not audio seconds, and the doc says so where a person reads it. A minute of wall
// clock is the only number somebody can predict before they start talking; audio seconds are what
// each vendor bills on and the two are not the same, which is why a row records both.

/** Half an hour of talking in one go. */
export const SESSION_CAP_MINUTES = 30;
/** Two hours a day for a whole workspace, the day being a UTC one. */
export const DAY_CAP_MINUTES = 120;

export const SESSION_CAP_SETTING = "voice.sessionMinutes";
export const DAY_CAP_SETTING = "voice.dayMinutes";
export const VENDORS_SETTING = "voice.vendors";

/**
 * Either number or the allowlist, for one workspace: `voice.dayMinutes.<slug>`. The per-workspace
 * row wins over the global one, and neither exists until the operator writes it. The same shape
 * cp/mail.mjs sendCapSetting uses, so an operator who has read one has read both.
 */
export const voiceSetting = (name, slug) => `${name}.${String(slug ?? "")}`;

/** The one word that means "off for this workspace" rather than "this row is a typo". */
export const VENDORS_NONE = "none";

const MINUTE_MS = 60_000;

/** "in 12 minutes" / "in under a minute". Plain words: a bot reads this sentence out to a person. */
function inWords(seconds) {
  const whole = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (whole < 60) return "in under a minute";
  if (whole < 3600) { const n = Math.ceil(whole / 60); return `in ${n} minute${n === 1 ? "" : "s"}`; }
  const n = Math.ceil(whole / 3600);
  return `in ${n} hour${n === 1 ? "" : "s"}`;
}

/** The UTC day a moment falls in, which is the day the cap resets on. */
export const utcDay = (at) => new Date(Number(at)).toISOString().slice(0, 10);
/** The UTC month the Spend panel reports on. */
export const utcMonth = (at) => new Date(Number(at)).toISOString().slice(0, 7);

/**
 * A vendor list off a settings row.
 *
 * The word `none` is honoured and means an empty allowlist, which is how an operator switches voice
 * off for one workspace in one word. ANYTHING ELSE that names no vendor this product knows falls
 * back to the default, for the reason cp/mail.mjs capOf gives about a number: a typo in a settings
 * row must never be the thing that changes what a customer can do. An empty allowlist from a typo
 * reads to that customer as voice being broken, and there would be nothing anywhere to say why.
 */
export function parseVendors(raw, fallback = REALTIME_VENDOR_IDS) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (text.length === 0) return [...fallback];
  if (text === VENDORS_NONE) return [];
  const asked = text.split(/[,\s]+/).map((one) => one.trim()).filter((one) => one.length > 0);
  const known = asked.filter((one) => Object.prototype.hasOwnProperty.call(REALTIME_VENDORS, one));
  return known.length > 0 ? [...new Set(known)] : [...fallback];
}

/**
 * The minutes ledger and the caps, over a store.
 *
 * `config` is read for nothing today and is taken anyway, because createMailDirectory and
 * createMailSends are both handed it and a third shape beside two would be the thing a reader has to
 * check rather than assume.
 */
export function createVoiceLog({ store, config = null, now = () => Date.now() } = {}) {
  void config;

  const minutesOf = (name, slug, fallback) => {
    for (const value of [store.getSetting(voiceSetting(name, slug), ""), store.getSetting(name, "")]) {
      const asked = Number.parseInt(String(value ?? "").trim(), 10);
      // A row that is not a positive number falls back rather than uncapping or zeroing anybody: a
      // typo must never be what takes a limit off, and a zero typed into a minutes field would read
      // as "voice is broken" rather than as a decision. `--vendors none` is the decision.
      if (Number.isFinite(asked) && asked > 0) return asked;
    }
    return fallback;
  };

  const vendorsOf = (slug) => {
    const perWorkspace = store.getSetting(voiceSetting(VENDORS_SETTING, slug), "");
    if (String(perWorkspace).trim().length > 0) return parseVendors(perWorkspace);
    return parseVendors(store.getSetting(VENDORS_SETTING, ""));
  };

  /** The three numbers and the allowlist, with no secret anywhere near them. */
  const caps = (slug) => ({
    sessionMinutes: minutesOf(SESSION_CAP_SETTING, slug, SESSION_CAP_MINUTES),
    dayMinutes: minutesOf(DAY_CAP_SETTING, slug, DAY_CAP_MINUTES),
    vendors: vendorsOf(slug),
  });

  /**
   * How much of a still-open session falls INSIDE a window. The window is [from, to) in milliseconds.
   *
   * The clip is the whole point and it is not tidiness. Counting only closed rows was the first bug
   * this guarded against -- a single session left open all afternoon read as nought seconds used, and
   * the cap never fired while the thing it caps was happening. MEASURED on this Mac 2026-09-09, the
   * first fix for that had the same hole one midnight later: a session started at 23:59:30 and still
   * running at 00:05 was matched by NEITHER day, because the row's own date belongs to yesterday and
   * the sum for today only looked at rows dated today. So a session can be running, burning a
   * workspace's minutes, and count against no day at all, up to the session cap's worth.
   *
   * So an open row contributes the part of its elapsed time that lies inside the window being asked
   * about, whichever day it started on, and the caller asks about rows from the day before as well.
   */
  const openSecondsInWindow = (row, from, to, at, capSeconds = 0) => {
    const started = Date.parse(row.startedAt);
    if (!Number.isFinite(started)) return 0;
    const begin = Math.max(started, from);
    const end = Math.min(at, to);
    const inside = Math.max(0, Math.round((end - begin) / 1000));
    // CLAMPED TO THE SESSION CAP, the same clamp ui/voice-edge.mjs daySecondsUsed applies, and for
    // the same reason: a row is open either because the session is running -- in which case the
    // relay's own tick ends it at the cap -- or because the relay went away before it could settle.
    // Unclamped, the second case accrues for ever. MEASURED on this Mac 2026-09-10 before this: one
    // row claimed and never closed read 3,600 s an hour later, refused that workspace's next call by
    // the day cap after six and a half hours, and after three days the Spend line said 143 hours
    // while the policy's own day number said nought -- two figures off one service, 143 hours apart.
    // reconcileOpen below settles such a row; this is what the numbers say until it runs.
    return capSeconds > 0 ? Math.min(inside, capSeconds) : inside;
  };

  /** Midnight UTC at the start of a YYYY-MM-DD. */
  const dayStart = (day) => Date.parse(`${day}T00:00:00.000Z`);
  /** The day before a YYYY-MM-DD, which is where a session that straddled midnight is filed. */
  const dayBefore = (day) => utcDay(dayStart(day) - 86_400_000);

  /**
   * What this workspace has spent of one UTC day, counting a session that is RUNNING RIGHT NOW for
   * whatever part of it falls inside that day.
   */
  const daySeconds = (slug, day, at) => {
    const from = dayStart(day);
    const to = from + 86_400_000;
    const capSeconds = caps(slug).sessionMinutes * 60;
    let seconds = 0;
    let open = 0;
    // This day's rows, and YESTERDAY's, because an open row from yesterday is still running today.
    // Two queries rather than one so the index on (tenant, started_at) is still the one being used.
    for (const theDay of [dayBefore(day), day]) {
      for (const row of store.listVoiceSessions({ tenant: slug, day: theDay })) {
        if (row.state === "open") {
          // Every open row in either day is open RIGHT NOW, whichever day it started on, so it counts
          // as one open session and contributes the part of itself that lies inside this day.
          open += 1;
          seconds += openSecondsInWindow(row, from, to, at, capSeconds);
          continue;
        }
        // A closed row counts its whole reported wall clock against the day it STARTED on, which is
        // the day an operator reading a ledger would look for it under.
        if (theDay === day) seconds += Number(row.wallSeconds) || 0;
      }
    }
    return { seconds, open };
  };

  /** Midnight UTC after this moment, which is when a day cap gives its minutes back. */
  const nextMidnight = (at) => Date.parse(`${utcDay(at + 86_400_000)}T00:00:00.000Z`);

  return {
    /** The whole vendor table, for the CLI and the doc. Frozen, so a caller cannot edit the source. */
    vendors: REALTIME_VENDORS,

    caps,

    /**
     * Settle every row that cannot still be running, and say how many. Called once when this service
     * starts, on the pattern the fallback reconcile at cp/server.mjs boot already uses.
     *
     * WHY A ROW IS LEFT OPEN AT ALL: the relay claims before it dials and settles on close, so a
     * relay that is restarted -- three times during this wave's own ship -- leaves rows nobody will
     * ever close. MEASURED on this Mac 2026-09-10, one such row read 3,600 s after an hour, refused
     * that workspace's next call on the day cap after six and a half hours, and after three days the
     * Spend line said 143 hours while the policy's day number said nought. The clamp above stops the
     * number growing; this stops the row pretending to be live, and the Spend line then says what
     * happened rather than counting.
     *
     * A row younger than the session cap is LEFT ALONE, because it may really be running: this
     * service cannot see the relay's sockets, and the cap is the longest a session can legitimately
     * be open for.
     */
    reconcileOpen({ at = now() } = {}) {
      const closed = [];
      for (const row of store.listVoiceSessions({})) {
        if (row.state !== "open") continue;
        const started = Date.parse(row.startedAt);
        if (!Number.isFinite(started)) continue;
        const capSeconds = caps(row.tenant).sessionMinutes * 60;
        const elapsed = Math.max(0, Math.round((at - started) / 1000));
        if (elapsed <= capSeconds) continue;
        store.closeVoiceSession(row.sessionId, {
          endedAt: new Date(started + capSeconds * 1000).toISOString(),
          // What it can honestly be said to have cost: the longest it was allowed to run for.
          wallSeconds: capSeconds,
          audioInSeconds: Number(row.audioInSeconds) || 0,
          audioOutSeconds: Number(row.audioOutSeconds) || 0,
          billedItemEvents: Number(row.billedItemEvents) || 0,
          toolCalls: Number(row.toolCalls) || 0,
          heldFrames: Number(row.heldFrames) || 0,
          closeReason: "the relay went away",
        });
        closed.push({ sessionId: row.sessionId, slug: row.tenant, wallSeconds: capSeconds });
      }
      return { closed, why: closed.length === 0 ? "no voice row was left open by a relay that went away" : "" };
    },

    /**
     * What the relay is told before it dials, and the only thing it is told. Numbers and an
     * allowlist: no key, no url, no credential, nothing a log would have to be scrubbed of.
     *
     * `dayRemainingSeconds` is what the relay starts its own clock against. It is advisory by
     * design -- the relay enforces from its own jsonl -- so this being a minute stale or this
     * service being unreachable costs a Spend line and never a cap.
     */
    policy(slug) {
      const tenant = String(slug ?? "").trim();
      const at = now();
      const limits = caps(tenant);
      const used = daySeconds(tenant, utcDay(at), at);
      const dayCapSeconds = limits.dayMinutes * 60;
      return {
        slug: tenant,
        sessionMinutes: limits.sessionMinutes,
        sessionCapSeconds: limits.sessionMinutes * 60,
        dayMinutes: limits.dayMinutes,
        dayCapSeconds,
        dayUsedSeconds: used.seconds,
        dayRemainingSeconds: Math.max(0, dayCapSeconds - used.seconds),
        openSessions: used.open,
        vendors: limits.vendors,
        defaultVendor: limits.vendors.includes(REALTIME_VENDOR_DEFAULT) ? REALTIME_VENDOR_DEFAULT : (limits.vendors[0] ?? ""),
        day: utcDay(at),
        resetsAt: new Date(nextMidnight(at)).toISOString(),
        measuredAt: new Date(at).toISOString(),
      };
    },

    /**
     * The claim. Both caps, then the row, and the row is written before the relay dials a vendor.
     *
     * An over-cap call writes NO row, so a refused workspace cannot be pushed further over its limit
     * by being refused, which is the same order cp/mail.mjs openSend keeps.
     *
     * The sentence in a refusal is what a person hears out loud. It names no vendor, no model, no
     * setting name and no number of seconds: plain words and a when.
     */
    openSession({ slug, sessionId, agentId = "", vendor = "", model = "" } = {}) {
      const tenant = String(slug ?? "").trim();
      const session = String(sessionId ?? "").trim();
      if (tenant.length === 0 || session.length === 0) {
        return { ok: false, error: "bad_request", message: "Name the workspace and the session this is for." };
      }
      const at = now();
      const limits = caps(tenant);
      const asked = String(vendor ?? "").trim().toLowerCase();
      if (limits.vendors.length === 0) {
        return { ok: false, error: "voice_off", message: "Voice is not switched on for this workspace yet." };
      }
      if (asked.length > 0 && !limits.vendors.includes(asked)) {
        // Deliberately says nothing about WHICH provider: the person at the microphone has no way to
        // act on a vendor id and the console never shows one.
        return { ok: false, error: "vendor_not_allowed", message: "Voice is not switched on for this workspace yet." };
      }
      const dayCapSeconds = limits.dayMinutes * 60;
      const used = daySeconds(tenant, utcDay(at), at);
      if (used.seconds >= dayCapSeconds) {
        const wait = Math.max(1, Math.round((nextMidnight(at) - at) / 1000));
        return {
          ok: false,
          error: "day_cap",
          retryAfterSeconds: wait,
          message: `This workspace has used all the voice time it has for today, so nothing was started. It starts again ${inWords(wait)}.`,
        };
      }
      const id = store.openVoiceSession({
        sessionId: session,
        tenant,
        agentId: String(agentId ?? ""),
        vendor: asked,
        model: String(model ?? ""),
        at: new Date(at).toISOString(),
      });
      return {
        ok: true,
        id,
        sessionId: session,
        sessionCapSeconds: limits.sessionMinutes * 60,
        // What is left AFTER this row exists, which is what the relay should hold its session to
        // when the day has less left in it than one whole session.
        dayRemainingSeconds: Math.max(0, dayCapSeconds - used.seconds),
        vendors: limits.vendors,
      };
    },

    /**
     * And what it came to. Both meters and the event count, because xAI bills audio sent-or-received
     * plus a flat fee per billable text event while OpenAI bills audio tokens with the whole prefix
     * re-read every turn: one "minutes" column reconciles against neither invoice.
     *
     * A close for a session nobody claimed is a 404 rather than a row: a report with no claim means
     * the claim was lost, and inventing the row here would hide exactly the case the claim-first
     * rule exists to expose.
     */
    closeSession({
      sessionId,
      wallSeconds = 0,
      audioInSeconds = 0,
      audioOutSeconds = 0,
      billedItemEvents = 0,
      toolCalls = 0,
      heldFrames = 0,
      closeReason = "",
    } = {}) {
      const session = String(sessionId ?? "").trim();
      if (session.length === 0) return { ok: false, error: "bad_request", message: "Name the session to settle." };
      const row = store.getVoiceSession(session);
      if (row == null) return { ok: false, error: "not_found", message: "Nothing claimed that session, so there is no row to settle." };
      // A SECOND CLOSE LEAVES THE ROW ALONE, and answers ok so a retry is not an error.
      //
      // The relay reports the close best effort and retries, so this arrives twice whenever its first
      // attempt times out after the write landed. MEASURED on this Mac 2026-09-09 before this guard: a
      // replay carrying 99999 seconds overwrote a settled 100, which is the one way a number on this
      // ledger can change after the fact -- and the day cap is read out of these rows. Idempotent is
      // the same discipline openVoiceSession keeps with ON CONFLICT DO NOTHING, for the same reason.
      if (row.state === "closed") return { ok: true, id: row.id, sessionId: session, alreadyClosed: true };
      const whole = (value) => Math.max(0, Math.round(Number(value) || 0));
      store.closeVoiceSession(session, {
        endedAt: new Date(now()).toISOString(),
        wallSeconds: whole(wallSeconds),
        audioInSeconds: whole(audioInSeconds),
        audioOutSeconds: whole(audioOutSeconds),
        billedItemEvents: whole(billedItemEvents),
        toolCalls: whole(toolCalls),
        heldFrames: whole(heldFrames),
        closeReason: String(closeReason ?? "").slice(0, 200),
      });
      return { ok: true, id: row.id, sessionId: session };
    },

    /**
     * The operator's read, for the Spend line and the CLI.
     *
     * EVERY NUMBER SAYS WHICH METER IT IS, in `meters`, because three of them are seconds and they
     * are seconds of different things. A column headed "minutes" with no such sentence beside it is
     * the thing that makes an invoice impossible to check.
     *
     * `everMeasured` is false when this table has never held a row at all, and that is the flag the
     * panel draws "not measured" from. A zero from a meter nobody has ever reported is not a zero,
     * which is written out at cp/admin/admin.js over the Spend table after a real screenshot bug.
     */
    usage({ slug = "", day = "" } = {}) {
      const at = now();
      const tenant = String(slug ?? "").trim();
      const theDay = String(day ?? "").trim();
      const month = theDay.length > 0 ? "" : utcMonth(at);
      const rows = store.listVoiceSessions({
        tenant: tenant.length > 0 ? tenant : null,
        day: theDay.length > 0 ? theDay : null,
        month: month.length > 0 ? month : null,
      });
      // The window an open row's elapsed is clipped to. A day is the day; a month runs from its first
      // midnight to the next month's; and a read with neither is every row there has ever been, so the
      // window is everything.
      const windowFrom = theDay.length > 0
        ? dayStart(theDay)
        : (month.length > 0 ? Date.parse(`${month}-01T00:00:00.000Z`) : 0);
      const windowTo = theDay.length > 0
        ? windowFrom + 86_400_000
        : (month.length > 0 ? Date.parse(`${utcMonth(Date.parse(`${month}-01T00:00:00.000Z`) + 32 * 86_400_000)}-01T00:00:00.000Z`) : Number.MAX_SAFE_INTEGER);
      const byTenant = new Map();
      // One settings read per tenant rather than one per row: a month of rows for one workspace would
      // otherwise ask the same two settings questions a thousand times.
      const capCache = new Map();
      const capFor = (tenant) => {
        if (!capCache.has(tenant)) capCache.set(tenant, caps(tenant).sessionMinutes * 60);
        return capCache.get(tenant);
      };
      for (const row of rows) {
        const key = row.tenant;
        if (!byTenant.has(key)) {
          byTenant.set(key, {
            slug: key,
            sessions: 0,
            open: 0,
            wallSeconds: 0,
            audioInSeconds: 0,
            audioOutSeconds: 0,
            billedItemEvents: 0,
            toolCalls: 0,
            heldFrames: 0,
            vendors: [],
          });
        }
        const line = byTenant.get(key);
        line.sessions += 1;
        if (row.state === "open") {
          line.open += 1;
          // Clipped to the window being reported, the same way the day cap clips, so the two numbers
          // agree: a session running across a boundary is not reported twice at its full length. And
          // clamped to that workspace's own session cap, because the Spend line and the cap must not
          // be able to disagree about the same row -- they did, by 143 hours, before this clamp.
          line.wallSeconds += openSecondsInWindow(row, windowFrom, windowTo, at, capFor(row.tenant));
        } else {
          line.wallSeconds += Number(row.wallSeconds) || 0;
        }
        line.audioInSeconds += Number(row.audioInSeconds) || 0;
        line.audioOutSeconds += Number(row.audioOutSeconds) || 0;
        line.billedItemEvents += Number(row.billedItemEvents) || 0;
        line.toolCalls += Number(row.toolCalls) || 0;
        line.heldFrames += Number(row.heldFrames) || 0;
        if (row.vendor.length > 0 && !line.vendors.includes(row.vendor)) line.vendors.push(row.vendor);
      }
      const answer = {
        window: { month, day: theDay },
        // Whether anything has EVER reported, rather than whether this window holds rows. The
        // difference is the whole of "not measured" against "nothing this month".
        everMeasured: store.countVoiceSessions() > 0,
        tenants: [...byTenant.values()].sort((one, two) => one.slug.localeCompare(two.slug)),
        meters: {
          wall: "wall clock, which is what the caps count and what a person can predict",
          audio: "audio seconds in and out, which is what a vendor's invoice is built from",
          events: "billable text events, a flat fee each on the default provider and free for a tool result",
        },
        // Only when there is nothing to say. Sent unconditionally it sat beside a populated tenant
        // list saying nothing had ever been reported, which is the one sentence an operator would
        // quote back -- and "not measured" has to mean not measured or it means nothing at all.
        ...(store.countVoiceSessions() > 0
          ? (byTenant.size === 0 ? { why: "nothing was spoken in this window" } : {})
          : { why: "no voice session has been reported to this service yet" }),
        measuredAt: new Date(at).toISOString(),
      };
      if (tenant.length > 0) answer.policy = this.policy(tenant);
      return answer;
    },

    /**
     * The operator's write, and there is no customer-reachable twin of it anywhere in this product.
     * A blank or absent field leaves that setting alone; `--vendors none` is the one word that turns
     * voice off for a workspace.
     */
    setCaps(slug, { dayMinutes = null, sessionMinutes = null, vendors = null } = {}, actor = "") {
      const tenant = String(slug ?? "").trim();
      if (tenant.length === 0) return { ok: false, error: "bad_request", message: "Name the workspace." };
      const wrote = [];
      const positive = (value) => {
        const asked = Number.parseInt(String(value ?? "").trim(), 10);
        return Number.isFinite(asked) && asked > 0 ? asked : null;
      };
      if (dayMinutes != null) {
        const minutes = positive(dayMinutes);
        if (minutes == null) return { ok: false, error: "bad_request", message: "A day cap is a whole number of minutes above nought." };
        store.setSetting(voiceSetting(DAY_CAP_SETTING, tenant), String(minutes), actor);
        wrote.push("dayMinutes");
      }
      if (sessionMinutes != null) {
        const minutes = positive(sessionMinutes);
        if (minutes == null) return { ok: false, error: "bad_request", message: "A session cap is a whole number of minutes above nought." };
        store.setSetting(voiceSetting(SESSION_CAP_SETTING, tenant), String(minutes), actor);
        wrote.push("sessionMinutes");
      }
      if (vendors != null) {
        const raw = Array.isArray(vendors) ? vendors.join(",") : String(vendors);
        const text = raw.trim().toLowerCase();
        if (text !== VENDORS_NONE) {
          const asked = text.split(/[,\s]+/).filter((one) => one.length > 0);
          const unknown = asked.filter((one) => !Object.prototype.hasOwnProperty.call(REALTIME_VENDORS, one));
          if (asked.length === 0 || unknown.length > 0) {
            return {
              ok: false,
              error: "bad_request",
              message: `This product knows ${REALTIME_VENDOR_IDS.join(" and ")}, or the word none to switch voice off for this workspace.`,
            };
          }
        }
        store.setSetting(voiceSetting(VENDORS_SETTING, tenant), text, actor);
        wrote.push("vendors");
      }
      if (wrote.length === 0) return { ok: false, error: "bad_request", message: "Name at least one of a day cap, a session cap or a provider list." };
      return { ok: true, slug: tenant, wrote, policy: this.policy(tenant) };
    },
  };
}
