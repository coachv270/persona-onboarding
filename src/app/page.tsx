"use client";

import dynamic from "next/dynamic";

// Onboarding state lives in localStorage, so skip SSR to avoid hydration mismatches.
const App = dynamic(() => import("@/components/App"), { ssr: false });

export default function Home() {
  return <App />;
}
