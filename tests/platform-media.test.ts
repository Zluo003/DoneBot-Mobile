import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  save: vi.fn(async () => {}), saveToPhotos: vi.fn(async () => {}),
  share: vi.fn(async () => {}), open: vi.fn(async () => {}),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "ios" }, registerPlugin: () => native }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" }, Filesystem: {
    writeFile: vi.fn(async () => {}), appendFile: vi.fn(async () => {}),
    getUri: vi.fn(async () => ({ uri: "file:///private/cache/donebot-media/test/file" })), rmdir: vi.fn(async () => {}),
  },
}));
vi.mock("@capacitor/share", () => ({ Share: { share: native.share } }));
vi.mock("@capacitor/file-viewer", () => ({ FileViewer: { openDocumentFromLocalPath: native.open } }));
import { nativeMedia } from "../src/platform/media";
beforeEach(() => vi.clearAllMocks());

it("saves images and videos directly to Photos while documents retain the Files picker", async () => {
  await nativeMedia.fileAction(new Blob(["png"], { type: "image/png" }), "图片.png", "save");
  await nativeMedia.fileAction(new Blob(["mp4"], { type: "application/octet-stream" }), "视频.mp4", "save");
  expect(native.saveToPhotos.mock.calls.map(call => (call as unknown as [{ kind: string }])[0].kind)).toEqual(["image", "video"]);
  expect(native.save).not.toHaveBeenCalled(); expect(native.share).not.toHaveBeenCalled();
  await nativeMedia.fileAction(new Blob(["pdf"], { type: "application/pdf" }), "文档.pdf", "save");
  expect(native.save).toHaveBeenCalledOnce();
});
it("reports a denied Photos permission without opening the file picker or share sheet", async () => {
  native.saveToPhotos.mockRejectedValueOnce(new Error("请在系统设置中允许 DoneBot 添加照片"));
  await expect(nativeMedia.fileAction(new Blob(["png"], { type: "image/png" }), "图片.png", "save")).rejects.toThrow("允许 DoneBot 添加照片");
  expect(native.save).not.toHaveBeenCalled(); expect(native.share).not.toHaveBeenCalled();
});
