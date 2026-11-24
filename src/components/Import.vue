<template>
  <div id="import" class="theme-normal">
    <div v-if="!shouldShowPassphrase">
      <div class="import_tab">
        <input
          type="radio"
          id="import_file_radio"
          value="FileImport"
          v-model="importType"
        />
        <label for="import_file_radio">{{ i18n.import_backup_file }}</label>
        <input
          type="radio"
          id="import_qr_radio"
          value="QrImport"
          v-model="importType"
        />
        <label for="import_qr_radio">{{ i18n.import_backup_qr }}</label>
        <input
          type="radio"
          id="import_code_radio"
          value="TextImport"
          v-model="importType"
        />
        <label for="import_code_radio">{{ i18n.import_backup_code }}</label>
      </div>
      <div>
        <p id="import_info">
          {{ i18n.otp_backup_inform }}
          <a href="https://otp.ee/otpbackup" target="_blank">{{
            i18n.otp_backup_learn
          }}</a>
        </p>
        <div class="import-help-card">
          <div class="import-help-title">{{ i18n.ui_import_help }}</div>
          <ul class="import-help-list">
            <li v-if="importType === 'FileImport'">
              {{ i18n.ui_import_file_help }}
            </li>
            <li v-if="importType === 'FileImport'">
              {{ i18n.ui_import_clear_help }}
            </li>
            <li v-if="importType === 'QrImport'">
              {{ i18n.ui_import_qr_help }}
            </li>
            <li v-if="importType === 'TextImport'">
              {{ i18n.ui_import_text_help }}
            </li>
            <li
              v-if="importType === 'TextImport' || importType === 'FileImport'"
            >
              {{ i18n.ui_import_csv_unsupported }}
            </li>
            <li>{{ i18n.ui_import_result_help }}</li>
          </ul>
        </div>
      </div>
      <component v-bind:is="importType" />
    </div>
    <div v-if="shouldShowPassphrase" class="error_password">
      <p>{{ i18n.import_error_password }}</p>
      <div v-if="biometricEnabled" class="import-passphrase-actions">
        <a-button :disabled="biometricBusy" @click="unlockWithBiometrics">
          {{ i18n.biometric_unlock_button }}
        </a-button>
      </div>
      <p v-if="biometricError" class="error_password">{{ biometricError }}</p>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import FileImport from "./Import/FileImport.vue";
import QrImport from "./Import/QrImport.vue";
import TextImport from "./Import/TextImport.vue";
import {
  cacheBiometricUnlockBundle,
  isBiometricUnlockEnabled,
  readBiometricUnlockRecord,
  unlockWithBiometricRecord,
} from "../models/biometric-unlock";
import { Encryption } from "../models/encryption";

export default Vue.extend({
  data: function () {
    const query = location.search ? location.search.substr(1) : "";
    const importType = ["FileImport", "QrImport", "TextImport"].includes(query)
      ? query
      : "FileImport";
    return {
      importType,
      shouldShowPassphrase:
        Boolean(this.$vaultLocked) || shouldShowPassphrase(this.$entries),
      biometricEnabled: false,
      biometricBusy: false,
      biometricError: "",
    };
  },
  components: {
    FileImport,
    QrImport,
    TextImport,
  },
  methods: {
    onRuntimeMessage(event: { action?: string }) {
      if (event?.action === "stopImport") {
        this.shouldShowPassphrase = true;
        this.$encryption?.updateEncryptionPassword?.("");
      }
      return false;
    },
    async unlockWithBiometrics() {
      if (!this.biometricEnabled || this.biometricBusy) {
        return;
      }
      this.biometricBusy = true;
      this.biometricError = "";
      try {
        const record = await readBiometricUnlockRecord();
        const bundle = await unlockWithBiometricRecord(record);
        await cacheBiometricUnlockBundle(bundle);
        chrome.runtime.sendMessage({ action: "resetAutolock" }, () => {
          void chrome.runtime.lastError;
        });

        const encryptions = new Map<string, Encryption>();
        for (const key of bundle.keys) {
          encryptions.set(key.id, new Encryption(key.secret, key.id));
        }
        const defaultKey =
          bundle.keys.find((key) => key.id === bundle.defaultKeyId) ||
          bundle.keys[0];
        if (defaultKey) {
          this.$encryption?.updateEncryptionPassword?.(defaultKey.secret);
          this.$encryption?.setEncryptionKeyId?.(defaultKey.id);
        }
        for (const entry of this.$entries || []) {
          const entryEncryption =
            (entry.keyId && encryptions.get(entry.keyId)) || this.$encryption;
          if (entryEncryption?.getEncryptionStatus()) {
            await entry.applyEncryption(entryEncryption);
          }
        }
        this.shouldShowPassphrase = shouldShowPassphrase(this.$entries || []);
      } catch (error) {
        const notAllowed =
          error instanceof Error && error.name === "NotAllowedError";
        this.biometricError = notAllowed
          ? this.i18n.biometric_unlock_cancelled
          : this.i18n.biometric_unlock_failed;
      } finally {
        this.biometricBusy = false;
      }
    },
  },
  created() {
    void isBiometricUnlockEnabled()
      .then((enabled) => {
        this.biometricEnabled = enabled;
      })
      .catch(() => {
        this.biometricEnabled = false;
      });
  },
  mounted() {
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
  },
  beforeDestroy() {
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
  },
});

function shouldShowPassphrase(entries: OTPEntryInterface[]) {
  for (const entry of entries) {
    if (!entry.secret) {
      return true;
    }
  }
  return false;
}
</script>
