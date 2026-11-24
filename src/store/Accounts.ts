import { EntryStorage, BrowserStorage, isOldKey } from "../models/storage";
import { Encryption } from "../models/encryption";
import AES from "crypto-js/aes";
import {
  OTPType,
  OTPAlgorithm,
  OTPEntry,
  regenerateLegacyEntryHash,
} from "../models/otp";
import { ActionContext } from "vuex";
import { getSiteName, getMatchedEntriesHash } from "../utils";
import { isChromium } from "../browser";
import { StorageLocation, UserSettings } from "../models/settings";
import { DataType } from "../models/otp";
import { argonHash, argonVerify } from "../models/password";
import { invalidateBiometricUnlock } from "../models/biometric-unlock";
const LegacyEncryption = "LegacyEncryption";
export class Accounts implements Module {
  async getModule() {
    const cachedKeyInfo = await this.getCachedKeyInfo();
    const encryption: Map<string, EncryptionInterface> = new Map();
    const biometricKeys = await this.getCachedBiometricKeys();
    for (const [id, encryptionKey] of biometricKeys) {
      encryption.set(id, encryptionKey);
    }
    if (cachedKeyInfo.cachedKeyId) {
      encryption.set(
        cachedKeyInfo.cachedKeyId,
        new Encryption(
          cachedKeyInfo.cachedPassphrase,
          cachedKeyInfo.cachedKeyId
        )
      );
    }
    const shouldShowPassphrase = await EntryStorage.hasEncryptionKey();
    const entries = shouldShowPassphrase ? [] : await this.getEntries();

    await UserSettings.updateItems();

    return {
      state: {
        entries,
        biometricKeys,
        encryption,
        defaultEncryption: cachedKeyInfo.cachedKeyId || "",
        OTPType,
        OTPAlgorithm,
        shouldShowPassphrase,
        sectorStart: false, // Should display timer circles?
        sectorOffset: 0, // Offset in seconds for animations
        second: 0, // Offset in seconds for math
        filter: true,
        siteName: await getSiteName(),
        showSearch: false,
        exportData: {},
        exportEncData: {},
        keys: [],
        wrongPassword: false,
        unresolvedKeyCount: 0,
        initComplete: false,
      },
      getters: {
        shouldFilter(
          state: AccountsState,
          getters: { matchedEntries: string[] },
          rootState: object
        ) {
          const menuState = (rootState as { menu?: MenuState } | undefined)
            ?.menu;
          const smartFilter =
            menuState !== undefined
              ? menuState.smartFilter === true
              : UserSettings.items.smartFilter === true;
          return smartFilter && getters.matchedEntries.length;
        },
        matchedEntries: (state: AccountsState) => {
          return getMatchedEntriesHash(state.siteName, state.entries);
        },
        /**
         * Encryption for the active master key. Never null: callers that only
         * need "an object to hand to export" get an empty one when locked.
         */
        activeEncryption(state: AccountsState): Encryption {
          const keyId = state.defaultEncryption;
          if (!keyId) {
            return new Encryption("", "");
          }
          // The map stores the interface type; every implementation is an
          // Encryption instance (see accounts/updateEncryption).
          return (
            ((state.encryption.get(keyId) as unknown) as Encryption) ||
            new Encryption("", "")
          );
        },
        currentlyEncrypted(state: AccountsState) {
          for (const entry of state.entries) {
            if (entry.secret === null) {
              return true;
            }
          }
          return false;
        },
        entries(state: AccountsState) {
          const pinnedEntries = state.entries.filter((entry) => entry.pinned);
          const unpinnedEntries = state.entries.filter(
            (entry) => !entry.pinned
          );
          return [...pinnedEntries, ...unpinnedEntries];
        },
      },
      mutations: {
        stopFilter(state: AccountsState) {
          state.filter = false;
        },
        showSearch(state: AccountsState) {
          state.showSearch = true;
        },
        updateCodes(state: AccountsState) {
          let second = new Date().getSeconds();
          if (UserSettings.items.offset) {
            // prevent second from negative
            second += Number(UserSettings.items.offset) + 60;
          }

          second = second % 60;
          state.second = second;

          let currentlyEncrypted = false;

          for (const entry of state.entries) {
            if (entry.secret === null) {
              currentlyEncrypted = true;
            }
          }

          if (
            !state.sectorStart &&
            state.entries.length > 0 &&
            !currentlyEncrypted
          ) {
            state.sectorStart = true;
            state.sectorOffset = -second;
          }

          // if (second > 25) {
          //   app.class.timeout = true;
          // } else {
          //   app.class.timeout = false;
          // }
          // if (second < 1) {
          //   const entries = app.entries as OTP[];
          //   for (let i = 0; i < entries.length; i++) {
          //     if (entries[i].type !== OTPType.hotp &&
          //         entries[i].type !== OTPType.hhex) {
          //       entries[i].generate();
          //     }
          //   }
          // }
          const entries = state.entries as OTPEntryInterface[];
          for (let i = 0; i < entries.length; i++) {
            if (
              entries[i].type !== OTPType.hotp &&
              entries[i].type !== OTPType.hhex
            ) {
              entries[i].generate();
            }
          }
        },
        loadCodes(state: AccountsState, newCodes: OTPEntryInterface[]) {
          state.entries = newCodes;
        },
        applyCachedKeys(
          state: AccountsState,
          payload: {
            keys: { id: string; secret: string }[];
            defaultKeyId: string;
          }
        ) {
          const biometricKeys = new Map<string, EncryptionInterface>();
          for (const key of payload.keys) {
            const encryption = new Encryption(key.secret, key.id);
            state.encryption.set(key.id, encryption);
            biometricKeys.set(key.id, encryption);
          }
          if (biometricKeys.size > 0) {
            state.biometricKeys = biometricKeys;
          }
          if (payload.defaultKeyId) {
            state.defaultEncryption = payload.defaultKeyId;
          }
        },
        pinEntry(state: AccountsState, entry: OTPEntryInterface) {
          const target = state.entries.find((item) => item.hash === entry.hash);
          if (target) {
            target.pinned = !target.pinned;
          }
        },
        updateExport(
          state: AccountsState,
          exportData: { [k: string]: OTPEntryInterface }
        ) {
          state.exportData = exportData;
        },
        updateEncExport(
          state: AccountsState,
          data: {
            entries: { [k: string]: OTPEntryInterface };
            keys: Key[] | OldKey;
          }
        ) {
          if (isOldKey(data.keys)) {
            return;
          }

          const keys = data.keys.reduce((prev: { [id: string]: Key }, key) => {
            prev[key.id] = key;
            return prev;
          }, {});
          state.exportEncData = { ...data.entries, ...keys };
        },
        wrongPassword(state: AccountsState) {
          state.wrongPassword = true;
        },
        setWrongPassword(state: AccountsState, wrongPassword: boolean) {
          state.wrongPassword = wrongPassword;
        },
        setUnresolvedKeyCount(state: AccountsState, count: number) {
          state.unresolvedKeyCount = count;
        },
        initComplete(state: AccountsState) {
          state.initComplete = true;
        },
      },
      actions: {
        deleteCode: async (
          state: ActionContext<AccountsState, object>,
          hash: string
        ) => {
          const index = state.state.entries.findIndex(
            (entry) => entry.hash === hash
          );
          if (index > -1) {
            state.state.entries.splice(index, 1);
          }
          state.state.entries.forEach((entry, entryIndex) => {
            entry.index = entryIndex;
          });
          state.commit(
            "updateExport",
            await EntryStorage.getExport(state.state.entries)
          );
          state.commit("updateEncExport", {
            entries: await EntryStorage.getExport(state.state.entries, true),
            keys: await BrowserStorage.getKeys(),
          });
        },
        batchDeleteCode: async (
          state: ActionContext<AccountsState, object>,
          hashes: string[]
        ) => {
          const hashSet = new Set(hashes);
          for (let i = state.state.entries.length - 1; i >= 0; i--) {
            if (hashSet.has(state.state.entries[i].hash)) {
              state.state.entries.splice(i, 1);
            }
          }
          state.state.entries.forEach((entry, index) => {
            entry.index = index;
          });
          state.commit(
            "updateExport",
            await EntryStorage.getExport(state.state.entries)
          );
          state.commit("updateEncExport", {
            entries: await EntryStorage.getExport(state.state.entries, true),
            keys: await BrowserStorage.getKeys(),
          });
        },
        assignGroupBatch: async (
          state: ActionContext<AccountsState, object>,
          args: { hashes: string[]; groupId?: string }
        ) => {
          const hashSet = new Set(args.hashes);
          const changedEntries: OTPEntry[] = [];
          const previousGroupIds = new Map<OTPEntry, string | undefined>();
          for (const entry of state.state.entries) {
            if (hashSet.has(entry.hash) && entry.groupId !== args.groupId) {
              const otpEntry = entry as OTPEntry;
              previousGroupIds.set(otpEntry, otpEntry.groupId);
              otpEntry.groupId = args.groupId;
              changedEntries.push(otpEntry);
            }
          }

          if (changedEntries.length) {
            try {
              await EntryStorage.updateMany(changedEntries);
              await state.dispatch("updateEntries");
            } catch (error) {
              for (const [otpEntry, previousGroupId] of previousGroupIds) {
                otpEntry.groupId = previousGroupId;
              }
              throw error;
            }
          }
        },
        lockVault: async (state: ActionContext<AccountsState, object>) => {
          state.state.encryption.clear();
          state.state.defaultEncryption = "";
          state.state.exportData = {};
          state.state.exportEncData = {};
          state.commit("setWrongPassword", false);
          await state.dispatch("updateEntries");
        },
        addCode: async (
          state: ActionContext<AccountsState, object>,
          entry: OTPEntryInterface
        ) => {
          state.state.entries.unshift(entry);
          state.state.entries.forEach((item, index) => {
            item.index = index;
          });
          state.commit(
            "updateExport",
            await EntryStorage.getExport(state.state.entries)
          );
          state.commit("updateEncExport", {
            entries: await EntryStorage.getExport(state.state.entries, true),
            keys: await BrowserStorage.getKeys(),
          });
        },
        applyPassphrase: async (
          state: ActionContext<AccountsState, object>,
          password: string
        ) => {
          if (!password) {
            return;
          }

          state.commit("setWrongPassword", false);
          state.commit("currentView/changeView", "LoadingPage", { root: true });

          try {
            // Decrypt entries
            let saltedHash = "";
            let migrationNeeded = false;
            const encKeys = await BrowserStorage.getKeys();
            if (isOldKey(encKeys)) {
              // --- handle v2 encryption
              // decrypt using key
              const key = AES.decrypt(encKeys.enc, password).toString();
              const isCorrectPassword = await argonVerify(key, encKeys.hash);

              if (!isCorrectPassword) {
                state.commit("setWrongPassword", true);
                state.commit("currentView/changeView", "EnterPasswordPage", {
                  root: true,
                });
                return;
              }

              state.state.encryption.set(
                LegacyEncryption,
                new Encryption(key, LegacyEncryption)
              );

              migrationNeeded = true;
            } else if (encKeys.length === 0) {
              // --- handle v1 encryption
              // verify current password
              state.state.encryption.set(
                LegacyEncryption,
                new Encryption(password, LegacyEncryption)
              );
              await state.dispatch("updateEntries");

              if (state.getters.currentlyEncrypted) {
                state.commit("setWrongPassword", true);
                state.commit("currentView/changeView", "EnterPasswordPage", {
                  root: true,
                });
                return;
              }

              migrationNeeded = true;
            } else {
              // --- handle v3 encryption
              for (const key of encKeys) {
                const rawHash = await argonHash(password, key.salt);
                if (!rawHash) {
                  throw new Error("argon2 did not return a hash!");
                }

                // https://passlib.readthedocs.io/en/stable/lib/passlib.hash.argon2.html#format-algorithm
                const possibleHash = rawHash.split("$")[5];
                if (!possibleHash) {
                  throw new Error("argon2 did not return a hash!");
                }

                // verify user password by comparing their password hash with the
                // hash of their password's hash
                const isCorrectPassword = await argonVerify(
                  possibleHash,
                  key.hash
                );

                if (isCorrectPassword) {
                  state.state.encryption.set(
                    key.id,
                    new Encryption(possibleHash, key.id)
                  );
                  state.state.defaultEncryption = key.id;

                  saltedHash = possibleHash;
                }
              }

              await state.dispatch("updateEntries");

              if (!saltedHash) {
                state.commit("setWrongPassword", true);
                state.commit("currentView/changeView", "EnterPasswordPage", {
                  root: true,
                });
                return;
              }
            }

            // Migrate from older encryption if needed
            if (migrationNeeded) {
              // gen hashes

              // The hash of the user's password is used as the encryption key for user data.
              const rawSaltedHash = await genHash(password);
              // https://passlib.readthedocs.io/en/stable/lib/passlib.hash.argon2.html#format-algorithm
              const salt = window.atob(rawSaltedHash.split("$")[4]);
              saltedHash = rawSaltedHash.split("$")[5];

              // This hash is used to verify that a user decrypted `saltedHash` correctly
              const hashOfHash = await genHash(saltedHash);

              if (!saltedHash || !hashOfHash) {
                throw new Error("argon2 did not return a hash!");
              }

              // update entry encryption
              const key: Key = {
                dataType: DataType.Key,
                id: crypto.randomUUID(),
                salt: salt,
                hash: hashOfHash,
                version: 3,
              };
              const newEncryption = new Encryption(saltedHash, key.id);
              state.state.encryption.set(key.id, newEncryption);
              state.state.defaultEncryption = key.id;

              const toRemove: string[] = [];
              for (const entry of state.state.entries) {
                if (!entry.secret) {
                  continue;
                }

                await entry.changeEncryption(newEncryption);

                const previousHash = regenerateLegacyEntryHash(entry);
                if (previousHash) {
                  toRemove.push(previousHash);
                }
              }

              // store key
              await BrowserStorage.set({
                [key.id]: key,
              });
              await EntryStorage.set(state.state.entries);
              await BrowserStorage.remove(toRemove);
              await BrowserStorage.remove("key");

              await state.dispatch("updateEntries");
            }

            if (!saltedHash) {
              throw new Error("Empty saltedHash! This should never happen.");
            }

            // Encrypt any unencrypted entries.
            // Browser sync can cause unencrypted entries to show up.
            let needUpdateStorage = false;
            const defaultEncryption = state.state.encryption.get(
              state.state.defaultEncryption
            );
            if (!defaultEncryption) {
              throw new Error(
                "defaultEncryption is empty, this should never happen!"
              );
            }
            for (const entry of state.state.entries) {
              if (
                entry.encryption?.getEncryptionKeyId() !==
                state.state.defaultEncryption
              ) {
                await entry.changeEncryption(defaultEncryption);
                needUpdateStorage = true;
              }
            }

            if (needUpdateStorage) {
              await EntryStorage.set(state.state.entries);
              await state.dispatch("updateEntries");
            }

            const unresolvedKeyIds = getUnresolvedEncryptionKeyIds(
              state.state.entries
            );
            state.commit("setUnresolvedKeyCount", unresolvedKeyIds.size);
            if (unresolvedKeyIds.size > 0) {
              state.commit("currentView/changeView", "EnterPasswordPage", {
                root: true,
              });
              return;
            }

            if (!isOldKey(encKeys) && state.state.entries.length > 0) {
              const linkedKeyIds = new Set(
                state.state.entries
                  .map((entry) => entry.encryption?.getEncryptionKeyId())
                  .filter((keyId): keyId is string => Boolean(keyId))
              );
              const unlinkedKeyIds = encKeys
                .map((key) => key.id)
                .filter((keyId) => !linkedKeyIds.has(keyId));
              if (unlinkedKeyIds.length) {
                await BrowserStorage.remove(unlinkedKeyIds);
                for (const keyId of unlinkedKeyIds) {
                  state.state.encryption.delete(keyId);
                }
              }
            }

            if (!state.getters.currentlyEncrypted) {
              chrome.runtime.sendMessage(
                {
                  action: "cachePassphrase",
                  value: saltedHash,
                  keyId: defaultEncryption.getEncryptionKeyId(),
                },
                () => {
                  // Ignore errors - caching is optional
                  if (chrome.runtime.lastError) {
                    return;
                  }
                }
              );
            }

            state.commit("style/hideInfo", true, { root: true });
            return;
          } catch (error) {
            console.error("Failed to apply passphrase:", error);
            state.commit(
              "notification/alert",
              chrome.i18n.getMessage("updateFailure") || "Update failed.",
              { root: true }
            );
            state.commit("currentView/changeView", "EnterPasswordPage", {
              root: true,
            });
          }
        },
        changePassphrase: async (
          state: ActionContext<AccountsState, object>,
          password: string
        ) => {
          if (password) {
            // The hash of the user's password is used as the encryption key for user data.
            const rawSaltedHash = await genHash(password);
            // https://passlib.readthedocs.io/en/stable/lib/passlib.hash.argon2.html#format-algorithm
            const salt = window.atob(rawSaltedHash.split("$")[4]);
            const saltedHash = rawSaltedHash.split("$")[5];

            // This hash is used to verify that a user decrypted `saltedHash` correctly
            const hashOfHash = await genHash(saltedHash);

            if (!saltedHash || !hashOfHash) {
              throw new Error("argon2 did not return a hash!");
            }

            // change entry encryption and regen hash
            const removeKeys: string[] = [];
            const keys = await BrowserStorage.getKeys();
            if (isOldKey(keys)) {
              throw new Error(
                "OldKey still being used. This should never happen!"
              );
            }
            const key: Key = {
              dataType: DataType.Key,
              id: crypto.randomUUID(),
              salt: salt,
              hash: hashOfHash,
              version: 3,
            };

            const linkedKeys = new Map<string, undefined>();
            for (const entry of state.state.entries) {
              await entry.changeEncryption(new Encryption(saltedHash, key.id));
              const previousHash = regenerateLegacyEntryHash(entry);
              if (previousHash) {
                removeKeys.push(previousHash);
              }

              if (entry.encryption?.getEncryptionKeyId()) {
                linkedKeys.set(
                  entry.encryption.getEncryptionKeyId(),
                  undefined
                );
              }
            }

            // store key
            await BrowserStorage.set({
              [key.id]: key,
            });
            await EntryStorage.set(state.state.entries);
            // remove unlinked keys when there is at least one entry
            if (state.state.entries.length !== 0) {
              for (const storedKey of keys) {
                if (!linkedKeys.has(storedKey.id)) {
                  removeKeys.push(storedKey.id);
                }
              }
            }
            if (removeKeys.length) {
              await BrowserStorage.remove(removeKeys);
              for (const removedKey of removeKeys) {
                state.state.encryption.delete(removedKey);
              }
            }

            // Master password rotated: drop any WebAuthn record wrapping the old
            // key before caching the new session key.
            await invalidateBiometricUnlock().catch(() => undefined);

            state.state.encryption.set(
              key.id,
              new Encryption(saltedHash, key.id)
            );
            state.state.defaultEncryption = key.id;
            chrome.runtime.sendMessage(
              { action: "cachePassphrase", value: saltedHash, keyId: key.id },
              () => {
                void chrome.runtime.lastError;
              }
            );

            await state.dispatch("updateEntries");

            // https://github.com/Authenticator-Extension/Authenticator/issues/412
            if (isChromium) {
              await BrowserStorage.clearLogs();
            }
          } else {
            for (const entry of state.state.entries) {
              await entry.changeEncryption(new Encryption("", ""));
            }
            await EntryStorage.set(state.state.entries);

            const storedKeys = await BrowserStorage.getKeys();
            const keysToRemove: string[] = ["key"];
            if (!isOldKey(storedKeys)) {
              for (const storedKey of storedKeys) {
                keysToRemove.push(storedKey.id);
              }
            }
            const defaultKeyId = state.state.encryption
              .get(state.state.defaultEncryption)
              ?.getEncryptionKeyId();
            if (defaultKeyId && !keysToRemove.includes(defaultKeyId)) {
              keysToRemove.push(defaultKeyId);
            }
            await BrowserStorage.remove(keysToRemove);
            await invalidateBiometricUnlock().catch(() => undefined);
            state.state.encryption.clear();
            state.state.defaultEncryption = "";

            await state.dispatch("updateEntries");

            chrome.runtime.sendMessage(
              {
                action: "lock",
              },
              () => {
                // Ignore errors
                if (chrome.runtime.lastError) {
                  return;
                }
              }
            );
          }

          // remove cached passphrase in old version
          UserSettings.items.encodedPhrase = undefined;
          await UserSettings.removeItem("encodedPhrase");
        },
        updateEntries: async (state: ActionContext<AccountsState, object>) => {
          const entries = await this.getEntries();

          for (const entry of entries) {
            // LegacyEncryption indicates that we need to use backwards compatibility logic
            if (entry.encSecret) {
              const legacyEncryption = state.state.encryption.get(
                LegacyEncryption
              );
              if (legacyEncryption) {
                await entry.applyEncryption(legacyEncryption);
              }
            } else if (entry.keyId) {
              const entryEncryption = state.state.encryption.get(entry.keyId);
              if (entryEncryption) {
                await entry.applyEncryption(entryEncryption);
              }
            }
          }

          state.commit("loadCodes", entries);
          state.commit("updateCodes");
          state.commit("initComplete");
          return;
        },
        clearFilter: (state: ActionContext<AccountsState, object>) => {
          state.commit("stopFilter");
          if (state.state.entries.length >= 10) {
            state.commit("showSearch");
          }
        },
        clearAllData: async (state: ActionContext<AccountsState, object>) => {
          // Preserve settings and encryption keys; only OTP and group records
          // belong to the user data cleared by this action.
          await BrowserStorage.clearOtpAndGroupData();
          await state.dispatch("updateEntries");
          await state.dispatch("groups/refreshGroups", undefined, {
            root: true,
          });
          return "updateSuccess";
        },
        migrateStorage: async (
          state: ActionContext<AccountsState, object>,
          newStorageLocation: string
        ) => {
          // sync => local
          if (
            UserSettings.items.storageLocation === StorageLocation.Sync &&
            newStorageLocation === StorageLocation.Local
          ) {
            const syncData = await chrome.storage.sync.get();
            await chrome.storage.local.set(syncData); // userSettings will be handled later
            const localData = await chrome.storage.local.get();

            // Double check if data was set
            if (
              Object.keys(syncData).every(
                (value) => Object.keys(localData).indexOf(value) >= 0
              )
            ) {
              UserSettings.items.storageLocation = StorageLocation.Local;
              await chrome.storage.sync.clear();
              await chrome.storage.local.set({
                UserSettings: UserSettings.items,
              });
              return "updateSuccess";
            } else {
              throw " All data not transferred successfully.";
            }
            // local => sync
          } else if (
            UserSettings.items.storageLocation === StorageLocation.Local &&
            newStorageLocation === StorageLocation.Sync
          ) {
            const localData = await chrome.storage.local.get();
            // Device-only state (API token, auto-import switch, biometric
            // record) must not travel through sync and must survive the local
            // wipe below.
            const deviceData: Record<string, unknown> = {};
            for (const key of Object.keys(localData)) {
              if (key.startsWith("Authenticator")) {
                deviceData[key] = localData[key];
                delete localData[key];
              }
            }
            delete localData.UserSettings;
            const entriesToSync = Object.entries(localData);
            const chunkSize = 25;
            for (
              let index = 0;
              index < entriesToSync.length;
              index += chunkSize
            ) {
              const chunk = Object.fromEntries(
                entriesToSync.slice(index, index + chunkSize)
              );
              await chrome.storage.sync.set(chunk);
            }
            const syncData = await chrome.storage.sync.get();

            // Double check if data was set
            if (
              Object.keys(localData).every(
                (value) => Object.keys(syncData).indexOf(value) >= 0
              )
            ) {
              UserSettings.items.storageLocation = StorageLocation.Sync;
              await chrome.storage.local.clear();
              if (Object.keys(deviceData).length) {
                await chrome.storage.local.set(deviceData);
              }
              await UserSettings.commitItems();
              return "updateSuccess";
            } else {
              throw " All data not transferred successfully.";
            }
          }

          // No change
          return "updateSuccess";
        },
      },
      namespaced: true,
    };
  }

  private async getCachedKeyInfo() {
    const {
      cachedPassphrase,
      cachedKeyId,
    } = await chrome.storage.session.get();

    return { cachedPassphrase, cachedKeyId };
  }
  private async getCachedBiometricKeys(): Promise<
    Map<string, EncryptionInterface>
  > {
    const { cachedBiometricKeys } = await chrome.storage.session.get(
      "cachedBiometricKeys"
    );
    if (!Array.isArray(cachedBiometricKeys)) return new Map();
    const keys = new Map<string, EncryptionInterface>();
    for (const item of cachedBiometricKeys) {
      if (
        !item ||
        typeof item !== "object" ||
        !("id" in item) ||
        typeof item.id !== "string" ||
        !("secret" in item) ||
        typeof item.secret !== "string"
      ) {
        console.warn("Skipping malformed biometric unlock session entry.");
        continue;
      }
      keys.set(item.id, new Encryption(item.secret, item.id));
    }
    return keys;
  }

  private async getEntries() {
    const otpEntries = await EntryStorage.get();
    return otpEntries;
  }
}

async function genHash(value: string) {
  const randomValues = window.crypto.getRandomValues(new Uint16Array(8));
  let salt = "";
  for (const byte of randomValues) {
    salt += byte.toString(16);
  }

  const hash = await argonHash(value, salt);
  if (!hash) {
    throw new Error("argon2 did not return a hash!");
  }
  return hash;
}

export function getUnresolvedEncryptionKeyIds(entries: OTPEntryInterface[]) {
  const unresolvedKeyIds = new Set<string>();
  for (const entry of entries) {
    if (entry.secret !== null) {
      continue;
    }
    unresolvedKeyIds.add(entry.keyId || "__unknown__");
  }
  return unresolvedKeyIds;
}
