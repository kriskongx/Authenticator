<template>
  <div class="backup-page">
    <div class="backup-page-head">
      <div class="backup-page-subtitle">
        {{ i18n.ui_backup_subtitle }}
      </div>
    </div>

    <section class="backup-section" v-if="isChromium">
      <div class="backup-section-title">{{ i18n.ui_cloud_sync_title }}</div>
      <div class="backup-option-list">
        <button
          type="button"
          class="backup-option"
          :disabled="cloudBackingUp"
          @click="cloudBackup"
        >
          <span class="backup-option-icon"><IconCloudBackup /></span>
          <span class="backup-option-copy">
            <span class="backup-option-title">{{
              cloudBackingUp
                ? i18n.ui_cloud_sync_backing_up
                : i18n.ui_cloud_backup_title
            }}</span>
            <span class="backup-option-desc">{{ cloudBackupHint }}</span>
          </span>
          <span class="cloud-sync-spinner" v-if="cloudBackingUp"></span>
          <IconArrowLeft class="backup-option-arrow" v-else />
        </button>

        <button type="button" class="backup-option" @click="cloudRestore">
          <span class="backup-option-icon"><IconCloudRestore /></span>
          <span class="backup-option-copy">
            <span class="backup-option-title">{{
              i18n.ui_cloud_restore_title
            }}</span>
            <span class="backup-option-desc">{{
              i18n.ui_cloud_sync_restore_desc
            }}</span>
          </span>
          <IconArrowLeft class="backup-option-arrow" />
        </button>
      </div>
    </section>

    <section class="backup-section">
      <div class="backup-section-title">{{ i18n.ui_local_backup }}</div>
      <div class="backup-option-list">
        <button
          v-if="!exportDisabled"
          type="button"
          class="backup-option"
          @click="showInfo('ExportBackupPage')"
        >
          <span class="backup-option-icon"><IconExchange /></span>
          <span class="backup-option-copy">
            <span class="backup-option-title">{{ i18n.ui_export_backup }}</span>
            <span class="backup-option-desc">{{
              i18n.ui_export_backup_desc
            }}</span>
          </span>
          <IconArrowLeft class="backup-option-arrow" />
        </button>

        <a
          class="backup-option"
          href="import.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="backup-option-icon"><IconRedo /></span>
          <span class="backup-option-copy">
            <span class="backup-option-title">
              {{ i18n.import_backup || "Import backup" }}
            </span>
            <span class="backup-option-desc">{{
              i18n.ui_import_backup_desc
            }}</span>
          </span>
          <IconArrowLeft class="backup-option-arrow" />
        </a>
      </div>
    </section>

    <section class="backup-section" v-if="isChromium">
      <div class="backup-section-title">{{ i18n.ui_local_import_title }}</div>
      <div class="backup-section-desc">{{ i18n.ui_local_import_desc }}</div>
      <div class="backup-option-list">
        <label class="backup-option local-import-entry">
          <span class="backup-option-icon"><IconSync /></span>
          <span class="backup-option-copy">
            <span class="backup-option-title">{{
              i18n.ui_local_import_row_title
            }}</span>
            <span class="backup-option-desc">{{ localImportStatusText }}</span>
          </span>
          <span class="subpage-switch">
            <input
              type="checkbox"
              v-model="localImportEnabled"
              :aria-label="i18n.ui_local_import_title"
              @change="syncLocalImport($event)"
            />
            <span class="subpage-switch-track"></span>
          </span>
        </label>

        <div class="local-import-body" v-if="localImportEnabled">
          <dl
            class="local-import-meta"
            v-if="localImportStatus && localImportStatus.available"
          >
            <div class="local-import-meta-row">
              <dt>{{ i18n.ui_local_import_dir }}</dt>
              <dd :title="localImportStatus.dir">
                {{ shortPath(localImportStatus.dir) }}
              </dd>
            </div>
            <div class="local-import-meta-row">
              <dt>{{ i18n.ui_local_import_rule }}</dt>
              <dd>{{ localImportRule }}</dd>
            </div>
            <div class="local-import-meta-row">
              <dt>{{ i18n.ui_local_import_limit }}</dt>
              <dd>{{ localImportLimit }}</dd>
            </div>
            <div class="local-import-meta-row">
              <dt>{{ i18n.ui_local_import_interval }}</dt>
              <dd>{{ localImportIntervalText }}</dd>
            </div>
            <div class="local-import-meta-row">
              <dt>{{ i18n.ui_local_import_last }}</dt>
              <dd :title="lastImportedTitle">{{ lastImportedText }}</dd>
            </div>
          </dl>
          <div class="local-import-actions">
            <button
              type="button"
              class="subpage-button"
              :disabled="localImportBusy"
              @click="runLocalImport"
            >
              {{ i18n.ui_local_import_run }}
            </button>
          </div>
          <div class="local-import-message" v-if="localImportMessage">
            {{ localImportMessage }}
          </div>
        </div>
      </div>
    </section>

    <section
      class="backup-section"
      v-if="!backupDisabled && isBackupServiceSupported"
    >
      <div class="backup-section-title">{{ i18n.ui_automatic_backup }}</div>
      <div class="backup-section-desc">{{ i18n.storage_sync_info }}</div>
      <div class="backup-option-list">
        <button
          type="button"
          class="backup-option"
          @click="showInfo('WebDAVPage')"
        >
          <span class="backup-option-icon"><IconSync /></span>
          <span class="backup-option-copy">
            <span class="backup-option-title">WebDAV</span>
            <span class="backup-option-desc">{{ i18n.ui_webdav_desc }}</span>
          </span>
          <IconArrowLeft class="backup-option-arrow" />
        </button>
      </div>
    </section>

    <section class="backup-section">
      <div class="backup-section-title">{{ i18n.ui_data_management }}</div>
      <div class="backup-option-list">
        <button
          type="button"
          class="backup-option danger"
          @click="handleClearAllData"
        >
          <span class="backup-option-icon"><IconXCircle /></span>
          <span class="backup-option-copy">
            <span class="backup-option-title">
              {{ i18n.backup_clear_button || "Clear all data" }}
            </span>
            <span class="backup-option-desc">{{
              i18n.ui_clear_data_desc
            }}</span>
          </span>
          <IconArrowLeft class="backup-option-arrow" />
        </button>
      </div>
    </section>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { isChromium, isSafari } from "../../browser";
import IconArrowLeft from "../../../svg/arrow-left.svg";
import IconExchange from "../../../svg/exchange.svg";
import IconRedo from "../../../svg/redo.svg";
import IconSync from "../../../svg/sync.svg";
import IconCloudBackup from "../../../svg/cloud-backup.svg";
import IconCloudRestore from "../../../svg/cloud-sync.svg";
import IconXCircle from "../../../svg/x-circle.svg";
import { UserSettings } from "../../models/settings";
import { backupDayToMs } from "../../models/webdav";
import { quickWebDAVBackup } from "../../models/webdav-quick";
import {
  getLocalImportInterval,
  getLocalImportStatus,
  isLocalImportEnabled,
  LocalImportStatus,
  setLocalImportEnabled,
  setLocalImportInterval,
} from "../../models/local-import";

export default Vue.extend({
  components: {
    IconArrowLeft,
    IconExchange,
    IconRedo,
    IconSync,
    IconCloudBackup,
    IconCloudRestore,
    IconXCircle,
  },
  data() {
    return {
      localImportEnabled: false,
      localImportBusy: false,
      localImportMessage: "",
      localImportStatus: null as LocalImportStatus | null,
      cloudBackingUp: false,
      cloudLastBackupAt: 0,
      isDestroyed: false,
    };
  },
  async created() {
    // Register synchronously so beforeDestroy always removes the exact listener.
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
    const [enabled, status] = await Promise.all([
      isLocalImportEnabled().catch(() => false),
      getLocalImportStatus().catch(() => null),
    ]);
    if (this.isDestroyed) {
      return;
    }
    this.localImportEnabled = enabled;
    this.localImportStatus = status;
    // Prefer the millisecond stamp when the automatic backup wrote one; the
    // day ordinal is the fallback after a manual backup.
    this.cloudLastBackupAt =
      Number(UserSettings.items.webdavLastAutoBackupAt) ||
      backupDayToMs(UserSettings.items.webdavLastBackupTime);
    if (enabled) {
      await this.applyIntervalFromStatus();
    }
  },
  beforeDestroy() {
    this.isDestroyed = true;
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
  },
  computed: {
    exportDisabled(): boolean {
      return this.$store.state.menu.exportDisabled;
    },
    backupDisabled(): boolean {
      return this.$store.state.menu.backupDisabled;
    },
    isBackupServiceSupported(): boolean {
      return !isSafari;
    },
    isChromium(): boolean {
      return isChromium;
    },
    cloudBackupHint(): string {
      if (!this.cloudLastBackupAt) {
        return this.i18n.ui_cloud_sync_never;
      }
      return `${this.i18n.ui_cloud_sync_last_backup} ${new Date(
        this.cloudLastBackupAt
      ).toLocaleString()}`;
    },
    localImportStatusText(): string {
      if (!this.localImportEnabled) {
        return this.i18n.ui_local_import_disabled;
      }
      const status = this.localImportStatus;
      if (!status || !status.available) {
        return this.i18n.ui_local_import_host_missing;
      }
      if (status.pending) {
        return `${this.i18n.ui_local_import_pending}: ${status.pending.name}`;
      }
      return this.i18n.ui_local_import_waiting;
    },
    localImportRule(): string {
      const status = this.localImportStatus;
      if (!status) {
        return "";
      }
      const pattern = this.displayPattern(status.pattern);
      const files = status.fileCount ?? 0;
      if (!files) {
        return pattern;
      }
      return `${pattern} · ${files} ${this.i18n.ui_local_import_files}`;
    },
    localImportLimit(): string {
      const status = this.localImportStatus;
      if (!status) {
        return "";
      }
      const parts = [
        this.formatBytes(status.maxBytes),
        status.deleteAfterImport
          ? this.i18n.ui_local_import_delete_on
          : this.i18n.ui_local_import_keep_on,
      ];
      return parts.filter(Boolean).join(" · ");
    },
    localImportIntervalText(): string {
      const minutes = this.localImportStatus?.intervalMinutes;
      if (!minutes) {
        return "";
      }
      return `${minutes} ${this.i18n.ui_local_import_minutes}`;
    },
    lastImportedText(): string {
      const status = this.localImportStatus;
      if (!status) {
        return "";
      }
      const last = status.lastImported;
      if (last && last.name) {
        return `${last.name} · ${this.formatTime(last.at)}`;
      }
      const imported = status.importedCount ?? 0;
      if (imported > 0) {
        // Older state files only keep the digests, not the timestamps.
        return `${this.i18n.ui_local_import_unknown_time} · ${imported} ${this.i18n.ui_local_import_files}`;
      }
      return this.i18n.ui_local_import_never;
    },
    lastImportedTitle(): string {
      const at = this.localImportStatus?.lastImported?.at;
      return at ? new Date(at).toLocaleString() : "";
    },
  },
  methods: {
    cloudRestore() {
      this.$store.commit("style/openCloudRestore");
    },
    async cloudBackup() {
      if (this.cloudBackingUp) {
        return;
      }
      if (this.$store.getters["accounts/currentlyEncrypted"]) {
        this.$store.commit(
          "notification/alert",
          this.i18n.phrase_incorrect_export
        );
        return;
      }

      this.cloudBackingUp = true;
      try {
        const result = await quickWebDAVBackup(
          this.$store.getters["accounts/activeEncryption"]
        );
        if (result === "unconfigured") {
          this.$store.commit(
            "notification/alert",
            this.i18n.webdav_settings_missing
          );
          this.$emit("navigate", "WebDAVPage");
          return;
        }
        if (result === "needsPassword") {
          this.$store.commit(
            "notification/alert",
            this.i18n.backup_set_password_alert ||
              this.i18n.ui_create_password_first
          );
          return;
        }
        if (result === "denied") {
          this.$store.commit(
            "notification/alert",
            this.i18n.webdav_permission_denied
          );
          return;
        }
        if (result === "ok") {
          this.cloudLastBackupAt =
            Number(UserSettings.items.webdavLastAutoBackupAt) ||
            backupDayToMs(UserSettings.items.webdavLastBackupTime);
        }
        this.$store.commit(
          "notification/alert",
          result === "ok"
            ? this.i18n.webdav_backup_success
            : result === "timeout"
            ? this.i18n.ui_error_webdav_timeout
            : this.i18n.webdav_backup_failure
        );
      } finally {
        this.cloudBackingUp = false;
      }
    },
    onRuntimeMessage(message: { action?: string }): boolean {
      if (message?.action === "entriesUpdated" && this.localImportEnabled) {
        void this.refreshLocalImportStatus();
      }
      return false;
    },
    shortPath(path?: string): string {
      if (!path) {
        return "";
      }
      return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
    },
    // The host stores a RegExp source; show something a human can read:
    // "\\.json$" becomes "*.json". Anything fancier is shown as written.
    displayPattern(pattern?: string): string {
      if (!pattern) {
        return "*.json";
      }
      const simple = /^\\?\.([a-z0-9]+)\$$/i.exec(pattern);
      if (simple) {
        return `*.${simple[1].toLowerCase()}`;
      }
      return pattern;
    },
    formatTime(at?: number): string {
      if (!at) {
        return "";
      }
      return new Date(at).toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    formatBytes(bytes?: number): string {
      if (!bytes || bytes < 0) {
        return "";
      }
      const mb = bytes / (1024 * 1024);
      if (mb >= 1) {
        return `${Math.round(mb * 10) / 10} MB`;
      }
      return `${Math.round(bytes / 1024)} KB`;
    },
    async syncLocalImport(event: Event) {
      const enabled = (event.target as HTMLInputElement).checked;
      this.localImportEnabled = enabled;
      this.localImportMessage = "";
      // Persist from this page instead of asking the service worker to do it:
      // the switch state must survive even if messaging fails.
      try {
        await setLocalImportEnabled(enabled);
      } catch (error) {
        this.localImportMessage = this.localImportErrorText(
          error instanceof Error ? error.message : String(error)
        );
        this.localImportEnabled = !enabled;
        return;
      }

      const persisted = await isLocalImportEnabled();
      if (persisted !== enabled) {
        this.localImportEnabled = persisted;
        this.localImportMessage = `${this.i18n.ui_local_import_failed} (storage)`;
        return;
      }

      const response = await this.sendRuntimeMessage({
        action: "setLocalImport",
        enabled,
      });
      if (response.ok === false) {
        this.localImportMessage = this.localImportErrorText(response.error);
      }
      await this.refreshLocalImportStatus();
    },
    async refreshLocalImportStatus() {
      this.localImportStatus = await getLocalImportStatus();
      await this.applyIntervalFromStatus();
    },
    // The interval lives in config.json; push it to the background whenever it
    // changes so the alarm period follows the file.
    async applyIntervalFromStatus() {
      const minutes = this.localImportStatus?.intervalMinutes;
      if (!minutes) {
        return;
      }
      if ((await getLocalImportInterval()) === minutes) {
        return;
      }
      await setLocalImportInterval(minutes);
      await this.sendRuntimeMessage({
        action: "setLocalImportInterval",
        minutes,
      });
    },
    async runLocalImport() {
      if (this.localImportBusy) {
        return;
      }
      this.localImportBusy = true;
      this.localImportMessage = "";
      try {
        const response = await this.sendRuntimeMessage({
          action: "runLocalImport",
        });
        if (response.ok !== true) {
          this.localImportMessage = this.localImportErrorText(response.error);
          return;
        }
        this.localImportMessage = this.i18n.ui_local_import_done;
        await this.$store.dispatch("groups/refreshGroups");
        await this.$store.dispatch("accounts/updateEntries");
      } finally {
        this.localImportBusy = false;
        await this.refreshLocalImportStatus();
      }
    },
    sendRuntimeMessage(
      message: Record<string, unknown>
    ): Promise<{ ok?: boolean; error?: string }> {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError?.message;
          if (error) {
            // The service worker never answered (asleep, reloaded, or the
            // message was rejected); do not report this as success.
            resolve({ ok: false, error });
            return;
          }
          resolve(response || {});
        });
      });
    },
    localImportErrorText(rawCode?: string): string {
      // The background reports failures as `${Error.name}: ${message}`.
      const text = (rawCode || "").trim();
      const code = text.split(":").pop()?.trim() || "";
      switch (code) {
        case "localImportDisabled":
          return this.i18n.ui_local_import_disabled;
        case "vaultLocked":
          return this.i18n.ui_local_import_locked;
        case "localImportNoPending":
          return this.i18n.ui_local_import_none;
        case "importInProgress":
          return this.i18n.ui_local_import_busy;
        case "nativeHostUnavailable":
        case "nativeHostError":
        case "nativeHostTimeout":
          return this.i18n.ui_local_import_host_missing;
        default:
          if (!code) {
            return this.i18n.ui_local_import_failed;
          }
          // Runtime errors arrive as a full sentence; show it verbatim.
          return /\s/.test(code)
            ? `${this.i18n.ui_local_import_failed}: ${code}`
            : `${this.i18n.ui_local_import_failed} (${code})`;
      }
    },
    showInfo(tab: string) {
      if (tab === "ExportBackupPage" || tab === "WebDAVPage") {
        this.$emit("navigate", tab);
        return;
      }
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
      if (
        await this.$store.dispatch(
          "notification/confirm",
          this.i18n.backup_clear_backup_prompt
        )
      ) {
        this.$emit("navigate", "WebDAVPage");
        return;
      }
      await this.$store.dispatch("accounts/clearAllData");
      await this.$store.dispatch("accounts/updateEntries");
      this.$store.commit("notification/alert", this.i18n.backup_clear_success);
    },
  },
});
</script>
