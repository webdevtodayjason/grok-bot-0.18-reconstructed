import { createHash } from "node:crypto";

/** The v5-shaped rendering both ids below share: version 5 and the RFC variant, over a sha256. */
function uuidFromDigest(hex: string): string { const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`; }

export function stableAutomationId(args: { agentId: string; localId: string }): string { return uuidFromDigest(createHash("sha256").update(Buffer.from(`${args.agentId}\0${args.localId}`)).digest("hex")); }

/**
 * The run id a locally scheduled fire uses, derived from the slot it is serving rather than
 * minted fresh. Two things fall out of that. A tick that fires the same slot twice (a restart
 * between the fire and the run row, two ticks racing) lands on the run the store already opened,
 * because beginRun returns an existing row with this id instead of writing a second one. And the
 * slot stops being invisible: a routine fired late, after the box was down through its slot, is
 * recorded under the slot it was owed rather than under the minute it happened to come back.
 */
export function localScheduleRunUuid(args: { agentId: string; localId: string; slotMs: number }): string { return uuidFromDigest(createHash("sha256").update(Buffer.from(`local-schedule\0${args.agentId}\0${args.localId}\0${Math.trunc(args.slotMs)}`)).digest("hex")); }
