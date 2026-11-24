import { parseOtpAuthUri } from "./otpauth-uri";
import { createRecordMap } from "./record-map";

interface BitwardenItem {
  folderId?: string | null;
  name?: string;
  login?: { totp?: string; username?: string };
  notes?: string;
}

interface BitwardenFolder {
  id?: string;
  name?: string;
}

/**
 * Parse OTP entries from a Bitwarden JSON export
 */
export async function getEntryDataFromBitwarden(data: {
  items?: BitwardenItem[];
  folders?: BitwardenFolder[];
}) {
  const exportData = createRecordMap<RawOTPStorage>();
  const groups = createRecordMap<GroupStorageRecord>();
  let failedCount = 0;
  let succeededCount = 0;

  for (const folder of data.folders || []) {
    const id = (folder.id || "").trim();
    const name = (folder.name || "").trim();
    if (!id || !name) {
      continue;
    }

    groups[id] = {
      dataType: "Group",
      id,
      name,
      index: Object.keys(groups).length,
    };
  }

  for (const item of data.items || []) {
    const rawTotp = item.login?.totp;
    const totp = typeof rawTotp === "string" ? rawTotp.trim() : "";
    if (!totp) {
      continue;
    }

    let type = "totp";
    let secret: string;
    let issuer = (item.name || "").trim();
    let account = (item.login?.username || "").trim();
    let counter: number | undefined;
    let period: number | undefined;
    let digits: number | undefined;
    let algorithm: string | undefined;
    let parsedFromUri = false;

    if (totp.toLowerCase().startsWith("otpauth://")) {
      const parsed = parseOtpAuthUri(totp);
      if (!parsed) {
        failedCount++;
        continue;
      }
      parsedFromUri = true;
      type = parsed.type;
      secret = parsed.secret;
      issuer = issuer || parsed.issuer;
      account = account || parsed.account;
      counter = parsed.counter;
      period = parsed.period;
      digits = parsed.digits;
      algorithm = parsed.algorithm;
    } else if (totp.toLowerCase().startsWith("steam://")) {
      type = "steam";
      secret = totp.slice("steam://".length).replace(/\s+/g, "").toUpperCase();
    } else {
      // Plain base32 secret (may be lowercase or have spaces)
      secret = totp.replace(/\s+/g, "").toUpperCase();
    }

    if (!/^[2-7A-Z]+=*$/i.test(secret) && !/^[0-9a-f]+$/i.test(secret)) {
      failedCount++;
      continue;
    }

    if (
      !parsedFromUri &&
      type !== "steam" &&
      /^[0-9a-f]+$/i.test(secret) &&
      !/^[2-7A-Z]+=*$/i.test(secret)
    ) {
      type = type === "hotp" ? "hhex" : "hex";
    }

    const hash = crypto.randomUUID();
    const entry: RawOTPStorage = {
      account,
      encrypted: false,
      hash,
      index: 0,
      issuer,
      note: (item.notes || "").trim(),
      secret,
      type,
      pinned: false,
    };

    const folderId = (item.folderId || "").trim();
    if (folderId) {
      // Preserve folder binding even if the folders array is missing or stale.
      // When the matching group record is imported, the association will still work.
      entry.groupId = folderId;
    }

    if (counter !== undefined) {
      entry.counter = counter;
    }
    if (period) {
      entry.period = period;
    }
    if (digits) {
      entry.digits = digits;
    }
    if (algorithm) {
      entry.algorithm = algorithm;
    }

    exportData[hash] = entry;
    succeededCount++;
  }

  return { exportData, groups, failedCount, succeededCount };
}
