import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SceneConfig } from "../config.ts";
import { runtimeRoot } from "../runtime-paths.ts";
import { AWAIT_RENDER_POLICY, LOCAL_EDIT_SCOPE, MAGNIFY_POLICY } from "./policies.ts";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("./magnify.py", import.meta.url));
const coordinate = () => Type.Integer({ minimum: 0 });
const bbox = () => Type.Tuple([coordinate(), coordinate(), coordinate(), coordinate()]);


export function scenePolicy(config: SceneConfig): string {
	return [
		config.localEditScope ? LOCAL_EDIT_SCOPE : "",
		config.magnify ? MAGNIFY_POLICY : "",
		config.awaitRender ? AWAIT_RENDER_POLICY : "",
	].filter(Boolean).join("\n\n");
}

/** Opt-in prompt guidance and an image tool; never overrides the shell or hides failures. */
export function registerSceneReconstruction(pi: ExtensionAPI, config: SceneConfig): void {
	const policy = scenePolicy(config);
	if (policy) {
		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n[SoL-Pi Visual]\n${policy}`,
		}));
	}
	if (!config.magnify) return;

	pi.registerTool({
		name: "magnify",
		label: "Magnify existing image",
		description: "Crop and interpolate an existing single-frame PNG/JPEG image without rendering or generating detail. Returns the crop image for inspection and a coordinate/hash receipt. Optionally crop a corresponding reference region with its own bounding box. Use only when the full image is insufficient; keep whole-scene context.",
		parameters: Type.Object({
			image: Type.String({ description: "Source image path, relative to the working directory or absolute" }),
			bbox: bbox(),
			scale: Type.Optional(Type.Number({ minimum: 1, maximum: 8, description: "Interpolation scale, default 2" })),
			interpolation: Type.Optional(Type.Union([
				Type.Literal("nearest"), Type.Literal("bilinear"), Type.Literal("bicubic"), Type.Literal("lanczos"),
			])),
			maxSide: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096, description: "Maximum output edge in pixels, default 1024; oversized crops fail instead of silently resizing" })),
			reference: Type.Optional(Type.String()),
			referenceBbox: Type.Optional(bbox()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if ((params.reference === undefined) !== (params.referenceBbox === undefined)) {
				throw new Error("reference and referenceBbox must be supplied together; framing may differ");
			}
			const args = [
				script, "--image", resolve(ctx.cwd, params.image), "--bbox", ...params.bbox.map(String),
				"--scale", String(params.scale ?? 2), "--interpolation", params.interpolation ?? "bicubic",
				"--max-side", String(params.maxSide ?? 1024),
				"--output-root", join(runtimeRoot(ctx), "magnify"),
			];
			if (params.reference !== undefined && params.referenceBbox !== undefined) {
				args.push("--reference", resolve(ctx.cwd, params.reference), "--reference-bbox", ...params.referenceBbox.map(String));
			}
			// Argument-vector execution: filenames never become shell code. No provider call.
			const { stdout } = await execFileAsync("python3", args, {
				cwd: ctx.cwd, signal, timeout: 30_000, maxBuffer: 256 * 1024,
			});
			const receipt = JSON.parse(stdout) as {
				artifact_id: string;
				receipt: string;
				cached: boolean;
				images: Record<string, { output_path: string }>;
			};
			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
				{ type: "text", text: stdout.trim() },
			];
			for (const [name, image] of Object.entries(receipt.images)) {
				signal?.throwIfAborted();
				const png = await readFile(image.output_path);
				if (png.length > 3_750_000) throw new Error("Magnify PNG exceeds 3,750,000 bytes; reduce bbox or scale");
				content.push({ type: "text", text: `${name}: interpolated existing pixels; see receipt for original coordinates.` });
				content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
			}
			return { content, details: receipt };
		},
	});
}
