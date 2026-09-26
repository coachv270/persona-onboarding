// Browser side of Gmail. It never holds a Google token: the Google popup
// returns a one-time *code*, which the server exchanges and keeps in an
// httpOnly cookie. All Gmail calls go through our API routes.
// requestAuthCode must run first thing in a click handler, before any await,
// or browsers block the popup.

import { devlog } from "./devlog";
import { COMPOSE, READONLY, type Detail, type GmailStatus, type MailResult } from "./mailTypes";

export { COMPOSE, READONLY };

const GIS_SRC = "https://accounts.google.com/gsi/client";

interface CodeResponse {
  code?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initCodeClient: (config: {
            client_id: string;
            scope: string;
            ux_mode: "popup";
            hint?: string;
            include_granted_scopes?: boolean;
            callback: (resp: CodeResponse) => void;
            error_callback?: (err: { type: string; message?: string }) => void;
          }) => { requestCode: () => void };
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

// ---- Connection status (shared by the app and the Dev panel) ----

let status: GmailStatus = { connected: false };
const listeners = new Set<() => void>();

function setStatus(next: GmailStatus) {
  status = next;
  listeners.forEach((l) => l());
}

export const gmailStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => status,
};

async function call<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  return { ok: res.ok, status: res.status, data: (await res.json()) as T };
}

export async function refreshGmailStatus(): Promise<GmailStatus> {
  const { data } = await call<GmailStatus>("/api/gmail/status");
  setStatus(data);
  return data;
}

// Opens Google's consent popup and resolves with a one-time code.
export function requestAuthCode({ scope = READONLY, hint }: { scope?: string; hint?: string | null } = {}): Promise<string> {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) return Promise.reject(new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set"));
  if (!window.google?.accounts?.oauth2) return Promise.reject(new Error("Google sign-in not loaded yet"));
  return new Promise((resolve, reject) => {
    window
      .google!.accounts.oauth2.initCodeClient({
        client_id: clientId,
        scope,
        ux_mode: "popup",
        include_granted_scopes: true,
        ...(hint ? { hint } : {}),
        callback: (resp) => {
          if (!resp.code) return reject(new Error(resp.error_description ?? resp.error ?? "Gmail access was not granted"));
          // Granular consent lets users untick scopes; don't pretend we got it.
          if (resp.scope && !resp.scope.split(" ").includes(scope)) return reject(new Error("Gmail permission was not granted"));
          resolve(resp.code);
        },
        // Fires when the user closes the popup or it gets blocked.
        error_callback: (err) => reject(new Error(err.message ?? err.type)),
      })
      .requestCode();
  });
}

export async function connectWithCode(code: string): Promise<GmailStatus> {
  const { ok, data } = await call<GmailStatus & { error?: string }>("/api/gmail/connect", { code });
  if (!ok) throw new Error(data.error ?? "Couldn't connect Gmail");
  devlog("gmail", `Server exchanged the code; connected ${data.email} (${(data.scopes ?? []).length} scopes)`);
  setStatus(data);
  return data;
}

// Runs an email command on the server (same for chat and voice).
export async function runMail(command: string, args: Record<string, unknown>, detail: Detail): Promise<MailResult> {
  const { ok, status: code, data } = await call<MailResult & { error?: string }>("/api/mail", { command, args, detail });
  for (const line of data.log ?? []) devlog("gmail", `server: ${line}`);
  if (!ok) throw new Error(data.error ?? `Mail request failed (${code})`);
  if (data.needs === "reconnect" || data.needs === "connect") void refreshGmailStatus();
  return data;
}

export async function fetchInboxIdeas(helpNeed: string | null): Promise<string[]> {
  const { data } = await call<{ insights: string[]; log?: string[] }>("/api/insights", { helpNeed });
  for (const line of data.log ?? []) devlog("gmail", `server: ${line}`);
  return data.insights ?? [];
}

// ---- Dev controls ----

export async function expireAccessToken() {
  const { data } = await call<GmailStatus>("/api/gmail/expire", {});
  devlog("gmail", "Dev: server access token dropped (next call refreshes)");
  setStatus(data);
}

export async function disconnectGmail() {
  const { data } = await call<GmailStatus>("/api/gmail/disconnect", {});
  devlog("gmail", "Disconnected: grant revoked at Google, session cookie cleared");
  setStatus(data);
}
