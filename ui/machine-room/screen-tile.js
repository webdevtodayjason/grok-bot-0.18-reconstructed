/*
 * The rail's screen tile reader. Owner: CONSOLE-4 item C. Stub installed by item A.
 * --------------------------------------------------------------------------------
 * Jason, 2026-09-08: "The Titan screen at the top right says 'Click to open,' but there's a broken
 * image there. I think that's supposed to be a screenshot of what's on the browser at that moment."
 *
 * Item A fixed the broken image itself: renderScreenTile emits no <img> without a src, and
 * styles.css carries the [hidden] guard for the trap underneath it (.rail-screen-button img sets
 * display:block, which outranks the UA sheet's [hidden] on specificity, so Chrome painted its own
 * broken-image glyph -- measured on his console at 231x75 with naturalWidth 0). What is left for
 * item C is the picture: no reader is ever mounted for an idle agent, so there was nothing to show
 * even once the glyph was gone.
 *
 * Item A publishes the seam and this file fills it. app.js calls both of these and no-ops cleanly
 * while this is a stub:
 *
 *   window.__screenTile.frameFor(agentId)                        -> data URL, or "" for none
 *   window.__screenTile.sync({ agentId, seat, status, visible }) -> start / stop the reader
 *
 * The seat is known and the reader works today: getForeverBoxStatus {id} answers boxSeat 3 for
 * Titan, and a view_only client built the way boxHandoffEnsureThumb builds one returned a 390x244
 * webp of his real Chrome in 2,014 ms over the internet. Argument shape matters -- the command
 * takes `id`, not `agentId`, and the agentId form silently returns a stub with no boxSeat field,
 * which would make a gate wrongly conclude the host cannot say which screen an agent is on.
 *
 * Three controls are load-bearing, each already paid for once:
 *   - Refuse a frame that cannot be told from blank. The first sample on Titan's seat was 1,043
 *     characters of solid white; the next was 7,591 of the real desktop.
 *   - One reader at a time, torn down on conversation change, paused when the tab is hidden and
 *     while the desktop dialog is open, and never restarted on a render that merely carried no
 *     display. The comment at renderBoxHandoffSurfaces records what that last one cost: the first
 *     frame went from 1.4 s to 33 s.
 *   - A still by default, refreshing only while the agent is working. The alternative is a
 *     standing screen-share of the operator's own browsing -- his seat had Gmail, a GitHub account
 *     and a YouTube channel open when it was read.
 */
