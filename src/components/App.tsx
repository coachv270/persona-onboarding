"use client";

import { useMemo, useState } from "react";
import { ConversationProvider } from "@elevenlabs/react";
import { Onboarding, loadMessages } from "./Onboarding";
import { loadState } from "@/lib/onboarding";
import { devlog } from "@/lib/devlog";
import { DevPanel } from "./DevPanel";

// Client-only (see page.tsx), so reading localStorage during render is safe.
export default function App() {
  const [session, setSession] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `session` is the reload trigger
  const initial = useMemo(() => ({ state: loadState(), messages: loadMessages() }), [session]);

  const reset = () => {
    try {
      // Keep the dev log across resets; it's the history of every run.
      for (const key of ["persona-onboarding-v1", "persona-onboarding-messages-v1"]) localStorage.removeItem(key);
    } catch {}
    devlog("state", "Start over");
    setSession((n) => n + 1);
  };

  // Provider sits above Onboarding so on-screen edits can reach a live call.
  return (
    <>
      <ConversationProvider key={session}>
        <Onboarding initialState={initial.state} initialMessages={initial.messages} onReset={reset} />
      </ConversationProvider>
      <DevPanel />
    </>
  );
}
