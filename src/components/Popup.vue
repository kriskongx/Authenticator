<template>
  <div
    v-cloak
    v-bind:class="{
      'theme-normal':
        theme !== 'accessibility' &&
        theme !== 'dark' &&
        theme !== 'simple' &&
        theme !== 'compact' &&
        theme !== 'flat',
      'theme-accessibility': theme === 'accessibility',
      'theme-dark': theme === 'dark',
      'theme-simple': theme === 'simple',
      'theme-compact': theme === 'compact',
      'theme-flat': theme === 'flat',
      hideoutline,
    }"
    v-on:mousedown="hideoutline = true"
    v-on:keydown="hideoutline = false"
  >
    <MainHeader />
    <MainBody
      v-bind:class="{
        timeout: style.timeout,
      }"
    />

    <MenuPage
      id="menu"
      v-show="style.slidein || style.slideout"
      v-bind:class="{ slidein: style.slidein, slideout: style.slideout }"
    />

    <BackupNavigationPage
      id="backupPanel"
      v-show="style.backupSlidein || style.backupSlideout"
      :active="style.backupSlidein"
      v-bind:class="{
        slidein: style.backupSlidein,
        slideout: style.backupSlideout,
      }"
    />

    <CloudRestoreDialog />

    <PageHandler
      v-bind:class="{
        fadein: style.fadein,
        fadeout: style.fadeout,
        show: style.show,
      }"
    />

    <NotificationHandler />

    <!-- EPHERMAL MESSAGE -->
    <div
      id="notification"
      v-bind:class="{
        fadein: style.notificationFadein,
        fadeout: style.notificationFadeout,
      }"
    >
      {{ notification }}
    </div>

    <!-- QR -->
    <div
      id="qr"
      v-bind:class="{ qrfadein: style.qrfadein, qrfadeout: style.qrfadeout }"
      v-bind:style="{ 'background-image': qr }"
      v-on:click="hideQr()"
    ></div>

    <!-- CLIPBOARD -->
    <input type="text" id="codeClipboard" tabindex="-1" />
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { mapState } from "vuex";

import MainHeader from "./Popup/MainHeader.vue";
import MainBody from "./Popup/MainBody.vue";
import MenuPage from "./Popup/MenuPage.vue";
import BackupNavigationPage from "./Popup/BackupNavigationPage.vue";
import CloudRestoreDialog from "./Popup/CloudRestoreDialog.vue";
import PageHandler from "./Popup/PageHandler.vue";
import NotificationHandler from "./Popup/NotificationHandler.vue";

const computedPrototype = [
  mapState("style", ["style"]),
  mapState("menu", ["theme"]),
  mapState("qr", ["qr"]),
  mapState("notification", ["notification"]),
];

let computed = {};

for (const module of computedPrototype) {
  Object.assign(computed, module);
}

export default Vue.extend({
  data: function () {
    return {
      hideoutline: true,
    };
  },
  computed,
  created() {
    chrome.runtime.onMessage.addListener(this.onRuntimeMessage);
  },
  beforeDestroy() {
    chrome.runtime.onMessage.removeListener(this.onRuntimeMessage);
  },
  methods: {
    // The service worker can import a backup on behalf of an external caller
    // while this popup is open; refresh in place instead of asking the user to
    // reopen it.
    onRuntimeMessage(message: { action?: string }): boolean {
      if (message?.action !== "entriesUpdated") {
        return false;
      }
      void this.$store.dispatch("accounts/updateEntries");
      void this.$store.dispatch("groups/refreshGroups");
      return false;
    },
    hideQr() {
      this.$store.commit("style/hideQr");
    },
  },
  components: {
    MainHeader,
    MainBody,
    MenuPage,
    BackupNavigationPage,
    CloudRestoreDialog,
    PageHandler,
    NotificationHandler,
  },
});
</script>
