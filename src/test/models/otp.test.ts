import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import {
  CodeState,
  normalizeOtpSecretForType,
  OTPAlgorithm,
  OTPEntry,
  OTPType,
  regenerateLegacyEntryHash,
} from "../../models/otp";
import { KeyUtilities } from "../../models/key-utilities";
import { verifyLocalBackupDigest } from "../../models/local-import";
import { UserSettings } from "../../models/settings";
import { getUnresolvedEncryptionKeyIds } from "../../store/Accounts";

mocha.setup("bdd");

describe("OTP secret normalization", () => {
  it("normalizes spaced Base32 secrets and preserves the TOTP family", () => {
    const result = normalizeOtpSecretForType(
      "JBSW Y3DP EHPK 3PXP",
      OTPType.hex
    );

    expect(result).to.deep.equal({
      secret: "JBSWY3DPEHPK3PXP",
      type: OTPType.totp,
    });
  });

  it("switches HOTP entries to hexadecimal mode for hex-only secrets", () => {
    const result = normalizeOtpSecretForType("0123456789abcdef", OTPType.hotp);

    expect(result).to.deep.equal({
      secret: "0123456789abcdef",
      type: OTPType.hhex,
    });
  });

  it("rejects short or malformed secrets", () => {
    expect(normalizeOtpSecretForType("ABC", OTPType.totp)).to.equal(null);
    expect(
      normalizeOtpSecretForType("INVALID-SECRET-123", OTPType.totp)
    ).to.equal(null);
  });

  it("preserves custom periods for hexadecimal TOTP entries", () => {
    const entry = new OTPEntry({
      encrypted: false,
      index: 0,
      secret: "0123456789abcdef",
      type: OTPType.hex,
      period: 45,
    });

    expect(entry.period).to.equal(45);
  });

  it("keeps UUID v4 entry hashes unchanged during encryption migration", () => {
    const genUUID = sinon.spy();
    const entry = {
      hash: "123e4567-e89b-42d3-a456-426614174000",
      genUUID,
    };

    expect(regenerateLegacyEntryHash(entry)).to.equal(null);
    expect(genUUID.called).to.equal(false);
  });

  it("returns the old key before replacing a legacy entry hash", () => {
    const entry = {
      hash: "legacy-storage-key",
      genUUID() {
        this.hash = "123e4567-e89b-42d3-a456-426614174000";
      },
    };

    expect(regenerateLegacyEntryHash(entry)).to.equal("legacy-storage-key");
    expect(entry.hash).to.equal("123e4567-e89b-42d3-a456-426614174000");
  });

  it("counts distinct unresolved encryption keys", () => {
    const entries = [
      { secret: null, keyId: "key-a" },
      { secret: null, keyId: "key-a" },
      { secret: null, keyId: "key-b" },
      { secret: "JBSWY3DPEHPK3PXP", keyId: "key-c" },
    ] as OTPEntryInterface[];

    expect(Array.from(getUnresolvedEncryptionKeyIds(entries))).to.deep.equal([
      "key-a",
      "key-b",
    ]);
  });

  it("caches TOTP code within the same period step and recomputes on step or secret change", () => {
    const clock = sinon.useFakeTimers({ now: 30_000 });
    const previousItems = UserSettings.items;
    UserSettings.items = { offset: 0 };
    const generateSpy = sinon.spy(KeyUtilities, "generate");
    try {
      const entry = new OTPEntry({
        encrypted: false,
        index: 0,
        secret: "JBSWY3DPEHPK3PXP",
        type: OTPType.totp,
        period: 30,
      });
      expect(generateSpy.callCount).to.equal(1);
      const firstCode = entry.code;

      // Same 30s window: should hit cache and skip recomputation.
      clock.tick(10_000);
      entry.generate();
      expect(generateSpy.callCount).to.equal(1);
      expect(entry.code).to.equal(firstCode);

      // Next 30s window: should recompute.
      clock.tick(20_000);
      entry.generate();
      expect(generateSpy.callCount).to.equal(2);

      // Changing secret within the same window: should recompute.
      entry.secret = "JBSWY3DPEHPK3PXQ";
      entry.generate();
      expect(generateSpy.callCount).to.equal(3);
    } finally {
      UserSettings.items = previousItems;
    }
  });

  it("rejects hex-only secrets for Battle.net and Steam and throws on invalid Base32", () => {
    expect(
      normalizeOtpSecretForType("0123456789abcdef", OTPType.battle)
    ).to.equal(null);
    expect(
      normalizeOtpSecretForType("0123456789abcdef", OTPType.steam)
    ).to.equal(null);
    expect(() =>
      KeyUtilities.generate(OTPType.totp, "0123456789ABCDEF", 0, 30)
    ).to.throw("Invalid Base32 string");
  });

  it("marks locked legacy v2 entries as Encrypted instead of Invalid", () => {
    const entry = new OTPEntry({
      encrypted: true,
      hash: "legacy-v2-hash",
      index: 0,
      secret: "U2FsdGVkX1+ciphertext",
      type: OTPType.totp,
    });
    expect(entry.secret).to.equal(null);
    expect(entry.code).to.equal(CodeState.Encrypted);
  });

  it("uses RFC 6238 floor time steps instead of rounding up 500ms early", () => {
    const stepZeroEnd = KeyUtilities.generate(
      OTPType.totp,
      "JBSWY3DPEHPK3PXP",
      0,
      30,
      6,
      OTPAlgorithm.SHA1,
      0,
      Math.floor(29_700 / 1000)
    );
    const stepZeroMid = KeyUtilities.generate(
      OTPType.totp,
      "JBSWY3DPEHPK3PXP",
      0,
      30,
      6,
      OTPAlgorithm.SHA1,
      0,
      15
    );
    expect(stepZeroEnd).to.equal(stepZeroMid);
  });

  it("produces exact GOST 2012-256 and 2012-512 OTPs without crypto-js typedarrays", () => {
    const counter = Math.floor(
      Date.parse("2021-01-01T00:00:00.000Z") / 1000 / 30
    );
    const gost256 = KeyUtilities.generate(
      OTPType.hhex,
      "B1B0AE0E5ADFBF89A5F7DF440592A3AE",
      counter,
      30,
      6,
      OTPAlgorithm.GOST3411_2012_256
    );
    const gost512 = KeyUtilities.generate(
      OTPType.hhex,
      "B1B0AE0E5ADFBF89A5F7DF440592A3AE",
      counter,
      30,
      6,
      OTPAlgorithm.GOST3411_2012_512
    );
    expect(gost256).to.equal("147947");
    expect(gost512).to.equal("838480");
  });

  it("matches sha256:-prefixed digests from native host in verifyLocalBackupDigest", async () => {
    const bytes = new TextEncoder().encode("hello-authenticator");
    const rawHashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(rawHashBuffer), (b) =>
      b.toString(16).padStart(2, "0")
    ).join("");

    expect(await verifyLocalBackupDigest(bytes, `sha256:${hex}`)).to.equal(
      true
    );
    expect(await verifyLocalBackupDigest(bytes, hex)).to.equal(true);
    expect(await verifyLocalBackupDigest(bytes, "sha256:0000")).to.equal(false);
  });
});
