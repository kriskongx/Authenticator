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
        setZoom: (state: MenuState, zoom: number | string) => {
          const numericZoom = Number(zoom) || 100;
          state.zoom = numericZoom;
          UserSettings.items.zoom = numericZoom;
          void UserSettings.commitItems();
          this.resize(numericZoom);
        },
        setAutofill(state: MenuState, useAutofill: boolean) {
          state.useAutofill = useAutofill;
          UserSettings.items.autofill = useAutofill;
          void UserSettings.commitItems();
        },
        setSmartFilter(state: MenuState, smartFilter: boolean) {
          state.smartFilter = smartFilter;
          UserSettings.items.smartFilter = smartFilter;
          void UserSettings.commitItems();
        },
        setEnableContextMenu(state: MenuState, enableContextMenu: boolean) {
          state.enableContextMenu = enableContextMenu;
          UserSettings.items.enableContextMenu = enableContextMenu;
          void UserSettings.commitItems();
        },
        setTheme(state: MenuState, theme: string) {
          state.theme = theme;
          UserSettings.items.theme = theme;
          void UserSettings.commitItems();
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
          void UserSettings.commitItems();
        },
      },
      actions: {
        async saveAutolock(
          context: { state: MenuState },
          autolock: number | string
        ) {
          const raw: unknown = autolock;
          if (raw === "" || raw === null || raw === undefined) {
            return;
          }
          const minutes = normalizeAutolock(raw);
          context.state.autolock = minutes;
          await UserSettings.updateItems();
          UserSettings.items.autolock = minutes;
          await UserSettings.commitItems();
        },
        async saveEnableContextMenu(
          context: { state: MenuState },
          enableContextMenu: boolean
        ) {
          context.state.enableContextMenu = enableContextMenu;
          await UserSettings.updateItems();
          UserSettings.items.enableContextMenu = enableContextMenu;
          await UserSettings.commitItems();
        },
      },
      namespaced: true,
    };

    this.resize(menuState.state.zoom);

    return menuState;
  }

  private resize(zoom: number | string) {
    const numericZoom = Number(zoom) || 100;
    if (numericZoom !== 100) {
      document.body.style.marginBottom = 480 * (numericZoom / 100 - 1) + "px";
      document.body.style.marginRight = 320 * (numericZoom / 100 - 1) + "px";
      document.body.style.transform = "scale(" + numericZoom / 100 + ")";
    } else {
      document.body.style.marginBottom = "";
      document.body.style.marginRight = "";
      document.body.style.transform = "";
    }
  }
}
