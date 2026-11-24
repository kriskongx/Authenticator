<template>
  <div>
    <h2>{{ i18n.delete_all }}</h2>
    <p>{{ i18n.delete_all_warning }}</p>
    <input type="checkbox" id="checkbox" v-model="deleteConfirm" />
    <label for="checkbox">{{ i18n.confirm_delete_all }}</label>
    <br />
    <br />
    <button
      type="button"
      v-on:click="deleteEverything()"
      v-bind:disabled="!deleteConfirm || isDeleting"
    >
      {{ i18n.delete_all }}
    </button>
    <br />
    <p v-show="deleteComplete">{{ i18n.updateSuccess }}</p>
    <p v-show="deleteError">{{ deleteError }}</p>
  </div>
</template>
<script lang="ts">
import Vue from "vue";

export default Vue.extend({
  data: function () {
    return {
      deleteConfirm: false,
      deleteComplete: false,
      isDeleting: false,
      deleteError: "",
    };
  },
  methods: {
    async deleteEverything() {
      if (this.isDeleting) {
        return;
      }
      this.isDeleting = true;
      this.deleteError = "";
      this.deleteComplete = false;
      try {
        await chrome.storage.sync.clear();
        await chrome.storage.local.clear();
        localStorage.clear();
        await new Promise<void>((resolve) => {
          chrome.runtime.sendMessage({ action: "lock" }, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        });
        chrome.runtime.sendMessage({ action: "entriesUpdated" }, () => {
          void chrome.runtime.lastError;
        });
        this.deleteConfirm = false;
        this.deleteComplete = true;
      } catch (error) {
        console.error("Failed to delete all data:", error);
        this.deleteError = this.i18n.updateFailure || "Update failed.";
      } finally {
        this.isDeleting = false;
      }
    },
  },
});
</script>
