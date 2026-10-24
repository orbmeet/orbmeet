import {
	ScribbleOverlayUtil,
	CollaboratorScribbleOverlayUtil,
	type TLScribbleOverlay,
	type TLCollaboratorScribbleOverlay,
	getStroke,
} from "tldraw";
import type { TLScribble, TLThemeColors, TLCanvasUiColor } from "@tldraw/tlschema";

// ─── Path builder (for polygon outlines from getStroke) ──────────────────────

/**
 * Matches upstream `getSvgPathFromPoints` from `@tldraw/editor`.
 * Kept local because that function is not exported from the `tldraw` package.
 *
 * Uses `toDomPrecision` rounding to match upstream exactly.
 */
export function svgPathFromPoints(points: Array<{ x: number; y: number }>, closed = true): string {
	const len = points.length;
	if (len < 2) return "";
	if (len === 2) return `M${precise(points[0])}L${precise(points[1])}`;

	let tail = "";
	for (let i = 2, max = len - 1; i < max; i++) {
		tail += average(points[i], points[i + 1]);
	}

	if (closed) {
		return (
			`M${average(points[0], points[1])}` +
			`Q${precise(points[1])}${average(points[1], points[2])}` +
			`T${tail}` +
			`${average(points[len - 1], points[0])}` +
			`${average(points[0], points[1])}Z`
		);
	}
	return (
		`M${precise(points[0])}` +
		`Q${precise(points[1])}${average(points[1], points[2])}` +
		`${len > 3 ? "T" : ""}${tail}` +
		`L${precise(points[len - 1])}`
	);
}

/** Round to 4 decimal places — matches upstream `toDomPrecision`. */
function toDomPrecision(v: number): number {
	return Math.round(v * 1e4) / 1e4;
}

function precise(v: { x: number; y: number }): string {
	return `${toDomPrecision(v.x)},${toDomPrecision(v.y)} `;
}

function average(a: { x: number; y: number }, b: { x: number; y: number }): string {
	return `${toDomPrecision((a.x + b.x) / 2)},${toDomPrecision((a.y + b.y) / 2)} `;
}

// ─── Linear easing (matches upstream EASINGS.linear) ─────────────────────────

/**
 * Identity easing function — matches upstream `EASINGS.linear`.
 * Kept local because `EASINGS` is not exported from the `tldraw` package.
 *
 * Used in `getStroke` `start` option to match upstream `ScribbleOverlayUtil`
 * taper behavior for non-laser scribbles (eraser, lasso).
 */
const linearEasing = (t: number): number => t;

// ─── Cache types ─────────────────────────────────────────────────────────────

interface CacheEntry {
	len: number;
	lastX: number;
	lastY: number;
	zoom: number;
	size: number;
	taper: boolean;
	state: TLScribble["state"];
	path: Path2D;
}

interface LaserCacheEntry {
	len: number;
	lastX: number;
	lastY: number;
	zoom: number;
	state: TLScribble["state"];
	glowPath: Path2D;
}

const MAX_CACHE = 500;

/** Evict the oldest half of a Map cache instead of clearing everything. */
function evictOldest<K, V>(cache: Map<K, V>): void {
	const evictCount = Math.floor(cache.size / 2);
	let i = 0;
	for (const key of cache.keys()) {
		if (i >= evictCount) break;
		cache.delete(key);
		i++;
	}
}

// ─── Color resolution ────────────────────────────────────────────────────────

export function resolveColor(colors: TLThemeColors, color: TLCanvasUiColor): string {
	switch (color) {
		case "accent":
		case "selection-stroke":
			return colors.selectionStroke;
		case "selection-fill":
			return colors.selectionFill;
		case "white":
			return colors.selectedContrast;
		case "black":
			return colors.text;
		case "laser":
			return colors.laser;
		case "muted-1":
			return colors.brushFill;
		default:
			return colors.text;
	}
}

// ─── Smooth laser centerline ─────────────────────────────────────────────────

/**
 * Build a smooth centerline Path2D from raw scribble points using quadratic
 * Bezier interpolation through midpoints.
 */
export function buildSmoothLaserPath(pts: Array<{ x: number; y: number }>): Path2D {
	const len = pts.length;
	if (len === 0) return new Path2D();

	if (len === 1) {
		return new Path2D(`M${pts[0].x},${pts[0].y} L${pts[0].x},${pts[0].y}`);
	}

	if (len === 2) {
		return new Path2D(`M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`);
	}

	let d = `M${pts[0].x},${pts[0].y} `;
	d += `Q${pts[1].x},${pts[1].y} ${(pts[1].x + pts[2].x) / 2},${(pts[1].y + pts[2].y) / 2} `;

	if (len > 3) {
		d += "T";
		for (let i = 2; i < len - 2; i++) {
			d += `${(pts[i].x + pts[i + 1].x) / 2},${(pts[i].y + pts[i + 1].y) / 2} `;
		}
		d += `${(pts[len - 2].x + pts[len - 1].x) / 2},${(pts[len - 2].y + pts[len - 1].y) / 2} `;
	}

	d += `L${pts[len - 1].x},${pts[len - 1].y}`;

	return new Path2D(d);
}

// ─── Laser renderer ──────────────────────────────────────────────────────────

/**
 * Render a laser pointer as a GoodNotes-style neon tube.
 *
 * GoodNotes = DEEP FLUORESCENT RED dominates + WIDE visible glow + THIN bright white filament.
 * White core must be THIN (~25-35% of red body), not thick.
 */
export function renderLaserGlow(
	ctx: CanvasRenderingContext2D,
	glowPath: Path2D,
	zoom: number,
	size: number,
	opacity: number,
) {
	ctx.save();
	ctx.globalAlpha = opacity;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	// ── Layer 1: FAR outer aura ───────────────────────────────────────
	ctx.lineWidth = (size * 6.0) / zoom;
	ctx.strokeStyle = "rgba(255, 32, 12, 0.14)";
	ctx.stroke(glowPath);

	// ── Layer 2: Wide glow zone ───────────────────────────────────────
	ctx.lineWidth = (size * 4.6) / zoom;
	ctx.strokeStyle = "rgba(255, 36, 15, 0.22)";
	ctx.stroke(glowPath);

	// ── Layer 3: Medium glow ──────────────────────────────────────────
	ctx.lineWidth = (size * 3.5) / zoom;
	ctx.strokeStyle = "rgba(255, 42, 20, 0.34)";
	ctx.stroke(glowPath);

	// ── Layer 4: Inner glow ──────────────────────────────────────────
	ctx.lineWidth = (size * 2.6) / zoom;
	ctx.strokeStyle = "rgba(255, 48, 24, 0.55)";
	ctx.stroke(glowPath);

	// ── Layer 5: Main body: DEEP FLUORESCENT RED (the dominant layer!) ──
	ctx.lineWidth = (size * 1.85) / zoom;
	ctx.strokeStyle = "rgba(255, 52, 28, 0.97)";
	ctx.stroke(glowPath);

	// ── Layer 6: Inner edge (still deep red) ───────────────────────────
	ctx.lineWidth = (size * 1.35) / zoom;
	ctx.strokeStyle = "rgba(255, 70, 45, 0.94)";
	ctx.stroke(glowPath);

	// ── Layer 7: THIN white hot filament (only ~35% of red body!) ──────
	ctx.lineWidth = (size * 0.58) / zoom;
	ctx.strokeStyle = "rgba(255, 255, 254, 1.0)";
	ctx.stroke(glowPath);

	// ── Layer 8: Hot center spine ─────────────────────────────────────
	ctx.lineWidth = (size * 0.22) / zoom;
	ctx.strokeStyle = "rgba(255, 255, 255, 1.0)";
	ctx.stroke(glowPath);

	ctx.restore();
}

// ─── Shared path cache ───────────────────────────────────────────────────────

/**
 * Encapsulates the caching and path-building logic shared between
 * `GlowLaserOverlayUtil` and `GlowCollaboratorLaserOverlayUtil`.
 *
 * Two separate caches:
 * - `_cache` for non-laser scribbles (eraser, lasso) — uses `getStroke` outlines
 * - `_laserCache` for laser scribbles — uses smooth centerline paths
 */
export class ScribblePathHelper {
	private readonly _cache = new Map<string, CacheEntry>();
	private readonly _laserCache = new Map<string, LaserCacheEntry>();

	/** Build (or retrieve from cache) a Path2D for non-laser scribbles. */
	getPath(scribble: TLScribble, zoom: number, streamline: number): Path2D | null {
		const ptsLen = scribble.points.length;
		if (!ptsLen) return null;

		const last = scribble.points[ptsLen - 1];
		const cached = this._cache.get(scribble.id);

		if (
			cached &&
			cached.len === ptsLen &&
			cached.lastX === last.x &&
			cached.lastY === last.y &&
			cached.zoom === zoom &&
			cached.size === scribble.size &&
			cached.taper === scribble.taper &&
			cached.state === scribble.state
		) {
			return cached.path;
		}

		const outline = getStroke(scribble.points, {
			size: scribble.size / zoom,
			start: { taper: scribble.taper, easing: linearEasing },
			last: scribble.state === "complete" || scribble.state === "stopping",
			simulatePressure: false,
			streamline,
		});

		let d: string;
		if (outline.length < 4) {
			const r = scribble.size / zoom / 2;
			const { x, y } = last;
			d = `M ${x - r},${y} a ${r},${r} 0 1,0 ${r * 2},0 a ${r},${r} 0 1,0 ${-r * 2},0`;
		} else {
			d = svgPathFromPoints(outline);
		}

		const path = new Path2D(d);
		this._cache.delete(scribble.id);
		this._cache.set(scribble.id, {
			len: ptsLen,
			lastX: last.x,
			lastY: last.y,
			zoom,
			size: scribble.size,
			taper: scribble.taper,
			state: scribble.state,
			path,
		});
		if (this._cache.size > MAX_CACHE) evictOldest(this._cache);
		return path;
	}

	/** Build (or retrieve from cache) the glow path for a laser scribble. */
	getGlowPath(scribble: TLScribble, zoom: number): Path2D | null {
		const ptsLen = scribble.points.length;
		if (!ptsLen) return null;

		const last = scribble.points[ptsLen - 1];
		const cached = this._laserCache.get(scribble.id);

		if (
			cached &&
			cached.len === ptsLen &&
			cached.lastX === last.x &&
			cached.lastY === last.y &&
			cached.zoom === zoom &&
			cached.state === scribble.state
		) {
			return cached.glowPath;
		}

		const glowPath = buildSmoothLaserPath(scribble.points);

		this._laserCache.delete(scribble.id);
		this._laserCache.set(scribble.id, {
			len: ptsLen,
			lastX: last.x,
			lastY: last.y,
			zoom,
			state: scribble.state,
			glowPath,
		});
		if (this._laserCache.size > MAX_CACHE) evictOldest(this._laserCache);

		return glowPath;
	}
}

// ─── Glow laser overlay ──────────────────────────────────────────────────────

/**
 * Replaces the default `ScribbleOverlayUtil` to add a laser glow effect on
 * laser-pointer scribbles.  Non-laser scribbles (eraser, lasso) render
 * identically to the built-in util.
 *
 * The laser is rendered as layered strokes with additive blending,
 * creating a smooth radial gradient from bright center to soft edge.
 */
export class GlowLaserOverlayUtil extends ScribbleOverlayUtil {
	static override type = "scribble" as const;

	private readonly _helper = new ScribblePathHelper();

	override render(ctx: CanvasRenderingContext2D, overlays: TLScribbleOverlay[]): void {
		const zoom = this.editor.getZoomLevel();
		const colors =
			this.editor.getCurrentTheme().colors[this.editor.getColorMode()];
		const streamline = this.options.streamline ?? 0.32;

		for (const overlay of overlays) {
			const { scribble } = overlay.props;
			if (!scribble.points.length) continue;

			if (scribble.color === "laser") {
				const glowPath = this._helper.getGlowPath(scribble, zoom);
				if (glowPath) {
					renderLaserGlow(ctx, glowPath, zoom, scribble.size, scribble.opacity);
				}
			} else {
				const path = this._helper.getPath(scribble, zoom, streamline);
				if (!path) continue;
				const fillColor = resolveColor(colors, scribble.color);
				ctx.fillStyle = fillColor;
				ctx.globalAlpha = scribble.opacity;
				ctx.fill(path);
				ctx.globalAlpha = 1;
			}
		}
	}
}

// ─── Collaborator glow laser overlay ─────────────────────────────────────────

/**
 * Replaces the default `CollaboratorScribbleOverlayUtil` to add the same laser
 * glow effect on remote participants' laser-pointer scribbles.  Non-laser
 * collaborator scribbles (eraser, lasso) render identically to the built-in util.
 */
export class GlowCollaboratorLaserOverlayUtil extends CollaboratorScribbleOverlayUtil {
	static override type = "collaborator_scribble" as const;

	private readonly _helper = new ScribblePathHelper();

	override render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorScribbleOverlay[]): void {
		const zoom = this.editor.getZoomLevel();
		const streamline = this.options.streamline ?? 0.32;

		for (const overlay of overlays) {
			const { scribble, color } = overlay.props;
			if (!scribble.points.length) continue;

			if (scribble.color === "laser") {
				const glowPath = this._helper.getGlowPath(scribble, zoom);
				if (glowPath) {
					renderLaserGlow(ctx, glowPath, zoom, scribble.size, scribble.opacity);
				}
			} else {
				const path = this._helper.getPath(scribble, zoom, streamline);
				if (!path) continue;
				ctx.fillStyle = color;
				ctx.globalAlpha = 0.1;
				ctx.fill(path);
				ctx.globalAlpha = 1;
			}
		}
	}
}
