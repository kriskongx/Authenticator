import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { importBackupContent, isVaultLocked } from "../../models/import-api";
import { EntryStorage } from "../../models/storage";

mocha.setup("bdd");

describe("import-api vault lock checks", () => {
  afterEach(async () => {
    await chrome.storage.session.remove([
      "cachedPassphrase",
      "cachedKeyId",
      "cachedBiometricKeys",
    ]);
  });

  it("reports unlocked when no encryption key is configured", async () => {
    sinon.stub(EntryStorage, "hasEncryptionKey").resolves(false);

    expect(await isVaultLocked()).to.equal(false);
  });

  it("reports locked when an encryption key exists even if the vault is empty", async () => {
    sinon.stub(EntryStorage, "hasEncryptionKey").resolves(true);

    expect(await isVaultLocked()).to.equal(true);
  });

  it("rejects import when encrypted vault is locked", async () => {
    sinon.stub(EntryStorage, "hasEncryptionKey").resolves(true);

    let caught: Error | null = null;
    try {
      await importBackupContent({
        content:
          "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example",
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).to.equal("vaultLocked");
  });
});
