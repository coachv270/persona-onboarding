// Gmail access via Google Identity Services *popup* token flow, entirely in
// the browser. A popup (not a redirect) keeps an in-progress voice call alive.
// requestGmailToken must run first thing in a click handler — before any
// await — or browsers block the popup.

import { devlog } from "./devlog";

const GIS_SRC = "https://accounts.google.com/gsi/client";
export const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            hint?: string;
            include_granted_scopes?: boolean;
            callback: (resp: TokenResponse) => void;
            error_callback?: (err: { type: string; message?: string }) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

let gisLoading: Promise<void> | null = null;

// Preload on page mount so the click → popup path stays synchronous.
export function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google sign-in"));
    document.head.appendChild(script);
  });
  return gisLoading;
}

// ---- Token cache (memory only: tokens never touch storage or the dev log) ----

const tokens = new Map<string, { token: string; expiresAt: number }>();
const tokenListeners = new Set<() => void>();
let tokenVersion = 0;

function tokensChanged() {
  tokenVersion++;
  tokenListeners.forEach((l) => l());
}

export const tokenStore = {
  subscribe(l: () => void) {
    tokenListeners.add(l);
    return () => tokenListeners.delete(l);
  },
  getSnapshot: () => tokenVersion,
};

export function getCachedToken(scope: string = READONLY): string | null {
  const t = tokens.get(scope);
  return t && t.expiresAt > Date.now() + 30_000 ? t.token : null;
}

function forgetToken(token: string) {
  for (const [scope, t] of tokens) if (t.token === token) tokens.delete(scope);
  tokensChanged();
}

export function requestGmailToken({ scope = READONLY, hint }: { scope?: string; hint?: string | null } = {}): Promise<string> {
  const cached = getCachedToken(scope);
  if (cached) return Promise.resolve(cached);
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) return Promise.reject(new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set"));
  if (!window.google?.accounts?.oauth2) return Promise.reject(new Error("Google sign-in not loaded yet"));

  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      ...(hint ? { hint } : {}),
      include_granted_scopes: true,
      callback: (resp) => {
        if (!resp.access_token) {
          reject(new Error(resp.error_description ?? resp.error ?? "Gmail access was not granted"));
          return;
        }
        const granted = (resp.scope ?? scope).split(" ");
        // Granular consent lets users untick scopes; don't pretend we got it.
        if (!granted.includes(scope)) {
          reject(new Error("Gmail permission was not granted"));
          return;
        }
        const expiresAt = Date.now() + Number(resp.expires_in ?? 3600) * 1000;
        for (const s of [READONLY, COMPOSE]) if (granted.includes(s)) tokens.set(s, { token: resp.access_token, expiresAt });
        tokensChanged();
        resolve(resp.access_token);
      },
      // Fires when the user closes the popup or it gets blocked.
      error_callback: (err) => reject(new Error(err.message ?? err.type)),
    });
    client.requestAccessToken();
  });
}

// ---- API calls ----

export class GmailAuthError extends Error {}

// Gmail allows ~250 quota units/user/second; messages.get costs 5, so cap
// concurrency instead of firing dozens of requests at once.
const MAX_PARALLEL = 8;
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

async function gmailFetch<T>(token: string, path: string, init?: RequestInit, log = true): Promise<T> {
  const label = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
  return withSlot(async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (res.status === 429 && attempt === 0) {
        devlog("gmail", `${label} → 429, retrying`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (res.status === 401) {
        forgetToken(token);
        devlog("gmail", `${label} → 401 (access expired)`);
        throw new GmailAuthError("Gmail access expired");
      }
      if (!res.ok) {
        devlog("error", `Gmail ${label} → ${res.status}`);
        throw new Error(`Gmail API ${res.status}`);
      }
      if (log) devlog("gmail", `${label} → ${res.status}`);
      return res.json();
    }
  });
}

type Header = { name: string; value: string };
interface RawPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: RawPart[];
  headers?: Header[];
}
interface RawMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: RawPart;
}

const header = (m: RawMessage, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

export interface MailItem {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export async function getProfileEmail(token: string): Promise<string> {
  return (await gmailFetch<{ emailAddress: string }>(token, "profile")).emailAddress;
}

export async function searchMessages(
  token: string,
  q: string,
  max: number,
): Promise<{ items: MailItem[]; estimate: number }> {
  const list = await gmailFetch<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(
    token,
    `messages?maxResults=${Math.min(max, 30)}&q=${encodeURIComponent(q)}`,
  );
  const ids = list.messages ?? [];
  const settled = await Promise.allSettled(
    ids.map(({ id }) =>
      gmailFetch<RawMessage>(
        token,
        `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        undefined,
        false,
      ),
    ),
  );
  const auth = settled.find((r) => r.status === "rejected" && r.reason instanceof GmailAuthError);
  if (auth) throw (auth as PromiseRejectedResult).reason;
  const items = settled
    .filter((r): r is PromiseFulfilledResult<RawMessage> => r.status === "fulfilled")
    .map(({ value: m }) => ({
      id: m.id,
      threadId: m.threadId,
      from: header(m, "From"),
      subject: header(m, "Subject"),
      date: header(m, "Date"),
      snippet: m.snippet ?? "",
    }));
  devlog("gmail", `Fetched ${items.length}/${ids.length} message headers`);
  return { items, estimate: list.resultSizeEstimate ?? items.length };
}

function decodeBase64Url(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function findPart(part: RawPart | undefined, mime: string): RawPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return undefined;
}

export interface FullMessage extends MailItem {
  to: string;
  replyTo: string;
  messageId: string;
  references: string;
  body: string;
}

export async function getMessage(token: string, id: string, maxChars: number): Promise<FullMessage> {
  const m = await gmailFetch<RawMessage>(token, `messages/${encodeURIComponent(id)}?format=full`);
  let body = "";
  const plain = findPart(m.payload, "text/plain");
  if (plain?.body?.data) {
    body = decodeBase64Url(plain.body.data);
  } else {
    const html = findPart(m.payload, "text/html");
    if (html?.body?.data) {
      body = new DOMParser().parseFromString(decodeBase64Url(html.body.data), "text/html").body.textContent ?? "";
    }
  }
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}… [truncated]`;
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m, "From"),
    to: header(m, "To"),
    replyTo: header(m, "Reply-To"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    snippet: m.snippet ?? "",
    messageId: header(m, "Message-ID"),
    references: header(m, "References"),
    body,
  };
}

// ---- Drafts (never sent) ----

export interface Draft {
  id: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string;
  references: string;
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

// RFC 2047 encoded-word for headers that aren't plain ASCII.
function encodeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${base64Utf8(s)}?=`;
}

function encodeAddress(addr: string): string {
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m && m[1] ? `${encodeWord(m[1])} <${m[2]}>` : addr;
}

export async function createDraft(token: string, d: Draft): Promise<void> {
  const headers = [
    `To: ${encodeAddress(d.to)}`,
    `Subject: ${encodeWord(d.subject)}`,
    ...(d.inReplyTo ? [`In-Reply-To: ${d.inReplyTo}`, `References: ${d.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  const raw = base64Utf8(`${headers.join("\r\n")}\r\n\r\n${d.body.replace(/\r?\n/g, "\r\n")}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  await gmailFetch(token, "drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw, threadId: d.threadId } }),
  });
}

// ---- Onboarding "value moment": recent headers for /api/insights ----

export interface MailSummary {
  email: string;
  messages: { from: string; subject: string }[];
}

export async function fetchRecentMail(token: string, max = 25): Promise<MailSummary> {
  const email = await getProfileEmail(token);
  const { items } = await searchMessages(token, "in:inbox -category:promotions -category:social newer_than:30d", max);
  return { email, messages: items.map(({ from, subject }) => ({ from, subject })) };
}
