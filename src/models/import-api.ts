import { Encryption } from "./encryption";
import { MAX_BACKUP_CONTENT_BYTES } from "./import-limits";
import {
  applyDecryptedBackup,
  decryptParsedBackup,
  parseBackupContent,
} from "./import-service";
import { EntryStorage } from "./storage";

export type BackupImportSource = "json" | "bitwarden" | "otpauth";

export interface BackupImportOptions {
  content: string;
  passphrase?: string | null;
  preUnlockedKeys?: Map<string, string>;
  clearFirst?: boolean;
  /** Drop records that already exist in the vault. Default true. */
  skipExisting?: boolean;
}

export interface BackupImportResult {
  source: BackupImportSource;
  importedEntryCount: number;
  importedGroupCount: number;
  groupedEntryCount: number;
  normalizedGroupReferenceCount: number;
  clearedEntryCount?: number;
  clearedGroupCount?: number;
  failedCount: number;
  succeededCount: number;
  skippedEntryCount?: number;
}

function normalizeText(value: string | undefined): string {
  return (value || "").trim().toLowerCase();
}

function normalizeSecret(value: string | undefined): string {
  return (value || "").replace(/[\s=]+/g, "").toUpperCase();
}

// Bitwarden/Vaultwarden exports get a fresh UUID per entry, so the same account
// would be inserted again on every export. Identify duplicates by content.
function entryKey(
  issuer: string | undefined,
  account: string | undefined,
  secret: string | undefined
): string {
  return [
    normalizeText(issuer),
    normalizeText(account),
    normalizeSecret(secret),
  ].join("\u0000");
}

async function collectExistingEntryKeys(
  defaultEncryption: Encryption,
  encryptions: Map<string, Encryption>
): Promise<Set<string>> {
  const keys = new Set<string>();
  const entries = await EntryStorage.get();
  for (const entry of entries) {
    const entryEncryption =
      (entry.keyId && encryptions.get(entry.keyId)) || defaultEncryption;
    if (entryEncryption.getEncryptionStatus()) {
      await entry.applyEncryption(entryEncryption);
    }
    if (entry.secret) {
      keys.add(entryKey(entry.issuer, entry.account, entry.secret));
    }
  }
  return keys;
}

/**
 * Runs the same parse → decrypt → apply pipeline as `view/import.html`, without
 * touching the DOM, so the service worker can import a backup on behalf of an
 * external caller.
 *
 * When the vault has an encryption key configured, it must be unlocked first:
 * writing entries through an empty `Encryption` would store plaintext secrets
 * inside an encrypted vault.
 */
export async function importBackupContent(
  options: BackupImportOptions
): Promise<BackupImportResult> {
  const content = options.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("importContentMissing");
  }
  if (new Blob([content]).size > MAX_BACKUP_CONTENT_BYTES) {
    throw new Error("backupContentTooLarge");
  }

  const {
    cachedPassphrase,
    cachedKeyId,
    cachedBiometricKeys,
  } = await chrome.storage.session.get([
    "cachedPassphrase",
    "cachedKeyId",
    "cachedBiometricKeys",
  ]);
  const encryption = await EntryStorage.assertEncryptionReadyForVault(
    new Encryption(cachedPassphrase || "", cachedKeyId || "")
  );

  const encryptions = new Map<string, Encryption>();
  if (Array.isArray(cachedBiometricKeys)) {
    for (const item of cachedBiometricKeys) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.id === "string" &&
        typeof item.secret === "string"
      ) {
        encryptions.set(item.id, new Encryption(item.secret, item.id));
      }
    }
  }
  if (encryption.getEncryptionStatus() && cachedKeyId) {
    encryptions.set(cachedKeyId, encryption);
  }

  const parsed = await parseBackupContent(content);
  const decrypted = await decryptParsedBackup(
    parsed,
    options.passphrase || null,
    undefined,
    options.preUnlockedKeys
  );

  let skippedEntryCount = 0;
  if (options.clearFirst !== true && options.skipExisting !== false) {
    const existingKeys = await collectExistingEntryKeys(
      encryption,
      encryptions
    );
    for (const hash of Object.keys(decrypted.entries)) {
      const record = decrypted.entries[hash];
      const key = entryKey(record.issuer, record.account, record.secret);
      if (existingKeys.has(key)) {
        delete decrypted.entries[hash];
        skippedEntryCount++;
      }
    }
    if (!Object.keys(decrypted.entries).length) {
      return {
        source: parsed.source,
        failedCount: parsed.failedCount,
        succeededCount: parsed.succeededCount,
        importedEntryCount: 0,
        importedGroupCount: 0,
        groupedEntryCount: 0,
        normalizedGroupReferenceCount: 0,
        skippedEntryCount,
      };
    }
  }

  const applied = await applyDecryptedBackup(decrypted, {
    encryption,
    clearFirst: options.clearFirst === true,
  });

  return {
    source: parsed.source,
    failedCount: parsed.failedCount,
    succeededCount: parsed.succeededCount,
    skippedEntryCount,
    ...applied,
  };
}

export async function isVaultLocked(): Promise<boolean> {
  if (!(await EntryStorage.hasEncryptionKey())) {
    return false;
  }
  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get([
    "cachedPassphrase",
    "cachedKeyId",
  ]);
  try {
    await EntryStorage.assertEncryptionReadyForVault(
      new Encryption(cachedPassphrase || "", cachedKeyId || "")
    );
    return false;
  } catch {
    return true;
  }
}
