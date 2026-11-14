import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Bell, ChevronRight, Cloud, Eye, EyeOff, LoaderCircle, LogOut, MessageSquare, Monitor, RefreshCw, Search, ShieldCheck, WifiOff, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { botKey, type Bot, type Message } from "../core/contracts";
import type { MobileController, State } from "../core/controller";

function IconButton({ label, children, onClick, disabled = false }: { label: string; children: ReactNode; onClick(): void; disabled?: boolean }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Spinner() { return <LoaderCircle size={18} className="spin" aria-hidden />; }
function Brand() { return <div className="brand"><img src="/brand/app-icon.png" width="30" height="30" alt="" /><span>DoneBot</span></div>; }
function Avatar({ bot, small = false }: { bot: Bot; small?: boolean }) {
  return <span className={`avatar ${small ? "small" : ""}`} data-tone={avatarTone(bot)}>{bot.emoji || <img src="/brand/mark.svg" alt="" />}</span>;
}
function avatarTone(bot: Bot): string { return ["blue", "green", "purple", "orange"][Array.from(bot.id).reduce((value, letter) => value + letter.charCodeAt(0), 0) % 4]; }
function clock(value?: string | number): string {
  if (value === undefined) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString() ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
function preview(message?: Message): string {
  if (!message) return "开始对话";
  return message.text.replace(/[#*_`>\[\]]/g, "").replace(/\s+/g, " ").trim() || "收到一条新消息";
}

function Login({ controller, state }: { controller: MobileController; state: State }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [visible, setVisible] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.challenge) { void controller.verify(code); setCode(""); }
    else { void controller.login(email, password); setPassword(""); }
  };
  return <main className="login-page">
    <section className="login-form-area">
      <div className="login-symbol"><img src="/brand/mark.svg" alt="" /></div>
      <h1>{state.challenge ? "验证身份" : "登录 DoneBot"}</h1>
      <p className="login-description">{state.challenge ? "输入验证器中的六位动态验证码。" : "你的 Bot，随时聊。"}</p>
      <form onSubmit={submit} className="login-form">
        {state.challenge ? <label>动态验证码<input autoFocus required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label> : <>
          <label>邮箱<input required type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} placeholder="你的 DoneBot 账号" value={email} onChange={event => setEmail(event.target.value)} /></label>
          <label>密码<span className="password-field"><input required type={visible ? "text" : "password"} autoComplete="current-password" maxLength={1000} placeholder="输入密码" value={password} onChange={event => setPassword(event.target.value)} /><IconButton label={visible ? "隐藏密码" : "显示密码"} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</IconButton></span></label>
        </>}
        {state.error && <p role="alert" className="error-message">{state.error}</p>}
        <button className="login-submit" disabled={state.loading}>{state.loading ? <Spinner /> : state.challenge ? "验证并登录" : "登录"}{!state.loading && <ChevronRight size={18} />}</button>
        {state.challenge && <button type="button" className="text-button" onClick={() => controller.cancelChallenge()} disabled={state.loading}><ArrowLeft size={15} />返回登录</button>}
      </form>
    </section>
    <footer className="login-footer"><ShieldCheck size={14} />安全连接你的电脑与 Cloud</footer>
    {__FIXTURE__ && <div className="fixture-label">隔离预览 · 合成数据</div>}
  </main>;
}

function AccountSheet({ state, controller, close }: { state: State; controller: MobileController; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="account-sheet" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-label="账号与消息提醒">
    <div className="sheet-inner"><div className="sheet-handle" /><header><h2>账号</h2><IconButton label="关闭账号面板" onClick={close}><X size={20} /></IconButton></header>
      <div className="account-identity"><span className="account-avatar">{state.session?.account.email[0].toUpperCase()}</span><div><strong>DoneBot 账号</strong><p>{state.session?.account.email}</p></div></div>
      {state.push !== "unavailable" && <><button className="setting-row" onClick={() => void (state.push === "on" ? controller.disablePush() : controller.enablePush())} disabled={state.push === "busy"}>
        <Bell size={20} /><span>新消息提醒<small>{state.push === "on" ? "Bot 有新消息时通知你" : "在手机上接收 Bot 的新消息"}</small></span>{state.push === "busy" ? <Spinner /> : <span className="toggle" role="switch" aria-checked={state.push === "on"} aria-label="新消息提醒开关"><span /></span>}
      </button><p className="privacy-note">通知不展示聊天正文。</p></>}
      {state.pushError && <p role="alert" className="error-message">{state.pushError}</p>}
      <button className="setting-row sign-out" onClick={() => void controller.logout()} disabled={state.loading}><LogOut size={19} /><span>{state.loading ? "正在退出…" : "退出登录"}</span></button>
      <p className="version">DoneBot · 0.1.0</p>
    </div>
  </dialog>;
}

function BotList({ controller, state, onAccount }: { controller: MobileController; state: State; onAccount(): void }) {
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); await controller.refresh(); setRefreshing(false); };
  const filtered = state.bots.filter(bot => `${bot.name} ${bot.title ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const totalUnread = state.bots.filter(bot => bot.unread).length;
  return <aside className={`bot-list-panel ${state.selected ? "mobile-hidden" : ""}`} aria-label="Bot 列表">
    <header className="list-header"><Brand /><div className="header-actions"><IconButton label="刷新 Bot 列表" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={18} className={refreshing ? "spin" : ""} /></IconButton><button className="profile-button" aria-label="账号与消息提醒" onClick={onAccount}>{state.session?.account.email[0].toUpperCase()}</button></div></header>
    <div className="list-title"><h1>我的 Bot</h1>{totalUnread > 0 && <span className="unread-summary">{totalUnread} 个 Bot 有新消息</span>}</div>
    <label className="search-field"><Search size={17} aria-hidden /><input aria-label="搜索 Bot" placeholder="搜索 Bot" value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label="清除搜索" onClick={() => setSearch("")}><X size={15} /></button>}</label>
    <div className="bot-list-scroll">
      {state.error && <div className="source-error" role="alert"><WifiOff size={18} /><div>{state.error}<button onClick={() => void refresh()}>重新连接</button></div></div>}
      {state.workspaces.map(workspace => {
        const bots = filtered.filter(bot => bot.workspace.id === workspace.id);
        if (search && !bots.length) return null;
        return <section key={workspace.id} className="workspace-section" aria-label={workspace.kind === "cloud" ? "我的 Cloud" : workspace.name}>
          <header className="workspace-heading"><span>{workspace.kind === "cloud" ? <Cloud size={14} /> : <Monitor size={14} />}{workspace.kind === "cloud" ? "我的 Cloud" : workspace.name}</span><span className={`workspace-state ${workspace.online && !state.sourceErrors[workspace.id] ? "online" : ""}`}><i />{workspace.online && !state.sourceErrors[workspace.id] ? "在线" : "离线"}</span></header>
          {state.sourceErrors[workspace.id] && <p className="workspace-error">{state.sourceErrors[workspace.id]}</p>}
          {bots.map(bot => <button className={`bot-row ${state.selected === botKey(bot) ? "selected" : ""}`} key={botKey(bot)} onClick={() => void controller.select(bot)} aria-label={`打开 ${bot.name} 的会话`} aria-current={state.selected === botKey(bot) ? "page" : undefined}>
            <span className="avatar-wrap"><Avatar bot={bot} />{bot.busy && <span className="busy-dot" />}</span>
            <span className="bot-row-content"><span className="bot-row-heading"><strong>{bot.name}</strong><time>{clock(bot.messages.at(-1)?.timestamp)}</time></span><span className="bot-role">{bot.title || (bot.busy ? "正在处理任务" : "随时可以聊")}</span><span className="bot-preview"><span>{preview(bot.messages.at(-1))}</span>{bot.unread && <span className="unread-badge" aria-label="有未读消息">·</span>}</span></span>
          </button>)}
          {!bots.length && !state.sourceErrors[workspace.id] && <p className="section-empty">{workspace.online ? "还没有 Bot" : "设备离线后将在重新连接时同步 Bot"}</p>}
        </section>;
      })}
      {!state.error && state.workspaces.length === 0 && <div className="empty-state"><MessageSquare size={30} strokeWidth={1.4} /><h2>还没有连接的 Bot</h2><p>在电脑端登录同一个 DoneBot 账号，<br />开启手机访问后即可在这里看到 Bot。</p><button className="outline-button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <Spinner /> : <RefreshCw size={15} />}刷新</button></div>}
      {search && !filtered.length && <div className="empty-state"><Search size={28} /><h2>没有找到这个 Bot</h2><p>试试其他名字。</p></div>}
    </div>
    {state.push !== "on" && state.push !== "unavailable" && <div className="notification-invite"><span className="notification-icon"><Bell size={18} /></span><div><strong>不错过 Bot 的消息</strong><span>任务有新进展，及时提醒你</span></div><button onClick={() => void controller.enablePush()} disabled={state.push === "busy"}>{state.push === "busy" ? <Spinner /> : "开启"}</button></div>}
    {state.pushError && <p className="push-error" role="alert">{state.pushError}</p>}
    <footer className="list-footer"><span className="connection-dot" />{state.workspaces.some(workspace => workspace.online && !state.sourceErrors[workspace.id]) ? "已连接 DoneBot" : "等待设备连接"}{state.push === "on" && <Bell size={13} aria-label="消息提醒已开启" />}</footer>
    {__FIXTURE__ && <div className="fixture-label">隔离预览 · 合成数据</div>}
  </aside>;
}

function MessageBody({ message }: { message: Message }) {
  if (!message.text) return <p className="message-fallback">{message.kind === "activity" ? "工具执行记录，可在电脑端查看详情。" : "请在电脑端查看此消息的完整内容。"}</p>;
  return <Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => href && /^https:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: () => <span className="message-fallback">[图片，请在电脑端查看]</span>,
  }}>{message.text}</Markdown>;
}

function Chat({ state, controller }: { state: State; controller: MobileController }) {
  const bot = controller.selectedBot();
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const [newMessages, setNewMessages] = useState(false);
  const draft = bot ? state.drafts[`${botKey(bot)}/${bot.threadId}`] ?? "" : "";
  useEffect(() => { atBottom.current = true; setNewMessages(false); }, [state.selected]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (atBottom.current) { element.scrollTop = element.scrollHeight; setNewMessages(false); }
    else setNewMessages(true);
  }, [state.messages]);
  useEffect(() => { if (composer.current) { composer.current.style.height = "auto"; composer.current.style.height = Math.min(composer.current.scrollHeight, 140) + "px"; } }, [draft]);
  if (!bot) return <section className="chat-placeholder"><img src="/brand/mark.svg" alt="" /><h2>选一个 Bot，接着聊。</h2><p>消息与电脑和 Cloud 中的会话保持同步。</p></section>;
  const send = (event: FormEvent) => { event.preventDefault(); void controller.send(); };
  const loadOlder = async () => {
    const element = scroll.current; const previous = element?.scrollHeight ?? 0;
    await controller.loadMessages(true);
    requestAnimationFrame(() => { if (element) element.scrollTop += element.scrollHeight - previous; });
  };
  return <section className="chat-panel" aria-label={`${bot.name} 的会话`}>
    <header className="chat-header"><IconButton label="返回 Bot 列表" onClick={() => controller.back()}><ArrowLeft size={22} /></IconButton><Avatar bot={bot} small /><div className="chat-identity"><h1>{bot.name}</h1><p>{bot.workspace.kind === "cloud" ? <Cloud size={11} /> : <Monitor size={11} />}{bot.workspace.name}<span>·</span>{bot.busy ? "正在处理任务" : bot.workspace.online ? "在线" : "离线"}</p></div><span className="encrypted-indicator" title="端到端加密连接"><ShieldCheck size={17} /></span></header>
    <div className="messages-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) { atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; if (atBottom.current) setNewMessages(false); } }}>
      {state.hasMore && <button className="history-button" onClick={() => void loadOlder()} disabled={state.loadingMessages}>{state.loadingMessages ? <Spinner /> : "查看更早消息"}</button>}
      {state.loadingMessages && !state.messages.length && <div className="loading-messages" role="status"><Spinner />正在同步消息…</div>}
      {!state.loadingMessages && !state.messages.length && !state.chatError && <div className="empty-conversation"><Avatar bot={bot} /><h2>和 {bot.name} 聊聊</h2><p>发一条消息，开始新的工作。</p></div>}
      {state.messages.map((message, index) => <div key={message.id} className={`message-row ${message.role}`}>
        {index === 0 && <div className="conversation-date">{message.timestamp ? new Date(message.timestamp).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }) : "会话记录"}</div>}
        {message.role === "bot" && <div className="message-author"><Avatar bot={bot} small /><span>{bot.name}</span><time>{clock(message.timestamp)}</time></div>}
        <article className="message-bubble"><MessageBody message={message} /></article>
        {message.role === "user" && <time className="message-time">{clock(message.timestamp)}</time>}
      </div>)}
      {bot.busy && <div className="thinking" role="status"><span /><span /><span /><span className="sr-only">{bot.name} 正在处理任务</span></div>}
    </div>
    {newMessages && <button className="new-messages" onClick={() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); atBottom.current = true; setNewMessages(false); }}>查看新消息</button>}
    <div className="composer-area">
      {state.chatError && <div className="chat-error" role="alert"><p>{state.chatError}</p><button onClick={() => void controller.loadMessages(false)}>刷新消息</button></div>}
      <form className="composer" onSubmit={send}><textarea ref={composer} aria-label={`给 ${bot.name} 发消息`} placeholder={bot.workspace.online ? `给 ${bot.name} 发消息…` : "设备离线，连接后即可发送"} rows={1} value={draft} maxLength={32000} onChange={event => controller.setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void controller.send(); } }} /><button className="send-button" aria-label="发送消息" disabled={!draft.trim() || state.sending || !bot.workspace.online}>{state.sending ? <Spinner /> : <ArrowUp size={20} strokeWidth={2.2} />}</button></form>
    </div>
  </section>;
}

export function App({ controller }: { controller: MobileController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [account, setAccount] = useState(false);
  useEffect(() => { if (state.phase !== "ready") setAccount(false); }, [state.phase]);
  if (state.phase === "boot") return <main className="boot-page"><Brand /><Spinner /></main>;
  if (state.phase === "login") return <Login controller={controller} state={state} />;
  return <main className={`app-shell ${state.selected ? "has-selection" : ""}`}><BotList controller={controller} state={state} onAccount={() => setAccount(true)} /><Chat controller={controller} state={state} />{account && <AccountSheet state={state} controller={controller} close={() => setAccount(false)} />}</main>;
}
