<template>
  <div class="backup-navigation-shell">
    <div class="header">
      <div class="header-actions header-actions-left">
        <button
          type="button"
          class="header-icon"
          :title="i18n.back"
          :aria-label="i18n.back"
          @click="goBack"
        >
          <IconArrowLeft />
        </button>
      </div>
      <span class="header-title">{{ pageTitle }}</span>
    </div>

    <div id="backupPanelBody">
      <BackupPage v-if="currentPage === 'BackupPage'" @navigate="navigate" />
      <ExportBackupPage
        v-else-if="currentPage === 'ExportBackupPage'"
        :embedded="true"
      />
      <WebDAVPage
        v-else-if="currentPage === 'WebDAVPage'"
        :embedded="true"
        @navigate="navigate"
      />
      <WebDAVManagePage
        v-else-if="currentPage === 'WebDAVManagePage'"
        :embedded="true"
      />
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import IconArrowLeft from "../../../svg/arrow-left.svg";
import BackupPage from "./BackupPage.vue";
import ExportBackupPage from "./ExportBackupPage.vue";
import WebDAVPage from "./WebDAVPage.vue";
import WebDAVManagePage from "./WebDAVManagePage.vue";

export default Vue.extend({
  props: {
    active: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      currentPage: "BackupPage",
    };
  },
  computed: {
    pageTitle(): string {
      if (this.currentPage === "ExportBackupPage") {
        return this.i18n.ui_export_backup;
      }
      if (this.currentPage === "WebDAVPage") {
        return this.i18n.ui_webdav_title;
      }
      if (this.currentPage === "WebDAVManagePage") {
        return this.i18n.webdav_manage_files || "Manage backup files";
      }
      return this.i18n.ui_backup_title;
    },
  },
  watch: {
    active(value: boolean) {
      if (value) {
        // The header's cloud icon opens this panel straight on the sync page.
        this.currentPage =
          this.$store.state.style.style.backupSubPage || "BackupPage";
      }
    },
  },
  methods: {
    navigate(page: string) {
      if (
        page === "ExportBackupPage" ||
        page === "WebDAVPage" ||
        page === "WebDAVManagePage"
      ) {
        this.currentPage = page;
      }
    },
    goBack() {
      if (this.currentPage === "WebDAVManagePage") {
        this.currentPage = "WebDAVPage";
        return;
      }
      if (this.currentPage !== "BackupPage") {
        this.currentPage = "BackupPage";
        return;
      }
      this.$store.commit("style/hideBackupPanel");
    },
  },
  components: {
    IconArrowLeft,
    BackupPage,
    ExportBackupPage,
    WebDAVPage,
    WebDAVManagePage,
  },
});
</script>
