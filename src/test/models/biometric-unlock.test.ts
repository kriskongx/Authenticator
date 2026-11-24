import "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import {
  BIOMETRIC_UNLOCK_STORAGE_KEY,
  cacheBiometricUnlockBundle,
  clearBiometricReauth,
  consumeBiometricReauthVerified,
  consumePendingPopupNotification,
  consumePendingPopupReopenView,
  decryptBiometricUnlockBundle,
  encryptBiometricUnlockBundle,
  hasBiometricUnlockRecord,
  isBiometricUnlockBundle,
  markBiometricReauthVerified,
  setPendingPopupNotification,
  setPendingPopupReopenView,
  WebAuthnUnlockRecord,
} from "../../models/biometric-unlock";
mocha.setup("bdd");

describe("biometric unlock key wrapping", () => {
  const bundle = {
    version: 1 as const,
    defaultKeyId: "default-key",
    keys: [
      { id: "default-key", secret: "master-derived-key" },
      { id: "legacy-key", secret: "legacy-derived-key" },
    ],
  };
  const metadata = {
    extensionId: "test-extension-id",
    credentialId: "Y3JlZGVudGlhbA",
    prfSalt: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    kdfSalt: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
  };

  it("round-trips every encryption key with the same PRF output", async () => {
    const prfOutput = new Uint8Array(32).fill(7).buffer;
    const record = await encryptBiometricUnlockBundle(
      bundle,
      prfOutput,
      metadata,
      new Uint8Array(12).fill(3)
    );

    expect(record.ciphertext).to.not.contain("master-derived-key");
    expect(await decryptBiometricUnlockBundle(record, prfOutput)).to.deep.equal(
      bundle
    );
  });

  it("rejects ciphertext tampering and incorrect PRF output", async () => {
    const record = await encryptBiometricUnlockBundle(
      bundle,
      new Uint8Array(32).fill(7).buffer,
      metadata,
      new Uint8Array(12).fill(3)
    );
    const ciphertext = record.ciphertext.split("");
    ciphertext[0] = ciphertext[0] === "A" ? "B" : "A";
    const tampered: WebAuthnUnlockRecord = {
      ...record,
      ciphertext: ciphertext.join(""),
    };

    let tamperingRejected = false;
    try {
      await decryptBiometricUnlockBundle(
        tampered,
        new Uint8Array(32).fill(7).buffer
      );
    } catch {
      tamperingRejected = true;
    }
    expect(tamperingRejected).to.equal(true);

    let wrongPrfRejected = false;
    try {
      await decryptBiometricUnlockBundle(
        record,
        new Uint8Array(32).fill(8).buffer
      );
    } catch {
      wrongPrfRejected = true;
    }
    expect(wrongPrfRejected).to.equal(true);
  });
  it("caches biometric keys directly in session storage", async () => {
    const setStub = sinon.stub(chrome.storage.session, "set").resolves();
    const sendMessageStub = sinon.stub(chrome.runtime, "sendMessage");

    await cacheBiometricUnlockBundle(bundle);

    expect(setStub.calledOnce).to.equal(true);
    expect(setStub.firstCall.args[0]).to.deep.equal({
      cachedPassphrase: "master-derived-key",
      cachedKeyId: "default-key",
      cachedBiometricKeys: bundle.keys,
      cachedBiometricDefaultKeyId: "default-key",
    });
    expect(sendMessageStub.called).to.equal(false);
    setStub.restore();
    sendMessageStub.restore();
  });

  it("tracks one-shot reauth, reopen view, and notification handoffs", async () => {
    await clearBiometricReauth();
    expect(await consumeBiometricReauthVerified("k1")).to.equal(false);

    await markBiometricReauthVerified("k1");
    expect(await consumeBiometricReauthVerified("k2")).to.equal(false);
    // A mismatch still consumes the one-shot grant so it cannot linger.
    expect(await consumeBiometricReauthVerified("k1")).to.equal(false);

    await markBiometricReauthVerified("k1");
    expect(await consumeBiometricReauthVerified("k1")).to.equal(true);
    expect(await consumeBiometricReauthVerified("k1")).to.equal(false);

    await setPendingPopupReopenView("SetPasswordPage");
    expect(await consumePendingPopupReopenView()).to.equal("SetPasswordPage");
    expect(await consumePendingPopupReopenView()).to.equal(null);

    await setPendingPopupNotification("webdav_restore_success");
    expect(await consumePendingPopupNotification()).to.equal(
      "webdav_restore_success"
    );
    expect(await consumePendingPopupNotification()).to.equal(null);
  });

  it("detects stored biometric records without requiring DOM WebAuthn globals", async () => {
    const validRecord = await encryptBiometricUnlockBundle(
      bundle,
      new Uint8Array(32).fill(7).buffer,
      { ...metadata, extensionId: chrome.runtime.id },
      new Uint8Array(12).fill(3)
    );
    const getStub = sinon.stub(chrome.storage.local, "get");
    try {
      getStub.resolves({});
      expect(await hasBiometricUnlockRecord()).to.equal(false);

      getStub.resolves({ [BIOMETRIC_UNLOCK_STORAGE_KEY]: validRecord });
      expect(await hasBiometricUnlockRecord()).to.equal(true);
    } finally {
      getStub.restore();
    }
  });

  it("rejects duplicate, missing, or mismatched encryption keys", () => {
    expect(isBiometricUnlockBundle(bundle)).to.equal(true);
    expect(
      isBiometricUnlockBundle({
        ...bundle,
        keys: [...bundle.keys, { ...bundle.keys[0] }],
      })
    ).to.equal(false);
    expect(
      isBiometricUnlockBundle({ ...bundle, defaultKeyId: "missing" })
    ).to.equal(false);
  });
});
