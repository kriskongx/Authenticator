import { isSafari } from "../browser";
import { UserSettings, normalizeAutolock } from "../models/settings";
import { ManagedStorage } from "../models/storage";

export class Menu implements Module {
  async getModule() {
    await UserSettings.updateItems();

    const menuState = {
      state: {
        version: chrome.runtime.getManifest()?.version || "0.0.0",
        zoom: Number(UserSettings.items.zoom) || 100,
        useAutofill: UserSettings.items.autofill === true,
        smartFilter: UserSettings.items.smartFilter === true,
        enableContextMenu: UserSettings.items.enableContextMenu === true,
        theme: UserSettings.items.theme || (isSafari ? "flat" : "normal"),
        autolock: normalizeAutolock(UserSettings.items.autolock),
        backupDisabled: await ManagedStorage.get("disableBackup", false),
        exportDisabled: await ManagedStorage.get("disableExport", false),
        enforcePassword: await ManagedStorage.get("enforcePassword", false),
        enforceAutolock: await ManagedStorage.get("enforceAutolock", false),
        storageArea: await ManagedStorage.get<"sync" | "local">("storageArea"),
        feedbackURL: await ManagedStorage.get<string>("feedbackURL"),
        passwordPolicy: await ManagedStorage.get<string>("passwordPolicy"),
        passwordPolicyHint: await ManagedStorage.get<string>(
          "passwordPolicyHint"
        ),
      },
      mutations: {
        setZoom: (state: MenuState, zoom: number) => {
          state.zoom = zoom;
          UserSettings.items.zoom = zoom;
          UserSettings.commitItems();
          this.resize(zoom);
        },
        setAutofill(state: MenuState, useAutofill: boolean) {
          state.useAutofill = useAutofill;
          UserSettings.items.autofill = useAutofill;
          UserSettings.commitItems();
        },
        setSmartFilter(state: MenuState, smartFilter: boolean) {
          state.smartFilter = smartFilter;
          UserSettings.items.smartFilter = smartFilter;
          UserSettings.commitItems();
        },
        setEnableContextMenu(state: MenuState, enableContextMenu: boolean) {
          state.enableContextMenu = enableContextMenu;
          UserSettings.items.enableContextMenu = enableContextMenu;
          UserSettings.commitItems();
        },
        setTheme(state: MenuState, theme: string) {
          state.theme = theme;
          UserSettings.items.theme = theme;
          UserSettings.commitItems();
        },
        setAutolock(state: MenuState, autolock: number) {
          // Ignore the transient empty value while the field is being retyped,
          // so clearing it does not silently switch the vault to "never lock".
          // (`Number("")` is 0, so a numeric check alone would not catch it.)
          const raw: unknown = autolock;
          if (raw === "" || raw === null || raw === undefined) {
            return;
          }
          const minutes = normalizeAutolock(raw);
          state.autolock = minutes;
          UserSettings.items.autolock = minutes;
          UserSettings.commitItems();
        },
      },
      namespaced: true,
    };

    this.resize(menuState.state.zoom);

    return menuState;
  }

  private resize(zoom: number) {
    if (zoom !== 100) {
      document.body.style.marginBottom = 480 * (zoom / 100 - 1) + "px";
      document.body.style.marginRight = 320 * (zoom / 100 - 1) + "px";
      document.body.style.transform = "scale(" + zoom / 100 + ")";
    }
  }
}
