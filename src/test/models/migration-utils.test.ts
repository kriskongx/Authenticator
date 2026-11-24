import "mocha";
import { expect } from "chai";
import { getOTPAuthPerLineFromOPTAuthMigration } from "../../models/migration";
import { okToInjectContentScript } from "../../utils";

mocha.setup("bdd");

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v & 0x7f);
  return bytes;
}

function encodeLengthDelimited(field: number, payload: Uint8Array): number[] {
  return [
    ...encodeVarint((field << 3) | 2),
    ...encodeVarint(payload.length),
    ...Array.from(payload),
  ];
}

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("Migration protobuf & utils guards", () => {
  it("decodes otpauth-migration payloads with omitted optional fields, UTF-8 names, and HOTP counters", () => {
    const enc = new TextEncoder();
    const secretBytes = new Uint8Array([
      0x48,
      0x65,
      0x6c,
      0x6c,
      0x6f,
      0x21,
      0xde,
      0xad,
      0xbe,
      0xef,
    ]);
    // Entry 1: TOTP with omitted issuer, UTF-8 account, omitted algorithm/digits/type defaults
    const entry1 = new Uint8Array([
      ...encodeLengthDelimited(1, secretBytes),
      ...encodeLengthDelimited(2, enc.encode("测试@example.com")),
    ]);
    // Entry 2: HOTP with issuer, SHA256 (2), 8 digits (2), HOTP (1), counter 300 (>127 multi-byte varint)
    const entry2 = new Uint8Array([
      ...encodeLengthDelimited(1, secretBytes),
      ...encodeLengthDelimited(2, enc.encode("alice")),
      ...encodeLengthDelimited(3, enc.encode("Acme")),
      ...encodeVarint((4 << 3) | 0),
      2,
      ...encodeVarint((5 << 3) | 0),
      2,
      ...encodeVarint((6 << 3) | 0),
      1,
      ...encodeVarint((7 << 3) | 0),
      ...encodeVarint(300),
    ]);
    const payload = [
      ...encodeLengthDelimited(1, entry1),
      ...encodeLengthDelimited(1, entry2),
    ];
    const uri = `otpauth-migration://offline?data=${encodeURIComponent(
      toBase64(payload)
    )}&extra=ignored`;

    const lines = getOTPAuthPerLineFromOPTAuthMigration(uri);
    expect(lines).to.have.lengthOf(2);
    expect(lines[0]).to.equal(
      "otpauth://totp/%E6%B5%8B%E8%AF%95%40example.com?secret=JBSWY3DPEHPK3PXP"
    );
    expect(lines[1]).to.equal(
      "otpauth://hotp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme&counter=300&digits=8&algorithm=SHA256"
    );
  });

  it("returns empty array for missing or invalid migration data", () => {
    expect(
      getOTPAuthPerLineFromOPTAuthMigration("otpauth-migration://offline")
    ).to.deep.equal([]);
    expect(
      getOTPAuthPerLineFromOPTAuthMigration(
        "otpauth-migration://offline?data=!!!invalid!!!"
      )
    ).to.deep.equal([]);
  });

  it("handles undefined tab safely in okToInjectContentScript", () => {
    expect(okToInjectContentScript(undefined)).to.equal(false);
    expect(
      okToInjectContentScript({
        id: 1,
        url: "https://example.com",
      } as chrome.tabs.Tab)
    ).to.equal(true);
    expect(
      okToInjectContentScript({
        id: 1,
        url: "chrome://extensions",
      } as chrome.tabs.Tab)
    ).to.equal(false);
  });
});
