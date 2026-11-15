import { Capacitor, registerPlugin } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { FileViewer } from "@capacitor/file-viewer";
import { Share } from "@capacitor/share";
import { Buffer } from "buffer";
import type { MediaPlatform, PickedImage } from "../core/contracts";
import { mediaKind } from "../core/media";

const documents = registerPlugin<{
  save(options: { uri: string }): Promise<void>;
  saveToPhotos(options: { uri: string; kind: "image" | "video"; mime: string }): Promise<void>;
}>("DoneBotDocuments");
const cacheRoot = "donebot-media";
const cancelled = (error: unknown) => /cancel|取消/i.test(String((error as Error)?.message ?? error));
const safeName = (name: string) => name.replace(/[\\/\x00-\x1f:*?"<>|]/g, "_").slice(-180) || "附件";

async function picked(path: string, format: string): Promise<PickedImage> {
  const response = await fetch(path);
  if (!response.ok) throw new Error("无法读取所选照片。");
  const blob = await response.blob();
  return { blob: blob.type ? blob : new Blob([blob], { type: `image/${format}` }), name: `照片-${Date.now()}.${format}` };
}

export const nativeMedia: MediaPlatform = {
  async pickImages(source) {
    try {
      if (source === "camera") {
        const photo = await Camera.getPhoto({ source: CameraSource.Camera, resultType: CameraResultType.Uri, quality: 90, width: 2560, height: 2560, correctOrientation: true, saveToGallery: false });
        if (!photo.webPath) throw new Error("无法读取拍摄的照片。");
        return [await picked(photo.webPath, photo.format)];
      }
      const photos = await Camera.pickImages({ quality: 90, width: 2560, height: 2560, limit: 8 });
      return Promise.all(photos.photos.map(photo => picked(photo.webPath, photo.format)));
    } catch (error) {
      if (cancelled(error)) return [];
      throw new Error(source === "camera" ? "无法使用摄像头，请在系统设置中允许 DoneBot 使用相机。" : "无法读取图库，请检查照片访问权限。");
    }
  },
  async fileAction(blob, name, action) {
    const path = `${cacheRoot}/${crypto.randomUUID()}/${safeName(name)}`;
    const kind = mediaKind(blob.type, name);
    const photos = action === "save" && Capacitor.getPlatform() === "ios" && (kind === "image" || kind === "video");
    try {
      const chunkSize = 384 * 1024;
      for (let offset = 0; offset < Math.max(1, blob.size); offset += chunkSize) {
        const data = Buffer.from(await blob.slice(offset, offset + chunkSize).arrayBuffer()).toString("base64");
        if (!offset) await Filesystem.writeFile({ directory: Directory.Cache, path, data, recursive: true });
        else await Filesystem.appendFile({ directory: Directory.Cache, path, data });
      }
      const { uri } = await Filesystem.getUri({ directory: Directory.Cache, path });
      if (photos) await documents.saveToPhotos({ uri, kind, mime: blob.type.split(";")[0] });
      else if (action === "save" && Capacitor.getPlatform() === "ios") await documents.save({ uri });
      else if (action === "open") await FileViewer.openDocumentFromLocalPath({ path: uri });
      else await Share.share({ files: [uri], title: safeName(name), dialogTitle: "打开或转发附件" });
    } catch (error) {
      if (!cancelled(error)) throw new Error(photos ? (error as Error).message || "未能保存到图库，请重试。" : action === "open" ? "系统暂不支持预览此格式，请通过分享菜单使用其他应用打开。" : "未能完成文件操作，请重试。");
    } finally {
      try { await Filesystem.rmdir({ directory: Directory.Cache, path: path.slice(0, path.lastIndexOf("/")), recursive: true }); } catch { }
    }
  },
  async clear() { try { await Filesystem.rmdir({ directory: Directory.Cache, path: cacheRoot, recursive: true }); } catch { } },
};

export const webMedia: MediaPlatform = {
  async pickImages(source) {
    return new Promise(resolve => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/jpeg,image/png,image/webp,image/gif";
      input.multiple = source === "library";
      if (source === "camera") input.capture = "environment";
      input.onchange = () => resolve(Array.from(input.files ?? []).map(file => ({ name: file.name, blob: file })));
      input.oncancel = () => resolve([]);
      input.click();
    });
  },
  async fileAction(blob, name, action) {
    const file = new File([blob], safeName(name), { type: blob.type });
    if (action === "share") {
      if (!navigator.canShare?.({ files: [file] })) throw new Error("此浏览器不支持文件分享，请在手机 App 中打开，或先保存文件。");
      try { await navigator.share({ files: [file], title: file.name }); } catch (error) { if (!cancelled(error) && (error as Error).name !== "AbortError") throw error; }
      return;
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  async clear() {},
};
