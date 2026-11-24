export enum StorageLocation {
  Sync = "sync",
  Local = "local",
}

interface UserSettingsData {
  // local settings
  driveEncrypted?: boolean;
  driveFolder?: string;
  driveRefreshToken?: string;
  driveRevoked?: boolean;
  driveToken?: string;
  dropboxEncrypted?: boolean;
  dropboxRevoked?: boolean;
  dropboxToken?: string;
  lastRemindingBackupTime?: number;
  offset?: number;
  oneDriveBusiness?: boolean;
  oneDriveEncrypted?: boolean;
  oneDriveRevoked?: boolean;
  oneDriveRefreshToken?: string;
  oneDriveToken?: string;
  webdavUrl?: string;
  webdavUsername?: string;
  webdavPassword?: string;
  webdavEncrypted?: boolean;
  webdavAutoBackup?: boolean;
  /** Day ordinal (local calendar day) the schedule counts from. */
  webdavLastBackupTime?: number;
  /** Millisecond timestamp of the last *automatic* upload, for display only. */
  webdavLastAutoBackupAt?: number;
  webdavClearBeforeRestore?: boolean;
  webdavMaxBackups?: number;
  webdavBackupIntervalDays?: number;
  webdavBackupHour?: number;
  storageLocation?: StorageLocation;

  // syncable settings
  advisorIgnoreList?: string[];
  autofill?: boolean;
  autolock?: number;
  enableContextMenu?: boolean;
  encodedPhrase?: string;
  smartFilter?: boolean;
  theme?: string;
  zoom?: number;
}

export const DEFAULT_AUTOLOCK_MINUTES = 30;

/**
 * `0` means "never auto-lock" and must survive the round trip; a truthiness
 * fallback (`Number(x) || 30`) would silently turn it back into 30 on reload.
 * An empty value is "not set yet", not "never": `Number("")` is 0.
 */
export function normalizeAutolock(value: unknown): number {
  if (value === "" || value === null || value === undefined) {
    return DEFAULT_AUTOLOCK_MINUTES;
  }
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return DEFAULT_AUTOLOCK_MINUTES;
  }
  return Math.floor(minutes);
}

// Maybe we can have a better way to define this
const LocalUserSettingsDataKeys = [
  "driveEncrypted",
  "driveFolder",
  "driveRefreshToken",
  "driveRevoked",
  "driveToken",
  "dropboxEncrypted",
  "dropboxRevoked",
  "dropboxToken",
  "lastRemindingBackupTime",
  "offset",
  "oneDriveBusiness",
  "oneDriveEncrypted",
  "oneDriveRevoked",
  "oneDriveRefreshToken",
  "oneDriveToken",
  "webdavUrl",
  "webdavUsername",
  "webdavPassword",
  "webdavEncrypted",
  "webdavAutoBackup",
  "webdavLastBackupTime",
  "webdavLastAutoBackupAt",
  "webdavClearBeforeRestore",
  "webdavMaxBackups",
  "webdavBackupIntervalDays",
  "webdavBackupHour",
  "storageLocation",
];

// Kept local to avoid a settings <-> webdav import cycle.
const DAY_MS = 24 * 60 * 60 * 1000;

export class UserSettings {
  static items: UserSettingsData = {};

  static async updateItems() {
    UserSettings.items = await UserSettings.getAllItems();
    if (UserSettings.migrateLegacyValues(UserSettings.items)) {
      await UserSettings.commitItems();
    }
  }

  /**
   * Fixes values written by older builds. Idempotent: once converted the check
   * no longer matches, so this is a no-op on every later load.
   */
  private static migrateLegacyValues(items: UserSettingsData): boolean {
    let changed = false;
    const lastBackup = Number(items.webdavLastBackupTime);
    if (Number.isFinite(lastBackup) && lastBackup > 1e11) {
      // An early build stored milliseconds here; the schedule works in days.
      items.webdavLastBackupTime = Math.floor(lastBackup / DAY_MS);
      changed = true;
    }
    return changed;
  }

  static async convertFromLocalStorage(
    data: Storage,
    location: StorageLocation
  ) {
    const settings: UserSettingsData = {};

    for (const key in data) {
      if (isBooleanOption(key)) {
        settings[key] = data[key] === "true";
      } else if (isNumberOption(key)) {
        settings[key] = Number(data[key]);
      } else if (isJSONOption(key)) {
        settings[key] = JSON.parse(data[key]);
      } else {
        settings[key as keyof UserSettingsData] = data[key];
      }
    }

    settings.storageLocation = location;
    UserSettings.items = settings;
    await UserSettings.commitItems();
  }

  static async commitItems() {
    const storageLocation =
      UserSettings.items.storageLocation || StorageLocation.Local;

    if (storageLocation === StorageLocation.Local) {
      await chrome.storage[storageLocation].set({
        // JSON.parse(JSON.stringify()) strips functions (e.g. getItem, setItem, ...) which may have been added to the object.
        // Without this, a crash may occur as chrome.storage throws an error when trying to serialize a function.
        UserSettings: JSON.parse(JSON.stringify(UserSettings.items)),
      });
    } else {
      const { syncableSettings, localSettings } = UserSettings.splitSettings(
        UserSettings.items
      );

      await Promise.all([
        chrome.storage[StorageLocation.Local].set({
          UserSettings: JSON.parse(JSON.stringify(localSettings)),
        }),
        chrome.storage[StorageLocation.Sync].set({
          UserSettings: JSON.parse(JSON.stringify(syncableSettings)),
        }),
      ]);
    }

    await UserSettings.updateItems();
  }

  static async removeItem(key: keyof UserSettingsData) {
    // Merge over the stored snapshot so edits made in this context (but not
    // committed yet) are not thrown away by the write-back below.
    const allItems = {
      ...(await UserSettings.getAllItems()),
      ...UserSettings.items,
    };
    delete allItems[key];

    UserSettings.items = allItems;

    await UserSettings.commitItems();
  }

  private static async getStorageData(location: StorageLocation) {
    const storageData: UserSettingsData =
      (await chrome.storage[location].get("UserSettings"))?.UserSettings || {};

    return storageData;
  }

  private static splitSettings(storageData: UserSettingsData) {
    const syncableSettings: UserSettingsData = Object.assign({}, storageData);
    const localSettings: UserSettingsData = Object.assign({}, storageData);

    let key: keyof UserSettingsData;
    for (key in storageData) {
      if (LocalUserSettingsDataKeys.includes(key)) {
        delete syncableSettings[key];
      } else {
        delete localSettings[key];
      }
    }

    return {
      syncableSettings,
      localSettings,
    };
  }

  private static async getAllItems() {
    const localSettings = await UserSettings.getStorageData(
      StorageLocation.Local
    );
    const storageLocation =
      localSettings.storageLocation || StorageLocation.Local;

    if (storageLocation === StorageLocation.Local) {
      return localSettings;
    }

    const syncableSettings = await UserSettings.getStorageData(
      StorageLocation.Sync
    );
    return { ...syncableSettings, ...localSettings };
  }
}

type BooleanOption =
  | "autofill"
  | "driveEncrypted"
  | "driveRevoked"
  | "dropboxEncrypted"
  | "dropboxRevoked"
  | "enableContextMenu"
  | "oneDriveBusiness"
  | "oneDriveEncrypted"
  | "oneDriveRevoked"
  | "smartFilter"
  | "webdavEncrypted"
  | "webdavAutoBackup"
  | "webdavClearBeforeRestore";

type NumberOption =
  | "autolock"
  | "lastRemindingBackupTime"
  | "offset"
  | "zoom"
  | "webdavLastBackupTime"
  | "webdavLastAutoBackupAt"
  | "webdavMaxBackups"
  | "webdavBackupIntervalDays"
  | "webdavBackupHour";

type JSONOption = "advisorIgnoreList";

function isBooleanOption(key: string): key is BooleanOption {
  return [
    "autofill",
    "driveEncrypted",
    "driveRevoked",
    "dropboxEncrypted",
    "dropboxRevoked",
    "enableContextMenu",
    "oneDriveBusiness",
    "oneDriveEncrypted",
    "oneDriveRevoked",
    "smartFilter",
    "webdavEncrypted",
    "webdavAutoBackup",
    "webdavClearBeforeRestore",
  ].includes(key);
}

function isNumberOption(key: string): key is NumberOption {
  return [
    "autolock",
    "lastRemindingBackupTime",
    "offset",
    "zoom",
    "webdavLastBackupTime",
    "webdavLastAutoBackupAt",
    "webdavMaxBackups",
    "webdavBackupIntervalDays",
    "webdavBackupHour",
  ].includes(key);
}

function isJSONOption(key: string): key is JSONOption {
  return ["advisorIgnoreList"].includes(key);
}
