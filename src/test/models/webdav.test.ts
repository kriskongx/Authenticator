import "mocha";
import { expect } from "chai";
import { Encryption } from "../../models/encryption";
import { UserSettings } from "../../models/settings";
import {
  buildWebDAVBackupFileName,
  encodeBasicAuth,
  extractWebDAVRelativePath,
  getWebDAVClientPlatform,
  getWebDAVBackupsToPrune,
  isAuthenticatorBackupFileName,
  isWebDAVBackupDue,
  parseMultistatus,
  readWebDAVResponseText,
  saveWebDAVConfig,
  uploadWebDAVBackup,
} from "../../models/webdav";
import { quickWebDAVBackup } from "../../models/webdav-quick";

mocha.setup("bdd");

describe("WebDAV transfer limits", () => {
  it("runs the automatic backup on a seven-day interval or clock rollback", () => {
    expect(isWebDAVBackupDue(100, 93)).to.equal(true);
    expect(isWebDAVBackupDue(100, 94)).to.equal(false);
    expect(isWebDAVBackupDue(100, 101)).to.equal(true);
  });

  it("selects only the oldest WebDAV files beyond the retention limit", () => {
    const files = [
      {
        name: "old.json",
        displayName: "old.json",
        lastModified: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "new.json",
        displayName: "new.json",
        lastModified: "2026-03-01T00:00:00.000Z",
      },
      {
        name: "middle.json",
        displayName: "middle.json",
        lastModified: "2026-02-01T00:00:00.000Z",
      },
    ];

    expect(getWebDAVBackupsToPrune(files, 2).map((file) => file.name)).to.eql([
      "old.json",
    ]);
  });

  it("adds the client platform and backup type to generated file names", () => {
    const fileName = buildWebDAVBackupFileName(
      new Date("2026-07-28T10:11:12.123Z"),
      true,
      "mac"
    );

    expect(fileName).to.equal(
      "authenticator-mac-encrypted-2026-07-28T10-11-12-123Z-123.json"
    );
  });

  it("detects common desktop platforms for WebDAV backup names", () => {
    expect(getWebDAVClientPlatform("Mozilla/5.0 (Macintosh)", "")).to.equal(
      "mac"
    );
    expect(
      getWebDAVClientPlatform("Mozilla/5.0 (Windows NT 10.0)", "")
    ).to.equal("windows");
    expect(
      getWebDAVClientPlatform("Mozilla/5.0 (X11; Linux x86_64)", "")
    ).to.equal("linux");
  });

  it("rejects a response whose declared size exceeds the limit", async () => {
    const response = new Response("12345", {
      headers: { "content-length": "5" },
    });
    const error = await captureError(
      readWebDAVResponseText(response, { maxBytes: 4 })
    );

    expect(error.message).to.equal("backupContentTooLarge");
  });

  it("reports streamed download progress", async () => {
    const progress: number[] = [];
    const response = new Response("12345");

    const result = await readWebDAVResponseText(response, {
      maxBytes: 10,
      onProgress: (loaded) => progress.push(loaded),
    });

    expect(result).to.equal("12345");
    expect(progress[progress.length - 1]).to.equal(5);
  });

  it("encodes UTF-8 Basic Auth credentials without failing on non-ASCII characters", () => {
    const encoded = encodeBasicAuth("用户", "密码🔑");
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    );
    expect(decoded).to.equal("用户:密码🔑");
  });

  it("extracts relative WebDAV paths from absolute URLs and malformed encodings", () => {
    expect(
      extractWebDAVRelativePath(
        "https://dav.example.com/dav/authenticator-mac-encrypted-2026.json",
        "https://dav.example.com/dav"
      )
    ).to.equal("authenticator-mac-encrypted-2026.json");
    expect(
      extractWebDAVRelativePath("/dav/", "https://dav.example.com/dav")
    ).to.equal("");
    expect(
      extractWebDAVRelativePath(
        "/dav/100%bad.json",
        "https://dav.example.com/dav"
      )
    ).to.equal("100%bad.json");
  });

  it("identifies only Authenticator backup files for retention pruning", () => {
    expect(
      isAuthenticatorBackupFileName(
        "authenticator-mac-encrypted-2026-07-28T10-11-12-123Z-123.json"
      )
    ).to.equal(true);
    expect(isAuthenticatorBackupFileName("notes.txt")).to.equal(false);
    expect(isAuthenticatorBackupFileName("keepass.kdbx")).to.equal(false);
    expect(isAuthenticatorBackupFileName("manual.json")).to.equal(false);
  });

  it("extracts metadata across multiple propstat blocks when 404 precedes 200", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/dav/authenticator-mac-encrypted-2026-07-28T10-11-12-123Z-123.json</d:href>
          <d:propstat>
            <d:prop><d:displayname/></d:prop>
            <d:status>HTTP/1.1 404 Not Found</d:status>
          </d:propstat>
          <d:propstat>
            <d:prop>
              <d:getcontentlength>4096</d:getcontentlength>
              <d:getlastmodified>Tue, 28 Jul 2026 10:11:12 GMT</d:getlastmodified>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
          </d:propstat>
        </d:response>
      </d:multistatus>`;

    const entries = parseMultistatus(xml);
    expect(entries).to.have.lengthOf(1);
    expect(entries[0].size).to.equal("4096");
    expect(entries[0].lastModified).to.equal("Tue, 28 Jul 2026 10:11:12 GMT");
  });

  describe("WebDAV encrypted backup guard", () => {
    afterEach(async () => {
      await chrome.storage.local.remove("UserSettings");
      UserSettings.items = {};
    });

    it("refuses encrypted WebDAV upload when no master password is active", async () => {
      await saveWebDAVConfig({
        url: "https://dav.example.com/dav",
        username: "alice",
        password: "secret",
        encrypted: true,
      });

      const error = await captureError(
        uploadWebDAVBackup(new Encryption("", ""), true)
      );
      expect(error.message).to.equal("encryptionRequired");
    });

    it("returns needsPassword from quickWebDAVBackup when encryption is enabled without a key", async () => {
      await saveWebDAVConfig({
        url: "https://dav.example.com/dav",
        username: "alice",
        password: "secret",
        encrypted: true,
      });

      const result = await quickWebDAVBackup(new Encryption("", ""));
      expect(result).to.equal("needsPassword");
    });
  });
});

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected promise to reject");
}
