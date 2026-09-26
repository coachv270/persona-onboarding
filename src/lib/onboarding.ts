// Single source of truth for the user's profile and what the assistant can do.
// Text chat (Gemini), the voice call (ElevenLabs) and the on-screen fields all
// read and write this same object, so the user can hop between channels — or
// hang up — without losing anything.

export type GmailStatus = "not_asked" | "offered" | "connected" | "declined";
export type EmailProvider = "google" | "microsoft" | "other" | "unknown";
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
  userEmail: string | null;
  // "google" wins over anything typed or spoken.
  userEmailSource?: "user" | "google";
  // Where that address's mail is hosted (MX lookup); only Google can be connected today.
  userEmailProvider?: EmailProvider;
  helpNeed: string | null;
  gmail: GmailState;
  call: {
    status: CallStatus;
    attempts: number;
    lastEndReason?: string;
  };
  // Setup finished or skipped: stop asking for profile details. Never gates features.
  graduated: boolean;
}

export const initialState: OnboardingState = {
  agentName: null,
  userName: null,
  userEmail: null,
  helpNeed: null,
  gmail: { status: "not_asked" },
  call: { status: "idle", attempts: 0 },
  graduated: false,
};

export type Action =
  | { type: "setAgentName"; value: string }
  | { type: "setUserName"; value: string }
  | { type: "setUserEmail"; value: string; source: "user" | "google"; provider?: EmailProvider }
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
    case "setUserEmail":
      // A typed/spoken address never overrides the connected Google account.
      if (state.userEmailSource === "google" && action.source === "user") return state;
      return {
        ...state,
        userEmail: action.value,
        userEmailSource: action.source,
        userEmailProvider: action.source === "google" ? "google" : action.provider,
      };
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

export type Slot = "agentName" | "userName" | "userEmail" | "gmail" | "helpNeed";

export function missingSlots(s: OnboardingState): Slot[] {
  const missing: Slot[] = [];
  if (!s.agentName) missing.push("agentName");
  if (!s.userName) missing.push("userName");
  if (!s.userEmail) missing.push("userEmail");
  // Declined, or a non-Google address (connecting it is coming soon), counts as
  // resolved: we don't nag, but may re-offer once.
  if (s.gmail.status !== "connected" && s.gmail.status !== "declined" && !isNonGoogle(s)) missing.push("gmail");
  if (!s.helpNeed) missing.push("helpNeed");
  return missing;
}

// Plain-English snapshot injected into every LLM turn (chat system prompt and
// voice contextual updates) so neither agent re-asks for known information.
export function describeState(s: OnboardingState): string {
  const lines = [
    `Agent name: ${s.agentName ?? "(not chosen yet)"}`,
    `User name: ${s.userName ?? "(unknown)"}`,
    `Email: ${s.userEmail ? `${s.userEmail}${emailNote(s)}` : "(unknown)"}`,
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
  if (s.graduated) lines.push("Setup: finished or skipped. Don't ask for missing profile details.");
  else lines.push(`Still missing: ${missing.length ? missing.join(", ") : "nothing, setup complete"}`);
  return lines.join("\n");
}

export const isNonGoogle = (s: OnboardingState) =>
  s.userEmailProvider === "microsoft" || s.userEmailProvider === "other";

function emailNote(s: OnboardingState): string {
  if (s.userEmailSource === "google") return " (from their connected Google account)";
  switch (s.userEmailProvider) {
    case "google":
      return " (a Google account: Connect Gmail works with it)";
    case "microsoft":
    case "other":
      return " (not a Google account: connecting non-Google email is coming soon)";
    case "unknown":
      return " (couldn't tell if it's a Google account)";
    default:
      return "";
  }
}

// Pure format check. Turning speech ("coach v at …") into an address is the
// LLM's job; code only verifies the result.
export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/\s+/g, "");
  return /^[^@]+@[^@]+\.[a-z]{2,}$/.test(v) && !v.includes("..") ? v : null;
}

export type MailAccess = "locked" | "unlocked" | "expired";

// Progressive unlock: Gmail connected + a live token in this tab = mail commands.
export function mailAccess(s: OnboardingState, hasToken: boolean): MailAccess {
  if (s.gmail.status !== "connected") return "locked";
  return hasToken ? "unlocked" : "expired";
}

export function describeCapabilities(s: OnboardingState, hasToken: boolean): string {
  const mail = {
    unlocked: "UNLOCKED. Use the mail tools now.",
    locked: isNonGoogle(s)
      ? "LOCKED. Their email isn't a Google account, and connecting non-Google email is coming soon. Say that once. If they also have a Google account, they can connect it with the Connect Gmail button."
      : "LOCKED. Gmail isn't connected. Offer the Connect Gmail button; the user clicks it in their browser.",
    expired: "NEEDS RECONNECT. Gmail was connected, but this browser session's access expired. Running a mail tool shows a Reconnect button.",
  }[mailAccess(s, hasToken)];
  return [
    `Email help (summarize a period, find or read an email, draft a reply, never sent): ${mail}`,
    "Always available: conversation, remembering profile details.",
  ].join("\n");
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
