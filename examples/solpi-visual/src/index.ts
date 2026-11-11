import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSceneConfig } from "./config.ts";
import { registerSceneReconstruction } from "./scene/index.ts";

export default function sceneReconstruction(pi: ExtensionAPI): void {
  let initialized = false;
  pi.on("session_start", (_event, ctx) => {
    if (initialized) return;
    const config = loadSceneConfig(ctx.cwd, ctx.isProjectTrusted());
    registerSceneReconstruction(pi, config);
    initialized = true;
  });
}
