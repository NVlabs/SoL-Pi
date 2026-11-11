import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export interface SceneConfig {
  readonly version: 1;
  readonly localEditScope: boolean;
  readonly magnify: boolean;
  readonly awaitRender: boolean;
}

export const DEFAULT_CONFIG: SceneConfig = Object.freeze({
  version: 1, localEditScope: false, magnify: false, awaitRender: false,
});

const flags = ["localEditScope", "magnify", "awaitRender"] as const;

/** Project-local example settings. Never reads or changes sol-pi.json. */
export function loadSceneConfig(cwd: string, projectTrusted = true): SceneConfig {
  if (!projectTrusted) return DEFAULT_CONFIG;
  const path = join(cwd, CONFIG_DIR_NAME, "solpi-visual.json");
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const config = value as Record<string, unknown>;
  if (config.version !== 1) throw new Error(`${path}: version must be 1`);
  for (const key of Object.keys(config)) {
    if (key !== "version" && !flags.some((flag) => flag === key)) {
      throw new Error(`${path}: unknown key ${key}`);
    }
  }
  const result = { ...DEFAULT_CONFIG };
  for (const key of flags) {
    if (config[key] === undefined) continue;
    if (typeof config[key] !== "boolean") throw new Error(`${path}: ${key} must be boolean`);
    result[key] = config[key];
  }
  return result;
}
