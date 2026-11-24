import { UserSettings } from "./models/settings";

export async function syncTimeWithGoogle(): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch("https://www.google.com/generate_204", {
      method: "HEAD",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status !== 204) {
      return "updateFailure";
    }

    const date = response.headers.get("date");
    if (!date) {
      return "updateFailure";
    }

    const serverTime = Date.parse(date);
    if (!Number.isFinite(serverTime)) {
      return "updateFailure";
    }

    const clientTime = Date.now();
    const offset = Math.round((serverTime - clientTime) / 1000);

    if (Math.abs(offset) <= 300) {
      // within 5 minutes
      await UserSettings.updateItems();
      UserSettings.items.offset = offset;
      await UserSettings.commitItems();
      return "updateSuccess";
    }
    return "clock_too_far_off";
  } catch {
    clearTimeout(timeoutId);
    return "updateFailure";
  }
}
