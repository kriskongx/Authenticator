// Vue
import Vue from "vue";
import Vuex from "vuex";

// Components
import Popup from "./components/Popup.vue";
import CommonComponents from "./components/common/index";

// Other
import { loadI18nMessages } from "./store/i18n";
import { Style } from "./store/Style";
import { Accounts } from "./store/Accounts";
import { Backup } from "./store/Backup";
import { CurrentView } from "./store/CurrentView";
import { Menu } from "./store/Menu";
import { Notification } from "./store/Notification";
import { Qr } from "./store/Qr";
import { Advisor } from "./store/Advisor";
import { Groups } from "./store/Groups";
import { Dropbox, Drive, OneDrive, isVaultLockedError } from "./models/backup";
import type { Encryption } from "./models/encryption";
import {
  getWebDAVConfig,
  getWebDAVOrigin,
  normalizeBackupDay,
} from "./models/webdav";
import type { WebDAVConfig } from "./models/webdav";
import { syncTimeWithGoogle } from "./syncTime";
import { StorageLocation, UserSettings } from "./models/settings";
import {
  clearPopupBlurGrace,
  consumePendingPopupNotification,
  consumePendingPopupReopenView,
  isAutoClosePopupWindow,
  isDetachedPopupWindow,
  isPopupBlurSuppressed,
  POPUP_ANCHOR_STORAGE_KEY,
} from "./models/biometric-unlock";

async function migrateLocalStorageToBrowserStorage() {
  if (localStorage.length > 0) {
    const location =
      (localStorage.storageLocation as StorageLocation) || StorageLocation.Sync;
    await UserSettings.convertFromLocalStorage(localStorage, location);
    localStorage.clear();
  }
}

let popupAnchorCalibrationInstalled = false;

function setupNativePopupAnchorCalibration(): void {
  if (popupAnchorCalibrationInstalled) {
    return;
  }
  popupAnchorCalibrationInstalled = true;
  popupAnchorCalibrationInstalled = true;
  if (isDetachedPopupWindow()) {
    return;
  }

  let anchor: chrome.windows.Window | null = null;
  let calibratedByPointer = false;
  let pendingPointerOrigin: { left: number; top: number } | null = null;

  const saveIfValid = (left: number, top: number) => {
    if (
      !anchor ||
      (anchor.type as string) !== "normal" ||
      anchor.left === undefined ||
      anchor.top === undefined ||
      anchor.width === undefined ||
      anchor.height === undefined
    ) {
      return;
    }
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(top) ||
      left < anchor.left - 40 ||
      left > anchor.left + anchor.width - 80 ||
      top < anchor.top + 20 ||
      top > anchor.top + 260
    ) {
      return;
    }
    const offsetFromRight = Math.round(anchor.left + anchor.width - left);
    const offsetFromTop = Math.round(top - anchor.top);
    if (offsetFromRight < 80 || offsetFromTop < 20) {
      return;
    }
    void chrome.storage.local.set({
      [POPUP_ANCHOR_STORAGE_KEY]: {
        offsetFromRight,
        offsetFromTop,
      },
    });
  };

  // On macOS Chrome, `window.screenX`/`window.screenY` inside a toolbar
  // `default_popup` often returns (0, 0), whereas PointerEvent's `screenX -
  // clientX` and `screenY - clientY` always reflect the exact macOS screen
  // origin of the popup bubble.
  const onPointer = (event: PointerEvent) => {
    if (calibratedByPointer) {
      return;
    }
    if (event.screenX === 0 && event.screenY === 0) {
      return;
    }
    const left = Math.round(event.screenX - event.clientX);
    const top = Math.round(event.screenY - event.clientY);
    if (!anchor) {
      pendingPointerOrigin = { left, top };
      return;
    }
    calibratedByPointer = true;
    window.removeEventListener("pointermove", onPointer, true);
    window.removeEventListener("pointerdown", onPointer, true);
    saveIfValid(left, top);
  };

  window.addEventListener("pointermove", onPointer, {
    capture: true,
    passive: true,
  });
  window.addEventListener("pointerdown", onPointer, {
    capture: true,
    passive: true,
  });

  chrome.windows.getCurrent({}, (win) => {
    if (chrome.runtime.lastError || !win) {
      return;
    }
    anchor = win;
    if (pendingPointerOrigin && !calibratedByPointer) {
      calibratedByPointer = true;
      window.removeEventListener("pointermove", onPointer, true);
      window.removeEventListener("pointerdown", onPointer, true);
      saveIfValid(pendingPointerOrigin.left, pendingPointerOrigin.top);
      return;
    }
    // Also attempt immediate calibration from window.screenX/Y for platforms
    // where Chrome populates it on toolbar popups.
    window.setTimeout(() => {
      if (!calibratedByPointer) {
        saveIfValid(window.screenX, window.screenY);
      }
    }, 60);
  });
}

function setupAutoCloseOnOutsideClick(): void {
  if (!isAutoClosePopupWindow() || !chrome.windows?.onFocusChanged) {
    return;
  }

  let myWindowId: number | undefined;
  let armed = false;
  let blurNoneTimer: number | null = null;

  const clearPendingClose = () => {
    if (blurNoneTimer !== null) {
      window.clearTimeout(blurNoneTimer);
      blurNoneTimer = null;
    }
  };

  const closeIfUnfocused = () => {
    if (!armed || isPopupBlurSuppressed()) {
      return;
    }
    window.close();
  };

  const onFocusChanged = (focusedWindowId: number) => {
    if (myWindowId === undefined) {
      return;
    }
    if (focusedWindowId === myWindowId) {
      armed = true;
      clearPendingClose();
      clearPopupBlurGrace();
      return;
    }
    if (!armed || isPopupBlurSuppressed()) {
      return;
    }
    if (focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
      // User clicked back into Chrome (e.g. blank area of the webpage or
      // another browser window): close immediately like a native toolbar popup.
      clearPendingClose();
      closeIfUnfocused();
      return;
    }
    // Focus left Chrome (could be desktop/another app, or a native macOS
    // select menu / Touch ID sheet just starting). Debounce briefly and verify.
    clearPendingClose();
    blurNoneTimer = window.setTimeout(() => {
      blurNoneTimer = null;
      if (isPopupBlurSuppressed()) {
        return;
      }
      if (document.activeElement?.tagName === "SELECT") {
        return;
      }
      if (myWindowId === undefined) {
        return;
      }
      chrome.windows.get(myWindowId, {}, (win) => {
        if (chrome.runtime.lastError || !win || win.focused) {
          return;
        }
        closeIfUnfocused();
      });
    }, 120);
  };

  chrome.windows.onFocusChanged.addListener(onFocusChanged);
  window.addEventListener("pagehide", () => {
    clearPendingClose();
    chrome.windows.onFocusChanged.removeListener(onFocusChanged);
  });

  chrome.windows.getCurrent({}, (win) => {
    if (chrome.runtime.lastError || win?.id === undefined) {
      return;
    }
    myWindowId = win.id;
    if (win.focused) {
      armed = true;
    } else {
      window.setTimeout(() => {
        armed = true;
      }, 500);
    }
  });
}

async function init() {
  setupAutoCloseOnOutsideClick();
  // Keep a lightweight port open from the toolbar popup so the background
  // service worker sees the exact moment macOS Chrome dismisses the popup
  // after a Touch ID prompt.
  if (!isDetachedPopupWindow()) {
    setupNativePopupAnchorCalibration();
    try {
      const lifecyclePort = chrome.runtime.connect({ name: "popup-lifecycle" });
      window.addEventListener("pagehide", () => {
        try {
          lifecyclePort.disconnect();
        } catch {
          // Ignore already disconnected port
        }
      });
    } catch {
      // Ignore outside extension context
    }
  }

  await migrateLocalStorageToBrowserStorage();
  await UserSettings.updateItems();

  // Add globals
  Vue.prototype.i18n = await loadI18nMessages();

  // Load modules
  Vue.use(Vuex);

  // Load common components globally
  for (const component of CommonComponents) {
    Vue.component(component.name, component.component);
  }

  const [
    accountsModule,
    advisorModule,
    backupModule,
    groupsModule,
    menuModule,
  ] = await Promise.all([
    new Accounts().getModule(),
    new Advisor().getModule(),
    new Backup().getModule(),
    new Groups().getModule(),
    new Menu().getModule(),
  ]);

  // State
  const store = new Vuex.Store({
    modules: {
      accounts: accountsModule,
      advisor: advisorModule,
      backup: backupModule,
      currentView: new CurrentView().getModule(),
      groups: groupsModule,
      menu: menuModule,
      notification: new Notification().getModule(),
      qr: new Qr().getModule(),
      style: new Style().getModule(),
    },
  });

  // Render
  const instance = new Vue({
    render: (h) => h(Popup),
    store,
    mounted() {
      // Update time based entries' codes
      this.$store.commit("accounts/updateCodes");
      setInterval(() => {
        this.$store.commit("accounts/updateCodes");
      }, 1000);
    },
  }).$mount("#authenticator");

  // Prompt for password if needed
  if (instance.$store.state.accounts.shouldShowPassphrase) {
    // If we have cached password, use that
    if (instance.$store.state.accounts.defaultEncryption) {
      instance.$store.commit("currentView/changeView", "LoadingPage");
      await instance.$store.dispatch("accounts/updateEntries");
    } else {
      instance.$store.commit("style/showInfo", true);
      instance.$store.commit("currentView/changeView", "EnterPasswordPage");
    }
  } else {
    // Set init complete if no encryption is present, otherwise this will be set in updateEntries.
    instance.$store.commit("accounts/initComplete");
  }

  if (
    !instance.$store.getters["accounts/currentlyEncrypted"] &&
    instance.$store.state.currentView.view !== "EnterPasswordPage"
  ) {
    const [pendingReopenView, pendingNotificationKey] = await Promise.all([
      consumePendingPopupReopenView().catch(() => null),
      consumePendingPopupNotification().catch(() => null),
    ]);
    if (pendingReopenView === "SetPasswordPage") {
      instance.$store.commit("style/showInfo", true);
      instance.$store.commit("currentView/changeView", "SetPasswordPage");
    }
    if (pendingNotificationKey) {
      const i18nMap = (instance.i18n as unknown) as Record<string, string>;
      const notice = i18nMap[pendingNotificationKey];
      if (notice) {
        instance.$store.commit("notification/alert", notice);
      }
    }
  }

  // Auto focus on first entry
  document.querySelector<HTMLElement>(".entry[tabindex='0']")?.focus();

  // Set document title
  try {
    document.title = instance.i18n.extName;
  } catch (e) {
    console.error(e);
  }

  // Warn if legacy password is set
  if (UserSettings.items.encodedPhrase) {
    instance.$store.commit(
      "notification/alert",
      instance.i18n.local_passphrase_warning
    );
  }

  // Backup reminder / run backup
  const backupReminder = setInterval(async () => {
    if (instance.$store.state.accounts.entries.length === 0) {
      return;
    }

    if (instance.$store.getters["accounts/currentlyEncrypted"]) {
      return;
    }

    clearInterval(backupReminder);

    const clientTime = Math.floor(new Date().getTime() / 1000 / 3600 / 24);
    let webdavAutoConfig: WebDAVAutoConfig | null = null;
    try {
      webdavAutoConfig = await getWebDAVAutoConfig();
    } catch (error) {
      console.error("Unable to read WebDAV auto-backup settings", error);
    }
    if (webdavAutoConfig) {
      window.setTimeout(() => {
        // The worker owns the upload so the schedule also runs without the popup.
        chrome.runtime.sendMessage({ action: "runWebDAVBackup" }, () => {
          void chrome.runtime.lastError;
        });
      }, 2000);
    }

    if (!UserSettings.items.lastRemindingBackupTime) {
      UserSettings.items.lastRemindingBackupTime = clientTime;
      UserSettings.commitItems();
    } else if (
      clientTime - Number(UserSettings.items.lastRemindingBackupTime) >= 30 ||
      clientTime - Number(UserSettings.items.lastRemindingBackupTime) < 0
    ) {
      runScheduledBackup(clientTime, instance, Boolean(webdavAutoConfig));
    }
    return;
  }, 5000);

  // Open search if '/' is pressed
  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (
        instance.$store.getters["style/isMenuShown"] ||
        instance.$store.state.style.style.cloudRestoreOpen ||
        instance.$store.state.notification.message.length > 0 ||
        instance.$store.state.notification.confirmMessage !== ""
      ) {
        return;
      }
      instance.$store.commit("accounts/stopFilter");
      // It won't focus the texfield if vue unhides the div
      instance.$store.commit("accounts/showSearch");
      const searchDiv = document.getElementById("search");
      const searchInput = document.getElementById("searchInput");
      if (!searchInput || !searchDiv) {
        return;
      }
      searchDiv.style.display = "block";
      searchInput.focus();
    },
    false
  );

  // Show search box if more than 10 entries
  if (
    instance.$store.state.accounts.entries.length >= 10 &&
    !(
      instance.$store.getters["accounts/shouldFilter"] &&
      instance.$store.state.accounts.filter
    )
  ) {
    instance.$store.commit("accounts/showSearch");
  }

  const query = new URLSearchParams(document.location.search.substring(1));
  // Resize window to proper size if popup
  if (query.get("popup")) {
    const zoom = Number(UserSettings.items.zoom) / 100 || 1;
    const correctHeight = 480 * zoom;
    const correctWidth = 320 * zoom;
    if (
      window.innerHeight !== correctHeight ||
      window.innerWidth !== correctWidth
    ) {
      // window update to correct size
      const adjustedHeight = Math.round(
        correctHeight + (window.outerHeight - window.innerHeight)
      );
      const adjustedWidth = Math.round(
        correctWidth + (window.outerWidth - window.innerWidth)
      );
      chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, {
        height: adjustedHeight,
        width: adjustedWidth,
      });
    }
  }

  // TODO: give an option for this
  chrome.permissions.contains(
    { origins: ["https://www.google.com/"] },
    (hasPermission) => {
      if (hasPermission) {
        syncTimeWithGoogle();
      }
    }
  );
}

init();

type ScheduledBackupProvider = {
  label: string;
  origins: string[];
  hasToken: () => boolean;
  upload: (encryption: Encryption) => Promise<boolean>;
  markRevoked: () => void;
};

/**
 * Tries every configured cloud provider once. A failing provider is logged and
 * reported, never silently treated as "nothing to back up".
 */
async function runScheduledBackup(
  clientTime: number,
  instance: Vue,
  hasWebDAVAutoConfig: boolean
) {
  const encryption = instance.$store.state.accounts.encryption.get(
    instance.$store.state.accounts.defaultEncryption
  );
  const providers: ScheduledBackupProvider[] = [
    {
      label: "Dropbox",
      origins: ["https://*.dropboxapi.com/*"],
      hasToken: () => Boolean(instance.$store.state.backup.dropboxToken),
      upload: (enc) => new Dropbox().upload(enc),
      markRevoked: () => {
        UserSettings.items.dropboxRevoked = undefined;
        void UserSettings.removeItem("dropboxRevoked");
      },
    },
    {
      label: "Google Drive",
      origins: [
        "https://www.googleapis.com/*",
        "https://accounts.google.com/o/oauth2/revoke",
      ],
      hasToken: () => Boolean(instance.$store.state.backup.driveToken),
      upload: (enc) => new Drive().upload(enc),
      markRevoked: () => {
        UserSettings.items.driveRevoked = undefined;
        void UserSettings.removeItem("driveRevoked");
      },
    },
    {
      label: "OneDrive",
      origins: [
        "https://graph.microsoft.com/me/*",
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      ],
      hasToken: () => Boolean(instance.$store.state.backup.oneDriveToken),
      upload: (enc) => new OneDrive().upload(enc),
      markRevoked: () => {
        UserSettings.items.oneDriveRevoked = undefined;
        void UserSettings.removeItem("oneDriveRevoked");
      },
    },
  ];

  let uploaded = false;
  let locked = false;

  for (const provider of providers) {
    if (!provider.hasToken()) {
      continue;
    }
    if (!(await hasOriginPermission(provider.origins))) {
      console.info(
        `[popup] Skipping ${provider.label} backup: origin permission missing`
      );
      continue;
    }
    try {
      if (await provider.upload(encryption)) {
        uploaded = true;
        continue;
      }
      if (
        (provider.label === "Dropbox" &&
          UserSettings.items.dropboxRevoked === true) ||
        (provider.label === "Google Drive" &&
          UserSettings.items.driveRevoked === true) ||
        (provider.label === "OneDrive" &&
          UserSettings.items.oneDriveRevoked === true)
      ) {
        instance.$store.commit(
          "notification/alert",
          chrome.i18n.getMessage("token_revoked", [provider.label])
        );
        provider.markRevoked();
        UserSettings.commitItems();
      } else {
        console.warn(`[popup] ${provider.label} backup returned no result`);
      }
    } catch (error) {
      console.error(`[popup] ${provider.label} backup failed`, error);
      if (isVaultLockedError(error)) {
        locked = true;
      }
    }
  }

  if (uploaded) {
    UserSettings.items.lastRemindingBackupTime = clientTime;
    await UserSettings.commitItems();
    return;
  }
  if (locked) {
    // Nothing else will succeed while the vault is locked: say so instead of
    // nagging the user to "back up now".
    instance.$store.commit(
      "notification/alert",
      instance.i18n.backup_failed_locked
    );
    UserSettings.items.lastRemindingBackupTime = clientTime;
    await UserSettings.commitItems();
    return;
  }
  if (!hasWebDAVAutoConfig) {
    instance.$store.commit("notification/alert", instance.i18n.remind_backup);
    UserSettings.items.lastRemindingBackupTime = clientTime;
    await UserSettings.commitItems();
  }
}

type WebDAVAutoConfig = {
  config: WebDAVConfig;
  lastBackupDay: number;
  maxBackups: number;
};

async function getWebDAVAutoConfig(): Promise<WebDAVAutoConfig | null> {
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
  const hasPermission = await hasOriginPermission(origin);
  if (!hasPermission) {
    return null;
  }
  return {
    config,
    lastBackupDay: normalizeBackupDay(UserSettings.items.webdavLastBackupTime),
    maxBackups: Number(UserSettings.items.webdavMaxBackups || 0),
  };
}

function hasOriginPermission(origins: string | string[]): Promise<boolean> {
  const list = Array.isArray(origins) ? origins : [origins];
  return new Promise((resolve) => {
    if (!list.length || list.some((origin) => !origin)) {
      resolve(false);
      return;
    }
    chrome.permissions.contains({ origins: list }, (result) => {
      resolve(Boolean(result));
    });
  });
}
