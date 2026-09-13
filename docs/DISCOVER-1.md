# DISCOVER-1: the welcome bar

Jason, 2026-09-13 07:31, with three Hugging Face screenshots: a "Welcome to Titanium Bot" pill in
the console header that opens a list of steps with counts and strikethroughs, and a bar that fills
as the person discovers the product. Post-onboarding; if they skip onboarding the steps are still
there. Measured, never self-reported; per person; Hide retires it, Settings brings it back.

Six steps, each ticked from evidence the relay can read for the signed-in person:
1. Say hello to Titan: a user message exists in Titan's conversation.
2. Make a voice call: a settled voice_sessions row over 10 s for this workspace (cp read).
3. Connect an app: a connector with a credential on the box (the marketplace's own read).
4. Give Titan a memory: at least one memory fact (getAgentMemories).
5. Watch his screen: the desktop pane opened once (a per-person flag the relay stores).
6. Put him in your pocket: a device bearer for this account (cp device sessions).

Two halves.

**Relay and control plane (Claude):** GET /discover on the relay answers {steps:[{id, label, done,
count, of}], pct, hidden} for the signed-in person, from the reads above (each read has a 1.5 s
budget and a missing read counts as not done, never as an error); POST /discover/hide and
/discover/show store the per-person flag on the control plane beside the other per-person rows.
Tests for the reads, the budget, the flags.

**Console (Codex):** the pill and bar in the window bar where the workspace name sits (brand
tokens: Signal Cyan on Midnight, no purple gradient; the pill reads "Welcome to Titanium Bot" with
the percentage; hidden at 100% or after Hide); the dropdown lists the six rows with counts and a
strikethrough on done ones, one Hide button; on a phone (max-width 690px) the pill is 44 px high
and the dropdown is a sheet. Polls /discover on load and every 60 s while open. A Settings row
"Show the welcome bar" calls /discover/show. Browser leg at 1440x900 and 390x844 with a fake
/discover answer; desktop measurements elsewhere byte for byte.
Rules: worktrees only, no push, no R750, no GUI browser, no em dashes.
