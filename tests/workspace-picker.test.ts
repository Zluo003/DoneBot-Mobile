import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { State } from "../src/core/controller";
import { WorkspacePage, WorkspacePicker } from "../src/ui/WorkspacePanels";
import type { MobileController } from "../src/core/controller";

it("shows every device name and labels offline or unreachable devices", () => {
  const workspaces = [
    { id: "home", name: "家里的电脑", kind: "computer" as const, provisioned: true, online: true },
    { id: "office", name: "办公室电脑", kind: "computer" as const, provisioned: true, online: false },
    { id: "cloud", name: "我的 Cloud", kind: "cloud" as const, provisioned: true, online: true },
  ];
  const state = { workspaces, offline: false, sourceErrors: { cloud: "连接失败" } } as unknown as State;
  const html = renderToStaticMarkup(createElement(WorkspacePicker, { state, source: workspaces[0], onChange() {} }));
  expect(html).toContain('value="home" selected="">家里的电脑</option>');
  expect(html).toContain('value="office">办公室电脑 · 离线</option>');
  expect(html).toContain('value="cloud">我的 Cloud · 离线</option>');
});

it("offers removal on the phone only for offline computers, including the current workspace", () => {
  const workspaces = [
    { id: "offline-one", name: "旧电脑", kind: "computer" as const, provisioned: true, online: false },
    { id: "online", name: "Mac mini", kind: "computer" as const, provisioned: true, online: true },
    { id: "cloud", name: "我的 Cloud", kind: "cloud" as const, provisioned: true, online: false },
  ];
  const render = (offline: boolean) => renderToStaticMarkup(createElement(WorkspacePage, {
    page: "workspaces", state: { workspaces, offline, sourceErrors: {}, workspaceLoading: {}, automations: {}, apps: {} } as unknown as State,
    controller: {} as MobileController, source: workspaces[0], onWorkspace() {}, back() {},
  }));
  const html = render(false);
  expect(html).toContain("离线 · 当前工作空间");
  expect(html.match(/>移除电脑<\/button>/g)).toHaveLength(1);
  expect(html).toContain('aria-label="移除电脑 旧电脑 offline-"');
  expect(render(true)).not.toContain(">移除电脑</button>");
});
