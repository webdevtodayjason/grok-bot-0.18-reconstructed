import {
  isTranscriptJournalCorruptionError,
  transcriptRepairRefusal,
  type TranscriptRepairReport,
} from "./transcript-journal-repair.js";

export type TranscriptMirrorRoute = "journal" | "legacy";

export interface TranscriptJournalPort<Checkpoint, Store> {
  ownsConversation(conversationId: string): Promise<boolean>;
  claimConversation(conversationId: string): Promise<void>;
  recover(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<unknown>;
  prepareCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    finalizeCheckpoint?: boolean
  ): Promise<unknown>;
  commitCheckpoint(ctx: unknown, conversationId: string): Promise<unknown>;
  abortCheckpoint(ctx: unknown, conversationId: string): Promise<unknown>;
  skipCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<unknown>;
  /**
   * BOX-6b. Optional so a test double or an older journal stays a valid port; when it is present
   * the router uses it to unstick a conversation whose prepare demanded a recovery first.
   */
  repairConversation?(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<TranscriptRepairReport>;
}

export interface LegacyTranscriptMirrorPort<Checkpoint, Store> {
  write(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    stateBlobId: Uint8Array
  ): Promise<unknown>;
}

interface LegacyPending<Checkpoint, Store> {
  readonly checkpoint: Checkpoint;
  readonly blobStore: Store;
}

/**
 * Pins a conversation to one persistence regime. Once a journal marker owns a
 * conversation, turning the experiment off cannot route it back to the legacy
 * writer. Route promises are cached so concurrent first writes cannot race two
 * claims or split a transcript between implementations.
 */
export class RoutedTranscriptMirror<Checkpoint, Store> {
  readonly legacyPending = new Map<
    string,
    LegacyPending<Checkpoint, Store>
  >();

  constructor(
    readonly journal: TranscriptJournalPort<Checkpoint, Store>,
    readonly legacy: LegacyTranscriptMirrorPort<Checkpoint, Store>,
    readonly isJournalEnabled: () => Promise<boolean>,
    readonly routes = new Map<string, Promise<TranscriptMirrorRoute>>()
  ) {}

  route(conversationId: string): Promise<TranscriptMirrorRoute> {
    const selected = this.routes.get(conversationId);
    if (selected != null) return selected;

    const route = this.selectRoute(conversationId);
    this.routes.set(conversationId, route);
    return route;
  }

  private async selectRoute(
    conversationId: string
  ): Promise<TranscriptMirrorRoute> {
    if (await this.journal.ownsConversation(conversationId)) return "journal";
    if (!await this.isJournalEnabled()) return "legacy";

    await this.journal.claimConversation(conversationId);
    return "journal";
  }

  async recover(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<void> {
    if (await this.route(conversationId) !== "journal") return;
    await this.journal.recover(ctx, conversationId, checkpoint, blobStore);
  }

  async prepareCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store,
    finalizeCheckpoint = false,
    writeLegacyCheckpoint = finalizeCheckpoint
  ): Promise<void> {
    if (await this.route(conversationId) === "journal") {
      try {
        await this.journal.prepareCheckpoint(
          ctx,
          conversationId,
          checkpoint,
          blobStore,
          finalizeCheckpoint
        );
      } catch (error) {
        // BOX-6b. "transcript checkpoint must recover before preparing" is not damage, it is a
        // recovery that never ran: the journal's in-memory maps are empty until one does, and the
        // turn path had no way to ask for one. Repair, then try the prepare EXACTLY once. A retry
        // on the retry would spin a wedged conversation for the life of the box.
        const repair = this.journal.repairConversation;
        if (repair == null || !isTranscriptJournalCorruptionError(error)) throw error;

        const report = await repair.call(
          this.journal,
          ctx,
          conversationId,
          checkpoint,
          blobStore
        );
        if (report.outcome === "needs-attention") throw transcriptRepairRefusal(report);

        await this.journal.prepareCheckpoint(
          ctx,
          conversationId,
          checkpoint,
          blobStore,
          finalizeCheckpoint
        );
      }
      return;
    }

    if (writeLegacyCheckpoint) {
      this.legacyPending.set(conversationId, { checkpoint, blobStore });
    }
  }

  async commitCheckpoint(
    ctx: unknown,
    conversationId: string,
    stateBlobId: Uint8Array
  ): Promise<void> {
    if (await this.route(conversationId) === "journal") {
      await this.journal.commitCheckpoint(ctx, conversationId);
      return;
    }

    const pending = this.legacyPending.get(conversationId);
    if (pending == null) return;
    this.legacyPending.delete(conversationId);

    // The legacy mirror is observational. Failure must not roll back a durable
    // agent-store checkpoint or fail the turn.
    await this.legacy.write(
      ctx,
      conversationId,
      pending.checkpoint,
      pending.blobStore,
      stateBlobId
    ).then(
      () => undefined,
      () => undefined
    );
  }

  async abortCheckpoint(
    ctx: unknown,
    conversationId: string
  ): Promise<void> {
    if (await this.route(conversationId) === "journal") {
      await this.journal.abortCheckpoint(ctx, conversationId);
      return;
    }
    this.legacyPending.delete(conversationId);
  }

  async skipCheckpoint(
    ctx: unknown,
    conversationId: string,
    checkpoint: Checkpoint,
    blobStore: Store
  ): Promise<void> {
    let selected = this.routes.get(conversationId);
    let recoverOwnedJournal = false;

    if (selected == null) {
      if (!await this.journal.ownsConversation(conversationId)) {
        this.legacyPending.delete(conversationId);
        return;
      }

      recoverOwnedJournal = true;
      selected = Promise.resolve("journal");
      this.routes.set(conversationId, selected);
    }

    if (await selected === "journal") {
      if (recoverOwnedJournal) {
        await this.journal.recover(
          ctx,
          conversationId,
          checkpoint,
          blobStore
        );
      }
      await this.journal.skipCheckpoint(
        ctx,
        conversationId,
        checkpoint,
        blobStore
      );
      return;
    }

    this.legacyPending.delete(conversationId);
  }

}

// Compatibility names used by earlier recovered modules.
export type TranscriptMirrorPort<Checkpoint, Store> =
  TranscriptJournalPort<Checkpoint, Store>;
export type LegacyMirrorPort<Checkpoint, Store> =
  LegacyTranscriptMirrorPort<Checkpoint, Store>;
