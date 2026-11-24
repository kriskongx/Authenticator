<template>
  <div
    class="subpage-dialog-backdrop cloud-restore-backdrop"
    v-if="open"
    role="presentation"
    @click.self="close"
    @keydown.esc.stop.prevent="close"
  >
    <div
      class="subpage-dialog cloud-restore-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cloudRestoreTitle"
    >
      <div class="cloud-restore-head">
        <span class="subpage-dialog-title" id="cloudRestoreTitle">
          {{ i18n.ui_cloud_restore_title }}
        </span>
        <button
          type="button"
          class="cloud-restore-close"
          :title="i18n.close"
          :aria-label="i18n.close"
          @click="close"
        >
          <IconXCircle />
        </button>
      </div>
      <CloudRestorePanel @restored="close" />
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import IconXCircle from "../../../svg/x-circle.svg";
import CloudRestorePanel from "./CloudRestorePanel.vue";

export default Vue.extend({
  components: { CloudRestorePanel, IconXCircle },
  computed: {
    open(): boolean {
      // Style is a namespaced module whose state is itself wrapped in `style`.
      return this.$store.state.style.style.cloudRestoreOpen;
    },
  },
  methods: {
    close() {
      this.$store.commit("style/closeCloudRestore");
    },
  },
});
</script>
