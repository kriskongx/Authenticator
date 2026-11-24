<template>
  <div class="cloud-restore-panel">
    <div class="cloud-restore-desc">
      {{ pendingFile ? i18n.ui_cloud_sync_restore_confirm : listHint }}
    </div>

    <template v-if="pendingFile">
      <div class="cloud-restore-target">
        <span class="backup-option-icon"><IconSync /></span>
        <span class="backup-option-copy">
          <span class="backup-option-title" :title="pendingFile.displayName">{{
            fileLabel(pendingFile)
          }}</span>
          <span class="backup-option-desc">{{ fileMeta(pendingFile) }}</span>
        </span>
      </div>
      <div class="webdav-transfer-progress" v-if="restoring">
        <div class="webdav-transfer-progress-head">
          <span>{{ restoreLabel }}</span>
          <span>{{ restoreProgress }}%</span>
        </div>
        <div
          class="webdav-transfer-progress-track"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="restoreProgress"
        >
          <span
            class="webdav-transfer-progress-fill"
            :style="{ width: restoreProgress + '%' }"
          ></span>
        </div>
      </div>

      <div class="cloud-restore-confirm-actions">
        <button
          type="button"
          class="subpage-button"
          :disabled="restoring"
          @click="cancelPendingRestore"
        >
          {{ i18n.cancel }}
        </button>
        <button
          type="button"
          class="subpage-button primary"
          :disabled="restoring"
          @click="runRestore"
        >
          {{
            restoring ? i18n.ui_cloud_sync_restoring : i18n.webdav_card_restore
          }}
        </button>
      </div>
    </template>

    <template v-else>
      <div class="cloud-restore-actions" v-if="needsSetup">
        <button type="button" class="subpage-button primary" @click="openSetup">
          {{ i18n.ui_cloud_sync_configure }}
        </button>
      </div>

      <div class="cloud-restore-actions" v-else-if="needsPermission">
        <button
          type="button"
          class="subpage-button primary"
          @click="grantAccess"
        >
          {{ i18n.ui_cloud_sync_grant }}
        </button>
      </div>

      <div class="backup-option-list" v-else>
        <button
          v-for="file in files"
          :key="file.name"
          type="button"
          class="backup-option"
          :disabled="restoring"
          @click="pendingFile = file"
        >
          <span class="backup-option-icon"><IconSync /></span>
          <span class="backup-option-copy">
            <span class="backup-option-title" :title="file.displayName">{{
              fileLabel(file)
            }}</span>
            <span class="backup-option-desc">{{ fileMeta(file) }}</span>
          </span>
          <IconArrowLeft class="backup-option-arrow" />
        </button>
        <div class="cloud-sync-empty" v-if="!files.length && !loading">
          {{ i18n.webdav_no_files }}
        </div>
      </div>

      <label class="webdav-toggle-field" v-if="!needsSetup">
        <span class="subpage-row-copy">
          <span class="subpage-row-title">{{
            i18n.webdav_clear_before_restore
          }}</span>
          <span class="subpage-row-desc">{{
            i18n.webdav_clear_before_restore_desc
          }}</span>
        </span>
        <span class="subpage-switch">
          <input
            type="checkbox"
            v-model="clearBeforeRestore"
            @change="updateClearPreference"
          />
          <span class="subpage-switch-track"></span>
        </span>
      </label>
    </template>

    <div class="cloud-restore-actions" v-if="!needsSetup && !pendingFile">
      <button
        type="button"
        class="subpage-button"
        :disabled="loading || restoring"
        @click="loadFiles"
      >
        {{ loading ? i18n.webdav_loading_files : i18n.webdav_refresh_list }}
      </button>
    </div>

    <div
      class="subpage-dialog-backdrop"
      v-if="passphraseOpen"
      role="presentation"
      @click.self="cancelPassphrase"
      @keydown.esc.stop.prevent="cancelPassphrase"
    >
      <form
        class="subpage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloudRestorePassphraseTitle"
        @submit.prevent="submitPassphrase"
      >
        <div class="subpage-dialog-title" id="cloudRestorePassphraseTitle">
          {{ i18n.ui_backup_password_title }}
        </div>
        <div class="subpage-dialog-desc">
          {{ i18n.webdav_restore_passphrase_prompt }}
        </div>
        <label class="subpage-field">
          <span class="subpage-field-label">{{ i18n.phrase }}</span>
          <input
            ref="passphrase"
            class="subpage-text-input"
            type="password"
            v-model="passphrase"
            autocomplete="current-password"
          />
        </label>
        <div class="subpage-actions">
          <button
            type="button"
            class="subpage-button"
            @click="cancelPassphrase"
          >
            {{ i18n.cancel }}
          </button>
          <button type="submit" class="subpage-button primary">
            {{ i18n.ok }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import IconArrowLeft from "../../../svg/arrow-left.svg";
import IconSync from "../../../svg/sync.svg";
import { MAX_BACKUP_CONTENT_BYTES } from "../../models/import-limits";
import { restoreBackupContent } from "../../models/backup-restore";
import { UserSettings } from "../../models/settings";
import {
  downloadWebDAVBackup,
  getWebDAVConfig,
  getWebDAVOrigin,
  listWebDAVBackups,
  type WebDAVFile,
} from "../../models/webdav";

export default Vue.extend({
  components: { IconArrowLeft, IconSync },
  data() {
    return {
      files: [] as WebDAVFile[],
      loading: false,
      needsPermission: false,
      needsSetup: false,
      restoring: false,
      restoreProgress: 0,
      restoreLabel: "",
      pendingFile: null as WebDAVFile | null,
      clearBeforeRestore: false,
      passphraseOpen: false,
      passphrase: "",
      passphraseResolver: null as ((value: string | null) => void) | null,
    };
  },
  async created() {
    this.clearBeforeRestore = Boolean(
      UserSettings.items.webdavClearBeforeRestore
    );
    const config = await getWebDAVConfig();
    if (!config.url || !config.username || !config.password) {
      this.needsSetup = true;
      return;
    }
    if (await this.ensurePermission(false)) {
      await this.loadFiles();
    } else {
      this.needsPermission = true;
    }
  },
  computed: {
    listHint(): string {
      if (this.restoring) {
        return this.i18n.ui_cloud_sync_restoring;
      }
      if (!this.files.length) {
        return this.i18n.ui_cloud_sync_restore_desc;
      }
      return `${this.files.length} ${this.i18n.ui_backups_found}`;
    },
  },
  methods: {
    updateClearPreference() {
      UserSettings.items.webdavClearBeforeRestore = this.clearBeforeRestore;
      UserSettings.commitItems();
    },
    notify(message: string) {
      this.$store.commit("notification/alert", message);
    },
    // Backups share a long prefix (`authenticator-mac-encrypted-`); the
    // timestamp is what actually tells them apart, so show that and keep the
    // full name in the tooltip.
    fileLabel(file: WebDAVFile): string {
      const match = /^(.*?)(\d{4}-\d{2}-\d{2}T.*)$/.exec(file.name);
      return match && match[1] ? match[2] : file.displayName;
    },
    fileMeta(file: WebDAVFile): string {
      const parts: string[] = [];
      if (file.lastModified) {
        parts.push(new Date(file.lastModified).toLocaleString());
      }
      if (file.size) {
        parts.push(this.formatBytes(file.size));
      }
      return parts.join(" · ");
    },
    formatBytes(bytes: number): string {
      const sizes = ["B", "KB", "MB", "GB"];
      const index = Math.floor(Math.log(bytes) / Math.log(1024));
      const value = bytes / Math.pow(1024, index);
      return `${value.toFixed(1)} ${sizes[index]}`;
    },
    async ensurePermission(interactive = true): Promise<boolean> {
      const config = await getWebDAVConfig();
      const origin = getWebDAVOrigin(config.url);
      if (!origin) {
        if (interactive) {
          this.notify(this.i18n.webdav_invalid_url);
        }
        return false;
      }
      const contained = await new Promise<boolean>((resolve) => {
        chrome.permissions.contains({ origins: [origin] }, (granted) =>
          resolve(Boolean(granted))
        );
      });
      if (contained || !interactive) {
        return contained;
      }
      // chrome.permissions.request needs a user gesture, so this branch only
      // runs from a click handler.
      const granted = await new Promise<boolean>((resolve) => {
        try {
          chrome.permissions.request({ origins: [origin] }, (result) =>
            resolve(Boolean(result))
          );
        } catch {
          resolve(false);
        }
      });
      if (!granted) {
        this.notify(this.i18n.webdav_permission_denied);
      }
      return granted;
    },
    openSetup() {
      this.$store.commit("style/closeCloudRestore");
      this.$store.commit("style/showBackupPanel", "WebDAVPage");
    },
    async grantAccess() {
      if (await this.ensurePermission(true)) {
        this.needsPermission = false;
        await this.loadFiles();
      }
    },
    async loadFiles() {
      if (this.loading) {
        return;
      }
      this.loading = true;
      try {
        if (!(await this.ensurePermission(true))) {
          this.needsPermission = true;
          return;
        }
        this.needsPermission = false;
        this.files = await listWebDAVBackups();
      } catch (error) {
        this.files = [];
        this.notify(
          (error as Error).message === "webdavTimeout"
            ? this.i18n.ui_error_webdav_timeout
            : this.i18n.webdav_connection_failure
        );
      } finally {
        this.loading = false;
      }
    },
    cancelPendingRestore() {
      this.pendingFile = null;
    },
    async runRestore() {
      const file = this.pendingFile;
      if (!file || this.restoring) {
        return;
      }
      if (this.$store.getters["accounts/currentlyEncrypted"]) {
        this.notify(this.i18n.import_error_password);
        return;
      }
      if (file.size && file.size > MAX_BACKUP_CONTENT_BYTES) {
        this.notify(this.i18n.ui_error_backup_too_large);
        return;
      }
      const encryption = this.$store.getters["accounts/activeEncryption"];
      if (!encryption) {
        this.notify(this.i18n.import_error_password);
        return;
      }
      this.restoring = true;
      this.restoreProgress = 2;
      this.restoreLabel = this.i18n.ui_progress_downloading_backup;
      try {
        // The list is only visible with permission already granted, so no
        // gesture-dependent permission prompt is needed here.
        const content = await downloadWebDAVBackup(file.name, {
          onDownloadProgress: (loadedBytes, totalBytes) => {
            const ratio = totalBytes
              ? loadedBytes / totalBytes
              : loadedBytes / MAX_BACKUP_CONTENT_BYTES;
            this.restoreProgress = Math.min(
              42,
              Math.round(3 + Math.min(1, ratio) * 39)
            );
          },
        });
        await restoreBackupContent({
          content,
          encryption,
          clearFirst: this.clearBeforeRestore,
          requestPassphrase: () => this.askPassphrase(),
          onProgress: (value, key) => {
            this.restoreProgress = Math.max(
              0,
              Math.min(100, Math.round(value))
            );
            this.restoreLabel = this.i18n[key] || key;
          },
          refresh: async () => {
            await this.$store.dispatch("groups/refreshGroups");
            await this.$store.dispatch("accounts/updateEntries");
          },
        });
        this.restoreProgress = 100;
        this.restoreLabel = this.i18n.webdav_restore_success;
        this.notify(this.i18n.webdav_restore_success);
        this.$emit("restored", file.name);
      } catch (error) {
        const message = (error as Error).message;
        if (message === "cancelled") {
          this.notify(this.i18n.webdav_restore_cancelled);
        } else if (message === "incorrectPassphrase") {
          this.notify(this.i18n.ui_incorrect_backup_password);
        } else if (message === "parseError" || message === "noImportableEntries") {
          this.notify(this.i18n.webdav_restore_parse_error);
        } else if (message === "backupContentTooLarge") {
          this.notify(this.i18n.ui_error_backup_too_large);
        } else if (message === "webdavTimeout") {
          this.notify(this.i18n.ui_error_webdav_timeout);
        } else {
          this.notify(this.i18n.webdav_restore_failure);
        }
      } finally {
        this.restoring = false;
        this.pendingFile = null;
      }
    },
    askPassphrase(): Promise<string | null> {
      this.passphrase = "";
      this.passphraseOpen = true;
      this.$nextTick(() => {
        const input = this.$refs.passphrase as HTMLInputElement | undefined;
        input?.focus();
      });
      return new Promise((resolve) => {
        this.passphraseResolver = resolve;
      });
    },
    submitPassphrase() {
      const resolver = this.passphraseResolver;
      if (!resolver) {
        return;
      }
      const value = this.passphrase.trim();
      if (!value) {
        return;
      }
      this.passphraseResolver = null;
      this.passphraseOpen = false;
      this.passphrase = "";
      resolver(value);
    },
    cancelPassphrase() {
      const resolver = this.passphraseResolver;
      this.passphraseResolver = null;
      this.passphraseOpen = false;
      this.passphrase = "";
      resolver?.(null);
    },
  },
});
</script>
