/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { fetchStarHistory, toDailyPoints } from "../scripts/update-star-history.mjs";

const sunday = Date.parse("2026-09-06T00:00:00Z") / 1000;
const week = (start = sunday, days = [0, 0, 1, 7, 587, 290, 0]) => ({ week: start, total: days.reduce((a, b) => a + b, 0), days });
const snapshot = (weeks = [week()]) => ({
	repository: "NVlabs/SoL-Pi", fetchedAt: "2026-09-11T14:00:00.000Z", currentStars: 880, weeks,
});

describe("star history generation", () => {
	it("orders weekly pages and omits future days without changing the daily totals to match current stars", () => {
		const data = snapshot([week(), week(sunday - 7 * 86400, [0, 0, 0, 0, 0, 1, 0])]);
		const points = toDailyPoints(data);
		expect(points[0].stars).toBe(0);
		expect(points.at(-1)).toEqual({ time: Date.parse("2026-09-11T00:00:00Z"), stars: 886 });
		expect(points.every((point, i) => i === 0 || point.time > points[i - 1].time)).toBe(true);

	});

	it("provides a finite time range for empty and zero-star histories", () => {
		for (const weeks of [[], [week(sunday, [0, 0, 0, 0, 0, 0, 0])]]) {
			const data = { ...snapshot(weeks), currentStars: 0 };
			expect(toDailyPoints(data).map((point) => point.stars)).toEqual([0, 0]);
			expect(toDailyPoints(data)[1].time).toBeGreaterThan(toDailyPoints(data)[0].time);
		}
	});

	it("rejects corrupt totals, malformed days, and duplicate weeks", () => {
		for (const weeks of [[{ ...week(), total: 0 }], [{ ...week(), days: [1] }],
			[week(), week()], [week(sunday, [-1, 0, 0, 0, 0, 0, 0])]]) {
			expect(() => toDailyPoints(snapshot(weeks))).toThrow(/Invalid/);
		}
	});

	it("fetches beyond a full page and keeps the current count independent", async () => {
		const urls = [];
		const fetcher = async (url) => {
			urls.push(url);
			const body = url.includes("page=1")
				? Array.from({ length: 30 }, (_, i) => week(sunday - i * 7 * 86400, [1, 0, 0, 0, 0, 0, 0]))
				: url.includes("page=2") ? [week(sunday - 30 * 7 * 86400)] : { count: 900 };
			return Response.json(body);
		};
		const result = await fetchStarHistory("NVlabs/SoL-Pi", { fetcher });
		expect(result.weeks).toHaveLength(31);
		expect(result.currentStars).toBe(900);
		expect(urls).toHaveLength(3);
		expect(urls.at(-1)).toBe("https://api.github.com/repos/NVlabs/SoL-Pi/stargazers/count");
	});

	it("fails on HTTP or schema errors instead of producing a blank success", async () => {
		await expect(fetchStarHistory("NVlabs/SoL-Pi", {
			fetcher: async () => new Response("unavailable", { status: 503 }),
		})).rejects.toThrow("HTTP 503");
		await expect(fetchStarHistory("NVlabs/SoL-Pi", {
			fetcher: async () => Response.json({ message: "invalid history" }),
		})).rejects.toThrow("Invalid GitHub history page");
		await expect(fetchStarHistory("NVlabs/SoL-Pi", {
			fetcher: async (url) => Response.json(url.endsWith("/count") ? { count: -1 } : []),
		})).rejects.toThrow("Invalid GitHub star count");
	});
});
