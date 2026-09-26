"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useConversationControls, useConversationStatus } from "@elevenlabs/react";
import {
  describeState,
  mailAccess,
  missingSlots,
  normalizeEmail,
  reducer,
  saveState,
  type Action,
  type OnboardingState,
} from "@/lib/onboarding";
import {
  COMPOSE,
  createDraft,
  fetchRecentMail,
  getCachedToken,
  getProfileEmail,
  loadGis,
  requestGmailToken,
  tokenStore,
  type Draft,
} from "@/lib/gmail";
import { findEmails, prepareDraft, readEmail, summarizePeriod, type Detail, type MailResult } from "@/lib/mailCommands";
import type { ChatMessage } from "@/lib/tools";
import { devlog } from "@/lib/devlog";
import { VoiceCall } from "./VoiceCall";

const MESSAGES_KEY = "persona-onboarding-messages-v1";
const MAIL_TOOLS = new Set(["tool-summarizeInbox", "tool-findEmails", "tool-readEmail"]);

export function loadMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// Email contents stay out of localStorage: large mail tool outputs are replaced.
function saveMessages(messages: ChatMessage[]) {
  const slim = messages.map((m) => ({
    ...m,
    parts: m.parts.map((p) =>
      MAIL_TOOLS.has(p.type) && "output" in p && typeof p.output === "string" && p.output.length > 300
        ? { ...p, output: "[email content omitted]" }
        : p,
    ),
  }));
  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(slim));
  } catch {}
}

type TextField = "agentName" | "userName" | "userEmail" | "helpNeed";

const FIELD_LABEL: Record<TextField, string> = {
  agentName: "a name for you",
  userName: "their name",
  userEmail: "their email",
  helpNeed: "what they need help with",
};

type DraftItem = Draft & { status: "idle" | "saving" | "saved" | "error"; error?: string };

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
  const [needReconnect, setNeedReconnect] = useState(false);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const voice = useConversationControls();
  const { status: voiceStatus } = useConversationStatus();
  // Re-render when a Gmail token is granted or dropped (tokens live in memory only).
  useSyncExternalStore(tokenStore.subscribe, tokenStore.getSnapshot, tokenStore.getSnapshot);
  const hasToken = !!getCachedToken();
  const access = mailAccess(state, hasToken);

  useEffect(() => {
    saveState(state);
  }, [state]);
  useEffect(() => {
    loadGis().catch(() => {});
  }, []);

  // Apply locally too, so a tool result reports the updated picture immediately.
  const apply = (action: Action) => {
    dispatch(action);
    stateRef.current = reducer(stateRef.current, action);
    return describeState(stateRef.current);
  };

  // ---- One implementation per capability; chat and voice both call runTool ----

  const handleMail = (r: MailResult) => {
    if (r.needs === "connect" && stateRef.current.gmail.status !== "connected") apply({ type: "gmail", value: { status: "offered" } });
    if (r.needs === "reconnect") setNeedReconnect(true);
    const draft = r.draft;
    if (draft) setDrafts((d) => [...d, { ...draft, status: "idle" }]);
    return r.text;
  };

  const runTool = async (name: string, input: Record<string, unknown>, detail: Detail): Promise<string> => {
    const str = (k: string) => String(input[k] ?? "").trim();
    const ctx = { gmailConnected: stateRef.current.gmail.status === "connected", detail };
    const setText = (type: "setAgentName" | "setUserName" | "setHelpNeed", key: string) =>
      str(key) ? apply({ type, value: str(key) }) : "Empty value, ask again.";

    switch (name) {
      case "setAgentName":
        return setText("setAgentName", "name");
      case "setUserName":
        return setText("setUserName", "name");
      case "setHelpNeed":
        return setText("setHelpNeed", "need");
      case "setUserEmail": {
        const email = normalizeEmail(str("email"));
        if (!email) {
          devlog("state", `setUserEmail rejected: invalid format`);
          return `Not a valid email: '${str("email")}'. Ask them to spell it.`;
        }
        const s = stateRef.current;
        if (s.userEmailSource === "google" && email !== s.userEmail) {
          return `Their connected Gmail (${s.userEmail}) is used and wins over '${email}'. Mention it once.`;
        }
        return apply({ type: "setUserEmail", value: email, source: "user" });
      }
      case "requestGmailConnect":
      case "showGmailButton":
        if (stateRef.current.gmail.status === "connected") {
          if (getCachedToken()) return "Gmail is already connected.";
          setNeedReconnect(true);
          return "A Reconnect Gmail button is now showing (access expired this session).";
        }
        apply({ type: "gmail", value: { status: "offered" } });
        return "A 'Connect Gmail' button is now showing on screen; the user clicks it in the browser.";
      case "declineGmail":
        return apply({ type: "gmail", value: { status: "declined" } });
      case "startCall":
        setCall("ring");
        return "The incoming-call screen is showing; the user can answer or keep texting.";
      case "graduate":
        apply({ type: "graduate" });
        return "Noted, no more setup questions. Keep helping.";
      case "summarizeInbox":
        return handleMail(await summarizePeriod({ after: str("after"), before: str("before") || undefined }, ctx));
      case "findEmails":
        return handleMail(await findEmails({ query: str("query") }, ctx));
      case "readEmail":
        return handleMail(await readEmail({ id: str("id") }, ctx));
      case "showDraft":
        return handleMail(await prepareDraft({ messageId: str("messageId"), body: String(input.body ?? "") }, ctx));
      default:
        devlog("error", `Unknown tool: ${name}`);
        return `Unknown tool ${name}.`;
    }
  };

  // Function body → evaluated per request, so tool-result resends also carry fresh state.
  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- the ref is read lazily per request, not during render
      new DefaultChatTransport<ChatMessage>({
        api: "/api/chat",
        body: () => ({
          onboardingState: stateRef.current,
          hasGmailToken: !!getCachedToken(),
          now: new Date().toString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        // Call dividers are display-only; keep them out of the model's history.
        prepareSendMessagesRequest: ({ id, messages, body, trigger, messageId }) => ({
          body: { ...body, id, trigger, messageId, messages: messages.filter((m) => !m.metadata?.divider) },
        }),
      }),
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
      // Not awaited — awaiting inside onToolCall can deadlock the chat.
      void runTool(toolCall.toolName, toolCall.input as Record<string, unknown>, "text")
        .then((output) => addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output }))
        .catch((e) =>
          addToolOutput({
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText: e instanceof Error ? e.message : String(e),
          }),
        );
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
    devlog("chat", `event → chat agent: ${text}`);
    sendMessage({ text: `[Event] ${text}`, metadata: { hidden: true } });
  };

  // Tell whichever agent is active about something that happened on screen.
  const notifyAgents = (text: string, { chat }: { chat: boolean }) => {
    if (voiceStatus === "connected") {
      devlog("voice", `context update → voice agent: ${text}`);
      voice.sendContextualUpdate(text);
    } else if (chat && !callLive()) sendEvent(text);
  };

  const askAssistant = (text: string) => {
    if (voiceStatus === "connected") {
      devlog("voice", `user (clicked): ${text}`);
      voice.sendUserMessage(text);
    } else if (!busy) {
      devlog("chat", `user (clicked): ${text}`);
      sendMessage({ text });
    }
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

  // Voice exchanges are marked in the transcript: a divider when the call
  // connects and when it ends, and a "voice" tag on every spoken line.
  const callStartedAt = useRef<number | null>(null);
  const appendDivider = (text: string) =>
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text }], metadata: { divider: true } },
    ]);

  const onCallConnected = () => {
    callStartedAt.current = Date.now();
    const at = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    appendDivider(`📞 Voice call with ${stateRef.current.agentName ?? "your assistant"} · ${at}`);
  };

  const onCallEnded = (reason: string) => {
    setCall(null);
    if (callStartedAt.current) {
      const secs = Math.round((Date.now() - callStartedAt.current) / 1000);
      appendDivider(`Call ended · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} · ${reason}`);
      callStartedAt.current = null;
    }
    sendEvent(`The voice call ended: ${reason}. Continue here in text.`);
  };

  // Typed straight into a field. Returns an error message, or null when saved.
  const editField = (field: TextField, raw: string): string | null => {
    let v = raw.trim();
    if (!v || v === stateRef.current[field]) return null;
    if (field === "userEmail") {
      const email = normalizeEmail(v);
      if (!email) return "That doesn't look like an email address.";
      if (stateRef.current.userEmailSource === "google") return "Your connected Gmail address is used.";
      v = email;
      apply({ type: "setUserEmail", value: v, source: "user" });
    } else {
      apply({ type: ({ agentName: "setAgentName", userName: "setUserName", helpNeed: "setHelpNeed" } as const)[field], value: v });
    }
    notifyAgents(`The user just typed ${FIELD_LABEL[field]} on screen: "${v}". Treat it as confirmed; don't ask again.`, {
      chat: false,
    });
    return null;
  };

  const connectGmail = async () => {
    const before = stateRef.current;
    // Popup first, synchronously inside the click — anything awaited before it gets blocked.
    const tokenP = requestGmailToken({ hint: before.userEmail });
    setGmailError(null);
    setGmailBusy(true);
    devlog("gmail", "Google popup opened");
    try {
      const token = await tokenP;
      setNeedReconnect(false);
      const email = (await getProfileEmail(token)).toLowerCase();
      devlog("gmail", `Authorized ${email}`);
      const mismatch =
        before.userEmail && before.userEmail !== email
          ? ` They'd given ${before.userEmail}; their Gmail is ${email}. Say (once) you'll use that.`
          : "";
      apply({ type: "setUserEmail", value: email, source: "google" });

      if (before.gmail.status === "connected") {
        apply({ type: "gmail", value: { email } });
        notifyAgents(`Gmail reconnected (${email}). If they were waiting on an email request, retry it now.${mismatch}`, { chat: true });
        return;
      }

      let insights: string[] = [];
      try {
        const mail = await fetchRecentMail(token);
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
      apply({ type: "gmail", value: { status: "connected", email, insights } });
      notifyAgents(
        `Gmail connected (${email}). Email help is now unlocked.` +
          (insights.length ? ` Ideas from their inbox: ${insights.join("; ")}` : "") +
          mismatch,
        { chat: true },
      );
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

  const updateDraft = (id: string, patch: Partial<DraftItem>) =>
    setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const saveDraft = async (d: DraftItem) => {
    // Compose scope is only requested here, on click — popup first.
    const tokenP = requestGmailToken({ scope: COMPOSE, hint: stateRef.current.userEmail });
    updateDraft(d.id, { status: "saving", error: undefined });
    try {
      await createDraft(await tokenP, d);
      updateDraft(d.id, { status: "saved" });
      devlog("gmail", `Draft saved to Gmail Drafts (reply to ${d.to.replace(/.*</, "<")})`);
      notifyAgents("The user saved the reply to their Gmail Drafts. It was NOT sent.", { chat: false });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      devlog("error", `Save draft: ${message}`);
      updateDraft(d.id, { status: "error", error: message });
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    devlog("chat", `user: ${text}`);
    sendMessage({ text });
    setInput("");
  };

  const prefill = (text: string) => {
    setInput(text);
    inputRef.current?.focus();
  };

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, state.gmail.status, drafts.length, needReconnect]);

  const agent = state.agentName ?? "your assistant";
  const visibleMessages = messages.filter((m) => !m.metadata?.hidden && messageText(m));
  const showReconnect = needReconnect && access === "expired";
  const gmailCard =
    state.gmail.status === "offered" || showReconnect ? (
      <GmailCard
        reconnect={showReconnect}
        busy={gmailBusy}
        error={gmailError}
        onConnect={connectGmail}
        onDecline={declineGmail}
      />
    ) : null;
  const draftCards = drafts.map((d) => (
    <DraftCard key={d.id} draft={d} onChange={(body) => updateDraft(d.id, { body, status: "idle" })} onSave={() => saveDraft(d)} />
  ));

  return (
    <div className="h-dvh flex flex-col">
      <header className="shrink-0 px-4 lg:px-5 py-2.5 lg:py-3 flex items-center gap-2">
        <span className="size-6 rounded-full border border-foreground/80 flex items-center justify-center text-[11px] font-semibold">P</span>
        <span className="display text-[17px]">Persona</span>
      </header>

      <div className="flex-1 min-h-0 mx-auto w-full max-w-7xl px-3 lg:px-4 pb-3 lg:pb-4 grid gap-3 lg:gap-6 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] lg:grid-rows-1 lg:grid-cols-[280px_minmax(0,1fr)_280px]">
        <aside className="flex flex-col gap-3 min-h-0 max-h-[55dvh] lg:max-h-none overflow-y-auto">
          <ProfileCard
            state={state}
            hasToken={hasToken}
            gmailBusy={gmailBusy}
            gmailError={gmailError}
            onEdit={editField}
            onConnectGmail={connectGmail}
          />
          <button onClick={onReset} className="hidden lg:block self-start px-1 text-xs text-muted hover:text-foreground">
            Start over
          </button>
        </aside>

        <section className="flex flex-col min-h-0 rounded-[28px] border border-hairline bg-background shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-4">
          {callOpen ? (
            <VoiceCall
              state={state}
              dispatch={dispatch}
              hasToken={hasToken}
              autoStart={call !== "ring"}
              runTool={runTool}
              onConnected={onCallConnected}
              onTranscript={appendVoiceTranscript}
              onEnded={onCallEnded}
              onDecline={() => {
                setCall(null);
                sendEvent("The user chose to keep texting instead of taking the call.");
              }}
            >
              {gmailCard}
              {draftCards.at(-1)}
            </VoiceCall>
          ) : (
            <>
              <main className="flex-1 overflow-y-auto flex flex-col gap-2 py-4">
                {visibleMessages.length === 0 && drafts.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-5 text-center px-4">
                    <Avatar name={state.agentName} />
                    <h1 className="display text-[40px] leading-[1.05] sm:text-[48px]">
                      {state.agentName ? (
                        <>Say hi to {state.agentName}</>
                      ) : (
                        <>
                          Your personal
                          <br />
                          intelligence
                        </>
                      )}
                    </h1>
                    <p className="text-muted max-w-sm text-[15px]">
                      Talk, text, or type, whatever&apos;s easiest. Ask for help right away and it learns the rest as you go.
                    </p>
                    <button onClick={() => setCall("dial")} className="pill px-6 py-3 flex items-center gap-2.5 text-[16px] shadow-sm">
                      <PhoneIcon />
                      {state.agentName ? `Call ${state.agentName}` : "Start a call"}
                    </button>
                  </div>
                ) : (
                  visibleMessages.map((m) => <Message key={m.id} message={m} />)
                )}
                {status === "submitted" && <TypingDots />}
                {error && <p className="text-sm text-red-600">Something went wrong: {error.message}</p>}
                {draftCards}
                {gmailCard}
                <div ref={bottomRef} />
              </main>

              <QuickActions access={access} onAsk={askAssistant} onPrefill={prefill} />
              <form onSubmit={submit} className="py-3 flex items-center gap-2 border-t border-hairline">
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={`Message ${agent}`}
                  className="flex-1 min-w-0 rounded-full border border-hairline bg-surface px-4 py-2.5 text-[15px] outline-none focus:border-imblue"
                />
                {visibleMessages.length > 0 && (
                  <button type="button" onClick={() => setCall("dial")} className="pill size-10 flex items-center justify-center" title={`Call ${agent}`}>
                    <PhoneIcon />
                  </button>
                )}
                <button
                  disabled={busy || !input.trim()}
                  aria-label="Send"
                  className="size-10 rounded-full bg-imblue text-white flex items-center justify-center disabled:opacity-30"
                >
                  ↑
                </button>
              </form>
            </>
          )}
        </section>

        <aside className="hidden lg:flex flex-col gap-4 overflow-y-auto">
          <HelpActions access={access} inCall={inCall} onAsk={askAssistant} onPrefill={prefill} />
          <HowItWorks />
        </aside>
      </div>
    </div>
  );
}

function ProfileCard({
  state,
  hasToken,
  gmailBusy,
  gmailError,
  onEdit,
  onConnectGmail,
}: {
  state: OnboardingState;
  hasToken: boolean;
  gmailBusy: boolean;
  gmailError: string | null;
  onEdit: (field: TextField, value: string) => string | null;
  onConnectGmail: () => void;
}) {
  const [emailError, setEmailError] = useState<string | null>(null);
  // Mobile: a one-line summary that expands. Desktop: always open.
  const [open, setOpen] = useState(false);
  const missing = missingSlots(state).length;
  const connected = state.gmail.status === "connected";
  return (
    <div className="rounded-[22px] lg:rounded-[28px] bg-surface p-3 lg:p-4 flex flex-col gap-3">
      <button onClick={() => setOpen((o) => !o)} className="px-1 flex items-center justify-between text-left lg:pointer-events-none">
        <span>
          <span className="display text-[17px]">Your Persona</span>
          <span className={`block text-xs ${missing === 0 ? "text-imgreen" : "text-muted"}`}>
            {missing === 0 ? "✓ All set. Change anything, anytime." : `${missing} detail${missing === 1 ? "" : "s"} left, or just ask for help.`}
          </span>
        </span>
        <span className="lg:hidden text-muted text-sm">{open ? "▴" : "▾"}</span>
      </button>
      <div className={`${open ? "flex" : "hidden"} lg:flex flex-col gap-3`}>
      <Field label="Assistant's name" value={state.agentName} placeholder="e.g. Nova" onCommit={(v) => onEdit("agentName", v)} />
      <Field label="Your name" value={state.userName} placeholder="What should it call you?" onCommit={(v) => onEdit("userName", v)} />
      <Field
        label={state.userEmailSource === "google" ? "Email · from Google" : "Email"}
        value={state.userEmail}
        placeholder="you@example.com"
        type="email"
        disabled={state.userEmailSource === "google"}
        error={emailError}
        onCommit={(v) => setEmailError(onEdit("userEmail", v))}
      />
      <Field
        label="What you need help with"
        value={state.helpNeed}
        placeholder="e.g. chasing client replies"
        multiline
        onCommit={(v) => onEdit("helpNeed", v)}
      />
      <div className="flex flex-col gap-1">
        <span className="px-1 text-xs text-muted">Gmail</span>
        {connected && hasToken ? (
          <p key={state.gmail.email} className="flash text-sm rounded-2xl px-3 py-2.5 bg-background text-imgreen">
            ✓ Connected
          </p>
        ) : (
          <button
            onClick={onConnectGmail}
            disabled={gmailBusy}
            className={`pill text-sm px-3 py-2.5 text-left disabled:opacity-50 ${
              state.gmail.status === "offered" || connected ? "!border-imblue text-imblue" : ""
            }`}
          >
            {gmailBusy
              ? "Connecting…"
              : connected
                ? "Reconnect Gmail"
                : state.gmail.status === "declined"
                  ? "Skipped · Connect anyway"
                  : "Connect Gmail"}
          </button>
        )}
        {gmailError && <p className="px-1 text-xs text-red-600">{gmailError}</p>}
      </div>
      </div>
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
  type = "text",
  disabled,
  error,
  onCommit,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  multiline?: boolean;
  type?: string;
  disabled?: boolean;
  error?: string | null;
  onCommit: (value: string) => void;
}) {
  const className = `${value ? "flash" : ""} w-full rounded-2xl border ${
    error ? "border-red-500" : "border-transparent"
  } bg-background px-3 py-2.5 text-sm outline-none focus:border-imblue disabled:text-muted`;
  const commit = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => onCommit(e.currentTarget.value);
  return (
    <label className="flex flex-col gap-1">
      <span className="px-1 text-xs text-muted">{label}</span>
      {multiline ? (
        <textarea key={value ?? ""} defaultValue={value ?? ""} placeholder={placeholder} rows={2} onBlur={commit} className={`${className} resize-none`} />
      ) : (
        <input
          key={value ?? ""}
          type={type}
          defaultValue={value ?? ""}
          placeholder={placeholder}
          disabled={disabled}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className={className}
        />
      )}
      {error && <span className="px-1 text-xs text-red-600">{error}</span>}
    </label>
  );
}

const HELP_ACTIONS: { label: string; send?: string; prefill?: string }[] = [
  { label: "What came in today?", send: "What came in today?" },
  { label: "Summarize yesterday", send: "Summarize my email from yesterday." },
  { label: "Summarize this week", send: "Summarize my email from this week." },
  { label: "Find an email…", prefill: "Find the email from " },
  { label: "Read the latest from…", prefill: "Read the latest email from " },
  { label: "Draft a reply…", prefill: "Draft a reply to the latest email from " },
];

function HelpActions({
  access,
  inCall,
  onAsk,
  onPrefill,
}: {
  access: ReturnType<typeof mailAccess>;
  inCall: boolean;
  onAsk: (text: string) => void;
  onPrefill: (text: string) => void;
}) {
  const locked = access !== "unlocked";
  return (
    <div className="flex flex-col gap-2">
      <div className="px-1">
        <p className="display text-[17px]">Ready when you are.</p>
        <p className="text-xs text-muted">
          {access === "unlocked"
            ? "Tap to ask, or just say it."
            : access === "expired"
              ? "Reconnect Gmail to pick up where you left off."
              : "Connect Gmail to unlock email help."}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {HELP_ACTIONS.map((a) => {
          const disabled = inCall && !a.send; // can't prefill the chat box during a call — say it instead
          return (
            <button
              key={a.label}
              disabled={disabled}
              title={disabled ? "Say it on the call" : undefined}
              onClick={() => (a.send ? onAsk(a.send) : onPrefill(a.prefill!))}
              className={`pill text-xs px-3 py-1.5 disabled:opacity-40 ${locked ? "text-muted" : ""}`}
            >
              {locked && <span className="mr-1">🔒</span>}
              {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Mobile: the same actions as one horizontally scrolling row above the input.
function QuickActions({
  access,
  onAsk,
  onPrefill,
}: {
  access: ReturnType<typeof mailAccess>;
  onAsk: (text: string) => void;
  onPrefill: (text: string) => void;
}) {
  const locked = access !== "unlocked";
  return (
    <div className="lg:hidden -mx-4 px-4 pb-2 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
      {HELP_ACTIONS.map((a) => (
        <button
          key={a.label}
          onClick={() => (a.send ? onAsk(a.send) : onPrefill(a.prefill!))}
          className={`pill shrink-0 text-xs px-3 py-1.5 ${locked ? "text-muted" : ""}`}
        >
          {locked && "🔒 "}
          {a.label}
        </button>
      ))}
    </div>
  );
}

// Numbered steps in the order the user goes through them; UI labels highlighted.
function Hl({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-surface border border-hairline px-1 text-foreground font-medium whitespace-nowrap">{children}</span>;
}

const HOW_IT_WORKS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Start however you like",
    body: (
      <>
        Tap <Hl>📞 Start a call</Hl>, send a message, or fill in <Hl>Your Persona</Hl>. All three stay in sync.
      </>
    ),
  },
  {
    title: "Ask for help right away",
    body: <>No setup first. Your assistant picks up your name and what you need as you talk.</>,
  },
  {
    title: "Connect Gmail to unlock email help",
    body: (
      <>
        Click <Hl>Connect Gmail</Hl> and approve the Google popup. It can read, never send.
      </>
    ),
  },
  {
    title: "Ask about your email",
    body: <>Use the buttons above, or just ask: summarize a day, find or read an email, draft a reply.</>,
  },
  {
    title: "Drafts stay drafts",
    body: (
      <>
        Edit it, then <Hl>Copy</Hl> or <Hl>Save to Gmail Drafts</Hl>. Sending is always up to you.
      </>
    ),
  },
  {
    title: "Hang up anytime",
    body: <>The chat picks up right where the call left off.</>,
  },
];

function HowItWorks() {
  return (
    <div className="flex flex-col gap-2 px-1">
      <p className="display text-[17px]">How it works</p>
      <ol className="flex flex-col gap-2">
        {HOW_IT_WORKS.map((step, i) => (
          <li key={step.title} className="flex gap-2.5">
            <span className="shrink-0 size-4 rounded-full bg-foreground text-background text-[10px] font-medium flex items-center justify-center mt-0.5">
              {i + 1}
            </span>
            <div>
              <p className="text-[13px] font-medium leading-tight">{step.title}</p>
              <p className="text-[11px] text-muted leading-snug">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function GmailCard({
  reconnect,
  busy,
  error,
  onConnect,
  onDecline,
}: {
  reconnect: boolean;
  busy: boolean;
  error: string | null;
  onConnect: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="w-full rounded-3xl bg-surface p-4 flex flex-col gap-3 text-left">
      <div>
        <p className="text-sm font-medium">{reconnect ? "Pick up where you left off." : "Bring your inbox."}</p>
        <p className="text-sm text-muted">
          {reconnect
            ? "Gmail access ends when the page reloads. Reconnect to continue."
            : "Connect Gmail and I'll summarize, find and draft. I never send or delete anything."}
        </p>
      </div>
      <div className="flex gap-2">
        <button onClick={onConnect} disabled={busy} className="rounded-full bg-imblue text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy ? "Connecting…" : reconnect ? "Reconnect Gmail" : "Connect Gmail"}
        </button>
        {!reconnect && (
          <button onClick={onDecline} className="rounded-full px-4 py-2 text-sm text-muted hover:text-foreground">
            Not now
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

function DraftCard({ draft, onChange, onSave }: { draft: DraftItem; onChange: (body: string) => void; onSave: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="w-full rounded-3xl bg-surface p-4 flex flex-col gap-2 text-left text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium">Draft reply</p>
        <p className="text-[11px] text-muted">Never sent</p>
      </div>
      <div className="text-xs text-muted">
        <p className="truncate">To: {draft.to}</p>
        <p className="truncate">Subject: {draft.subject}</p>
      </div>
      <textarea
        value={draft.body}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.min(10, draft.body.split("\n").length + 1)}
        className="w-full rounded-2xl border border-transparent bg-background px-3 py-2 outline-none focus:border-imblue"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(draft.body);
            setCopied(true);
          }}
          className="pill px-3 py-1.5 text-xs"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <button
          onClick={onSave}
          disabled={draft.status === "saving" || draft.status === "saved"}
          className="rounded-full bg-foreground text-background px-3 py-1.5 text-xs font-medium disabled:opacity-60"
        >
          {draft.status === "saving" ? "Saving…" : draft.status === "saved" ? "Saved to Gmail Drafts ✓" : "Save to Gmail Drafts"}
        </button>
      </div>
      {draft.error && <p className="text-xs text-red-600">{draft.error}</p>}
    </div>
  );
}

function PhoneIcon() {
  return (
    <span className="size-6 rounded-md bg-imgreen text-white flex items-center justify-center">
      <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
        <path d="M6.6 10.8a15.2 15.2 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z" />
      </svg>
    </span>
  );
}

function TypingDots() {
  return (
    <div className="self-start rounded-[20px] bg-bubble px-4 py-3 flex gap-1" aria-label="Typing">
      {[0, 150, 300].map((d) => (
        <span key={d} className="size-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: `${d}ms` }} />
      ))}
    </div>
  );
}

function Avatar({ name }: { name: string | null }) {
  return (
    <div className="size-20 rounded-full bg-surface border border-hairline flex items-center justify-center display text-3xl">
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

// iMessage-style bubbles. Spoken lines carry a "voice" tag; calls get dividers.
function Message({ message }: { message: ChatMessage }) {
  const text = messageText(message);
  if (message.metadata?.divider) {
    return (
      <div className="my-2 flex items-center gap-3 text-[11px] text-muted">
        <span className="h-px flex-1 bg-hairline" />
        {text}
        <span className="h-px flex-1 bg-hairline" />
      </div>
    );
  }
  const mine = message.role === "user";
  const voice = message.metadata?.channel === "voice";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[80%] rounded-[20px] px-4 py-2 text-[15px] leading-snug whitespace-pre-wrap ${
          mine ? "bg-imblue text-white" : "bg-bubble text-foreground"
        } ${voice ? "ring-1 ring-imgreen/60" : ""}`}
      >
        {text}
      </div>
      {voice && <span className="px-2 pt-0.5 text-[10px] text-muted">🎙 voice</span>}
    </div>
  );
}
