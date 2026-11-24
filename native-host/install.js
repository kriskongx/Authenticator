#!/usr/bin/env node
"use strict";

// Registers the native messaging host so the extension can talk to it.
//
//   node native-host/install.js --extension-id <id>
//   node native-host/install.js --extension-id <id> --dir ~/Vaultwarden
//   node native-host/install.js --extension-id <id> --node /usr/local/bin/node
//   node native-host/install.js --uninstall
//
// The id is the 32-character string shown on chrome://extensions. Unpacked
// builds get a different id on every machine, so it has to be passed in.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOST_NAME = "com.otp_ee.authenticator_import";
const HOST_SCRIPT = path.join(__dirname, "host.js");
const RUNNER_SCRIPT = path.join(__dirname, "run.sh");
const BASE_DIR = path.join(os.homedir(), ".authenticator-import");
const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const DEFAULT_INBOX = path.join(BASE_DIR, "inbox");

const BROWSER_DIRS =
  process.platform === "linux"
    ? {
        chrome: path.join(
          os.homedir(),
          ".config/google-chrome/NativeMessagingHosts"
        ),
        edge: path.join(
          os.homedir(),
          ".config/microsoft-edge/NativeMessagingHosts"
        ),
        firefox: path.join(os.homedir(), ".mozilla/native-messaging-hosts"),
      }
    : {
        chrome: path.join(
          os.homedir(),
          "Library/Application Support/Google/Chrome/NativeMessagingHosts"
        ),
        edge: path.join(
          os.homedir(),
          "Library/Application Support/Microsoft Edge/NativeMessagingHosts"
        ),
        firefox: path.join(
          os.homedir(),
          "Library/Application Support/Mozilla/NativeMessagingHosts"
        ),
      };

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    if (key === "uninstall") {
      args.uninstall = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    args[key] = value;
    index++;
  }
  return args;
}

function writeRunner(nodePath) {
  const script = `#!/bin/sh\nexec ${shQuote(nodePath)} ${shQuote(
    HOST_SCRIPT
  )}\n`;
  fs.writeFileSync(RUNNER_SCRIPT, script, { mode: 0o755 });
  fs.chmodSync(RUNNER_SCRIPT, 0o755);
}

function ensureConfig(dir) {
  fs.mkdirSync(BASE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(BASE_DIR, 0o700);
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
  const config = {
    dir: path.resolve(dir || DEFAULT_INBOX),
    pattern: "\\.json$",
    maxBytes: 100 * 1024 * 1024,
    deleteAfterImport: true,
    intervalMinutes: 5,
  };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return config;
}

function hostManifest(browser, extensionId) {
  const manifest = {
    name: HOST_NAME,
    description: "Authenticator local backup importer",
    path: RUNNER_SCRIPT,
    type: "stdio",
  };
  if (browser === "firefox") {
    manifest.allowed_extensions = ["authenticator@mymindstorm"];
  } else {
    manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  }
  return manifest;
}

function install(extensionId, dir, nodePath) {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    fail(
      `Invalid extension id "${extensionId}". Copy the 32-character id from chrome://extensions.`
    );
  }

  const resolvedNode = path.resolve(nodePath || process.env.NODE_BINARY || process.execPath);
  if (!fs.existsSync(resolvedNode)) {
    fail(`Node binary not found: ${resolvedNode}`);
  }

  writeRunner(resolvedNode);
  const config = ensureConfig(dir);
  fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 });
  if (path.resolve(config.dir) === path.resolve(DEFAULT_INBOX)) {
    fs.chmodSync(config.dir, 0o700);
  }

  for (const [browser, browserDir] of Object.entries(BROWSER_DIRS)) {
    fs.mkdirSync(browserDir, { recursive: true });
    const target = path.join(browserDir, `${HOST_NAME}.json`);
    fs.writeFileSync(
      target,
      `${JSON.stringify(hostManifest(browser, extensionId), null, 2)}\n`
    );
    process.stdout.write(`registered ${browser}: ${target}\n`);
  }

  process.stdout.write(
    [
      "",
      `Host:        ${HOST_NAME}`,
      `Runner:      ${RUNNER_SCRIPT}`,
      `Node:        ${resolvedNode}`,
      `Watch dir:   ${config.dir}`,
      `Config:      ${CONFIG_PATH}`,
      "",
      "Drop Vaultwarden JSON exports into the watch dir. Any file matching",
      "*.json is picked up; the newest one wins and is imported once.",
      "",
      "The export is deleted after a successful import, because it holds",
      "plaintext TOTP secrets. Set deleteAfterImport to false in config.json",
      "to keep the files instead.",
      "",
      "If that node path is not the one you normally use, rerun with",
      "--node /path/to/node so the host keeps working after upgrades.",
      "",
      "Restart the browser, then reload the extension.",
      "",
    ].join("\n")
  );
}

function uninstall() {
  for (const browserDir of Object.values(BROWSER_DIRS)) {
    const target = path.join(browserDir, `${HOST_NAME}.json`);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      process.stdout.write(`removed ${target}\n`);
    }
  }
  if (fs.existsSync(RUNNER_SCRIPT)) {
    fs.unlinkSync(RUNNER_SCRIPT);
    process.stdout.write(`removed ${RUNNER_SCRIPT}\n`);
  }
  process.stdout.write(`\nKept ${BASE_DIR} (config, inbox and import state).\n`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.uninstall) {
    uninstall();
    return;
  }
  if (!args["extension-id"]) {
    fail(
      "Usage: node native-host/install.js --extension-id <id> [--dir <export dir>] [--node <node path>]\n" +
        "Run with --uninstall to remove the registration."
    );
  }
  install(args["extension-id"], args.dir, args.node);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  HOST_NAME,
  HOST_SCRIPT,
  RUNNER_SCRIPT,
  BASE_DIR,
  CONFIG_PATH,
  BROWSER_DIRS,
  install,
  uninstall,
};
