/** Mechanically recovered from the immutable 0.18 host bundle. */
type GatewayApi = any;
export function parseCommandArgs(body: string): unknown { return body.length > 0 ? JSON.parse(body) : {}; }
export const SAND_GATEWAY_COMMANDS = {
  getTranscript: (api: GatewayApi) => api.getTranscript(),
  getAgentTranscript: (api: GatewayApi, body: string) => api.getAgentTranscript(parseCommandArgs(body)),
  getAgentTranscriptPage: (api: GatewayApi, body: string) => api.getAgentTranscriptPage(parseCommandArgs(body)),
  openAgentWindowed: (api: GatewayApi, body: string) => api.openAgentWindowed(parseCommandArgs(body)),
  getAgentTranscriptWindow: (api: GatewayApi, body: string) => api.getAgentTranscriptWindow(parseCommandArgs(body)),
  openAgentTail: (api: GatewayApi, body: string) => api.openAgentTail(parseCommandArgs(body)),
  getAgentTranscriptTail: (api: GatewayApi, body: string) => api.getAgentTranscriptTail(parseCommandArgs(body)),
  getAgentThread: (api: GatewayApi, body: string) => api.getAgentThread(parseCommandArgs(body)),
  sendPrompt: (api: GatewayApi, body: string) => api.sendPrompt(parseCommandArgs(body)),
  promptAcceptanceStatus: (api: GatewayApi, body: string) => api.promptAcceptanceStatus(parseCommandArgs(body)),
  respondToWidget: (api: GatewayApi, body: string) => api.respondToWidget(parseCommandArgs(body)),
  resolveAutoReviewApproval: (api: GatewayApi, body: string) => api.resolveAutoReviewApproval(parseCommandArgs(body)),
  resolveLocalToolPermission: (api: GatewayApi, body: string) => api.resolveLocalToolPermission(parseCommandArgs(body)),
  dismissWidget: (api: GatewayApi, body: string) => api.dismissWidget(parseCommandArgs(body)),
  submitSecret: (api: GatewayApi, body: string) => api.submitSecret(parseCommandArgs(body)),
  reactToMessage: (api: GatewayApi, body: string) => api.reactToMessage(parseCommandArgs(body)),
  appendConnectorCard: (api: GatewayApi, body: string) => api.appendConnectorCard(parseCommandArgs(body)),
  listAgents: (api: GatewayApi) => api.listAgents(),
  countAgents: (api: GatewayApi) => api.countAgents(),
  // AGENTS-CAP-1. Bots against the ceiling, for the Add button's "n of 12". `countAgents` above
  // counts groups too, so it is the wrong number to show beside a cap that never refuses one.
  getAgentCapacity: (api: GatewayApi) => api.getAgentCapacity(),
  searchAgents: (api: GatewayApi, body: string) => api.searchAgents(parseCommandArgs(body)),
  searchMedia: (api: GatewayApi, body: string) => api.searchMedia(parseCommandArgs(body)),
  createAgent: (api: GatewayApi, body: string) => api.createAgent(parseCommandArgs(body)),
  kickstartAgent: (api: GatewayApi, body: string) => api.kickstartAgent(parseCommandArgs(body)),
  requestDiskSaverAudit: (api: GatewayApi, body: string) => api.requestDiskSaverAudit(parseCommandArgs(body)),
  createGroup: (api: GatewayApi, body: string) => api.createGroup(parseCommandArgs(body)),
  setGroupMembers: (api: GatewayApi, body: string) => api.setGroupMembers(parseCommandArgs(body)),
  updateAgent: (api: GatewayApi, body: string) => api.updateAgent(parseCommandArgs(body)),
  deleteAgent: (api: GatewayApi, body: string) => api.deleteAgent(parseCommandArgs(body)),
  deleteAgents: (api: GatewayApi, body: string) => api.deleteAgents(parseCommandArgs(body)),
  duplicateAgent: (api: GatewayApi, body: string) => api.duplicateAgent(parseCommandArgs(body)),
  setAgentUnread: (api: GatewayApi, body: string) => api.setAgentUnread(parseCommandArgs(body)),
  setAgentNotificationsEnabled: (api: GatewayApi, body: string) => api.setAgentNotificationsEnabled(parseCommandArgs(body)),
  setAgentNotifyOnUpdates: (api: GatewayApi, body: string) => api.setAgentNotifyOnUpdates(parseCommandArgs(body)),
  setAgentHiddenFromSidebar: (api: GatewayApi, body: string) => api.setAgentHiddenFromSidebar(parseCommandArgs(body)),
  openAgent: (api: GatewayApi, body: string) => api.openAgent(parseCommandArgs(body)),
  setWindowFocused: (api: GatewayApi, body: string) => api.setWindowFocused(parseCommandArgs(body)),
  getAgentMemories: (api: GatewayApi, body: string) => api.getAgentMemories(parseCommandArgs(body)),
  deleteAgentMemory: (api: GatewayApi, body: string) => api.deleteAgentMemory(parseCommandArgs(body)),
  clearAgentMemories: (api: GatewayApi, body: string) => api.clearAgentMemories(parseCommandArgs(body)),
  getAgentAutomations: (api: GatewayApi, body: string) => api.getAgentAutomations(parseCommandArgs(body)),
  listAllAutomations: (api: GatewayApi) => api.listAllAutomations(),
  isAgentNetworkEnabled: (api: GatewayApi) => api.isAgentNetworkEnabled(),
  isGlobalSearchEnabled: (api: GatewayApi) => api.isGlobalSearchEnabled(),
  isEgressTunnelAvailable: (api: GatewayApi) => api.isEgressTunnelAvailable(),
  getSharingState: (api: GatewayApi) => api.getSharingState(),
  createRoomFromAgent: (api: GatewayApi, body: string) => api.createRoomFromAgent(parseCommandArgs(body)),
  createRoomInvite: (api: GatewayApi, body: string) => api.createRoomInvite(parseCommandArgs(body)),
  joinSharedRoom: (api: GatewayApi, body: string) => api.joinSharedRoom(parseCommandArgs(body)),
  respondToRoomJoinRequest: (api: GatewayApi, body: string) => api.respondToRoomJoinRequest(parseCommandArgs(body)),
  createSharedRoom: (api: GatewayApi, body: string) => api.createSharedRoom(parseCommandArgs(body)),
  addOwnAgentToSharedRoom: (api: GatewayApi, body: string) => api.addOwnAgentToSharedRoom(parseCommandArgs(body)),
  removeOwnAgentFromSharedRoom: (api: GatewayApi, body: string) => api.removeOwnAgentFromSharedRoom(parseCommandArgs(body)),
  setSharedRoomTyping: (api: GatewayApi, body: string) => api.setSharedRoomTyping(parseCommandArgs(body)),
  leaveSharedRoom: (api: GatewayApi, body: string) => api.leaveSharedRoom(parseCommandArgs(body)),
  setAgentAutomationEnabled: (api: GatewayApi, body: string) => api.setAgentAutomationEnabled(parseCommandArgs(body)),
  createAgentAutomation: (api: GatewayApi, body: string) => api.createAgentAutomation(parseCommandArgs(body)),
  updateAgentAutomation: (api: GatewayApi, body: string) => api.updateAgentAutomation(parseCommandArgs(body)),
  deleteAgentAutomation: (api: GatewayApi, body: string) => api.deleteAgentAutomation(parseCommandArgs(body)),
  runAgentAutomationNow: (api: GatewayApi, body: string) => api.runAgentAutomationNow(parseCommandArgs(body)),
  broadcastToAgents: (api: GatewayApi, body: string) => api.broadcastToAgents(parseCommandArgs(body)),
  getAgentWorkflows: (api: GatewayApi, body: string) => api.getAgentWorkflows(parseCommandArgs(body)),
  createAgentWorkflow: (api: GatewayApi, body: string) => api.createAgentWorkflow(parseCommandArgs(body)),
  updateAgentWorkflow: (api: GatewayApi, body: string) => api.updateAgentWorkflow(parseCommandArgs(body)),
  setAgentWorkflowEnabled: (api: GatewayApi, body: string) => api.setAgentWorkflowEnabled(parseCommandArgs(body)),
  setAgentWorkflowOwner: (api: GatewayApi, body: string) => api.setAgentWorkflowOwner(parseCommandArgs(body)),
  deleteAgentWorkflow: (api: GatewayApi, body: string) => api.deleteAgentWorkflow(parseCommandArgs(body)),
  runAgentWorkflowNow: (api: GatewayApi, body: string) => api.runAgentWorkflowNow(parseCommandArgs(body)),
  importAgentWorkflowText: (api: GatewayApi, body: string) => api.importAgentWorkflowText(parseCommandArgs(body)),
  importAgentWorkflowUrl: (api: GatewayApi, body: string) => api.importAgentWorkflowUrl(parseCommandArgs(body)),
  portAgentLocalSkills: (api: GatewayApi, body: string) => api.portAgentLocalSkills(parseCommandArgs(body)),
  getConversationOutline: (api: GatewayApi, body: string) => api.getConversationOutline(parseCommandArgs(body)),
  getAgentEvidence: (api: GatewayApi, body: string) => api.getAgentEvidence(parseCommandArgs(body)),
  getAgentActionAudit: (api: GatewayApi, body: string) => api.getAgentActionAudit(parseCommandArgs(body)),
  repairAgentTranscript: (api: GatewayApi, body: string) => api.repairAgentTranscript(parseCommandArgs(body)),
  skillsCatalog: (api: GatewayApi) => api.skillsCatalog(),
  syncPluginSkills: (api: GatewayApi) => api.syncPluginSkills(),
  getPluginSyncStatus: (api: GatewayApi) => api.getPluginSyncStatus(),
  getSkillPublishTargets: (api: GatewayApi) => api.getSkillPublishTargets(),
  publishSkill: (api: GatewayApi, body: string) => api.publishSkill(parseCommandArgs(body)),
  resyncPublishedSkill: (api: GatewayApi, body: string) => api.resyncPublishedSkill(parseCommandArgs(body)),
  unpublishSkill: (api: GatewayApi, body: string) => api.unpublishSkill(parseCommandArgs(body)),
  getAgentChannels: (api: GatewayApi, body: string) => api.getAgentChannels(parseCommandArgs(body)),
  connectChannel: (api: GatewayApi, body: string) => api.connectChannel(parseCommandArgs(body)),
  disconnectChannel: (api: GatewayApi, body: string) => api.disconnectChannel(parseCommandArgs(body)),
  refreshChannel: (api: GatewayApi, body: string) => api.refreshChannel(parseCommandArgs(body)),
  getListenerIntegrations: (api: GatewayApi) => api.getListenerIntegrations(),
  getListenerConnectUrl: (api: GatewayApi, body: string) => api.getListenerConnectUrl(parseCommandArgs(body)),
  getSubagents: (api: GatewayApi, body: string) => api.getSubagents(parseCommandArgs(body)),
  getAsyncTasks: (api: GatewayApi, body: string) => api.getAsyncTasks(parseCommandArgs(body)),
  setAgentAvatarBytes: (api: GatewayApi, body: string) => api.setAgentAvatarBytes(parseCommandArgs(body)),
  getAgentAvatar: (api: GatewayApi, body: string) => api.getAgentAvatar(parseCommandArgs(body)),
  getForeverBoxStatus: (api: GatewayApi, body: string) => api.getForeverBoxStatus(parseCommandArgs(body)),
  getCloudAgentInfo: (api: GatewayApi, body: string) => api.getCloudAgentInfo(parseCommandArgs(body)),
  ensureForeverBox: (api: GatewayApi, body: string) => api.ensureForeverBox(parseCommandArgs(body)),
  resetForeverBox: (api: GatewayApi, body: string) => api.resetForeverBox(parseCommandArgs(body)),
  updateForeverBox: (api: GatewayApi, body: string) => api.updateForeverBox(parseCommandArgs(body)),
  autoUpdateBoxNow: (api: GatewayApi) => api.autoUpdateBoxNow(),
  snapshotBoxStoreNow: (api: GatewayApi, body: string) => api.snapshotBoxStoreNow(parseCommandArgs(body)),
  getBoxStoreStatus: (api: GatewayApi) => api.getBoxStoreStatus(),
  clearBoxStoreNow: (api: GatewayApi) => api.clearBoxStoreNow(),
  updateHostNow: (api: GatewayApi, body: string) => api.updateHostNow(parseCommandArgs(body)),
  getHostStatus: (api: GatewayApi) => api.getHostStatus(),
  setBoxMigrating: (api: GatewayApi, body: string) => api.setBoxMigrating(parseCommandArgs(body)),
  prepareBoxForRecreate: (api: GatewayApi) => api.prepareBoxForRecreate(),
  resumeBoxAfterRecreate: (api: GatewayApi, body: string) => api.resumeBoxAfterRecreate(parseCommandArgs(body)),
  handBackForeverBox: (api: GatewayApi, body: string) => api.handBackForeverBox(parseCommandArgs(body)),
  skipBoxHandoff: (api: GatewayApi, body: string) => api.skipBoxHandoff(parseCommandArgs(body)),
  startTeachRecording: (api: GatewayApi, body: string) => api.startTeachRecording(parseCommandArgs(body)),
  stopTeachRecording: (api: GatewayApi, body: string) => api.stopTeachRecording(parseCommandArgs(body)),
  getTeachRecordingStatus: (api: GatewayApi) => api.getTeachRecordingStatus(),
  getTrays: (api: GatewayApi) => api.getTrays(),
  dismissTray: (api: GatewayApi, body: string) => api.dismissTray(parseCommandArgs(body)),
  clearTrays: (api: GatewayApi) => api.clearTrays(),
  uploadAttachment: (api: GatewayApi, body: string) => api.uploadAttachment(parseCommandArgs(body)),
  readAttachmentImage: (api: GatewayApi, body: string) => api.readAttachmentImage(parseCommandArgs(body)),
  readAttachmentText: (api: GatewayApi, body: string) => api.readAttachmentText(parseCommandArgs(body)),
  readAttachmentChunk: (api: GatewayApi, body: string) => api.readAttachmentChunk(parseCommandArgs(body)),
  // ONBOARD-1. First run, at the box level. `getOnboardingState` is safe to call on an older host
  // through the console's tryCall: it answers "unknown gateway method" and the console degrades to
  // no modal rather than throwing.
  getOnboardingState: (api: GatewayApi) => api.getOnboardingState(),
  startOnboarding: (api: GatewayApi, body: string) => api.startOnboarding(parseCommandArgs(body)),
  completeOnboarding: (api: GatewayApi, body: string) => api.completeOnboarding(parseCommandArgs(body)),
  resetOnboarding: (api: GatewayApi, body: string) => api.resetOnboarding(parseCommandArgs(body)),
  // MAIL-2 / PERSONA-1. The relay pushes the tenant's directory in after each roster sweep; the
  // gate reads it back. Safe to call on an older host through the console's tryCall: it answers
  // "unknown gateway method" and the caller degrades to "this box has no address yet".
  setAgentMail: (api: GatewayApi, body: string) => api.setAgentMail(parseCommandArgs(body)),
  getAgentMail: (api: GatewayApi) => api.getAgentMail(),
  getHostSettings: (api: GatewayApi) => api.getHostSettings(),
  setHostSettings: (api: GatewayApi, body: string) => api.setHostSettings(parseCommandArgs(body)),
  setBoxSecrets: (api: GatewayApi, body: string) => api.setBoxSecrets(parseCommandArgs(body)),
  getBoxSecretsStatus: (api: GatewayApi) => api.getBoxSecretsStatus(),
  completeMcpOAuth: (api: GatewayApi, body: string) => api.completeMcpOAuth(parseCommandArgs(body)),
  requestWebAuthnCeremony: (api: GatewayApi, body: string) => api.requestWebAuthnCeremony(parseCommandArgs(body)),
  refreshMcp: (api: GatewayApi, body: string) => api.refreshMcp(parseCommandArgs(body)),
  listRoutedMcpTools: (api: GatewayApi) => api.listRoutedMcpTools(),
  executeRoutedMcpTool: (api: GatewayApi, body: string) => api.executeRoutedMcpTool(parseCommandArgs(body)),
  listBoxMcpServers: (api: GatewayApi, body: string) => api.listBoxMcpServers(parseCommandArgs(body)),
  // Wave D1. The connector plane the Electron IPC always had and the gateway never did:
  // CP-03 reads, CP-08 per-tool permissions, CP-10 connector-process secrets.
  listInstalledMcpServers: (api: GatewayApi) => api.listInstalledMcpServers(),
  listMcpPlugins: (api: GatewayApi) => api.listMcpPlugins(),
  getMcpPlugin: (api: GatewayApi, body: string) => api.getMcpPlugin(parseCommandArgs(body)),
  listMcpServerTools: (api: GatewayApi, body: string) => api.listMcpServerTools(parseCommandArgs(body)),
  toggleMcpToolDisabled: (api: GatewayApi, body: string) => api.toggleMcpToolDisabled(parseCommandArgs(body)),
  listConnectorSecretFields: (api: GatewayApi, body: string) => api.listConnectorSecretFields(parseCommandArgs(body)),
  setConnectorSecret: (api: GatewayApi, body: string) => api.setConnectorSecret(parseCommandArgs(body)),
  deleteConnectorSecret: (api: GatewayApi, body: string) => api.deleteConnectorSecret(parseCommandArgs(body)),
  // MARKET-6. The one writer, reached by name. Adding a connector had two doors before this and
  // they disagreed: the relay read connectors.json out of the box over `docker exec`, edited the
  // whole map and wrote it back, while the host had its own single-entry write that only the
  // marketplace install ever called. Read-modify-write of a customer's credential file from
  // outside the box is not a mechanism worth keeping, and it needed a docker socket the relay does
  // not always have. These five are the doors now, and every one of them lands on the same write.
  addLocalConnector: (api: GatewayApi, body: string) => api.addLocalConnector(parseCommandArgs(body)),
  removeLocalConnector: (api: GatewayApi, body: string) => api.removeLocalConnector(parseCommandArgs(body)),
  // CONNECT-11. Keys the store still holds for connectors connectors.json no longer names. Nothing
  // could see these before: every listing began at the entry, so an uninstall left a credential
  // behind that no surface would ever mention again.
  listConnectorSecretOrphans: (api: GatewayApi) => api.listConnectorSecretOrphans(),
  // MARKET-5. One typed value, one write, fanned out to every consumer the plugin declares. The
  // TinyFish page drew two credential forms for one key, each warning that the other's value did
  // not reach it; this is the command that makes it one box and one sentence.
  setPluginCredential: (api: GatewayApi, body: string) => api.setPluginCredential(parseCommandArgs(body)),
  // One connector's live condition and its tool list, in the words the person who added it uses.
  probeConnector: (api: GatewayApi, body: string) => api.probeConnector(parseCommandArgs(body)),
  // CONNECT-5. Shell tools: a CLI the agent runs from its own shell with a credential in the
  // environment. CodeRabbit ships no MCP server at all, so none of the connector commands above
  // can carry its key; these are the same shape one layer down.
  // MARKET-1. The Marketplace catalog, bundled into the host and served from here. The console
  // reads it ONLY through these two, never as a static JSON, so the panel and the agent's
  // SearchPlugins cannot be looking at two different catalogs.
  listMarketplace: (api: GatewayApi) => api.listMarketplace(),
  getMarketplaceItem: (api: GatewayApi, body: string) => api.getMarketplaceItem(parseCommandArgs(body)),
  // JOBBUS. The Titan Job Bus (docs/JOB-BUS.md). The relay's /v1 surface is the first five commands
  // and nothing else: an allowlisted job API that returns attested results and never exposes a
  // shell. `jobBusList` and the settings pair are the console's, and `jobBusAudit` is the relay's
  // one write that is not a job -- the bearer lockout row of section 10.5.
  jobBusHealth: (api: GatewayApi) => api.jobBusHealth(),
  jobBusCreate: (api: GatewayApi, body: string) => api.jobBusCreate(parseCommandArgs(body)),
  jobBusGet: (api: GatewayApi, body: string) => api.jobBusGet(parseCommandArgs(body)),
  jobBusCancel: (api: GatewayApi, body: string) => api.jobBusCancel(parseCommandArgs(body)),
  jobBusArtifacts: (api: GatewayApi, body: string) => api.jobBusArtifacts(parseCommandArgs(body)),
  jobBusList: (api: GatewayApi, body: string) => api.jobBusList(parseCommandArgs(body)),
  jobBusAudit: (api: GatewayApi, body: string) => api.jobBusAudit(parseCommandArgs(body)),
  jobBusGetSettings: (api: GatewayApi) => api.jobBusGetSettings(),
  jobBusSetSettings: (api: GatewayApi, body: string) => api.jobBusSetSettings(parseCommandArgs(body)),
  // CLOUD-BROWSER-1. The cloud leg of the four browser tools, from the console's side. Four
  // commands and no more: one credential (Browserbase's row is credential-only, because that vendor
  // has no honest connector to hang a key on), the workspace's engine choice both ways, and the
  // open sessions the Computer card draws a live view from. Nothing here returns a stored value.
  setCloudBrowserKey: (api: GatewayApi, body: string) => api.setCloudBrowserKey(parseCommandArgs(body)),
  getCloudBrowserPolicy: (api: GatewayApi) => api.getCloudBrowserPolicy(),
  setCloudBrowserPolicy: (api: GatewayApi, body: string) => api.setCloudBrowserPolicy(parseCommandArgs(body)),
  listCloudBrowserSessions: (api: GatewayApi) => api.listCloudBrowserSessions(),
  listShellTools: (api: GatewayApi) => api.listShellTools(),
  listShellSecretFields: (api: GatewayApi) => api.listShellSecretFields(),
  setShellSecret: (api: GatewayApi, body: string) => api.setShellSecret(parseCommandArgs(body)),
  deleteShellSecret: (api: GatewayApi, body: string) => api.deleteShellSecret(parseCommandArgs(body)),
  probeShellSecret: (api: GatewayApi, body: string) => api.probeShellSecret(parseCommandArgs(body)),
  // FEEDBACK-1. The box's pending problem reports and the console's answer to one. Reads and
  // removes; nothing here sends anything anywhere, which is the whole point of the design.
  listProblemReports: (api: GatewayApi) => api.listProblemReports(),
  resolveProblemReport: (api: GatewayApi, body: string) => api.resolveProblemReport(parseCommandArgs(body)),
  installShellTool: (api: GatewayApi, body: string) => api.installShellTool(parseCommandArgs(body)),
  teachShellTool: (api: GatewayApi, body: string) => api.teachShellTool(parseCommandArgs(body))
};
export const GATEWAY_PREPARE_UPGRADE_PATH = "/prepare-upgrade";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export function isLoopbackHost(host: string): boolean { return LOOPBACK_HOSTS.has(host.trim().toLowerCase()); }
export interface AgentSummaryLike { readonly avatarDataUrl?: unknown; readonly [key: string]: unknown; }
export function stripSummaryInlineAvatar<T extends AgentSummaryLike>(summary: T): T { return summary.avatarDataUrl == null ? summary : { ...summary, avatarDataUrl: null }; }
export function stripSummaryRows<T extends AgentSummaryLike>(rows: readonly T[]): readonly T[] { let changed = false; const stripped = rows.map((row) => { const slim = stripSummaryInlineAvatar(row); if (slim !== row) changed = true; return slim; }); return changed ? stripped : rows; }
export function stripNullableSummary<T extends AgentSummaryLike>(summary: T | null): T | null { return summary == null ? null : stripSummaryInlineAvatar(summary); }
export function stripCreateAgentResult<T extends { readonly agent: AgentSummaryLike }>(result: T): T { const agent = stripSummaryInlineAvatar(result.agent); return agent === result.agent ? result : { ...result, agent }; }
export const SAND_GATEWAY_SLIM_COMMANDS = {
  ...SAND_GATEWAY_COMMANDS,
  listAgents: async (api: GatewayApi, _body: string) => stripSummaryRows(await SAND_GATEWAY_COMMANDS.listAgents(api)),
  updateAgent: async (api: GatewayApi, body: string) => stripNullableSummary(await SAND_GATEWAY_COMMANDS.updateAgent(api, body)),
  setGroupMembers: async (api: GatewayApi, body: string) => stripNullableSummary(await SAND_GATEWAY_COMMANDS.setGroupMembers(api, body)),
  setAgentAvatarBytes: async (api: GatewayApi, body: string) => stripNullableSummary(await SAND_GATEWAY_COMMANDS.setAgentAvatarBytes(api, body)),
  createAgent: async (api: GatewayApi, body: string) => stripCreateAgentResult(await SAND_GATEWAY_COMMANDS.createAgent(api, body)),
  createGroup: async (api: GatewayApi, body: string) => stripCreateAgentResult(await SAND_GATEWAY_COMMANDS.createGroup(api, body)),
  duplicateAgent: async (api: GatewayApi, body: string) => stripCreateAgentResult(await SAND_GATEWAY_COMMANDS.duplicateAgent(api, body))
};
export function stripInlineAvatarsFromEvent(event: any): any {
  if (event.channel === "agents") { const agents = stripSummaryRows(event.payload.agents); return agents === event.payload.agents ? event : { channel: "agents", payload: { ...event.payload, agents } }; }
  if (event.channel === "agent-upserted") { const agent = stripSummaryInlineAvatar(event.payload.agent); return agent === event.payload.agent ? event : { channel: "agent-upserted", payload: { ...event.payload, agent } }; }
  return event;
}
