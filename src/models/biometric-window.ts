export type BiometricWindowHandlers = {
  onClosed?: () => void;
  onError?: (message: string) => void;
};

const WINDOW_WIDTH = 460;
const WINDOW_HEIGHT = 420;

// Anchor the window to the toolbar area of the browser window so it shows up
// just under and to the left of the extension icon.
const ANCHOR_MARGIN = 16;
const TOOLBAR_OFFSET = 88;

type Placement = { left?: number; top?: number };

/**
 * Opens view/biometric.html in a small popup window instead of a full tab.
 * The window is placed at the top right of the current browser window and must
 * stay focused, otherwise the platform authenticator prompt is suppressed.
 */
export function openBiometricWindow(
  url: string,
  handlers: BiometricWindowHandlers = {}
): void {
  void getAnchorWindow().then((anchor) => {
    createWindow(url, placementFor(anchor), handlers);
  });
}

function getAnchorWindow(): Promise<chrome.windows.Window | null> {
  return new Promise((resolve) => {
    chrome.windows.getLastFocused({}, (anchor) => {
      if (chrome.runtime.lastError || !anchor) {
        resolve(null);
        return;
      }
      // Only normal browser windows expose the toolbar we anchor against.
      if ((anchor.type as string) !== "normal") {
        resolve(null);
        return;
      }
      resolve(anchor);
    });
  });
}

function placementFor(anchor: chrome.windows.Window | null): Placement {
  if (
    !anchor ||
    anchor.left === undefined ||
    anchor.top === undefined ||
    anchor.width === undefined
  ) {
    return {};
  }

  const preferredLeft =
    anchor.left + anchor.width - WINDOW_WIDTH - ANCHOR_MARGIN;
  const left = Math.max(anchor.left + ANCHOR_MARGIN, preferredLeft);
  const anchorHeight = anchor.height ?? WINDOW_HEIGHT;
  const maxTop = anchor.top + anchorHeight - WINDOW_HEIGHT - ANCHOR_MARGIN;
  const top = Math.min(
    anchor.top + TOOLBAR_OFFSET,
    Math.max(anchor.top + ANCHOR_MARGIN, maxTop)
  );

  return { left, top };
}

function createWindow(
  url: string,
  placement: Placement,
  handlers: BiometricWindowHandlers
): void {
  chrome.windows.create(
    {
      url,
      type: "popup",
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      focused: true,
      ...placement,
    },
    (created) => {
      if (chrome.runtime.lastError || created?.id === undefined) {
        const message = chrome.runtime.lastError?.message;
        handlers.onError?.(message || "biometricWindowOpenFailed");
        return;
      }
      const windowId = created.id;
      const onRemoved = (removedId: number) => {
        if (removedId !== windowId) {
          return;
        }
        chrome.windows.onRemoved.removeListener(onRemoved);
        handlers.onClosed?.();
      };
      chrome.windows.onRemoved.addListener(onRemoved);
    }
  );
}
