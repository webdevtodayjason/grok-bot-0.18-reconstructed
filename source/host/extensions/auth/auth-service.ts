import type { Clock, RetryPolicy } from "../../../internal/scheduling.js";
import { getSandBackendMode } from "../../../shared/node/backend-mode.js";
import { getConfiguredBackendUrl } from "../../../shared/node/cursor-token.js";
import { getOrCreateHostMachineId } from "../../host-secret-store.js";
import {
  readDevInferenceCredentialFile,
  renewSandBoxInferenceCredential,
  SandInferenceCredentialRenewer,
  SAND_DEV_INFERENCE_TOKEN_FILE_ENV,
  SAND_INFERENCE_RENEWAL_CREDENTIAL_ENV,
  type InferenceCredential,
  type RenewalResult
} from "./credential-renewer.js";

export class SandCredentialsWaitingError extends Error {
  constructor(message: string) { super(message); this.name = "SandCredentialsWaitingError"; }
}

export const EXPIRY_LEEWAY_MS = 30_000;
export const SAND_SHORTLIVED_CREDS_WAITING_MESSAGE = "Waiting for an inference credential. Grok Bot's computer renews this automatically (no desktop required); this resolves on its own shortly.";

export class InferenceCredentialStore {
  private credential: InferenceCredential | undefined;
  setCredential(credential: InferenceCredential): void { if (credential.accessToken.length > 0) this.credential = credential; }
  getValidAccessToken(now = Date.now()): string | null {
    const credential = this.credential;
    return credential === undefined || now >= credential.expiresAtMs - EXPIRY_LEEWAY_MS ? null : credential.accessToken;
  }
  hasValidCredential(now = Date.now()): boolean { return this.getValidAccessToken(now) !== null; }
  clear(): void { this.credential = undefined; }
}

export interface HostAuthRenewalEvent extends RenewalResult { readonly isFirstCredential: boolean; }

export function createHostAuthService(options: {
  readonly retry: RetryPolicy;
  readonly clock: Clock;
  readonly log: (message: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly backendUrl?: string;
  readonly renewCredential?: (backendUrl: string, credential: string) => Promise<InferenceCredential>;
  readonly readDevCredential?: (path: string) => Promise<InferenceCredential>;
  readonly getMachineId?: () => Promise<string>;
  /** CURSOR-1. Injected by the tests; production asks `getSandBackendMode()`. */
  readonly isBackendOurs?: boolean;
}) {
  const env = options.env ?? process.env;
  const store = new InferenceCredentialStore();
  const listeners = new Set<(event: HostAuthRenewalEvent) => void>();
  let lastRenewalEvent: HostAuthRenewalEvent | null = null;
  let wroteFirstCredential = false;
  const emit = (event: HostAuthRenewalEvent) => {
    lastRenewalEvent = event;
    for (const listener of [...listeners]) {
      try { listener(event); }
      catch (error) { options.log(`credential renewal listener failed: ${String(error)}`); }
    }
  };
  const devTokenFile = env[SAND_DEV_INFERENCE_TOKEN_FILE_ENV]?.trim() ?? "";
  const isDevTokenFile = devTokenFile.length > 0;
  const hasRenewalCredential = isDevTokenFile || (env[SAND_INFERENCE_RENEWAL_CREDENTIAL_ENV]?.trim() ?? "").length > 0;
  const renewer = new SandInferenceCredentialRenewer({
    getCredential: isDevTokenFile ? () => devTokenFile : () => env[SAND_INFERENCE_RENEWAL_CREDENTIAL_ENV]?.trim() ?? null,
    renew: isDevTokenFile
      ? () => (options.readDevCredential ?? ((path) => readDevInferenceCredentialFile({ path })))(devTokenFile)
      : (credential) => (options.renewCredential ?? ((backendUrl, value) => renewSandBoxInferenceCredential({ backendUrl, credential: value })))(options.backendUrl ?? getConfiguredBackendUrl(env), credential),
    setCredential: (credential) => { wroteFirstCredential = store.getValidAccessToken() == null; store.setCredential(credential); },
    onResult: (result) => {
      const isFirstCredential = result.outcome === "renewed" && wroteFirstCredential;
      wroteFirstCredential = false;
      if (result.outcome === "failed") options.log(`inference-credential renewal failed (streak ${result.consecutiveFailures}): ${result.errorSummary ?? "unknown error"}`);
      emit({ ...result, isFirstCredential });
    },
    retry: options.retry,
    clock: options.clock
  });
  /**
   * CURSOR-1. The renewer is a forever loop against the backend (or against a file the backend is
   * meant to keep fresh), backing off between 30 s and 30 min. On a box with no backend of ours its
   * only real effect was noise and harm: Jason measured "inference-credential renewal failed
   * (streak N): ENOENT" on every tenant box on the R750 until the file was copied in by hand, and
   * on the boxes where the file WAS present it made `peekAccessToken()` non-null -- which is the
   * test the auto-review router used to choose the upstream classifier over REVIEW-1's local one.
   * Real inference credentials come from the endpoint picker, which writes SAND_OPENAI_COMPATIBLE_*
   * into the box's own secrets file and never touches this loop.
   */
  const isBackendOurs = options.isBackendOurs ?? getSandBackendMode() === "ours";
  if (isBackendOurs) {
    renewer.start();
    options.log(isDevTokenFile
      ? `DEV inference-credential renewer started, reading short-lived tokens from ${devTokenFile} (dev:box-docker local loop)`
      : hasRenewalCredential
        ? "inference-credential renewer started (backend self-renewal is the sole inference-credential source)"
        : "inference-credential renewer started, but no renewal credential was delivered into the box; inference is unavailable until the box is re-provisioned with one");
  } else {
    options.log("inference-credential renewer is off: this box has no backend of ours configured, so there is nothing to renew against. Inference credentials come from the endpoint settings.");
  }
  return {
    async getAccessToken(_options?: { readonly backendUrl?: string }): Promise<string> {
      let token = store.getValidAccessToken();
      if (token === null && hasRenewalCredential && isBackendOurs) {
        const renewed = await renewer.requestImmediateRenewal();
        if (renewed) token = store.getValidAccessToken();
      }
      if (token === null) throw new SandCredentialsWaitingError(SAND_SHORTLIVED_CREDS_WAITING_MESSAGE);
      return token;
    },
    peekAccessToken: () => store.getValidAccessToken(),
    getLastRenewalEvent: () => lastRenewalEvent,
    getMachineId: options.getMachineId ?? (() => getOrCreateHostMachineId()),
    subscribeToRenewal(listener: (event: HostAuthRenewalEvent) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    dispose(): void { renewer.close(); listeners.clear(); }
  };
}
