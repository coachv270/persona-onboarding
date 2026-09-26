"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode } from "react";
import {
  useConversation,
  useConversationClientTool,
  type DisconnectionDetails,
} from "@elevenlabs/react";
import type { Action, OnboardingState } from "@/lib/onboarding";
import { UNNAMED_AGENT, voiceContext, voiceFirstMessage } from "@/lib/prompts";
import { devlog } from "@/lib/devlog";

interface Props {
  state: OnboardingState;
  dispatch: Dispatch<Action>;
  hasToken: boolean;
  // true: the user tapped "Call" (dial immediately); false: the text agent is ringing them.
  autoStart: boolean;
  // Shared tool implementation (same as the chat's).
  runTool: (name: string, input: Record<string, unknown>, detail: "voice" | "text") => Promise<string>;
  onConnected: () => void;
  onTranscript: (role: "user" | "agent", text: string) => void;
  onEnded: (reason: string) => void;
  onDecline: () => void;
  // Shown under the captions, e.g. the Connect Gmail card.
  children?: ReactNode;
}

type Line = { role: "user" | "agent"; text: string };

function describeDisconnect(d: DisconnectionDetails): string {
  switch (d.reason) {
    case "user":
      return "the user hung up";
    case "agent":
      return d.context?.type === "end_call" ? "you ended the call" : "the call dropped";
    case "error":
      return d.context?.type === "max_duration_exceeded" ? "the call hit its time limit" : "the connection dropped";
  }
}

// Short, human reason for state + the model's context; raw details go to the console.
function failureReason(message: string): string {
  devlog("error", `Voice call failed: ${message}`);
  return /NotAllowedError|Permission denied|microphone/i.test(message)
    ? "microphone access was blocked"
    : "the call couldn't connect";
}

// The voice model sometimes wraps replies in tags like <Jenny>…</Jenny>; keep
// captions and the transcript clean.
function cleanSpoken(text: string): string {
  return text.replace(/<\/?[A-Za-z][\w .'-]{0,40}>/g, "").replace(/\s{2,}/g, " ").trim();
}

async function fetchToken(): Promise<string> {
  const res = await fetch("/api/voice-token", { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Couldn't start the call");
  return body.token;
}

export function VoiceCall({ state, dispatch, hasToken, autoStart, runTool, onConnected, onTranscript, onEnded, onDecline, children }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const tokenRef = useRef<Promise<string> | null>(null);
  const endedRef = useRef(true);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const finish = (reason: string) => {
    if (endedRef.current) return; // onError and onDisconnect can both fire
    endedRef.current = true;
    devlog("voice", `Call ended: ${reason}`);
    dispatch({ type: "callEnded", reason });
    onEnded(reason);
  };

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      devlog("voice", "Connected", { conversationId });
      setConnectedAt(Date.now());
      dispatch({ type: "callActive" });
      onConnected();
    },
    onDisconnect: (details) => {
      devlog("voice", `Disconnected (${details.reason})`, details);
      finish(describeDisconnect(details));
    },
    onMessage: ({ role, message: raw }) => {
      const message = cleanSpoken(raw);
      if (!message) return;
      devlog("voice", `🎙 ${role === "user" ? "user" : (stateRef.current.agentName ?? "agent")} (spoken): ${message}`);
      setLines((prev) => [...prev.slice(-2), { role, text: message }]);
      onTranscript(role, message);
    },
    onError: (message) => {
      // Start failures (mic denied, bad token) only surface here, never via onDisconnect.
      const reason = failureReason(message);
      setError(reason);
      finish(reason);
    },
  });

  // Thin wrappers: every tool runs the same shared implementation as the chat
  // (Onboarding's runTool). Names must match the client tools on the ElevenLabs
  // agent (docs/VOICE_AGENT.md). Params arrive untyped, so runTool coerces them.
  const tool = (name: string) => (params: Record<string, unknown>) => {
    devlog("tool", `voice → ${name}`, params);
    return runTool(name, params, "voice");
  };
  useConversationClientTool("setAgentName", tool("setAgentName"));
  useConversationClientTool("setUserName", tool("setUserName"));
  useConversationClientTool("setUserEmail", tool("setUserEmail"));
  useConversationClientTool("setHelpNeed", tool("setHelpNeed"));
  useConversationClientTool("showGmailButton", tool("showGmailButton"));
  useConversationClientTool("declineGmail", tool("declineGmail"));
  useConversationClientTool("graduate", tool("graduate"));
  useConversationClientTool("summarizeInbox", tool("summarizeInbox"));
  useConversationClientTool("findEmails", tool("findEmails"));
  useConversationClientTool("readEmail", tool("readEmail"));
  useConversationClientTool("showDraft", tool("showDraft"));
  useConversationClientTool("saveDraft", tool("saveDraft"));

  // Prefetch the token while ringing so "Answer" starts audio inside the click
  // gesture — Safari won't unlock audio after an extra network round trip.
  const ringing = state.call.status === "idle" || state.call.status === "ended";
  useEffect(() => {
    if (ringing) tokenRef.current = fetchToken().catch(() => null as unknown as string);
  }, [ringing]);

  const answer = async () => {
    setError(null);
    const snapshot = stateRef.current;
    endedRef.current = false;
    dispatch({ type: "callConnecting" });
    try {
      const token = (await tokenRef.current) || (await fetchToken());
      tokenRef.current = null; // single-use
      const knownInfo = voiceContext(snapshot, hasToken);
      devlog("voice", `Dialing (attempt ${snapshot.call.attempts + 1})`, {
        firstMessage: voiceFirstMessage(snapshot),
        known_info: knownInfo,
      });
      conversation.startSession({
        conversationToken: token,
        connectionType: "webrtc",
        // The system prompt lives in the ElevenLabs dashboard (docs/VOICE_AGENT.md);
        // we fill its variables and pick a greeting that fits what's already known.
        dynamicVariables: {
          agent_name: snapshot.agentName ?? UNNAMED_AGENT,
          known_info: knownInfo,
        },
        overrides: { agent: { firstMessage: voiceFirstMessage(snapshot) } },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const reason = failureReason(message);
      setError(reason);
      finish(reason);
    }
  };

  // Dialed from a click: start right away (the token prefetch above is already in flight).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void answer();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  const live = conversation.status === "connected" || conversation.status === "connecting";
  const dialing = !live && state.call.status === "connecting";
  const agentName = state.agentName ?? "Your new assistant";

  let status: ReactNode;
  if (conversation.status === "connected") {
    status = (
      <>
        {conversation.isSpeaking ? `${agentName} is speaking` : "Listening…"}
        {connectedAt && (
          <>
            {" · "}
            <CallTimer since={connectedAt} />
          </>
        )}
      </>
    );
  } else if (live || dialing || autoStart) {
    status = "Calling…";
  } else {
    status = "Incoming call";
  }

  return (
    <div className="h-full w-full py-4 lg:py-6 flex flex-col items-center gap-4 lg:gap-6 text-center overflow-y-auto">
      <div className="flex-1 w-full flex flex-col items-center justify-center gap-5">
        <div
          className={`size-28 rounded-full flex items-center justify-center display text-4xl transition-all duration-300 ${
            conversation.isSpeaking
              ? "bg-imgreen/20 ring-8 ring-imgreen/10 scale-105"
              : live
                ? "bg-surface border border-hairline"
                : "bg-surface border border-hairline animate-pulse"
          }`}
        >
          {state.agentName ? state.agentName.charAt(0).toUpperCase() : "✦"}
        </div>
        <div>
          <p className="display text-[28px]">{agentName}</p>
          <p className="text-sm text-muted tabular-nums">{status}</p>
        </div>

        <div className="min-h-24 w-full flex flex-col justify-end gap-1.5 text-sm" aria-live="polite">
          {lines.map((l, i) => (
            <p key={i} className={l.role === "user" ? "text-muted" : ""}>
              {l.role === "user" ? "You: " : ""}
              {l.text}
            </p>
          ))}
        </div>

        {children}
      </div>

      {live || dialing || autoStart ? (
        <button
          onClick={() => (live ? conversation.endSession() : finish("the user hung up before it connected"))}
          className="rounded-full bg-red-600 text-white px-8 py-3 font-medium"
        >
          Hang up
        </button>
      ) : (
        <div className="flex gap-3">
          <button onClick={onDecline} className="pill px-5 py-3">
            Keep texting
          </button>
          <button onClick={answer} className="rounded-full bg-imgreen text-white px-8 py-3 font-medium">
            Answer
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  return <>{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`}</>;
}
