<template>
  <div>
    <!-- MESSAGE -->
    <div
      class="message-box"
      role="alertdialog"
      aria-modal="true"
      v-show="alertOpen"
      @keydown.esc.stop.prevent="closeAlert()"
    >
      <div class="notification-dialog-message">
        {{ message.length ? message[0] : "" }}
      </div>
      <div class="notification-dialog-actions">
        <button
          ref="alertOkButton"
          type="button"
          class="subpage-button primary"
          @click="closeAlert()"
        >
          {{ i18n.ok }}
        </button>
      </div>
    </div>

    <!-- CONFIRM -->
    <div
      class="message-box"
      role="alertdialog"
      aria-modal="true"
      v-show="confirmOpen"
      @keydown.esc.stop.prevent="confirmCancel()"
    >
      <div class="notification-dialog-message">{{ confirmMessage }}</div>
      <div class="notification-dialog-actions">
        <button
          ref="confirmCancelButton"
          type="button"
          class="subpage-button"
          @click="confirmCancel()"
        >
          {{ i18n.no }}
        </button>
        <button
          type="button"
          class="subpage-button primary"
          @click="confirmOK()"
        >
          {{ i18n.yes }}
        </button>
      </div>
    </div>

    <!-- OVERLAY -->
    <div
      id="overlay"
      class="notification-overlay"
      v-show="alertOpen || confirmOpen"
    ></div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";

export default Vue.extend({
  data() {
    return {
      previousFocus: null as HTMLElement | null,
    };
  },
  computed: {
    message(): string[] {
      return this.$store.state.notification.message;
    },
    messageIdle(): boolean {
      return this.$store.state.notification.messageIdle;
    },
    confirmMessage(): string {
      return this.$store.state.notification.confirmMessage;
    },
    alertOpen(): boolean {
      return Boolean(this.message.length && this.messageIdle);
    },
    confirmOpen(): boolean {
      return this.confirmMessage !== "";
    },
    dialogOpen(): boolean {
      return this.alertOpen || this.confirmOpen;
    },
  },
  watch: {
    dialogOpen(isOpen: boolean, wasOpen: boolean) {
      if (isOpen && !wasOpen) {
        this.previousFocus =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        this.focusActiveDialog();
      } else if (!isOpen && wasOpen) {
        this.previousFocus?.focus?.();
        this.previousFocus = null;
      }
    },
    alertOpen(isOpen: boolean) {
      if (isOpen) {
        this.focusActiveDialog();
      }
    },
    confirmOpen(isOpen: boolean) {
      if (isOpen) {
        this.focusActiveDialog();
      }
    },
  },
  methods: {
    focusActiveDialog() {
      this.$nextTick(() => {
        if (this.confirmOpen) {
          (this.$refs.confirmCancelButton as
            | HTMLElement
            | undefined)?.focus?.();
        } else if (this.alertOpen) {
          (this.$refs.alertOkButton as HTMLElement | undefined)?.focus?.();
        }
      });
    },
    closeAlert() {
      this.$store.commit("notification/closeAlert");
    },
    confirmOK() {
      this.$store.commit("notification/resolveConfirm", true);
    },
    confirmCancel() {
      this.$store.commit("notification/resolveConfirm", false);
    },
  },
});
</script>
