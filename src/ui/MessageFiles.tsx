import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FileText, ImageIcon, LoaderCircle, Maximize, Play, RotateCw, Share2, X } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Attachment, Bot, FileAction, Message } from "../core/contracts";
import { errorMessage } from "../core/contracts";
import type { MobileController } from "../core/controller";
import { fileName, localReference, mediaKind, messageContent, remoteReference, remoteFileLink } from "../core/media";
import { ImagePreview } from "./ImagePreview";
import { useSwipeNavigation } from "./gestures";

function MessageMedia({ controller, bot, message, attachment }: { controller: MobileController; bot: Bot; message: Message; attachment: Attachment }) {
  const [loaded, setLoaded] = useState<{ blob: Blob; url: string; name: string }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [expanded, setExpanded] = useState(false), [text, setText] = useState("");
  const abort = useRef(new AbortController()), link = useRef<string | undefined>(undefined), flight = useRef<Promise<{ blob: Blob; url: string; name: string }> | undefined>(undefined);
  const element = useRef<HTMLDivElement>(null), dialog = useRef<HTMLDialogElement>(null);
  useSwipeNavigation(dialog, () => setExpanded(false), { enabled: expanded, down: true });
  const inlinePlayer = useRef<HTMLMediaElement | null>(null);
  const name = loaded?.name || attachment.name || fileName(attachment.path);
  const kind = mediaKind(loaded?.blob.type || attachment.mime || (attachment.kind === "image" ? "image/png" : attachment.kind === "audio" ? "audio/mpeg" : ""), loaded?.name || fileName(attachment.path));
  const savesToPhotos = controller.platform.kind === "ios" && (kind === "image" || kind === "video");
  const saveLabel = savesToPhotos ? "保存到图库" : "保存文件";
  useEffect(() => () => { abort.current.abort(); if (link.current) URL.revokeObjectURL(link.current); }, []);
  const load = () => {
    if (loaded) return Promise.resolve(loaded);
    if (flight.current) return flight.current;
    setBusy(true); setError("");
    const pending = controller.file(bot, message.id, attachment.path, abort.current.signal).then(async file => {
      abort.current.signal.throwIfAborted();
      const blob = new Blob([new Uint8Array(file.data)], { type: file.mime });
      const actualName = file.name || attachment.name || fileName(attachment.path);
      if (mediaKind(blob.type, actualName) === "text" && blob.size <= 2 * 1024 * 1024) setText(await blob.text());
      abort.current.signal.throwIfAborted();
      const result = { blob, name: actualName, url: URL.createObjectURL(blob) };
      link.current = result.url; setLoaded(result); return result;
    }).finally(() => { flight.current = undefined; if (!abort.current.signal.aborted) setBusy(false); });
    flight.current = pending; return pending;
  };
  useEffect(() => {
    if (!["image", "text"].includes(kind) || !element.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load().catch(error => { if (!abort.current.signal.aborted) setError(errorMessage(error)); }); }
    }, { rootMargin: "120px" });
    observer.observe(element.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (expanded) { inlinePlayer.current?.pause(); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [expanded]);
  const action = async (action: FileAction | "view") => {
    try {
      setError(""); setStatus("");
      const file = await load();
      if (abort.current.signal.aborted) return;
      if (action === "view" && (kind === "file" || kind === "pdf") && controller.platform.kind !== "web") { setBusy(true); await controller.platform.media.fileAction(file.blob, file.name, "open"); }
      else if (action === "view") setExpanded(true);
      else { setBusy(true); await controller.platform.media.fileAction(file.blob, file.name, action); if (action === "save" && savesToPhotos && !abort.current.signal.aborted) setStatus("已保存到图库"); }
    } catch (error) { if (!abort.current.signal.aborted) setError(errorMessage(error)); }
    finally { if (!abort.current.signal.aborted) setBusy(false); }
  };
  const playbackError = () => setError("系统不支持此编码，可在预览中用其他应用打开。");
  const document = kind === "file" || kind === "pdf";
  return <div ref={element} className={`message-media media-${kind}`}>
    {loaded && kind === "image" ? <button className="image-preview" onClick={() => void action("view")} aria-label={`查看图片 ${name}`}><img src={loaded.url} alt={name} loading="lazy" onError={() => setError("图片未能显示，请在预览中用其他应用打开。")} /></button>
      : loaded && kind === "video" ? <div className="inline-player"><video ref={node => { inlinePlayer.current = node; }} src={loaded.url} controls playsInline preload="metadata" aria-label={name} onError={playbackError} /><button className="expand-media" aria-label={`全屏播放 ${name}`} onClick={() => void action("view")}><Maximize size={19} /></button></div>
        : loaded && kind === "audio" ? <div className="inline-audio"><audio ref={node => { inlinePlayer.current = node; }} src={loaded.url} controls preload="metadata" aria-label={name} onError={playbackError} /><button className="icon-button" aria-label={`预览音频 ${name}`} onClick={() => void action("view")}><Maximize size={18} /></button></div>
          : loaded && kind === "text" && text ? <button className="text-preview" aria-label={`查看文档 ${name}`} onClick={() => void action("view")}><pre>{text.slice(0, 2000)}</pre></button>
            : <button className={document ? "document-preview" : "media-placeholder"} onClick={() => void action("view")} disabled={busy} aria-label={`查看附件 ${name}`}>
              {busy ? <LoaderCircle size={24} className="spin" /> : kind === "image" ? <ImageIcon size={28} /> : kind === "audio" || kind === "video" ? <Play size={28} /> : <FileText size={30} />}
              {document && <span>{name}</span>}
            </button>}
    {error && <div className="media-error" role="alert"><span>{error}</span><button className="icon-button" aria-label={`重试 ${name}`} onClick={() => void action("view")} disabled={busy}><RotateCw size={18} /></button></div>}
    {busy && !loaded && <span className="media-download-status" role="status">正在下载，完成后即可查看…</span>}
    {expanded && loaded && <dialog ref={dialog} className="media-viewer" aria-label={`预览 ${name}`} onCancel={() => setExpanded(false)} onClick={event => { if (event.target instanceof Element && !event.target.closest("button, a, img, video, audio, iframe, pre, .document-cover, .zoomable-image")) setExpanded(false); }}>
      <header><button className="viewer-close" aria-label="关闭预览" onClick={() => setExpanded(false)}><X size={23} /></button><span>{name}</span></header>
      <div className="media-viewer-body">{kind === "image" ? <ImagePreview src={loaded.url} alt={name} close={() => setExpanded(false)} /> : kind === "video" ? <video src={loaded.url} controls autoPlay playsInline onError={playbackError} /> : kind === "audio" ? <audio src={loaded.url} controls autoPlay onError={playbackError} /> : kind === "pdf" ? <iframe src={loaded.url} title={name} /> : kind === "text" && text ? <pre>{text}</pre> : <div className="document-cover"><FileText size={64} /><p>{name}</p><button onClick={() => void action("open")}>打开文档</button></div>}</div>
      {error && <p role="alert" className="viewer-error">{error}</p>}
      {status && <p role="status" className="viewer-status">{status}</p>}
      <nav className="viewer-actions" aria-label="附件操作">
        <button disabled={busy} aria-label="转发或分享" title="转发或分享" onClick={() => void action("share")}><Share2 size={24} /></button>
        <button disabled={busy} aria-label={saveLabel} title={saveLabel} onClick={() => void action("save")}><Download size={24} /></button>
        <button disabled={busy} aria-label="用其他应用打开" title="用其他应用打开" onClick={() => void action("open")}><ExternalLink size={24} /></button>
      </nav>
      <span className="sr-only" role="status">{busy ? "正在处理文件" : ""}</span>
    </dialog>}
  </div>;
}
export function MessageBody({ message, bot, controller }: { message: Message; bot: Bot; controller: MobileController }) {
  const { text, attachments } = messageContent(message);
  const components = useMemo<Components>(() => ({
    p: ({ children }) => <div className="message-paragraph">{children}</div>,
    a: ({ href, children }) => href && (localReference(href) || remoteFileLink(href)) ? <MessageMedia key={href} controller={controller} bot={bot} message={message} attachment={{ kind: "file", path: href, name: typeof children === "string" ? children : fileName(href), mime: "" }} /> : href && /^https:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ src, alt }) => typeof src === "string" && (localReference(src) || remoteReference(src)) ? <MessageMedia key={src} controller={controller} bot={bot} message={message} attachment={{ kind: "image", path: src, name: alt || fileName(src), mime: "" }} /> : <span>[图片链接不可用]</span>,
  }), [controller, bot.workspace.id, bot.threadId, message.id]);
  return <>{text ? <div className="message-bubble message-markdown"><Markdown remarkPlugins={[remarkGfm]} urlTransform={url => /^https:\/\//i.test(url) || localReference(url) ? url : ""} components={components}>{text}</Markdown></div> : !attachments.length && <div className="message-bubble"><p className="message-fallback">{message.kind === "activity" ? "工具执行记录，可在电脑端查看详情。" : "消息暂时没有可显示的内容。"}</p></div>}
    {attachments.map(attachment => <MessageMedia key={`${bot.workspace.id}/${bot.threadId}/${message.id}/${attachment.path}`} {...{ controller, bot, message, attachment }} />)}
  </>;
}
