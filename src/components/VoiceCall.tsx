"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch } from "react";
import {
  useConversation,
  useConversationClientTool,
  type DisconnectionDetails,
} from "@elevenlabs/react";
import { describeState, reducer, type Action, type OnboardingState } from "@/lib/onboarding";
import { voiceFirstMessage } from "@/lib/prompts";

interface Props {
  state: OnboardingState;
  dispatch: Dispatch<Action>;
  onTranscript: (role: "user" | "agent", text: string) => void;
  onEnded: (reason: string) => void;
  onDecline: () => void;
}

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
  console.error("[voice] call failed:", message);
  return /NotAllowedError|Permission denied|microphone/i.test(message)
    ? "microphone access was blocked"
    : "the call couldn't connect";
}

async function fetchToken(): Promise<string> {
  const res = await fetch("/api/voice-token", { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Couldn't start the call");
  return body.token;
}

export function VoiceCall({ state, dispatch, onTranscript, onEnded, onDecline }: Props) {
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<Promise<string> | null>(null);
  const endedRef = useRef(true);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const finish = (reason: string) => {
    if (endedRef.current) return; // onError and onDisconnect can both fire
    endedRef.current = true;
    dispatch({ type: "callEnded", reason });
    onEnded(reason);
  };

  const conversation = useConversation({
    onConnect: () => dispatch({ type: "callActive" }),
    onDisconnect: (details) => finish(describeDisconnect(details)),
    onMessage: ({ role, message }) => onTranscript(role, message),
    onError: (message) => {
      // Start failures (mic denied, bad token) only surface here, never via onDisconnect.
      const reason = failureReason(message);
      setError(reason);
      finish(reason);
    },
  });

  // Apply the action locally too, so the tool result tells the agent the
  // updated picture immediately (React state won't have re-rendered yet).
  const apply = (action: Action) => {
    dispatch(action);
    stateRef.current = reducer(stateRef.current, action);
    return describeState(stateRef.current);
  };

  // Names must match the client tools configured on the ElevenLabs agent (docs/SETUP.md).
  // Params arrive untyped from the LLM, so coerce rather than trust them.
  useConversationClientTool("setUserName", (p) => `Saved.\n${apply({ type: "setUserName", value: String(p.name ?? "") })}`);
  useConversationClientTool("setHelpNeed", (p) => `Saved.\n${apply({ type: "setHelpNeed", value: String(p.need ?? "") })}`);
  useConversationClientTool("showGmailButton", () => {
    apply({ type: "gmail", value: { status: "offered" } });
    return "A 'Connect Gmail' button is now visible on the user's screen. Keep talking; you'll get an update when it's connected.";
  });
  useConversationClientTool("graduate", () => {
    apply({ type: "graduate" });
    return "Onboarding complete. Say a short, warm goodbye, then end the call.";
  });

  // Gmail connects via a popup while the call keeps running — tell the agent.
  const sentGmailUpdate = useRef(false);
  useEffect(() => {
    if (conversation.status !== "connected" || state.gmail.status !== "connected" || sentGmailUpdate.current) return;
    sentGmailUpdate.current = true;
    conversation.sendContextualUpdate(
      `Gmail is now connected (${state.gmail.email ?? "unknown address"}).` +
        (state.gmail.insights?.length ? ` Ideas from their inbox: ${state.gmail.insights.join("; ")}` : ""),
    );
  }, [conversation, state.gmail]);

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
    sentGmailUpdate.current = snapshot.gmail.status === "connected";
    dispatch({ type: "callConnecting" });
    try {
      const token = (await tokenRef.current) || (await fetchToken());
      tokenRef.current = null; // single-use
      conversation.startSession({
        conversationToken: token,
        connectionType: "webrtc",
        // The system prompt lives in the ElevenLabs dashboard (docs/VOICE_AGENT.md);
        // we only fill its variables, plus a tailored greeting for callbacks.
        dynamicVariables: {
          agent_name: snapshot.agentName ?? "your assistant",
          known_info: describeState(snapshot),
        },
        ...(snapshot.call.attempts > 0 && {
          overrides: { agent: { firstMessage: voiceFirstMessage(snapshot) } },
        }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const reason = failureReason(message);
      setError(reason);
      finish(reason);
    }
  };

  const live = conversation.status === "connected" || conversation.status === "connecting";

  return (
    <div className="rounded-2xl border border-black/10 dark:border-white/15 p-5 flex flex-col items-center gap-4 text-center">
      <div
        className={`size-20 rounded-full flex items-center justify-center text-3xl transition-all ${
          conversation.isSpeaking ? "bg-emerald-500/30 scale-110" : live ? "bg-emerald-500/15" : "bg-black/5 dark:bg-white/10 animate-pulse"
        }`}
      >
        📞
      </div>
      <div>
        <p className="font-medium">{state.agentName ?? "Your assistant"}</p>
        <p className="text-sm opacity-60">
          {conversation.status === "connecting"
            ? "Connecting…"
            : conversation.status === "connected"
              ? conversation.isSpeaking
                ? "Speaking…"
                : "Listening…"
              : "Incoming call"}
        </p>
      </div>

      {live ? (
        <button
          onClick={() => conversation.endSession()}
          className="rounded-full bg-red-600 text-white px-6 py-2 font-medium"
        >
          Hang up
        </button>
      ) : (
        <div className="flex gap-3">
          <button onClick={onDecline} className="rounded-full border border-black/15 dark:border-white/20 px-5 py-2">
            Keep texting
          </button>
          <button onClick={answer} className="rounded-full bg-emerald-600 text-white px-6 py-2 font-medium">
            Answer
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
