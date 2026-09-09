/*
 * The between-chats badge. Owner: CONSOLE-4 item B. Stub installed by item A.
 * --------------------------------------------------------------------------
 * Jason, 2026-09-08: "All the shell commands and everything that happens in between chats, while
 * the agent is doing work, can live inside a badge, right? If I want, I can click the badge to
 * expand it or just leave it shrunk inside the badge."
 *
 * Item A publishes the seam and this file fills it. app.js calls both of these and no-ops cleanly
 * while this is a stub, so item A can merge before item B exists:
 *
 *   window.__gapBadge.render(rows, messageMarkup, { agentId, working }) -> html string
 *   window.__gapBadge.toggle(element)                                  -> expand / collapse
 *
 * `rows` is foldRepeatedRows(contextMessages()). The vocabulary is smaller than it looks: every
 * between-chats row is type "system" in one of three shapes (plain tool row, SHOT-4 receipt row,
 * Messaged row), and every card that must stay OUTSIDE a badge -- decision, secret, connector,
 * hand-off, turn-failed, attachment, the working bubble -- is already another type. So the gap
 * predicate is one line and the never-hides-a-card requirement needs no special casing. Evidence
 * chips render inside the reply's own row and notices are toasts outside the transcript, so
 * neither is between-chats content either.
 *
 * Two facts item B will need, both measured on grok-bot-local-vm during the design pass. Badge
 * state cannot live in the DOM: a working turn wiped #transcript five times in 36 s and an opened
 * receipt snapped shut within 2 s, so expanded/collapsed belongs in module state plus
 * localStorage. And duration cannot be faked: no tool row carries a timestamp of any kind, so
 * where both bounding chat entries exist the badge can say the span (messagesOf carries
 * timestampMs on chat rows now) and where one is missing it says the step count alone.
 *
 * DASH-FOLD-1's step-count folding stays inside the expanded view -- foldRepeatedRows runs before
 * this file sees the rows, so it is already done.
 *
 * Until item B lands, app.js falls back to rows.map(messageMarkup).join("") -- today's transcript,
 * unchanged.
 */
