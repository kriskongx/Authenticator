import { EntryStorage } from "../models/storage";
import { InsightLevel, AdvisorInsight } from "../models/advisor";
import {
  normalizeAutolock,
  StorageLocation,
  UserSettings,
} from "../models/settings";

function parseIgnoreList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw || "[]");
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

const insightsData: AdvisorInsightInterface[] = [
  {
    id: "passwordNotSet",
    level: InsightLevel.danger,
    description: chrome.i18n.getMessage("advisor_insight_password_not_set"),
    validation: async () => {
      const hasEncryptedEntry = await EntryStorage.hasEncryptionKey();
      return !hasEncryptedEntry;
    },
  },
  {
    id: "autoLockNotSet",
    level: InsightLevel.warning,
    description: chrome.i18n.getMessage("advisor_insight_auto_lock_not_set"),
    validation: async () => {
      await UserSettings.updateItems();
      const hasEncryptedEntry = await EntryStorage.hasEncryptionKey();
      return (
        hasEncryptedEntry &&
        normalizeAutolock(UserSettings.items.autolock) === 0
      );
    },
  },
  {
    id: "browserSyncNotEnabled",
    level: InsightLevel.info,
    description: chrome.i18n.getMessage(
      "advisor_insight_browser_sync_not_enabled"
    ),
    validation: async () => {
      await UserSettings.updateItems();
      const storageArea = UserSettings.items.storageLocation;
      return storageArea !== StorageLocation.Sync;
    },
  },
  {
    id: "autoFillNotEnabled",
    level: InsightLevel.info,
    description: chrome.i18n.getMessage(
      "advisor_insight_auto_fill_not_enabled"
    ),
    validation: async () => {
      await UserSettings.updateItems();
      return UserSettings.items.autofill !== true;
    },
  },
  {
    id: "smartFilterNotEnabled",
    level: InsightLevel.info,
    description: chrome.i18n.getMessage(
      "advisor_insight_smart_filter_not_enabled"
    ),
    validation: async () => {
      await UserSettings.updateItems();
      return UserSettings.items.smartFilter !== true;
    },
  },
];

export class Advisor implements Module {
  private pendingOp: Promise<void> = Promise.resolve();

  private enqueue(task: () => Promise<void>) {
    this.pendingOp = this.pendingOp.then(task, task).catch((error) => {
      console.error("[Advisor] operation failed:", error);
    });
  }

  async getModule() {
    await UserSettings.updateItems();
    return {
      state: {
        insights: await this.getInsights(),
        ignoreList: parseIgnoreList(UserSettings.items.advisorIgnoreList),
      },
      mutations: {
        dismissInsight: (state: AdvisorState, insightId: string) => {
          if (!state.ignoreList.includes(insightId)) {
            state.ignoreList.push(insightId);
          }
          const nextIgnoreList = [...state.ignoreList];
          this.enqueue(async () => {
            await UserSettings.updateItems();
            UserSettings.items.advisorIgnoreList = nextIgnoreList;
            await UserSettings.commitItems();
            state.insights = await this.getInsights();
          });
        },
        clearIgnoreList: (state: AdvisorState) => {
          state.ignoreList = [];
          this.enqueue(async () => {
            await UserSettings.updateItems();
            UserSettings.items.advisorIgnoreList = undefined;
            await UserSettings.commitItems();
            state.insights = await this.getInsights();
          });
        },
        updateInsight: (state: AdvisorState) => {
          this.enqueue(async () => {
            state.insights = await this.getInsights();
            state.ignoreList = parseIgnoreList(
              UserSettings.items.advisorIgnoreList
            );
          });
        },
      },
      namespaced: true,
    };
  }

  private async getInsights() {
    await UserSettings.updateItems();
    const advisorIgnoreList = parseIgnoreList(
      UserSettings.items.advisorIgnoreList
    );

    const filteredInsightsData: AdvisorInsightInterface[] = [];

    for (const insightData of insightsData) {
      if (advisorIgnoreList.includes(insightData.id)) {
        continue;
      }

      const validation = await insightData.validation();

      if (validation) {
        filteredInsightsData.push(insightData);
      }
    }

    return filteredInsightsData.map(
      (insightData) => new AdvisorInsight(insightData)
    );
  }
}
