/**
 * Device bearer token helpers for DeskLink.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function loadOrCreateToken(tokenFile: string): string {
  const file = path.resolve(tokenFile);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf-8").trim();
  }
  const token = generateToken();
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}
