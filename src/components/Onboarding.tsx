"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useConversationControls, useConversationStatus } from "@elevenlabs/react";
import { describeState, missingSlots, reducer, saveState, type Action, type OnboardingState } from "@/lib/onboarding";
import { fetchRecentMail, loadGis, requestGmailToken } from "@/lib/gmail";
import type { ChatMessage } from "@/lib/tools";
import { devlog } from "@/lib/devlog";
import { VoiceCall } from "./VoiceCall";

const MESSAGES_KEY = "persona-onboarding-messages-v1";

export function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveMessages(messages: ChatMessage[]) {
  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  } catch {}
}

type TextField = "agentName" | "userName" | "helpNeed";

const FIELD_ACTION = { agentName: "setAgentName", userName: "setUserName", helpNeed: "setHelpNeed" } as const;
const FIELD_LABEL = { agentName: "a name for you", userName: "their name", helpNeed: "what they need help with" };

export function Onboarding({
  initialState,
  initialMessages,
  onReset,
}: {
  initialState: OnboardingState;
  initialMessages: ChatMessage[];
  onReset: () => void;
}) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  // Every state change, from any source (chat tool, voice tool, typed field), lands in the dev log.
  const dispatch = useCallback((action: Action) => {
    const { type, ...rest } = action;
    devlog("state", type, Object.keys(rest).length ? rest : undefined);
    rawDispatch(action);
  }, []);
  // Callbacks (tool handlers, transport body) run outside render and need the latest state.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  // "dial": the user tapped Call, connect now. "ring": the text agent offered a call.
  const [call, setCall] = useState<null | "dial" | "ring">(null);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const voice = useConversationControls();
  const { status: voiceStatus } = useConversationStatus();

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
    onError: (e) => devlog("error", `Chat: ${e.message}`),
    onFinish: ({ message, isError, isAbort }) => {
      const text = messageText(message);
      if (text) devlog("chat", `${stateRef.current.agentName ?? "assistant"}: ${text}`);
      if (isError || isAbort) devlog("error", `Chat response ${isError ? "errored" : "aborted"}`);
    },
    onToolCall({ toolCall }): void {
      if (toolCall.dynamic) return;
      devlog("tool", `chat → ${toolCall.toolName}`, toolCall.input);
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
          setCall("ring");
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
  const callOpen = call !== null || inCall;
  // Read from the ref after awaits: the call may have started/ended during the Gmail popup.
  const callLive = () => ["active", "connecting"].includes(stateRef.current.call.status);
  const busy = status === "submitted" || status === "streaming";

  // Hidden note that nudges the text agent after something happens outside the chat.
  const sendEvent = (text: string) => {
    if (stateRef.current.graduated) return;
    devlog("chat", `event → chat agent: ${text}`);
    sendMessage({ text: `[Event] ${text}`, metadata: { hidden: true } });
  };

  // Tell whichever agent is active about something that happened on screen.
  const notifyAgents = (text: string, { chat }: { chat: boolean }) => {
    if (voiceStatus === "connected") {
      devlog("voice", `context update → voice agent: ${text}`);
      voice.sendContextualUpdate(text);
    }
    else if (chat && !callLive()) sendEvent(text);
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
    setCall(null);
    const s = stateRef.current;
    if (s.graduated) return;
    sendEvent(
      `The voice call ended: ${reason}. Continue here in text with whatever is still missing` +
        (missingSlots(s).length ? "." : ", or wrap up and graduate."),
    );
  };

  // Typed straight into a field: no chat event needed (the next chat turn sees the
  // state), but a live voice agent should hear about it.
  const editField = (field: TextField, value: string) => {
    const v = value.trim();
    if (!v || v === stateRef.current[field]) return;
    apply({ type: FIELD_ACTION[field], value: v });
    notifyAgents(`The user just typed ${FIELD_LABEL[field]} on screen: "${v}". Treat it as confirmed; don't ask again.`, {
      chat: false,
    });
  };

  const connectGmail = async () => {
    setGmailError(null);
    setGmailBusy(true);
    devlog("gmail", "Google popup opened");
    try {
      const token = await requestGmailToken();
      const mail = await fetchRecentMail(token);
      devlog("gmail", `Authorized ${mail.email}; read ${mail.messages.length} message headers`);
      let insights: string[] = [];
      try {
        const res = await fetch("/api/insights", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: mail.messages, helpNeed: stateRef.current.helpNeed }),
        });
        if (res.ok) insights = (await res.json()).insights;
        else devlog("error", `Insights: HTTP ${res.status}`);
      } catch (e) {
        // Insights are a bonus; a connected inbox is what counts.
        devlog("error", `Insights: ${e instanceof Error ? e.message : String(e)}`);
      }
      devlog("gmail", `Inbox ideas: ${insights.length}`, insights);
      dispatch({ type: "gmail", value: { status: "connected", email: mail.email, insights } });
      // During a call, VoiceCall pushes a contextual update to the voice agent instead.
      if (!callLive()) {
        sendEvent(
          `Gmail connected (${mail.email}).` + (insights.length ? ` Ideas from their inbox: ${insights.join("; ")}` : ""),
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      devlog("error", `Gmail: ${message}`);
      setGmailError(message);
      notifyAgents(`Gmail connection didn't go through (${message}). Reassure them; they can retry or skip.`, { chat: true });
    } finally {
      setGmailBusy(false);
    }
  };

  const declineGmail = () => {
    dispatch({ type: "gmail", value: { status: "declined" } });
    notifyAgents("The user clicked 'Not now' on the Gmail button.", { chat: true });
  };

  const finish = () => {
    if (callLive()) voice.endSession();
    dispatch({ type: "graduate" });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    devlog("chat", `user: ${text}`);
    sendMessage({ text });
    setInput("");
  };

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, state.gmail.status]);

  if (state.graduated && !inCall) {
    // The graduate tool fires before the reply streams in, so keep showing that reply here.
    const last = messages.at(-1);
    const farewell = last?.role === "assistant" && !last.metadata?.hidden ? messageText(last) : "";
    return <Graduated state={state} farewell={farewell} onReset={onReset} />;
  }

  const agent = state.agentName ?? "your assistant";
  const visibleMessages = messages.filter((m) => !m.metadata?.hidden && messageText(m));
  const gmailCard =
    state.gmail.status === "offered" ? (
      <GmailCard busy={gmailBusy} error={gmailError} onConnect={connectGmail} onDecline={declineGmail} />
    ) : null;

  return (
    <div className="mx-auto w-full max-w-5xl min-h-dvh md:h-dvh px-4 py-4 md:py-6 grid gap-4 md:gap-6 md:grid-cols-[300px_1fr]">
      <aside className="flex flex-col gap-4 md:overflow-y-auto">
        <ProfileCard
          state={state}
          inCall={inCall}
          gmailBusy={gmailBusy}
          gmailError={gmailError}
          onEdit={editField}
          onConnectGmail={connectGmail}
          onFinish={finish}
        />
        <HowItWorks />
        <button onClick={onReset} className="self-start text-xs opacity-50 hover:opacity-100">
          Start over
        </button>
      </aside>

      <section className="flex flex-col min-h-[70dvh] md:min-h-0 rounded-3xl border border-black/10 dark:border-white/15 px-4">
        {callOpen ? (
          <VoiceCall
            state={state}
            dispatch={dispatch}
            autoStart={call !== "ring"}
            onTranscript={appendVoiceTranscript}
            onEnded={onCallEnded}
            onDecline={() => {
              setCall(null);
              sendEvent("The user chose to keep texting instead of taking the call.");
            }}
          >
            {gmailCard}
          </VoiceCall>
        ) : (
          <>
            <main className="flex-1 overflow-y-auto flex flex-col gap-3 py-4">
              {visibleMessages.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-4">
                  <Avatar name={state.agentName} />
                  <h1 className="text-2xl font-semibold">
                    {state.agentName ? `Say hi to ${state.agentName}` : "Meet your new assistant"}
                  </h1>
                  <p className="opacity-60 max-w-sm">
                    Hop on a quick call, type below, or fill in the details on the left — whatever&apos;s easiest.
                  </p>
                  <button
                    onClick={() => setCall("dial")}
                    className="rounded-full bg-emerald-600 text-white px-8 py-3 font-medium hover:bg-emerald-700"
                  >
                    📞 {state.agentName ? `Call ${state.agentName}` : "Start a call"}
                  </button>
                </div>
              ) : (
                visibleMessages.map((m) => <Message key={m.id} message={m} />)
              )}
              {status === "submitted" && <p className="text-sm opacity-50">…</p>}
              {error && <p className="text-sm text-red-600">Something went wrong: {error.message}</p>}
              {gmailCard}
              <div ref={bottomRef} />
            </main>

            <form onSubmit={submit} className="py-4 flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={`Message ${agent}…`}
                className="flex-1 min-w-0 rounded-full border border-black/15 dark:border-white/20 bg-transparent px-4 py-2 outline-none"
              />
              {visibleMessages.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCall("dial")}
                  className="rounded-full border border-black/15 dark:border-white/20 px-3"
                  title={`Call ${agent}`}
                >
                  📞
                </button>
              )}
              <button disabled={busy} className="rounded-full bg-foreground text-background px-4 py-2 font-medium disabled:opacity-40">
                Send
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

function ProfileCard({
  state,
  inCall,
  gmailBusy,
  gmailError,
  onEdit,
  onConnectGmail,
  onFinish,
}: {
  state: OnboardingState;
  inCall: boolean;
  gmailBusy: boolean;
  gmailError: string | null;
  onEdit: (field: TextField, value: string) => void;
  onConnectGmail: () => void;
  onFinish: () => void;
}) {
  const complete = missingSlots(state).length === 0;
  return (
    <div className="rounded-3xl border border-black/10 dark:border-white/15 p-4 flex flex-col gap-3">
      <Field label="Assistant's name" value={state.agentName} placeholder="e.g. Nova" onCommit={(v) => onEdit("agentName", v)} />
      <Field label="Your name" value={state.userName} placeholder="What should they call you?" onCommit={(v) => onEdit("userName", v)} />
      <Field
        label="What you need help with"
        value={state.helpNeed}
        placeholder="e.g. chasing client replies"
        multiline
        onCommit={(v) => onEdit("helpNeed", v)}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium opacity-60">Gmail</span>
        {state.gmail.status === "connected" ? (
          <p key={state.gmail.email} className="flash text-sm rounded-xl px-3 py-2 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 truncate">
            ✓ {state.gmail.email ?? "Connected"}
          </p>
        ) : (
          <button
            onClick={onConnectGmail}
            disabled={gmailBusy}
            className={`text-sm rounded-xl px-3 py-2 text-left border transition-colors disabled:opacity-50 ${
              state.gmail.status === "offered"
                ? "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                : "border-black/10 dark:border-white/15 hover:border-blue-500"
            }`}
          >
            {gmailBusy ? "Connecting…" : state.gmail.status === "declined" ? "Skipped · connect anyway" : "Connect Gmail (read-only)"}
          </button>
        )}
        {gmailError && <p className="text-xs text-red-600">{gmailError}</p>}
      </div>
      <button
        onClick={onFinish}
        className={`mt-1 rounded-full px-4 py-2 text-sm font-medium ${
          complete ? "bg-foreground text-background" : "border border-black/15 dark:border-white/20 opacity-70 hover:opacity-100"
        }`}
      >
        {complete ? "Finish setup →" : inCall ? "Skip ahead (ends call) →" : "Skip ahead →"}
      </button>
    </div>
  );
}

// Uncontrolled + keyed by value: remounts (and flashes) when an agent fills it in,
// without fighting the user's typing otherwise.
function Field({
  label,
  value,
  placeholder,
  multiline,
  onCommit,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  multiline?: boolean;
  onCommit: (value: string) => void;
}) {
  const className = `${value ? "flash" : ""} w-full rounded-xl border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500`;
  const commit = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => onCommit(e.currentTarget.value);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium opacity-60">{label}</span>
      {multiline ? (
        <textarea key={value ?? ""} defaultValue={value ?? ""} placeholder={placeholder} rows={2} onBlur={commit} className={`${className} resize-none`} />
      ) : (
        <input
          key={value ?? ""}
          defaultValue={value ?? ""}
          placeholder={placeholder}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className={className}
        />
      )}
    </label>
  );
}

function HowItWorks() {
  return (
    <div className="text-xs opacity-60 flex flex-col gap-1.5 px-1">
      <p className="font-medium">How it works</p>
      <p>Your assistant needs a name, your name, what you&apos;d like help with, and (optionally) Gmail.</p>
      <p>Fill them in any way you like: type in the fields, chat, or talk on a call. Fields update live as it listens.</p>
      <p>Hang up anytime — the chat picks up where the call left off. Gmail connects via a Google popup, read-only.</p>
      <p>Know what you want already? Skip ahead.</p>
    </div>
  );
}

function GmailCard({
  busy,
  error,
  onConnect,
  onDecline,
}: {
  busy: boolean;
  error: string | null;
  onConnect: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="w-full rounded-2xl border border-blue-500/40 bg-blue-500/5 p-4 flex flex-col gap-3 text-left">
      <p className="text-sm">Connect Gmail so I can spot things to take off your plate. Read-only — I can&apos;t send anything.</p>
      <div className="flex gap-2">
        <button onClick={onConnect} disabled={busy} className="rounded-full bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy ? "Connecting…" : "Connect Gmail"}
        </button>
        <button onClick={onDecline} className="rounded-full px-4 py-2 text-sm opacity-60">
          Not now
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function Avatar({ name }: { name: string | null }) {
  return (
    <div className="size-20 rounded-full bg-emerald-500/15 flex items-center justify-center text-3xl font-semibold">
      {name ? name.charAt(0).toUpperCase() : "✦"}
    </div>
  );
}

function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();
}

function Message({ message }: { message: ChatMessage }) {
  const text = messageText(message);
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

function Graduated({ state, farewell, onReset }: { state: OnboardingState; farewell: string; onReset: () => void }) {
  return (
    <div className="mx-auto max-w-xl w-full px-4 py-16 flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">You&apos;re all set{state.userName ? `, ${state.userName}` : ""} 🎉</h1>
      {farewell && (
        <div className="rounded-2xl px-4 py-3 bg-black/5 dark:bg-white/10 whitespace-pre-wrap">
          <p className="text-xs opacity-60 mb-1">{state.agentName ?? "Your assistant"}</p>
          {farewell}
        </div>
      )}
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
