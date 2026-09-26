"use client";

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { ConversationProvider } from "@elevenlabs/react";
import { describeState, missingSlots, reducer, saveState, type Action, type OnboardingState } from "@/lib/onboarding";
import { fetchRecentMail, loadGis, requestGmailToken } from "@/lib/gmail";
import type { ChatMessage } from "@/lib/tools";
import { VoiceCall } from "./VoiceCall";

const MESSAGES_KEY = "persona-onboarding-messages-v1";

export const GREETING: ChatMessage = {
  id: "greeting",
  role: "assistant",
  parts: [
    {
      type: "text",
      text: "Hey! 👋 I'm your new personal assistant — I just got here and don't even have a name yet. What would you like to call me?",
    },
  ],
};

export function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    return raw ? JSON.parse(raw) : [GREETING];
  } catch {
    return [GREETING];
  }
}

function saveMessages(messages: ChatMessage[]) {
  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  } catch {}
}

export function Onboarding({
  initialState,
  initialMessages,
  onReset,
}: {
  initialState: OnboardingState;
  initialMessages: ChatMessage[];
  onReset: () => void;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Callbacks (tool handlers, transport body) run outside render and need the latest state.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [showCall, setShowCall] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    saveState(state);
  }, [state]);
  useEffect(() => {
    loadGis().catch(() => {});
  }, []);

  // Same trick as VoiceCall: return the post-update state to the model at once.
  const apply = (action: Action) => {
    dispatch(action);
    stateRef.current = reducer(stateRef.current, action);
    return describeState(stateRef.current);
  };

  // Function body → evaluated per request, so tool-result resends also carry fresh state.
  const transport = useMemo(
    // eslint-disable-next-line react-hooks/refs -- the ref is read lazily per request, not during render
    () => new DefaultChatTransport<ChatMessage>({ api: "/api/chat", body: () => ({ onboardingState: stateRef.current }) }),
    [],
  );

  const { messages, setMessages, sendMessage, addToolOutput, status, error } = useChat<ChatMessage>({
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall({ toolCall }): void {
      if (toolCall.dynamic) return;
      const done = (output: string): void => {
        // Not awaited — awaiting inside onToolCall can deadlock the chat.
        void addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output });
      };

      switch (toolCall.toolName) {
        case "setAgentName":
          return done(apply({ type: "setAgentName", value: toolCall.input.name }));
        case "setUserName":
          return done(apply({ type: "setUserName", value: toolCall.input.name }));
        case "setHelpNeed":
          return done(apply({ type: "setHelpNeed", value: toolCall.input.need }));
        case "requestGmailConnect":
          apply({ type: "gmail", value: { status: "offered" } });
          return done("The Connect Gmail button is now showing.");
        case "declineGmail":
          return done(apply({ type: "gmail", value: { status: "declined" } }));
        case "startCall":
          setShowCall(true);
          return done("The incoming-call screen is showing; the user can answer or keep texting.");
        case "graduate":
          apply({ type: "graduate" });
          return done("Onboarding complete.");
      }
    },
  });

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  const inCall = state.call.status === "active" || state.call.status === "connecting";
  // Read from the ref after awaits: the call may have started/ended during the Gmail popup.
  const callLive = () => ["active", "connecting"].includes(stateRef.current.call.status);
  const busy = status === "submitted" || status === "streaming";

  // Hidden note that nudges the text agent after something happens outside the chat.
  const sendEvent = (text: string) => {
    if (stateRef.current.graduated) return;
    sendMessage({ text: `[Event] ${text}`, metadata: { hidden: true } });
  };

  const appendVoiceTranscript = (role: "user" | "agent", text: string) =>
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: role === "user" ? "user" : "assistant",
        parts: [{ type: "text", text }],
        metadata: { channel: "voice" },
      },
    ]);

  const onCallEnded = (reason: string) => {
    setShowCall(false);
    const s = stateRef.current;
    if (s.graduated) return;
    sendEvent(
      `The voice call ended: ${reason}. Continue here in text with whatever is still missing` +
        (missingSlots(s).length ? "." : ", or wrap up and graduate."),
    );
  };

  const connectGmail = async () => {
    setGmailError(null);
    try {
      const token = await requestGmailToken();
      const mail = await fetchRecentMail(token);
      let insights: string[] = [];
      try {
        const res = await fetch("/api/insights", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: mail.messages, helpNeed: stateRef.current.helpNeed }),
        });
        if (res.ok) insights = (await res.json()).insights;
      } catch {
        // Insights are a bonus; a connected inbox is what counts.
      }
      dispatch({ type: "gmail", value: { status: "connected", email: mail.email, insights } });
      // During a call, VoiceCall pushes a contextual update to the voice agent instead.
      if (!callLive()) {
        sendEvent(
          `Gmail connected (${mail.email}).` + (insights.length ? ` Ideas from their inbox: ${insights.join("; ")}` : ""),
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setGmailError(message);
      if (!callLive()) sendEvent(`Gmail connection didn't go through (${message}). Reassure them; offer to retry or skip.`);
    }
  };

  const declineGmail = () => {
    dispatch({ type: "gmail", value: { status: "declined" } });
    if (!callLive()) sendEvent("The user clicked 'Not now' on the Gmail button.");
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    sendMessage({ text });
    setInput("");
  };

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, showCall, state.gmail.status]);

  if (state.graduated && !inCall) {
    return <Graduated state={state} onReset={onReset} />;
  }

  return (
    <ConversationProvider>
      <div className="mx-auto w-full max-w-xl flex flex-col h-dvh px-4">
        <header className="py-4 flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5 text-xs">
            <Chip done={!!state.agentName} label={state.agentName ?? "Assistant name"} />
            <Chip done={!!state.userName} label={state.userName ?? "Your name"} />
            <Chip done={state.gmail.status === "connected"} label={state.gmail.status === "declined" ? "Gmail skipped" : "Gmail"} />
            <Chip done={!!state.helpNeed} label="Goal" />
          </div>
          <button onClick={onReset} className="text-xs opacity-50 hover:opacity-100 shrink-0">
            Start over
          </button>
        </header>

        <main className="flex-1 overflow-y-auto flex flex-col gap-3 pb-4">
          {messages.map((m) => (
            <Message key={m.id} message={m} />
          ))}
          {status === "submitted" && <p className="text-sm opacity-50">…</p>}
          {error && <p className="text-sm text-red-600">Something went wrong: {error.message}</p>}

          {state.gmail.status === "offered" && (
            <div className="rounded-2xl border border-black/10 dark:border-white/15 p-4 flex flex-col gap-3">
              <p className="text-sm">Connect Gmail so I can spot things I can take off your plate. Read-only — I can&apos;t send anything.</p>
              <div className="flex gap-2">
                <button onClick={connectGmail} className="rounded-full bg-blue-600 text-white px-4 py-2 text-sm font-medium">
                  Connect Gmail
                </button>
                <button onClick={declineGmail} className="rounded-full px-4 py-2 text-sm opacity-60">
                  Not now
                </button>
              </div>
              {gmailError && <p className="text-sm text-red-600">{gmailError}</p>}
            </div>
          )}

          {(showCall || inCall) && (
            <VoiceCall
              state={state}
              dispatch={dispatch}
              onTranscript={appendVoiceTranscript}
              onEnded={onCallEnded}
              onDecline={() => {
                setShowCall(false);
                sendEvent("The user chose to keep texting instead of taking the call.");
              }}
            />
          )}
          <div ref={bottomRef} />
        </main>

        <form onSubmit={submit} className="py-4 flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={inCall}
            placeholder={inCall ? "On a call — hang up to type" : "Message…"}
            className="flex-1 rounded-full border border-black/15 dark:border-white/20 bg-transparent px-4 py-2 outline-none disabled:opacity-50"
          />
          {state.agentName && !inCall && !showCall && (
            <button type="button" onClick={() => setShowCall(true)} className="rounded-full border border-black/15 dark:border-white/20 px-3" title="Call">
              📞
            </button>
          )}
          <button disabled={busy || inCall} className="rounded-full bg-foreground text-background px-4 py-2 font-medium disabled:opacity-40">
            Send
          </button>
        </form>
      </div>
    </ConversationProvider>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.metadata?.hidden) return null;
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
  if (!text) return null;
  const mine = message.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2 whitespace-pre-wrap ${
          mine ? "bg-blue-600 text-white" : "bg-black/5 dark:bg-white/10"
        }`}
      >
        {message.metadata?.channel === "voice" && <span className="mr-1 opacity-60">🎙️</span>}
        {text}
      </div>
    </div>
  );
}

function Chip({ done, label }: { done: boolean; label: string }) {
  return (
    <span className={`rounded-full px-2.5 py-1 border ${done ? "border-emerald-500 text-emerald-700 dark:text-emerald-400" : "border-black/10 dark:border-white/15 opacity-60"}`}>
      {done ? "✓ " : ""}
      {label}
    </span>
  );
}

function Graduated({ state, onReset }: { state: OnboardingState; onReset: () => void }) {
  return (
    <div className="mx-auto max-w-xl w-full px-4 py-16 flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">You&apos;re all set{state.userName ? `, ${state.userName}` : ""} 🎉</h1>
      <p className="opacity-70">
        {state.agentName ?? "Your assistant"} is ready to help
        {state.helpNeed ? ` with: ${state.helpNeed}` : "."}
      </p>
      {state.gmail.insights?.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">From your inbox, I can start on:</p>
          <ul className="list-disc pl-5 text-sm opacity-80">
            {state.gmail.insights.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <button onClick={onReset} className="self-start text-sm underline opacity-60">
        Start over
      </button>
    </div>
  );
}
