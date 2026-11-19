import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CalendarClock, ChevronDown, ChevronRight, Cloud, Link, LoaderCircle, Menu, MessageSquare, Monitor, RefreshCw, Settings, X } from "lucide-react";
import { automationKey, type ConnectedApp } from "../core/automations";
import type { MobileController, State } from "../core/controller";
import type { Workspace } from "../core/contracts";
import { hasActiveConnection } from "../desktop/connector-status";
import { useSwipeNavigation } from "./gestures";

export type Panel = "menu" | "settings" | "automations" | "apps" | "workspaces";
export type ListDensity = "compact" | "standard" | "comfortable";
export function readListDensity(): ListDensity {
  try { const value = localStorage.getItem("donebot.listDensity"); return value === "compact" || value === "comfortable" ? value : "standard"; }
  catch { return "standard"; }
}
export function saveListDensity(value: ListDensity): void {
  try { localStorage.setItem("donebot.listDensity", value); } catch { }
}

export function WorkspacePicker({ state, source, onChange }: { state: State; source: Workspace; onChange(id: string): void }) {
  const online = source.online && !state.offline && !state.sourceErrors[source.id];
  return <label className="workspace-dropdown">{source.kind === "cloud" ? <Cloud size={15} /> : <Monitor size={15} />}<select aria-label="切换电脑与 Cloud" value={source.id} onChange={event => onChange(event.target.value)}>{state.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}{!workspace.online || state.offline || state.sourceErrors[workspace.id] ? " · 离线" : ""}</option>)}</select><i className={`workspace-dot ${online ? "online" : ""}`} role="img" aria-label={online ? "在线" : "离线"} /><ChevronDown size={15} /></label>;
}

export function PanelFrame({ title, children, back, action }: { title: string; children: ReactNode; back(): void; action?: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useSwipeNavigation(dialog, back);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="page-sheet" aria-label={title} onCancel={event => { event.preventDefault(); back(); }}><header className="page-header"><button className="icon-button back-button" aria-label="返回" onClick={back}><ArrowLeft size={22} /></button><h2>{title}</h2>{action ?? <span className="header-spacer" />}</header><div className="page-body">{children}</div></dialog>;
}

export function MenuSheet({ state, onNavigate, close }: { state: State; onNavigate(panel: Panel): void; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useSwipeNavigation(dialog, close);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="account-sheet" aria-label="菜单" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="sheet-inner"><header><h2><Menu size={20} />菜单</h2><button className="icon-button" aria-label="关闭菜单" onClick={close}><X size={20} /></button></header><p className="menu-account">{state.session?.account.email}</p><nav className="menu-links" aria-label="功能菜单">
    <button onClick={close}><MessageSquare size={20} /><span>聊天</span><ChevronRight size={17} /></button>
    <button onClick={() => onNavigate("automations")}><CalendarClock size={20} /><span>自动化工作</span><ChevronRight size={17} /></button>
    <button onClick={() => onNavigate("settings")}><Settings size={20} /><span>设置</span><ChevronRight size={17} /></button>
  </nav></div></dialog>;
}

const appNames: Record<string, string> = { gmail: "Gmail", googlecalendar: "Google 日历", slack: "Slack", notion: "Notion", github: "GitHub", googledrive: "Google 云端硬盘", outlook: "Outlook" };
const appName = (id: string) => appNames[id] ?? id;
function appStatus(app: ConnectedApp): string {
  if (hasActiveConnection(app)) return "已连接";
  return app.pending || app.accounts?.some(account => /^(initiated|initializing|pending)$/i.test(account.status)) ? "等待完成连接" : "需要重新连接";
}
const nextRun = (at: number) => new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function WorkspacePage({ page, state, controller, source, onWorkspace, back }: { page: "automations" | "apps" | "workspaces"; state: State; controller: MobileController; source?: Workspace; onWorkspace(id: string): void; back(): void }) {
  const [removing, setRemoving] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [removeError, setRemoveError] = useState("");
  const remove = async (id: string) => {
    setRemoving(id); setRemoveError("");
    try { await controller.removeComputer(id); setConfirmRemove(""); }
    catch (error) { setRemoveError(error instanceof Error ? error.message : "无法移除设备，请稍后重试。"); }
    finally { setRemoving(""); }
  };
  const key = `${page}/${source?.id ?? ""}`;
  const busy = state.workspaceLoading[key];
  useEffect(() => {
    if (!source || page === "workspaces") return;
    void controller.loadWorkspaceData(source.id, page);
    const timer = setInterval(() => { void controller.loadWorkspaceData(source.id, page); }, 15_000);
    return () => clearInterval(timer);
  }, [controller, source?.id, source?.online, state.offline, page]);
  const refresh = async () => { await controller.refresh(); if (source && page !== "workspaces") await controller.loadWorkspaceData(source.id, page); };
  const items = source ? state.automations[source.id]?.filter(item => state.bots.some(bot => bot.workspace.id === source.id && bot.id === item.botId)) : undefined;
  const apps = source ? state.apps[source.id]?.filter(app => hasActiveConnection(app) || app.pending || Boolean(app.accounts?.length)) : undefined;
  const canEdit = Boolean(source?.online && !state.offline && !state.sourceErrors[source.id]);
  return <PanelFrame title={page === "automations" ? "自动化工作" : page === "apps" ? "已连接的应用程序" : "电脑与 Cloud"} back={back} action={<button className="icon-button" aria-label="刷新列表" disabled={busy} onClick={() => void refresh()}><RefreshCw size={19} className={busy ? "spin" : ""} /></button>}>
    {page !== "workspaces" && source && <div className="page-workspace"><WorkspacePicker state={state} source={source} onChange={onWorkspace} /></div>}
    {page === "workspaces" ? <>{removeError && <p className="panel-error" role="alert">{removeError}</p>}<div className="settings-group">{state.workspaces.map(workspace => {
      const online = workspace.online && !state.offline && !state.sourceErrors[workspace.id];
      return <div key={workspace.id} className="workspace-device">
        <button className="workspace-setting" onClick={() => { onWorkspace(workspace.id); back(); }}>
          {workspace.kind === "cloud" ? <Cloud size={23} /> : <Monitor size={23} />}
          <span><strong>{workspace.name}</strong><small><i className={`workspace-dot ${online ? "online" : ""}`} />{online ? "在线" : "离线"}{workspace.id === source?.id ? " · 当前工作空间" : ""}</small><small>设备编号：{workspace.id.slice(0, 8)}</small></span>
          <ChevronRight size={17} />
        </button>
        {workspace.kind === "computer" && !workspace.online && !state.offline && <div className="workspace-remove">
          {confirmRemove === workspace.id ? <>
            <p>移除后，这台电脑下次打开 DoneBot 会自动重新连接。电脑里的聊天和文件会保留。</p>
            <button className="outline-button" disabled={Boolean(removing)} onClick={() => setConfirmRemove("")}>取消</button>
            <button className="outline-button danger-button" disabled={Boolean(removing)} onClick={() => void remove(workspace.id)}>{removing === workspace.id ? "正在移除…" : "确认移除"}</button>
          </> : <button className="outline-button" aria-label={`移除电脑 ${workspace.name} ${workspace.id.slice(0, 8)}`} disabled={Boolean(removing)} onClick={() => setConfirmRemove(workspace.id)}>移除电脑</button>}
        </div>}
      </div>;
    })}</div>{!state.workspaces.length && <p className="panel-empty">暂无已连接的电脑或 Cloud。</p>}</>
      : !source ? <p className="panel-empty">连接电脑或 Cloud 后即可查看。</p> : <>
        {state.workspaceErrors[key] && <p className="panel-error" role="alert">{state.workspaceErrors[key]}</p>}
        {busy && !(page === "automations" ? items : apps) && <p className="panel-empty" role="status"><LoaderCircle size={18} className="spin" />正在同步…</p>}
        {page === "automations" ? <div className="automation-list">{items?.map(item => {
          const changing = state.automationBusy.includes(automationKey(source.id, item));
          const bot = state.bots.find(bot => bot.workspace.id === source.id && bot.id === item.botId);
          return <article className="automation-item" key={`${item.kind}/${item.id}`}><div className="automation-heading"><div><span className="automation-type">{item.kind === "schedule" ? "定时工作" : item.kind === "app" ? "应用事件" : "外部事件"} · {bot?.name}</span><h3>{item.name}</h3></div><button className="toggle" role="switch" aria-label={`${item.name}开关`} aria-checked={item.enabled} disabled={!canEdit || changing} onClick={() => void controller.setAutomationEnabled(source.id, item, !item.enabled)}>{changing ? <LoaderCircle size={17} className="spin" /> : <span />}</button></div>{item.prompt && <p className="automation-prompt">{item.prompt}</p>}<p className="automation-status">{item.enabled ? "已开启" : "已关闭"}{item.enabled && item.nextRunAt ? ` · 下次 ${nextRun(item.nextRunAt)}` : item.eventName ? ` · ${item.appName ?? ""} ${item.eventName}` : ""}</p>{(item.checkTrouble || item.warning) && <p className="automation-warning">{item.checkTrouble || item.warning}</p>}</article>;
        })}{items && !items.length && <p className="panel-empty">暂无自动化工作。可在电脑端创建后，在这里管理开关。</p>}</div>
          : <div className="settings-group">{apps?.map(app => <div key={app.id} className="connected-app"><Link size={21} /><div><strong>{appName(app.id)}</strong><p>{appStatus(app)}</p>{app.accounts?.map(account => <small key={account.id}>{account.alias || appName(app.id)} · {/^active$/i.test(account.status) ? "已连接" : "需要处理"}</small>)}</div><i className={`workspace-dot ${hasActiveConnection(app) ? "online" : ""}`} /></div>)}{apps && !apps.length && <p className="panel-empty">暂无已连接的应用程序。</p>}</div>}
      </>}
  </PanelFrame>;
}
