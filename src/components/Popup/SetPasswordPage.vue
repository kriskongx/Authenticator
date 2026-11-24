<template>
  <div class="subpage security-page">
    <div class="subpage-head">
      <div class="subpage-title">{{ i18n.ui_security_title }}</div>
      <div class="subpage-subtitle">
        {{ i18n.ui_security_subtitle }}
      </div>
    </div>

    <section class="subpage-section">
      <div class="subpage-notice security-notice">
        <span class="subpage-row-icon warning"><IconLock /></span>
        <div>
          <div class="subpage-notice-title">
            {{ i18n.ui_password_warning_title }}
          </div>
          <div class="subpage-notice-desc">
            {{
              i18n.security_warning ||
              "Encrypted data cannot be recovered if the master password is lost."
            }}
          </div>
        </div>
      </div>
    </section>

    <section class="subpage-section" v-if="isChromium">
      <div class="subpage-card">
        <div class="subpage-row">
          <span class="subpage-row-icon"><IconLock /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">{{
              i18n.biometric_settings_title
            }}</span>
            <span class="subpage-row-desc">{{
              i18n.biometric_settings_desc
            }}</span>
          </span>
          <span class="subpage-control">
            <button
              v-if="!biometricEnabled"
              type="button"
              class="subpage-button"
              :disabled="
                biometricBusy || !biometricAvailable || !defaultEncryption
              "
              @click="enableBiometricUnlock"
            >
              {{ i18n.biometric_enable }}
            </button>
            <button
              v-else
              type="button"
              class="subpage-button danger"
              :disabled="biometricBusy"
              @click="disableBiometricUnlock"
            >
              {{ i18n.biometric_disable }}
            </button>
          </span>
        </div>
        <div class="subpage-card-message" v-if="biometricError">
          {{ biometricError }}
        </div>
        <div
          class="subpage-field-help security-card-hint"
          v-if="!defaultEncryption"
        >
          {{ i18n.biometric_requires_password }}
        </div>
      </div>
    </section>

    <section class="subpage-section" v-if="defaultEncryption">
      <div class="subpage-card">
        <div class="subpage-row">
          <span class="subpage-row-icon neutral"><IconLock /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">{{ i18n.ui_autolock_title }}</span>
            <span class="subpage-row-desc">{{ i18n.ui_autolock_desc }}</span>
          </span>
          <span class="subpage-control security-autolock">
            <input
              class="subpage-number-input"
              type="number"
              min="0"
              v-model.number="autolock"
              :disabled="Boolean(enforceAutolock)"
              :aria-label="i18n.ui_autolock_minutes"
            />
            <span class="subpage-control-unit">{{ i18n.ui_minutes_unit }}</span>
          </span>
        </div>
      </div>
    </section>

    <section class="subpage-section">
      <details
        class="subpage-card subpage-collapsible"
        :open="!defaultEncryption"
      >
        <summary>
          <span class="subpage-row-icon"><IconKey /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">
              {{
                defaultEncryption
                  ? i18n.ui_change_master_password
                  : i18n.ui_set_master_password
              }}
            </span>
            <span class="subpage-row-desc" v-if="defaultEncryption">
              {{ i18n.security_password_row_desc }}
            </span>
          </span>
          <IconArrowLeft class="subpage-row-arrow" />
        </summary>
        <form
          class="subpage-collapsible-body"
          @submit.prevent="changePassphrase"
        >
          <label class="subpage-field" v-if="defaultEncryption">
            <span class="subpage-field-label">
              {{ i18n.current_phrase || "Current password" }}
            </span>
            <input
              class="subpage-text-input"
              type="password"
              v-model="currentPhrase"
              autocomplete="current-password"
            />
          </label>

          <label class="subpage-field">
            <span class="subpage-field-label">
              {{
                defaultEncryption
                  ? i18n.new_phrase || "New password"
                  : i18n.ui_master_password
              }}
            </span>
            <input
              class="subpage-text-input"
              type="password"
              v-model="phrase"
              autocomplete="new-password"
            />
            <span class="subpage-field-help" v-if="passwordPolicyHint">
              {{ passwordPolicyHint }}
            </span>
          </label>

          <label class="subpage-field">
            <span class="subpage-field-label">
              {{ i18n.confirm_phrase || "Confirm password" }}
            </span>
            <input
              class="subpage-text-input"
              type="password"
              v-model="confirm"
              autocomplete="new-password"
            />
          </label>

          <div class="subpage-actions security-actions">
            <button
              v-if="defaultEncryption && !enforcePassword"
              id="security-remove"
              class="subpage-button danger"
              type="button"
              @click="removePassphrase"
            >
              {{ i18n.remove || "Remove password" }}
            </button>
            <button
              id="security-save"
              class="subpage-button primary"
              type="submit"
            >
              {{ i18n.save || i18n.ok }}
            </button>
          </div>
        </form>
      </details>
    </section>

    <section class="subpage-section" v-if="isChromium">
      <div class="subpage-card">
        <label class="subpage-row">
          <span class="subpage-row-icon neutral"><IconCode /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">{{ i18n.ui_api_title }}</span>
            <span class="subpage-row-desc">{{ i18n.ui_api_desc }}</span>
          </span>
          <span class="subpage-switch">
            <input
              type="checkbox"
              v-model="apiEnabled"
              :aria-label="i18n.ui_api_title"
              @change="syncApiAccess($event)"
            />
            <span class="subpage-switch-track"></span>
          </span>
        </label>
        <div class="security-inline-body" v-if="apiEnabled">
          <span class="subpage-field-label">{{ i18n.ui_api_token_label }}</span>
          <div class="security-api-row">
            <input
              ref="apiToken"
              class="subpage-text-input"
              type="text"
              readonly
              :value="apiToken"
              :title="i18n.ui_api_token_copy_hint"
              @focus="selectApiToken"
              @click="selectApiToken"
            />
            <button
              type="button"
              class="subpage-button danger"
              @click="resetToken"
            >
              {{ i18n.ui_api_token_reset }}
            </button>
          </div>
          <div class="subpage-field-help">{{ i18n.ui_api_token_hint }}</div>
        </div>
      </div>
    </section>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { verifyPasswordUsingKeyID } from "../../models/password";
import IconArrowLeft from "../../../svg/arrow-left.svg";
import IconCode from "../../../svg/code.svg";
import IconKey from "../../../svg/key-solid.svg";
import IconLock from "../../../svg/lock.svg";
import { isChromium } from "../../browser";
import {
  createApiToken,
  getApiToken,
  isApiAccessEnabled,
  setApiAccessEnabled,
} from "../../models/api-access";
import {
  cancelBiometricBundleSetup,
  createBiometricUnlockBundle,
  isBiometricUnlockEnabled,
  isPlatformAuthenticatorAvailable,
  removeBiometricUnlock,
  stageBiometricBundleForCreation,
} from "../../models/biometric-unlock";
import { openBiometricWindow } from "../../models/biometric-window";

export default Vue.extend({
  components: {
    IconArrowLeft,
    IconCode,
    IconKey,
    IconLock,
  },
  data: function () {
    return {
      phrase: "",
      currentPhrase: "",
      confirm: "",
      biometricEnabled: false,
      biometricAvailable: false,
      biometricBusy: false,
      biometricError: "",
      apiEnabled: false,
      apiToken: "",
    };
  },
  async created() {
    const [enabled, available, apiEnabled, apiToken] = await Promise.all([
      isBiometricUnlockEnabled().catch(() => false),
      isPlatformAuthenticatorAvailable().catch(() => false),
      isApiAccessEnabled().catch(() => false),
      getApiToken().catch(() => ""),
    ]);
    this.biometricEnabled = enabled;
    this.biometricAvailable = available;
    this.apiEnabled = apiEnabled;
    this.apiToken = apiToken;
  },
  computed: {
    enforcePassword: function () {
      return this.$store.state.menu.enforcePassword;
    },
    passwordPolicy: function () {
      if (!this.$store.state.menu.passwordPolicy) {
        return null;
      }

      try {
        return new RegExp(this.$store.state.menu.passwordPolicy);
      } catch {
        console.warn(
          "Invalid password policy. The password policy is not a valid regular expression.",
          this.$store.state.menu.passwordPolicy
        );
        return null;
      }
    },
    passwordPolicyHint: function () {
      return this.$store.state.menu.passwordPolicyHint;
    },
    enforceAutolock() {
      return this.$store.state.menu.enforceAutolock;
    },
    autolock: {
      get(): number {
        if (this.$store.state.menu.enforceAutolock) {
          return this.$store.state.menu.enforceAutolock;
        }
        return this.$store.state.menu.autolock;
      },
      set(autolock: number) {
        this.$store.commit("menu/setAutolock", autolock);
        chrome.runtime.sendMessage({ action: "resetAutolock" }, () => {
          void chrome.runtime.lastError;
        });
      },
    },
    defaultEncryption: function (): string | undefined {
      return this.$store.state.accounts.defaultEncryption;
    },
    isChromium(): boolean {
      return isChromium;
    },
  },
  methods: {
    async syncApiAccess(event: Event) {
      // Read the state from the event: `v-model` and this handler share the
      // same change event, so relying on the data property would be racy.
      const enabled = (event.target as HTMLInputElement).checked;
      this.apiEnabled = enabled;
      if (!enabled) {
        await setApiAccessEnabled(false);
        return;
      }
      if (!this.apiToken) {
        this.apiToken = await createApiToken();
      }
      await setApiAccessEnabled(true);
      await this.$nextTick();
      this.selectApiToken();
    },
    async resetToken() {
      // Rotate only: the API stays enabled, the old token simply stops working.
      this.apiToken = await createApiToken();
      await this.$nextTick();
      this.selectApiToken();
    },
    selectApiToken() {
      const input = (this.$refs.apiToken as unknown) as
        | HTMLInputElement
        | undefined;
      input?.select();
    },
    async removePassphrase() {
      this.$store.commit("currentView/changeView", "LoadingPage");

      if (this.defaultEncryption) {
        const isCorrectPassword = await verifyPasswordUsingKeyID(
          this.defaultEncryption,
          this.currentPhrase
        );
        if (!isCorrectPassword) {
          this.$store.commit("notification/alert", this.i18n.phrase_not_match);
          this.$store.commit("currentView/changeView", "SetPasswordPage");
          return;
        }
      }

      await this.$store.dispatch("accounts/changePassphrase", "");
      this.$store.commit("notification/alert", this.i18n.updateSuccess);
      this.$store.commit("style/hideInfo");
      return;
    },
    async changePassphrase() {
      if (this.phrase === "") {
        return;
      }

      if (this.passwordPolicy && !this.passwordPolicy.test(this.phrase)) {
        const hint =
          this.passwordPolicyHint || this.i18n.password_policy_default_hint;
        this.$store.commit("notification/alert", hint);
        return;
      }

      if (this.phrase !== this.confirm) {
        this.$store.commit("notification/alert", this.i18n.phrase_not_match);
        return;
      }

      this.$store.commit("currentView/changeView", "LoadingPage");

      if (this.defaultEncryption) {
        const isCorrectPassword = await verifyPasswordUsingKeyID(
          this.defaultEncryption,
          this.currentPhrase
        );
        if (!isCorrectPassword) {
          this.$store.commit("notification/alert", this.i18n.phrase_wrong);
          this.$store.commit("currentView/changeView", "SetPasswordPage");
          return;
        }
      }

      await this.$store.dispatch("accounts/changePassphrase", this.phrase);
      this.$store.commit("notification/alert", this.i18n.updateSuccess);
      this.$store.commit("style/hideInfo");
      return;
    },

    async enableBiometricUnlock() {
      if (this.biometricBusy) return;
      this.biometricBusy = true;
      this.biometricError = "";
      let ticket = "";
      try {
        const bundle = createBiometricUnlockBundle(
          this.$store.state.accounts.encryption,
          this.$store.state.accounts.defaultEncryption
        );
        ticket = await stageBiometricBundleForCreation(bundle);
        chrome.runtime.sendMessage({ action: "lock" }, (lockResponse) => {
          if (chrome.runtime.lastError || !lockResponse?.ok) {
            void cancelBiometricBundleSetup(ticket);
            this.biometricError = `${this.i18n.biometric_setup_failed} (${
              lockResponse?.error || "lock failed"
            })`;
            this.biometricBusy = false;
            return;
          }
          const setupUrl = chrome.runtime.getURL(
            `view/biometric.html?ticket=${encodeURIComponent(ticket)}`
          );
          openBiometricWindow(setupUrl, {
            onClosed: () => {
              this.biometricBusy = false;
              void isBiometricUnlockEnabled().then((enabled) => {
                this.biometricEnabled = enabled;
              });
            },
            onError: () => {
              void cancelBiometricBundleSetup(ticket);
              this.biometricError = this.i18n.biometric_setup_failed;
              this.biometricBusy = false;
            },
          });
        });
      } catch (error) {
        if (ticket) await cancelBiometricBundleSetup(ticket);
        const reason =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        this.biometricError = `${this.i18n.biometric_setup_failed} (${reason})`;
        this.biometricBusy = false;
      }
    },
    async disableBiometricUnlock() {
      this.biometricBusy = true;
      this.biometricError = "";
      try {
        await removeBiometricUnlock();
        this.biometricEnabled = false;
      } catch {
        this.biometricError = this.i18n.biometric_setup_failed;
      } finally {
        this.biometricBusy = false;
      }
    },
  },
});
</script>
