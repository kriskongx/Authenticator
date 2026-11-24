import "mocha";
import { expect } from "chai";
import * as CryptoJS from "crypto-js";
import {
  assertBackupContentSize,
  decryptParsedBackup,
  parseBackupContent,
} from "../../models/import-service";
import {
  BACKUP_PARSE_WORKER_THRESHOLD_BYTES,
  shouldParseBackupInWorker,
} from "../../models/import-worker-client";
import { normalizeImportedEntryGroupIds } from "../../models/import-utils";
import { Encryption } from "../../models/encryption";

mocha.setup("bdd");

describe("Backup import service", () => {
  it("uses the background parser for large backup text", () => {
    expect(
      shouldParseBackupInWorker("x".repeat(BACKUP_PARSE_WORKER_THRESHOLD_BYTES))
    ).to.equal(true);
    expect(shouldParseBackupInWorker("small backup")).to.equal(false);
  });

  it("rejects backup content larger than the configured limit", () => {
    expect(() => assertBackupContentSize("1234", 3)).to.throw(
      "backupContentTooLarge"
    );
    expect(() => assertBackupContentSize("1234", 4)).not.to.throw();
  });

  it("maps Bitwarden folders to imported OTP groups", async () => {
    const folderId = "group-1";
    const parsed = await parseBackupContent(
      JSON.stringify({
        encrypted: false,
        folders: [{ id: folderId, name: "开发" }],
        items: [
          {
            type: 1,
            name: "GitHub",
            folderId,
            login: {
              username: "developer@example.com",
              totp: "JBSWY3DPEHPK3PXP",
            },
          },
        ],
      })
    );
    const decrypted = await decryptParsedBackup(parsed, null);
    const entry = Object.values(decrypted.entries)[0];

    expect(parsed.source).to.equal("bitwarden");
    expect(decrypted.groups[folderId].name).to.equal("开发");
    expect(entry.groupId).to.equal(folderId);
  });

  it("removes group references that do not exist after import", () => {
    const entries: { [hash: string]: RawOTPStorage } = {
      entry: {
        encrypted: false,
        hash: "entry",
        index: 0,
        secret: "JBSWY3DPEHPK3PXP",
        type: "totp",
        groupId: "missing-group",
      },
    };

    const normalizedCount = normalizeImportedEntryGroupIds(entries, []);

    expect(normalizedCount).to.equal(1);
    expect(entries.entry.groupId).to.equal(undefined);
  });

  it("counts only OTP records in JSON backups", async () => {
    const parsed = await parseBackupContent(
      JSON.stringify({
        group: {
          dataType: "Group",
          id: "group",
          name: "测试",
          index: 0,
        },
        entry: {
          encrypted: false,
          hash: "entry",
          index: 0,
          secret: "JBSWY3DPEHPK3PXP",
          type: "totp",
        },
      })
    );

    expect(parsed.succeededCount).to.equal(1);
    expect(Object.keys(parsed.groups)).to.deep.equal(["group"]);
  });

  it("does not reinterpret valid but unsupported JSON as otpauth text", async () => {
    let error: Error | null = null;
    try {
      await parseBackupContent(JSON.stringify(["not", "a", "backup"]));
    } catch (caughtError) {
      error = caughtError as Error;
    }

    expect(error?.message).to.equal("invalidBackupFormat");
  });

  it("reports an incorrect passphrase for legacy encrypted entries", async () => {
    const hash = "11111111-1111-4111-8111-111111111111";
    const parsed = await parseBackupContent(
      JSON.stringify({
        [hash]: {
          encrypted: true,
          hash,
          index: 0,
          secret: CryptoJS.AES.encrypt(
            "JBSWY3DPEHPK3PXP",
            "correct-password"
          ).toString(),
          type: "totp",
        },
      })
    );

    let error: Error | null = null;
    try {
      await decryptParsedBackup(parsed, "wrong-password");
    } catch (caughtError) {
      error = caughtError as Error;
    }

    expect(error?.message).to.equal("incorrectPassphrase");
  });

  it("imports Bitwarden steam:// secrets and preserves HOTP counters", async () => {
    const parsed = await parseBackupContent(
      JSON.stringify({
        items: [
          {
            name: "Steam",
            login: {
              username: "gamer",
              totp: "steam://JBSWY3DPEHPK3PXP",
            },
          },
          {
            name: "CounterApp",
            login: {
              username: "alice",
              totp:
                "otpauth://hotp/CounterApp:alice?secret=JBSWY3DPEHPK3PXP&counter=42",
            },
          },
        ],
      })
    );

    const records = Object.values(parsed.records) as RawOTPStorage[];
    const steam = records.find((r) => r.issuer === "Steam");
    const hotp = records.find((r) => r.issuer === "CounterApp");
    expect(parsed.failedCount).to.equal(0);
    expect(steam?.type).to.equal("steam");
    expect(steam?.secret).to.equal("JBSWY3DPEHPK3PXP");
    expect(hotp?.type).to.equal("hotp");
    expect(hotp?.counter).to.equal(42);
  });

  it("keeps lowercase Base32 Bitwarden otpauth secrets as totp instead of hex", async () => {
    const parsed = await parseBackupContent(
      JSON.stringify({
        items: [
          {
            name: "LowerBase32",
            login: {
              username: "bob",
              totp:
                "  otpauth://totp/LowerBase32:bob?secret=abcdef234567abcd  ",
            },
          },
          {
            name: "LowerFullBase32",
            login: {
              username: "carol",
              totp:
                "otpauth://totp/LowerFullBase32:carol?secret=jbswy3dpehpk3pxp",
            },
          },
        ],
      })
    );

    const records = Object.values(parsed.records) as RawOTPStorage[];
    const lowerHexLike = records.find((r) => r.issuer === "LowerBase32");
    const lowerFull = records.find((r) => r.issuer === "LowerFullBase32");
    expect(parsed.failedCount).to.equal(0);
    expect(lowerHexLike?.type).to.equal("totp");
    expect(lowerFull?.type).to.equal("totp");
  });

  it("ignores null and malformed records safely during backup decryption", async () => {
    const parsed = await parseBackupContent(
      JSON.stringify({
        brokenNull: null,
        brokenGroup: { dataType: "Group", id: "g1", name: 123 },
        validEntry: {
          dataType: "OTPStorage",
          encrypted: false,
          hash: "11111111-1111-4111-8111-111111111111",
          index: 0,
          issuer: "GitHub",
          secret: "JBSWY3DPEHPK3PXP",
          type: "totp",
        },
      })
    );
    const decrypted = await decryptParsedBackup(parsed, null);
    expect(Object.keys(decrypted.entries)).to.deep.equal(["validEntry"]);
    expect(Object.keys(decrypted.groups)).to.deep.equal([]);
  });

  it("decrypts v3 encrypted backup entries and groups using pre-unlocked biometric keys", async () => {
    const encryption = new Encryption("derived-vault-key", "key-bio-1");
    const rawEntry: RawOTPStorage = {
      account: "alice@example.com",
      dataType: "OTPStorage",
      encrypted: true,
      hash: "11111111-1111-4111-8111-111111111111",
      index: 0,
      issuer: "GitHub",
      secret: "JBSWY3DPEHPK3PXP",
      type: "totp",
      groupId: "group-bio-1",
    };
    const rawGroup: GroupStorageRecord = {
      dataType: "Group",
      id: "group-bio-1",
      index: 0,
      name: "Work",
    };

    const parsed = await parseBackupContent(
      JSON.stringify({
        [rawEntry.hash]: {
          dataType: "EncOTPStorage",
          keyId: "key-bio-1",
          data: encryption.getEncryptedString(JSON.stringify(rawEntry)),
          index: 0,
        },
        [rawGroup.id]: {
          dataType: "EncGroup",
          keyId: "key-bio-1",
          data: encryption.getEncryptedString(JSON.stringify(rawGroup)),
          index: 0,
        },
      })
    );

    const decrypted = await decryptParsedBackup(
      parsed,
      null,
      undefined,
      new Map([["key-bio-1", "derived-vault-key"]])
    );
    expect(decrypted.entries[rawEntry.hash]?.secret).to.equal(
      "JBSWY3DPEHPK3PXP"
    );
    expect(decrypted.groups[rawGroup.id]?.name).to.equal("Work");

    let mismatchError: Error | null = null;
    try {
      await decryptParsedBackup(
        parsed,
        null,
        undefined,
        new Map([["other-key-id", "other-secret"]])
      );
    } catch (caught) {
      mismatchError = caught as Error;
    }
    expect(mismatchError?.message).to.equal("biometricBackupKeyMismatch");
  });
});
