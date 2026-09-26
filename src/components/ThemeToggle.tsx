"use client";

import { useState } from "react";

// Light/dark switch. The initial class is set by the inline script in layout.tsx;
// the choice is saved so it survives reloads.
export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("persona-theme", next ? "dark" : "light");
    } catch {}
    setDark(next);
  };
  return (
    <button
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
      className="pill size-8 flex items-center justify-center text-sm"
    >
      {dark ? "☀︎" : "☾"}
    </button>
  );
}
