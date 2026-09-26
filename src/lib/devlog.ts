// A tiny persistent event log for the Dev panel: every chat turn, tool call,
// voice event, state change and error, in one timestamped list.

export type DevKind = "chat" | "tool" | "voice" | "state" | "gmail" | "error";

export interface DevEntry {
  id: number;
  at: number;
  kind: DevKind;
  message: string;
  data?: unknown;
}

const KEY = "persona-devlog-v1";
const MAX = 500;

let entries: DevEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

try {
  entries = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  nextId = (entries.at(-1)?.id ?? 0) + 1;
} catch {
  entries = [];
}

function emit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {}
  listeners.forEach((l) => l());
}

export function devlog(kind: DevKind, message: string, data?: unknown) {
  entries = [...entries.slice(-(MAX - 1)), { id: nextId++, at: Date.now(), kind, message, data }];
  if (kind === "error") console.error(`[${kind}] ${message}`, data ?? "");
  emit();
}

export function clearDevlog() {
  entries = [];
  emit();
}

export const devlogStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => entries,
};

// Uncaught errors anywhere on the page end up in the log too.
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => devlog("error", e.message, { source: e.filename, line: e.lineno }));
  window.addEventListener("unhandledrejection", (e) =>
    devlog("error", `Unhandled rejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`),
  );
}
