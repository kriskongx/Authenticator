import fs from "fs";
import path from "path";

const entryPath = path.resolve("src/models/biometric-unlock.ts");
const entry = fs.readFileSync(entryPath, "utf8");
const match = entry.match(/export const BIOMETRIC_RP_ID = "([^"]*)";/);
if (!match) {
  throw new Error("BIOMETRIC_RP_ID declaration missing");
}

const output = path.resolve("build/biometric-rp-id.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ rpId: match[1] }));
