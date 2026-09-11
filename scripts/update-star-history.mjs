/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DAY = 86_400_000;
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[char]);
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

export function renderStarHistory(snapshot, theme) {
	const points = toDailyPoints(snapshot);
	const dark = theme === "dark";
	const colors = dark
		? { background: "#0d1117", text: "#f0f6fc", muted: "#9198a1", grid: "#30363d", line: "#9bd43c" }
		: { background: "#ffffff", text: "#1f2328", muted: "#59636e", grid: "#d1d9e0", line: "#608f00" };
	const left = 80, right = 854, top = 120, bottom = 350;
	const end = points.at(-1);
	const maximum = Math.max(5, end.stars);
	const magnitude = 10 ** Math.floor(Math.log10(maximum / 5));
	const step = Math.ceil(maximum / 5 / magnitude) * magnitude;
	const ceiling = Math.ceil(maximum / step) * step;
	const x = (time) => left + (time - points[0].time) / (end.time - points[0].time) * (right - left);
	const y = (stars) => bottom - stars / ceiling * (bottom - top);
	const path = points.map((point, i) => `${i ? "L" : "M"}${x(point.time).toFixed(2)},${y(point.stars).toFixed(2)}`).join(" ");
	const formatDate = (time) => new Date(time).toISOString().slice(0, 10);
	const title = `${snapshot.repository} star history`;
	const updated = snapshot.fetchedAt.slice(0, 16).replace("T", " ");
	const elements = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="460" viewBox="0 0 900 460" role="img" aria-labelledby="title description">`,
		`<title id="title">${escape(title)}</title>`,
		`<desc id="description">${snapshot.currentStars} current stars. Historical line sums daily star additions reported by GitHub. Updated ${updated} UTC.</desc>`,
		`<rect width="900" height="460" rx="12" fill="${colors.background}"/>`,
		`<g font-family="Arial, Helvetica, sans-serif" fill="${colors.text}">`,
		`<text x="36" y="42" font-size="24" font-weight="700">Star history</text>`,
		`<text x="36" y="68" font-size="15" fill="${colors.muted}">${escape(snapshot.repository)}</text>`,
		`<text x="864" y="42" text-anchor="end" font-size="24" font-weight="700">${snapshot.currentStars.toLocaleString("en-US")} stars</text>`,
		`<text x="864" y="68" text-anchor="end" font-size="13" fill="${colors.muted}">Current total</text>`,
		`<text x="${left}" y="104" font-size="12" fill="${colors.muted}">Cumulative daily star additions</text>`,
	];
	for (let stars = 0; stars <= ceiling; stars += step) {
		elements.push(`<path d="M${left},${y(stars)} H${right}" stroke="${colors.grid}" stroke-width="1"/>`,
			`<text x="${left - 12}" y="${y(stars) + 4}" text-anchor="end" font-size="12" fill="${colors.muted}">${stars.toLocaleString("en-US")}</text>`);
	}
	const ticks = Math.min(4, Math.round((end.time - points[0].time) / DAY));
	for (let i = 0; i <= ticks; i++) {
		const time = points[0].time + Math.round((end.time - points[0].time) / DAY * i / ticks) * DAY;
		elements.push(`<text x="${x(time)}" y="377" text-anchor="middle" font-size="12" fill="${colors.muted}">${formatDate(time)}</text>`);
	}
	elements.push(
		`<path d="${path} L${right},${bottom} L${left},${bottom} Z" fill="${colors.line}" fill-opacity="0.10"/>`,
		`<path d="${path}" fill="none" stroke="${colors.line}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
		`<circle cx="${x(end.time)}" cy="${y(end.stars)}" r="4" fill="${colors.line}"/>`,
		`<text x="36" y="415" font-size="12" fill="${colors.muted}">Source: GitHub API · Scheduled hourly</text>`,
		`<text x="864" y="415" text-anchor="end" font-size="12" fill="${colors.muted}">Updated ${updated} UTC</text>`,
		`<text x="36" y="439" font-size="11" fill="${colors.muted}">Current total excludes removed stars; daily history follows GitHub’s reporting boundaries.</text>`,
		"</g></svg>\n",
	);
	return elements.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const [repository = process.env.GITHUB_REPOSITORY, directory] = process.argv.slice(2);
		if (!repository || !directory) throw new Error("Usage: node scripts/update-star-history.mjs owner/repository output-directory");
		const snapshot = await fetchStarHistory(repository, { token: process.env.GITHUB_TOKEN });
		const files = {
			"star-history-light.svg": renderStarHistory(snapshot, "light"),
			"star-history-dark.svg": renderStarHistory(snapshot, "dark"),
			"star-history.json": `${JSON.stringify(snapshot, null, 2)}\n`,
		};
		await mkdir(directory, { recursive: true });
		for (const [name, contents] of Object.entries(files)) await writeFile(resolve(directory, name), contents);
		console.log(`Generated star history for ${repository}: ${snapshot.currentStars} current stars, ${snapshot.fetchedAt}`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
