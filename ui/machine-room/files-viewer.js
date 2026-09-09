/*
 * The file viewer. Owner: CONSOLE-4 item D. Stub installed by item A.
 * -------------------------------------------------------------------
 * Jason, 2026-09-08: "When there is a file and I click Files, like when Titan created a Markdown
 * file for me, I can't do anything with it. If I go to his desktop and click Files, it shows me
 * files we've created, but I can't click, open, or view it."
 *
 * Item A made every file row a real control and routed all three of them here -- the desktop
 * Files tile, and Open and Download on a transcript attachment. What is left for item D is the
 * viewer itself, and the relay route behind Download.
 *
 * Item A publishes the seam and this file fills it. app.js calls it and no-ops cleanly while this
 * is a stub:
 *
 *   window.__filesViewer.open({ path, agentId, name, download })
 *
 * `path` is always bare. gateway-adapter's filesOf runs every path through localPathOf now, which
 * it did not before -- and that mattered: the host answers null for the file:// form (4 bytes on
 * the wire) and 2,712 bytes for the same file asked for by bare path. Wiring a viewer onto the old
 * list would have shipped a button that opened 1 file of 11 and then failed on it.
 *
 * No new machinery is needed, and no new gateway command. openPanel is the modal the evidence and
 * exchange viewers already use; paragraphMarkup already renders headings, bullets, numbered lists
 * and inline marks, so Markdown needs no library; maskSecrets is already applied to attachment
 * text and stays applied inside the viewer; escapeHtml is there for everything else. All of them
 * are on window.__mrUi. readAttachmentText, readAttachmentChunk and readAttachmentImage already
 * exist, are wired through gateway-protocol.ts, carry a real path check, and were measured live on
 * Jason's box returning rsi-vs-agi-notes.md in 165 ms cold and 52 ms warm. So this whole item is a
 * relay ship: no source/host change, no host bundle, no updateHostNow, no box touched.
 *
 * Two boundaries item D should keep. The viewer only ever opens paths that came out of that
 * agent's own transcript, and offers no field a person can type a path into, because
 * readAttachmentImage ignores agentId entirely and checks only the sand root. And /workspace is
 * deliberately out of scope: 65 entries on his box shared by every agent with no per-agent
 * directory, so the attachments path check cannot be reused, and a listing command would turn a
 * relay restart into a three-box host swap. It gets a GAP row, not a rushed implementation.
 */
