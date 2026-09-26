import "server-only";
import { cookies } from "next/headers";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Google tokens live only on the server side of the wire: sealed with
// AES-256-GCM into an httpOnly cookie. No database needed, and page scripts
// can't read it.

const COOKIE = "persona_gmail";
const MAX_AGE = 60 * 60 * 24 * 30;

export interface GmailSession {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  email: string;
  scopes: string[];
}

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHash("sha256").update(secret).digest();
}

function seal(data: GmailSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function unseal(value: string): GmailSession {
  const raw = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
}

export async function readSession(): Promise<GmailSession | null> {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value) return null;
  try {
    return unseal(value);
  } catch {
    return null; // tampered, or SESSION_SECRET changed
  }
}

export async function writeSession(session: GmailSession) {
  (await cookies()).set(COOKIE, seal(session), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSession() {
  (await cookies()).delete(COOKIE);
}
