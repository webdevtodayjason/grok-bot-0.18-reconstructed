import { defineHostExtension } from "../../../internal/host-extensions.js";
import { SAND_SUMMARIZATION_MODEL_ID } from "../../../shared/agents/sand-agent-model.js";
import {
  readSandBoxSetting,
  resolveAutoReviewEnforceEnabled,
  SAND_AUTO_REVIEW_MODE_SETTING,
  SAND_AUTO_REVIEW_SETTING,
} from "../../sand-box-setting.js";
import { SAND_AUTO_REVIEW_HOST_GENERATION } from "../../runner/sand-auto-review.js";
import { HostExtensions } from "../extension-ids.generated.js";
import {
  AutoReviewService,
  parseLocalAutoReviewMode,
  type AutoReviewServiceDeps,
} from "./auto-review-service.js";
import { createSandBackendSmartModeClassifierExecutor } from "./sand-backend-smart-mode-classifier-exec.js";
import {
  createSandAutoReviewClassifierRouter,
  type SandAutoReviewModelSession,
} from "./sand-local-auto-review-classifier.js";

type AutoReviewAuth = Parameters<typeof createSandBackendSmartModeClassifierExecutor>[0];
type AutoReviewClassifier = ReturnType<typeof createSandAutoReviewClassifierRouter>;
type AutoReviewInference = {
  readonly port: {
    createSession(
      onRequestId: (requestId: string) => void,
      options?: Readonly<Record<string, unknown>>,
    ): SandAutoReviewModelSession;
  };
};
type AutoReviewDependencies = Omit<
  AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>,
  "hostGeneration" | "getLocalMode" | "getEnforceEnabled" | "now" | "createClassifierExecutor"
> & {
  readonly transcript: AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>["transcript"] & {
    createAwaitingStateSink(): AutoReviewServiceDeps<AutoReviewClassifier, AutoReviewAuth>["awaitingSink"];
    listAgentIds(): Promise<readonly string[]>;
    expireAllPendingAutoReviewApprovalCards(): Promise<unknown>;
  };
};

export const autoReviewExtension = defineHostExtension<
  AutoReviewService<AutoReviewClassifier, AutoReviewAuth>
>({
  id: HostExtensions.AutoReview,
  dependencies: [
    HostExtensions.Auth,
    HostExtensions.Experiments,
    HostExtensions.Inference,
    HostExtensions.Settings,
    HostExtensions.Telemetry,
    HostExtensions.Transcript,
  ],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as AutoReviewAuth & {
      peekAccessToken?(): string | null;
    };
    const experiments = context.deps[HostExtensions.Experiments] as AutoReviewDependencies["experiments"];
    const inference = context.deps[HostExtensions.Inference] as AutoReviewInference;
    const settings = context.deps[HostExtensions.Settings] as AutoReviewDependencies["settings"];
    const telemetry = (context.deps[HostExtensions.Telemetry] as {
      logs: AutoReviewDependencies["telemetry"];
    }).logs;
    const transcript = context.deps[HostExtensions.Transcript] as AutoReviewDependencies["transcript"];
    const service = new AutoReviewService({
      auth,
      experiments,
      settings,
      telemetry,
      awaitingSink: transcript.createAwaitingStateSink(),
      transcript,
      hostGeneration: SAND_AUTO_REVIEW_HOST_GENERATION,
      getLocalMode: () => parseLocalAutoReviewMode(readSandBoxSetting(SAND_AUTO_REVIEW_MODE_SETTING)),
      getEnforceEnabled: () => resolveAutoReviewEnforceEnabled(
        readSandBoxSetting(SAND_AUTO_REVIEW_SETTING),
        () => experiments.checkFeatureGate("sand_auto_review"),
      ),
      createClassifierExecutor: (classifierAuth) => createSandAutoReviewClassifierRouter({
        backend: createSandBackendSmartModeClassifierExecutor(classifierAuth),
        hasBackendCredential: () => auth.peekAccessToken?.() != null,
        // Out of turn, on the routed provider, same shape as the memory synthesiser: this is a
        // short one-shot judgement, not a conversation, so it takes the summarization session and
        // stays out of the agent's own labeling and transcript.
        createModelSession: () => inference.port.createSession(() => {}, {
          modelId: SAND_SUMMARIZATION_MODEL_ID,
          isSummarizationSession: true,
          skipLabeling: true,
        }),
      }),
    });
    context.onStop(() => service.stop());
    const startedAtMs = Date.now();
    const sweepBadges = () => service.sweepStaleAwaitingBadges(
      () => transcript.listAgentIds(),
      startedAtMs,
    );
    void transcript.expireAllPendingAutoReviewApprovalCards().then(sweepBadges, sweepBadges);
    return service;
  },
});
