import type { Encryption } from "./encryption";
import { applyDecryptedBackup, decryptParsedBackup } from "./import-service";
import { parseBackupContentOffThread } from "./import-worker-client";
import { EntryStorage } from "./storage";

export type RestoreProgressReporter = (value: number, labelKey: string) => void;

export type BackupPassphraseResult =
  | string
  | { preUnlockedKeys: Map<string, string> }
  | { handledInBackground: true }
  | null;

export type RestoreBackupOptions = {
  content: string;
  encryption: Encryption;
  clearFirst: boolean;
  signal?: AbortSignal;
  /** Asked only when the backup itself is password protected. */
  requestPassphrase?: () => Promise<BackupPassphraseResult>;
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

  const activeEncryption = await EntryStorage.assertEncryptionReadyForVault(
    encryption
  );

  try {
    onProgress?.(48, "ui_progress_parsing_backup");
    const parsed = await parseBackupContentOffThread(content, {
      signal,
      onProgress: (value) =>
        onProgress?.(48 + value * 0.16, "ui_progress_parsing_backup"),
    });

    const passphraseResult = parsed.requiresPassphrase
      ? await (requestPassphrase ? requestPassphrase() : Promise.resolve(null))
      : null;
    if (parsed.requiresPassphrase && !passphraseResult) {
      throw new Error("cancelled");
    }
    if (
      passphraseResult &&
      typeof passphraseResult === "object" &&
      "handledInBackground" in passphraseResult
    ) {
      await refresh();
      return {
        failedCount: 0,
        succeededCount: parsed.succeededCount,
      };
    }

    const passphrase =
      typeof passphraseResult === "string" ? passphraseResult : null;
    const preUnlockedKeys =
      passphraseResult &&
      typeof passphraseResult === "object" &&
      "preUnlockedKeys" in passphraseResult
        ? passphraseResult.preUnlockedKeys
        : undefined;

    onProgress?.(
      68,
      passphrase || preUnlockedKeys
        ? "ui_progress_decrypting"
        : "ui_progress_preparing_import"
    );
    const decrypted = await decryptParsedBackup(
      parsed,
      passphrase,
      signal,
      preUnlockedKeys
    );

    // Applying is not safely interruptible, so callers lock their cancel UI here.
    onApplyStart?.();
    await applyDecryptedBackup(decrypted, {
      encryption: activeEncryption,
      clearFirst,
      onProgress: (value, key) => onProgress?.(value, key),
      refresh,
      signal,
    });

    return {
      failedCount: parsed.failedCount,
      succeededCount: parsed.succeededCount,
    };
  } catch (error) {
    const message = (error as Error).message;
    if (message === "importCancelled") {
      throw new Error("cancelled");
    }
    if (
      message === "noImportableEntries" ||
      message === "invalidBackupFormat"
    ) {
      throw new Error("parseError");
    }
    throw error;
  }
}
