import { BrowserStorage, isOldKey } from "./storage";

const ARGON_TIMEOUT_MS = 20000;
const ARGON_READY_TIMEOUT_MS = 5000;
let argonRequestCounter = 0;
const readyArgonWindows = new WeakSet<Window>();

type ArgonRequest =
  | { action: "hash"; value: string; salt: string }
  | { action: "verify"; value: string; hash: string };

function ensureArgonSandboxReady(
  iframe: HTMLIFrameElement,
  targetWindow: Window
): Promise<void> {
  if (readyArgonWindows.has(targetWindow)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const pingId = `argon-ping-${Date.now()}-${++argonRequestCounter}`;
    let settled = false;

    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      iframe.removeEventListener("load", sendPing);
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      readyArgonWindows.add(targetWindow);
      cleanup();
      resolve();
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== targetWindow || !event.data) {
        return;
      }
      if (
        event.data.type === "argon-ready" ||
        (event.data.requestId === pingId && event.data.response === "pong")
      ) {
        finish();
      }
    };

    const sendPing = () => {
      try {
        targetWindow.postMessage({ action: "ping", requestId: pingId }, "*");
      } catch {
        // Ignore until the sandbox window is reachable.
      }
    };

    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error("argon2 sandbox timed out"));
    }, ARGON_READY_TIMEOUT_MS);

    const intervalId = window.setInterval(sendPing, 100);
    window.addEventListener("message", handleMessage);
    iframe.addEventListener("load", sendPing);
    sendPing();
  });
}

async function requestArgon<T>(request: ArgonRequest): Promise<T> {
  if (typeof document === "undefined") {
    throw new Error("argonSandboxUnavailable");
  }
  const iframe = document.getElementById(
    "argon-sandbox"
  ) as HTMLIFrameElement | null;
  const targetWindow = iframe?.contentWindow;

  if (!iframe || !targetWindow) {
    throw new Error("argon-sandbox missing!");
  }

  await ensureArgonSandboxReady(iframe, targetWindow);

  const requestId = `argon-${Date.now()}-${++argonRequestCounter}`;

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      window.clearTimeout(timeoutId);
    };
    const handleMessage = (event: MessageEvent) => {
      if (
        event.source !== targetWindow ||
        !event.data ||
        event.data.requestId !== requestId ||
        (!("response" in event.data) && !("error" in event.data))
      ) {
        return;
      }

      cleanup();
      if (event.data.error) {
        reject(new Error(String(event.data.error)));
        return;
      }
      resolve(event.data.response as T);
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("argon2 request timed out"));
    }, ARGON_TIMEOUT_MS);

    window.addEventListener("message", handleMessage);
    try {
      targetWindow.postMessage({ ...request, requestId }, "*");
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export async function argonHash(
  value: string,
  salt: string
): Promise<string | undefined> {
  return requestArgon<string | undefined>({
    action: "hash",
    value,
    salt,
  });
}

export async function argonVerify(
  value: string,
  hash: string
): Promise<boolean> {
  return requestArgon<boolean>({
    action: "verify",
    value,
    hash,
  });
}

// Verify a password using keys in BrowserStorage
export async function verifyPasswordUsingKeyID(
  keyId: string,
  password: string
): Promise<boolean> {
  // Get key for current encryption
  const keys = await BrowserStorage.getKeys();
  if (isOldKey(keys)) {
    throw new Error(
      "v3 encryption not being used with verifyPassword. This should never happen!"
    );
  }

  const key = keys.find((key) => key.id === keyId);
  if (!key) {
    throw new Error(`Key ${keyId} not in BrowserStorage`);
  }

  return verifyPasswordUsingKey(key, password);
}

export async function verifyDerivedKeyUsingKeyID(
  keyId: string,
  derivedSecret: string
): Promise<boolean> {
  if (!derivedSecret) {
    return false;
  }
  const keys = await BrowserStorage.getKeys();
  if (isOldKey(keys)) {
    return false;
  }
  const key = keys.find((item) => item.id === keyId);
  if (!key) {
    return false;
  }
  return argonVerify(derivedSecret, key.hash);
}

export async function verifyPasswordUsingKey(
  key: Key,
  password: string
): Promise<boolean> {
  // Hash password with argon
  const rawHash = await argonHash(password, key.salt);
  if (!rawHash) {
    throw new Error("argon2 did not return a hash!");
  }
  // https://passlib.readthedocs.io/en/stable/lib/passlib.hash.argon2.html#format-algorithm
  const possibleHash = rawHash.split("$")[5];
  if (!possibleHash) {
    throw new Error("argon2 did not return a hash!");
  }

  // verify user password by comparing their password hash with the
  // hash of their password's hash
  return await argonVerify(possibleHash, key.hash);
}
