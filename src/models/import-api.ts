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
  encryption: Encryption
): Promise<Set<string>> {
  const keys = new Set<string>();
  const entries = await EntryStorage.get();
  for (const entry of entries) {
    await entry.applyEncryption(encryption);
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
 * The vault must be unlocked: writing entries through an empty `Encryption`
 * would store plaintext secrets inside an encrypted vault.
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

  const { cachedPassphrase, cachedKeyId } = await chrome.storage.session.get([
    "cachedPassphrase",
    "cachedKeyId",
  ]);
  const encryption = new Encryption(cachedPassphrase, cachedKeyId);
  if (!encryption.getEncryptionStatus()) {
    throw new Error("vaultLocked");
  }

  const parsed = await parseBackupContent(content);
  const decrypted = await decryptParsedBackup(
    parsed,
    options.passphrase || null
  );

  let skippedEntryCount = 0;
  if (options.clearFirst !== true && options.skipExisting !== false) {
    const existingKeys = await collectExistingEntryKeys(encryption);
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
  const { cachedPassphrase } = await chrome.storage.session.get(
    "cachedPassphrase"
  );
  if (cachedPassphrase) {
    return false;
  }
  const entries = await EntryStorage.get();
  return entries.some(
    (entry) => Boolean(entry.encData) || Boolean(entry.encSecret)
  );
}
