/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DAY = 86_400_000;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

export async function fetchStarHistory(repository, { token, fetcher = fetch } = {}) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Expected owner/repository");
	const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" };
	if (token) headers.Authorization = `Bearer ${token}`;
	async function get(path) {
		const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
			headers, signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
		return response.json();
	}
	const weeks = [];
	for (let page = 1; ; page++) {
		if (page > 100) throw new Error("GitHub history exceeded the supported pagination limit");
		const batch = await get(`stargazers/history?per_page=30&page=${page}`);
		if (!Array.isArray(batch) || batch.length > 30) throw new Error("Invalid GitHub history page");
		weeks.push(...batch);
		if (batch.length < 30) break;
	}
	const { count } = await get("stargazers/count");
	if (!isCount(count)) throw new Error("Invalid GitHub star count");
	const snapshot = { repository, fetchedAt: new Date().toISOString(), currentStars: count, weeks };
	// Validate the complete history before the caller can publish any output.
	toDailyPoints(snapshot);
	return snapshot;
}

export function toDailyPoints({ weeks, fetchedAt }) {
	const now = Date.parse(fetchedAt);
	if (!Number.isFinite(now) || !Array.isArray(weeks)) throw new Error("Invalid history snapshot");
	const seen = new Set();
	for (const week of weeks) {
		if (!week || !isCount(week.week) || !Number.isFinite(new Date(week.week * 1000).getTime()) ||
			!isCount(week.total) || !Array.isArray(week.days) || week.days.length !== 7 ||
			!week.days.every(isCount) || week.days.reduce((a, b) => a + b, 0) !== week.total ||
			seen.has(week.week)) throw new Error("Invalid or duplicate GitHub history week");
		seen.add(week.week);
	}
	let total = 0;
	const points = [];
	for (const week of [...weeks].sort((a, b) => a.week - b.week)) {
		for (const [day, count] of week.days.entries()) {
			const time = week.week * 1000 + day * DAY;
			if (time > now) continue; // The newest week includes future zero-filled days.
			total += count;
			if (!Number.isSafeInteger(total)) throw new Error("History total exceeds safe integer range");
			points.push({ time, stars: total });
		}
	}
	const first = points.findIndex((point) => point.stars > 0);
	if (first === -1) return [{ time: now - DAY, stars: 0 }, { time: now, stars: 0 }];
	const active = points.slice(first);
	return [{ time: active[0].time - DAY, stars: 0 }, ...active];
}

export async function renderStarHistory(snapshot, theme) {
	const renderer = process.env.STAR_HISTORY_RENDERER;
	if (!renderer) throw new Error("STAR_HISTORY_RENDERER must point to the pinned Star History checkout");
	const require = createRequire(resolve(renderer, "backend/package.json"));
	const { JSDOM } = require("jsdom");
	const { optimize } = require("svgo");
	const { default: XYChart } = await import(pathToFileURL(resolve(renderer, "shared/packages/xy-chart.tsx")).href);
	const { fixJsdomSvgCasing } = await import(pathToFileURL(resolve(renderer, "backend/utils.ts")).href);
	const dom = new JSDOM("<!doctype html><body></body>");
	try {
		const svg = dom.window.document.createElement("svg");
		dom.window.document.body.append(svg);
		svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
		svg.setAttribute("width", "800");
		XYChart(svg, {
			title: "Star History", xLabel: "Date", yLabel: "GitHub Stars",
			showDots: false, transparent: false, theme,
			data: { datasets: [{
				label: snapshot.repository.toLowerCase(), logo: snapshot.logo || "",
				data: toDailyPoints(snapshot).map(({ time, stars }) => ({ x: new Date(time), y: stars })),
			}] },
		}, { xTickLabelType: "Date", chartWidth: 800, legendPosition: "top-left" });
		// Preserve the original chart layout; the timestamp is the only addition.
		const height = Number(svg.getAttribute("height"));
		const updated = dom.window.document.createElementNS("http://www.w3.org/2000/svg", "text");
		updated.setAttribute("x", "790");
		updated.setAttribute("y", String(height + 14));
		updated.setAttribute("text-anchor", "end");
		updated.setAttribute("style", `font: 10px Arial, sans-serif; fill: ${theme === "dark" ? "#9198a1" : "#656d76"}`);
		updated.textContent = `Updated ${snapshot.fetchedAt.slice(0, 16).replace("T", " ")} UTC`;
		svg.append(updated);
		svg.setAttribute("height", String(height + 22));
		svg.setAttribute("viewBox", `0 0 800 ${height + 22}`);
		return `${optimize(fixJsdomSvgCasing(svg.outerHTML), { multipass: true }).data}\n`;
	} finally {
		dom.window.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const [repository = process.env.GITHUB_REPOSITORY, directory] = process.argv.slice(2);
		if (!repository || !directory) throw new Error("Usage: node scripts/update-star-history.mjs owner/repository output-directory");
		const snapshot = await fetchStarHistory(repository, { token: process.env.GITHUB_TOKEN });
		const logo = await fetch(`https://github.com/${repository.split("/")[0]}.png?size=22`, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!logo.ok) throw new Error(`GitHub avatar: HTTP ${logo.status}`);
		snapshot.logo = `data:${logo.headers.get("content-type")};base64,${Buffer.from(await logo.arrayBuffer()).toString("base64")}`;
		const files = {
			"star-history-light.svg": await renderStarHistory(snapshot, "light"),
			"star-history-dark.svg": await renderStarHistory(snapshot, "dark"),
			"star-history.json": `${JSON.stringify(snapshot, null, 2)}\n`,
			"LICENSE-star-history.txt": await readFile(resolve(process.env.STAR_HISTORY_RENDERER, "LICENSE"), "utf8"),
		};
		await mkdir(directory, { recursive: true });
		for (const [name, contents] of Object.entries(files)) await writeFile(resolve(directory, name), contents);
		console.log(`Generated star history for ${repository}: ${snapshot.currentStars} current stars, ${snapshot.fetchedAt}`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
