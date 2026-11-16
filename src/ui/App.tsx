import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Bell, CalendarClock, Camera, Check, FileText, FolderOpen, ImagePlus, Link, List, Menu, MessagesSquare, Paperclip, ChevronRight, Crown, Users, Cloud, Eye, EyeOff, LoaderCircle, LogOut, MessageSquare, Monitor, RefreshCw, Search, ShieldCheck, WifiOff, X } from "lucide-react";
import type { Conversation } from "../core/conversations";
import { messageContent } from "../core/media";
import { Avatar } from "./Avatar";
import { viewersDefaultBot } from "../desktop/default-bot";
import { MessageBody } from "./MessageFiles";
import { useSwipeNavigation } from "./gestures";
import { botKey, type Bot, type Message, type Workspace } from "../core/contracts";
import { MenuSheet, PanelFrame, WorkspacePage, WorkspacePicker, readListDensity, saveListDensity, type ListDensity, type Panel } from "./WorkspacePanels";
import type { MobileController, State } from "../core/controller";

function IconButton({ label, children, onClick, disabled = false, className = "" }: { label: string; children: ReactNode; onClick(): void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Spinner() { return <LoaderCircle size={18} className="spin" aria-hidden />; }
function clock(value?: string | number): string {
  if (value === undefined) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString() ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
function preview(message?: Message): string {
  if (!message) return "开始对话";
  const content = messageContent(message);
  return content.text.replace(/!\[[^\]]*\]\([^)]*\)/g, "图片").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#*_`>\[\]]/g, "").replace(/\s+/g, " ").trim() || (content.attachments.length ? "收到附件" : "收到一条新消息");
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

function SettingsPage({ state, controller, back, onNavigate, density, onDensity }: { state: State; controller: MobileController; back(): void; onNavigate(panel: Panel): void; density: ListDensity; onDensity(value: ListDensity): void }) {
  return <PanelFrame title="设置" back={back}>
      <div className="account-identity"><span className="account-avatar">{state.session?.account.email[0].toUpperCase()}</span><div><strong>DoneBot 账号</strong><p>{state.session?.account.email}</p></div></div>
      <h3 className="settings-heading">聊天列表</h3><div className="settings-group"><label className="setting-row"><List size={20} /><span>列表密度</span><select aria-label="列表密度" value={density} onChange={event => onDensity(event.target.value as ListDensity)}><option value="compact">紧凑</option><option value="standard">标准</option><option value="comfortable">宽松</option></select></label><div className="setting-row"><List size={20} /><span>工具活动</span><small>已隐藏</small></div></div>
      <p className="settings-note">聊天中只显示消息，不显示工具活动和执行摘要。</p>
      <h3 className="settings-heading">工作与连接</h3><div className="settings-group"><button className="setting-row" onClick={() => onNavigate("automations")}><CalendarClock size={20} /><span>自动化工作</span><ChevronRight size={17} /></button><button className="setting-row" onClick={() => onNavigate("apps")}><Link size={20} /><span>已连接的应用程序</span><ChevronRight size={17} /></button><button className="setting-row" onClick={() => onNavigate("workspaces")}><Monitor size={20} /><span>电脑与 Cloud</span><ChevronRight size={17} /></button></div>
      <h3 className="settings-heading">消息与存储</h3><div className="settings-group">
      {state.push !== "unavailable" && <><button className="setting-row" onClick={() => void (state.push === "on" ? controller.disablePush() : controller.enablePush())} disabled={state.push === "busy"}>
        <Bell size={20} /><span>新消息提醒<small>{state.push === "on" ? "Bot 有新消息时通知你" : "在手机上接收 Bot 的新消息"}</small></span>{state.push === "busy" ? <Spinner /> : <span className="toggle" role="switch" aria-checked={state.push === "on"} aria-label="新消息提醒开关"><span /></span>}
      </button><p className="privacy-note">通知不展示聊天正文。</p></>}
      {state.pushError && <p role="alert" className="error-message">{state.pushError}</p>}
      <p className="privacy-note">已同步的消息和附件保存在本机，离线也能查看。退出登录会清除此账号的本机缓存。</p>
      {state.cachePending > 0 && <p className="privacy-note" role="status">正在缓存 {state.cachePending} 个附件…</p>}
      {state.cacheError && <div role="alert" className="error-message">{state.cacheError}<button className="text-button" disabled={state.offline || state.cachePending > 0} onClick={() => void controller.retryCache()}>重试缓存</button></div>}
      </div>
      <button className="setting-row sign-out" onClick={() => void controller.logout()} disabled={state.loading}><LogOut size={19} /><span>{state.loading ? "正在退出…" : "退出登录"}</span></button>
      <p className="version">DoneBot · 0.1.0</p>
  </PanelFrame>;
}

function ConversationAvatar({ bot, state, controller, size = 46 }: { bot: Bot; state: State; controller: MobileController; size?: number }) {
  if (bot.conversationKind !== "group") return <Avatar bot={bot} controller={controller} size={size} />;
  const members = (bot.memberIds ?? []).map(id => state.bots.find(member => member.workspace.id === bot.workspace.id && member.id === id && member.conversationKind !== "group")).filter((member): member is Bot => Boolean(member)).slice(0, 2);
  return <span className="group-avatar" style={{ width: size, height: size }} aria-hidden="true">{members.length ? members.map(member => <Avatar key={member.id} bot={member} controller={controller} size={size * .7} />) : <Users size={size * .7} />}</span>;
}
function BotList({ controller, state, onMenu, source, onWorkspace, density }: { controller: MobileController; state: State; onMenu(): void; source?: Workspace; onWorkspace(id: string): void; density: ListDensity }) {
  const [search, setSearch] = useState("");
  const listId = useId();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem("donebot.collapsedDepartments") ?? "[]"); return new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []); }
    catch { return new Set(); }
  });
  const toggleDepartment = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key); else next.add(key);
    setCollapsed(next);
    try { localStorage.setItem("donebot.collapsedDepartments", JSON.stringify([...next])); } catch { }
  };
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); await controller.refresh(); setRefreshing(false); };
  const bots = state.bots.filter(bot => bot.workspace.id === source?.id);
  const filtered = bots.filter(bot => `${bot.name} ${bot.title ?? ""} ${bot.section ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const chief = viewersDefaultBot(bots.filter(bot => bot.conversationKind !== "group"), state.session?.account.email) ?? bots.find(bot => bot.conversationKind !== "group" && bot.chiefOfStaff && !bot.section);
  const sections = [...new Set(["", ...(state.sections[source?.id ?? ""] ?? []), ...filtered.map(bot => bot.section ?? "")])];
  const online = Boolean(source?.online && !state.sourceErrors[source.id] && !state.offline);
  return <aside className={`bot-list-panel ${state.selected ? "mobile-hidden" : ""}`} data-density={density} aria-label="Bot 列表">
    <header className="list-header directory-header">
      <button className="icon-button menu-button" aria-label="打开菜单" onClick={onMenu}><Menu size={23} /></button>
      <div className="directory-title"><h1>聊天</h1>{source && <WorkspacePicker state={state} source={source} onChange={onWorkspace} />}</div>
      <IconButton label="刷新 Bot 列表" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={18} className={refreshing ? "spin" : ""} /></IconButton>
    </header>
    {source && !online && <div className="directory-status" role="status"><WifiOff size={14} /><span>{state.offline ? "离线模式 · 可查看已缓存内容" : "未连接 · 显示已同步内容"}</span></div>}
    <label className="search-field"><Search size={17} aria-hidden /><input aria-label="搜索 Bot" placeholder="搜索 Bot 或群聊" value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label="清除搜索" onClick={() => setSearch("")}><X size={15} /></button>}</label>
    <div className="bot-list-scroll">
      {state.openingBot && <p className="conversation-loading" role="status"><Spinner />正在同步对话…<button onClick={() => controller.back()}>取消</button></p>}
      {state.error && <div className="source-error" role="alert"><WifiOff size={18} /><div>{state.error}<button onClick={() => void refresh()}>重新连接</button></div></div>}
      {source && state.sourceErrors[source.id] && <p className="workspace-error">{state.sourceErrors[source.id]}</p>}
      {chief && (!search || filtered.includes(chief)) && <button className="coordinator" onClick={() => void controller.select(chief)} aria-label={`打开 ${chief.name} 的会话`} aria-current={state.selected === botKey(chief) ? "page" : undefined}>
        <span className="coordinator-avatar"><Avatar controller={controller} bot={chief} size={60} /><Crown size={16} className="coordinator-crown" />{chief.unread && <i className="coordinator-unread" role="img" aria-label="有未读消息" />}{chief.busy && <i className="busy-dot" role="img" aria-label="正在工作" />}</span><strong>{chief.name}</strong><span>主协调 Bot</span><p>{chief.busy ? "正在处理任务…" : controller.latestConversation(chief)?.reply ? preview(controller.latestConversation(chief)?.reply) : "暂无回复"}</p>
      </button>}
      {sections.map((section, index) => {
        const entries = filtered.filter(bot => bot !== chief && (bot.section ?? "") === section)
          .sort((a, b) => Number(Boolean(b.chiefOfStaff && b.conversationKind !== "group")) - Number(Boolean(a.chiefOfStaff && a.conversationKind !== "group")));
        if (!entries.length) return null;
        const key = JSON.stringify([state.session?.account.id, source?.id, section]);
        const folded = Boolean(section && !search.trim() && collapsed.has(key));
        const unread = entries.filter(bot => bot.unread);
        const counting = unread.some(bot => bot.unreadCount === undefined);
        const unreadCount = unread.reduce((count, bot) => count + (bot.unreadCount ?? 0), 0);
        const membersId = `${listId}-department-${index}`;
        return <section className="directory-section" key={section} aria-label={section || "Bot 与群聊"}>{section && <h2 className="department-heading"><button type="button" className="department-toggle" aria-expanded={!folded} aria-controls={membersId} onClick={() => toggleDepartment(key)}><ChevronRight size={15} className={folded ? "" : "expanded"} aria-hidden /><span>{section}</span><i aria-hidden />{folded && unread.length > 0 && <span className="department-unread" aria-label={counting ? "正在同步未读消息数量" : `${unreadCount} 条未读消息`}>{counting ? "…" : unreadCount}</span>}</button></h2>}<div id={membersId} hidden={folded}>{entries.map(bot => {
          const reply = controller.latestConversation(bot)?.reply;
          return <button className={`bot-row ${state.selected === botKey(bot) ? "selected" : ""}`} key={botKey(bot)} onClick={() => void controller.select(bot)} aria-label={`打开 ${bot.name} 的会话`} aria-current={state.selected === botKey(bot) ? "page" : undefined}>
            <span className="avatar-wrap"><ConversationAvatar bot={bot} state={state} controller={controller} size={density === "compact" ? 38 : density === "comfortable" ? 52 : 46} />{bot.chiefOfStaff && <Crown className="row-crown" size={13} />}{bot.busy && <span className="busy-dot" role="img" aria-label="正在工作" />}</span>
            <span className="bot-row-content"><span className="bot-row-heading"><strong>{bot.name}</strong><time>{clock(reply?.timestamp)}</time></span><span className="bot-preview"><span>{bot.busy ? "正在处理任务…" : reply ? preview(reply) : "暂无回复"}</span>{bot.unread && <span className="unread-badge" role="img" aria-label="有未读消息" />}</span></span>
          </button>;
        })}</div></section>;
      })}
      {source && !bots.length && !state.sourceErrors[source.id] && <p className="section-empty">{online ? "还没有 Bot 或群聊" : "重新连接后同步 Bot 与群聊"}</p>}
      {!state.error && state.workspaces.length === 0 && <div className="empty-state"><MessageSquare size={30} strokeWidth={1.4} /><h2>还没有连接的 Bot</h2><p>在电脑端登录同一个 DoneBot 账号，<br />开启手机访问后即可在这里看到 Bot。</p><button className="outline-button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <Spinner /> : <RefreshCw size={15} />}刷新</button></div>}
      {search && !filtered.length && <div className="empty-state"><Search size={28} /><h2>没有找到相关会话</h2><p>试试其他名字。</p></div>}
    </div>
    {state.push !== "on" && state.push !== "unavailable" && <div className="notification-invite"><span className="notification-icon"><Bell size={18} /></span><div><strong>不错过 Bot 的消息</strong><span>任务有新进展，及时提醒你</span></div><button onClick={() => void controller.enablePush()} disabled={state.push === "busy"}>{state.push === "busy" ? <Spinner /> : "开启"}</button></div>}
    {state.pushError && <p className="push-error" role="alert">{state.pushError}</p>}
    <footer className="list-footer">{state.cachePending > 0 ? `正在缓存 ${state.cachePending} 个附件…` : `${bots.filter(bot => bot.conversationKind !== "group").length} 个 Bot · ${bots.filter(bot => bot.conversationKind === "group").length} 个群聊`}{state.push === "on" && <Bell size={13} aria-label="消息提醒已开启" />}</footer>
    {__FIXTURE__ && <div className="fixture-label">隔离预览 · 合成数据</div>}
  </aside>;
}

function ConversationList({ bot, controller, state, close }: { bot: Bot; controller: MobileController; state: State; close(): void }) {
  const items = controller.conversations(bot), sync = state.conversationSync[botKey(bot)];
  const refresh = async () => { await controller.refresh(bot.workspace.id); await controller.syncConversations([controller.selectedBot() ?? bot], true); };
  const row = (item: Conversation) => <button key={item.threadId} className="conversation-row" aria-current={item.threadId === bot.threadId ? "page" : undefined} onClick={() => { void controller.select(bot, item.threadId); close(); }}>
    <MessagesSquare size={19} aria-hidden /><span className="conversation-row-content"><span className="conversation-row-heading"><strong>{item.title}</strong><time>{clock(item.reply?.timestamp)}</time></span><span className="conversation-preview">{item.reply ? preview(item.reply) : "尚无 Bot 回复"}</span></span>{item.unread && <i className="conversation-unread" role="img" aria-label="有未读消息" />}{item.threadId === bot.threadId && <Check size={18} aria-label="当前对话" />}
  </button>;
  return <PanelFrame title="对话列表" back={close} action={<button className="icon-button" aria-label="刷新对话列表" disabled={sync?.loading || !bot.workspace.online} onClick={() => void refresh()}><RefreshCw size={19} className={sync?.loading ? "spin" : ""} /></button>}>
    <p className="conversation-owner">{bot.name} · {bot.workspace.name}</p>
    {sync?.loading && <p className="conversation-loading" role="status"><Spinner />正在同步对话…</p>}
    {sync?.error && <p className="panel-error" role="alert">{sync.error}</p>}
    {(!bot.workspace.online || state.offline) && <p className="settings-note">离线模式，显示已同步的对话。</p>}
    <nav className="conversation-list" aria-label="对话">{items.filter(item => !item.archived).map(row)}</nav>
    {items.some(item => item.archived) && <details className="archived-conversations"><summary>已归档的对话</summary><nav className="conversation-list" aria-label="已归档的对话">{items.filter(item => item.archived).map(row)}</nav></details>}
  </PanelFrame>;
}

function Chat({ state, controller }: { state: State; controller: MobileController }) {
  const bot = controller.selectedBot();
  const panel = useRef<HTMLElement>(null);
  useSwipeNavigation(panel, () => controller.back(), { enabled: Boolean(bot) });
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [newMessages, setNewMessages] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const images = bot ? state.images[`${botKey(bot)}/${bot.threadId}`] ?? [] : [];
  const messages = state.messages.filter(message => message.kind !== "activity" && message.kind !== "digest");
  const lastMessage = messages.at(-1);
  const lastAttachments = JSON.stringify(lastMessage?.attachments);
  const draft = bot ? state.drafts[`${botKey(bot)}/${bot.threadId}`] ?? "" : "";
  useEffect(() => { atBottom.current = true; setNewMessages(false); }, [state.selected, state.selectedThread]);
  useEffect(() => { setConversationsOpen(false); }, [state.selected]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (atBottom.current) { element.scrollTop = element.scrollHeight; setNewMessages(false); }
    else setNewMessages(true);
  }, [state.selected, state.selectedThread, messages.length, lastMessage?.id, lastMessage?.text, lastAttachments]);
  useEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(() => { if (atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [state.selected, state.selectedThread]);
  useEffect(() => { if (composer.current) { composer.current.style.height = "auto"; composer.current.style.height = Math.min(composer.current.scrollHeight, 140) + "px"; } }, [draft]);
  if (!bot) return <section className="chat-placeholder"><img src="/brand/mark.svg" alt="" /><h2>选一个 Bot，接着聊。</h2><p>消息与电脑和 Cloud 中的会话保持同步。</p></section>;
  const conversations = controller.conversations(bot), current = conversations.find(item => item.threadId === bot.threadId);
  const otherUnread = conversations.some(item => item.threadId !== bot.threadId && item.unread);
  const send = (event: FormEvent) => { event.preventDefault(); void controller.send(); };
  const loadOlder = async () => {
    const element = scroll.current; const previous = element?.scrollHeight ?? 0;
    await controller.loadMessages(true);
    requestAnimationFrame(() => { if (element) element.scrollTop += element.scrollHeight - previous; });
  };
  return <section ref={panel} className="chat-panel" aria-label={`${bot.name} 的会话`}>
    <header className="chat-header"><IconButton className="back-button" label="返回 Bot 列表" onClick={() => controller.back()}><ArrowLeft size={22} /></IconButton><ConversationAvatar controller={controller} state={state} bot={bot} size={30} /><div className="chat-identity"><h1>{bot.name}</h1><p title={`${current?.title ?? ""} · ${bot.workspace.name}`}><span className="chat-conversation-title">{current?.title}</span><span>·</span>{bot.busy ? "正在处理任务" : bot.workspace.online ? "在线" : "离线"}</p></div><button className="icon-button conversation-switcher" aria-label={otherUnread ? "切换对话，其他对话有未读消息" : "切换对话"} title="对话列表" aria-haspopup="dialog" aria-expanded={conversationsOpen} onClick={() => { setConversationsOpen(true); void controller.syncConversations([bot]); }}><MessagesSquare size={21} />{otherUnread && <i className="conversation-unread" aria-hidden />}</button></header>
    {conversationsOpen && <ConversationList bot={bot} state={state} controller={controller} close={() => setConversationsOpen(false)} />}
    <div className="messages-area"><div className="messages-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) { atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; if (atBottom.current) setNewMessages(false); } }}>
      <div className="messages-content" ref={content}>{state.hasMore && <button className="history-button" onClick={() => void loadOlder()} disabled={state.loadingMessages}>{state.loadingMessages ? <Spinner /> : "查看更早消息"}</button>}
      {state.loadingMessages && !state.messages.length && <div className="loading-messages" role="status"><Spinner />正在同步消息…</div>}
      {!state.loadingMessages && !messages.length && !state.chatError && !bot.busy && <div className="empty-conversation"><Avatar controller={controller} bot={bot} /><h2>和 {bot.name} 聊聊</h2><p>发一条消息，开始新的工作。</p></div>}
      {messages.map((message, index) => <div key={`${botKey(bot)}/${bot.threadId}/${message.id}`} className={`message-row ${message.role}`}>
        {index === 0 && <div className="conversation-date">{message.timestamp ? new Date(message.timestamp).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }) : "会话记录"}</div>}
        {message.role === "bot" && <div className="message-author"><Avatar controller={controller} bot={state.bots.find(member => member.workspace.id === bot.workspace.id && member.id === message.from?.botId) ?? bot} small /><span>{message.from?.name ?? bot.name}</span><time>{clock(message.timestamp)}</time></div>}
        <article className="message-content"><MessageBody controller={controller} bot={bot} message={message} /></article>
        {message.role === "user" && <time className="message-time">{clock(message.timestamp)}</time>}
      </div>)}
      {bot.busy && <div className="thinking" role="status"><span /><span /><span /><span className="sr-only">{bot.name} 正在处理任务</span></div>}
    </div></div>
    {newMessages && <button className="new-messages" onClick={() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); atBottom.current = true; setNewMessages(false); }}>查看新消息</button>}
    </div><div className="composer-area">
      {state.chatError && <div className="chat-error" role="alert"><p>{state.chatError}</p><button onClick={() => void controller.loadMessages(false)}>刷新消息</button></div>}
      {images.length > 0 && <div className="draft-images" aria-label="待发送的附件">{images.map(image => <div key={image.id}>{image.kind === "file" ? <span className="draft-document"><FileText size={24} /><span>{image.name}</span></span> : <img src={image.url} alt={image.name} />}<button type="button" aria-label={`移除 ${image.name}`} disabled={state.sending} onClick={() => controller.removeImage(image.id)}><X size={14} /></button></div>)}</div>}
      {attachMenu && <div className="attachment-menu"><button type="button" disabled={state.picking || state.sending} onClick={() => { setAttachMenu(false); void controller.pickImages("camera"); }}><Camera size={19} />拍摄照片</button><button type="button" disabled={state.picking || state.sending} onClick={() => { setAttachMenu(false); void controller.pickImages("library"); }}><ImagePlus size={19} />从图库选择</button><button type="button" disabled={state.picking || state.sending} onClick={() => { setAttachMenu(false); void controller.pickDocuments(); }}><FolderOpen size={19} />从文件中选择文档</button><button type="button" aria-label="关闭附件菜单" onClick={() => setAttachMenu(false)}><X size={18} /></button></div>}
      <form className="composer" onSubmit={send}><button type="button" className="icon-button attach-button" aria-label="添加附件" aria-expanded={attachMenu} disabled={state.picking || state.sending || !bot.workspace.online} onClick={() => setAttachMenu(!attachMenu)}>{state.picking ? <Spinner /> : <Paperclip size={20} />}</button><textarea ref={composer} aria-label={`给 ${bot.name} 发消息`} placeholder={bot.workspace.online ? `给 ${bot.name} 发消息…` : "设备离线，连接后即可发送"} rows={1} value={draft} maxLength={32000} onChange={event => controller.setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void controller.send(); } }} /><button className="send-button" aria-label="发送消息" disabled={(!draft.trim() && !images.length) || state.sending || state.picking || !bot.workspace.online}>{state.sending ? <Spinner /> : <ArrowUp size={20} strokeWidth={2.2} />}</button></form>
    </div>
  </section>;
}

export function App({ controller }: { controller: MobileController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [density, setDensity] = useState<ListDensity>(readListDensity);
  const [returnPanel, setReturnPanel] = useState<Panel>("menu");
  const source = state.workspaces.find(workspace => workspace.id === sourceId) ?? state.workspaces[0];
  const changeWorkspace = (id: string) => { setSourceId(id); void controller.refresh(id); };
  const navigate = (next: Panel) => { if (next === "apps" || next === "workspaces" || next === "automations") setReturnPanel(panel === "settings" ? "settings" : "menu"); setPanel(next); };
  useEffect(() => { if (state.phase !== "ready") { setPanel(null); setSourceId(""); } }, [state.phase]);
  if (state.phase === "boot") return <main className="boot-page"><Spinner /></main>;
  if (state.phase === "login") return <Login controller={controller} state={state} />;
  return <main className={`app-shell ${state.selected ? "has-selection" : ""}`}><BotList controller={controller} state={state} onMenu={() => setPanel("menu")} source={source} onWorkspace={changeWorkspace} density={density} /><Chat controller={controller} state={state} />{panel === "menu" && <MenuSheet state={state} onNavigate={navigate} close={() => setPanel(null)} />}{panel === "settings" && <SettingsPage state={state} controller={controller} back={() => setPanel(null)} onNavigate={navigate} density={density} onDensity={value => { setDensity(value); saveListDensity(value); }} />}{(panel === "apps" || panel === "workspaces" || panel === "automations") && <WorkspacePage page={panel} state={state} controller={controller} source={source} onWorkspace={changeWorkspace} back={() => setPanel(returnPanel)} />}</main>;
}
