/**
 * The hand in the landing film. Strokes are polylines jittered like a person's
 * line and drawn as filled outlines, so they swell and taper the way ink does.
 */
export type Point = readonly [x: number, y: number];

function noise(i: number, seed: number): number {
  return Math.sin(i * 0.19 + seed) * 0.9 + Math.sin(i * 0.47 + seed * 2.3) * 0.6 + Math.sin(i * 0.083 + seed * 0.7) * 0.8;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Walks a polyline every six units, wobbling each step by up to about `wobble`. */
export function handDrawn(points: readonly Point[], seed: number, wobble: number): Point[] {
  const out: Point[] = [];
  let step = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const count = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 6));
    for (let j = 0; j < count; j++) {
      const t = j / count;
      out.push([ax + (bx - ax) * t + noise(step, seed) * wobble, ay + (by - ay) * t + noise(step + 40, seed + 3) * wobble]);
      step++;
    }
  }
  const [ex, ey] = points[points.length - 1];
  out.push([ex + noise(step, seed) * wobble, ey + noise(step + 40, seed + 3) * wobble]);
  return out;
}

/** A closed outline around the points, as an SVG path. Fewer than two points draw nothing. */
export function inkPath(points: readonly Point[], base: number): string {
  const count = points.length;
  if (count < 2) return "";
  const left: Point[] = [];
  const right: Point[] = [];
  let width = base;
  for (let i = 0; i < count; i++) {
    const [ax, ay] = points[Math.max(0, i - 1)];
    const [bx, by] = points[Math.min(count - 1, i + 1)];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) || 1;
    width += (base * (1 + 0.28 * Math.sin(i * 0.13)) - width) * 0.3;
    const taper = Math.min(1, (i + 1) / 6, (count - i) / 6);
    const half = (width * (0.4 + 0.6 * taper)) / 2;
    const nx = -dy / length;
    const ny = dx / length;
    left.push([round(points[i][0] + nx * half), round(points[i][1] + ny * half)]);
    right.push([round(points[i][0] - nx * half), round(points[i][1] - ny * half)]);
  }
  const outline = left.concat(right.reverse());
  let d = `M${outline[0][0]} ${outline[0][1]}`;
  for (let i = 1; i < outline.length - 1; i++) {
    const [x, y] = outline[i];
    const [nextX, nextY] = outline[i + 1];
    d += `Q${x} ${y} ${round((x + nextX) / 2)} ${round((y + nextY) / 2)}`;
  }
  return `${d}Z`;
}

export function roughRect(x: number, y: number, w: number, h: number): Point[] {
  return [[x + 2, y - 1], [x + w - 1, y + 1], [x + w + 1, y + h - 1], [x - 1, y + h + 1], [x + 2, y + 3]];
}

export function roughSquiggle(fromX: number, toX: number, y: number): Point[] {
  const points: Point[] = [];
  let up = 1;
  for (let x = fromX; x < toX; x += 13) {
    points.push([x, y + up * 5]);
    up = -up;
  }
  return points;
}

export function roughDot(cx: number, cy: number, radius: number): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= 46; i++) {
    const angle = -2.4 + (i / 46) * 6.6;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return points;
}
