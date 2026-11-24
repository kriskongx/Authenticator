import { ActionContext } from "vuex";

type PendingConfirm = {
  message: string;
  resolve: (value: boolean) => void;
};

export class Notification implements Module {
  private activeConfirm: PendingConfirm | null = null;
  private confirmQueue: PendingConfirm[] = [];

  getModule() {
    const showNextConfirm = (state: NotificationState) => {
      if (this.activeConfirm || !this.confirmQueue.length) {
        return;
      }
      const next = this.confirmQueue.shift() || null;
      this.activeConfirm = next;
      state.confirmMessage = next ? next.message : "";
    };

    return {
      state: {
        message: [], // Message content for alert with ok button
        confirmMessage: "", // Message content for alert with yes / no
        messageIdle: true, // Should show alert box?
        notification: "", // Ephermal message text
      },
      mutations: {
        alert: (state: NotificationState, message: string) => {
          state.message.unshift(message);
        },
        closeAlert: (state: NotificationState) => {
          state.messageIdle = false;
          state.message.shift();
          setTimeout(() => {
            state.messageIdle = true;
          }, 200);
        },
        setConfirm: (state: NotificationState, message: string) => {
          state.confirmMessage = message;
        },
        resolveConfirm: (state: NotificationState, accepted: boolean) => {
          const current = this.activeConfirm;
          this.activeConfirm = null;
          state.confirmMessage = "";
          if (current) {
            current.resolve(Boolean(accepted));
          }
          showNextConfirm(state);
        },
        setNotification: (state: NotificationState, message: string) => {
          state.notification = message;
        },
      },
      actions: {
        confirm: async (
          context: ActionContext<NotificationState, object>,
          message: string
        ) => {
          return new Promise<boolean>((resolve) => {
            this.confirmQueue.push({ message, resolve });
            showNextConfirm(context.state);
          });
        },
        ephermalMessage: (
          state: ActionContext<NotificationState, object>,
          message: string
        ) => {
          state.commit("setNotification", message);
          state.commit("style/showNotification", null, { root: true });
        },
      },
      namespaced: true,
    };
  }
}
