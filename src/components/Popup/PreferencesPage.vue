<template>
  <div class="subpage preferences-page">
    <div class="subpage-head">
      <div class="subpage-title">{{ i18n.ui_preferences_title }}</div>
      <div class="subpage-subtitle">
        {{ i18n.ui_preferences_subtitle }}
      </div>
    </div>

    <section class="subpage-section">
      <div class="subpage-section-head">
        <div class="subpage-section-title">{{ i18n.ui_appearance }}</div>
      </div>
      <div class="subpage-list-card">
        <label class="subpage-row">
          <span class="subpage-row-icon"><IconCog /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">{{ i18n.theme || "Theme" }}</span>
            <span class="subpage-row-desc">{{ i18n.ui_theme_desc }}</span>
          </span>
          <span class="subpage-control">
            <select class="subpage-select" v-model="theme">
              <option value="normal">{{ i18n.theme_light || "Light" }}</option>
              <option value="dark">{{ i18n.theme_dark || "Dark" }}</option>
              <option value="simple">
                {{ i18n.theme_simple || "Simple" }}
              </option>
              <option value="compact">
                {{ i18n.theme_compact || "Compact" }}
              </option>
              <option value="accessibility">
                {{ i18n.theme_high_contrast || "High contrast" }}
              </option>
              <option value="flat">{{ i18n.theme_flat || "Flat" }}</option>
            </select>
          </span>
        </label>

        <label class="subpage-row">
          <span class="subpage-row-icon"><IconExchange /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">{{
              i18n.scale || "Interface scale"
            }}</span>
            <span class="subpage-row-desc">{{ i18n.ui_scale_desc }}</span>
          </span>
          <span class="subpage-control">
            <select
              class="subpage-select preference-zoom-select"
              v-model.number="zoom"
            >
              <option value="125">125%</option>
              <option value="100">100%</option>
              <option value="90">90%</option>
              <option value="80">80%</option>
              <option value="67">67%</option>
              <option value="57">57%</option>
              <option value="50">50%</option>
              <option value="40">40%</option>
              <option value="33">33%</option>
              <option value="25">25%</option>
              <option value="20">20%</option>
            </select>
          </span>
        </label>
      </div>
    </section>

    <section class="subpage-section">
      <div class="subpage-section-head">
        <div class="subpage-section-title">{{ i18n.ui_quick_actions }}</div>
      </div>
      <div class="subpage-list-card">
        <label class="subpage-row">
          <span class="subpage-row-icon"><IconKey /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">
              {{ i18n.use_autofill || "Enable autofill" }}
            </span>
            <span class="subpage-row-desc">{{ i18n.ui_autofill_desc }}</span>
          </span>
          <span class="subpage-switch">
            <input type="checkbox" v-model="useAutofill" />
            <span class="subpage-switch-track"></span>
          </span>
        </label>

        <label class="subpage-row">
          <span class="subpage-row-icon"><IconAdvisor /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">
              {{ i18n.smart_filter || "Smart filter" }}
            </span>
            <span class="subpage-row-desc">{{
              i18n.ui_smart_filter_desc
            }}</span>
          </span>
          <span class="subpage-switch">
            <input type="checkbox" v-model="smartFilter" />
            <span class="subpage-switch-track"></span>
          </span>
        </label>

        <label class="subpage-row" v-if="isSupported">
          <span class="subpage-row-icon"><IconBars /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">
              {{ i18n.enable_context_menu || "Add to context menu" }}
            </span>
            <span class="subpage-row-desc">{{
              i18n.ui_context_menu_desc
            }}</span>
          </span>
          <span class="subpage-switch">
            <input
              type="checkbox"
              v-model="enableContextMenu"
              @change="requireContextMenuPermission"
            />
            <span class="subpage-switch-track"></span>
          </span>
        </label>
      </div>
    </section>

    <section class="subpage-section">
      <div class="subpage-section-head">
        <div class="subpage-section-title">{{ i18n.ui_storage_security }}</div>
      </div>
      <div class="subpage-list-card">
        <label class="subpage-row">
          <span class="subpage-row-icon"><IconSync /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">
              {{ i18n.browser_sync || "Browser data sync" }}
            </span>
            <span class="subpage-row-desc">{{
              i18n.ui_browser_sync_desc
            }}</span>
          </span>
          <span class="subpage-switch">
            <input
              type="checkbox"
              v-model="browserSync"
              :disabled="Boolean(storageArea)"
              @change="migrateStorage"
            />
            <span class="subpage-switch-track"></span>
          </span>
        </label>
      </div>
    </section>

    <section class="subpage-section">
      <div class="subpage-section-head">
        <div class="subpage-section-title">{{ i18n.ui_window }}</div>
      </div>
      <div class="subpage-list-card">
        <button
          type="button"
          class="subpage-row preferences-popout-row"
          @click="popOut"
        >
          <span class="subpage-row-icon"><IconWrench /></span>
          <span class="subpage-row-copy">
            <span class="subpage-row-title">
              {{ i18n.popout || "Separate window mode" }}
            </span>
            <span class="subpage-row-desc">{{ i18n.ui_popout_desc }}</span>
          </span>
          <IconArrowLeft class="subpage-row-arrow" />
        </button>
      </div>
    </section>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { isFirefox, isSafari } from "../../browser";
import { UserSettings } from "../../models/settings";
import IconAdvisor from "../../../svg/lightbulb.svg";
import IconArrowLeft from "../../../svg/arrow-left.svg";
import IconBars from "../../../svg/bars.svg";
import IconCog from "../../../svg/cog.svg";
import IconExchange from "../../../svg/exchange.svg";
import IconKey from "../../../svg/key-solid.svg";
import IconWrench from "../../../svg/wrench.svg";
import IconSync from "../../../svg/sync.svg";

export default Vue.extend({
  components: {
    IconAdvisor,
    IconArrowLeft,
    IconBars,
    IconCog,
    IconExchange,
    IconWrench,
    IconKey,
    IconSync,
  },
  computed: {
    zoom: {
      get(): number {
        return this.$store.state.menu.zoom;
      },
      set(zoom: number) {
        this.$store.commit("menu/setZoom", zoom);
      },
    },
    useAutofill: {
      get(): boolean {
        return this.$store.state.menu.useAutofill;
      },
      set(useAutofill: boolean) {
        this.$store.commit("menu/setAutofill", useAutofill);
      },
    },
    smartFilter: {
      get(): boolean {
        return this.$store.state.menu.smartFilter;
      },
      set(smartFilter: boolean) {
        this.$store.commit("menu/setSmartFilter", smartFilter);
        if (smartFilter) {
          this.$store.commit(
            "notification/alert",
            this.i18n.activate_auto_filter
          );
        }
      },
    },
    enableContextMenu: {
      get(): boolean {
        return this.$store.state.menu.enableContextMenu;
      },
      set(enableContextMenu: boolean) {
        this.$store.commit("menu/setEnableContextMenu", enableContextMenu);
      },
    },
    theme: {
      get(): string {
        return this.$store.state.menu.theme;
      },
      set(theme: string) {
        this.$store.commit("menu/setTheme", theme);
      },
    },
    storageArea() {
      return this.$store.state.menu.storageArea;
    },
    isSupported(): boolean {
      return !isSafari;
    },
    browserSync: {
      get(): boolean {
        return this.newStorageLocation === "sync";
      },
      set(value) {
        this.newStorageLocation = value ? "sync" : "local";
      },
    },
  },
  data() {
    return { newStorageLocation: "" };
  },
  async created() {
    this.newStorageLocation =
      this.$store.state.menu.storageArea ||
      UserSettings.items.storageLocation ||
      "";
  },
  methods: {
    popOut() {
      let windowType;
      if (isFirefox) {
        windowType = "detached_panel";
      } else {
        windowType = "panel";
      }
      chrome.windows.create({
        url: chrome.runtime.getURL("view/popup.html?popup=true"),
        type: windowType as chrome.windows.createTypeEnum,
        height: window.innerHeight,
        width: window.innerWidth,
      });
    },
    requireContextMenuPermission() {
      if (!this.enableContextMenu) {
        void this.$store
          .dispatch("menu/saveEnableContextMenu", false)
          .then(() => {
            this.syncContextMenu();
          });
        return;
      }

      // contextMenus is an optional permission, so it has to be requested from
      // a user gesture before the background can create the menu entry.
      chrome.permissions.request(
        { permissions: ["contextMenus"] },
        (granted) => {
          if (!granted) {
            void this.$store.dispatch("menu/saveEnableContextMenu", false);
            return;
          }
          void this.$store
            .dispatch("menu/saveEnableContextMenu", true)
            .then(() => {
              this.syncContextMenu();
            });
        }
      );
    },
    syncContextMenu() {
      chrome.runtime.sendMessage({ action: "updateContextMenu" }, () => {
        void chrome.runtime.lastError;
      });
    },
    async migrateStorage() {
      this.$store.commit("currentView/changeView", "LoadingPage");
      try {
        const message = await this.$store.dispatch(
          "accounts/migrateStorage",
          this.newStorageLocation
        );
        this.$store.commit("notification/alert", this.i18n[message] || message);
      } catch (error) {
        await UserSettings.updateItems();
        this.newStorageLocation =
          this.$store.state.menu.storageArea ||
          UserSettings.items.storageLocation ||
          "sync";
        const reason =
          error instanceof Error ? error.message : String(error || "");
        this.$store.commit(
          "notification/alert",
          `${this.i18n.updateFailure}${reason}`
        );
      } finally {
        this.$store.commit("currentView/changeView", "PreferencesPage");
      }
    },
  },
});
</script>
