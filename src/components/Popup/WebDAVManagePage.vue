<template>
  <div class="subpage webdav-page webdav-manage-page">
    <div class="subpage-head" v-if="!embedded">
      <div class="subpage-title">
        {{ i18n.webdav_manage_files || "Manage backup files" }}
      </div>
      <div class="subpage-subtitle">
        {{
          i18n.webdav_manage_files_desc ||
          "Download or delete backup files stored on your WebDAV server"
        }}
      </div>
    </div>

    <section class="subpage-section">
      <div class="subpage-section-head">
        <div class="subpage-section-title">
          {{ i18n.webdav_manage_files || "Manage backup files" }}
        </div>
      </div>
      <div class="subpage-section-desc">
        {{
          i18n.webdav_manage_files_desc ||
          "Download or delete backup files stored on your WebDAV server"
        }}
      </div>
      <div class="subpage-list-card webdav-file-manager">
        <div class="webdav-file-toolbar">
          <button
            type="button"
            class="subpage-button"
            :disabled="!webdav.files.length || isManagingWebDAVFiles"
            @click="toggleAllWebDAVFiles"
          >
            {{
              allWebDAVFilesSelected
                ? i18n.deselect_all || "Deselect all"
                : i18n.select_all || "Select all"
            }}
          </button>
          <button
            type="button"
            class="subpage-button"
            :disabled="webdav.isLoadingList || isManagingWebDAVFiles"
            @click="refreshWebDAVList"
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
            :disabled="!webdav.selectedFiles.length || isManagingWebDAVFiles"
            @click="downloadSelectedWebDAVFiles"
          >
            {{
              webdav.isDownloadingFiles
                ? i18n.webdav_downloading_files || "Downloading"
                : i18n.webdav_download_selected || "Download selected"
            }}
          </button>
          <button
            type="button"
            class="subpage-button danger"
            :disabled="!webdav.selectedFiles.length || isManagingWebDAVFiles"
            @click="deleteSelectedWebDAVFiles"
          >
            {{
              webdav.isDeletingFiles
                ? i18n.webdav_deleting_files || "Deleting"
                : i18n.webdav_delete_selected || "Delete selected"
            }}
          </button>
        </div>
        <div class="webdav-file-status" v-if="webdav.selectedFiles.length">
          {{ selectedFilesLabel }}
        </div>

        <div class="webdav-file-list" v-if="webdav.files.length">
          <div
            :class="{
              'subpage-row': true,
              'webdav-file-row': true,
              'is-selected': webdav.selectedFiles.includes(file.name),
            }"
            v-for="file in webdav.files"
            :key="file.name"
            role="button"
            tabindex="0"
            :aria-pressed="
              webdav.selectedFiles.includes(file.name) ? 'true' : 'false'
            "
            @click="toggleWebDAVFile(file)"
            @keydown.enter.prevent="toggleWebDAVFile(file)"
            @keydown.space.prevent="toggleWebDAVFile(file)"
            @keydown.delete.stop.prevent="deleteSingleWebDAVFile(file)"
          >
            <label class="webdav-file-select" @click.stop>
              <input
                type="checkbox"
                :value="file.name"
                v-model="webdav.selectedFiles"
                :disabled="isManagingWebDAVFiles"
              />
              <span
                :class="{
                  'webdav-file-checkbox': true,
                  checked: webdav.selectedFiles.includes(file.name),
                }"
              >
                <IconCheck v-if="webdav.selectedFiles.includes(file.name)" />
              </span>
            </label>
            <div class="webdav-file-copy">
              <div class="webdav-file-title" :title="getWebDAVFileName(file)">
                {{ getWebDAVFileName(file) }}
              </div>
              <div class="webdav-file-meta">
                {{ formatWebDAVFileMeta(file) }}
              </div>
            </div>
            <div class="webdav-file-actions" @click.stop>
              <button
                type="button"
                class="subpage-button"
                :disabled="isManagingWebDAVFiles"
                @click="downloadSingleWebDAVFile(file)"
              >
                {{ i18n.webdav_download_file || "Download" }}
              </button>
              <button
                type="button"
                class="subpage-button danger"
                :disabled="isManagingWebDAVFiles"
                @click="deleteSingleWebDAVFile(file)"
              >
                {{ i18n.delete || "Delete" }}
              </button>
            </div>
          </div>
        </div>

        <div class="subpage-empty webdav-file-empty" v-else>
          <span class="subpage-row-icon neutral"><IconDatabase /></span>
          <span class="subpage-empty-title">
            {{
              webdav.message || i18n.webdav_no_files || "No backup files found"
            }}
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<script lang="ts">
import Vue from "vue";
import IconCheck from "../../../svg/check.svg";
import IconDatabase from "../../../svg/database.svg";
import { MAX_BACKUP_CONTENT_BYTES } from "../../models/import-limits";
import {
  deleteWebDAVBackup,
  downloadWebDAVBackup,
  getWebDAVConfig,
  getWebDAVOrigin,
  listWebDAVBackups,
  type WebDAVConfig,
  type WebDAVFile,
} from "../../models/webdav";

export default Vue.extend({
  props: {
    embedded: {
      type: Boolean,
      default: false,
    },
  },
  components: {
    IconCheck,
    IconDatabase,
  },
  data() {
    return {
      webdav: {
        config: {
          url: "",
          username: "",
          password: "",
          encrypted: true,
        } as WebDAVConfig,
        files: [] as WebDAVFile[],
        selectedFiles: [] as string[],
        isLoadingList: false,
        isDownloadingFiles: false,
        isDeletingFiles: false,
        message: "",
      },
    };
  },
  created() {
    this.loadWebDAVSettings();
  },
  computed: {
    selectedWebDAVFiles(): WebDAVFile[] {
      const selectedNames = new Set(this.webdav.selectedFiles);
      return this.webdav.files.filter((file) => selectedNames.has(file.name));
    },
    allWebDAVFilesSelected(): boolean {
      return (
        this.webdav.files.length > 0 &&
        this.webdav.selectedFiles.length === this.webdav.files.length
      );
    },
    selectedFilesLabel(): string {
      return this.formatCountMessage(
        this.i18n.webdav_selected_count,
        this.webdav.selectedFiles.length,
        `${this.webdav.selectedFiles.length} ${
          this.i18n.ui_selected || "Selected"
        }`
      );
    },
    isManagingWebDAVFiles(): boolean {
      return (
        this.webdav.isLoadingList ||
        this.webdav.isDownloadingFiles ||
        this.webdav.isDeletingFiles
      );
    },
  },
  methods: {
    async loadWebDAVSettings() {
      this.webdav.config = await getWebDAVConfig();
      await this.refreshWebDAVList(true);
    },
    async refreshWebDAVList(silent = false) {
      if (!(await this.ensureWebDAVReady())) {
        return;
      }
      this.webdav.isLoadingList = true;
      if (!silent) {
        this.webdav.message = this.i18n.webdav_loading_files;
      }
      try {
        this.webdav.files = [];
        const files = await listWebDAVBackups();
        this.webdav.files = files;
        this.syncWebDAVFileSelection(files);
        this.webdav.message = files.length
          ? ""
          : this.i18n.webdav_no_files || "No backup files found";
      } catch (error) {
        this.webdav.message =
          this.i18n.webdav_fetch_failed || "Failed to load WebDAV backups";
      } finally {
        this.webdav.isLoadingList = false;
      }
    },
    toggleAllWebDAVFiles() {
      this.webdav.selectedFiles = this.allWebDAVFilesSelected
        ? []
        : this.webdav.files.map((file) => file.name);
    },
    toggleWebDAVFile(file: WebDAVFile) {
      if (this.isManagingWebDAVFiles) {
        return;
      }
      if (this.webdav.selectedFiles.includes(file.name)) {
        this.webdav.selectedFiles = this.webdav.selectedFiles.filter(
          (name) => name !== file.name
        );
        return;
      }
      this.webdav.selectedFiles = [...this.webdav.selectedFiles, file.name];
    },
    syncWebDAVFileSelection(files: WebDAVFile[]) {
      const availableNames = new Set(files.map((file) => file.name));
      this.webdav.selectedFiles = this.webdav.selectedFiles.filter((name) =>
        availableNames.has(name)
      );
    },
    async downloadSingleWebDAVFile(file: WebDAVFile) {
      await this.downloadWebDAVFiles([file]);
    },
    async downloadSelectedWebDAVFiles() {
      await this.downloadWebDAVFiles(this.selectedWebDAVFiles);
    },
    async downloadWebDAVFiles(files: WebDAVFile[]) {
      if (!files.length || !(await this.ensureWebDAVReady())) {
        return;
      }
      this.webdav.isDownloadingFiles = true;
      let downloadedCount = 0;
      try {
        for (const file of files) {
          if (file.size && file.size > MAX_BACKUP_CONTENT_BYTES) {
            throw new Error("backupContentTooLarge");
          }
          const content = await downloadWebDAVBackup(file.name);
          this.saveWebDAVFileLocally(file, content);
          downloadedCount++;
        }
        this.notify(
          this.formatCountMessage(
            this.i18n.webdav_download_success,
            downloadedCount,
            `${downloadedCount} backup file(s) downloaded`
          )
        );
      } catch (error) {
        const message = (error as Error).message;
        this.notify(
          message === "backupContentTooLarge"
            ? this.i18n.ui_error_backup_too_large
            : this.i18n.webdav_download_failure ||
                "Failed to download backup file"
        );
      } finally {
        this.webdav.isDownloadingFiles = false;
      }
    },
    saveWebDAVFileLocally(file: WebDAVFile, content: string) {
      const blob = new Blob([content], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = this.getWebDAVDownloadFileName(file);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    async deleteSingleWebDAVFile(file: WebDAVFile) {
      await this.deleteWebDAVFiles([file]);
    },
    async deleteSelectedWebDAVFiles() {
      await this.deleteWebDAVFiles(this.selectedWebDAVFiles);
    },
    async deleteWebDAVFiles(files: WebDAVFile[]) {
      if (!files.length || !(await this.ensureWebDAVReady())) {
        return;
      }
      const confirmed = await this.$store.dispatch(
        "notification/confirm",
        this.formatCountMessage(
          this.i18n.webdav_delete_confirm,
          files.length,
          `Delete ${files.length} backup file(s)?`
        )
      );
      if (!confirmed) {
        return;
      }
      this.webdav.isDeletingFiles = true;
      let deletedCount = 0;
      try {
        for (const file of files) {
          if (await deleteWebDAVBackup(file.name)) {
            deletedCount++;
          }
        }
        await this.refreshWebDAVList(true);
        if (deletedCount === files.length) {
          this.notify(
            this.formatCountMessage(
              this.i18n.webdav_delete_success,
              deletedCount,
              `${deletedCount} backup file(s) deleted`
            )
          );
        } else {
          this.notify(
            this.i18n.webdav_delete_failure || "Failed to delete backup file"
          );
        }
      } catch (error) {
        this.notify(
          this.i18n.webdav_delete_failure || "Failed to delete backup file"
        );
      } finally {
        this.webdav.isDeletingFiles = false;
      }
    },
    validateWebDAVFields() {
      return (
        this.webdav.config.url.trim() &&
        this.webdav.config.username.trim() &&
        this.webdav.config.password
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
      return true;
    },
    ensureWebDAVPermission(): Promise<boolean> {
      return new Promise((resolve) => {
        const origin = getWebDAVOrigin(this.webdav.config.url);
        if (!origin) {
          this.notify(this.i18n.webdav_invalid_url);
          resolve(false);
          return;
        }
        chrome.permissions.request({ origins: [origin] }, (granted) => {
          if (!granted) {
            this.notify(this.i18n.webdav_permission_denied);
          }
          resolve(Boolean(granted));
        });
      });
    },
    formatWebDAVFileMeta(file: WebDAVFile) {
      const meta: string[] = [];
      if (file.size && file.size > 0) {
        meta.push(this.formatBytes(file.size));
      }
      if (file.lastModified) {
        meta.push(new Date(file.lastModified).toLocaleString());
      }
      return meta.join(" · ") || this.i18n.webdav_file_meta_empty || "No details";
    },
    getWebDAVDownloadFileName(file: WebDAVFile) {
      return this.getWebDAVFileName(file);
    },
    getWebDAVFileName(file: WebDAVFile) {
      return file.name.split("/").pop() || file.displayName || "backup.json";
    },
    formatCountMessage(message: string, count: number, fallback: string) {
      return message ? message.replace("{count}", String(count)) : fallback;
    },
    removeTrailingPeriods(message: string) {
      return message ? message.trim().replace(/[.。]+$/g, "") : message;
    },
    formatBytes(bytes: number) {
      if (!bytes) {
        return "0 B";
      }
      const sizes = ["B", "KB", "MB", "GB"];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      const value = bytes / Math.pow(1024, i);
      return `${value.toFixed(1)} ${sizes[i]}`;
    },
    notify(message: string) {
      this.$store.commit(
        "notification/alert",
        this.removeTrailingPeriods(message)
      );
    },
  },
});
</script>
