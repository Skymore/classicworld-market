import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Copy,
  History,
  Plus,
  Send,
  Square,
  Trash2,
  Pencil,
  RotateCcw,
  Check,
} from "lucide-react";
import { useAccount } from "../lib/query";
import { usePreferences, useWords } from "../providers";
import { Loading, ErrorState } from "../components/shared";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import type { Account } from "../lib/types";
import "./agent.css";

type Meta = {
  thread_id?: string;
  state?: string;
  error_code?: string;
  model?: string;
  sources?: string[];
  tool_calls?: { name: string; ok: boolean; arguments: unknown }[];
};
type Message = UIMessage<Meta>;
type Row = {
  id: string;
  seq: number;
  request_id?: string;
  role: "user" | "assistant";
  content: string;
  state: string;
  metadata: Meta;
  error_code?: string;
};
type Thread = { id: string; title: string; updated_at?: number };
type Detail = Thread & { messages: Row[]; has_more: boolean };
const API = "/api/v1/agent";
const text = (m: Message) =>
  m.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
function temporaryHistory(messages: Message[]) {
  const history: { role: string; content: string }[] = [];
  let bytes = 0;
  for (const message of [...messages].reverse()) {
    if (!["user", "assistant"].includes(message.role) || !text(message).trim())
      continue;
    const turn = { role: message.role, content: text(message).slice(0, 4000) };
    const size = new TextEncoder().encode(JSON.stringify(turn)).length;
    if (bytes + size > 22000 || history.length === 12) break;
    history.unshift(turn);
    bytes += size;
  }
  if (history[0]?.role === "assistant") history.shift();
  return history;
}
function fromRow(row: Row): Message {
  return {
    id: row.role === "user" ? row.request_id || row.id : row.id,
    role: row.role,
    parts: [{ type: "text", text: row.content }],
    metadata: { ...row.metadata, state: row.state, error_code: row.error_code },
  };
}
async function request<T>(
  url: string,
  csrf?: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let code = "unavailable";
    try {
      code = (await res.json()).error || code;
    } catch {}
    throw Error(code);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}
function errorText(code: string, en: boolean) {
  const pairs: Record<string, [string, string]> = {
    login_required: ["请先登录账号。", "Please sign in."],
    invalid_request: [
      "登录状态已更新，请刷新页面重试。",
      "Your session changed. Reload and try again.",
    ],
    conversation_not_found: [
      "这段对话不存在或不属于当前账号。",
      "This conversation is unavailable for this account.",
    ],
    conversation_busy: [
      "这段对话正在其他页面生成回复，请稍后再试。",
      "This conversation is generating in another tab.",
    ],
    message_already_saved: [
      "消息已保存，正在重新加载对话。",
      "The message is already saved. Reloading the conversation.",
    ],
    agent_rate_limited: [
      "请求太频繁，请稍后重试。",
      "Too many requests. Please try again shortly.",
    ],
    agent_busy: [
      "助手正在忙，请稍后重试。",
      "The assistant is busy. Please try again shortly.",
    ],
    agent_timeout: [
      "回复超时，已生成的内容会保留。",
      "The response timed out. Partial text is preserved.",
    ],
    agent_history_unavailable: [
      "对话暂时未能保存，请稍后重新打开核对。",
      "Could not save the conversation. Reopen it to check.",
    ],
    agent_stream_interrupted: [
      "连接中断，已生成的内容会保留，可重试。",
      "Connection interrupted. Partial text is preserved; you can retry.",
    ],
    agent_response_truncated: [
      "回复未完成，可重试。",
      "The response was incomplete. You can retry.",
    ],
    agent_free_quota_exceeded: [
      "模型额度不足或繁忙，请稍后再试。",
      "The model quota or rate limit was reached.",
    ],
  };
  return (
    pairs[code]?.[en ? 1 : 0] ||
    (en
      ? "Could not finish the response. Please try again."
      : "回复未完成，请稍后重试。")
  );
}
function RichText({ value }: { value: string }) {
  const tokens = value.split(
    /(\[[^\]\n]{1,160}\]\(\s*\/(?:item\/\d+|map\/\d+|prices)\s*\)|\*\*[^*\n]+\*\*)/g,
  );
  return (
    <>
      {tokens.map((part, i) => {
        const link = part.match(
          /^\[([^\]]+)\]\(\s*(\/(?:item\/\d+|map\/\d+|prices))\s*\)$/,
        );
        return link ? (
          <a key={i} href={link[2]}>
            {link[1]}
          </a>
        ) : part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}
export default function Agent() {
  const account = useAccount();
  const cache = useQueryClient();
  useEffect(() => {
    cache.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === "agent-history" &&
        query.queryKey[1] !== account.data?.public_id,
    });
  }, [account.data?.public_id, cache]);
  if (account.isPending) return <Loading />;
  if (account.isError) return <ErrorState retry={() => account.refetch()} />;
  return (
    <Assistant key={account.data.public_id || "guest"} account={account.data} />
  );
}
function Assistant({ account }: { account: Account }) {
  const words = useWords(),
    en = usePreferences().language === "en",
    cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [active, setActive] = useState<string | null>(
    account.signed_in ? params.get("chat") : null,
  );
  const [draft, setDraft] = useState(0);
  const [menu, setMenu] = useState(false);
  const [action, setAction] = useState<{
    type: "rename" | "delete";
    thread: Thread;
  } | null>(null);
  const [title, setTitle] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const threads = useInfiniteQuery({
    queryKey: ["agent-history", account.public_id],
    enabled: account.signed_in,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      request<{ threads: Thread[]; next_cursor?: string }>(
        API + "/threads" + (pageParam ? "?before=" + pageParam : ""),
        undefined,
        "GET",
        undefined,
        signal,
      ),
    getNextPageParam: (p) => p.next_cursor || undefined,
    staleTime: 0,
  });
  const all = threads.data?.pages.flatMap((p) => p.threads) || [];
  const refresh = useCallback(() => {
    void cache.invalidateQueries({
      queryKey: ["agent-history", account.public_id],
    });
  }, [cache, account.public_id]);
  function select(id: string | null) {
    setActive(id);
    setMenu(false);
    setParams(
      (p) => {
        if (id) p.set("chat", id);
        else p.delete("chat");
        return p;
      },
      { replace: true },
    );
  }
  useEffect(() => {
    const id = params.get("chat");
    if (id !== active) setActive(account.signed_in ? id : null);
  }, [params, account.signed_in]);
  function newChat() {
    select(null);
    setDraft((d) => d + 1);
  }
  async function commitAction() {
    if (!action) return;
    setSaving(true);
    setActionError("");
    try {
      await request(
        API + "/threads/" + action.thread.id,
        account.csrf,
        action.type === "delete" ? "DELETE" : "PATCH",
        action.type === "rename" ? { title: title.trim() } : undefined,
      );
      if (action.type === "delete" && active === action.thread.id) newChat();
      setAction(null);
      refresh();
    } catch (e) {
      setActionError(errorText((e as Error).message, en));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="chat-shell" data-agent-chat>
      <header className="stall-bar chat-top">
        <h1>{words("市场助手", "Market assistant")}</h1>
        <span className="chat-model">GPT-6 Luna</span>
        <button
          className="chat-history-toggle"
          onClick={() => setMenu(!menu)}
          aria-expanded={menu}
        >
          <History size={16} />
          {words("历史", "History")}
        </button>
        <button onClick={newChat}>
          <Plus size={16} />
          {words("新对话", "New chat")}
        </button>
      </header>
      <div className="chat-layout">
        <aside
          className={"chat-sidebar" + (menu ? " is-open" : "")}
          aria-label={words("对话历史", "Conversation history")}
        >
          <div className="chat-sidebar-title">
            {words("对话历史", "Conversations")}
          </div>
          {!account.signed_in ? (
            <div className="chat-account-note">
              <p>
                {words(
                  "登录后，对话将保存到账号，可在其他设备继续。",
                  "Sign in to save conversations and continue on another device.",
                )}
              </p>
              <Link to="/account">
                {words("登录 / 注册", "Sign in / Register")}
              </Link>
            </div>
          ) : (
            <>
              {threads.isError ? (
                <button onClick={() => threads.refetch()}>
                  {words("历史加载失败，重试", "History unavailable. Retry")}
                </button>
              ) : null}
              {all.length === 0 && !threads.isPending ? (
                <p className="chat-empty-history">
                  {words("还没有保存的对话", "No saved conversations")}
                </p>
              ) : null}
              <nav>
                {all.map((t) => (
                  <div
                    className={
                      "chat-history-row" + (active === t.id ? " is-active" : "")
                    }
                    key={t.id}
                  >
                    <button
                      className="chat-history-title"
                      onClick={() => select(t.id)}
                      title={t.title}
                    >
                      {t.title}
                    </button>
                    <button
                      className="chat-icon"
                      aria-label={words("重命名对话", "Rename conversation")}
                      onClick={() => {
                        setAction({ type: "rename", thread: t });
                        setTitle(t.title);
                        setActionError("");
                      }}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="chat-icon"
                      aria-label={words("删除对话", "Delete conversation")}
                      onClick={() => {
                        setAction({ type: "delete", thread: t });
                        setActionError("");
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </nav>
              {threads.hasNextPage ? (
                <button
                  className="chat-more"
                  disabled={threads.isFetchingNextPage}
                  onClick={() => threads.fetchNextPage()}
                >
                  {words("更早的对话", "Older conversations")}
                </button>
              ) : null}
            </>
          )}
        </aside>
        <Conversation
          key={(active || "new-" + draft) + ":" + account.public_id}
          threadId={active}
          account={account}
          onSaved={(id) => {
            refresh();
            if (id && !active) select(id);
          }}
          onChanged={refresh}
        />
      </div>
      <Dialog
        open={!!action}
        onOpenChange={(v) => {
          if (!v && !saving) setAction(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {action?.type === "rename"
              ? words("重命名对话", "Rename conversation")
              : words("删除这段对话？", "Delete this conversation?")}
          </DialogTitle>
          <DialogDescription>
            {action?.type === "delete"
              ? words(
                  "这段对话及其消息将从账号中删除。",
                  "This conversation and its messages will be removed from your account.",
                )
              : words(
                  "为这段对话设置一个容易找到的名字。",
                  "Choose a name you can recognize later.",
                )}
          </DialogDescription>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void commitAction();
            }}
          >
            {action?.type === "rename" ? (
              <input
                className="chat-title-input"
                autoFocus
                maxLength={80}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label={words("对话名称", "Conversation title")}
              />
            ) : null}
            <p role="alert">{actionError}</p>
            <div className="chat-dialog-actions">
              <button
                type="button"
                disabled={saving}
                onClick={() => setAction(null)}
              >
                {words("取消", "Cancel")}
              </button>
              <button
                type="submit"
                disabled={
                  saving || (action?.type === "rename" && !title.trim())
                }
              >
                {saving
                  ? words("处理中…", "Saving…")
                  : action?.type === "delete"
                    ? words("删除", "Delete")
                    : words("保存", "Save")}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
function Conversation({
  threadId,
  account,
  onSaved,
  onChanged,
}: {
  threadId: string | null;
  account: Account;
  onSaved(id?: string): void;
  onChanged(): void;
}) {
  const [loaded, setLoaded] = useState<Detail | null>(null),
    [failed, setFailed] = useState("");
  const words = useWords(),
    en = usePreferences().language === "en";
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!threadId) return;
      try {
        const data = await request<Detail>(
          API + "/threads/" + threadId,
          undefined,
          "GET",
          undefined,
          signal,
        );
        setLoaded(data);
        setFailed("");
      } catch (e) {
        if ((e as Error).name !== "AbortError") setFailed((e as Error).message);
      }
    },
    [threadId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  if (threadId && !loaded)
    return failed ? (
      <div className="chat-load-error" role="alert">
        <p>{errorText(failed, en)}</p>
        <button onClick={() => load()}>{words("重试", "Retry")}</button>
      </div>
    ) : (
      <div className="chat-load-error">
        <Loading />
      </div>
    );
  return (
    <ChatPane
      threadId={threadId}
      account={account}
      initial={loaded}
      onSaved={onSaved}
      onChanged={onChanged}
    />
  );
}
function ChatPane({
  threadId,
  account,
  initial,
  onSaved,
  onChanged,
}: {
  threadId: string | null;
  account: Account;
  initial: Detail | null;
  onSaved(id?: string): void;
  onChanged(): void;
}) {
  const words = useWords(),
    { language } = usePreferences(),
    en = language === "en";
  const current = useRef({ account, language, onSaved, onChanged });
  current.current = { account, language, onSaved, onChanged };
  const threadRef = useRef(threadId),
    inputRef = useRef<HTMLTextAreaElement>(null),
    scrollRef = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const [input, setInput] = useState(""),
    [querying, setQuerying] = useState(""),
    [copied, setCopied] = useState(""),
    [more, setMore] = useState(initial?.has_more || false),
    [olderBusy, setOlderBusy] = useState(false);
  const [rows, setRows] = useState(initial?.messages || []);
  const [notice, setNotice] = useState("");
  const transport = useMemo(
    () =>
      new DefaultChatTransport<Message>({
        api: API + "/stream",
        credentials: "same-origin",
        fetch: async (url, options) => {
          const response = await fetch(url, options);
          if (!response.ok) {
            let code = "unavailable";
            try {
              code = (await response.json()).error || code;
            } catch {}
            throw Error(code);
          }
          return response;
        },
        prepareSendMessagesRequest: ({ messages, trigger }) => {
          const user = [...messages].reverse().find((m) => m.role === "user")!;
          const userIndex = messages.indexOf(user);
          return {
            headers: new Headers(
              current.current.account.csrf
                ? { "X-CSRF-Token": current.current.account.csrf }
                : {},
            ),
            body: {
              thread_id: threadRef.current,
              message: text(user),
              request_id: user.id,
              language: current.current.language,
              retry: trigger === "regenerate-message",
              history: current.current.account.signed_in
                ? []
                : temporaryHistory(messages.slice(0, userIndex)),
            },
          };
        },
      }),
    [],
  );
  const chat = useChat<Message>({
    id: threadId || "draft",
    messages: initial?.messages.map(fromRow) || [],
    transport,
    throttle: 35,
    onData: (part) => {
      if (part.type === "data-session") {
        const data = part.data as { thread_id?: string };
        if (data.thread_id) threadRef.current = data.thread_id;
      }
      if (part.type === "data-status") {
        const data = part.data as { tool?: string };
        setQuerying(data.tool || "");
      }
    },
    onFinish: () => {
      setQuerying("");
      current.current.onSaved(threadRef.current || undefined);
    },
  });
  const busy = chat.status === "submitted" || chat.status === "streaming";
  const externalRunning = !busy && rows.some((r) => r.state === "streaming");
  const stopRef = useRef(chat.stop);
  stopRef.current = chat.stop;
  useEffect(
    () => () => {
      void stopRef.current();
    },
    [],
  );
  useEffect(() => {
    if (follow.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat.messages, querying]);
  useEffect(() => {
    if (!threadRef.current || !externalRunning) return;
    const timer = setInterval(async () => {
      try {
        const data = await request<Detail>(
          API + "/threads/" + threadRef.current,
        );
        setRows(data.messages);
        setMore(data.has_more);
        chat.setMessages(data.messages.map(fromRow));
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [externalRunning]);
  useEffect(() => {
    if (chat.error?.message === "message_already_saved" && threadRef.current) {
      void request<Detail>(API + "/threads/" + threadRef.current)
        .then((data) => {
          setRows(data.messages);
          chat.setMessages(data.messages.map(fromRow));
          current.current.onChanged();
        })
        .catch(() => {});
    }
  }, [chat.error]);
  async function older() {
    if (!threadRef.current || !rows.length) return;
    setOlderBusy(true);
    const scroller = scrollRef.current,
      previous = scroller?.scrollHeight || 0;
    try {
      const data = await request<Detail>(
        API + "/threads/" + threadRef.current + "?before_seq=" + rows[0].seq,
      );
      follow.current = false;
      setRows((r) => [...data.messages, ...r]);
      setMore(data.has_more);
      chat.setMessages((m) => [...data.messages.map(fromRow), ...m]);
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop += scroller.scrollHeight - previous;
      });
    } catch (e) {
      setNotice(errorText((e as Error).message, en));
    } finally {
      setOlderBusy(false);
    }
  }
  function send(e?: FormEvent) {
    e?.preventDefault();
    if (!input.trim() || busy || externalRunning) return;
    follow.current = true;
    setNotice("");
    chat.clearError();
    const message = input.trim();
    setInput("");
    void chat.sendMessage({ text: message });
  }
  async function stop() {
    if (threadRef.current && account.signed_in)
      void request(
        API + "/threads/" + threadRef.current + "/stop",
        account.csrf,
        "POST",
      ).catch(() => {});
    await chat.stop();
    setQuerying("");
    if (threadRef.current && account.signed_in) {
      setTimeout(() => {
        void request<Detail>(API + "/threads/" + threadRef.current)
          .then((data) => {
            setRows(data.messages);
            chat.setMessages(data.messages.map(fromRow));
            current.current.onChanged();
          })
          .catch(() => {});
      }, 350);
    }
  }
  async function copy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setNotice(
        words(
          "复制失败，请手动选择文字。",
          "Could not copy. Select the text manually.",
        ),
      );
    }
  }
  const labels: Record<string, string> = {
    search_items: words("筛选物品", "Searching items"),
    get_listings: words("查询摊位报价", "Checking offers"),
    get_item: words("核对物品资料", "Checking item data"),
    get_price_advice: words("计算卖出建议", "Checking sale prices"),
    get_recent_sales: words("查询近期成交", "Checking recent sales"),
    get_market_overview: words("查看市场行情", "Checking the market"),
  };
  const last = chat.messages.at(-1);
  const retryable =
    !!chat.error ||
    (!busy && last?.role === "user") ||
    (!busy &&
      last?.role === "assistant" &&
      ["aborted", "error"].includes(last.metadata?.state || ""));
  return (
    <main className="chat-main">
      <div
        ref={scrollRef}
        className="chat-scroll"
        onScroll={() => {
          const s = scrollRef.current;
          if (s)
            follow.current = s.scrollHeight - s.scrollTop - s.clientHeight < 90;
        }}
        role="log"
        aria-label={words("对话消息", "Messages")}
        aria-busy={busy}
      >
        {more ? (
          <button
            className="chat-more"
            disabled={olderBusy || busy}
            onClick={older}
          >
            {words("加载更早的消息", "Load earlier messages")}
          </button>
        ) : null}
        {chat.messages.length === 0 ? (
          <div className="chat-welcome">
            <h2>
              {words(
                "今天想买什么、卖什么？",
                "What would you like to buy or sell?",
              )}
            </h2>
            <p>
              {words(
                "我会查市场报价、摊位位置和近期成交。",
                "I can look up prices, shop locations and recent sales.",
              )}
            </p>
            <div className="chat-examples">
              {[
                words(
                  "我要买40-50弓手披风，买什么？",
                  "Which cape should a level 40–50 archer buy?",
                ),
                words(
                  "我要卖100个铁矿石，挂多少钱？",
                  "How much should I ask for 100 Iron Ores?",
                ),
              ].map((value) => (
                <button
                  key={value}
                  onClick={() => {
                    setInput(value);
                    inputRef.current?.focus();
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {chat.messages.map((message, index) => {
          const value = text(message),
            meta = message.metadata;
          return (
            <article
              key={message.id}
              className={"chat-message chat-" + message.role}
              data-message-role={message.role}
            >
              <div className="chat-message-label">
                {message.role === "user"
                  ? words("你", "You")
                  : words("市场助手", "Assistant")}
              </div>
              <div className="chat-answer">
                <RichText value={value} />
                {busy && index === chat.messages.length - 1 && value ? (
                  <span className="chat-cursor" aria-hidden="true" />
                ) : null}
              </div>
              {message.role === "assistant" && value ? (
                <div className="chat-message-tools">
                  <button
                    className="chat-icon"
                    title={words("复制回复", "Copy response")}
                    aria-label={words("复制回复", "Copy response")}
                    onClick={() => copy(message.id, value)}
                  >
                    {copied === message.id ? (
                      <Check size={14} />
                    ) : (
                      <Copy size={14} />
                    )}
                  </button>
                  {meta?.state === "aborted" ? (
                    <span>
                      {words("已停止，保留部分回复", "Stopped · partial reply")}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {meta?.sources?.length ? (
                <div className="chat-sources">
                  {meta.sources
                    .filter((s) => /^\/(?:item\/\d+|map\/\d+|prices)$/.test(s))
                    .map((s) => (
                      <a key={s} href={s}>
                        {s === "/prices"
                          ? words("市场行情", "Market")
                          : words("物品 ", "Item ") + s.split("/").at(-1)}
                      </a>
                    ))}
                </div>
              ) : null}
              {meta?.tool_calls?.length ? (
                <details className="chat-evidence">
                  <summary>
                    {words("数据查询", "Data queries")} ·{" "}
                    {meta.tool_calls.length}
                  </summary>
                  <ul>
                    {meta.tool_calls.map((t, i) => (
                      <li key={i}>
                        {labels[t.name] || words("查询数据", "Data query")} ·{" "}
                        {t.ok
                          ? words("完成", "Done")
                          : words("未查到", "Unavailable")}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          );
        })}
        {busy ? (
          <p className="chat-progress" role="status">
            {querying
              ? labels[querying] || words("正在查询…", "Looking up data…")
              : chat.status === "submitted"
                ? words("正在连接助手…", "Connecting…")
                : words("正在生成回复…", "Writing…")}
          </p>
        ) : null}
        {externalRunning ? (
          <p className="chat-progress">
            {words(
              "这段对话正在其他页面生成，内容会自动更新。",
              "This conversation is generating in another tab. Updates appear automatically.",
            )}
          </p>
        ) : null}
      </div>
      {chat.error || notice || last?.metadata?.state === "error" ? (
        <div className="chat-error" role="alert">
          {notice ||
            errorText(
              chat.error?.message || last?.metadata?.error_code || "",
              en,
            )}
        </div>
      ) : null}
      {retryable ? (
        <button
          className="chat-retry"
          disabled={busy || externalRunning}
          onClick={() => {
            setNotice("");
            chat.clearError();
            follow.current = true;
            void chat.regenerate();
          }}
        >
          <RotateCcw size={14} />
          {words("重试回复", "Retry response")}
        </button>
      ) : null}
      <form className="chat-composer" onSubmit={send}>
        <label htmlFor="chat-input" className="sr">
          {words("你的市场问题", "Your market question")}
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          value={input}
          maxLength={2000}
          rows={2}
          disabled={busy || externalRunning}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={words(
            "说说你想买什么、卖什么…",
            "Tell me what you want to buy or sell…",
          )}
        />
        {busy ? (
          <button type="button" className="chat-send" onClick={stop}>
            <Square size={16} />
            {words("停止", "Stop")}
          </button>
        ) : (
          <button
            className="chat-send"
            type="submit"
            disabled={!input.trim() || externalRunning}
          >
            <Send size={16} />
            {words("发送", "Send")}
          </button>
        )}
      </form>
      <p className="chat-footnote">
        {account.signed_in
          ? words(
              "对话随账号保存，可在其他设备继续。",
              "Conversations are saved to your account across devices.",
            )
          : words(
              "当前为临时对话，登录后可保存历史。",
              "Temporary chat. Sign in to save history.",
            )}{" "}
        {words(
          "报价来自已采集数据，请在游戏中核对。",
          "Check observed offers in game.",
        )}
      </p>
    </main>
  );
}
