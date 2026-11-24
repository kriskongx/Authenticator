<template>
  <div class="subpage webdav-page">
    <div class="subpage-head" v-if="!embedded">
      <div class="subpage-title">{{ i18n.ui_webdav_title }}</div>
      <div class="subpage-subtitle">
        {{ i18n.ui_webdav_subtitle }}
      </div>
    </div>

    <section class="subpage-section">
      <div class="subpage-section-head">
        <div class="subpage-section-title">{{ i18n.ui_server_connection }}</div>
      </div>
      <div class="subpage-card subpage-form-card">
        <div class="webdav-connection-meta">
          {{ i18n.ui_webdav_connection_info }}
        </div>

        <label class="subpage-field">
          <span class="subpage-field-label">
            {{ i18n.webdav_server_url || "Server URL" }}
          </span>
          <input
            class="subpage-text-input"
            type="url"
            v-model="webdav.serverUrl"
            placeholder="https://example.com/webdav"
            autocomplete="url"
          />
        </label>

        <label class="subpage-field">
          <span class="subpage-field-label">
            {{ i18n.webdav_username || "Username" }}
          </span>
          <input
            class="subpage-text-input"
            type="text"
            v-model="webdav.username"
            autocomplete="username"
          />
        </label>

        <label class="subpage-field">
          <span class="subpage-field-label">
            {{ i18n.webdav_password || "Password" }}
          </span>
          <a-password-input
            input-class="subpage-text-input"
            v-model="webdav.password"
            autocomplete="current-password"
          />
        </label>

        <label class="subpage-field">
          <span class="subpage-field-label">{{ i18n.ui_backup_storage }}</span>
          <select class="subpage-select" v-model="webdav.encrypted">
            <option value="true">
              {{
                i18n.webdav_backup_option_encrypted ||
                "Encrypted storage (recommended)"
              }}
            </option>
            <option value="false">
              {{ i18n.webdav_backup_option_plain || "Plain-text storage" }}
            </option>
          </select>
        </label>

        <div class="subpage-actions">
          <button
            type="button"
            class="subpage-button"
            :disabled="webdav.isTesting"
            @click="testWebDAV"
          >
            {{
              webdav.isTesting
                ? i18n.ui_testing
                : i18n.webdav_test_connection || "Test connection"
            }}
          </button>
          <button
            type="button"
            class="subpage-button primary"
            :disabled="webdav.isSaving"
            @click="saveWebDAVSettings"
          >
            {{ webdav.isSaving ? i18n.ui_saving : i18n.webdav_save || "Save" }}
          </button>
        </div>
      </div>
    </section>

    <section class="subpage-section">
      <div class="subpage-section-head">
        <div class="subpage-section-title">{{ i18n.ui_automatic_backup }}</div>
        <span class="subpage-section-meta">
          {{ i18n.webdav_last_backup || "Last backup" }}: {{ lastBackupLabel }}
        </span>
      </div>
      <div class="subpage-list-card">
        <label class="subpage-row">
          <span class="subpage-row-icon"><IconSync /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">
              {{ i18n.webdav_auto_backup || "Automatic WebDAV backup" }}
            </span>
            <span class="subpage-row-desc">
              {{
                i18n.webdav_auto_backup_desc ||
                "Upload a backup every 7 days when Authenticator opens."
              }}
            </span>
          </span>
          <span class="subpage-switch">
            <input
              type="checkbox"
              v-model="webdav.autoBackup"
              @change="updateAutoBackupPreference"
            />
            <span class="subpage-switch-track"></span>
          </span>
        </label>

        <label class="subpage-row">
          <span class="subpage-row-icon neutral"><IconSync /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">{{
              i18n.webdav_backup_interval
            }}</span>
            <span class="subpage-row-desc">{{
              i18n.webdav_backup_interval_desc
            }}</span>
            <span class="subpage-row-desc">{{ lastAutoBackupSummary }}</span>
          </span>
          <span class="subpage-control">
            <input
              class="subpage-number-input"
              type="number"
              v-model.number="webdav.intervalDays"
              min="1"
              max="365"
              :aria-label="i18n.webdav_backup_interval"
              @change="updateIntervalPreference"
            />
            <span class="subpage-control-unit">{{ i18n.ui_days_unit }}</span>
          </span>
        </label>

        <label class="subpage-row">
          <span class="subpage-row-icon neutral"><IconSync /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">{{ i18n.webdav_backup_hour }}</span>
            <span class="subpage-row-desc">{{
              i18n.webdav_backup_hour_desc
            }}</span>
          </span>
          <span class="subpage-control">
            <select
              class="subpage-select webdav-hour-select"
              v-model.number="webdav.backupHour"
              :aria-label="i18n.webdav_backup_hour"
              @change="updateBackupHourPreference"
            >
              <option :value="-1">{{ i18n.webdav_backup_hour_now }}</option>
              <option v-for="hour in hourOptions" :key="hour" :value="hour">
                {{ hourLabel(hour) }}
              </option>
            </select>
          </span>
        </label>

        <label class="subpage-row">
          <span class="subpage-row-icon neutral"><IconDatabase /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">{{ i18n.ui_retention_count }}</span>
            <span class="subpage-row-desc">{{ i18n.ui_retention_desc }}</span>
          </span>
          <span class="subpage-control">
            <input
              class="subpage-number-input"
              type="number"
              v-model.number="webdav.maxBackups"
              min="0"
              :aria-label="i18n.ui_retention_count"
              @change="updateMaxBackupsPreference"
            />
            <span class="subpage-control-unit">{{ i18n.ui_copies }}</span>
          </span>
        </label>
      </div>

      <div class="subpage-card webdav-action-card">
        <div class="subpage-actions">
          <button
            type="button"
            class="subpage-button primary"
            :disabled="webdav.isBackingUp"
            @click="backupToWebDAV"
          >
            {{
              webdav.isBackingUp
                ? i18n.ui_backing_up
                : i18n.webdav_backup_button || "Back up now"
            }}
          </button>
          <button
            type="button"
            class="subpage-button"
            :disabled="webdav.isLoadingList"
            @click="refreshWebDAVList(false)"
          >
            {{
              webdav.isLoadingList
                ? i18n.ui_refreshing
                : i18n.webdav_refresh_list || "Refresh"
            }}
          </button>
          <button
            type="button"
            class="subpage-button"
            @click="openWebDAVFileManager"
          >
            {{ i18n.webdav_manage_files || "Manage backup files" }}
          </button>
        </div>
        <p class="subpage-card-message" v-if="webdav.message">
          {{ webdav.message }}
        </p>
      </div>
    </section>

    <section class="subpage-section">
      <div class="subpage-section-head">
        <div class="subpage-section-title">{{ i18n.ui_restore_backup }}</div>
      </div>
      <div class="subpage-section-desc">{{ restoreHint }}</div>
      <div class="subpage-card subpage-form-card">
        <label class="subpage-field">
          <span class="subpage-field-label">{{ i18n.ui_select_backup }}</span>
          <select class="subpage-select" v-model="webdav.selectedFile">
            <option disabled value="">
              {{ i18n.webdav_choose_backup || "Choose a backup file" }}
            </option>
            <option
              v-for="file in webdav.files"
              :key="file.name"
              :value="file.name"
            >
              {{ formatWebDAVFile(file) }}
            </option>
          </select>
        </label>

        <label class="webdav-toggle-field">
          <span class="subpage-row-copy">
            <span class="subpage-row-title">
              {{
                i18n.webdav_clear_before_restore ||
                "Clear existing data before restore"
              }}
            </span>
            <span class="subpage-row-desc">
              {{
                i18n.webdav_clear_before_restore_desc ||
                "Delete all current accounts before importing the selected backup."
              }}
            </span>
          </span>
          <span class="subpage-switch">
            <input
              type="checkbox"
              v-model="webdav.clearBeforeRestore"
              @change="updateClearBeforeRestorePreference"
            />
            <span class="subpage-switch-track"></span>
          </span>
        </label>

        <div class="subpage-actions webdav-restore-actions">
          <button
            type="button"
            class="subpage-button primary"
            :disabled="!webdav.selectedFile || webdav.isRestoring"
            @click="restoreFromWebDAV"
          >
            {{
              webdav.isRestoring
                ? i18n.ui_restoring
                : i18n.webdav_restore_button || "Restore selected backup"
            }}
          </button>
          <button
            type="button"
            class="subpage-button"
            v-if="webdav.isRestoring && webdav.restoreCanCancel"
            @click="cancelWebDAVRestore"
          >
            {{ i18n.ui_cancel_import }}
          </button>
          <button
            type="button"
            class="subpage-button danger"
            :disabled="webdav.isRestoring"
            @click="handleClearAllData"
          >
            {{ i18n.backup_clear_button || "Clear all data" }}
          </button>
        </div>

        <div class="webdav-transfer-progress" v-if="webdav.isRestoring">
          <div class="webdav-transfer-progress-head">
            <span>{{ webdav.restoreProgressLabel }}</span>
            <span>{{ webdav.restoreProgress }}%</span>
          </div>
          <div
            class="webdav-transfer-progress-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="webdav.restoreProgress"
          >
            <span
              class="webdav-transfer-progress-fill"
              :style="{ width: webdav.restoreProgress + '%' }"
            ></span>
          </div>
        </div>
      </div>
    </section>

    <div
      class="subpage-dialog-backdrop"
      v-if="restorePassphraseDialogOpen"
      role="presentation"
      @click.self="cancelRestorePassphrase"
      @keydown.esc.stop.prevent="cancelRestorePassphrase"
    >
      <form
        class="subpage-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="'webdavRestorePasswordTitle'"
        @submit.prevent="submitRestorePassphrase"
      >
        <div class="subpage-dialog-title" id="webdavRestorePasswordTitle">
          {{ i18n.ui_backup_password_title }}
        </div>
        <div class="subpage-dialog-desc">
          {{ i18n.ui_backup_password_desc }}
        </div>
        <label class="subpage-field">
          <span class="subpage-field-label">{{ i18n.phrase }}</span>
          <a-password-input
            ref="restorePassphraseInput"
            input-class="subpage-text-input"
            v-model="restorePassphrase"
            autocomplete="current-password"
            :biometric="biometricEnabled"
            :biometric-disabled="biometricBusy"
            :biometric-title="i18n.biometric_decrypt_backup"
            @biometric="unlockRestorePassphraseWithBiometrics"
          />
        </label>
        <div class="subpage-actions">
          <button
            type="button"
            class="subpage-button"
            @click="cancelRestorePassphrase"
          >
            {{ i18n.cancel }}
          </button>
          <button
            type="submit"
            class="subpage-button primary"
            :disabled="!restorePassphrase"
          >
            {{ i18n.ok }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import IconDatabase from "../../../svg/database.svg";
import IconSync from "../../../svg/sync.svg";
import { Encryption } from "../../models/encryption";
import { MAX_BACKUP_CONTENT_BYTES } from "../../models/import-limits";
import {
  type BackupPassphraseResult,
  restoreBackupContent,
} from "../../models/backup-restore";
import {
  isBiometricUnlockEnabled,
  isDetachedPopupWindow,
  unlockBiometricBackupKeys,
} from "../../models/biometric-unlock";
import {
  downloadWebDAVBackup,
  getClientDay,
  getWebDAVConfig,
  listWebDAVBackups,
  saveWebDAVConfig,
  testWebDAVConnection,
  uploadWebDAVBackup,
  pruneWebDAVBackups,
  type WebDAVConfig,
  type WebDAVFile,
  getWebDAVOrigin,
  backupDayToMs,
  normalizeBackupDay,
  normalizeBackupIntervalDays,
  normalizeBackupHour,
} from "../../models/webdav";
import { UserSettings } from "../../models/settings";

export default Vue.extend({
  props: {
    embedded: {
      type: Boolean,
      default: false,
    },
  },
  components: {
    IconDatabase,
    IconSync,
  },
  data: function () {
    return {
      webdav: {
        serverUrl: "",
        username: "",
        password: "",
        encrypted: "true",
        autoBackup: true,
        clearBeforeRestore: false,
        maxBackups: 0,
        intervalDays: 7,
        backupHour: -1,
        files: [] as WebDAVFile[],
        selectedFile: "",
        isTesting: false,
        isBackingUp: false,
        isLoadingList: false,
        isRestoring: false,
        isSaving: false,
        message: "",
        lastBackupDay: 0,
        lastAutoBackupAt: 0,
        restoreProgress: 0,
        restoreProgressLabel: "",
        restoreCanCancel: false,
      },
      biometricEnabled: false,
      biometricBusy: false,
      restoreAbortController: null as AbortController | null,
      restorePassphraseDialogOpen: false,
      restorePassphrase: "",
      restorePassphraseResolver: null as
        | ((passphrase: BackupPassphraseResult) => void)
        | null,
      pendingRestorePayload: null as {
        content: string;
        clearFirst: boolean;
      } | null,
    };
  },
  created() {
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
    this.loadWebDAVSettings();
    void isBiometricUnlockEnabled()
      .then((enabled) => {
        this.biometricEnabled = enabled;
      })
      .catch(() => {
        this.biometricEnabled = false;
      });
  },
  beforeDestroy() {
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
    this.restoreAbortController?.abort();
    this.cancelRestorePassphrase();
  },
  computed: {
    currentlyEncrypted: function () {
      return this.$store.getters["accounts/currentlyEncrypted"];
    },
    webdavConfig(): WebDAVConfig {
      return {
        url: this.webdav.serverUrl.trim(),
        username: this.webdav.username.trim(),
        password: this.webdav.password,
        encrypted: this.webdav.encrypted === "true",
      };
    },
    lastBackupLabel(): string {
      if (!this.webdav.lastBackupDay) {
        return this.i18n.webdav_never_backed_up || "Never backed up";
      }
      const ms = backupDayToMs(this.webdav.lastBackupDay);
      return new Date(ms).toLocaleDateString();
    },
    lastAutoBackupSummary(): string {
      if (!this.webdav.lastAutoBackupAt) {
        return (
          this.i18n.webdav_never_auto_backed_up || "No automatic backup yet"
        );
      }
      const formatted = new Date(this.webdav.lastAutoBackupAt).toLocaleString(
        undefined,
        {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }
      );
      return `${
        this.i18n.webdav_last_auto_backup || "Last automatic backup"
      }: ${formatted}`;
    },
    hourOptions(): number[] {
      return Array.from({ length: 24 }, (_, index) => index);
    },
    restoreHint(): string {
      return this.webdav.files.length
        ? `${this.webdav.files.length} ${this.i18n.ui_backups_found} · ${this.i18n.ui_latest_backup} ${this.lastBackupLabel}`
        : this.i18n.webdav_no_files || "No restorable backup files were found.";
    },
  },
  methods: {
    onRuntimeMessage(message: { action?: string }): boolean {
      if (message?.action === "webdavBackupUpdated") {
        void UserSettings.updateItems().then(() => {
          this.webdav.lastBackupDay = normalizeBackupDay(
            UserSettings.items.webdavLastBackupTime
          );
          this.webdav.lastAutoBackupAt = Number(
            UserSettings.items.webdavLastAutoBackupAt || 0
          );
        });
      }
      return false;
    },
    async loadWebDAVSettings() {
      const config = await getWebDAVConfig();
      this.webdav.serverUrl = config.url;
      this.webdav.username = config.username;
      this.webdav.password = config.password;
      this.webdav.encrypted = config.encrypted ? "true" : "false";
      this.webdav.autoBackup = UserSettings.items.webdavAutoBackup !== false;
      this.webdav.clearBeforeRestore =
        UserSettings.items.webdavClearBeforeRestore === true;
      this.webdav.maxBackups = Number(
        UserSettings.items.webdavMaxBackups || 0
      );
      this.webdav.intervalDays = normalizeBackupIntervalDays(
        UserSettings.items.webdavBackupIntervalDays
      );
      this.webdav.backupHour = normalizeBackupHour(
        UserSettings.items.webdavBackupHour
      );
      this.webdav.lastBackupDay = normalizeBackupDay(
        UserSettings.items.webdavLastBackupTime
      );
      this.webdav.lastAutoBackupAt = Number(
        UserSettings.items.webdavLastAutoBackupAt || 0
      );
      if (config.url) {
        this.refreshWebDAVList(true);
      }
    },
    async saveWebDAVSettings() {
      if (!this.validateWebDAVFields()) {
        this.notify(this.i18n.webdav_settings_missing);
        return;
      }
      const granted = await this.ensureWebDAVPermission();
      if (!granted) {
        return;
      }
      this.webdav.isSaving = true;
      try {
        await saveWebDAVConfig(this.webdavConfig);
        UserSettings.items.webdavMaxBackups = this.webdav.maxBackups;
        await UserSettings.commitItems();
        this.syncAutoBackupAlarm();
        this.notify(this.i18n.updateSuccess);
      } finally {
        this.webdav.isSaving = false;
      }
    },
    async testWebDAV() {
      if (!(await this.ensureWebDAVReady())) {
        return;
      }
      this.webdav.isTesting = true;
      try {
        const success = await testWebDAVConnection();
        this.notify(
          success
            ? this.i18n.webdav_connection_success
            : this.i18n.webdav_connection_failure
        );
      } catch (error) {
        this.notify(this.i18n.webdav_connection_failure);
      } finally {
        this.webdav.isTesting = false;
      }
    },
    async backupToWebDAV(showToast = true) {
      if (this.currentlyEncrypted) {
        this.notify(this.i18n.phrase_incorrect_export);
        return false;
      }
      if (!(await this.ensureWebDAVReady())) {
        return false;
      }
      const encryption = this.getActiveEncryption();

      // Check if user selected encrypted backup but no password is set
      if (this.webdavConfig.encrypted && (!encryption || !encryption.getEncryptionStatus())) {
        this.notify(
          this.i18n.backup_set_password_alert ||
            this.i18n.ui_create_password_first
        );
        return false;
      }

      if (!encryption) {
        this.notify(this.i18n.import_error_password);
        return false;
      }
      this.webdav.isBackingUp = true;
      try {
        const success = await uploadWebDAVBackup(
          encryption,
          this.webdavConfig.encrypted
        );
        if (showToast) {
          this.notify(
            success
              ? this.i18n.webdav_backup_success
              : this.i18n.webdav_backup_failure
          );
        }
        if (success) {
          await this.recordBackupDay();
          await this.cleanupOldBackups();
          await this.refreshWebDAVList(true);
        }
        return success;
      } catch (error) {
        if (showToast) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.notify(
            errorMsg === "webdavTimeout"
              ? this.i18n.ui_error_webdav_timeout
              : errorMsg === "backupContentTooLarge"
              ? this.i18n.ui_error_backup_too_large
              : this.i18n.webdav_backup_failure +
                (errorMsg ? ": " + errorMsg : "")
          );
        }
        return false;
      } finally {
        this.webdav.isBackingUp = false;
      }
    },
    async refreshWebDAVList(silent = false) {
      if (!this.validateWebDAVFields()) {
        return;
      }
      const granted = await this.ensureWebDAVPermission(!silent);
      if (!granted) {
        return;
      }
      this.webdav.isLoadingList = true;
      if (!silent) {
        this.webdav.message = this.i18n.webdav_loading_files;
      }
      try {
        // Clear the current list first so the refreshed state is unambiguous.
        this.webdav.files = [];
        const files = await listWebDAVBackups();
        this.webdav.files = files;
        if (!files.length) {
          this.webdav.message = this.i18n.webdav_no_files;
          this.webdav.selectedFile = "";
        } else {
          this.webdav.message = "";
          if (
            !this.webdav.selectedFile ||
            !files.some((file) => file.name === this.webdav.selectedFile)
          ) {
            this.webdav.selectedFile = files[0].name;
          }
        }
      } catch (error) {
        this.webdav.message = this.i18n.webdav_fetch_failed;
      } finally {
        this.webdav.isLoadingList = false;
      }
    },
    async restoreFromWebDAV() {
      if (!this.webdav.selectedFile) {
        this.notify(this.i18n.webdav_choose_backup);
        return;
      }
      if (this.currentlyEncrypted) {
        this.notify(this.i18n.import_error_password);
        return;
      }
      if (!(await this.ensureWebDAVReady())) {
        return;
      }
      const selectedFile = this.webdav.files.find(
        (file) => file.name === this.webdav.selectedFile
      );
      if (
        selectedFile?.size &&
        selectedFile.size > MAX_BACKUP_CONTENT_BYTES
      ) {
        this.notify(this.i18n.ui_error_backup_too_large);
        return;
      }
      const encryption = this.getActiveEncryption();
      if (!encryption) {
        this.notify(this.i18n.import_error_password);
        return;
      }
      const controller = new AbortController();
      this.restoreAbortController = controller;
      this.webdav.isRestoring = true;
      this.webdav.restoreCanCancel = true;
      this.setRestoreProgress(2, this.i18n.ui_progress_downloading_backup);
      try {
        const content = await downloadWebDAVBackup(this.webdav.selectedFile, {
          signal: controller.signal,
          onDownloadProgress: (loadedBytes, totalBytes) => {
            const ratio = totalBytes
              ? loadedBytes / totalBytes
              : loadedBytes / MAX_BACKUP_CONTENT_BYTES;
            this.setRestoreProgress(
              3 + Math.min(1, ratio) * 42,
              this.i18n.ui_progress_downloading_backup
            );
          },
        });
        await this.restoreFromBackupContent(
          content,
          encryption,
          this.webdav.clearBeforeRestore,
          controller.signal,
          (value, label) => this.setRestoreProgress(value, label)
        );
        this.setRestoreProgress(100, this.i18n.webdav_restore_success);
        this.notify(this.i18n.webdav_restore_success);
      } catch (error) {
        const message = (error as Error).message;
        if (message === "cancelled" || message === "importCancelled") {
          this.notify(this.i18n.webdav_restore_cancelled);
        } else if (message === "parseError") {
          this.notify(this.i18n.webdav_restore_parse_error);
        } else if (message === "incorrectPassphrase") {
          this.notify(this.i18n.ui_incorrect_backup_password);
        } else if (message === "biometricBackupKeyMismatch") {
          this.notify(this.i18n.biometric_backup_key_mismatch);
        } else if (message === "backupContentTooLarge") {
          this.notify(this.i18n.ui_error_backup_too_large);
        } else if (message === "webdavTimeout") {
          this.notify(this.i18n.ui_error_webdav_timeout);
        } else {
          this.notify(this.i18n.webdav_restore_failure);
        }
      } finally {
        this.webdav.isRestoring = false;
        this.webdav.restoreCanCancel = false;
        this.restoreAbortController = null;
      }
    },
    cancelWebDAVRestore() {
      this.restoreAbortController?.abort();
      this.cancelRestorePassphrase();
      this.setRestoreProgress(100, this.i18n.webdav_restore_cancelled);
    },
    async handleClearAllData() {
      if (
        !(await this.$store.dispatch(
          "notification/confirm",
          this.i18n.backup_clear_confirm
        ))
      ) {
        return;
      }
      let proceed = true;
      if (
        await this.$store.dispatch(
          "notification/confirm",
          this.i18n.backup_clear_backup_prompt
        )
      ) {
        const success = await this.backupToWebDAV(false);
        if (!success) {
          proceed = await this.$store.dispatch(
            "notification/confirm",
            this.i18n.webdav_backup_failure
          );
        }
      }
      if (!proceed) {
        return;
      }
      await this.$store.dispatch("accounts/clearAllData");
      await this.$store.dispatch("accounts/updateEntries");
      this.notify(this.i18n.backup_clear_success);
    },
    async restoreFromBackupContent(
      content: string,
      encryption: Encryption,
      clearFirst: boolean,
      signal?: AbortSignal,
      onProgress?: (value: number, label: string) => void
    ) {
      this.pendingRestorePayload = { content, clearFirst };
      try {
        const result = await restoreBackupContent({
          content,
          encryption,
          clearFirst,
          signal,
          requestPassphrase: () => this.promptRestorePassphrase(),
          onProgress: (value, key) =>
            onProgress?.(value, this.i18n[key] || key),
          onApplyStart: () => {
            this.webdav.restoreCanCancel = false;
          },
          refresh: async () => {
            await this.$store.dispatch("groups/refreshGroups");
            await this.$store.dispatch("accounts/updateEntries");
          },
        });

        if (result.failedCount > 0 && result.succeededCount === 0) {
          this.notify(this.i18n.migration_fail);
        } else if (result.failedCount > 0) {
          this.notify(this.i18n.migration_partly_fail);
        }
      } finally {
        this.pendingRestorePayload = null;
      }
    },
    async promptRestorePassphrase() {
      this.cancelRestorePassphrase();
      this.restorePassphrase = "";
      this.restorePassphraseDialogOpen = true;
      this.$nextTick(() => {
        const input = this.$refs.restorePassphraseInput as
          | { focus?: () => void }
          | undefined;
        input?.focus?.();
      });
      return new Promise<BackupPassphraseResult>((resolve) => {
        this.restorePassphraseResolver = resolve;
      });
    },
    async unlockRestorePassphraseWithBiometrics() {
      if (
        !this.biometricEnabled ||
        this.biometricBusy ||
        !this.restorePassphraseResolver
      ) {
        return;
      }
      this.biometricBusy = true;
      try {
        const preUnlockedKeys = await unlockBiometricBackupKeys();
        if (!isDetachedPopupWindow() && this.pendingRestorePayload) {
          const response = await this.completeBiometricBackupRestore(
            this.pendingRestorePayload.content,
            this.pendingRestorePayload.clearFirst,
            preUnlockedKeys
          );
          if (!response.ok) {
            if (response.error?.includes("biometricBackupKeyMismatch")) {
              this.notify(this.i18n.biometric_backup_key_mismatch);
              return;
            }
            throw new Error(response.error || "webdav_restore_failure");
          }
          const resolver = this.restorePassphraseResolver;
          this.restorePassphraseResolver = null;
          this.restorePassphraseDialogOpen = false;
          this.restorePassphrase = "";
          resolver?.({ handledInBackground: true });
          return;
        }
        const resolver = this.restorePassphraseResolver;
        this.restorePassphraseResolver = null;
        this.restorePassphraseDialogOpen = false;
        this.restorePassphrase = "";
        resolver?.({ preUnlockedKeys });
      } catch (error) {
        const notAllowed =
          error instanceof Error && error.name === "NotAllowedError";
        this.notify(
          notAllowed
            ? this.i18n.biometric_unlock_cancelled
            : this.i18n.biometric_unlock_failed
        );
      } finally {
        this.biometricBusy = false;
      }
    },
    completeBiometricBackupRestore(
      content: string,
      clearFirst: boolean,
      preUnlockedKeys: Map<string, string>
    ): Promise<{ ok: boolean; error?: string }> {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: "completeBiometricBackupRestore",
            content,
            clearFirst,
            preUnlockedKeys: Array.from(preUnlockedKeys.entries()).map(
              ([id, secret]) => ({ id, secret })
            ),
            reopenPopup: true,
          },
          (response?: { ok?: boolean; error?: string }) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve({ ok: response?.ok === true, error: response?.error });
          }
        );
      });
    },
    submitRestorePassphrase() {
      if (!this.restorePassphrase || !this.restorePassphraseResolver) {
        return;
      }
      const resolver = this.restorePassphraseResolver;
      const passphrase = this.restorePassphrase;
      this.restorePassphraseResolver = null;
      this.restorePassphraseDialogOpen = false;
      this.restorePassphrase = "";
      resolver(passphrase);
    },
    cancelRestorePassphrase() {
      const resolver = this.restorePassphraseResolver;
      this.restorePassphraseResolver = null;
      this.restorePassphraseDialogOpen = false;
      this.restorePassphrase = "";
      resolver?.(null);
    },
    validateWebDAVFields() {
      return (
        this.webdav.serverUrl.trim() &&
        this.webdav.username.trim() &&
        this.webdav.password
      );
    },
    async ensureWebDAVReady() {
      if (!this.validateWebDAVFields()) {
        this.notify(this.i18n.webdav_settings_missing);
        return false;
      }
      const granted = await this.ensureWebDAVPermission();
      if (!granted) {
        return false;
      }
      await saveWebDAVConfig(this.webdavConfig);
      return true;
    },
    getOriginFromUrl(url: string) {
      return getWebDAVOrigin(url);
    },
    ensureWebDAVPermission(interactive = true): Promise<boolean> {
      return new Promise((resolve) => {
        const origin = this.getOriginFromUrl(this.webdav.serverUrl);
        if (!origin) {
          if (interactive) {
            this.notify(this.i18n.webdav_invalid_url);
          }
          resolve(false);
          return;
        }
        if (!interactive) {
          chrome.permissions.contains(
            { origins: [origin] },
            (hasPermission) => {
              void chrome.runtime.lastError;
              resolve(Boolean(hasPermission));
            }
          );
          return;
        }
        try {
          chrome.permissions.request({ origins: [origin] }, (granted) => {
            const ok = !chrome.runtime.lastError && Boolean(granted);
            if (!ok) {
              this.notify(this.i18n.webdav_permission_denied);
            }
            resolve(ok);
          });
        } catch {
          this.notify(this.i18n.webdav_permission_denied);
          resolve(false);
        }
      });
    },
    getActiveEncryption(): Encryption | null {
      const defaultKeyId = this.$store.state.accounts.defaultEncryption;
      if (!defaultKeyId) {
        return new Encryption("", "");
      }
      const encryption = this.$store.state.accounts.encryption.get(
        defaultKeyId
      );
      return encryption || new Encryption("", "");
    },
    formatWebDAVFile(file: WebDAVFile) {
      const size =
        file.size && file.size > 0 ? ` (${this.formatBytes(file.size)})` : "";
      const date = file.lastModified
        ? ` - ${new Date(file.lastModified).toLocaleString()}`
        : "";
      return `${file.displayName}${size}${date}`;
    },
    async openWebDAVFileManager() {
      if (!(await this.ensureWebDAVReady())) {
        return;
      }
      this.$emit("navigate", "WebDAVManagePage");
    },
    formatBytes(bytes: number) {
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
      }
      const sizes = ["B", "KB", "MB", "GB"];
      const i = Math.min(
        sizes.length - 1,
        Math.floor(Math.log(bytes) / Math.log(1024))
      );
      const value = bytes / Math.pow(1024, i);
      return `${value.toFixed(1)} ${sizes[i]}`;
    },
    notify(message: string) {
      this.$store.commit("notification/alert", message);
    },
    setRestoreProgress(value: number, label: string) {
      this.webdav.restoreProgress = Math.max(
        0,
        Math.min(100, Math.round(value))
      );
      this.webdav.restoreProgressLabel = label;
    },
    async updateAutoBackupPreference() {
      UserSettings.items.webdavAutoBackup = this.webdav.autoBackup;
      await UserSettings.commitItems();
      this.syncAutoBackupAlarm();
      if (this.webdav.autoBackup) {
        this.runAutoBackupNow();
      }
    },
    runAutoBackupNow() {
      chrome.runtime.sendMessage({ action: "runWebDAVBackup" }, () => {
        void chrome.runtime.lastError;
      });
    },
    hourLabel(hour: number): string {
      return `${String(hour).padStart(2, "0")}:00`;
    },
    async updateBackupHourPreference() {
      const hour = normalizeBackupHour(this.webdav.backupHour);
      this.webdav.backupHour = hour;
      UserSettings.items.webdavBackupHour = hour;
      await UserSettings.commitItems();
      this.syncAutoBackupAlarm();
    },
    async updateIntervalPreference() {
      const days = normalizeBackupIntervalDays(this.webdav.intervalDays);
      this.webdav.intervalDays = days;
      UserSettings.items.webdavBackupIntervalDays = days;
      await UserSettings.commitItems();
      this.syncAutoBackupAlarm();
      // A shorter interval may already be overdue: do not wait for the alarm.
      this.runAutoBackupNow();
    },
    // The worker schedules the alarm; tell it whenever the config changes.
    syncAutoBackupAlarm() {
      chrome.runtime.sendMessage({ action: "syncWebDAVAlarm" }, () => {
        void chrome.runtime.lastError;
      });
    },
    updateClearBeforeRestorePreference() {
      UserSettings.items.webdavClearBeforeRestore =
        this.webdav.clearBeforeRestore;
      UserSettings.commitItems();
    },
    updateMaxBackupsPreference() {
      const maxBackups = Math.max(0, Number(this.webdav.maxBackups) || 0);
      this.webdav.maxBackups = maxBackups;
      UserSettings.items.webdavMaxBackups = maxBackups;
      UserSettings.commitItems();
    },
    async recordBackupDay(day = getClientDay()) {
      this.webdav.lastBackupDay = day;
      UserSettings.items.webdavLastBackupTime = day;
      await UserSettings.commitItems();
    },
    async cleanupOldBackups() {
      const maxBackups = this.webdav.maxBackups;
      if (!maxBackups || maxBackups <= 0) {
        return;
      }
      await pruneWebDAVBackups(maxBackups);
    },
  },
});
</script>
