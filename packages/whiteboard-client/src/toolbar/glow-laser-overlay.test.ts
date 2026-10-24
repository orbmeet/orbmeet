import { describe, it, expect, beforeAll } from "vitest";
import {
	svgPathFromPoints,
	buildSmoothLaserPath,
	renderLaserGlow,
	resolveColor,
	ScribblePathHelper,
} from "./glow-laser-overlay";
import type { TLScribble } from "@tldraw/tlschema";

// ─── Path2D polyfill for Node test environment ────────────────────────────────

beforeAll(() => {
	if (typeof Path2D === "undefined") {
		// Minimal Path2D mock — sufficient for construction and reference equality checks.
		(globalThis as any).Path2D = class Path2D {
			constructor(_d?: string) {}
		};
	}
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeScribble(overrides: Partial<TLScribble> = {}): TLScribble {
	return {
		id: "s1",
		points: [],
		size: 4,
		color: "laser",
		opacity: 0.7,
		state: "active",
		delay: 0,
		shrink: 0,
		taper: false,
		...overrides,
	};
}

/** Create a mock CanvasRenderingContext2D that records method calls and property assignments. */
function mockCtx() {
	const calls: Record<string, unknown[][]> = {};

	const store = new Map<string, unknown>();

	const handler: ProxyHandler<CanvasRenderingContext2D> = {
		get(_target, prop: string) {
			if (store.has(prop)) return store.get(prop);
			return (...args: unknown[]) => {
				if (!calls[prop]) calls[prop] = [];
				calls[prop].push(args);
			};
		},
		set(_target, prop: string, value: unknown) {
			store.set(prop, value);
			if (!calls[prop]) calls[prop] = [];
			calls[prop].push([value]);
			return true;
		},
	};

	const ctx = new Proxy({} as CanvasRenderingContext2D, handler);
	return { ctx, calls };
}

const fakeThemeColors = {
	selectionStroke: "#4A90D9",
	selectionFill: "#B5D5F5",
	selectedContrast: "#FFFFFF",
	text: "#000000",
	laser: "#FF0000",
	brushFill: "#CCCCCC",
} as unknown as import("@tldraw/tlschema").TLThemeColors;

// ─── svgPathFromPoints ───────────────────────────────────────────────────────

describe("svgPathFromPoints", () => {
	it("returns empty string for fewer than 2 points", () => {
		expect(svgPathFromPoints([])).toBe("");
		expect(svgPathFromPoints([{ x: 1, y: 2 }])).toBe("");
	});

	it("draws a line for 2 points", () => {
		const result = svgPathFromPoints([
			{ x: 0, y: 0 },
			{ x: 10, y: 10 },
		]);
		expect(result).toContain("M");
		expect(result).toContain("L");
	});

	it("draws a closed quadratic curve for 4+ points (default closed=true)", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		];
		const result = svgPathFromPoints(pts);
		expect(result).toContain("Q");
		expect(result).toContain("T");
		expect(result).toMatch(/Z$/); // closed
	});

	it("draws an open path when closed=false", () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		];
		const result = svgPathFromPoints(pts, false);
		expect(result).toContain("Q");
		expect(result).not.toMatch(/Z$/);
	});

	it("rounds coordinates to 4 decimal places (toDomPrecision)", () => {
		const result = svgPathFromPoints([
			{ x: 1.123456789, y: 2.987654321 },
			{ x: 3.111111111, y: 4.666666666 },
		]);
		expect(result).toContain("1.1235");
		expect(result).toContain("2.9877");
	});
});

// ─── buildSmoothLaserPath ────────────────────────────────────────────────────

describe("buildSmoothLaserPath", () => {
	it("returns an empty Path2D for zero points", () => {
		const path = buildSmoothLaserPath([]);
		// Path2D is opaque; just verify it doesn't throw
		expect(path).toBeInstanceOf(Path2D);
	});

	it("returns a degenerate line for 1 point", () => {
		const path = buildSmoothLaserPath([{ x: 5, y: 5 }]);
		expect(path).toBeInstanceOf(Path2D);
	});

	it("returns a straight line for 2 points", () => {
		const path = buildSmoothLaserPath([
			{ x: 0, y: 0 },
			{ x: 10, y: 10 },
		]);
		expect(path).toBeInstanceOf(Path2D);
	});

	it("returns a smooth curve for 4+ points", () => {
		const path = buildSmoothLaserPath([
			{ x: 0, y: 0 },
			{ x: 10, y: 5 },
			{ x: 20, y: 5 },
			{ x: 30, y: 0 },
			{ x: 40, y: 0 },
		]);
		expect(path).toBeInstanceOf(Path2D);
	});
});

// ─── resolveColor ─────────────────────────────────────────────────────────────

describe("resolveColor", () => {
	it("maps 'laser' to theme laser color", () => {
		expect(resolveColor(fakeThemeColors, "laser")).toBe("#FF0000");
	});

	it("maps 'accent' and 'selection-stroke' to selectionStroke", () => {
		expect(resolveColor(fakeThemeColors, "accent")).toBe("#4A90D9");
		expect(resolveColor(fakeThemeColors, "selection-stroke")).toBe("#4A90D9");
	});

	it("maps 'white' to selectedContrast", () => {
		expect(resolveColor(fakeThemeColors, "white")).toBe("#FFFFFF");
	});

	it("maps 'black' to text", () => {
		expect(resolveColor(fakeThemeColors, "black")).toBe("#000000");
	});

	it("maps 'muted-1' to brushFill", () => {
		expect(resolveColor(fakeThemeColors, "muted-1")).toBe("#CCCCCC");
	});

	it("defaults to text for unknown colors", () => {
		expect(resolveColor(fakeThemeColors, "unknown-color" as any)).toBe("#000000");
	});
});

// ─── renderLaserGlow ──────────────────────────────────────────────────────────

describe("renderLaserGlow", () => {
	it("renders 8 stroke layers", () => {
		const { ctx, calls } = mockCtx();
		const path = new Path2D();

		renderLaserGlow(ctx, path, 1, 4, 0.7);

		// Should have 8 stroke calls (one per glow layer)
		expect(calls.stroke).toHaveLength(8);

		// Each stroke call should receive the Path2D
		for (const args of calls.stroke) {
			expect(args[0]).toBe(path);
		}
	});

	it("sets globalAlpha to the provided opacity", () => {
		const { ctx, calls } = mockCtx();
		const path = new Path2D();

		renderLaserGlow(ctx, path, 1, 4, 0.5);

		// globalAlpha should be set to opacity value at least once
		expect(calls.globalAlpha).toBeDefined();
		expect(calls.globalAlpha[0]).toEqual([0.5]);
	});

	it("scales line widths inversely with zoom", () => {
		const { ctx, calls } = mockCtx();
		const path = new Path2D();

		renderLaserGlow(ctx, path, 2, 4, 0.7);

		// First layer width = (4 * 6.0) / 2 = 12
		expect(calls.lineWidth[0]).toEqual([12]);
	});

	it("saves and restores canvas state", () => {
		const { ctx, calls } = mockCtx();
		const path = new Path2D();

		renderLaserGlow(ctx, path, 1, 4, 0.7);

		expect(calls.save).toHaveLength(1);
		expect(calls.restore).toHaveLength(1);
	});
});

// ─── ScribblePathHelper ──────────────────────────────────────────────────────

describe("ScribblePathHelper", () => {
	const helper = new ScribblePathHelper();

	describe("getPath", () => {
		it("returns null for scribble with no points", () => {
			const scribble = makeScribble({ points: [] });
			expect(helper.getPath(scribble, 1, 0.32)).toBeNull();
		});

		it("returns a Path2D for a scribble with points", () => {
			const scribble = makeScribble({
				points: [
					{ x: 0, y: 0, z: 0.5 },
					{ x: 10, y: 10, z: 0.5 },
					{ x: 20, y: 5, z: 0.5 },
					{ x: 30, y: 15, z: 0.5 },
				],
			});
			const path = helper.getPath(scribble, 1, 0.32);
			expect(path).toBeInstanceOf(Path2D);
		});

		it("returns the same Path2D on a cache hit", () => {
			const scribble = makeScribble({
				id: "cache-hit-test",
				points: [
					{ x: 0, y: 0, z: 0.5 },
					{ x: 10, y: 10, z: 0.5 },
					{ x: 20, y: 5, z: 0.5 },
					{ x: 30, y: 15, z: 0.5 },
				],
			});

			const first = helper.getPath(scribble, 1, 0.32);
			const second = helper.getPath(scribble, 1, 0.32);
			expect(first).toBe(second); // same reference
		});

		it("returns a new Path2D when points change", () => {
			const scribble = makeScribble({
				id: "cache-miss-test",
				points: [
					{ x: 0, y: 0, z: 0.5 },
					{ x: 10, y: 10, z: 0.5 },
					{ x: 20, y: 5, z: 0.5 },
					{ x: 30, y: 15, z: 0.5 },
				],
			});

			const first = helper.getPath(scribble, 1, 0.32);

			// Mutate points
			scribble.points.push({ x: 40, y: 20, z: 0.5 });

			const second = helper.getPath(scribble, 1, 0.32);
			expect(second).not.toBe(first);
		});

		it("returns a new Path2D when zoom changes", () => {
			const scribble = makeScribble({
				id: "zoom-change-test",
				points: [
					{ x: 0, y: 0, z: 0.5 },
					{ x: 10, y: 10, z: 0.5 },
					{ x: 20, y: 5, z: 0.5 },
					{ x: 30, y: 15, z: 0.5 },
				],
			});

			const first = helper.getPath(scribble, 1, 0.32);
			const second = helper.getPath(scribble, 2, 0.32);
			expect(second).not.toBe(first);
		});

		it("returns a new Path2D when state changes", () => {
			const scribble = makeScribble({
				id: "state-change-test",
				state: "active",
				points: [
					{ x: 0, y: 0, z: 0.5 },
					{ x: 10, y: 10, z: 0.5 },
					{ x: 20, y: 5, z: 0.5 },
					{ x: 30, y: 15, z: 0.5 },
				],
			});

			const first = helper.getPath(scribble, 1, 0.32);

			scribble.state = "complete";
			const second = helper.getPath(scribble, 1, 0.32);

			expect(second).not.toBe(first);
		});
	});

	describe("getGlowPath", () => {
		it("returns null for scribble with no points", () => {
			const scribble = makeScribble({ points: [] });
			expect(helper.getGlowPath(scribble, 1)).toBeNull();
		});

		it("returns a Path2D for a laser scribble with points", () => {
			const scribble = makeScribble({
				points: [
					{ x: 0, y: 0, z: 0.5 },
					{ x: 100, y: 100, z: 0.5 },
					{ x: 200, y: 50, z: 0.5 },
				],
			});
			const path = helper.getGlowPath(scribble, 1);
			expect(path).toBeInstanceOf(Path2D);
		});

		it("returns the same Path2D on a cache hit", () => {
			const scribble = makeScribble({
				id: "glow-cache-hit",
				points: [
					{ x: 0, y: 0, z: 0.5 },
					{ x: 100, y: 100, z: 0.5 },
					{ x: 200, y: 50, z: 0.5 },
				],
			});

			const first = helper.getGlowPath(scribble, 1);
			const second = helper.getGlowPath(scribble, 1);
			expect(first).toBe(second);
		});

		it("returns a new Path2D when points change", () => {
			const scribble = makeScribble({
				id: "glow-cache-miss",
				points: [
					{ x: 0, y: 0, z: 0.5 },
					{ x: 100, y: 100, z: 0.5 },
					{ x: 200, y: 50, z: 0.5 },
				],
			});

			const first = helper.getGlowPath(scribble, 1);
			scribble.points.push({ x: 300, y: 75, z: 0.5 });
			const second = helper.getGlowPath(scribble, 1);
			expect(second).not.toBe(first);
		});
	});
});
