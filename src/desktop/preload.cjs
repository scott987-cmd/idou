const { contextBridge, ipcRenderer } = require("electron");

const invoke = (method) => (...args) => ipcRenderer.invoke(`idou:${method}`, ...args);
contextBridge.exposeInMainWorld("idou", Object.freeze({
  snapshot: invoke("snapshot"), pickWorkspace: invoke("pick-workspace"),
  recentWorkspaces: invoke("recent-workspaces"), initGit: invoke("init-git"),
  taskFiles: invoke("task-files"), attachTaskFiles: invoke("attach-task-files"), openTaskFile: invoke("open-task-file"),
  removeTaskFile: invoke("remove-task-file"), revealTaskFolder: invoke("reveal-task-folder"),
  uploadToDrive: invoke("upload-to-drive"), openDriveFile: invoke("open-drive-file"), openExternalLink: invoke("open-external-link"),
  listMcpServers: invoke("list-mcp-servers"), addMcpServer: invoke("add-mcp-server"), removeMcpServer: invoke("remove-mcp-server"),
  loginMcpServer: invoke("login-mcp-server"), logoutMcpServer: invoke("logout-mcp-server"),
  listBuiltinConnectors: invoke("list-builtin-connectors"), setBuiltinConnectorEnabled: invoke("set-builtin-connector-enabled"),
  requestComputerPermissions: invoke("request-computer-permissions"),
  listMarketplaces: invoke("list-marketplaces"), addMarketplace: invoke("add-marketplace"),
  removeMarketplace: invoke("remove-marketplace"), upgradeMarketplaces: invoke("upgrade-marketplaces"),
  listPlugins: invoke("list-plugins"), installPlugin: invoke("install-plugin"),
  removePlugin: invoke("remove-plugin"), setPluginEnabled: invoke("set-plugin-enabled"),
  openFeishuView: invoke("open-feishu-view"), hideFeishuView: invoke("hide-feishu-view"), feishuViewLocation: invoke("feishu-view-location"), feishuViewBounds: invoke("feishu-view-bounds"),
  feishuViewNavigate: invoke("feishu-view-navigate"), feishuViewRail: invoke("feishu-view-rail"),
  feishuUnread: invoke("feishu-unread"), feishuDeployment: invoke("feishu-deployment"),
  listSchedules: invoke("list-schedules"), createSchedule: invoke("create-schedule"), updateScheduleResources: invoke("update-schedule-resources"),
  updateSchedule: invoke("update-schedule"), runScheduleNow: invoke("run-schedule-now"),
  scheduleResourceRecents: invoke("schedule-resource-recents"), searchScheduleResources: invoke("search-schedule-resources"),
  listScheduleChats: invoke("list-schedule-chats"), closeScheduleResources: invoke("close-schedule-resources"),
  setScheduleState: invoke("set-schedule-state"), removeSchedule: invoke("remove-schedule"), removeSchedules: invoke("remove-schedules"),
  scheduleRuns: invoke("schedule-runs"), scheduleConsent: invoke("schedule-consent"),
  shelveScheduleRun: invoke("shelve-schedule-run"), deleteScheduleRun: invoke("delete-schedule-run"),
  authorizeSchedules: invoke("authorize-schedules"), revokeSchedules: invoke("revoke-schedules"),
  scheduleUnattended: invoke("schedule-unattended"),
  syncScheduleTasks: invoke("sync-schedule-tasks"),
  bindFeishuChat: invoke("bind-feishu-chat"),
  dockedChat: invoke("docked-chat"), dockedChatOptions: invoke("docked-chat-options"),
  confirmDockedChat: invoke("confirm-docked-chat"), forgetDockedChat: invoke("forget-docked-chat"),
  webIdentity: invoke("web-identity"), verifyWebIdentity: invoke("verify-web-identity"),
  onWebIdentity: (handler) => ipcRenderer.on("idou:web-identity", (_event, value) => handler(value)),
  onScheduleAuthorization: (handler) => ipcRenderer.on("idou:schedule-authorization", (_event, value) => handler(value)),
  onOpenScheduleRuns: (handler) => ipcRenderer.on("idou:open-schedule-runs", (_event, value) => handler(value)),
  onOpenTask: (handler) => ipcRenderer.on("idou:open-task", (_event, value) => handler(value)),
  onScheduleDraft: (handler) => ipcRenderer.on("idou:schedule-draft", (_event, value) => handler(value)),
  onScheduleDraftWithdrawn: (handler) => ipcRenderer.on("idou:schedule-draft-withdrawn", (_event, value) => handler(value)),
  settleScheduleDraft: invoke("settle-schedule-draft"),
  onSchedulesChanged: (handler) => ipcRenderer.on("idou:schedules-changed", () => handler()),
  notificationPreferences: invoke("notification-preferences"), setNotificationPreferences: invoke("set-notification-preferences"),
  testNotification: invoke("test-notification"), openNotificationSettings: invoke("open-notification-settings"),
  testScheduleNotify: invoke("test-schedule-notify"),
  authorizeUnattendedSchedules: invoke("authorize-unattended-schedules"),
  revokeUnattendedSchedules: invoke("revoke-unattended-schedules"),
  onFeishuUnread: (handler) => ipcRenderer.on("idou:feishu-unread", (_event, value) => handler(value)),
  closeLoginView: invoke("close-login-view"), loginViewBounds: invoke("login-view-bounds"), openLoginExternal: invoke("open-login-external"),
  onLoginCallback: (handler) => ipcRenderer.on("idou:login-callback", () => handler()),
  onAuthChanged: (handler) => ipcRenderer.on("idou:auth-changed", (_event, value) => handler(value)),
  onConfirm: (handler) => ipcRenderer.on("idou:confirm", (_event, value) => handler(value)),
  onConfirmWithdrawn: (handler) => ipcRenderer.on("idou:confirm-withdrawn", (_event, value) => handler(value)), onMediaPreview: (handler) => ipcRenderer.on("idou:media-preview", (_event, value) => handler(value)), onMediaChanged: (handler) => ipcRenderer.on("idou:media-changed", (_event, value) => handler(value)), confirmResponse: invoke("confirm-response"),
  onFeishuViewFailed: (handler) => ipcRenderer.on("idou:feishu-view-failed", (_event, value) => handler(value)),
  onFeishuOpenDocs: (handler) => ipcRenderer.on("idou:feishu-open-docs", () => handler()), createTask: invoke("create-task"), permissionModes: invoke("permission-modes"), setTaskPermission: invoke("set-task-permission"), setTaskKnowledgeScope: invoke("set-task-knowledge-scope"),
  taskUiState: invoke("task-ui-state"), taskUiNavigation: invoke("task-ui-navigation"), saveTaskUiState: invoke("save-task-ui-state"), setTaskUiMetadata: invoke("set-task-ui-metadata"),
  terminalOpen: invoke("terminal-open"), terminalReopen: invoke("terminal-reopen"), terminalWrite: invoke("terminal-write"), terminalResize: invoke("terminal-resize"), terminalClose: invoke("terminal-close"),
  onTerminalData: (handler) => { const listener = (_event, value) => handler(value); ipcRenderer.on("idou:terminal-data", listener); return () => ipcRenderer.removeListener("idou:terminal-data", listener); },
  onTerminalExit: (handler) => { const listener = (_event, value) => handler(value); ipcRenderer.on("idou:terminal-exit", listener); return () => ipcRenderer.removeListener("idou:terminal-exit", listener); },
  onFlushTaskUi: handler => ipcRenderer.on("idou:flush-task-ui", async () => { try { await handler(); } finally { ipcRenderer.send("idou:task-ui-flushed"); } }),
  setTheme: invoke("set-theme"),
  searchProjectFiles: invoke("search-project-files"), projectDiff: invoke("project-diff"), reviewTargets: invoke("review-targets"), taskImage: invoke("task-image"), projectCommands: invoke("project-commands"), projectCommand: invoke("project-command"), approvalRules: invoke("approval-rules"), forgetApprovalRule: invoke("forget-approval-rule"), tableDescribe: invoke("table-describe"), sites: invoke("sites"), siteTemplates: invoke("site-templates"), siteCreate: invoke("site-create"), siteRefresh: invoke("site-refresh"), sitePreview: invoke("site-preview"), siteDemo: invoke("site-demo"), siteRestyle: invoke("site-restyle"), siteFromTask: invoke("site-from-task"), siteRename: invoke("site-rename"), siteForget: invoke("site-forget"), sitePublish: invoke("site-publish"), siteShareSet: invoke("site-share-set"), siteUnpublish: invoke("site-unpublish"), siteRepublish: invoke("site-republish"), copyText: invoke("copy-text"), sitePublished: invoke("site-published"),
  send: invoke("send"), enqueueTaskMessage: invoke("enqueue-task-message"), updateQueuedMessage: invoke("update-queued-message"), removeQueuedMessage: invoke("remove-queued-message"), setTaskQueuePaused: invoke("set-task-queue-paused"), searchPeople: invoke("search-people"), stop: invoke("stop"), startBuilding: invoke("start-building"), approve: invoke("approve"), answer: invoke("answer"), steer: invoke("steer"),
  renameTask: invoke("rename-task"), deleteTask: invoke("delete-task"),
  compactTask: invoke("compact-task"), rollbackTask: invoke("rollback-task"),
  connection: invoke("connection"), connect: invoke("connect"),
  modelOptions: invoke("model-options"), selectModel: invoke("select-model"),
  authStatus: invoke("auth-status"), authBegin: invoke("auth-begin"), authPoll: invoke("auth-poll"),
  authConfirm: invoke("auth-confirm"), authCancel: invoke("auth-cancel"), authLogout: invoke("auth-logout"),
  listFiles: invoke("list-files"), readFile: invoke("read-file"),
  listAppCandidates: invoke("list-app-candidates"), publishStaticApp: invoke("publish-static-app"), submitAppCandidate: invoke("submit-app-candidate"), withdrawAppCandidate: invoke("withdraw-app-candidate"),
  archiveAppCandidate: invoke("archive-app-candidate"), verifyAppArchive: invoke("verify-app-archive"),
  retrieveAppArchive: invoke("retrieve-app-archive"),
  previewAppArchive: invoke("preview-app-archive"),
  listAppReviews: invoke("list-app-reviews"), readAppReview: invoke("read-app-review"),
  decideAppReview: invoke("decide-app-review"), closeAppReview: invoke("close-app-review"),
  listAppRuntimes: invoke("list-app-runtimes"), readAppRuntime: invoke("read-app-runtime"),
  exportAppRuntime: invoke("export-app-runtime"), closeAppRuntime: invoke("close-app-runtime"),
  listMedia: invoke("list-media"), createMedia: invoke("create-media"), refreshMedia: invoke("refresh-media"), cancelMedia: invoke("cancel-media"), previewMedia: invoke("preview-media"), mediaPreviewBounds: invoke("media-preview-bounds"), closeMediaPreview: invoke("close-media-preview"),
  saveMediaDrive: invoke("save-media-drive"), openMediaDrive: invoke("open-media-drive"), checkMediaDriveFolder: invoke("check-media-drive-folder"),
  documentConnection: invoke("document-connection"), searchDocuments: invoke("search-documents"), openDocument: invoke("open-document"), closeDocument: invoke("close-document"),
  openSheet: invoke("open-sheet"), closeSheet: invoke("close-sheet"), openBase: invoke("open-base"), closeBase: invoke("close-base"),
  onSheetInvalidated(callback) {
    const listener = (_event, value) => callback(value); ipcRenderer.on("idou:sheet-invalidated", listener);
    return () => ipcRenderer.removeListener("idou:sheet-invalidated", listener);
  },
  onBaseInvalidated(callback) {
    const listener = (_event, value) => callback(value); ipcRenderer.on("idou:base-invalidated", listener);
    return () => ipcRenderer.removeListener("idou:base-invalidated", listener);
  },
  applyDocumentEdit: invoke("apply-document-edit"), applySheetEdit: invoke("apply-sheet-edit"), undoSheetEdit: invoke("undo-sheet-edit"),
  applyBaseEdit: invoke("apply-base-edit"), undoBaseEdit: invoke("undo-base-edit"), recheckBaseEdit: invoke("recheck-base-edit"),
  searchDocumentRecipients: invoke("search-document-recipients"), prepareDocumentDelivery: invoke("prepare-document-delivery"),
  documentRecipientMembers: invoke("document-recipient-members"),
  listChats: invoke("list-chats"), readChat: invoke("read-chat"), resolveChatDocument: invoke("resolve-chat-document"), closeChatReader: invoke("close-chat-reader"),
  replyChatMessage: invoke("reply-chat-message"),
  discoveryStatus: invoke("discovery-status"), watchKnowledgeChat: invoke("watch-knowledge-chat"), stopKnowledgeDiscovery: invoke("stop-discovery"),
  sendDocumentDelivery: invoke("send-document-delivery"), discardDocumentDelivery: invoke("discard-document-delivery"),
  knowledgeStatus: invoke("knowledge-status"), searchKnowledge: invoke("search-knowledge"), addKnowledge: invoke("add-knowledge"), knowledgeList: invoke("knowledge-list"), removeKnowledge: invoke("knowledge-remove"), knowledgeGraph: invoke("knowledge-graph"), knowledgeGraphSnapshot: invoke("knowledge-graph-snapshot"),
  knowledgeNodeStatus: invoke("knowledge-node-status"),
  knowledgePublicationStatus: invoke("knowledge-publication-status"), startKnowledgePublication: invoke("start-knowledge-publication"), stopKnowledgePublication: invoke("stop-knowledge-publication"),
  knowledgeReceptionStatus: invoke("knowledge-reception-status"), startKnowledgeReception: invoke("start-knowledge-reception"), stopKnowledgeReception: invoke("stop-knowledge-reception"),
  setKnowledgeSynthesis: invoke("set-knowledge-synthesis"),
  previewFile: invoke("preview-file"), previewNavigate: invoke("preview-navigate"), hidePreview: invoke("hide-preview"), previewBounds: invoke("preview-bounds"),
  listSkills: invoke("list-skills"), readSkill: invoke("read-skill"), listLocalSkills: invoke("list-local-skills"), importLocalSkill: invoke("import-local-skill"), setLocalSkillEnabled: invoke("set-local-skill-enabled"), rollbackLocalSkill: invoke("rollback-local-skill"), removeLocalSkill: invoke("remove-local-skill"),
  listEnterpriseSkills: invoke("list-enterprise-skills"), readEnterpriseSkill: invoke("read-enterprise-skill"), skillShelf: invoke("skill-shelf"), publishSkill: invoke("publish-skill"), unpublishSkill: invoke("unpublish-skill"),
  useEnterpriseSkill: invoke("use-enterprise-skill"),
  enterpriseSkillConnections: invoke("enterprise-skill-connections"),
  listMcp: invoke("list-mcp"), importMcp: invoke("import-mcp"), removeMcp: invoke("remove-mcp"), useMcp: invoke("use-mcp"),
  listEnterpriseMcp: invoke("list-enterprise-mcp"), importEnterpriseMcp: invoke("import-enterprise-mcp"),
  onChange: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("idou:changed", listener);
    return () => ipcRenderer.removeListener("idou:changed", listener);
  },
  onSitesChange: callback => {
    const listener = () => callback(); ipcRenderer.on("idou:sites-changed", listener);
    return () => ipcRenderer.removeListener("idou:sites-changed", listener);
  },
  onDiscoveryChange: callback => {
    const listener = (_event, value) => callback(value); ipcRenderer.on("idou:discovery-changed", listener);
    return () => ipcRenderer.removeListener("idou:discovery-changed", listener);
  },
  onPublicationChange: callback => {
    const listener = (_event, value) => callback(value); ipcRenderer.on("idou:publication-changed", listener);
    return () => ipcRenderer.removeListener("idou:publication-changed", listener);
  },
  onReceptionChange: callback => {
    const listener = (_event, value) => callback(value); ipcRenderer.on("idou:reception-changed", listener);
    return () => ipcRenderer.removeListener("idou:reception-changed", listener);
  },
  onDocumentInvalidated: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("idou:document-invalidated", listener);
    return () => ipcRenderer.removeListener("idou:document-invalidated", listener);
  },
  onPreviewExpired: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("idou:preview-expired", listener);
    return () => ipcRenderer.removeListener("idou:preview-expired", listener);
  },
  onPreviewNavigation: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("idou:preview-navigation", listener);
    return () => ipcRenderer.removeListener("idou:preview-navigation", listener);
  },
}));
