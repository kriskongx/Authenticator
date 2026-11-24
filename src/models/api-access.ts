const API_TOKEN_KEY = "AuthenticatorApiToken";
const API_ENABLED_KEY = "AuthenticatorApiEnabled";

const TOKEN_BYTES = 32;

function randomToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compares two tokens without leaking their common prefix through timing.
 */
function tokensMatch(expected: string, candidate: string): boolean {
  if (expected.length !== candidate.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  }
  return diff === 0;
}

export async function isApiAccessEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(API_ENABLED_KEY);
  return stored[API_ENABLED_KEY] === true;
}

export async function setApiAccessEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [API_ENABLED_KEY]: enabled });
}

export async function getApiToken(): Promise<string> {
  const stored = await chrome.storage.local.get(API_TOKEN_KEY);
  const token = stored[API_TOKEN_KEY];
  return typeof token === "string" ? token : "";
}

export async function createApiToken(): Promise<string> {
  const token = randomToken();
  await chrome.storage.local.set({ [API_TOKEN_KEY]: token });
  return token;
}

export async function verifyApiToken(candidate: unknown): Promise<boolean> {
  if (typeof candidate !== "string" || !candidate) {
    return false;
  }
  const token = await getApiToken();
  if (!token) {
    return false;
  }
  return tokensMatch(token, candidate);
}
