import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const temporaryRoots = new Map<string, string>();

/** Example-only namespace; no imports from SoL-Pi core. */
export function runtimeRoot(ctx: ExtensionContext): string {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(sessionId)) {
    throw new Error("Scene reconstruction requires a safe Pi session id");
  }
  if (sessionDir) return join(sessionDir, "sol-pi-examples", "solpi-visual", sessionId);
  let root = temporaryRoots.get(sessionId);
  if (!root) {
    root = mkdtempSync(join(tmpdir(), `sol-pi-scene-${sessionId}-`));
    temporaryRoots.set(sessionId, root);
  }
  return root;
}
