"use client";

import { useMemo, useState } from "react";
import { Onboarding, loadMessages } from "./Onboarding";
import { loadState } from "@/lib/onboarding";

// Client-only (see page.tsx), so reading localStorage during render is safe.
export default function App() {
  const [session, setSession] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `session` is the reload trigger
  const initial = useMemo(() => ({ state: loadState(), messages: loadMessages() }), [session]);

  const reset = () => {
    try {
      localStorage.clear();
    } catch {}
    setSession((n) => n + 1);
  };

  return <Onboarding key={session} initialState={initial.state} initialMessages={initial.messages} onReset={reset} />;
}
