<template>
  <div class="subpage unlock-page" v-on:keydown.stop>
    <div class="unlock-hero">
      <span class="unlock-badge"><IconLock /></span>
      <div class="unlock-title">{{ i18n.ui_master_password }}</div>
      <div class="unlock-subtitle">
        {{
          unresolvedKeyCount > 0
            ? i18n.ui_additional_password_required
            : i18n.passphrase_info
        }}
      </div>
    </div>

    <div class="unlock-form">
      <input
        ref="password"
        class="subpage-text-input unlock-input"
        type="password"
        v-model="password"
        autocomplete="current-password"
        :placeholder="i18n.ui_master_password"
        :aria-label="i18n.ui_master_password"
        @keyup.enter="applyPassphrase"
      />
      <button
        type="button"
        class="subpage-button primary unlock-submit"
        @click="applyPassphrase"
      >
        {{ i18n.ok }}
      </button>
      <button
        v-if="biometricEnabled"
        type="button"
        class="unlock-link"
        :disabled="biometricBusy"
        @click="unlockWithBiometrics"
      >
        {{ i18n.biometric_unlock_button }}
      </button>
      <div class="unlock-message" v-show="wrongPassword">
        {{ i18n.phrase_not_match }}
      </div>
      <div class="unlock-message" v-show="biometricError">
        {{ biometricError }}
      </div>
      <div class="unlock-hint" v-show="unresolvedKeyCount > 0">
        {{ i18n.ui_remaining_encryption_keys }}: {{ unresolvedKeyCount }}
      </div>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import IconLock from "../../../svg/lock.svg";
import { describeError } from "../../errors";
import {
  BiometricUnlockBundle,
  cacheBiometricUnlockBundle,
  clearAutoBiometricPromptSkip,
  isAutoBiometricPromptSkipped,
  readBiometricUnlockRecord,
  skipAutoBiometricPrompt,
  unlockWithBiometricRecord,
  WebAuthnUnlockRecord,
} from "../../models/biometric-unlock";
import { openBiometricWindow } from "../../models/biometric-window";

// A rejection that arrives this fast means the browser refused to show the
// prompt at all; anything slower is the user cancelling it.
const PROMPT_REFUSED_MS = 600;

export default Vue.extend({
  components: {
    IconLock,
  },
  data() {
    return {
      password: "",
      biometricBusy: false,
      biometricError: "",
      biometricEnabled: false,
      unlockRecord: null as WebAuthnUnlockRecord | null,
    };
  },
  async created() {
    try {
      this.unlockRecord = await readBiometricUnlockRecord();
      this.biometricEnabled = true;
    } catch {
      this.biometricEnabled = false;
      return;
    }
    if (this.unresolvedKeyCount > 0) {
      return;
    }
    if (await isAutoBiometricPromptSkipped()) {
      return;
    }
    // Let the popup paint before the device prompt takes over.
    window.setTimeout(() => {
      void this.unlockInline();
    }, 120);
  },
  mounted() {
    const input = this.$refs.password as HTMLInputElement | undefined;
    input?.focus();
  },
  computed: {
    wrongPassword() {
      return this.$store.state.accounts.wrongPassword;
    },
    unresolvedKeyCount() {
      return this.$store.state.accounts.unresolvedKeyCount || 0;
    },
  },
  methods: {
    // Runs the assertion inside the popup so no extra window is shown. The
    // manual click carries a user gesture, which is what Chrome normally needs;
    // the standalone window is only used when the popup refuses the prompt.
    async unlockInline(manual = false) {
      if (this.biometricBusy || !this.biometricEnabled) {
        return;
      }
      this.biometricBusy = true;
      this.biometricError = "";
      const startedAt = Date.now();
      try {
        const bundle = await this.performUnlock();
        await this.applyBundle(bundle);
        this.biometricEnabled = false;
        this.biometricBusy = false;
      } catch (error) {
        // Releases the busy flag itself; the window fallback re-arms it.
        this.handleUnlockFailure(error, manual, Date.now() - startedAt);
      }
    },
    async performUnlock(): Promise<BiometricUnlockBundle> {
      const record = this.unlockRecord || (await readBiometricUnlockRecord());
      const bundle = await unlockWithBiometricRecord(record);
      await cacheBiometricUnlockBundle(bundle);
      await this.resetAutolock();
      this.unlockRecord = null;
      return bundle;
    },
    handleUnlockFailure(error: unknown, manual: boolean, elapsed: number) {
      // Info level on purpose: chrome://extensions lists warn/error entries as
      // extension errors, and a refused prompt is not a defect.
      console.info("[biometric] unlock failed:", describeError(error));
      this.biometricBusy = false;
      const notAllowed =
        error instanceof Error && error.name === "NotAllowedError";

      if (!manual) {
        // Automatic attempt: stay silent, just stop retrying for a while.
        void skipAutoBiometricPrompt();
        if (!notAllowed) {
          this.biometricError = this.i18n.biometric_unlock_failed;
        }
        return;
      }

      if (elapsed < PROMPT_REFUSED_MS) {
        // The prompt never appeared, so the popup is not allowed to ask for it:
        // retry once in the standalone window, which always carries a fresh
        // user gesture.
        this.openUnlockWindow();
        return;
      }

      this.biometricError = notAllowed
        ? this.i18n.biometric_unlock_cancelled
        : this.i18n.biometric_unlock_failed;
    },
    async applyBundle(bundle: BiometricUnlockBundle) {
      this.$store.commit("currentView/changeView", "LoadingPage");
      this.$store.commit("accounts/applyCachedKeys", {
        keys: bundle.keys,
        defaultKeyId: bundle.defaultKeyId,
      });
      await this.$store.dispatch("accounts/updateEntries");
      this.$store.commit("style/hideInfo", true);
    },
    resetAutolock() {
      return new Promise<void>((resolve) => {
        chrome.runtime.sendMessage({ action: "resetAutolock" }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
    },
    unlockWithBiometrics() {
      if (this.biometricBusy || !this.biometricEnabled) {
        return;
      }
      void clearAutoBiometricPromptSkip();
      void this.unlockInline(true);
    },
    openUnlockWindow() {
      this.biometricBusy = true;
      this.biometricError = "";
      openBiometricWindow(
        chrome.runtime.getURL("view/biometric.html?mode=unlock&auto=1"),
        {
          onClosed: () => {
            this.biometricBusy = false;
            void chrome.storage.session
              .get("cachedPassphrase")
              .then(({ cachedPassphrase }) => {
                if (!cachedPassphrase) {
                  return;
                }
                this.biometricEnabled = false;
                this.$store.commit("currentView/changeView", "LoadingPage");
                void this.$store.dispatch("accounts/updateEntries");
              });
          },
          onError: () => {
            this.biometricBusy = false;
            this.biometricError = this.i18n.biometric_unlock_failed;
          },
        }
      );
    },
    async applyPassphrase() {
      await this.$store.dispatch("accounts/applyPassphrase", this.password);
      document.querySelector<HTMLElement>(".entry[tabindex='0']")?.focus();
    },
  },
});
</script>
