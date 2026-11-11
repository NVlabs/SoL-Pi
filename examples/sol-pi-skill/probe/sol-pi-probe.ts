// Helper extension for sol-pi-run, loaded only with `pi -e`; it never calls a model.
// - `/sol-pi-probe` (used by `doctor`) reports which SoL-Pi tools, skills and
//   models registered.
// - On every run it records the reducer model's prices in the session, because
//   SoL-Pi's reducer entries store token usage only and Pi's session totals leave
//   nested reducer calls out. sol-pi-run prices those calls from this entry.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REDUCER_PRICE_ENTRY = "sol-pi-skill-reducer-price";

function splitRoute(route: string): [string, string] {
	const [provider = "", ...rest] = route.split("/");
	return [provider, rest.join("/")];
}

export default function probe(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const route = process.env.SOL_PI_REDUCER_ROUTE;
		if (!route) return;
		const found = ctx.modelRegistry.find(...splitRoute(route));
		pi.appendEntry(REDUCER_PRICE_ENTRY, { route, cost: found?.cost ?? null });
	});

	pi.registerCommand("sol-pi-probe", {
		description: "Print SoL-Pi registration state as JSON",
		handler: async (_args, ctx) => {
			const tools = pi.getAllTools().map((t) => ({ name: t.name, source: t.sourceInfo?.source, path: t.sourceInfo?.path }));
			const solPi = tools.filter((t) => String(t.path ?? "").includes("SoL-Pi") || String(t.path ?? "").includes("sol-pi"));
			const lookup = (route: string | undefined) => {
				if (!route) return null;
				const found = ctx.modelRegistry.find(...splitRoute(route));
				return { route, registered: Boolean(found), authConfigured: found ? ctx.modelRegistry.hasConfiguredAuth(found) : false };
			};
			const skills = (pi.getCommands?.() ?? []).map((c: { name: string }) => c.name).filter((n) => n.startsWith("skill:"));
			const report = {
				skills,
				tools: tools.map((t) => t.name),
				solPiTools: solPi.map((t) => t.name),
				reducer: lookup(process.env.SOL_PI_PROBE_REDUCER),
				model: lookup(process.env.SOL_PI_PROBE_MODEL),
				available: ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`),
			};
			process.stdout.write(`SOL_PI_PROBE ${JSON.stringify(report)}\n`);
		},
	});
}
