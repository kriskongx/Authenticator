import { buildOtpAuthUri } from "./otpauth-uri";

function byteArray2Base32(bytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let result = "";
  let buffer = 0;
  let bitsLeft = 0;

  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i];
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      result += chars[(buffer >>> bitsLeft) & 0x1f];
    }
  }

  if (bitsLeft > 0) {
    result += chars[(buffer << (5 - bitsLeft)) & 0x1f];
  }

  const padLen = (8 - (result.length % 8)) % 8;
  return result + "=".repeat(padLen);
}

function decodeBase64ToBytes(raw: string): Uint8Array | null {
  try {
    const normalized = raw
      .trim()
      .replace(/ /g, "+")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function readVarint(
  bytes: Uint8Array,
  start: number
): { value: number; next: number } | null {
  let result = 0;
  let multiplier = 1;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    result += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value: result, next: offset };
    }
    multiplier *= 128;
    if (offset - start > 10) {
      return null;
    }
  }
  return null;
}

function skipField(
  bytes: Uint8Array,
  offset: number,
  wireType: number
): number | null {
  switch (wireType) {
    case 0: {
      const skipped = readVarint(bytes, offset);
      return skipped ? skipped.next : null;
    }
    case 1:
      return offset + 8 <= bytes.length ? offset + 8 : null;
    case 2: {
      const len = readVarint(bytes, offset);
      if (!len || len.next + len.value > bytes.length) {
        return null;
      }
      return len.next + len.value;
    }
    case 5:
      return offset + 4 <= bytes.length ? offset + 4 : null;
    default:
      return null;
  }
}

function parseOtpParameters(bytes: Uint8Array): string | null {
  const decoder = new TextDecoder();
  let secretBytes: Uint8Array | null = null;
  let account = "";
  let issuer = "";
  let algorithmIndex = 1;
  let digitsIndex = 1;
  let typeIndex = 2;
  let counter: number | undefined;

  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) {
      return null;
    }
    offset = tag.next;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x07;

    if (wireType === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.next + length.value > bytes.length) {
        return null;
      }
      const slice = bytes.subarray(length.next, length.next + length.value);
      offset = length.next + length.value;
      if (fieldNumber === 1) {
        secretBytes = slice;
      } else if (fieldNumber === 2) {
        account = decoder.decode(slice);
      } else if (fieldNumber === 3) {
        issuer = decoder.decode(slice);
      }
    } else if (wireType === 0) {
      const val = readVarint(bytes, offset);
      if (!val) {
        return null;
      }
      offset = val.next;
      if (fieldNumber === 4) {
        algorithmIndex = val.value;
      } else if (fieldNumber === 5) {
        digitsIndex = val.value;
      } else if (fieldNumber === 6) {
        typeIndex = val.value;
      } else if (fieldNumber === 7) {
        counter = val.value;
      }
    } else {
      const nextOffset = skipField(bytes, offset, wireType);
      if (nextOffset === null) {
        return null;
      }
      offset = nextOffset;
    }
  }

  if (!secretBytes || secretBytes.length === 0) {
    return null;
  }

  const secret = byteArray2Base32(secretBytes);
  const algorithm =
    ["SHA1", "SHA1", "SHA256", "SHA512", "MD5"][algorithmIndex] || "SHA1";
  const digits = [6, 6, 8][digitsIndex] || 6;
  const type = ["totp", "hotp", "totp"][typeIndex] || "totp";

  return buildOtpAuthUri({
    type,
    account,
    secret,
    issuer,
    algorithm,
    digits,
    counter: type === "hotp" ? counter ?? 0 : undefined,
  });
}

function extractMigrationDataParam(migrationUri: string): string | null {
  try {
    const parsed = new URL(migrationUri.trim());
    return parsed.searchParams.get("data");
  } catch {
    const match = /[?&]data=([^&#]+)/i.exec(migrationUri);
    if (!match) {
      return null;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

export function getOTPAuthPerLineFromOPTAuthMigration(
  migrationUri: string
): string[] {
  if (!migrationUri.trim().toLowerCase().startsWith("otpauth-migration:")) {
    return [];
  }

  const base64Data = extractMigrationDataParam(migrationUri);
  if (!base64Data) {
    return [];
  }

  const byteData = decodeBase64ToBytes(base64Data);
  if (!byteData || byteData.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let offset = 0;
  while (offset < byteData.length) {
    const tag = readVarint(byteData, offset);
    if (!tag) {
      break;
    }
    offset = tag.next;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x07;

    if (fieldNumber === 1 && wireType === 2) {
      const length = readVarint(byteData, offset);
      if (!length || length.next + length.value > byteData.length) {
        break;
      }
      const entryBytes = byteData.subarray(
        length.next,
        length.next + length.value
      );
      offset = length.next + length.value;
      const line = parseOtpParameters(entryBytes);
      if (line) {
        lines.push(line);
      }
    } else {
      const nextOffset = skipField(byteData, offset, wireType);
      if (nextOffset === null) {
        break;
      }
      offset = nextOffset;
    }
  }

  return lines;
}
