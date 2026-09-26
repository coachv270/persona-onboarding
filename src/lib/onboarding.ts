// Single source of truth for onboarding progress. Both the text chat (Gemini)
// and the voice call (ElevenLabs) read and write this same object, so the user
// can hop between channels — or hang up — without losing anything.

export type GmailStatus = "not_asked" | "offered" | "connected" | "declined";
export type CallStatus = "idle" | "connecting" | "active" | "ended";

export interface GmailState {
  status: GmailStatus;
  email?: string;
  // Short, concrete things the agent could help with, derived from recent mail.
  insights?: string[];
}

export interface OnboardingState {
  agentName: string | null;
  userName: string | null;
  helpNeed: string | null;
  gmail: GmailState;
  call: {
    status: CallStatus;
    attempts: number;
    lastEndReason?: string;
  };
  graduated: boolean;
}

export const initialState: OnboardingState = {
  agentName: null,
  userName: null,
  helpNeed: null,
  gmail: { status: "not_asked" },
  call: { status: "idle", attempts: 0 },
  graduated: false,
};

export type Action =
  | { type: "setAgentName"; value: string }
  | { type: "setUserName"; value: string }
  | { type: "setHelpNeed"; value: string }
  | { type: "gmail"; value: Partial<GmailState> }
  | { type: "callConnecting" }
  | { type: "callActive" }
  | { type: "callEnded"; reason: string }
  | { type: "graduate" }
  | { type: "reset" };

export function reducer(state: OnboardingState, action: Action): OnboardingState {
  switch (action.type) {
    case "setAgentName":
      return { ...state, agentName: action.value.trim() };
    case "setUserName":
      return { ...state, userName: action.value.trim() };
    case "setHelpNeed":
      return { ...state, helpNeed: action.value.trim() };
    case "gmail":
      return { ...state, gmail: { ...state.gmail, ...action.value } };
    case "callConnecting":
      return { ...state, call: { ...state.call, status: "connecting", attempts: state.call.attempts + 1 } };
    case "callActive":
      return { ...state, call: { ...state.call, status: "active" } };
    case "callEnded":
      return { ...state, call: { ...state.call, status: "ended", lastEndReason: action.reason } };
    case "graduate":
      return { ...state, graduated: true };
    case "reset":
      return initialState;
  }
}

export type Slot = "agentName" | "userName" | "gmail" | "helpNeed";

export function missingSlots(s: OnboardingState): Slot[] {
  const missing: Slot[] = [];
  if (!s.agentName) missing.push("agentName");
  if (!s.userName) missing.push("userName");
  // A declined Gmail counts as resolved — we don't nag, but may re-offer once.
  if (s.gmail.status !== "connected" && s.gmail.status !== "declined") missing.push("gmail");
  if (!s.helpNeed) missing.push("helpNeed");
  return missing;
}

// Plain-English snapshot injected into every LLM turn (chat system prompt and
// voice contextual updates) so neither agent re-asks for known information.
export function describeState(s: OnboardingState): string {
  const lines = [
    `Agent name: ${s.agentName ?? "(not chosen yet)"}`,
    `User name: ${s.userName ?? "(unknown)"}`,
    `Gmail: ${
      s.gmail.status === "connected"
        ? `connected (${s.gmail.email ?? "address unknown"})`
        : s.gmail.status
    }`,
    `What they need help with: ${s.helpNeed ?? "(unknown)"}`,
  ];
  if (s.gmail.insights?.length) {
    lines.push(`Ideas from their inbox: ${s.gmail.insights.join("; ")}`);
  }
  if (s.call.status === "ended" && s.call.lastEndReason) {
    lines.push(`The last voice call ended (${s.call.lastEndReason}).`);
  }
  const missing = missingSlots(s);
  lines.push(`Still missing: ${missing.length ? missing.join(", ") : "nothing — ready to graduate"}`);
  return lines.join("\n");
}

const STORAGE_KEY = "persona-onboarding-v1";

export function loadState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    const parsed = { ...initialState, ...JSON.parse(raw) } as OnboardingState;
    // A call can't survive a page reload; don't restore a phantom "active" call.
    if (parsed.call.status === "active" || parsed.call.status === "connecting") {
      parsed.call = { ...parsed.call, status: "ended", lastEndReason: "page reloaded" };
    }
    return parsed;
  } catch {
    return initialState;
  }
}

export function saveState(s: OnboardingState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private mode / storage disabled — onboarding still works, just not across reloads.
  }
}
