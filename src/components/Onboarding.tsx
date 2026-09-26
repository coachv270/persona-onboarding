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
      str(key) ? apply({ type, value: str(key) }) : "Empty value — ask again.";

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
        return "Noted — no more setup questions. Keep helping.";
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

  const onCallEnded = (reason: string) => {
    setCall(null);
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
          ? ` They'd given ${before.userEmail}; their Gmail is ${email} — say (once) you'll use that.`
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
        `Gmail connected (${email}) — email help is now unlocked.` +
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
    <div className="mx-auto w-full max-w-5xl min-h-dvh md:h-dvh px-4 py-4 md:py-6 grid gap-4 md:gap-6 md:grid-cols-[300px_1fr]">
      <aside className="flex flex-col gap-4 md:overflow-y-auto">
        <ProfileCard
          state={state}
          hasToken={hasToken}
          gmailBusy={gmailBusy}
          gmailError={gmailError}
          onEdit={editField}
          onConnectGmail={connectGmail}
        />
        <HelpActions access={access} inCall={inCall} onAsk={askAssistant} onPrefill={prefill} />
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
            hasToken={hasToken}
            autoStart={call !== "ring"}
            runTool={runTool}
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
            <main className="flex-1 overflow-y-auto flex flex-col gap-3 py-4">
              {visibleMessages.length === 0 && drafts.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-4">
                  <Avatar name={state.agentName} />
                  <h1 className="text-2xl font-semibold">
                    {state.agentName ? `Say hi to ${state.agentName}` : "Meet your new assistant"}
                  </h1>
                  <p className="opacity-60 max-w-sm">
                    Ask for help, hop on a quick call, or fill in the details on the left — whatever&apos;s easiest.
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
              {draftCards}
              {gmailCard}
              <div ref={bottomRef} />
            </main>

            <form onSubmit={submit} className="py-4 flex gap-2">
              <input
                ref={inputRef}
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
  const missing = missingSlots(state).length;
  const connected = state.gmail.status === "connected";
  return (
    <div className="rounded-3xl border border-black/10 dark:border-white/15 p-4 flex flex-col gap-3">
      <Field label="Assistant's name" value={state.agentName} placeholder="e.g. Nova" onCommit={(v) => onEdit("agentName", v)} />
      <Field label="Your name" value={state.userName} placeholder="What should they call you?" onCommit={(v) => onEdit("userName", v)} />
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
        <span className="text-xs font-medium opacity-60">Gmail</span>
        {connected && hasToken ? (
          <p key={state.gmail.email} className="flash text-sm rounded-xl px-3 py-2 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 truncate">
            ✓ Connected
          </p>
        ) : (
          <button
            onClick={onConnectGmail}
            disabled={gmailBusy}
            className={`text-sm rounded-xl px-3 py-2 text-left border transition-colors disabled:opacity-50 ${
              state.gmail.status === "offered" || connected
                ? "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                : "border-black/10 dark:border-white/15 hover:border-blue-500"
            }`}
          >
            {gmailBusy
              ? "Connecting…"
              : connected
                ? "Reconnect Gmail (session expired)"
                : state.gmail.status === "declined"
                  ? "Skipped · connect anyway"
                  : "Connect Gmail"}
          </button>
        )}
        {gmailError && <p className="text-xs text-red-600">{gmailError}</p>}
      </div>
      <p className={`text-xs ${missing === 0 ? "text-emerald-700 dark:text-emerald-400" : "opacity-50"}`}>
        {missing === 0 ? "✓ Setup complete" : `${missing} detail${missing === 1 ? "" : "s"} left — or just ask for help`}
      </p>
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
  const className = `${value ? "flash" : ""} w-full rounded-xl border ${
    error ? "border-red-500" : "border-black/10 dark:border-white/15"
  } bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:opacity-70`;
  const commit = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => onCommit(e.currentTarget.value);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium opacity-60">{label}</span>
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
      {error && <span className="text-xs text-red-600">{error}</span>}
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
    <div className="flex flex-col gap-2 px-1">
      <div className="flex items-baseline justify-between">
        <p className="text-xs font-medium">What I can do</p>
        <p className="text-[11px] opacity-50">
          {access === "unlocked" ? "Email help unlocked" : access === "expired" ? "🔒 Reconnect Gmail" : "🔒 Connect Gmail to unlock"}
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
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
                locked
                  ? "border-black/10 dark:border-white/15 opacity-60 hover:opacity-100"
                  : "border-emerald-500/40 hover:bg-emerald-500/10"
              }`}
            >
              {locked ? "🔒 " : ""}
              {a.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] opacity-50">Drafts are never sent — you can copy them or save to Gmail Drafts.</p>
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="text-xs opacity-60 flex flex-col gap-1.5 px-1">
      <p className="font-medium">How it works</p>
      <p>Talk, type, or fill in the fields — all three work together and update live.</p>
      <p>Ask for help anytime. Setup never blocks you; connecting Gmail unlocks email help.</p>
      <p>Gmail connects via a Google popup. The assistant can read, summarize and draft — it never sends or deletes.</p>
      <p>Hang up anytime — the chat picks up where the call left off.</p>
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
    <div className="w-full rounded-2xl border border-blue-500/40 bg-blue-500/5 p-4 flex flex-col gap-3 text-left">
      <p className="text-sm">
        {reconnect
          ? "Gmail access expired for this session — reconnect to continue."
          : "Connect Gmail so I can summarize, find and read your email and draft replies. I never send or delete anything."}
      </p>
      <div className="flex gap-2">
        <button onClick={onConnect} disabled={busy} className="rounded-full bg-blue-600 text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy ? "Connecting…" : reconnect ? "Reconnect Gmail" : "Connect Gmail"}
        </button>
        {!reconnect && (
          <button onClick={onDecline} className="rounded-full px-4 py-2 text-sm opacity-60">
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
    <div className="w-full rounded-2xl border border-violet-500/40 bg-violet-500/5 p-4 flex flex-col gap-2 text-left text-sm">
      <div className="text-xs opacity-70">
        <p className="truncate">To: {draft.to}</p>
        <p className="truncate">Subject: {draft.subject}</p>
      </div>
      <textarea
        value={draft.body}
        onChange={(e) => onChange(e.target.value)}
        rows={Math.min(10, draft.body.split("\n").length + 1)}
        className="w-full rounded-xl border border-black/10 dark:border-white/15 bg-background px-3 py-2 outline-none focus:border-violet-500"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(draft.body);
            setCopied(true);
          }}
          className="rounded-full border border-black/15 dark:border-white/20 px-3 py-1.5 text-xs"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <button
          onClick={onSave}
          disabled={draft.status === "saving" || draft.status === "saved"}
          className="rounded-full bg-violet-600 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60"
        >
          {draft.status === "saving" ? "Saving…" : draft.status === "saved" ? "Saved to Gmail Drafts ✓" : "Save to Gmail Drafts"}
        </button>
        <span className="text-[11px] opacity-50">Never sent</span>
      </div>
      {draft.error && <p className="text-xs text-red-600">{draft.error}</p>}
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
