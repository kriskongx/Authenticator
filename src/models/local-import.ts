import { BackupImportResult, importBackupContent } from "./import-api";

export const LOCAL_IMPORT_HOST = "com.otp_ee.authenticator_import";
export const LOCAL_IMPORT_ALARM = "localImportWatch";

const ENABLED_KEY = "AuthenticatorLocalImportEnabled";
const FAILURE_KEY = "AuthenticatorLocalImportFailure";
const INTERVAL_KEY = "AuthenticatorLocalImportIntervalMinutes";
const CHUNK_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 20000;
// A broken export would otherwise be retried every alarm tick forever.
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000;

export const DEFAULT_INTERVAL_MINUTES = 5;
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 1440;

function clampInterval(value: unknown): number {
  const minutes = Math.floor(Number(value));
  if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return Math.min(MAX_INTERVAL_MINUTES, minutes);
}

export interface LocalBackupInfo {
  name: string;
  size: number;
  mtime: number;
  digest: string;
}

export interface LocalImportStatus {
  available: boolean;
  dir?: string;
  pattern?: string;
  maxBytes?: number;
  deleteAfterImport?: boolean;
  intervalMinutes?: number;
  fileCount?: number;
  importedCount?: number;
  pending?: LocalBackupInfo | null;
  lastImported?: { name: string; at: number } | null;
  error?: string;
}

type NativeRequest = Record<string, unknown> & { type: string };
type NativeResponse = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
};

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/**
 * Opens one native messaging connection, runs `worker` against it, and closes
 * it. Messages are matched by id so chunked reads can be issued in sequence.
 */
async function withNativeHost<T>(
  worker: (
    call: (request: NativeRequest) => Promise<NativeResponse>
  ) => Promise<T>
): Promise<T> {
  const port = chrome.runtime.connectNative(LOCAL_IMPORT_HOST);
  const pending = new Map<
    number,
    {
      resolve: (response: NativeResponse) => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >();
  let nextId = 1;

  const settleAll = (error: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  port.onMessage.addListener((message: NativeResponse) => {
    const id = message && typeof message.id === "number" ? message.id : null;
    const entry = id === null ? undefined : pending.get(id);
    if (!entry) {
      return;
    }
    pending.delete(id as number);
    clearTimeout(entry.timer);
    if (message.ok === false) {
      entry.reject(new Error(message.error || "nativeHostError"));
      return;
    }
    entry.resolve(message);
  });

  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || "nativeHostUnavailable";
    settleAll(new Error(reason));
  });

  const call = (request: NativeRequest) =>
    new Promise<NativeResponse>((resolve, reject) => {
      const id = nextId++;
      const timer = (setTimeout(() => {
        pending.delete(id);
        reject(new Error("nativeHostTimeout"));
      }, REQUEST_TIMEOUT_MS) as unknown) as number;
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ ...request, id });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  try {
    return await worker(call);
  } finally {
    try {
      port.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

export async function isLocalImportEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  return stored[ENABLED_KEY] === true;
}

export async function setLocalImportEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

export async function getLocalImportInterval(): Promise<number> {
  const stored = await chrome.storage.local.get(INTERVAL_KEY);
  return clampInterval(stored[INTERVAL_KEY]);
}

export async function setLocalImportInterval(minutes: number): Promise<number> {
  const value = clampInterval(minutes);
  await chrome.storage.local.set({ [INTERVAL_KEY]: value });
  return value;
}

export async function getLocalImportStatus(): Promise<LocalImportStatus> {
  try {
    const status = await withNativeHost((call) => call({ type: "status" }));
    return {
      available: true,
      dir: typeof status.dir === "string" ? status.dir : undefined,
      pattern: typeof status.pattern === "string" ? status.pattern : undefined,
      maxBytes:
        typeof status.maxBytes === "number" ? status.maxBytes : undefined,
      deleteAfterImport:
        typeof status.deleteAfterImport === "boolean"
          ? status.deleteAfterImport
          : undefined,
      intervalMinutes:
        typeof status.intervalMinutes === "number"
          ? clampInterval(status.intervalMinutes)
          : undefined,
      fileCount:
        typeof status.fileCount === "number" ? status.fileCount : undefined,
      importedCount:
        typeof status.importedCount === "number"
          ? status.importedCount
          : undefined,
      pending: (status.pending as LocalBackupInfo | null) || null,
      lastImported:
        (status.lastImported as { name: string; at: number } | null) || null,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Pulls the newest export the host has not delivered yet and imports it.
 * Returns null when there is nothing new (or when the same file failed a
 * moment ago and `ignoreCooldown` is false), so callers can stay silent.
 */
export async function importFromLocalHost(
  options: { ignoreCooldown?: boolean } = {}
): Promise<BackupImportResult | null> {
  return withNativeHost(async (call) => {
    const status = await call({ type: "status" });
    const info = status.pending as LocalBackupInfo | null;
    if (!info) {
      return null;
    }
    if (!options.ignoreCooldown && (await isCoolingDown(info.digest))) {
      return null;
    }

    const chunks: Uint8Array[] = [];
    let offset = 0;
    try {
      for (;;) {
        const chunk = await call({
          type: "read",
          name: info.name,
          offset,
          length: CHUNK_BYTES,
        });
        chunks.push(base64ToBytes(String(chunk.data || "")));
        offset = Number(chunk.offset) + Number(chunk.length);
        if (chunk.eof) {
          break;
        }
      }

      const content = new TextDecoder().decode(concatBytes(chunks));
      const result = await importBackupContent({ content });
      await call({ type: "ack", name: info.name, digest: info.digest });
      await clearFailure();
      return result;
    } catch (error) {
      // A vault that locked mid-import is not a broken export: keep it
      // eligible so the next unlock retries right away.
      if (!(error instanceof Error && error.message === "vaultLocked")) {
        await recordFailure(info.digest);
      }
      throw error;
    }
  });
}

async function isCoolingDown(digest: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(FAILURE_KEY);
  const failure = stored[FAILURE_KEY] as
    | { digest?: string; at?: number }
    | undefined;
  if (!failure || failure.digest !== digest || typeof failure.at !== "number") {
    return false;
  }
  return Date.now() - failure.at < FAILURE_COOLDOWN_MS;
}

async function recordFailure(digest: string): Promise<void> {
  await chrome.storage.local.set({
    [FAILURE_KEY]: { digest, at: Date.now() },
  });
}

async function clearFailure(): Promise<void> {
  await chrome.storage.local.remove(FAILURE_KEY);
}
