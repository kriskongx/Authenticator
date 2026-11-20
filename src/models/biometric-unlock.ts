import { isChromium } from "../browser";

export type BiometricUnlockKey = {
  id: string;
  secret: string;
};

export type BiometricUnlockBundle = {
  version: 1;
  defaultKeyId: string;
  keys: BiometricUnlockKey[];
};

export type BiometricCredentialEnrollment = {
  credentialId: string;
  extensionId: string;
  prfSalt: string;
  kdfSalt: string;
  initialPrfOutput: string;
};

export type BiometricUnlockStatus = { ok: true } | { ok: false; error: string };
export type WebAuthnUnlockRecord = {
  version: 1;
  extensionId: string;
  credentialId: string;
  prfSalt: string;
  kdfSalt: string;
  iv: string;
  ciphertext: string;
};

type PendingSetup = {
  ticket: string;
  expiresAt: number;
  bundle: BiometricUnlockBundle;
};

type PrfInputs = AuthenticationExtensionsClientInputs & {
  prf: { eval: { first: Uint8Array } };
};

type PrfOutputs = AuthenticationExtensionsClientOutputs & {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer };
  };
};

const RECORD_STORAGE_KEY = "AuthenticatorBiometricUnlock";
const PENDING_SETUP_PREFIX = "AuthenticatorBiometricSetup:";
const AUTO_PROMPT_SKIP_KEY = "AuthenticatorBiometricAutoPromptSkippedUntil";
const AUTO_PROMPT_SKIP_MS = 2 * 60 * 1000;
const SETUP_LIFETIME_MS = 5 * 60 * 1000;
const PRF_CONTEXT = new TextEncoder().encode(
  "Authenticator local vault unlock key v1"
);

export function isBiometricUnlockBundle(
  value: unknown
): value is BiometricUnlockBundle {
  if (!isPlainObject(value) || value.version !== 1) {
    return false;
  }
  if (
    typeof value.defaultKeyId !== "string" ||
    !Array.isArray(value.keys) ||
    value.keys.length === 0 ||
    value.keys.length > 32
  ) {
    return false;
  }

  const ids = new Set<string>();
  for (const key of value.keys) {
    if (
      !isPlainObject(key) ||
      typeof key.id !== "string" ||
      key.id.length === 0 ||
      typeof key.secret !== "string" ||
      key.secret.length === 0 ||
      ids.has(key.id)
    ) {
      return false;
    }
    ids.add(key.id);
  }
  return ids.has(value.defaultKeyId);
}

export function createBiometricUnlockBundle(
  encryption: Map<string, EncryptionInterface>,
  defaultKeyId: string
): BiometricUnlockBundle {
  const keys: BiometricUnlockKey[] = [];
  for (const [id, value] of encryption) {
    const secret = value.getEncryptionPassword();
    if (!secret) {
      throw new Error("biometricUnlockKeysUnavailable");
    }
    keys.push({ id, secret });
  }
  const bundle = { version: 1 as const, defaultKeyId, keys };
  if (!isBiometricUnlockBundle(bundle)) {
    throw new Error("biometricUnlockKeysUnavailable");
  }
  return bundle;
}
export async function isBiometricUnlockEnabled(): Promise<boolean> {
  if (!isChromium || !hasWebAuthnSupport()) {
    return false;
  }
  const stored = await chrome.storage.local.get(RECORD_STORAGE_KEY);
  return isWebAuthnUnlockRecord(stored[RECORD_STORAGE_KEY]);
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isChromium || !hasWebAuthnSupport()) {
    return false;
  }
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

export async function readBiometricUnlockRecord(): Promise<WebAuthnUnlockRecord> {
  if (!isChromium || !hasWebAuthnSupport()) {
    throw new Error("biometricWebAuthnUnavailable");
  }
  const stored = await chrome.storage.local.get(RECORD_STORAGE_KEY);
  const record = stored[RECORD_STORAGE_KEY];
  if (!isWebAuthnUnlockRecord(record)) {
    throw new Error("biometricUnlockNotConfigured");
  }
  return record;
}

export async function removeBiometricUnlock(): Promise<void> {
  await chrome.storage.local.remove(RECORD_STORAGE_KEY);
  await chrome.storage.session.remove([
    "cachedBiometricKeys",
    "cachedBiometricDefaultKeyId",
  ]);
}
export async function invalidateBiometricUnlock(): Promise<void> {
  await removeBiometricUnlock();
  await chrome.storage.session.remove(["cachedPassphrase", "cachedKeyId"]);
  const session = await chrome.storage.session.get(null);
  const pendingKeys = Object.keys(session).filter((key) =>
    key.startsWith(PENDING_SETUP_PREFIX)
  );
  if (pendingKeys.length > 0) {
    await chrome.storage.session.remove(pendingKeys);
  }
}
export async function stageBiometricBundleForCreation(
  bundle: BiometricUnlockBundle
): Promise<string> {
  if (!isBiometricUnlockBundle(bundle)) {
    throw new Error("biometricUnlockInvalidBundle");
  }
  const ticket = crypto.randomUUID();
  const pending: PendingSetup = {
    ticket,
    expiresAt: Date.now() + SETUP_LIFETIME_MS,
    bundle,
  };
  await chrome.storage.session.set({
    [PENDING_SETUP_PREFIX + ticket]: pending,
  });
  return ticket;
}
export async function cancelBiometricBundleSetup(
  ticket: string
): Promise<void> {
  await chrome.storage.session.remove(PENDING_SETUP_PREFIX + ticket);
}

export async function hasStagedBiometricBundle(
  ticket: string
): Promise<boolean> {
  if (!ticket) {
    return false;
  }
  const storageKey = PENDING_SETUP_PREFIX + ticket;
  const stored = await chrome.storage.session.get(storageKey);
  return isPlainObject(stored[storageKey]);
}

/**
 * Remembers that the user dismissed the automatic device unlock prompt, so the
 * popup does not reopen the unlock window on every open. Expires on its own so
 * the prompt comes back for the next lock session.
 */
export async function skipAutoBiometricPrompt(): Promise<void> {
  await chrome.storage.session.set({
    [AUTO_PROMPT_SKIP_KEY]: Date.now() + AUTO_PROMPT_SKIP_MS,
  });
}

export async function isAutoBiometricPromptSkipped(): Promise<boolean> {
  const stored = await chrome.storage.session.get(AUTO_PROMPT_SKIP_KEY);
  const until = stored[AUTO_PROMPT_SKIP_KEY];
  return typeof until === "number" && until > Date.now();
}

export async function clearAutoBiometricPromptSkip(): Promise<void> {
  await chrome.storage.session.remove(AUTO_PROMPT_SKIP_KEY);
}

export async function finishBiometricCredentialEnrollment(
  ticket: string,
  enrollment: BiometricCredentialEnrollment
): Promise<void> {
  const storageKey = PENDING_SETUP_PREFIX + ticket;
  const stored = await chrome.storage.session.get(storageKey);
  await chrome.storage.session.remove(storageKey);
  const pending = stored[storageKey];
  if (
    !isPlainObject(pending) ||
    pending.ticket !== ticket ||
    typeof pending.expiresAt !== "number" ||
    pending.expiresAt < Date.now() ||
    !isBiometricUnlockBundle(pending.bundle)
  ) {
    throw new Error("biometricSetupExpired");
  }
  await finalizeBiometricCredentialEnrollment(enrollment, pending.bundle);
  await cacheBiometricUnlockBundle(pending.bundle);
}

export function beginBiometricCredentialEnrollment(): Promise<BiometricCredentialEnrollment> {
  if (!isChromium || !hasWebAuthnSupport()) {
    return Promise.reject(new Error("biometricWebAuthnUnavailable"));
  }

  const prfSalt = randomBytes(32);
  const publicKey = {
    challenge: randomBytes(32),
    rp: { name: "Authenticator" },
    user: {
      id: randomBytes(32),
      name: "authenticator-vault",
      displayName: "Authenticator vault unlock",
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "required",
      userVerification: "required",
    },
    extensions: { prf: { eval: { first: prfSalt } } } as PrfInputs,
    timeout: 60_000,
    attestation: "none",
  } as PublicKeyCredentialCreationOptions;

  // Invoke WebAuthn synchronously from the trusted click handler.
  return navigator.credentials.create({ publicKey }).then((credential) => {
    if (!(credential instanceof PublicKeyCredential)) {
      throw new Error("biometricCredentialCreationCancelled");
    }
    const outputs = credential.getClientExtensionResults() as PrfOutputs;
    const prfOutput = outputs.prf?.results?.first;
    if (
      outputs.prf?.enabled !== true ||
      !prfOutput ||
      prfOutput.byteLength !== 32
    ) {
      throw new Error("biometricPrfUnavailable");
    }
    return {
      credentialId: encodeBase64Url(credential.rawId),
      extensionId: chrome.runtime.id,
      prfSalt: encodeBase64Url(prfSalt),
      kdfSalt: encodeBase64Url(randomBytes(32)),
      initialPrfOutput: encodeBase64Url(prfOutput),
    };
  });
}

export async function finalizeBiometricCredentialEnrollment(
  enrollment: BiometricCredentialEnrollment,
  bundle: BiometricUnlockBundle
): Promise<void> {
  if (
    !isBiometricUnlockBundle(bundle) ||
    !isBiometricCredentialEnrollment(enrollment) ||
    enrollment.extensionId !== chrome.runtime.id
  ) {
    throw new Error("biometricUnlockInvalidBundle");
  }
  const record = await encryptBiometricBundle(
    bundle,
    decodeBase64Url(enrollment.initialPrfOutput),
    {
      version: 1,
      extensionId: enrollment.extensionId,
      credentialId: enrollment.credentialId,
      prfSalt: enrollment.prfSalt,
      kdfSalt: enrollment.kdfSalt,
    }
  );
  await chrome.storage.local.set({ [RECORD_STORAGE_KEY]: record });
}

export async function unlockWithBiometricRecord(
  record: WebAuthnUnlockRecord
): Promise<BiometricUnlockBundle> {
  if (!isChromium || !hasWebAuthnSupport() || !isWebAuthnUnlockRecord(record)) {
    throw new Error("biometricWebAuthnUnavailable");
  }
  const prfOutput = await evaluateCredentialPrf(
    record.credentialId,
    record.prfSalt
  );
  return decryptBiometricUnlockBundle(record, prfOutput);
}
export async function cacheBiometricUnlockBundle(
  bundle: BiometricUnlockBundle
): Promise<void> {
  if (!isBiometricUnlockBundle(bundle)) {
    throw new Error("biometricUnlockInvalidBundle");
  }
  const defaultKey = bundle.keys.find((key) => key.id === bundle.defaultKeyId);
  if (!defaultKey) {
    throw new Error("biometricUnlockInvalidBundle");
  }
  await chrome.storage.session.set({
    cachedPassphrase: defaultKey.secret,
    cachedKeyId: defaultKey.id,
    cachedBiometricKeys: bundle.keys,
    cachedBiometricDefaultKeyId: bundle.defaultKeyId,
  });
}

export async function encryptBiometricUnlockBundle(
  bundle: BiometricUnlockBundle,
  prfOutput: ArrayBuffer,
  metadata: Pick<
    WebAuthnUnlockRecord,
    "extensionId" | "credentialId" | "prfSalt" | "kdfSalt"
  >,
  iv: Uint8Array = randomBytes(12)
): Promise<WebAuthnUnlockRecord> {
  return encryptBiometricBundle(
    bundle,
    prfOutput,
    {
      version: 1,
      ...metadata,
    },
    iv
  );
}

export async function decryptBiometricUnlockBundle(
  record: WebAuthnUnlockRecord,
  prfOutput: ArrayBuffer
): Promise<BiometricUnlockBundle> {
  if (!isWebAuthnUnlockRecordShape(record)) {
    throw new Error("biometricUnlockInvalidRecord");
  }
  const key = await deriveWrappingKey(
    prfOutput,
    decodeBase64Url(record.kdfSalt)
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64Url(record.iv),
      additionalData: recordAdditionalData(record),
    },
    key,
    decodeBase64Url(record.ciphertext)
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (!isBiometricUnlockBundle(parsed)) {
    throw new Error("biometricUnlockInvalidBundle");
  }
  return parsed;
}

async function encryptBiometricBundle(
  bundle: BiometricUnlockBundle,
  prfOutput: ArrayBuffer,
  record: Pick<
    WebAuthnUnlockRecord,
    "version" | "extensionId" | "credentialId" | "prfSalt" | "kdfSalt"
  >,
  iv = randomBytes(12)
): Promise<WebAuthnUnlockRecord> {
  if (!isBiometricUnlockBundle(bundle)) {
    throw new Error("biometricUnlockInvalidBundle");
  }
  const key = await deriveWrappingKey(
    prfOutput,
    decodeBase64Url(record.kdfSalt)
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: recordAdditionalData(record),
    },
    key,
    new TextEncoder().encode(JSON.stringify(bundle))
  );
  return {
    ...record,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

async function evaluateCredentialPrf(
  credentialId: string,
  prfSalt: string
): Promise<ArrayBuffer> {
  if (!isChromium || !hasWebAuthnSupport()) {
    throw new Error("biometricWebAuthnUnavailable");
  }
  const challenge = randomBytes(32);
  const credentialPromise = navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [
        { type: "public-key", id: decodeBase64Url(credentialId) },
      ],
      userVerification: "required",
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: decodeBase64Url(prfSalt) } },
      } as PrfInputs,
    } as PublicKeyCredentialRequestOptions,
  });
  const credential = await credentialPromise;
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("biometricAuthenticationCancelled");
  }
  const outputs = credential.getClientExtensionResults() as PrfOutputs;
  const result = outputs.prf?.results?.first;
  if (!result || result.byteLength !== 32) {
    throw new Error("biometricPrfUnavailable");
  }
  return result;
}

async function deriveWrappingKey(
  prfOutput: ArrayBuffer,
  salt: Uint8Array
): Promise<CryptoKey> {
  const inputKey = await crypto.subtle.importKey(
    "raw",
    prfOutput,
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: PRF_CONTEXT },
    inputKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function recordAdditionalData(
  record: Pick<
    WebAuthnUnlockRecord,
    "version" | "extensionId" | "credentialId" | "prfSalt" | "kdfSalt"
  >
): Uint8Array {
  return new TextEncoder().encode(
    `${record.version}|${record.extensionId}|${record.credentialId}|${record.prfSalt}|${record.kdfSalt}`
  );
}

function hasWebAuthnSupport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function" &&
    typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable ===
      "function"
  );
}

function isWebAuthnUnlockRecord(value: unknown): value is WebAuthnUnlockRecord {
  return (
    isWebAuthnUnlockRecordShape(value) &&
    value.extensionId === chrome.runtime.id
  );
}

function isWebAuthnUnlockRecordShape(
  value: unknown
): value is WebAuthnUnlockRecord {
  if (!isPlainObject(value)) {
    return false;
  }
  if (
    value.version !== 1 ||
    typeof value.extensionId !== "string" ||
    !isBase64Url(value.credentialId) ||
    !isBase64Url(value.prfSalt) ||
    !isBase64Url(value.kdfSalt) ||
    !isBase64Url(value.iv) ||
    !isBase64Url(value.ciphertext)
  ) {
    return false;
  }
  try {
    return (
      decodeBase64Url(value.credentialId).byteLength > 0 &&
      decodeBase64Url(value.prfSalt).byteLength === 32 &&
      decodeBase64Url(value.kdfSalt).byteLength === 32 &&
      decodeBase64Url(value.iv).byteLength === 12 &&
      decodeBase64Url(value.ciphertext).byteLength >= 16
    );
  } catch {
    return false;
  }
}
function isBiometricCredentialEnrollment(
  value: unknown
): value is BiometricCredentialEnrollment {
  if (
    !isPlainObject(value) ||
    typeof value.extensionId !== "string" ||
    !isBase64Url(value.credentialId) ||
    !isBase64Url(value.prfSalt) ||
    !isBase64Url(value.kdfSalt) ||
    !isBase64Url(value.initialPrfOutput)
  ) {
    return false;
  }
  try {
    return (
      decodeBase64Url(value.credentialId).byteLength > 0 &&
      decodeBase64Url(value.prfSalt).byteLength === 32 &&
      decodeBase64Url(value.kdfSalt).byteLength === 32 &&
      decodeBase64Url(value.initialPrfOutput).byteLength === 32
    );
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBase64Url(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!isBase64Url(value)) {
    throw new Error("biometricUnlockInvalidRecord");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
