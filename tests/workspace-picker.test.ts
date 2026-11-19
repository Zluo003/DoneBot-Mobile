import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { State } from "../src/core/controller";
import { WorkspacePicker } from "../src/ui/WorkspacePanels";

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
