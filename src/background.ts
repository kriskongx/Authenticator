import { getCredentials } from "./models/credentials";
import { Encryption } from "./models/encryption";
import { EntryStorage, ManagedStorage } from "./models/storage";
import { Dropbox, Drive, OneDrive } from "./models/backup";
import {
  getSiteName,
  getMatchedEntries,
  getCurrentTab,
  okToInjectContentScript,
} from "./utils";
import { CodeState } from "./models/otp";
import { getOTPAuthPerLineFromOPTAuthMigration } from "./models/migration";
import { parseOtpAuthUri } from "./models/otpauth-uri";
import { isChrome, isChromium, isFirefox } from "./browser";
import {
  DEFAULT_AUTOLOCK_MINUTES,
  UserSettings,
  normalizeAutolock,
} from "./models/settings";
import {
  BIOMETRIC_UNLOCK_STORAGE_KEY,
  BiometricCredentialEnrollment,
  BiometricUnlockBundle,
  BiometricUnlockKey,
  cacheBiometricUnlockBundle,
  clearAutoBiometricPromptSkip,
  clearBiometricReauth,
  finishBiometricCredentialEnrollment,
  hasBiometricUnlockRecord,
  isBiometricUnlockBundle,
  isPopupAnchorOffset,
  markBiometricReauthVerified,
  POPUP_ANCHOR_STORAGE_KEY,
  PopupAnchorOffset,
  setPendingPopupNotification,
  setPendingPopupReopenView,
} from "./models/biometric-unlock";
import { isApiAccessEnabled, verifyApiToken } from "./models/api-access";
import { importBackupContent, isVaultLocked } from "./models/import-api";
import {
  LOCAL_IMPORT_ALARM,
  getLocalImportInterval,
  importFromLocalHost,
  isLocalImportEnabled,
  setLocalImportEnabled,
  setLocalImportInterval,
} from "./models/local-import";
import {
  getClientDay,
  getWebDAVConfig,
  getWebDAVOrigin,
  isWebDAVBackupDue,
  normalizeBackupDay,
  normalizeBackupIntervalDays,
  normalizeBackupHour,
  isBackupHourReached,
  pruneWebDAVBackups,
  uploadWebDAVBackup,
} from "./models/webdav";

type ContentTab = Pick<chrome.tabs.Tab, "id" | "windowId">;

type CaptureInfo = {
  captureBoxLeft: number;
  captureBoxTop: number;
  captureBoxWidth: number;
  captureBoxHeight: number;
};
type RuntimeMessage =
  | { action: "getCapture"; info: CaptureInfo }
  | { action: "getTotp"; info: string }
  | { action: "cachePassphrase"; value: string; keyId: string }
  | {
      action: "finishBiometricEnrollment";
      ticket: string;
      enrollment: BiometricCredentialEnrollment;
    }
  | {
      action: "completeBiometricUnlock";
      bundle: BiometricUnlockBundle;
      reopenPopup?: boolean;
      reopenDelayMs?: number;
    }
  | {
      action: "completeBiometricReauth";
      keyId: string;
      reopenPopup?: boolean;
      reopenView?: string;
      reopenDelayMs?: number;
    }
  | {
      action: "completeBiometricBackupRestore";
      content: string;
      clearFirst: boolean;
      preUnlockedKeys: BiometricUnlockKey[];
      reopenPopup?: boolean;
    }
  | { action: "dropbox" | "drive" | "onedrive" }
  | { action: "lock" | "resetAutolock" | "updateContextMenu" }
  | { action: "runLocalImport" }
  | { action: "setLocalImport"; enabled: boolean }
  | { action: "setLocalImportInterval"; minutes: number }
  | { action: "runWebDAVBackup" | "syncWebDAVAlarm" }
  | { action: "updateContentTab"; data: ContentTab };

type WebDAVRequestMessage = {
  action: "webdavRequest";
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeout?: number;
};

let contentTab: ContentTab | undefined;

function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL(""))
  );
}

// Expected business-state outcomes returned to UI callers via `{ ok: false, error }`.
// Log these at info level so Chrome's chrome://extensions error panel is not
// polluted with false extension errors during normal operation (e.g. clicking
// "Import now" when the inbox is empty).
const EXPECTED_MESSAGE_ERRORS = new Set([
  "localImportNoPending",
  "localImportDisabled",
  "vaultLocked",
  "importInProgress",
  "nativeHostUnavailable",
  "nativeHostError",
  "nativeHostTimeout",
  "biometricSetupExpired",
  "biometricUnlockInvalidBundle",
  "biometricBackupKeyMismatch",
]);

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message: unknown = rawMessage;
  const action =
    isObject(message) && typeof message.action === "string"
      ? message.action
      : "(unknown)";

  if (isObject(message) && "action" in message && message.action === "lock") {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "invalidSender" });
      return false;
    }
    void handleVaultLock().then(
      () => sendResponse({ ok: true }),
      (error: unknown) => {
        console.error("Failed to lock the vault", error);
        sendResponse({ ok: false });
      }
    );
    return true;
  }

  if (isWebDAVRequest(message)) {
    if (!isExtensionPageSender(sender)) {
      sendResponse({
        status: 0,
        statusText: "Forbidden",
        headers: "",
        responseText: "",
      });
      return false;
    }
    void handleWebDAVRequest(message).then(
      (response) => sendResponse(response),
      (error: unknown) =>
        sendResponse({
          status: 0,
          statusText: error instanceof Error ? error.message : "Network Error",
          headers: "",
          responseText: "",
        })
    );
    return true;
  }

  if (!isRuntimeMessage(message)) {
    if (action === "finishBiometricEnrollment") {
      console.warn("[background] rejected finishBiometricEnrollment", message);
      sendResponse({ ok: false, error: "biometricMessageInvalid" });
    }
    return false;
  }
  void handleRuntimeMessage(message, sender).then(
    () => sendResponse({ ok: true }),
    (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : "";
      if (EXPECTED_MESSAGE_ERRORS.has(errorMessage)) {
        console.info(
          "[background] extension message outcome",
          action,
          errorMessage
        );
      } else {
        console.error("Failed to handle extension message", action, error);
      }
      sendResponse({
        ok: false,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      });
    }
  );
  return true;
});

function isCaptureInfo(value: unknown): value is CaptureInfo {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return (
    "captureBoxLeft" in value &&
    typeof value.captureBoxLeft === "number" &&
    "captureBoxTop" in value &&
    typeof value.captureBoxTop === "number" &&
    "captureBoxWidth" in value &&
    typeof value.captureBoxWidth === "number" &&
    "captureBoxHeight" in value &&
    typeof value.captureBoxHeight === "number"
  );
}

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("action" in value)
  ) {
    return false;
  }

  switch (value.action) {
    case "getCapture":
      return "info" in value && isCaptureInfo(value.info);
    case "getTotp":
      return "info" in value && typeof value.info === "string";
    case "cachePassphrase":
      return (
        "value" in value &&
        typeof value.value === "string" &&
        "keyId" in value &&
        typeof value.keyId === "string"
      );
    case "finishBiometricEnrollment":
      return (
        "ticket" in value &&
        typeof value.ticket === "string" &&
        "enrollment" in value &&
        parseBiometricEnrollment(value.enrollment) !== null
      );
    case "completeBiometricUnlock":
      return (
        "bundle" in value &&
        isBiometricUnlockBundle(value.bundle) &&
        (!("reopenPopup" in value) || typeof value.reopenPopup === "boolean") &&
        (!("reopenDelayMs" in value) || typeof value.reopenDelayMs === "number")
      );
    case "completeBiometricReauth":
      return (
        "keyId" in value &&
        typeof value.keyId === "string" &&
        value.keyId.length > 0 &&
        (!("reopenPopup" in value) || typeof value.reopenPopup === "boolean") &&
        (!("reopenView" in value) || typeof value.reopenView === "string") &&
        (!("reopenDelayMs" in value) || typeof value.reopenDelayMs === "number")
      );
    case "completeBiometricBackupRestore":
      return (
        "content" in value &&
        typeof value.content === "string" &&
        "clearFirst" in value &&
        typeof value.clearFirst === "boolean" &&
        "preUnlockedKeys" in value &&
        Array.isArray(value.preUnlockedKeys) &&
        value.preUnlockedKeys.length > 0 &&
        value.preUnlockedKeys.length <= 32 &&
        value.preUnlockedKeys.every(
          (item) =>
            isObject(item) &&
            typeof item.id === "string" &&
            item.id.length > 0 &&
            typeof item.secret === "string" &&
            item.secret.length > 0
        ) &&
        (!("reopenPopup" in value) || typeof value.reopenPopup === "boolean")
      );
    case "dropbox":
    case "drive":
    case "onedrive":
    case "lock":
    case "resetAutolock":
    case "updateContextMenu":
    case "runLocalImport":
    case "runWebDAVBackup":
    case "syncWebDAVAlarm":
      return true;
    case "setLocalImport":
      return "enabled" in value && typeof value.enabled === "boolean";
    case "setLocalImportInterval":
      return "minutes" in value && typeof value.minutes === "number";
    case "updateContentTab":
      return (
        "data" in value &&
        typeof value.data === "object" &&
        value.data !== null &&
        !Array.isArray(value.data) &&
        "id" in value.data &&
        typeof value.data.id === "number" &&
        "windowId" in value.data &&
        typeof value.data.windowId === "number"
      );
    default:
      return false;
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBiometricEnrollment(
  value: unknown
): BiometricCredentialEnrollment | null {
  if (
    !isObject(value) ||
    typeof value.credentialId !== "string" ||
    typeof value.extensionId !== "string" ||
    typeof value.prfSalt !== "string" ||
    typeof value.kdfSalt !== "string" ||
    typeof value.initialPrfOutput !== "string"
  ) {
    return null;
  }
  return {
    credentialId: value.credentialId,
    extensionId: value.extensionId,
    prfSalt: value.prfSalt,
    kdfSalt: value.kdfSalt,
    initialPrfOutput: value.initialPrfOutput,
  };
}

function isWebDAVRequest(value: unknown): value is WebDAVRequestMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("action" in value) ||
    value.action !== "webdavRequest" ||
    !("method" in value) ||
    typeof value.method !== "string" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("headers" in value) ||
    typeof value.headers !== "object" ||
    value.headers === null ||
    Array.isArray(value.headers) ||
    ("body" in value && typeof value.body !== "string") ||
    ("timeout" in value && typeof value.timeout !== "number")
  ) {
    return false;
  }

  return Object.values(value.headers).every(
    (header) => typeof header === "string"
  );
}
async function handleRuntimeMessage(
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender
) {
  await UserSettings.updateItems();

  if (message.action === "getCapture") {
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) {
      return;
    }
    const url = await getCapture(sender.tab);
    sendTabMessage(sender.tab.id, {
      action: "sendCaptureUrl",
      info: { ...message.info, url },
    });
  } else if (message.action === "getTotp") {
    if (sender.id !== chrome.runtime.id) {
      return;
    }
    await getTotp(message.info, false, sender.tab?.id);
  } else if (!isExtensionPageSender(sender)) {
    throw new Error("invalidSender");
  } else if (message.action === "cachePassphrase") {
    await chrome.storage.session.set({
      cachedPassphrase: message.value,
      cachedKeyId: message.keyId,
    });
    await syncActionPopupMode();
    await chrome.alarms.clear("autolock");
    await setAutolock();
    // A scheduled import cannot run while the vault is locked, so the unlock is
    // the moment to catch up.
    void runLocalImportTick().catch((error) =>
      console.info("[background] local import after unlock skipped", error)
    );
    void runWebDAVAutoBackup().catch((error) =>
      console.info("[background] WebDAV backup after unlock skipped", error)
    );
  } else if (message.action === "runLocalImport") {
    await runLocalImportTick({ manual: true });
  } else if (message.action === "setLocalImport") {
    await setLocalImportEnabled(message.enabled);
    await syncLocalImportAlarm(true);
    if (message.enabled) {
      // Do not make the user wait for the first alarm tick.
      void runLocalImportTick().catch((error) =>
        console.info("[background] local import after enable skipped", error)
      );
    }
  } else if (message.action === "setLocalImportInterval") {
    await setLocalImportInterval(message.minutes);
    await syncLocalImportAlarm(true);
  } else if (message.action === "runWebDAVBackup") {
    await runWebDAVAutoBackup();
    await syncWebDAVBackupAlarm(false);
  } else if (message.action === "syncWebDAVAlarm") {
    await syncWebDAVBackupAlarm(true);
  } else if (["dropbox", "drive", "onedrive"].includes(message.action)) {
    getBackupToken(message.action);
  } else if (message.action === "finishBiometricEnrollment") {
    const enrollment = parseBiometricEnrollment(message.enrollment);
    if (!enrollment || enrollment.extensionId !== chrome.runtime.id) {
      throw new Error("biometricUnlockInvalidBundle");
    }
    console.info("[background] finishing enrollment", {
      ticket: message.ticket,
      credentialIdLength: enrollment.credentialId.length,
    });
    await finishBiometricCredentialEnrollment(message.ticket, enrollment);
    await syncActionPopupMode();
    await setAutolock();
  } else if (message.action === "completeBiometricUnlock") {
    await cacheBiometricUnlockBundle(message.bundle);
    await syncActionPopupMode();
    await clearAutoBiometricPromptSkip();
    await chrome.alarms.clear("autolock");
    await setAutolock();
    void runLocalImportTick().catch((error) =>
      console.info("[background] local import after unlock skipped", error)
    );
    void runWebDAVAutoBackup().catch((error) =>
      console.info("[background] WebDAV backup after unlock skipped", error)
    );
    if (message.reopenPopup) {
      armBiometricPopupReopen(message.reopenDelayMs);
    }
  } else if (message.action === "completeBiometricReauth") {
    if (message.reopenPopup) {
      await markBiometricReauthVerified(message.keyId);
      if (message.reopenView === "SetPasswordPage") {
        await setPendingPopupReopenView(message.reopenView);
      }
      armBiometricPopupReopen(message.reopenDelayMs);
    }
  } else if (message.action === "completeBiometricBackupRestore") {
    if (vaultImportInFlight) {
      throw new Error("importInProgress");
    }
    if (message.reopenPopup) {
      armBiometricPopupReopen(120);
    }
    vaultImportInFlight = true;
    try {
      const preUnlockedKeys = new Map<string, string>(
        message.preUnlockedKeys.map((item) => [item.id, item.secret])
      );
      await importBackupContent({
        content: message.content,
        clearFirst: message.clearFirst,
        preUnlockedKeys,
        skipExisting: false,
      });
      notifyEntriesUpdated();
      if (message.reopenPopup && activePopupPorts.size === 0) {
        await setPendingPopupNotification("webdav_restore_success");
      }
    } catch (error) {
      if (message.reopenPopup && activePopupPorts.size === 0) {
        const code = error instanceof Error ? error.message : "";
        await setPendingPopupNotification(
          code === "biometricBackupKeyMismatch"
            ? "biometric_backup_key_mismatch"
            : "webdav_restore_failure"
        );
      }
      throw error;
    } finally {
      vaultImportInFlight = false;
    }
  } else if (message.action === "resetAutolock") {
    await syncActionPopupMode();
    await chrome.alarms.clear("autolock");
    await setAutolock();
    // Biometric unlock caches keys directly in session and calls resetAutolock,
    // so run the same catch-up hooks as password unlock when the vault is open.
    const { cachedPassphrase } = await chrome.storage.session.get(
      "cachedPassphrase"
    );
    if (cachedPassphrase) {
      void runLocalImportTick().catch((error) =>
        console.info("[background] local import after unlock skipped", error)
      );
      void runWebDAVAutoBackup().catch((error) =>
        console.info("[background] WebDAV backup after unlock skipped", error)
      );
    }
  } else if (message.action === "updateContentTab") {
    await setTrackedContentTab(message.data);
  } else if (message.action === "updateContextMenu") {
    await updateContextMenu();
  }
}

const CONTENT_TAB_STORAGE_KEY = "authenticatorContentTabId";
const BIOMETRIC_SETUP_PREFIX = "AuthenticatorBiometricSetup:";

async function setTrackedContentTab(tab: ContentTab | undefined) {
  contentTab = tab;
  try {
    if (tab?.id !== undefined) {
      await chrome.storage.session.set({
        [CONTENT_TAB_STORAGE_KEY]: tab.id,
      });
    } else {
      await chrome.storage.session.remove(CONTENT_TAB_STORAGE_KEY);
    }
  } catch (error) {
    console.warn("[background] failed to persist contentTab", error);
  }
}

async function getTrackedContentTabId(): Promise<number | undefined> {
  if (contentTab?.id !== undefined) {
    return contentTab.id;
  }
  try {
    const stored = await chrome.storage.session.get(CONTENT_TAB_STORAGE_KEY);
    const id = stored[CONTENT_TAB_STORAGE_KEY];
    return typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}

async function clearSessionSecrets() {
  try {
    const allSession = await chrome.storage.session.get();
    const setupKeys = Object.keys(allSession).filter((key) =>
      key.startsWith(BIOMETRIC_SETUP_PREFIX)
    );
    if (setupKeys.length) {
      await chrome.storage.session.remove(setupKeys);
    }
    await chrome.storage.session.set({
      cachedPassphrase: null,
      cachedKeyId: null,
      cachedBiometricKeys: null,
      cachedBiometricDefaultKeyId: null,
    });
    await clearBiometricReauth();
  } catch (error) {
    console.error("Failed to clear cached session secrets", error);
  }
}

const activePopupPorts = new Set<chrome.runtime.Port>();
let pendingBiometricReopen: {
  expiresAt: number;
  delayMs: number;
  safetyTimer?: ReturnType<typeof setTimeout>;
} | null = null;

function clearPendingBiometricReopen(): void {
  if (pendingBiometricReopen?.safetyTimer !== undefined) {
    clearTimeout(pendingBiometricReopen.safetyTimer);
  }
  pendingBiometricReopen = null;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup-lifecycle") {
    return;
  }
  if (!port.sender || !isExtensionPageSender(port.sender)) {
    port.disconnect();
    return;
  }
  activePopupPorts.add(port);
  port.onDisconnect.addListener(() => {
    activePopupPorts.delete(port);
    if (
      activePopupPorts.size === 0 &&
      pendingBiometricReopen &&
      pendingBiometricReopen.expiresAt > Date.now()
    ) {
      const delayMs = pendingBiometricReopen.delayMs;
      clearPendingBiometricReopen();
      void reopenPopupAfterBiometricDismissal(delayMs);
    }
  });
});

async function hasOpenExtensionPopup(): Promise<boolean> {
  if (activePopupPorts.size > 0) {
    return true;
  }
  const runtimeWithContexts = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (filter: {
      contextTypes?: string[];
    }) => Promise<Array<{ contextType?: string }>>;
  };
  // A detached popup is a normal window with our page in it, so
  // getContexts({contextTypes:["POPUP"]}) does not list it.
  const popupUrl = chrome.runtime.getURL(DEFAULT_ACTION_POPUP_PATH);
  const windows = await new Promise<chrome.windows.Window[] | null>(
    (resolve) => {
      chrome.windows.getAll({ populate: true }, (list) => {
        resolve(chrome.runtime.lastError ? null : list);
      });
    }
  );
  if (
    windows?.some((win) =>
      win.tabs?.some((tab) => tab.url?.startsWith(popupUrl))
    )
  ) {
    return true;
  }
  if (typeof runtimeWithContexts.getContexts !== "function") {
    return false;
  }
  try {
    const contexts = await runtimeWithContexts.getContexts({
      contextTypes: ["POPUP"],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

const DEFAULT_ACTION_POPUP_PATH = "view/popup.html";

function getWindowById(
  windowId: number
): Promise<chrome.windows.Window | null> {
  return new Promise((resolve) => {
    chrome.windows.get(windowId, {}, (win) => {
      if (chrome.runtime.lastError || !win) {
        resolve(null);
        return;
      }
      resolve(win);
    });
  });
}

async function syncActionPopupMode(): Promise<void> {
  if (!isChromium || typeof chrome.action?.setPopup !== "function") {
    return;
  }
  try {
    const biometricConfigured = await hasBiometricUnlockRecord();
    // Whenever device unlock is configured, always open our anchored popup
    // window on icon click so locked and unlocked states share the exact same
    // native rounded window UI and position, and Touch ID never dismisses it
    // (unlock, password changes, and encrypted WebDAV restores alike).
    const popup = biometricConfigured ? "" : DEFAULT_ACTION_POPUP_PATH;
    await chrome.action.setPopup({ popup });
  } catch (error) {
    console.info(
      "[background] action popup mode sync skipped:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

if (isChromium && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    void (async () => {
      const biometricConfigured = await hasBiometricUnlockRecord().catch(
        () => false
      );
      const tabWindow =
        tab?.windowId !== undefined ? await getWindowById(tab.windowId) : null;
      const anchor =
        tabWindow && (tabWindow.type as string) === "normal"
          ? tabWindow
          : await getLastFocusedNormalWindow();

      if (!biometricConfigured) {
        await syncActionPopupMode();
        if (!(await tryOpenActionPopup(anchor))) {
          await openAnchoredDetachedPopup(anchor);
        }
        return;
      }

      await openAnchoredDetachedPopup(anchor);
    })();
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    (areaName === "local" && BIOMETRIC_UNLOCK_STORAGE_KEY in changes) ||
    (areaName === "session" &&
      ("cachedPassphrase" in changes || "cachedBiometricKeys" in changes))
  ) {
    void syncActionPopupMode();
  }
});

function getLastFocusedNormalWindow(): Promise<chrome.windows.Window | null> {
  return new Promise((resolve) => {
    chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (win) => {
      if (chrome.runtime.lastError || !win) {
        resolve(null);
        return;
      }
      resolve(win);
    });
  });
}

function focusBrowserWindow(windowId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.windows.update(windowId, { focused: true }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function tryOpenActionPopup(
  normalWindow: chrome.windows.Window | null
): Promise<boolean> {
  const actionApi = chrome.action as typeof chrome.action & {
    openPopup?: (options?: { windowId?: number }) => Promise<void>;
  };
  if (typeof actionApi?.openPopup !== "function") {
    return false;
  }
  if (await hasOpenExtensionPopup()) {
    return true;
  }
  const options =
    normalWindow?.id !== undefined ? { windowId: normalWindow.id } : undefined;
  try {
    if (options) {
      await actionApi.openPopup(options);
    } else {
      await actionApi.openPopup();
    }
    return true;
  } catch (error) {
    console.info(
      "[background] chrome.action.openPopup unavailable:",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

let trackedDetachedPopup: {
  windowId: number;
  anchorWindowId?: number;
  openedAt: number;
} | null = null;

async function readSavedPopupAnchorOffset(): Promise<PopupAnchorOffset | null> {
  try {
    const stored = await chrome.storage.local.get(POPUP_ANCHOR_STORAGE_KEY);
    const value = stored[POPUP_ANCHOR_STORAGE_KEY];
    return isPopupAnchorOffset(value) ? value : null;
  } catch {
    return null;
  }
}

if (chrome.windows?.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener((win) => {
    if (
      !trackedDetachedPopup ||
      win.id !== trackedDetachedPopup.windowId ||
      Date.now() < trackedDetachedPopup.openedAt + 800 ||
      win.left === undefined ||
      win.top === undefined
    ) {
      return;
    }
    const winLeft = win.left;
    const winTop = win.top;
    const anchorId = trackedDetachedPopup.anchorWindowId;
    void (async () => {
      const anchor =
        anchorId !== undefined
          ? await getWindowById(anchorId)
          : await getLastFocusedNormalWindow();
      if (
        !anchor ||
        anchor.left === undefined ||
        anchor.top === undefined ||
        anchor.width === undefined
      ) {
        return;
      }
      const offsetFromRight = Math.round(anchor.left + anchor.width - winLeft);
      const offsetFromTop = Math.round(winTop - anchor.top);
      if (offsetFromRight < 0 || offsetFromTop < 0) {
        return;
      }
      await chrome.storage.local.set({
        [POPUP_ANCHOR_STORAGE_KEY]: { offsetFromRight, offsetFromTop },
      });
    })();
  });
}

if (chrome.windows?.onRemoved) {
  chrome.windows.onRemoved.addListener((removedId) => {
    if (trackedDetachedPopup?.windowId === removedId) {
      trackedDetachedPopup = null;
    }
  });
}

async function openAnchoredDetachedPopup(
  anchor: chrome.windows.Window | null
): Promise<void> {
  const popupUrl = chrome.runtime.getURL(
    "view/popup.html?popup=true&autoClose=1"
  );
  const existing = await new Promise<chrome.windows.Window | null>(
    (resolve) => {
      chrome.windows.getAll({ populate: true }, (windows) => {
        if (chrome.runtime.lastError || !Array.isArray(windows)) {
          resolve(null);
          return;
        }
        const match = windows.find((win) =>
          win.tabs?.some((tab) => tab.url === popupUrl)
        );
        resolve(match || null);
      });
    }
  );
  if (existing?.id !== undefined) {
    await focusBrowserWindow(existing.id);
    return;
  }

  await UserSettings.updateItems();
  const zoom = Number(UserSettings.items.zoom) / 100 || 1;
  const width = Math.round(320 * zoom);
  const height = Math.round(480 * zoom) + 28;
  const savedAnchor = await readSavedPopupAnchorOffset();
  const placement: { left?: number; top?: number } = {};
  if (
    anchor &&
    anchor.left !== undefined &&
    anchor.top !== undefined &&
    anchor.width !== undefined
  ) {
    const minMargin = 8;
    const anchorHeight = anchor.height ?? height;
    const maxLeft = anchor.left + anchor.width - width - minMargin;
    const maxTop = anchor.top + anchorHeight - height - minMargin;
    const preferredLeft = savedAnchor
      ? Math.round(anchor.left + anchor.width - savedAnchor.offsetFromRight)
      : anchor.left +
        anchor.width -
        width -
        (anchor.width > width + 240 ? 160 : 16);
    const preferredTop = savedAnchor
      ? Math.round(anchor.top + savedAnchor.offsetFromTop)
      : anchor.top + 82;

    placement.left = Math.min(
      Math.max(anchor.left + minMargin, preferredLeft),
      Math.max(anchor.left + minMargin, maxLeft)
    );
    placement.top = Math.min(
      Math.max(anchor.top + 24, preferredTop),
      Math.max(anchor.top + 24, maxTop)
    );
  }

  await new Promise<void>((resolve) => {
    chrome.windows.create(
      {
        url: popupUrl,
        type: "popup",
        width,
        height,
        focused: true,
        ...placement,
      },
      (created) => {
        if (!chrome.runtime.lastError && created?.id !== undefined) {
          trackedDetachedPopup = {
            windowId: created.id,
            anchorWindowId: anchor?.id,
            openedAt: Date.now(),
          };
        }
        resolve();
      }
    );
  });
}

async function reopenPopupAfterBiometricDismissal(
  initialDelayMs = 80
): Promise<void> {
  if (initialDelayMs > 0) {
    await delay(initialDelayMs);
  }
  if (await hasOpenExtensionPopup()) {
    return;
  }

  const normalWindow = await getLastFocusedNormalWindow();
  if (normalWindow?.id !== undefined && !normalWindow.focused) {
    await focusBrowserWindow(normalWindow.id);
    await delay(80);
  }

  if (await tryOpenActionPopup(normalWindow)) {
    return;
  }
  await delay(180);
  if (await tryOpenActionPopup(normalWindow)) {
    return;
  }

  // Chrome rejects programmatic chrome.action.openPopup() when the user gesture
  // expired during the OS Touch ID sheet. Fall back to the extension's own
  // anchored popup window so the user immediately sees the unlocked vault.
  if (!(await hasOpenExtensionPopup())) {
    await openAnchoredDetachedPopup(normalWindow);
  }
}

function armBiometricPopupReopen(initialDelayMs = 100): void {
  clearPendingBiometricReopen();
  const delayMs = Math.max(50, Math.min(initialDelayMs, 1000));
  if (activePopupPorts.size === 0) {
    void reopenPopupAfterBiometricDismissal(delayMs);
    return;
  }
  pendingBiometricReopen = {
    expiresAt: Date.now() + 4000,
    delayMs,
    safetyTimer: setTimeout(() => {
      void (async () => {
        if (!pendingBiometricReopen) {
          return;
        }
        if (await hasOpenExtensionPopup()) {
          return;
        }
        const pendingDelay = pendingBiometricReopen.delayMs;
        clearPendingBiometricReopen();
        await reopenPopupAfterBiometricDismissal(Math.min(pendingDelay, 80));
      })();
    }, 650),
  };
}

async function handleVaultLock() {
  await chrome.alarms.clear("autolock");
  await clearSessionSecrets();
  await syncActionPopupMode();
  const trackedTabId = await getTrackedContentTabId();
  if (trackedTabId !== undefined) {
    sendTabMessage(trackedTabId, { action: "stopCapture" });
  }
  sendRuntimeMessage({ action: "stopImport" });
}

function sendTabMessage(tabId: number, message: unknown) {
  chrome.tabs.sendMessage(tabId, message, () => {
    const error = chrome.runtime.lastError;
    if (!error) {
      return;
    }
    if (contentTab?.id === tabId) {
      void setTrackedContentTab(undefined);
    }
    if (!error.message?.includes("Receiving end does not exist")) {
      console.warn("Unable to deliver tab message", error.message);
    }
  });
}

function sendRuntimeMessage(message: unknown) {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
}

let vaultImportInFlight = false;
async function syncLocalImportAlarm(force = false): Promise<void> {
  if (await isLocalImportEnabled()) {
    const periodInMinutes = await getLocalImportInterval();
    const existing = await chrome.alarms.get(LOCAL_IMPORT_ALARM);
    if (force || !existing || existing.periodInMinutes !== periodInMinutes) {
      chrome.alarms.create(LOCAL_IMPORT_ALARM, {
        periodInMinutes,
      });
    }
    return;
  }
  await chrome.alarms.clear(LOCAL_IMPORT_ALARM);
}

const WEBDAV_BACKUP_ALARM = "webdavBackup";
// Alarms wake the worker hourly; the 7-day check decides whether to upload.
const WEBDAV_BACKUP_PERIOD_MINUTES = 60;
let webdavBackupInFlight = false;

/** WebDAV auto-backup is only possible when configured, permitted and enabled. */
async function readWebDAVAutoBackupConfig() {
  await UserSettings.updateItems();
  if (UserSettings.items.webdavAutoBackup === false) {
    return null;
  }
  const config = await getWebDAVConfig();
  if (!config.url || !config.username || !config.password) {
    return null;
  }
  const origin = getWebDAVOrigin(config.url);
  if (!origin) {
    return null;
  }
  const granted = await new Promise<boolean>((resolve) => {
    chrome.permissions.contains({ origins: [origin] }, (result) =>
      resolve(Boolean(result))
    );
  });
  return granted ? config : null;
}

/** Minutes until the next local occurrence of `hour`:00. */
function minutesUntilHour(hour: number, now = new Date()): number {
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return Math.max(1, Math.round((target.getTime() - now.getTime()) / 60000));
}

async function syncWebDAVBackupAlarm(force = false): Promise<void> {
  const config = await readWebDAVAutoBackupConfig().catch(() => null);
  if (!config) {
    await chrome.alarms.clear(WEBDAV_BACKUP_ALARM);
    return;
  }
  const targetHour = normalizeBackupHour(UserSettings.items.webdavBackupHour);
  const existing = await chrome.alarms.get(WEBDAV_BACKUP_ALARM);

  if (targetHour < 0) {
    // No preferred hour: hourly ticks are enough, keep the existing phase.
    if (!existing) {
      chrome.alarms.create(WEBDAV_BACKUP_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: WEBDAV_BACKUP_PERIOD_MINUTES,
      });
    }
    return;
  }

  // On passive worker wakeups, preserve an already-scheduled alarm so hourly
  // retries are not pushed 24 hours forward. Only re-anchor when forced or missing.
  if (!force && existing) {
    return;
  }

  // Anchor the ticks to the chosen hour so the upload lands at HH:00 instead of
  // at whatever minute the worker happened to start.
  await chrome.alarms.clear(WEBDAV_BACKUP_ALARM);
  chrome.alarms.create(WEBDAV_BACKUP_ALARM, {
    delayInMinutes: minutesUntilHour(targetHour),
    periodInMinutes: WEBDAV_BACKUP_PERIOD_MINUTES,
  });
}

/**
 * Uploads a WebDAV backup when the schedule is due. Runs from an alarm, so it no
 * longer depends on the popup being opened — when encrypted, it waits for the
 * session passphrase to be available.
 */
async function runWebDAVAutoBackup(): Promise<void> {
  if (webdavBackupInFlight) {
    return;
  }
  webdavBackupInFlight = true;
  try {
    const config = await readWebDAVAutoBackupConfig().catch(() => null);
    if (!config) {
      return;
    }
    const lastDay = normalizeBackupDay(UserSettings.items.webdavLastBackupTime);
    const intervalDays = normalizeBackupIntervalDays(
      UserSettings.items.webdavBackupIntervalDays
    );
    if (!isWebDAVBackupDue(getClientDay(), lastDay, intervalDays)) {
      return;
    }
    const targetHour = normalizeBackupHour(UserSettings.items.webdavBackupHour);
    if (!isBackupHourReached(targetHour)) {
      return;
    }
    const encryptedBackup = config.encrypted !== false;
    const hasEncryptionKey = await EntryStorage.hasEncryptionKey();
    const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get([
      "cachedPassphrase",
      "cachedKeyId",
    ]);
    if ((hasEncryptionKey || encryptedBackup) && !cachedPassphrase) {
      return;
    }

    const encryption = new Encryption(
      cachedPassphrase || "",
      cachedKeyId || ""
    );
    const ok = await uploadWebDAVBackup(encryption, encryptedBackup);
    if (!ok) {
      return;
    }
    await UserSettings.updateItems();
    UserSettings.items.webdavLastBackupTime = getClientDay();
    UserSettings.items.webdavLastAutoBackupAt = Date.now();
    await UserSettings.commitItems();
    await pruneWebDAVBackups(Number(UserSettings.items.webdavMaxBackups || 0));
    sendRuntimeMessage({ action: "webdavBackupUpdated" });
  } catch (error) {
    console.error("[background] WebDAV auto backup failed", error);
  } finally {
    webdavBackupInFlight = false;
  }
}

/**
 * Imports whatever the native host has staged. A locked vault is not an error:
 * the tick simply returns and the unlock path retries.
 */
async function runLocalImportTick(
  options: { manual?: boolean } = {}
): Promise<void> {
  const manual = options.manual === true;
  if (!(await isLocalImportEnabled())) {
    if (manual) {
      throw new Error("localImportDisabled");
    }
    return;
  }
  if (await isVaultLocked()) {
    if (manual) {
      throw new Error("vaultLocked");
    }
    return;
  }
  if (vaultImportInFlight) {
    if (manual) {
      throw new Error("importInProgress");
    }
    return;
  }

  vaultImportInFlight = true;
  try {
    // Only the newest export is imported; the host marks older queued files as
    // superseded on ack, so a backlog never merges stale entries back in.
    const result = await importFromLocalHost({ ignoreCooldown: manual });
    if (!result) {
      if (manual) {
        throw new Error("localImportNoPending");
      }
      return;
    }
    notifyEntriesUpdated();
  } finally {
    vaultImportInFlight = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncLocalImportAlarm(false);
  void syncWebDAVBackupAlarm(false);
  void updateContextMenu();
  void syncActionPopupMode();
});
chrome.runtime.onStartup.addListener(() => {
  void syncLocalImportAlarm(false);
  void syncWebDAVBackupAlarm(false);
  void updateContextMenu();
  void syncActionPopupMode();
});
// Self-heal: if the flag was saved while the worker was asleep and the alarm
// never got created, the next wake-up restores it without resetting active timers.
void syncLocalImportAlarm(false).catch((error) =>
  console.info("[background] local import alarm sync skipped", error)
);
void syncWebDAVBackupAlarm(false).catch((error) =>
  console.info("[background] WebDAV alarm sync skipped", error)
);
void syncActionPopupMode().catch((error) =>
  console.info("[background] action popup mode sync skipped", error)
);

// The alarm listener used to ignore the alarm name, which meant any new alarm
// would also lock the vault. Filter by name before touching the session.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WEBDAV_BACKUP_ALARM) {
    void runWebDAVAutoBackup().catch((error) =>
      console.info("[background] scheduled WebDAV backup skipped", error)
    );
    return;
  }
  if (alarm.name === LOCAL_IMPORT_ALARM) {
    void runLocalImportTick().catch((error) =>
      console.info("[background] scheduled local import skipped", error)
    );
    return;
  }
  if (alarm.name !== "autolock") {
    return;
  }
  void clearSessionSecrets();
  void getTrackedContentTabId().then((tabId) => {
    if (tabId !== undefined) {
      sendTabMessage(tabId, { action: "stopCapture" });
    }
  });
  sendRuntimeMessage({ action: "stopImport" });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (contentTab?.id === tabId) {
    void setTrackedContentTab(undefined);
  }
});

async function getCapture(tab: chrome.tabs.Tab) {
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

async function getTotp(
  text: string,
  silent = false,
  senderTabId?: number
): Promise<boolean> {
  const tabId = senderTabId ?? contentTab?.id;
  if (tabId === undefined || !text) {
    return false;
  }

  if (!text.startsWith("otpauth://")) {
    if (text.startsWith("otpauth-migration://")) {
      const otpUrls = getOTPAuthPerLineFromOPTAuthMigration(text);
      if (otpUrls.length === 0) {
        if (!silent) sendTabMessage(tabId, { action: "errorenc" });
        return false;
      }

      const {
        cachedPassphrase,
        cachedKeyId,
      } = await chrome.storage.session.get(["cachedPassphrase", "cachedKeyId"]);
      const encryption = new Encryption(
        cachedPassphrase || "",
        cachedKeyId || ""
      );
      try {
        await EntryStorage.assertEncryptionReadyForVault(encryption);
      } catch {
        if (!silent) sendTabMessage(tabId, { action: "errorenc" });
        return false;
      }

      const batchEntryData: { [hash: string]: RawOTPStorage } = {};
      let failedCount = 0;
      let nextIndex = 0;
      for (const otpUrl of otpUrls) {
        const parsed = parseOtpAuthUri(otpUrl);
        if (!parsed) {
          failedCount++;
          continue;
        }
        const hash = crypto.randomUUID();
        const record: RawOTPStorage = {
          account: parsed.account,
          hash,
          issuer: parsed.issuer,
          secret: parsed.secret,
          type: parsed.type,
          encrypted: false,
          index: nextIndex++,
          counter: parsed.counter || 0,
          pinned: false,
        };
        if (parsed.period) record.period = parsed.period;
        if (parsed.digits) record.digits = parsed.digits;
        if (parsed.algorithm) record.algorithm = parsed.algorithm;
        batchEntryData[hash] = record;
      }

      if (Object.keys(batchEntryData).length === 0) {
        if (!silent) sendTabMessage(tabId, { action: "migrationfail" });
        return false;
      }

      try {
        await EntryStorage.import(encryption, batchEntryData);
        notifyEntriesUpdated();
      } catch {
        if (!silent) sendTabMessage(tabId, { action: "migrationfail" });
        return false;
      }

      if (failedCount > 0) {
        if (!silent) sendTabMessage(tabId, { action: "migrationpartlyfail" });
        return true;
      }
      if (!silent) sendTabMessage(tabId, { action: "migrationsuccess" });
      return true;
    }

    if (text === "error decoding QR Code") {
      if (!silent) sendTabMessage(tabId, { action: "errorqr" });
      return false;
    }
    if (!silent) sendTabMessage(tabId, { action: "text", text });
    return true;
  }

  const parsed = parseOtpAuthUri(text);
  if (!parsed) {
    if (!silent) sendTabMessage(tabId, { action: "errorqr" });
    return false;
  }

  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get([
    "cachedPassphrase",
    "cachedKeyId",
  ]);
  const encryption = new Encryption(cachedPassphrase || "", cachedKeyId || "");
  try {
    await EntryStorage.assertEncryptionReadyForVault(encryption);
  } catch {
    if (!silent) sendTabMessage(tabId, { action: "errorenc" });
    return false;
  }

  const hash = crypto.randomUUID();
  const entryData: { [hash: string]: RawOTPStorage } = {
    [hash]: {
      account: parsed.account,
      hash,
      issuer: parsed.issuer,
      secret: parsed.secret,
      type: parsed.type,
      encrypted: false,
      index: 0,
      counter: parsed.counter || 0,
      pinned: false,
    },
  };
  if (parsed.period) entryData[hash].period = parsed.period;
  if (parsed.digits) entryData[hash].digits = parsed.digits;
  if (parsed.algorithm) entryData[hash].algorithm = parsed.algorithm;

  await EntryStorage.import(encryption, entryData);
  if (!silent) {
    sendTabMessage(tabId, { action: "added", account: parsed.account });
  }
  return true;
}
function getBackupToken(service: string) {
  if (isChrome && service === "drive") {
    chrome.identity.getAuthToken(
      {
        interactive: true,
        scopes: ["https://www.googleapis.com/auth/drive.file"],
      },
      (value) => {
        if (!value) {
          return false;
        }
        UserSettings.items.driveToken = value;
        void UserSettings.commitItems();
        return true;
      }
    );
  } else {
    let authUrl = "";
    let redirUrl = "";
    if (service === "dropbox") {
      redirUrl = encodeURIComponent(chrome.identity.getRedirectURL());
      authUrl =
        "https://www.dropbox.com/oauth2/authorize?response_type=token&client_id=" +
        getCredentials().dropbox.client_id +
        "&redirect_uri=" +
        redirUrl;
    } else if (service === "drive") {
      if (navigator.userAgent.indexOf("Edg") !== -1) {
        redirUrl = encodeURIComponent("https://authenticator.cc/oauth-edge");
      } else if (isFirefox) {
        redirUrl = encodeURIComponent(chrome.identity.getRedirectURL());
      } else {
        redirUrl = encodeURIComponent("https://authenticator.cc/oauth");
      }

      authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&client_id=" +
        getCredentials().drive.client_id +
        "&scope=https%3A//www.googleapis.com/auth/drive.file&prompt=consent&redirect_uri=" +
        redirUrl;
    } else if (service === "onedrive") {
      redirUrl = encodeURIComponent(chrome.identity.getRedirectURL());
      authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${
        getCredentials().onedrive.client_id
      }&response_type=code&redirect_uri=${redirUrl}&scope=https%3A%2F%2Fgraph.microsoft.com%2FFiles.ReadWrite${
        UserSettings.items.oneDriveBusiness !== true ? ".AppFolder" : ""
      }%20https%3A%2F%2Fgraph.microsoft.com%2FUser.Read%20offline_access&response_mode=query&prompt=consent`;
    }
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      async (url) => {
        if (!url) {
          return;
        }
        let params: URLSearchParams;
        try {
          const parsedUrl = new URL(url);
          if (service === "dropbox") {
            params = new URLSearchParams(parsedUrl.hash.replace(/^#/, ""));
          } else {
            params = parsedUrl.searchParams;
          }
        } catch {
          return;
        }

        if (service === "dropbox") {
          const accessToken = params.get("access_token");
          if (!accessToken) {
            return;
          }
          await UserSettings.updateItems();
          UserSettings.items.dropboxToken = accessToken;
          await UserSettings.commitItems();
          await uploadBackup("dropbox");
          return;
        }

        const code = params.get("code");
        if (!code) {
          return;
        }

        if (service === "drive") {
          let success = false;
          const driveRedirUrl =
            navigator.userAgent.indexOf("Edg") !== -1
              ? "https://authenticator.cc/oauth-edge"
              : isFirefox
              ? chrome.identity.getRedirectURL()
              : "https://authenticator.cc/oauth";
          const tokenBody = new URLSearchParams({
            client_id: getCredentials().drive.client_id,
            client_secret: getCredentials().drive.client_secret,
            code,
            redirect_uri: driveRedirUrl,
            grant_type: "authorization_code",
          });

          const response = await fetch(
            "https://www.googleapis.com/oauth2/v4/token",
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: tokenBody.toString(),
            }
          );

          try {
            const res = await response.json();

            if (res.error) {
              console.error(res.error_description);
            } else {
              await UserSettings.updateItems();
              UserSettings.items.driveToken = res.access_token;
              UserSettings.items.driveRefreshToken = res.refresh_token;
              await UserSettings.commitItems();
              success = true;
            }
          } catch (error) {
            console.error(error);
            throw error;
          }

          if (success) {
            await uploadBackup("drive");
          }
          return success;
        } else if (service === "onedrive") {
          // Need to trade code we got from launchWebAuthFlow for a
          // token & refresh token
          let success = false;
          await UserSettings.updateItems();
          const tokenBody = new URLSearchParams({
            client_id: getCredentials().onedrive.client_id,
            client_secret: getCredentials().onedrive.client_secret,
            code,
            redirect_uri: chrome.identity.getRedirectURL(),
            grant_type: "authorization_code",
            scope: `https://graph.microsoft.com/Files.ReadWrite${
              UserSettings.items.oneDriveBusiness !== true ? ".AppFolder" : ""
            } https://graph.microsoft.com/User.Read offline_access`,
          });

          const response = await fetch(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: tokenBody.toString(),
            }
          );

          try {
            const res = await response.json();
            if (res.error) {
              console.error(res.error_description);
            } else {
              await UserSettings.updateItems();
              UserSettings.items.oneDriveToken = res.access_token;
              UserSettings.items.oneDriveRefreshToken = res.refresh_token;
              await UserSettings.commitItems();
              success = true;
            }
          } catch (error) {
            console.error(error);
            throw error;
          }

          if (success) {
            await uploadBackup("onedrive");
          }
          return success;
        }

        return;
      }
    );
  }
}

async function uploadBackup(service: string) {
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();
  const encryption = new Encryption(cachedPassphrase, cachedKeyId);

  const providers: Record<string, () => Promise<boolean>> = {
    dropbox: () => new Dropbox().upload(encryption),
    drive: () => new Drive().upload(encryption),
    onedrive: () => new OneDrive().upload(encryption),
  };
  const run = providers[service];
  if (!run) {
    return;
  }
  try {
    const ok = await run();
    if (!ok) {
      console.warn(`[background] ${service} backup returned no result`);
    }
  } catch (error) {
    // Surface the reason: a locked vault and a network failure are different.
    console.error(
      `[background] ${service} backup failed:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// Show issue page after first install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") {
    return;
  } else if (await ManagedStorage.get("disableInstallHelp", false)) {
    return;
  }

  let url: string | null = null;

  if (isChrome) {
    url = "https://otp.ee/chromeissues";
  }

  if (url) {
    chrome.tabs.create({ url, active: true });
  }
});

chrome.commands.onCommand.addListener(async (command: string) => {
  const {
    cachedPassphrase,
    cachedKeyId,
    cachedBiometricKeys,
  } = await chrome.storage.session.get([
    "cachedPassphrase",
    "cachedKeyId",
    "cachedBiometricKeys",
  ]);

  let tab: chrome.tabs.Tab | undefined;

  switch (command) {
    case "scan-qr":
      if (await isVaultLocked()) {
        return;
      }

      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["/dist/content.js"],
          });
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ["/css/content.css"],
          });

          await setTrackedContentTab(tab);
          sendTabMessage(tab.id, { action: "capture" });
        } catch (error) {
          console.warn("[background] scan-qr injection failed:", error);
        }
      }
      break;

    case "autofill":
      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["/dist/content.js"],
          });
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ["/css/content.css"],
          });
        } catch (error) {
          console.warn("[background] autofill injection failed:", error);
          break;
        }

        await setTrackedContentTab(tab);

        const defaultEncryption = new Encryption(
          cachedPassphrase || "",
          cachedKeyId || ""
        );
        const encryptions = new Map<string, Encryption>();
        if (Array.isArray(cachedBiometricKeys)) {
          for (const item of cachedBiometricKeys) {
            if (
              item &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              typeof item.secret === "string"
            ) {
              encryptions.set(item.id, new Encryption(item.secret, item.id));
            }
          }
        }
        if (defaultEncryption.getEncryptionStatus() && cachedKeyId) {
          encryptions.set(cachedKeyId, defaultEncryption);
        }

        const siteName = await getSiteName();
        const entries = await EntryStorage.get();
        for (const entry of entries) {
          const entryEncryption =
            (entry.keyId && encryptions.get(entry.keyId)) || defaultEncryption;
          if (entryEncryption.getEncryptionStatus()) {
            entry.applyEncryption(entryEncryption);
          }
        }
        const matchedEntries = getMatchedEntries(siteName, entries);

        if (matchedEntries && matchedEntries.length === 1) {
          const entry = matchedEntries[0];

          if (
            entry.code !== CodeState.Encrypted &&
            entry.code !== CodeState.Invalid
          ) {
            sendTabMessage(tab.id, {
              action: "pastecode",
              code: entry.code,
            });
          }
        }
      }
      break;

    default:
      break;
  }
  return;
});

async function setAutolock() {
  const enforcedAutolock = Number(
    await ManagedStorage.get("enforceAutolock", false)
  );

  if (enforcedAutolock && enforcedAutolock > 0) {
    chrome.alarms.create("autolock", { delayInMinutes: enforcedAutolock });
    return;
  }

  // Set default autolock value
  if (UserSettings.items.autolock === undefined) {
    UserSettings.items.autolock = DEFAULT_AUTOLOCK_MINUTES;
  }

  // 0 means "never auto-lock": no alarm at all, matching what the UI shows.
  const minutes = normalizeAutolock(UserSettings.items.autolock);
  if (minutes > 0) {
    chrome.alarms.create("autolock", { delayInMinutes: minutes });
  }
}

function handleContextMenuClick(
  _info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
) {
  let popupUrl = "view/popup.html?popup=true";
  if (tab && tab.url && tab.title) {
    popupUrl +=
      "&url=" +
      encodeURIComponent(tab.url) +
      "&title=" +
      encodeURIComponent(tab.title);
  }
  const windowType = isFirefox ? "detached_panel" : "panel";
  chrome.windows.create({
    url: chrome.runtime.getURL(popupUrl),
    type: windowType as chrome.windows.createTypeEnum,
    height: 400,
    width: 320,
  });
}

chrome.contextMenus?.onClicked?.addListener(handleContextMenuClick);

async function updateContextMenu() {
  await UserSettings.updateItems();
  const hasPermission = await new Promise<boolean>((resolve) => {
    chrome.permissions.contains(
      {
        permissions: ["contextMenus"],
      },
      (result) => resolve(Boolean(result))
    );
  });
  if (!hasPermission || !chrome.contextMenus) {
    return;
  }
  if (UserSettings.items.enableContextMenu === true) {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "otpContextMenu",
        title: chrome.i18n.getMessage("extName"),
        contexts: ["all"],
      });
    });
  } else {
    chrome.contextMenus.removeAll();
  }
}

async function handleWebDAVRequest(message: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<WebDAVResponse> {
  const controller = new AbortController();
  const timeout = message.timeout || 15000;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(message.url, {
      method: message.method,
      headers: message.headers,
      body: message.body,
      signal: controller.signal,
    });
    const responseText = await response.text();
    const headerLines: string[] = [];
    response.headers.forEach((value, key) => {
      headerLines.push(`${key}: ${value}`);
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: headerLines.join("\r\n"),
      responseText,
    };
  } catch (error) {
    const messageText =
      error instanceof DOMException && error.name === "AbortError"
        ? "Timeout"
        : (error as Error).message || "Network Error";
    return {
      status: 0,
      statusText: messageText,
      headers: "",
      responseText: "",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

type WebDAVResponse = {
  status: number;
  statusText: string;
  headers: string;
  responseText: string;
};

// External API entry point. Only other extensions can reach this listener:
// `externally_connectable` is not declared, so web pages are never allowed in.
// Every call beyond `ping` needs the token generated in the security settings.
chrome.runtime.onMessageExternal.addListener(
  (rawMessage, sender, sendResponse) => {
    void handleExternalMessage(rawMessage, sender).then(
      (response) => sendResponse(response),
      (error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    );
    return true;
  }
);

async function handleExternalMessage(
  rawMessage: unknown,
  sender: chrome.runtime.MessageSender
): Promise<Record<string, unknown>> {
  if (!isExternalExtensionCaller(sender)) {
    throw new Error("externalCallerRejected");
  }
  if (!isObject(rawMessage) || typeof rawMessage.action !== "string") {
    throw new Error("externalMessageInvalid");
  }

  if (rawMessage.action === "ping") {
    const apiEnabled = await isApiAccessEnabled();
    const authorized = apiEnabled
      ? await verifyApiToken(rawMessage.token)
      : false;
    return {
      ok: true,
      name: "Authenticator",
      version: chrome.runtime.getManifest().version,
      apiEnabled,
      locked: authorized ? await isVaultLocked() : null,
    };
  }

  if (rawMessage.action !== "importBackup") {
    throw new Error("externalActionUnsupported");
  }

  if (!(await isApiAccessEnabled())) {
    throw new Error("externalApiDisabled");
  }
  if (!(await verifyApiToken(rawMessage.token))) {
    throw new Error("externalTokenInvalid");
  }
  if (vaultImportInFlight) {
    throw new Error("importInProgress");
  }

  const content =
    typeof rawMessage.content === "string" ? rawMessage.content : "";
  const passphrase =
    typeof rawMessage.passphrase === "string" ? rawMessage.passphrase : null;
  const clearFirst = rawMessage.clearFirst === true;

  vaultImportInFlight = true;
  try {
    const result = await importBackupContent({
      content,
      passphrase,
      clearFirst,
    });
    notifyEntriesUpdated();
    return { ok: true, result };
  } finally {
    vaultImportInFlight = false;
  }
}

function isExternalExtensionCaller(
  sender: chrome.runtime.MessageSender
): boolean {
  if (!sender.id || sender.id === chrome.runtime.id) {
    return false;
  }
  const origin =
    (sender as chrome.runtime.MessageSender & { origin?: string }).origin || "";
  if (origin === `chrome-extension://${sender.id}`) {
    return true;
  }
  return (
    typeof sender.url === "string" &&
    sender.url.startsWith(`chrome-extension://${sender.id}/`)
  );
}

function notifyEntriesUpdated() {
  try {
    chrome.runtime.sendMessage({ action: "entriesUpdated" }, () => {
      // No listener is fine: the popup may be closed.
      void chrome.runtime.lastError;
    });
  } catch (error) {
    console.info("[background] entriesUpdated broadcast skipped", error);
  }
}
