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

export const BIOMETRIC_UNLOCK_STORAGE_KEY = "AuthenticatorBiometricUnlock";
export const POPUP_ANCHOR_STORAGE_KEY = "AuthenticatorPopupAnchor";
const RECORD_STORAGE_KEY = BIOMETRIC_UNLOCK_STORAGE_KEY;

export type PopupAnchorOffset = {
  offsetFromRight: number;
  offsetFromTop: number;
};

export function isPopupAnchorOffset(
  value: unknown
): value is PopupAnchorOffset {
  return (
    isPlainObject(value) &&
    typeof value.offsetFromRight === "number" &&
    Number.isFinite(value.offsetFromRight) &&
    value.offsetFromRight >= 0 &&
    typeof value.offsetFromTop === "number" &&
    Number.isFinite(value.offsetFromTop) &&
    value.offsetFromTop >= 0
  );
}
const PENDING_SETUP_PREFIX = "AuthenticatorBiometricSetup:";
const AUTO_PROMPT_SKIP_KEY = "AuthenticatorBiometricAutoPromptSkippedUntil";
const BIOMETRIC_REAUTH_UNTIL_KEY = "biometricReauthVerifiedUntil";
const BIOMETRIC_REAUTH_KEY_ID_KEY = "biometricReauthKeyId";
const BIOMETRIC_REAUTH_TTL_MS = 15 * 1000;
const REOPEN_VIEW_KEY = "biometricReopenView";
const REOPEN_VIEW_UNTIL_KEY = "biometricReopenViewUntil";
const REOPEN_NOTIFICATION_KEY = "biometricReopenNotification";
const REOPEN_NOTIFICATION_UNTIL_KEY = "biometricReopenNotificationUntil";
const REOPEN_VIEW_TTL_MS = 15 * 1000;
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

/**
 * Service-worker-safe check for whether a valid biometric unlock record is
 * stored for this extension (does not require `window` / DOM WebAuthn APIs).
 */
export async function hasBiometricUnlockRecord(): Promise<boolean> {
  if (!isChromium) {
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

let popupBlurSuppressionCount = 0;
let popupBlurSuppressedUntil = 0;

export function isDetachedPopupWindow(): boolean {
  if (typeof window === "undefined" || !window.location) {
    return false;
  }
  return new URLSearchParams(window.location.search).get("popup") === "true";
}

export function isAutoClosePopupWindow(): boolean {
  if (typeof window === "undefined" || !window.location) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("popup") === "true" && params.get("autoClose") === "1";
}

export function beginPopupBlurSuppression(): void {
  popupBlurSuppressionCount++;
}

export function endPopupBlurSuppression(graceMs = 700): void {
  popupBlurSuppressionCount = Math.max(0, popupBlurSuppressionCount - 1);
  if (graceMs > 0) {
    popupBlurSuppressedUntil = Math.max(
      popupBlurSuppressedUntil,
      Date.now() + graceMs
    );
  }
}

export function clearPopupBlurGrace(): void {
  if (popupBlurSuppressionCount === 0) {
    popupBlurSuppressedUntil = 0;
  }
}

export function isPopupBlurSuppressed(): boolean {
  return popupBlurSuppressionCount > 0 || Date.now() < popupBlurSuppressedUntil;
}

export async function unlockBiometricBackupKeys(): Promise<
  Map<string, string>
> {
  const record = await readBiometricUnlockRecord();
  const bundle = await unlockWithBiometricRecord(record);
  return new Map(bundle.keys.map((item) => [item.id, item.secret]));
}

export async function markBiometricReauthVerified(
  keyId: string
): Promise<void> {
  if (!keyId) {
    return;
  }
  await chrome.storage.session.set({
    [BIOMETRIC_REAUTH_UNTIL_KEY]: Date.now() + BIOMETRIC_REAUTH_TTL_MS,
    [BIOMETRIC_REAUTH_KEY_ID_KEY]: keyId,
  });
}

/**
 * One-shot handoff used only when macOS Chrome dismisses the toolbar popup
 * right after a genuine Touch ID check on SetPasswordPage and the background
 * worker immediately reopens it. Never set during normal vault unlock.
 */
export async function consumeBiometricReauthVerified(
  keyId: string | undefined
): Promise<boolean> {
  const stored = await chrome.storage.session.get([
    BIOMETRIC_REAUTH_UNTIL_KEY,
    BIOMETRIC_REAUTH_KEY_ID_KEY,
  ]);
  const until = stored[BIOMETRIC_REAUTH_UNTIL_KEY];
  const storedKeyId = stored[BIOMETRIC_REAUTH_KEY_ID_KEY];
  if (until !== undefined || storedKeyId !== undefined) {
    await chrome.storage.session.remove([
      BIOMETRIC_REAUTH_UNTIL_KEY,
      BIOMETRIC_REAUTH_KEY_ID_KEY,
    ]);
  }
  return (
    Boolean(keyId) &&
    storedKeyId === keyId &&
    typeof until === "number" &&
    until > Date.now()
  );
}

export async function clearBiometricReauth(): Promise<void> {
  await chrome.storage.session.remove([
    BIOMETRIC_REAUTH_UNTIL_KEY,
    BIOMETRIC_REAUTH_KEY_ID_KEY,
    REOPEN_VIEW_KEY,
    REOPEN_VIEW_UNTIL_KEY,
    REOPEN_NOTIFICATION_KEY,
    REOPEN_NOTIFICATION_UNTIL_KEY,
  ]);
}

export async function setPendingPopupReopenView(view: string): Promise<void> {
  if (!view) {
    return;
  }
  await chrome.storage.session.set({
    [REOPEN_VIEW_KEY]: view,
    [REOPEN_VIEW_UNTIL_KEY]: Date.now() + REOPEN_VIEW_TTL_MS,
  });
}

export async function consumePendingPopupReopenView(): Promise<string | null> {
  const stored = await chrome.storage.session.get([
    REOPEN_VIEW_KEY,
    REOPEN_VIEW_UNTIL_KEY,
  ]);
  const view = stored[REOPEN_VIEW_KEY];
  const until = stored[REOPEN_VIEW_UNTIL_KEY];
  if (view !== undefined || until !== undefined) {
    await chrome.storage.session.remove([
      REOPEN_VIEW_KEY,
      REOPEN_VIEW_UNTIL_KEY,
    ]);
  }
  if (
    typeof view === "string" &&
    typeof until === "number" &&
    until > Date.now()
  ) {
    return view;
  }
  return null;
}

export async function setPendingPopupNotification(
  messageKey: string
): Promise<void> {
  if (!messageKey) {
    return;
  }
  await chrome.storage.session.set({
    [REOPEN_NOTIFICATION_KEY]: messageKey,
    [REOPEN_NOTIFICATION_UNTIL_KEY]: Date.now() + REOPEN_VIEW_TTL_MS,
  });
}

export async function consumePendingPopupNotification(): Promise<
  string | null
> {
  const stored = await chrome.storage.session.get([
    REOPEN_NOTIFICATION_KEY,
    REOPEN_NOTIFICATION_UNTIL_KEY,
  ]);
  const messageKey = stored[REOPEN_NOTIFICATION_KEY];
  const until = stored[REOPEN_NOTIFICATION_UNTIL_KEY];
  if (messageKey !== undefined || until !== undefined) {
    await chrome.storage.session.remove([
      REOPEN_NOTIFICATION_KEY,
      REOPEN_NOTIFICATION_UNTIL_KEY,
    ]);
  }
  if (
    typeof messageKey === "string" &&
    typeof until === "number" &&
    until > Date.now()
  ) {
    return messageKey;
  }
  return null;
}

export async function removeBiometricUnlock(): Promise<void> {
  await chrome.storage.local.remove(RECORD_STORAGE_KEY);
  await chrome.storage.session.remove([
    "cachedBiometricKeys",
    "cachedBiometricDefaultKeyId",
    BIOMETRIC_REAUTH_UNTIL_KEY,
    BIOMETRIC_REAUTH_KEY_ID_KEY,
    REOPEN_VIEW_KEY,
    REOPEN_VIEW_UNTIL_KEY,
    REOPEN_NOTIFICATION_KEY,
    REOPEN_NOTIFICATION_UNTIL_KEY,
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
  const now = Date.now();
  const session = await chrome.storage.session.get(null);
  const expiredKeys = Object.keys(session).filter((key) => {
    if (!key.startsWith(PENDING_SETUP_PREFIX)) {
      return false;
    }
    const item = session[key];
    return (
      !isPlainObject(item) ||
      typeof item.expiresAt !== "number" ||
      item.expiresAt < now
    );
  });
  if (expiredKeys.length > 0) {
    await chrome.storage.session.remove(expiredKeys);
  }
  const ticket = crypto.randomUUID();
  const pending: PendingSetup = {
    ticket,
    expiresAt: now + SETUP_LIFETIME_MS,
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
  const pending = stored[storageKey];
  const valid =
    isPlainObject(pending) &&
    pending.ticket === ticket &&
    typeof pending.expiresAt === "number" &&
    pending.expiresAt >= Date.now() &&
    isBiometricUnlockBundle(pending.bundle);
  if (!valid && pending !== undefined) {
    await chrome.storage.session.remove(storageKey);
  }
  return valid;
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
  const pending = stored[storageKey];
  if (
    !isPlainObject(pending) ||
    pending.ticket !== ticket ||
    typeof pending.expiresAt !== "number" ||
    pending.expiresAt < Date.now() ||
    !isBiometricUnlockBundle(pending.bundle)
  ) {
    if (pending !== undefined) {
      await chrome.storage.session.remove(storageKey);
    }
    throw new Error("biometricSetupExpired");
  }
  await finalizeBiometricCredentialEnrollment(enrollment, pending.bundle);
  await cacheBiometricUnlockBundle(pending.bundle);
  await chrome.storage.session.remove(storageKey);
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
  beginPopupBlurSuppression();
  let credential: Credential | null;
  try {
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
    credential = await credentialPromise;
  } finally {
    endPopupBlurSuppression(700);
    if (isAutoClosePopupWindow() && chrome.windows?.update) {
      chrome.windows.update(
        chrome.windows.WINDOW_ID_CURRENT,
        { focused: true },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  }
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
