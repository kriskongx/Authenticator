import { describeError } from "./errors";
import {
  beginBiometricCredentialEnrollment,
  BiometricCredentialEnrollment,
  cacheBiometricUnlockBundle,
  cancelBiometricBundleSetup,
  clearAutoBiometricPromptSkip,
  hasStagedBiometricBundle,
  readBiometricUnlockRecord,
  skipAutoBiometricPrompt,
  unlockWithBiometricRecord,
  WebAuthnUnlockRecord,
} from "./models/biometric-unlock";

const continueButton = document.getElementById(
  "continue"
) as HTMLButtonElement | null;
const description = document.getElementById("description");
const status = document.getElementById("status");
const params = new URLSearchParams(location.search);
const ticket = params.get("ticket") || "";
const unlockMode = params.get("mode") === "unlock";
// The unlock page is only opened as the fallback window (see
// EnterPasswordPage.openUnlockWindow), which passes auto=1 so the assertion
// starts without an extra click.
const autoMode = params.get("auto") === "1";

const text = (key: string, fallback: string) =>
  chrome.i18n.getMessage(key) || fallback;

type RuntimeResponse = { ok: boolean; error?: string };

const RUNTIME_UNAVAILABLE = "biometricRuntimeUnavailable";
const AUTO_CANCEL_THRESHOLD_MS = 600;

// Failures here are expected (the user cancelled, the prompt was refused), so
// everything is logged at info level: console.warn/error entries show up on
// chrome://extensions as extension errors even when nothing is broken.
const log = (message: string, detail?: unknown) => {
  console.info("[biometric]", message, detail === undefined ? "" : detail);
};

function setStatus(message: string) {
  if (status) {
    status.textContent = message;
  }
}

function closeWindowAfterSuccess() {
  window.setTimeout(() => window.close(), 1500);
}

function sendRuntimeMessage(message: unknown): Promise<RuntimeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      message,
      (response: RuntimeResponse | undefined) => {
        if (chrome.runtime.lastError) {
          reject(
            new Error(
              `${RUNTIME_UNAVAILABLE}: ${chrome.runtime.lastError.message}`
            )
          );
          return;
        }
        if (!response || response.ok !== true) {
          reject(new Error(response?.error || "biometricSetupRejected"));
          return;
        }
        resolve(response);
      }
    );
  });
}

let unlockRecord: WebAuthnUnlockRecord | null = null;
if (unlockMode && continueButton) {
  continueButton.disabled = true;
  void readBiometricUnlockRecord()
    .then((record) => {
      unlockRecord = record;
      continueButton.disabled = false;
      if (autoMode) {
        void unlock(true);
      }
    })
    .catch(() => {
      if (status) {
        status.textContent = text(
          "biometric_unlock_failed",
          "Device unlock failed. Enter your master password instead."
        );
      }
      continueButton.disabled = false;
    });
}
document.title = unlockMode
  ? text("biometric_settings_title", "Device unlock")
  : text("biometric_setup_title", "Set up device unlock");
const title = document.getElementById("title");
if (title) title.textContent = document.title;
if (description) {
  description.textContent = text(
    unlockMode ? "biometric_unlock_desc" : "biometric_setup_desc",
    unlockMode
      ? "Confirm with your device to unlock this local vault."
      : "Confirm with your device to enable local vault unlock."
  );
}
if (continueButton) {
  continueButton.textContent = text(
    unlockMode ? "biometric_unlock_button" : "biometric_continue",
    unlockMode ? "Unlock with device" : "Continue"
  );
  continueButton.disabled = unlockMode ? false : !ticket;
  continueButton.addEventListener("click", () => {
    if (unlockMode) {
      void unlock();
    } else {
      void enroll();
    }
  });
}

async function enroll() {
  if (!continueButton || continueButton.disabled) return;
  continueButton.disabled = true;
  setStatus(text("biometric_setup_wait", "Waiting for device confirmation…"));
  log("setup started", { ticket, extensionId: chrome.runtime.id });

  try {
    // Start WebAuthn immediately inside the trusted click handler.
    const enrollmentPromise = beginBiometricCredentialEnrollment();
    const enrollment = await enrollmentPromise;
    log("credential created", {
      credentialIdLength: enrollment.credentialId.length,
      extensionId: enrollment.extensionId,
    });

    const staged = await hasStagedBiometricBundle(ticket);
    log("pending setup still staged", staged);
    if (!staged) {
      throw new Error("biometricSetupTicketMissing");
    }

    await submitEnrollment(enrollment);
    setStatus(text("biometric_setup_complete", "Device unlock is ready."));
    continueButton.textContent = text("biometric_setup_done", "Done");
    closeWindowAfterSuccess();
  } catch (error) {
    log("setup failed", describeError(error));
    await cancelBiometricBundleSetup(ticket);
    setStatus(
      `${text(
        "biometric_setup_failed",
        "Device unlock could not be set up. Your master password still works."
      )} (${describeError(error)})`
    );
    continueButton.disabled = false;
  }
}

async function submitEnrollment(enrollment: BiometricCredentialEnrollment) {
  const message = { action: "finishBiometricEnrollment", ticket, enrollment };
  try {
    return await sendRuntimeMessage(message);
  } catch (error) {
    const reason = describeError(error);
    log("finishBiometricEnrollment failed", reason);
    if (!reason.startsWith(RUNTIME_UNAVAILABLE)) {
      throw error;
    }
    // The service worker may be asleep or just restarted after a rebuild.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });
    return await sendRuntimeMessage(message);
  }
}

async function unlock(auto = false) {
  if (!continueButton) return;
  continueButton.disabled = true;
  setStatus(text("biometric_setup_wait", "Waiting for device confirmation…"));
  const startedAt = Date.now();

  try {
    if (!unlockRecord) throw new Error("biometricUnlockNotConfigured");
    const unlockPromise = unlockWithBiometricRecord(unlockRecord);
    const bundle = await unlockPromise;
    await cacheBiometricUnlockBundle(bundle);
    await clearAutoBiometricPromptSkip();
    await sendRuntimeMessage({ action: "resetAutolock" });
    setStatus(text("biometric_unlock_complete", "Vault unlocked."));
    continueButton.textContent = text("biometric_setup_done", "Done");
    closeWindowAfterSuccess();
  } catch (error) {
    log("unlock failed", describeError(error));
    const notAllowed =
      error instanceof Error && error.name === "NotAllowedError";
    // A rejection that arrives quickly is the browser refusing to prompt
    // without a user gesture; a slow one is the user cancelling the prompt.
    const userCancelled =
      notAllowed && Date.now() - startedAt > AUTO_CANCEL_THRESHOLD_MS;

    if (auto && userCancelled) {
      await skipAutoBiometricPrompt();
      setStatus(
        text(
          "biometric_unlock_cancelled",
          "Device unlock cancelled. Use your master password."
        )
      );
      window.setTimeout(() => window.close(), 700);
      return;
    }

    if (auto && notAllowed) {
      setStatus(
        text(
          "biometric_unlock_needs_tap",
          "Tap the button below to confirm with your device."
        )
      );
      continueButton.textContent = text(
        "biometric_unlock_button",
        "Unlock with device"
      );
      continueButton.disabled = false;
      return;
    }

    setStatus(
      text(
        "biometric_unlock_failed",
        "Device unlock failed. Enter your master password instead."
      )
    );
    continueButton.disabled = false;
  }
}
