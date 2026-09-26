// Types shared by the browser and the server mail routes (no server-only imports).

export const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

export type Detail = "voice" | "text";

export interface Draft {
  id: string;
  threadId: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string;
  references: string;
}

export interface MailResult {
  // Plain text for the LLM.
  text: string;
  // "connect": show Connect Gmail. "reconnect": Google access was lost.
  // "compose": the drafts permission is needed (requested on the Save click).
  needs?: "connect" | "reconnect" | "compose";
  draft?: Draft;
  // Server-side steps for the Dev panel (never tokens or email bodies).
  log?: string[];
}

// What the browser may know about the Gmail connection: never a token.
export interface GmailStatus {
  connected: boolean;
  email?: string;
  scopes?: string[];
  accessExpiresAt?: number;
}
