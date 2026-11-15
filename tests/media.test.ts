import { expect, it } from "vitest";
import { botSchema, messageSchema } from "../src/core/contracts";
import { localReference, mediaKind, messageContent, messageFiles } from "../src/core/media";
import { mobileRequestAllowed } from "../src/core/relay";

it("only admits automation lists, enabled updates and connected-app inventory", () => {
  for (const path of ["/api/routines", "/api/webhooks", "/api/app-triggers", "/api/connectors/connected"]) expect(mobileRequestAllowed("GET", path)).toBe(true);
  expect(mobileRequestAllowed("PATCH", "/api/routines/daily")).toBe(true);
  expect(mobileRequestAllowed("POST", "/api/webhooks/hook/enabled")).toBe(true);
  expect(mobileRequestAllowed("POST", "/api/app-triggers/event/enabled")).toBe(true);
  for (const [method, path] of [["POST", "/api/routines"], ["DELETE", "/api/routines/daily"], ["PATCH", "/api/webhooks/hook"], ["POST", "/api/app-triggers/event/enabled?admin=1"], ["GET", "/api/connectors/catalog"]]) expect(mobileRequestAllowed(method!, path!)).toBe(false);
});

it("retains all reply attachment formats and extracts the original image upload markup", () => {
  const reply = messageSchema.parse({ id: "msg", role: "bot", text: "文件", attachments: [
    { kind: "image", path: "/image.png", mime: "image/png" },
    { kind: "file", path: "/video.mp4", mime: "video/mp4", name: "视频.mp4" },
    { kind: "audio", path: "/voice.wav", mime: "audio/wav" },
    { kind: "file", path: "/plan.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "计划.docx" },
  ] });
  expect(messageContent(reply).attachments).toHaveLength(4);
  const uploaded = messageSchema.parse({ id: "msg", role: "user", text: '看看\n\n<attached-image path="/safe/a.png" name="图&amp;片.png" />' });
  expect(messageContent(uploaded)).toEqual({ text: "看看", attachments: [{ kind: "image", path: "/safe/a.png", name: "图&片.png", mime: "" }] });
});
it("finds offscreen media and documents, including Markdown reference links, without caching ordinary websites", () => {
  const message = messageSchema.parse({ id: "files", role: "bot", text: `![图](/图片(原版).png)
[文档](</工作目录/计划 v2.pdf>)
[视频][clip]
![图](/图片(原版).png)
[网站](https://example.test/page)
[下载](https://example.test/file.docx?token=synthetic)
\`[代码中的文件](/not-a-file.pdf)\`

[clip]: /video.mp4`, attachments: [{ kind: "audio", path: "/audio.mp3", mime: "audio/mpeg" }] });
  expect(messageFiles(message).map(file => file.path)).toEqual(["/audio.mp3", "/图片(原版).png", "/工作目录/计划 v2.pdf", "/video.mp4", "https://example.test/file.docx?token=synthetic"]);
});
it("uses safe in-app preview formats and leaves active content to system applications", () => {
  expect(mediaKind("image/svg+xml", "script.svg")).toBe("file");
  expect(mediaKind("text/html", "script.html")).toBe("file");
  expect(mediaKind("application/octet-stream", "video.mp4")).toBe("video");
  for (const path of ["/workspace/file.pdf", "file:///tmp/file.pdf", "./file.pdf"]) expect(localReference(path)).toBe(true);
  for (const path of ["javascript:alert(1)", "data:text/html,x", "https://external.test", "//evil.test/file"]) expect(localReference(path)).toBe(false);
});
it("accepts the desktop's unset mascot profile alongside custom avatars", () => {
  const bot = botSchema.parse({ id: "bot", name: "DoneBot", threadId: "thread", mascotBody: null, mascotExpression: null, avatarUrl: "/api/attachments/avatar.png", avatarCrop: "rounded", avatarZoom: 1.6, avatarFocusX: .25, avatarFocusY: .75 });
  expect(bot.avatarUrl).toBe("/api/attachments/avatar.png");
  expect(bot.mascotExpression).toBeNull();
  expect(bot.avatarFocusX).toBe(.25);
});
it("only permits scoped file downloads, raster avatars and idempotent image uploads", () => {
  expect(mobileRequestAllowed("POST", "/api/threads/thread/messages/msg/file")).toBe(true);
  expect(mobileRequestAllowed("POST", "/api/attachments?uploadId=11111111-1111-4111-8111-111111111111")).toBe(true);
  expect(mobileRequestAllowed("GET", "/api/attachments/avatar.png")).toBe(true);
  for (const path of ["/api/files", "/api/attachments/private.pdf", "/api/attachments/avatar.svg", "/api/threads/t/messages/m/file?path=/private", "/api/attachments/../config", "/api/bots/b/profile"]) {
    expect(mobileRequestAllowed("GET", path)).toBe(false);
    expect(mobileRequestAllowed("POST", path)).toBe(false);
  }
});
