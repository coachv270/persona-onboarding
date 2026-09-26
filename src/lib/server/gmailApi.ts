import "server-only";
import type { Draft } from "../mailTypes";

// Gmail REST calls, server-side only. `log` collects short step notes for the
// browser's Dev panel (paths, statuses, counts: never tokens or bodies).

export class GmailAuthError extends Error {}

// Gmail allows ~250 quota units/user/second and messages.get costs 5, so cap
// concurrency instead of firing dozens of requests at once.
const MAX_PARALLEL = 8;

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason) => ({ status: "rejected", reason }) as const,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, items.length) }, worker));
  return out;
}

async function gmailFetch<T>(token: string, path: string, log: string[] | null, init?: RequestInit): Promise<T> {
  const label = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (res.status === 429 && attempt === 0) {
      log?.push(`${label} → 429, retrying`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (res.status === 401) throw new GmailAuthError("Gmail access expired");
    if (!res.ok) {
      log?.push(`${label} → ${res.status}`);
      throw new Error(`Gmail API ${res.status}`);
    }
    log?.push(`${label} → ${res.status}`);
    return res.json();
  }
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
  labelIds?: string[];
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
  // Human tags from Gmail labels: unread, archived, promotions, social, updates…
  tags: string[];
}

const LABEL_TAGS: Record<string, string> = {
  UNREAD: "unread",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
  IMPORTANT: "important",
};

function tagsFor(labelIds: string[] = []): string[] {
  const tags = labelIds.map((l) => LABEL_TAGS[l]).filter(Boolean);
  if (!labelIds.includes("INBOX")) tags.push("archived");
  return tags;
}

// Everything the user received: archived and read included; not spam, trash,
// their own sent mail or drafts.
export const ALL_RECEIVED = "-in:spam -in:trash -in:sent -in:drafts";

export async function getProfileEmail(token: string, log: string[]): Promise<string> {
  return (await gmailFetch<{ emailAddress: string }>(token, "profile", log)).emailAddress;
}

export async function searchMessages(
  token: string,
  q: string,
  max: number,
  log: string[],
): Promise<{ items: MailItem[]; estimate: number }> {
  const list = await gmailFetch<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(
    token,
    `messages?maxResults=${Math.min(max, 30)}&q=${encodeURIComponent(q)}`,
    log,
  );
  const ids = list.messages ?? [];
  const settled = await pool(ids, ({ id }) =>
    gmailFetch<RawMessage>(
      token,
      `messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      null,
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
      tags: tagsFor(m.labelIds),
    }));
  log.push(`fetched ${items.length}/${ids.length} message headers`);
  return { items, estimate: list.resultSizeEstimate ?? items.length };
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ");
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

export async function getMessage(token: string, id: string, maxChars: number, log: string[]): Promise<FullMessage> {
  const m = await gmailFetch<RawMessage>(token, `messages/${encodeURIComponent(id)}?format=full`, log);
  const plain = findPart(m.payload, "text/plain");
  const html = plain ? undefined : findPart(m.payload, "text/html");
  let body = plain?.body?.data ? decode(plain.body.data) : html?.body?.data ? htmlToText(decode(html.body.data)) : "";
  body = body.replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
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
    tags: tagsFor(m.labelIds),
    messageId: header(m, "Message-ID"),
    references: header(m, "References"),
    body,
  };
}

// RFC 2047 encoded-word for headers that aren't plain ASCII.
function encodeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function encodeAddress(addr: string): string {
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m && m[1] ? `${encodeWord(m[1])} <${m[2]}>` : addr;
}

// Creates a Gmail draft (never sends), threaded as a reply.
export async function createDraft(token: string, d: Draft, log: string[]): Promise<void> {
  const headers = [
    `To: ${encodeAddress(d.to)}`,
    `Subject: ${encodeWord(d.subject)}`,
    ...(d.inReplyTo ? [`In-Reply-To: ${d.inReplyTo}`, `References: ${d.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${d.body.replace(/\r?\n/g, "\r\n")}`, "utf8").toString("base64url");
  await gmailFetch(token, "drafts", log, { method: "POST", body: JSON.stringify({ message: { raw, threadId: d.threadId } }) });
}
