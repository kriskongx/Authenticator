export class Style implements Module {
  private infoFadeTimer?: ReturnType<typeof setTimeout>;
  private notificationFadeTimer?: ReturnType<typeof setTimeout>;
  private notificationClearTimer?: ReturnType<typeof setTimeout>;

  getModule() {
    return {
      state: {
        style: {
          timeout: false,
          isSelecting: false,
          slidein: false, // menu
          slideout: false, // menu
          backupSlidein: false, // full-page backup navigation
          backupSlideout: false, // full-page backup navigation
          backupSubPage: "BackupPage", // which backup page to open
          cloudRestoreOpen: false, // WebDAV restore picker dialog
          fadein: false, // info
          fadeout: false, // info
          show: false, // info
          qrfadein: false,
          qrfadeout: false,
          notificationFadein: false,
          notificationFadeout: false,
          hotpDisabled: false,
        },
      },
      mutations: {
        showMenu(state: StyleState) {
          state.style.slidein = true;
          state.style.slideout = false;
        },
        hideMenu(state: StyleState) {
          state.style.slidein = false;
          state.style.slideout = true;
          setTimeout(() => {
            state.style.slideout = false;
          }, 200);
        },
        openCloudRestore(state: StyleState) {
          state.style.cloudRestoreOpen = true;
        },
        closeCloudRestore(state: StyleState) {
          state.style.cloudRestoreOpen = false;
        },
        showBackupPanel(state: StyleState, page?: string) {
          state.style.backupSubPage = page || "BackupPage";
          state.style.backupSlidein = true;
          state.style.backupSlideout = false;
        },
        hideBackupPanel(state: StyleState) {
          state.style.backupSlidein = false;
          state.style.backupSlideout = true;
          setTimeout(() => {
            state.style.backupSlideout = false;
          }, 200);
        },
        showInfo: (state: StyleState, noAnimate?: boolean) => {
          if (this.infoFadeTimer !== undefined) {
            clearTimeout(this.infoFadeTimer);
            this.infoFadeTimer = undefined;
          }
          state.style.fadeout = false;
          if (noAnimate) {
            state.style.show = true;
            state.style.fadein = false;
          } else {
            state.style.fadein = true;
            state.style.show = false;
          }
        },
        hideInfo: (state: StyleState, noAnimate?: boolean) => {
          if (this.infoFadeTimer !== undefined) {
            clearTimeout(this.infoFadeTimer);
            this.infoFadeTimer = undefined;
          }
          state.style.show = false;
          state.style.fadein = false;
          if (noAnimate) {
            state.style.fadeout = false;
          } else {
            state.style.fadeout = true;
            this.infoFadeTimer = setTimeout(() => {
              this.infoFadeTimer = undefined;
              state.style.fadeout = false;
            }, 200);
          }
        },
        showQr(state: StyleState) {
          state.style.qrfadein = true;
          state.style.qrfadeout = false;
        },
        hideQr(state: StyleState) {
          state.style.qrfadein = false;
          state.style.qrfadeout = true;
          setTimeout(() => {
            state.style.qrfadeout = false;
          }, 200);
        },
        showNotification: (state: StyleState) => {
          if (this.notificationFadeTimer !== undefined) {
            clearTimeout(this.notificationFadeTimer);
          }
          if (this.notificationClearTimer !== undefined) {
            clearTimeout(this.notificationClearTimer);
          }
          state.style.notificationFadein = true;
          state.style.notificationFadeout = false;
          this.notificationFadeTimer = setTimeout(() => {
            this.notificationFadeTimer = undefined;
            state.style.notificationFadein = false;
            state.style.notificationFadeout = true;
            this.notificationClearTimer = setTimeout(() => {
              this.notificationClearTimer = undefined;
              state.style.notificationFadeout = false;
            }, 200);
          }, 1000);
        },
        toggleSelect(state: StyleState) {
          state.style.isSelecting = !state.style.isSelecting;
        },
        setHotpDisabled(state: StyleState, disabled: boolean) {
          state.style.hotpDisabled = disabled;
        },
      },
      getters: {
        // Returns true if menu or info screen shown
        isMenuShown(state: StyleState) {
          return (
            state.style.fadein ||
            state.style.show ||
            state.style.slidein ||
            state.style.backupSlidein
          );
        },
      },
      namespaced: true,
    };
  }
}
