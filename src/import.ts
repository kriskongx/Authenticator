import Vue from "vue";
import ImportView from "./components/Import.vue";
import CommonComponents from "./components/common/index";
import { loadI18nMessages } from "./store/i18n";

import { Encryption } from "./models/encryption";
import { EntryStorage } from "./models/storage";

// Re-export utility functions for backward compatibility
export {
  decryptBackupData,
  decryptBackupGroups,
  getEntryDataFromOTPAuthPerLine,
  getEntryDataFromBitwarden,
  normalizeImportedEntryGroupIds,
} from "./models/import-utils";

async function init() {
  // i18n
  Vue.prototype.i18n = await loadI18nMessages();

  // Load common components globally
  for (const component of CommonComponents) {
    Vue.component(component.name, component.component);
  }

  // Load entries to global
  const cachedSecrets = await getCachedSecrets();
  const encryption = new Encryption(
    cachedSecrets.cachedPassphrase || "",
    cachedSecrets.cachedKeyId || ""
  );
  let vaultLocked = false;
  try {
    await EntryStorage.assertEncryptionReadyForVault(encryption);
  } catch {
    vaultLocked = true;
  }
  const encryptions = new Map<string, Encryption>();
  if (Array.isArray(cachedSecrets.cachedBiometricKeys)) {
    for (const item of cachedSecrets.cachedBiometricKeys) {
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
  if (encryption.getEncryptionStatus() && cachedSecrets.cachedKeyId) {
    encryptions.set(cachedSecrets.cachedKeyId, encryption);
  }

  const entries = await EntryStorage.get();

  if (encryptions.size > 0 || encryption.getEncryptionStatus()) {
    for (const entry of entries) {
      const entryEncryption =
        (entry.keyId && encryptions.get(entry.keyId)) || encryption;
      if (entryEncryption.getEncryptionStatus()) {
        await entry.applyEncryption(entryEncryption);
      }
    }
  }

  Vue.prototype.$entries = entries;
  Vue.prototype.$encryption = encryption;
  Vue.prototype.$vaultLocked = vaultLocked;

  const instance = new Vue({
    render: (h) => h(ImportView),
  }).$mount("#import");

  // Set title
  try {
    document.title = instance.i18n.extName;
  } catch (e) {
    console.error(e);
  }
}

init();

async function getCachedSecrets() {
  const {
    cachedPassphrase,
    cachedKeyId,
    cachedBiometricKeys,
  } = await chrome.storage.session.get([
    "cachedPassphrase",
    "cachedKeyId",
    "cachedBiometricKeys",
  ]);

  return { cachedPassphrase, cachedKeyId, cachedBiometricKeys };
}
