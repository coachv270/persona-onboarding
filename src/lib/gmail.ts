// Gmail connect via Google Identity Services *popup* token flow.
// A popup (not a redirect) is essential: redirecting away would kill an
// in-progress voice call. Must be invoked from a user click, or browsers
// will block the popup.

const GIS_SRC = "https://accounts.google.com/gsi/client";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

interface TokenResponse {
  access_token?: string;
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
            callback: (resp: TokenResponse) => void;
            error_callback?: (err: { type: string; message?: string }) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

let gisLoading: Promise<void> | null = null;

// Preload on page mount so the click → popup path is synchronous enough that
// Safari doesn't treat it as an unsolicited popup.
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

export function requestGmailToken(): Promise<string> {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) return Promise.reject(new Error("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set"));
  if (!window.google?.accounts?.oauth2) return Promise.reject(new Error("Google sign-in not loaded yet"));

  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.access_token) resolve(resp.access_token);
        else reject(new Error(resp.error_description ?? resp.error ?? "Gmail access was not granted"));
      },
      // Fires when the user closes the popup or it gets blocked.
      error_callback: (err) => reject(new Error(err.message ?? err.type)),
    });
    client.requestAccessToken();
  });
}

export interface MailSummary {
  email: string;
  messages: { from: string; subject: string }[];
}

async function gmailGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Only headers (From/Subject) — enough to spot what the user could use help
// with, without pulling message bodies into the browser.
export async function fetchRecentMail(token: string, max = 25): Promise<MailSummary> {
  const profile = await gmailGet<{ emailAddress: string }>(token, "profile");
  const q = encodeURIComponent("in:inbox -category:promotions -category:social newer_than:30d");
  const list = await gmailGet<{ messages?: { id: string }[] }>(token, `messages?maxResults=${max}&q=${q}`);

  const messages = await Promise.all(
    (list.messages ?? []).map(async ({ id }) => {
      const msg = await gmailGet<{ payload?: { headers?: { name: string; value: string }[] } }>(
        token,
        `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      );
      const header = (name: string) => msg.payload?.headers?.find((h) => h.name === name)?.value ?? "";
      return { from: header("From"), subject: header("Subject") };
    }),
  );

  return { email: profile.emailAddress, messages };
}
