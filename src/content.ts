// @ts-expect-error - no typings
import QRCode from "qrcode-reader";
import jsQR from "jsqr";

// @ts-expect-error - injected by vue-svg-loader
import scanGIF from "../images/scan.gif";

// First line of defence: per-frame guard so a second injection into the same
// frame cannot register duplicate listeners. Cross-frame injection is decided
// earlier by okToInjectContentScript() in utils.ts.
// First line of defence: per-frame guard so a second injection into the same
// frame cannot register duplicate listeners. Cross-frame injection is decided
// earlier by okToInjectContentScript() in utils.ts.
const contentGlobal = globalThis as typeof globalThis & {
  __authenticatorContentLoaded?: boolean;
};

let isDraggingCapture = false;
let captureStartX = 0;
let captureStartY = 0;

if (!contentGlobal.__authenticatorContentLoaded) {
  contentGlobal.__authenticatorContentLoaded = true;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case "capture":
        sendResponse("beginCapture");
        showGrayLayout();
        break;
      case "sendCaptureUrl":
        qrDecode(
          message.info.url,
          message.info.captureBoxLeft,
          message.info.captureBoxTop,
          message.info.captureBoxWidth,
          message.info.captureBoxHeight
        );
        break;
      case "errorsecret":
        alert(chrome.i18n.getMessage("errorsecret") + message.secret);
        break;
      case "errorenc":
        alert(chrome.i18n.getMessage("phrase_incorrect"));
        break;
      case "added":
        alert(message.account + chrome.i18n.getMessage("added"));
        break;
      case "text":
        alert(message.text);
        break;
      case "migrationfail":
        alert(chrome.i18n.getMessage("migration_fail"));
        break;
      case "migrationpartlyfail":
        alert(chrome.i18n.getMessage("migration_partly_fail"));
        break;
      case "migrationsuccess":
        alert(chrome.i18n.getMessage("updateSuccess"));
        break;
      case "pastecode":
        pasteCode(message.code);
        break;
      case "stopCapture": {
        isDraggingCapture = false;
        const captureBox = document.getElementById("__ga_captureBox__");
        if (captureBox) {
          captureBox.style.display = "none";
        }

        const grayLayout = document.getElementById("__ga_grayLayout__");
        if (grayLayout) {
          grayLayout.style.display = "none";
        }
        break;
      }
      default:
        // invalid command, ignore it
        break;
    }

    return false;
  });

  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      return;
    }
    const grayLayout = document.getElementById("__ga_grayLayout__");
    if (!grayLayout || grayLayout.style.display === "none") {
      return;
    }
    event.preventDefault();
    isDraggingCapture = false;
    grayLayout.style.display = "none";
    const captureBox = document.getElementById("__ga_captureBox__");
    if (captureBox) {
      captureBox.style.display = "none";
    }
  });
}

function showGrayLayout() {
  let grayLayout = document.getElementById("__ga_grayLayout__");
  if (!grayLayout) {
    grayLayout = document.createElement("div");
    grayLayout.id = "__ga_grayLayout__";
    document.body.appendChild(grayLayout);
    const scan = document.createElement("div");
    scan.className = "scan";
    scan.id = "__ga_scan__";
    scan.style.background = `url('${scanGIF}') no-repeat center`;
    grayLayout.appendChild(scan);
    const captureBox = document.createElement("div");
    captureBox.id = "__ga_captureBox__";
    grayLayout.appendChild(captureBox);
    grayLayout.onmousedown = grayLayoutDown;
    grayLayout.onmousemove = grayLayoutMove;
    grayLayout.onmouseup = (event) => {
      grayLayoutUp(event);
    };
    grayLayout.oncontextmenu = (event) => {
      event.preventDefault();
      return;
    };
  }
  isDraggingCapture = false;
  grayLayout.style.display = "block";
}

function grayLayoutDown(event: MouseEvent) {
  if (event.button === 1 || event.button === 2) {
    event.preventDefault();
    return;
  }
  const captureBox = document.getElementById("__ga_captureBox__");
  if (!captureBox) {
    return;
  }

  isDraggingCapture = true;
  captureStartX = event.clientX;
  captureStartY = event.clientY;
  captureBox.style.left = event.clientX + "px";
  captureBox.style.top = event.clientY + "px";
  captureBox.style.width = "1px";
  captureBox.style.height = "1px";
  captureBox.style.display = "block";

  const scan = document.getElementById("__ga_scan__");
  if (scan) {
    scan.style.background = "transparent";
  }
  return;
}

function grayLayoutMove(event: MouseEvent) {
  if (!isDraggingCapture) {
    return;
  }
  if (event.button === 1 || event.button === 2) {
    event.preventDefault();
    return;
  }
  const captureBox = document.getElementById("__ga_captureBox__");
  if (!captureBox) {
    return;
  }

  const captureBoxLeft = Math.min(captureStartX, event.clientX);
  const captureBoxTop = Math.min(captureStartY, event.clientY);
  const captureBoxWidth = Math.max(
    0,
    Math.abs(captureStartX - event.clientX) - 1
  );
  const captureBoxHeight = Math.max(
    0,
    Math.abs(captureStartY - event.clientY) - 1
  );
  captureBox.style.left = captureBoxLeft + "px";
  captureBox.style.top = captureBoxTop + "px";
  captureBox.style.width = captureBoxWidth + "px";
  captureBox.style.height = captureBoxHeight + "px";
  return;
}

function grayLayoutUp(event: MouseEvent) {
  const grayLayout = document.getElementById("__ga_grayLayout__");
  const captureBox = document.getElementById("__ga_captureBox__");
  if (!captureBox || !grayLayout) {
    return;
  }

  const wasDragging = isDraggingCapture;
  isDraggingCapture = false;

  setTimeout(() => {
    captureBox.style.display = "none";
    grayLayout.style.display = "none";
  }, 100);

  if (event.button === 1 || event.button === 2) {
    event.preventDefault();
    return;
  }

  if (!wasDragging) {
    return false;
  }

  const captureBoxLeft = Math.min(captureStartX, event.clientX) + 1;
  const captureBoxTop = Math.min(captureStartY, event.clientY) + 1;
  const captureBoxWidth = Math.abs(captureStartX - event.clientX) - 1;
  const captureBoxHeight = Math.abs(captureStartY - event.clientY) - 1;

  if (captureBoxWidth <= 0 || captureBoxHeight <= 0) {
    return false;
  }

  // make sure captureBox and grayLayout is hidden
  setTimeout(() => {
    chrome.runtime.sendMessage({
      action: "getCapture",
      info: {
        captureBoxLeft,
        captureBoxTop,
        captureBoxWidth,
        captureBoxHeight,
      },
    });
  }, 200);
  return false;
}

async function qrDecode(
  url: string,
  left: number,
  top: number,
  width: number,
  height: number
) {
  if (width <= 0 || height <= 0 || !window.innerWidth) {
    return;
  }
  const qr = new Image();
  qr.onload = () => {
    // Keep decoding canvas detached from document.body so host page scripts
    // can never read the viewport screenshot or secret QR code pixels.
    const canvas = document.createElement("canvas");
    try {
      const devicePixelRatio = qr.width / window.innerWidth;
      const sx = Math.max(0, Math.round(left * devicePixelRatio));
      const sy = Math.max(0, Math.round(top * devicePixelRatio));
      const sw = Math.round(width * devicePixelRatio);
      const sh = Math.round(height * devicePixelRatio);
      if (sw <= 0 || sh <= 0) {
        return;
      }
      canvas.width = qr.width;
      canvas.height = qr.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      ctx.drawImage(qr, 0, 0);
      const imageData = ctx.getImageData(sx, sy, sw, sh);
      if (!imageData) {
        return;
      }
      canvas.width = 0;
      canvas.height = 0;

      const qrReader = new QRCode();
      qrReader.callback = (
        error: string,
        text?: {
          result?: string;
          points: Array<{
            x: number;
            y: number;
            count: number;
            estimatedModuleSize: number;
          }>;
        }
      ) => {
        let qrRes = "";
        if (error || typeof text?.result !== "string") {
          if (error) {
            console.error(error);
          }
          const jsQrCode = jsQR(
            imageData.data,
            imageData.width,
            imageData.height
          );

          if (jsQrCode) {
            qrRes = jsQrCode.data;
          } else {
            alert(chrome.i18n.getMessage("errorqr"));
          }
        } else {
          qrRes = text.result;
        }

        chrome.runtime.sendMessage({
          action: "getTotp",
          info: qrRes,
        });
      };
      qrReader.decode(imageData);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  };
  qr.src = url;
}

function pasteCode(code: string) {
  const _inputBoxes = document.getElementsByTagName("input");
  const inputBoxes: HTMLInputElement[] = [];
  for (let i = 0; i < _inputBoxes.length; i++) {
    if (
      _inputBoxes[i].type === "text" ||
      _inputBoxes[i].type === "number" ||
      _inputBoxes[i].type === "tel" ||
      _inputBoxes[i].type === "password"
    ) {
      inputBoxes.push(_inputBoxes[i]);
    }
  }
  if (!inputBoxes.length) {
    return;
  }
  const identities = [
    "2fa",
    "otp",
    "authenticator",
    "factor",
    "code",
    "totp",
    "twoFactorCode",
  ];
  for (const inputBox of inputBoxes) {
    for (const identity of identities) {
      if (
        inputBox.name.toLowerCase().indexOf(identity) >= 0 ||
        inputBox.id.toLowerCase().indexOf(identity) >= 0
      ) {
        if (!inputBox.value || /^(\d{6}|\d{8})$/.test(inputBox.value)) {
          inputBox.value = code;
          fireInputEvents(inputBox);
        }
        return;
      }
    }
  }

  const activeInputBox =
    document.activeElement && document.activeElement.tagName === "INPUT"
      ? document.activeElement
      : null;
  if (activeInputBox) {
    const inputBox = activeInputBox as HTMLInputElement;
    if (!inputBox.value || /^(\d{6}|\d{8})$/.test(inputBox.value)) {
      inputBox.value = code;
      fireInputEvents(inputBox);
    }
    return;
  }

  for (const inputBox of inputBoxes) {
    if (
      (!inputBox.value || /^(\d{6}|\d{8})$/.test(inputBox.value)) &&
      inputBox.type !== "password"
    ) {
      inputBox.value = code;
      fireInputEvents(inputBox);
      return;
    }
  }
  return;
}

function fireInputEvents(inputBox: HTMLInputElement) {
  const events = [
    new KeyboardEvent("keydown"),
    new KeyboardEvent("keyup"),
    new KeyboardEvent("keypress"),
    new Event("input", { bubbles: true }),
    new Event("change", { bubbles: true }),
  ];
  for (const event of events) {
    inputBox.dispatchEvent(event);
  }
  return;
}
