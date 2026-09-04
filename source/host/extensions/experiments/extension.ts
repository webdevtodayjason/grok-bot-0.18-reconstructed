import { defineHostExtension } from "../../../internal/host-extensions.js";
import { getSandRootDir } from "../../host-paths.js";
import { resolveMultitaskEnabled } from "../../sand-multitask.js";
import { readSandBoxSetting, resolveBrowserUseEnabled, resolveTeachEnabled, SAND_BROWSER_USE_SETTING, SAND_TEACH_SETTING } from "../../sand-box-setting.js";
import { resolveSpotlightEnabled } from "../../../shared/sand-spotlight.js";
import { SandExperimentService } from "../../../shared/node/experiments/cursor-experiments.js";
import { HostExtensions } from "../extension-ids.generated.js";

interface AuthApi { getAccessToken(options: { backendUrl: string }): Promise<string>; getMachineId(): Promise<string>; peekAccessToken(): string | null; subscribeToRenewal(listener: (event: { outcome: string; isFirstCredential: boolean }) => void): () => void; }
interface SettingsApi { subscribeToFeatureFlagOverrides(listener: (overrides: Record<string, boolean>) => void): () => void; }
export const experimentsExtension = defineHostExtension({
  id: HostExtensions.Experiments, dependencies: [HostExtensions.Auth, HostExtensions.Settings],
  start: (context) => {
    const auth = context.deps[HostExtensions.Auth] as AuthApi; const settings = context.deps[HostExtensions.Settings] as SettingsApi;
    const service = new SandExperimentService({ getAccessToken: auth.getAccessToken, getMachineId: auth.getMachineId, getCacheDir: () => getSandRootDir(), isDevBuild: process.env.SAND_PACKAGED !== "1" || process.env.SAND_HOST_DEV_ERROR_DETAIL === "1" });
    service.start(); context.onStop(() => service.dispose()); context.onStop(auth.subscribeToRenewal((event) => { if (event.outcome === "renewed" && (event.isFirstCredential || !service.hasAuthenticatedStatsigBootstrap())) service.handleAuthChange(); }));
    if (auth.peekAccessToken() !== null) service.handleAuthChange(); context.onStop(settings.subscribeToFeatureFlagOverrides((overrides) => service.replaceFeatureFlagOverrides(overrides)));
    // FLAGS-1. Gates default false and never bootstrap without an xAI login, and nothing said which
    // capability was off for that reason. One line at start, per gate that matters on this box.
    try {
      // Only a value that actually decides may be named: every resolver ignores an empty string,
      // and readSandBoxSetting reads the container env before the settings file, so a row that
      // says "host setting" when the value came from the environment names the wrong switch.
      const fromEnv = (name: string | undefined) => name !== undefined && (process.env[name]?.trim() ?? "").length > 0;
      const source = (envName?: string, settingName?: string) =>
        fromEnv(settingName) ? `env ${settingName}`
        : settingName !== undefined && readSandBoxSetting(settingName) !== undefined ? `host setting ${settingName}`
        : fromEnv(envName) ? `env ${envName}`
        : service.hasAuthenticatedStatsigBootstrap() ? "statsig" : "bundled default";
      const gate = (name: Parameters<typeof service.checkFeatureGate>[0]) => service.checkFeatureGate(name);
      const rows: Record<string, { value: boolean; source: string }> = {
        sand_browser_use_subagent: { value: resolveBrowserUseEnabled(readSandBoxSetting(SAND_BROWSER_USE_SETTING), () => gate("sand_browser_use_subagent")), source: source(undefined, SAND_BROWSER_USE_SETTING) },
        grok_bot_dynamic_tools: { value: gate("grok_bot_dynamic_tools"), source: source() },
        sand_agent_network: { value: gate("sand_agent_network"), source: source() },
        sand_multitask: { value: resolveMultitaskEnabled(process.env.SAND_MULTITASK, () => gate("sand_multitask")), source: source("SAND_MULTITASK") },
        sand_spotlight: { value: resolveSpotlightEnabled(process.env.SAND_SPOTLIGHT, () => gate("sand_spotlight")), source: source("SAND_SPOTLIGHT") },
        sand_global_search: { value: gate("sand_global_search"), source: source() },
        sand_teach_by_demonstration: { value: resolveTeachEnabled(readSandBoxSetting(SAND_TEACH_SETTING), () => gate("sand_teach_by_demonstration")), source: source(undefined, SAND_TEACH_SETTING) },
        // FLAGS-2. Both decide whether a shipped feature runs at all, and neither was in the table:
        // memory synthesis is armed once, from this gate, at authenticated bootstrap (memory
        // extension), and auto-review only escalates past shadow when sand_auto_review is on
        // (auto-review-service). Off here means the feature is silently inert, not broken.
        sand_memory_dreaming: { value: gate("sand_memory_dreaming"), source: source() },
        sand_auto_review: { value: gate("sand_auto_review"), source: source() },
        sand_stale_root_gc: { value: gate("sand_stale_root_gc"), source: source("SAND_STALE_ROOT_GC", "SAND_STALE_ROOT_GC") },
        grok_bot_conversation_gc: { value: gate("grok_bot_conversation_gc"), source: source("SAND_CONVERSATION_GC", "SAND_CONVERSATION_GC") },
        sand_legacy_store_blob_retirement: { value: gate("sand_legacy_store_blob_retirement"), source: source("SAND_RETIRE_LEGACY_STORE_BLOBS", "SAND_RETIRE_LEGACY_STORE_BLOBS") },
      };
      console.log(`[sand][gates] ${JSON.stringify(rows)}`);
    } catch (error) { console.warn(`[sand][gates] table failed: ${error instanceof Error ? error.message : String(error)}`); }
    return {
      checkFeatureGate: (name: Parameters<typeof service.checkFeatureGate>[0]) => service.checkFeatureGate(name), getFeatureGateProperty: (name: Parameters<typeof service.getFeatureGateProperty>[0]) => service.getFeatureGateProperty(name),
      checkGate: (name: Parameters<typeof service.checkGate>[0], options?: { timeoutMs?: number }) => service.checkGate(name, options), getDynamicConfig: (name: Parameters<typeof service.getDynamicConfig>[0]) => service.getDynamicConfig(name), subscribe: (listener: Parameters<typeof service.subscribe>[0]) => service.subscribe(listener),
      pinGateOnAuthenticatedBootstrap: (name: Parameters<typeof service.pinGateOnAuthenticatedBootstrap>[0], pin: (value: boolean) => void) => service.pinGateOnAuthenticatedBootstrap(name, pin), hasHydratedStatsigUserId: () => service.hasHydratedStatsigUserId(), waitForHydratedStatsigUserId: (timeoutMs?: number) => service.waitForHydratedStatsigUserId(timeoutMs),
      hasAuthenticatedStatsigBootstrap: () => service.hasAuthenticatedStatsigBootstrap(), getSandModelExperimentState: () => service.getSandModelExperimentState(), logSandModelExperimentExposure: () => service.logSandModelExperimentExposure(), getConfiguredDefaultModel: () => service.getConfiguredDefaultModel(), getConfiguredAutomationsModel: () => service.getConfiguredAutomationsModel(), getComputerUseModelOverride: () => service.getComputerUseModelOverride(), getBrowserUseModelOverride: () => service.getBrowserUseModelOverride(),
      isAgentNetworkEnabled: () => service.checkFeatureGate("sand_agent_network"), isMcpMultiAccountEnabled: () => service.checkFeatureGate("mcp_multi_account"), isSparsePluginClonesEnabled: () => service.checkFeatureGate("enable_sparse_plugin_clones"),
      isMultitaskEnabled: () => resolveMultitaskEnabled(process.env.SAND_MULTITASK, () => service.checkFeatureGate("sand_multitask")), isSendMessageDeliveryOwedEnabled: () => service.checkFeatureGate("sand_send_message_delivery_owed"), isDynamicToolsEnabled: () => service.checkFeatureGate("grok_bot_dynamic_tools"), isBrowserUseSubagentEnabled: () => resolveBrowserUseEnabled(readSandBoxSetting(SAND_BROWSER_USE_SETTING), () => service.checkFeatureGate("sand_browser_use_subagent")),
      isSpotlightEnabled: () => resolveSpotlightEnabled(process.env.SAND_SPOTLIGHT, () => service.checkFeatureGate("sand_spotlight")), isUnicodeTypingEnabled: () => service.checkFeatureGate("sand_computer_use_unicode_typing"), isUaTokenKillSwitchEnabled: () => service.checkFeatureGate("sand_browser_ua_token_kill_switch")
    };
  }
});
