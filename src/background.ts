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
import { isChrome, isFirefox } from "./browser";
import {
  DEFAULT_AUTOLOCK_MINUTES,
  UserSettings,
  normalizeAutolock,
} from "./models/settings";
import {
  BiometricCredentialEnrollment,
  finishBiometricCredentialEnrollment,
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

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message: unknown = rawMessage;
  const action =
    isObject(message) && typeof message.action === "string"
      ? message.action
      : "(unknown)";

  if (isObject(message) && "action" in message && message.action === "lock") {
    void chrome.storage.session
      .set({
        cachedPassphrase: null,
        cachedKeyId: null,
        cachedBiometricKeys: null,
        cachedBiometricDefaultKeyId: null,
      })
      .then(
        () => sendResponse({ ok: true }),
        (error: unknown) => {
          console.error("Failed to lock the vault", error);
          sendResponse({ ok: false });
        }
      );
    return true;
  }

  if (isWebDAVRequest(message)) {
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
      console.error("Failed to handle extension message", action, error);
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
    case "dropbox":
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
    if (sender.tab?.id === undefined) return;
    const url = await getCapture(sender.tab);
    sendTabMessage(sender.tab.id, {
      action: "sendCaptureUrl",
      info: { ...message.info, url },
    });
  } else if (message.action === "getTotp") {
    await getTotp(message.info);
  } else if (message.action === "cachePassphrase") {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    ) {
      throw new Error("biometricUnlockInvalidSender");
    }
    await chrome.storage.session.set({
      cachedPassphrase: message.value,
      cachedKeyId: message.keyId,
    });
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
    await syncLocalImportAlarm();
    if (message.enabled) {
      // Do not make the user wait for the first alarm tick.
      void runLocalImportTick().catch((error) =>
        console.info("[background] local import after enable skipped", error)
      );
    }
  } else if (message.action === "setLocalImportInterval") {
    await setLocalImportInterval(message.minutes);
    await syncLocalImportAlarm();
  } else if (message.action === "runWebDAVBackup") {
    await runWebDAVAutoBackup();
    await syncWebDAVBackupAlarm();
  } else if (message.action === "syncWebDAVAlarm") {
    await syncWebDAVBackupAlarm();
  } else if (["dropbox", "drive", "onedrive"].includes(message.action)) {
    getBackupToken(message.action);
  } else if (message.action === "finishBiometricEnrollment") {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    ) {
      console.warn("[background] invalid sender for enrollment", sender.url);
      throw new Error("biometricUnlockInvalidSender");
    }
    const enrollment = parseBiometricEnrollment(message.enrollment);
    if (!enrollment || enrollment.extensionId !== chrome.runtime.id) {
      throw new Error("biometricUnlockInvalidBundle");
    }
    console.info("[background] finishing enrollment", {
      ticket: message.ticket,
      credentialIdLength: enrollment.credentialId.length,
    });
    await finishBiometricCredentialEnrollment(message.ticket, enrollment);
    await setAutolock();
  } else if (message.action === "lock") {
    await chrome.storage.session.set({
      cachedPassphrase: null,
      cachedKeyId: null,
      cachedBiometricKeys: null,
      cachedBiometricDefaultKeyId: null,
    });
  } else if (message.action === "resetAutolock") {
    await chrome.alarms.clear("autolock");
    await setAutolock();
  } else if (message.action === "updateContentTab") {
    contentTab = message.data;
  } else if (message.action === "updateContextMenu") {
    await updateContextMenu();
  }
}

function sendTabMessage(tabId: number, message: unknown) {
  chrome.tabs.sendMessage(tabId, message, () => {
    const error = chrome.runtime.lastError;
    if (!error) {
      return;
    }
    if (contentTab?.id === tabId) {
      contentTab = undefined;
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

let localImportInFlight = false;
async function syncLocalImportAlarm(): Promise<void> {
  if (await isLocalImportEnabled()) {
    chrome.alarms.create(LOCAL_IMPORT_ALARM, {
      periodInMinutes: await getLocalImportInterval(),
    });
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

async function syncWebDAVBackupAlarm(): Promise<void> {
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
 * longer depends on the popup being opened — but it still needs the vault to be
 * unlocked, because the backup is encrypted with the session passphrase.
 */
async function runWebDAVAutoBackup(): Promise<void> {
  if (webdavBackupInFlight) {
    return;
  }
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
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();
  if (!cachedPassphrase) {
    return;
  }

  webdavBackupInFlight = true;
  try {
    const encryption = new Encryption(cachedPassphrase, cachedKeyId);
    const ok = await uploadWebDAVBackup(encryption, config.encrypted !== false);
    if (!ok) {
      return;
    }
    UserSettings.items.webdavLastBackupTime = getClientDay();
    await UserSettings.commitItems();
    await pruneWebDAVBackups(Number(UserSettings.items.webdavMaxBackups || 0));
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
  if (localImportInFlight) {
    if (manual) {
      throw new Error("importInProgress");
    }
    return;
  }

  localImportInFlight = true;
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
    localImportInFlight = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncLocalImportAlarm();
  void syncWebDAVBackupAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  void syncLocalImportAlarm();
  void syncWebDAVBackupAlarm();
});
// Self-heal: if the flag was saved while the worker was asleep and the alarm
// never got created, the next wake-up restores it.
void syncLocalImportAlarm().catch((error) =>
  console.info("[background] local import alarm sync skipped", error)
);
void syncWebDAVBackupAlarm().catch((error) =>
  console.info("[background] WebDAV alarm sync skipped", error)
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
  void chrome.storage.session
    .set({
      cachedPassphrase: null,
      cachedKeyId: null,
      cachedBiometricKeys: null,
      cachedBiometricDefaultKeyId: null,
    })
    .catch((error) =>
      console.error("Failed to clear cached passphrase", error)
    );
  if (contentTab?.id !== undefined) {
    sendTabMessage(contentTab.id, { action: "stopCapture" });
  }
  sendRuntimeMessage({ action: "stopImport" });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (contentTab?.id === tabId) {
    contentTab = undefined;
  }
});

async function getCapture(tab: chrome.tabs.Tab) {
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

async function getTotp(text: string, silent = false): Promise<boolean> {
  const tabId = contentTab?.id;
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

      const results = await Promise.allSettled(
        otpUrls.map((otpUrl) => getTotp(otpUrl, true))
      );
      const failedCount = results.filter(
        (result) => result.status === "rejected" || result.value !== true
      ).length;
      if (failedCount === otpUrls.length) {
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

  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();
  const encryption = new Encryption(cachedPassphrase, cachedKeyId);
  if (
    (await EntryStorage.hasEncryptionKey()) !== encryption.getEncryptionStatus()
  ) {
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
        let hashMatches = url.split("#");
        if (service === "drive") {
          hashMatches = url.slice(0, -1).split("?");
        } else if (service === "onedrive") {
          hashMatches = url.split("?");
        }

        if (hashMatches.length < 2) {
          return;
        }

        const hash = hashMatches[1];

        const resData = hash.split("&");
        for (let i = 0; i < resData.length; i++) {
          const kv = resData[i];
          if (/^(.*?)=(.*?)$/.test(kv)) {
            const kvMatches = kv.match(/^(.*?)=(.*?)$/);
            if (!kvMatches) {
              continue;
            }
            const key = kvMatches[1];
            const value = kvMatches[2];
            if (key === "access_token") {
              if (service === "dropbox") {
                UserSettings.items.dropboxToken = value;
                UserSettings.commitItems();
                uploadBackup("dropbox");
                return;
              }
            } else if (key === "code") {
              if (service === "drive") {
                let success = false;

                const response = await fetch(
                  "https://www.googleapis.com/oauth2/v4/token?client_id=" +
                    getCredentials().drive.client_id +
                    "&client_secret=" +
                    getCredentials().drive.client_secret +
                    "&code=" +
                    value +
                    "&redirect_uri=" +
                    redirUrl +
                    "&grant_type=authorization_code",
                  {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                  }
                );

                try {
                  const res = await response.json();

                  if (res.error) {
                    console.error(res.error_description);
                  } else {
                    UserSettings.items.driveToken = res.access_token;
                    UserSettings.items.driveRefreshToken = res.refresh_token;
                    UserSettings.commitItems();
                    success = true;
                  }
                } catch (error) {
                  console.error(error);
                  throw error;
                }

                uploadBackup("drive");
                return success;
              } else if (service === "onedrive") {
                // Need to trade code we got from launchWebAuthFlow for a
                // token & refresh token
                let success = false;

                const response = await fetch(
                  "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                  {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/x-www-form-urlencoded",
                    },
                  }
                );

                try {
                  const res = await response.json();
                  if (res.error) {
                    console.error(res.error_description);
                  } else {
                    UserSettings.items.oneDriveToken = res.access_token;
                    UserSettings.items.oneDriveRefreshToken = res.refresh_token;
                    UserSettings.commitItems();
                    success = true;
                  }
                } catch (error) {
                  console.error(error);
                  throw error;
                }

                uploadBackup("onedrive");
                return success;
              }
            }
          }
        }

        return;
      }
    );
  }
}

async function uploadBackup(service: string) {
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();
  const encryption = new Encryption(cachedPassphrase, cachedKeyId);

  switch (service) {
    case "dropbox":
      await new Dropbox().upload(encryption);
      break;

    case "drive":
      await new Drive().upload(encryption);
      break;

    case "onedrive":
      await new OneDrive().upload(encryption);
      break;

    default:
      break;
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
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get();

  let tab: chrome.tabs.Tab | undefined;

  switch (command) {
    case "scan-qr":
      if (cachedPassphrase === null || cachedPassphrase === undefined) {
        return;
      }

      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/dist/content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["/css/content.css"],
        });

        contentTab = tab;
        sendTabMessage(tab.id, { action: "capture" });
      }
      break;

    case "autofill":
      tab = await getCurrentTab();
      if (okToInjectContentScript(tab)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/dist/content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["/css/content.css"],
        });

        contentTab = tab;

        const siteName = await getSiteName();
        const entries = await EntryStorage.get();
        const matchedEntries = getMatchedEntries(siteName, entries);

        if (matchedEntries && matchedEntries.length === 1) {
          const entry = matchedEntries[0];
          const encryption = new Encryption(cachedPassphrase, cachedKeyId);
          entry.applyEncryption(encryption);

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

async function updateContextMenu() {
  chrome.permissions.contains(
    {
      permissions: ["contextMenus"],
    },
    (result) => {
      if (result) {
        if (UserSettings.items.enableContextMenu === true) {
          chrome.contextMenus.removeAll();
          chrome.contextMenus.create({
            id: "otpContextMenu",
            title: chrome.i18n.getMessage("extName"),
            contexts: ["all"],
          });
          chrome.contextMenus.onClicked.addListener((info, tab) => {
            let popupUrl = "view/popup.html?popup=true";
            if (tab && tab.url && tab.title) {
              popupUrl +=
                "&url=" +
                encodeURIComponent(tab.url) +
                "&title=" +
                encodeURIComponent(tab.title);
            }
            let windowType;
            if (isFirefox) {
              windowType = "detached_panel";
            } else {
              windowType = "panel";
            }
            chrome.windows.create({
              url: chrome.runtime.getURL(popupUrl),
              type: windowType as chrome.windows.createTypeEnum,
              height: 400,
              width: 320,
            });
          });
        } else {
          chrome.contextMenus.removeAll();
        }
      }
    }
  );
}

updateContextMenu();

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
let externalImportInFlight = false;

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
  if (!isObject(rawMessage) || typeof rawMessage.action !== "string") {
    throw new Error("externalMessageInvalid");
  }

  if (rawMessage.action === "ping") {
    const authorized = await verifyApiToken(rawMessage.token);
    return {
      ok: true,
      name: "Authenticator",
      version: chrome.runtime.getManifest().version,
      apiEnabled: await isApiAccessEnabled(),
      locked: authorized ? await isVaultLocked() : null,
    };
  }

  if (rawMessage.action !== "importBackup") {
    throw new Error("externalActionUnsupported");
  }

  if (!isExternalExtensionCaller(sender)) {
    throw new Error("externalCallerRejected");
  }
  if (!(await isApiAccessEnabled())) {
    throw new Error("externalApiDisabled");
  }
  if (!(await verifyApiToken(rawMessage.token))) {
    throw new Error("externalTokenInvalid");
  }
  if (externalImportInFlight) {
    throw new Error("importInProgress");
  }

  const content =
    typeof rawMessage.content === "string" ? rawMessage.content : "";
  const passphrase =
    typeof rawMessage.passphrase === "string" ? rawMessage.passphrase : null;
  const clearFirst = rawMessage.clearFirst === true;

  externalImportInFlight = true;
  try {
    const result = await importBackupContent({
      content,
      passphrase,
      clearFirst,
    });
    notifyEntriesUpdated();
    return { ok: true, result };
  } finally {
    externalImportInFlight = false;
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
