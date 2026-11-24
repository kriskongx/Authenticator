import type { Encryption } from "./encryption";
import { UserSettings } from "./settings";
import {
  getClientDay,
  getWebDAVConfig,
  getWebDAVOrigin,
  uploadWebDAVBackup,
} from "./webdav";

export type QuickBackupResult =
  | "ok"
  | "unconfigured"
  | "denied"
  | "timeout"
  | "error";

/** True when the extension already holds the host permission for this origin. */
function ensureOriginPermission(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!origin) {
      resolve(false);
      return;
    }
    chrome.permissions.contains({ origins: [origin] }, (contained) => {
      if (contained) {
        resolve(true);
        return;
      }
      // Must run during a user gesture; callers invoke this from a click.
      try {
        chrome.permissions.request({ origins: [origin] }, (granted) =>
          resolve(Boolean(granted))
        );
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * One-shot WebDAV upload used by the quick actions. Returns a code instead of
 * throwing so callers only have to map it to a message.
 */
export async function quickWebDAVBackup(
  encryption: Encryption
): Promise<QuickBackupResult> {
  const config = await getWebDAVConfig();
  if (!config.url || !config.username || !config.password) {
    return "unconfigured";
  }
  const origin = getWebDAVOrigin(config.url);
  if (!(await ensureOriginPermission(origin))) {
    return "denied";
  }
  try {
    const ok = await uploadWebDAVBackup(encryption, config.encrypted !== false);
    if (!ok) {
      return "error";
    }
    // Keep the shared schedule in sync: a manual backup also resets the timer.
    UserSettings.items.webdavLastBackupTime = getClientDay();
    await UserSettings.commitItems();
    return "ok";
  } catch (error) {
    return (error as Error).message === "webdavTimeout" ? "timeout" : "error";
  }
}
