"use client";

import { useState, useSyncExternalStore } from "react";
import { clearDevlog, devlogStore, type DevKind } from "@/lib/devlog";

const KIND_STYLE: Record<DevKind, string> = {
  chat: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  tool: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  voice: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  state: "bg-black/5 dark:bg-white/10",
  gmail: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  error: "bg-red-500/15 text-red-700 dark:text-red-300",
};

function time(at: number) {
  const d = new Date(at);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function DevPanel() {
  const [open, setOpen] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  // Everything (onboarding state, chat history, this log) lives in localStorage.
  const wipe = () => {
    try {
      localStorage.clear();
    } catch {}
    location.reload();
  };
  const entries = useSyncExternalStore(devlogStore.subscribe, devlogStore.getSnapshot, devlogStore.getSnapshot);
  const errors = entries.filter((e) => e.kind === "error").length;

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed top-2.5 right-3 z-50 rounded-full bg-red-600 text-white px-3 py-1 text-xs font-mono shadow-sm hover:bg-red-700"
      >
        Dev{errors > 0 && <span className="ml-1 rounded-full bg-white text-red-600 px-1.5">{errors}</span>}
      </button>

      {open && (
        <div className="fixed top-12 right-3 bottom-3 z-50 w-[min(560px,calc(100vw-1.5rem))] rounded-2xl border border-black/15 dark:border-white/20 bg-background shadow-xl flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b border-black/10 dark:border-white/15 text-xs">
            <span className="font-medium">
              Event log · {entries.length} {entries.length === 1 ? "entry" : "entries"}
            </span>
            <div className="flex gap-3">
              <button onClick={() => navigator.clipboard?.writeText(JSON.stringify(entries, null, 2))} className="opacity-60 hover:opacity-100">
                Copy JSON
              </button>
              <button onClick={clearDevlog} className="opacity-60 hover:opacity-100">
                Clear log
              </button>
              <button onClick={() => setOpen(false)} className="opacity-60 hover:opacity-100">
                ✕
              </button>
            </div>
          </div>
          <div className="px-4 py-2 border-b border-black/10 dark:border-white/15 text-xs flex items-center gap-3">
            {confirmWipe ? (
              <>
                <span className="text-red-600">Erase all local data (state, chat, log) and reload?</span>
                <button onClick={wipe} className="rounded-full bg-red-600 text-white px-3 py-0.5">
                  Yes, clear
                </button>
                <button onClick={() => setConfirmWipe(false)} className="opacity-60 hover:opacity-100">
                  Cancel
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmWipe(true)} className="text-red-600 opacity-80 hover:opacity-100">
                Clear local data…
              </button>
            )}
          </div>
          <ol className="flex-1 overflow-y-auto font-mono text-[11px] leading-snug divide-y divide-black/5 dark:divide-white/10">
            {[...entries].reverse().map((e) => (
              <li key={e.id} className="px-4 py-1.5 flex gap-2 items-start">
                <span className="opacity-50 shrink-0 tabular-nums">{time(e.at)}</span>
                <span className={`shrink-0 rounded px-1.5 ${KIND_STYLE[e.kind]}`}>{e.kind}</span>
                <span className="min-w-0 break-words">
                  {e.message}
                  {e.data !== undefined && (
                    <details className="opacity-60">
                      <summary className="cursor-pointer">data</summary>
                      <pre className="whitespace-pre-wrap break-all">{JSON.stringify(e.data, null, 2)}</pre>
                    </details>
                  )}
                </span>
              </li>
            ))}
            {entries.length === 0 && <li className="px-4 py-6 text-center opacity-50">No events yet.</li>}
          </ol>
        </div>
      )}
    </>
  );
}
