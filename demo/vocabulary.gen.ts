// 派生自 SnowLuma 源码 · 非商业自用 · 不发包管理器
// AUTO-GENERATED — do not edit

// 由 npm run gen:demo 从 spec/openapi.yaml + generated/typescript/sdk.gen.ts 机械推出。
// 上游加/删一条操作后本表即过期：gen:check 重新生成后 git diff 非空即红。

export interface VocabularyEntry {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 上游路径（含 /api），非 demo 语义路径。 */
  path: string;
  isSSE: boolean;
  isGate: boolean;
  /** spec 显式 security: [] ⇒ 登录前可读。 */
  anonymous: boolean;
}

export const VOCABULARY: Record<string, VocabularyEntry> = {
  beginTotpEnrollment: { operationId: 'beginTotpEnrollment', method: 'POST', path: '/api/auth/totp/begin', isSSE: false, isGate: false, anonymous: false },
  changePassword: { operationId: 'changePassword', method: 'POST', path: '/api/auth/change-password', isSSE: false, isGate: true, anonymous: false },
  checkPasswordStrength: { operationId: 'checkPasswordStrength', method: 'POST', path: '/api/auth/check-strength', isSSE: false, isGate: true, anonymous: false },
  checkUpdate: { operationId: 'checkUpdate', method: 'GET', path: '/api/update/check', isSSE: false, isGate: false, anonymous: false },
  cleanupStorage: { operationId: 'cleanupStorage', method: 'POST', path: '/api/system/storage/cleanup', isSSE: false, isGate: false, anonymous: false },
  clearBackgroundImage: { operationId: 'clearBackgroundImage', method: 'DELETE', path: '/api/ui/background', isSSE: false, isGate: false, anonymous: false },
  confirmTotpEnrollment: { operationId: 'confirmTotpEnrollment', method: 'POST', path: '/api/auth/totp/confirm', isSSE: false, isGate: false, anonymous: false },
  deleteTlsCert: { operationId: 'deleteTlsCert', method: 'DELETE', path: '/api/system/tls/cert', isSSE: false, isGate: false, anonymous: false },
  disableTotp: { operationId: 'disableTotp', method: 'POST', path: '/api/auth/totp/disable', isSSE: false, isGate: false, anonymous: false },
  exportBackup: { operationId: 'exportBackup', method: 'GET', path: '/api/system/backup/export', isSSE: false, isGate: false, anonymous: false },
  exportTraceLog: { operationId: 'exportTraceLog', method: 'GET', path: '/api/logs/export/trace', isSSE: false, isGate: false, anonymous: false },
  getAgreements: { operationId: 'getAgreements', method: 'GET', path: '/api/agreements', isSSE: false, isGate: true, anonymous: false },
  getAuthState: { operationId: 'getAuthState', method: 'GET', path: '/api/auth/state', isSSE: false, isGate: true, anonymous: false },
  getGlobalConfig: { operationId: 'getGlobalConfig', method: 'GET', path: '/api/global-config', isSSE: false, isGate: false, anonymous: false },
  getLogLevel: { operationId: 'getLogLevel', method: 'GET', path: '/api/logs/level', isSSE: false, isGate: false, anonymous: false },
  getNotificationsConfig: { operationId: 'getNotificationsConfig', method: 'GET', path: '/api/notifications/config', isSSE: false, isGate: false, anonymous: false },
  getOneBotConfig: { operationId: 'getOneBotConfig', method: 'GET', path: '/api/config/{uin}', isSSE: false, isGate: false, anonymous: false },
  getPublicUiAppearance: { operationId: 'getPublicUiAppearance', method: 'GET', path: '/api/ui/public', isSSE: false, isGate: true, anonymous: true },
  getStatus: { operationId: 'getStatus', method: 'GET', path: '/api/status', isSSE: false, isGate: false, anonymous: false },
  getSystem: { operationId: 'getSystem', method: 'GET', path: '/api/system', isSSE: false, isGate: false, anonymous: false },
  getSystemSettings: { operationId: 'getSystemSettings', method: 'GET', path: '/api/system/settings', isSSE: false, isGate: false, anonymous: false },
  getSystemStorage: { operationId: 'getSystemStorage', method: 'GET', path: '/api/system/storage', isSSE: false, isGate: false, anonymous: false },
  getTotpStatus: { operationId: 'getTotpStatus', method: 'GET', path: '/api/auth/totp', isSSE: false, isGate: false, anonymous: false },
  getUiConfig: { operationId: 'getUiConfig', method: 'GET', path: '/api/ui', isSSE: false, isGate: false, anonymous: false },
  importBackup: { operationId: 'importBackup', method: 'POST', path: '/api/system/backup/import', isSSE: false, isGate: false, anonymous: false },
  invokeDebugAction: { operationId: 'invokeDebugAction', method: 'POST', path: '/api/debug/invoke', isSSE: false, isGate: false, anonymous: false },
  listConnections: { operationId: 'listConnections', method: 'GET', path: '/api/connections', isSSE: false, isGate: false, anonymous: false },
  listDebugActions: { operationId: 'listDebugActions', method: 'GET', path: '/api/debug/actions', isSSE: false, isGate: false, anonymous: false },
  listLogs: { operationId: 'listLogs', method: 'GET', path: '/api/logs', isSSE: false, isGate: false, anonymous: false },
  listProcesses: { operationId: 'listProcesses', method: 'GET', path: '/api/processes', isSSE: false, isGate: false, anonymous: false },
  listQq: { operationId: 'listQq', method: 'GET', path: '/api/qq-list', isSSE: false, isGate: false, anonymous: false },
  listRecentNotifications: { operationId: 'listRecentNotifications', method: 'GET', path: '/api/notifications/recent', isSSE: false, isGate: false, anonymous: false },
  loadProcess: { operationId: 'loadProcess', method: 'POST', path: '/api/processes/{pid}/load', isSSE: false, isGate: false, anonymous: false },
  login: { operationId: 'login', method: 'POST', path: '/api/login', isSSE: false, isGate: true, anonymous: true },
  logout: { operationId: 'logout', method: 'POST', path: '/api/logout', isSSE: false, isGate: true, anonymous: false },
  probeProcessLogin: { operationId: 'probeProcessLogin', method: 'GET', path: '/api/processes/{pid}/probe-login', isSSE: false, isGate: false, anonymous: false },
  recordConsent: { operationId: 'recordConsent', method: 'POST', path: '/api/agreements/record-consent', isSSE: false, isGate: true, anonymous: false },
  refreshProcess: { operationId: 'refreshProcess', method: 'POST', path: '/api/processes/{pid}/refresh', isSSE: false, isGate: false, anonymous: false },
  regenerateTotpRecoveryCodes: { operationId: 'regenerateTotpRecoveryCodes', method: 'POST', path: '/api/auth/totp/recovery-codes', isSSE: false, isGate: false, anonymous: false },
  saveGlobalConfig: { operationId: 'saveGlobalConfig', method: 'POST', path: '/api/global-config', isSSE: false, isGate: false, anonymous: false },
  saveNotificationsConfig: { operationId: 'saveNotificationsConfig', method: 'POST', path: '/api/notifications/config', isSSE: false, isGate: false, anonymous: false },
  saveOneBotConfig: { operationId: 'saveOneBotConfig', method: 'POST', path: '/api/config/{uin}', isSSE: false, isGate: false, anonymous: false },
  saveSystemSettings: { operationId: 'saveSystemSettings', method: 'POST', path: '/api/system/settings', isSSE: false, isGate: false, anonymous: false },
  saveUiConfig: { operationId: 'saveUiConfig', method: 'POST', path: '/api/ui', isSSE: false, isGate: false, anonymous: false },
  setLogLevel: { operationId: 'setLogLevel', method: 'POST', path: '/api/logs/level', isSSE: false, isGate: false, anonymous: false },
  streamDebugAction: { operationId: 'streamDebugAction', method: 'POST', path: '/api/debug/invoke-stream', isSSE: true, isGate: false, anonymous: false },
  streamDebugEvents: { operationId: 'streamDebugEvents', method: 'GET', path: '/api/debug/stream', isSSE: true, isGate: false, anonymous: false },
  streamLogs: { operationId: 'streamLogs', method: 'GET', path: '/api/logs/stream', isSSE: true, isGate: false, anonymous: false },
  streamState: { operationId: 'streamState', method: 'GET', path: '/api/state/stream', isSSE: true, isGate: false, anonymous: false },
  testNotificationChannel: { operationId: 'testNotificationChannel', method: 'POST', path: '/api/notifications/test', isSSE: false, isGate: false, anonymous: false },
  unloadProcess: { operationId: 'unloadProcess', method: 'POST', path: '/api/processes/{pid}/unload', isSSE: false, isGate: false, anonymous: false },
  updateStorageSettings: { operationId: 'updateStorageSettings', method: 'POST', path: '/api/system/storage/settings', isSSE: false, isGate: false, anonymous: false },
  uploadBackgroundImage: { operationId: 'uploadBackgroundImage', method: 'POST', path: '/api/ui/background', isSSE: false, isGate: false, anonymous: false },
  uploadDebugFile: { operationId: 'uploadDebugFile', method: 'POST', path: '/api/debug/upload', isSSE: false, isGate: false, anonymous: false },
  uploadTlsCert: { operationId: 'uploadTlsCert', method: 'POST', path: '/api/system/tls/cert', isSSE: false, isGate: false, anonymous: false },
};

export const OPERATION_IDS: string[] = ['beginTotpEnrollment', 'changePassword', 'checkPasswordStrength', 'checkUpdate', 'cleanupStorage', 'clearBackgroundImage', 'confirmTotpEnrollment', 'deleteTlsCert', 'disableTotp', 'exportBackup', 'exportTraceLog', 'getAgreements', 'getAuthState', 'getGlobalConfig', 'getLogLevel', 'getNotificationsConfig', 'getOneBotConfig', 'getPublicUiAppearance', 'getStatus', 'getSystem', 'getSystemSettings', 'getSystemStorage', 'getTotpStatus', 'getUiConfig', 'importBackup', 'invokeDebugAction', 'listConnections', 'listDebugActions', 'listLogs', 'listProcesses', 'listQq', 'listRecentNotifications', 'loadProcess', 'login', 'logout', 'probeProcessLogin', 'recordConsent', 'refreshProcess', 'regenerateTotpRecoveryCodes', 'saveGlobalConfig', 'saveNotificationsConfig', 'saveOneBotConfig', 'saveSystemSettings', 'saveUiConfig', 'setLogLevel', 'streamDebugAction', 'streamDebugEvents', 'streamLogs', 'streamState', 'testNotificationChannel', 'unloadProcess', 'updateStorageSettings', 'uploadBackgroundImage', 'uploadDebugFile', 'uploadTlsCert'];
export const SSE_OPERATIONS: string[] = ['streamDebugAction', 'streamDebugEvents', 'streamLogs', 'streamState'];
export const GATE_OPERATIONS: string[] = ['changePassword', 'checkPasswordStrength', 'getAgreements', 'getAuthState', 'getPublicUiAppearance', 'login', 'logout', 'recordConsent'];
export const ANONYMOUS_OPERATIONS: string[] = ['getPublicUiAppearance', 'login'];
