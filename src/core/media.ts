import type { Attachment, Message } from "./contracts";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export const fileName = (path: string): string => {
  const name = path.split(/[\\/]/).at(-1)?.split(/[?#]/)[0] || "附件";
  try { return decodeURIComponent(name); } catch { return name; }
};
const decodeAttribute = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export function messageContent(message: Message): { text: string; attachments: Attachment[] } {
  const attachments = [...(message.attachments ?? [])];
  const text = message.text.replace(/<attached-(image|file)\s+path="([^"]+)"(?:\s+name="([^"]*)")?\s*\/>/g, (_tag, kind, path, name) => {
    const decoded = decodeAttribute(path);
    if (!attachments.some(attachment => attachment.path === decoded)) attachments.push({ kind, path: decoded, name: name ? decodeAttribute(name) : fileName(decoded), mime: "" });
    return "";
  }).trim();
  return { text, attachments };
}
export function mediaKind(mime: string, name: string): "image" | "video" | "audio" | "pdf" | "text" | "file" {
  const type = mime.split(";")[0].toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|avif|heic|heif)$/.test(type)) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  if (/^text\/(plain|markdown|csv|tab-separated-values)$/.test(type) || ["application/json"].includes(type)) return "text";
  if (!type || type === "application/octet-stream") {
    if (/\.(png|jpe?g|gif|webp|avif|heic|heif)$/i.test(name)) return "image";
    if (/\.(mp4|mov|webm|m4v)$/i.test(name)) return "video";
    if (/\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(name)) return "audio";
    if (/\.pdf$/i.test(name)) return "pdf";
    if (/\.(txt|md|csv|tsv|json)$/i.test(name)) return "text";
  }
  return "file";
}
export const localReference = (href: string) => Boolean(href && !href.startsWith("//") && !href.startsWith("#") && (/^[a-z]:[\\/]/i.test(href) || /^file:/i.test(href) || !/^[a-z][a-z\d+.-]*:/i.test(href)));
export const remoteReference = (href: string): boolean => {
  try { const url = new URL(href); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
};
export const remoteFileLink = (href: string) => remoteReference(href) && /\.(png|jpe?g|gif|webp|avif|heic|heif|mp4|mov|webm|m4v|mp3|m4a|wav|ogg|aac|flac|pdf|docx?|xlsx?|pptx?|txt|md|csv|tsv|json|zip)$/i.test(fileName(href));

type MarkdownNode = { type: string; url?: string; identifier?: string; alt?: string; children?: MarkdownNode[] };
const markdown = unified().use(remarkParse).use(remarkGfm);
/** The same structured attachments, inline images, file links and reference links shown by MessageBody. */
export function messageFiles(message: Message): Attachment[] {
  const content = messageContent(message), files = new Map(content.attachments.map(file => [file.path, file]));
  const tree = markdown.parse(content.text) as MarkdownNode, definitions = new Map<string, string>();
  const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void) => { visit(node); node.children?.forEach(child => walk(child, visit)); };
  walk(tree, node => { if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url); });
  walk(tree, node => {
    if (!["image", "link", "imageReference", "linkReference"].includes(node.type)) return;
    const path = node.url ?? definitions.get(node.identifier?.toLowerCase() ?? "");
    const image = node.type.startsWith("image");
    if (path && (localReference(path) || (image ? remoteReference(path) : remoteFileLink(path))) && !files.has(path)) {
      files.set(path, { kind: image ? "image" : "file", path, name: node.alt || fileName(path), mime: "" });
    }
  });
  return [...files.values()].filter(file => localReference(file.path) || remoteReference(file.path));
}
