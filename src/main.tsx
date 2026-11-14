import { createRoot } from "react-dom/client";
import { MobileApi } from "./core/api";
import { MobileController } from "./core/controller";
import { platform } from "./platform";
import { App } from "./ui/App";
import "@fontsource-variable/geist";
import "./desktop/tokens.css";
import "./ui/styles.css";

const media = matchMedia("(prefers-color-scheme: dark)");
const theme = () => {
  document.documentElement.dataset.skin = media.matches ? "midnight" : "daylight";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", media.matches ? "#121212" : "#fcfcfc");
};
theme(); media.addEventListener("change", theme);

const adapter = platform();
const controller = new MobileController(new MobileApi(adapter.vault), adapter);
createRoot(document.getElementById("root")!).render(<App controller={controller} />);
void controller.boot();
if (import.meta.hot) import.meta.hot.dispose(() => controller.dispose());
