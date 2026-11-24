import type { Encryption } from "./encryption";
import { applyDecryptedBackup, decryptParsedBackup } from "./import-service";
import { parseBackupContentOffThread } from "./import-worker-client";

export type RestoreProgressReporter = (value: number, labelKey: string) => void;

export type RestoreBackupOptions = {
  content: string;
  encryption: Encryption;
  clearFirst: boolean;
  signal?: AbortSignal;
  /** Asked only when the backup itself is password protected. */
  requestPassphrase?: () => Promise<string | null>;
  refresh: () => Promise<void>;
  onProgress?: RestoreProgressReporter;
  /** Fired right before the import starts, e.g. to disable cancel buttons. */
  onApplyStart?: () => void;
};

export type RestoreBackupResult = {
  /** Entries that failed to import (0 when everything was fine). */
  failedCount: number;
  succeededCount: number;
};

/**
 * Parses, decrypts and applies a backup payload. Shared by the WebDAV settings
 * page and the quick restore dialog so both stay in step; the caller keeps the
 * messaging and the UI. Errors are thrown with the codes the callers already
 * switch on (`cancelled`, `parseError`, `incorrectPassphrase`, ...).
 */
export async function restoreBackupContent(
  options: RestoreBackupOptions
): Promise<RestoreBackupResult> {
  const {
    content,
    encryption,
    clearFirst,
    signal,
    requestPassphrase,
    refresh,
    onProgress,
    onApplyStart,
  } = options;

  onProgress?.(48, "ui_progress_parsing_backup");
  const parsed = await parseBackupContentOffThread(content, {
    signal,
    onProgress: (value) =>
      onProgress?.(48 + value * 0.16, "ui_progress_parsing_backup"),
  });

  const passphrase = parsed.requiresPassphrase
    ? await (requestPassphrase ? requestPassphrase() : Promise.resolve(null))
    : null;
  if (parsed.requiresPassphrase && !passphrase) {
    throw new Error("cancelled");
  }

  onProgress?.(
    68,
    passphrase ? "ui_progress_decrypting" : "ui_progress_preparing_import"
  );
  const decrypted = await decryptParsedBackup(parsed, passphrase, signal);

  // Applying is not safely interruptible, so callers lock their cancel UI here.
  onApplyStart?.();
  // Applying is not safely interruptible, so callers lock their cancel UI here.
  onApplyStart?.();
  try {
    await applyDecryptedBackup(decrypted, {
      encryption,
      clearFirst,
      onProgress: (value, key) => onProgress?.(value, key),
      refresh,
      signal,
    });
  } catch (error) {
    // The UI shows "unreadable file" for this one.
    if ((error as Error).message === "noImportableEntries") {
      throw new Error("parseError");
    }
    throw error;
  }

  return {
    failedCount: parsed.failedCount,
    succeededCount: parsed.succeededCount,
  };
}
