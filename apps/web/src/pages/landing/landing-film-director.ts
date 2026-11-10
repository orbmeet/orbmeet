/**
 * The landing film's script: one call, told on one GSAP timeline.
 *
 * Nothing in the room moves unless the product would move it. The camera does
 * the rest, and the chat is picked out by dimming what surrounds it, so the
 * film never shows a panel doing something the app can't.
 *
 * Every tween is on the timeline and every frame is redrawn from its state, so
 * seeking to a chapter and looping are both exact.
 */
import gsap from "gsap";
import { handDrawn, inkPath, roughDot, roughRect, roughSquiggle, type Point } from "./landing-film-ink";

const SVG_NS = "http://www.w3.org/2000/svg";
/** The order of the chapter buttons in `landing-film.tsx`. */
const CHAPTERS = ["talk", "board", "orb", "private", "screen", "hangup"] as const;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Shot = readonly [x: number, y: number, w: number, h: number];

const FULL: Shot = [0, 0, 1280, 800];
const BOARD_CLOSE: Shot = [0, 140, 918, 574];
const WIDE_SHOTS: Record<string, Shot> = {
  wide: FULL, talk0: FULL, talk1: FULL, talk2: FULL, board: FULL, sketch: BOARD_CLOSE, chat: [792, 420, 608, 380],
  orb: BOARD_CLOSE, see: FULL, all: FULL, docs: FULL, leave: FULL, d1: FULL, d2: FULL, d3: FULL,
};
const TALL_SHOTS: Record<string, Shot> = {
  wide: FULL, talk0: [12, 161, 412, 515], talk1: [434, 161, 412, 515], talk2: [856, 161, 412, 515], board: [345, 0, 320, 400],
  sketch: [32, 184, 416, 520], chat: [924, 358, 344, 430], orb: [510, 184, 416, 520], see: [32, 184, 416, 520],
  all: [12, 84, 900, 1125], docs: [34, 60, 400, 500], leave: [1080, 0, 200, 250], d1: [34, 200, 400, 500], d2: [440, 200, 400, 500], d3: [846, 200, 400, 500],
};

const TILE_TALK = [
  { left: 12, top: 96, width: 412, height: 580 },
  { left: 434, top: 96, width: 412, height: 580 },
  { left: 856, top: 96, width: 412, height: 580 },
];
const TILE_STRIP = [
  { left: 924, top: 84, width: 108, height: 84 },
  { left: 1042, top: 84, width: 108, height: 84 },
  { left: 1160, top: 84, width: 108, height: 84 },
];
const SPOKEN: readonly [speaker: number, from: number, until: number][] = [[0, 0.45, 2.75], [1, 2.85, 4.95], [2, 5.05, 7], [0, 7.1, 8.7]];

const INK = "#1b1b22";
const GREEN = "#087f5b";
const HIGHLIGHT = "#f5b94c";
const VIOLET = "#5838ee";
const SKETCH: readonly { points: Point[]; color: string; width: number; seed: number; highlighter?: boolean }[] = [
  { points: roughRect(62, 84, 300, 140), color: INK, width: 3.8, seed: 1 },
  { points: roughSquiggle(92, 310, 132), color: INK, width: 2.8, seed: 2 },
  { points: roughSquiggle(92, 250, 176), color: INK, width: 2.8, seed: 3 },
  { points: [[212, 228], [214, 256]], color: INK, width: 3.2, seed: 4 },
  { points: [[203, 247], [214, 258], [224, 246]], color: INK, width: 3.2, seed: 5 },
  { points: roughRect(62, 262, 300, 140), color: INK, width: 3.8, seed: 6 },
  { points: [[88, 332], [300, 330]], color: HIGHLIGHT, width: 48, seed: 7, highlighter: true },
  { points: roughSquiggle(92, 290, 332), color: INK, width: 2.8, seed: 8 },
  { points: [[212, 406], [214, 434]], color: INK, width: 3.2, seed: 9 },
  { points: [[203, 425], [214, 436], [224, 424]], color: INK, width: 3.2, seed: 10 },
  { points: roughRect(62, 440, 300, 140), color: INK, width: 3.8, seed: 11 },
  { points: roughSquiggle(92, 270, 510), color: INK, width: 2.8, seed: 12 },
  { points: [[316, 492], [324, 478], [340, 478], [347, 492], [336, 506], [331, 520]], color: GREEN, width: 4, seed: 13 },
  { points: roughDot(331, 538, 2.5), color: GREEN, width: 4, seed: 14 },
];
const DAYS: readonly [y: number, day: string, plan: string][] = [[84, "Friday", "Train at 6 PM"], [262, "Saturday", "Hike"], [440, "Sunday", "Home at night"]];

export interface FilmControls {
  seek: (chapter: number) => void;
  setPaused: (paused: boolean) => void;
  destroy: () => void;
}

interface FilmOptions {
  /** Called every frame with the running chapter and how far through it is. */
  onFrame: (chapter: number, fraction: number) => void;
}

export function startFilm(root: HTMLElement, { onFrame }: FilmOptions): FilmControls {
  const one = (name: string) => root.querySelector<HTMLElement>(`[data-f="${name}"]`)!;
  const group = (name: string) => Array.from(root.querySelectorAll<HTMLElement>(`[data-g~="${name}"]`));
  const stage = root;
  const camera = one("camera");
  const human = one("human") as unknown as SVGGElement;
  const orbArt = one("orbArt") as unknown as SVGGElement;
  const mayaCursor = one("cMaya");
  const orbCursor = one("cOrb");
  const typed = one("typed");
  const clock = one("clock");
  const scrim = one("spot");

  const narrow = window.matchMedia("(max-width: 700px)").matches;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const film = { speaker: 0, typed: "", typedLength: 0, clock: 0 };
  const wide: Rect = { x: 0, y: 0, w: 1280, h: 800 };
  const tall: Rect = { x: 12, y: 96, w: 412, h: 515 };
  const maya = { x: 420, y: 640, on: 0 };
  const orb = { x: 470, y: 40 };

  const strokes = SKETCH.map((stroke) => {
    const el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("fill", stroke.color);
    if (stroke.highlighter) {
      el.setAttribute("opacity", ".38");
      human.insertBefore(el, human.firstChild);
    } else {
      human.appendChild(el);
    }
    return { el, points: handDrawn(stroke.points, stroke.seed, stroke.highlighter ? 0.5 : 1.15), width: stroke.width, highlighter: stroke.highlighter, p: 0, drawn: -1 };
  });

  const art = (tag: string, attributes: Record<string, string | number>, text?: string) => {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([key, value]) => el.setAttribute(key, String(value)));
    if (text) el.textContent = text;
    orbArt.appendChild(el);
    return el;
  };
  const rail = art("path", { d: "M516 154V510", fill: "none", stroke: "#beb0ff", "stroke-width": 3, "stroke-linecap": "round", pathLength: 1 });
  const dayArt = DAYS.map(([y, day, plan]) => [
    art("rect", { x: 548, y, width: 244, height: 140, rx: 14, fill: "#f5f3ff", stroke: VIOLET, "stroke-width": 2.5, pathLength: 1 }),
    art("circle", { cx: 516, cy: y + 70, r: 11, fill: VIOLET }),
    art("text", { x: 574, y: y + 56, "font-size": 17, "font-weight": 600, fill: "#4527d4" }, day),
    art("text", { x: 574, y: y + 94, "font-size": 28, "font-weight": 600, "letter-spacing": -0.8, fill: "#16161b" }, plan),
  ]);
  const arrow = art("path", { d: "M384 318C410 306 436 306 462 318M451 306L464 319L447 327", fill: "none", stroke: VIOLET, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" });
  const orbParts = [rail, arrow, ...dayArt.flat()];

  const messages = group("message");
  const everyone = group("everyone");
  const privately = group("private");
  const highlights = group("heard");
  const chips = ["c0", "c1", "c2"].map(one);
  const docs = ["d1", "d2", "d3"].map(one);

  gsap.set(messages, { height: 0, autoAlpha: 0 });
  TILE_TALK.forEach((position, index) => { gsap.set(one(`t${index}`), position); });
  gsap.set(one("boardPane"), { autoAlpha: 0, y: 80, rotationX: -14, transformPerspective: 1600, transformOrigin: "50% 100%" });
  gsap.set(one("screenPane"), { autoAlpha: 0, rotationY: 70, transformPerspective: 1600, transformOrigin: "0% 50%" });
  gsap.set(one("chat"), { autoAlpha: 0, x: 380 });
  gsap.set(one("docs"), { autoAlpha: 0 });
  gsap.set(docs, { y: 160, autoAlpha: 0, rotationX: -24, transformPerspective: 1400, transformOrigin: "50% 100%" });
  gsap.set([one("tagHuman"), one("tagOrb"), one("orbFrame"), one("seen"), scrim], { autoAlpha: 0 });
  gsap.set([mayaCursor, orbCursor], { opacity: 0 });
  gsap.set(one("cLeave"), { x: 760, y: 420, autoAlpha: 0, transformOrigin: "0 0" });
  gsap.set(chips, { opacity: 0 });
  gsap.set(orbParts, { opacity: 0 });
  orbParts.filter((el) => el.hasAttribute("pathLength")).forEach((el) => { gsap.set(el, { strokeDasharray: 1.002, strokeDashoffset: 1.002 }); });
  gsap.set(one("caret"), { opacity: 0 });
  gsap.set(root.querySelectorAll('[data-f="l0"] u'), { opacity: 0 });
  if (narrow) gsap.set(one("cap"), { left: 20, width: 396, top: 556, fontSize: 21 });

  const placeCamera = () => {
    const { clientWidth: viewWidth, clientHeight: viewHeight } = stage;
    const shot = viewHeight > viewWidth ? tall : wide;
    const scale = Math.min(viewWidth / shot.w, viewHeight / shot.h);
    camera.style.transform = `translate(${(viewWidth - shot.w * scale) / 2 - shot.x * scale}px,${(viewHeight - shot.h * scale) / 2 - shot.y * scale}px) scale(${scale.toFixed(4)})`;
  };

  const timeline = gsap.timeline({ paused: true, repeat: -1, defaults: { ease: "power3.inOut" }, onUpdate: () => draw() });
  const cut = (name: string, at: number, duration: number, ease = "expo.inOut") => {
    const [ax, ay, aw, ah] = WIDE_SHOTS[name];
    const [bx, by, bw, bh] = TALL_SHOTS[name];
    timeline.to(wide, { x: ax, y: ay, w: aw, h: ah, duration, ease }, at);
    timeline.to(tall, { x: bx, y: by, w: bw, h: bh, duration, ease }, at);
  };
  const say = (el: HTMLElement, at: number) => timeline.to(el, { height: "auto", autoAlpha: 1, duration: 0.55, ease: "power3.out" }, at);
  const spotOn = (at: number) => timeline.to(scrim, { autoAlpha: 1, duration: 0.7, ease: "power2.inOut" }, at + 0.2);
  const spotOff = (at: number) => timeline.to(scrim, { autoAlpha: 0, duration: 0.6, ease: "power2.inOut" }, at);
  const mode = (position: number, at: number) => timeline.to(one("segThumb"), { x: position * 86, duration: 0.5 }, at);
  const type = (text: string, at: number, duration: number) => {
    timeline.set(one("ph"), { autoAlpha: 0 }, at);
    timeline.set(one("caret"), { opacity: 1 }, at);
    timeline.set(film, { typed: text }, at);
    timeline.fromTo(film, { typedLength: 0 }, { typedLength: text.length, duration, ease: "none", immediateRender: false }, at + 0.05);
    const sent = at + duration + 0.2;
    timeline.set(film, { typed: "", typedLength: 0 }, sent);
    timeline.set(one("caret"), { opacity: 0 }, sent);
    timeline.set(one("ph"), { autoAlpha: 1 }, sent);
    return sent;
  };
  const appear = (el: Element, at: number, duration: number) => {
    if (el.hasAttribute("pathLength")) {
      timeline.to(el, { opacity: 1, duration: 0.04, ease: "none" }, at);
      timeline.to(el, { strokeDashoffset: 0, duration, ease: "none" }, at);
    } else {
      timeline.to(el, { opacity: 1, duration: 0.3, ease: "power2.out" }, at);
    }
  };

  timeline.to(one("curtain"), { autoAlpha: 0, duration: 0.6, ease: "none" }, 0);

  /* Talk: the plan is said aloud, in captions, before anyone opens the board. */
  timeline.addLabel("talk", 0);
  SPOKEN.forEach(([speaker, from, until], index) => {
    const line = one(`l${index}`);
    timeline.set(film, { speaker }, from - 0.1);
    [0, 1, 2].forEach((n) => { timeline.set(one(`ring${n}`), { opacity: n === speaker ? 1 : 0 }, from - 0.1); });
    if (index > 0) timeline.to(line, { opacity: 1, duration: 0.2, ease: "none" }, from - 0.05);
    timeline.to(line.querySelectorAll("u"), { opacity: 1, duration: 0.06, ease: "none", stagger: 0.16 }, from);
    if (index < SPOKEN.length - 1) timeline.to(line, { opacity: 0, duration: 0.14, ease: "none" }, until);
    cut(`talk${speaker}`, from - 0.25, 0.7);
    if (narrow) timeline.to(one("cap"), { x: speaker * 422, duration: 0.7, ease: "expo.inOut" }, from - 0.25);
  });
  const [heard1, heard2, heard3] = ["m1", "m2", "m3"].map(one);
  say(heard1, 1.2);
  say(heard2, 3.6);
  say(heard3, 5.8);

  /* Board: Maya sketches while the room watches. */
  const boardAt = 8.8;
  timeline.addLabel("board", boardAt);
  timeline.to(one("cap"), { autoAlpha: 0, y: 30, duration: 0.4 }, boardAt - 0.1);
  mode(1, boardAt);
  timeline.set(film, { speaker: 0 }, boardAt);
  TILE_STRIP.forEach((position, index) => { timeline.to(one(`t${index}`), { ...position, duration: 1, borderRadius: 12 }, boardAt + 0.1 + index * 0.05); });
  timeline.to(one("boardPane"), { autoAlpha: 1, y: 0, rotationX: 0, duration: 1.1, ease: "power3.out" }, boardAt + 0.25);
  timeline.to(one("chat"), { autoAlpha: 1, x: 0, duration: 0.9, ease: "power3.out" }, boardAt + 0.45);
  cut("board", boardAt - 0.1, 0.9);
  cut("sketch", boardAt + 1.15, 1);

  let pen = boardAt + 2.2;
  timeline.to(maya, { on: 1, duration: 0.2, ease: "none" }, pen - 0.2);
  strokes.forEach((stroke) => {
    const duration = Math.min(0.82, 0.14 + (stroke.points.length * 6) / 1500);
    timeline.to(stroke, { p: 1, duration, ease: "sine.inOut" }, pen);
    pen += duration + 0.05;
  });
  timeline.to(maya, { on: 0, duration: 0.25, ease: "none" }, pen);
  timeline.to(one("tagHuman"), { autoAlpha: 1, duration: 0.3, ease: "power2.out" }, pen);

  /* Ask Orb: it reads what was said, then looks at what was drawn. */
  const askAt = pen + 0.75;
  timeline.addLabel("orb", askAt);
  spotOn(askAt + 0.05);
  cut("chat", askAt + 0.05, 1);
  const sent = type("@Orb draw this plan", askAt + 0.75, 1.15);
  say(one("m4"), sent);
  say(one("m5"), sent + 0.35);
  timeline.to(chips[0], { opacity: 1, duration: 0.3, ease: "none" }, sent + 0.45);
  timeline.to(highlights, { color: "#3720a8", backgroundColor: "#dcd3ff", duration: 0.35, ease: "none", stagger: 0.32 }, sent + 0.6);
  const lookAt = sent + 2.1;
  spotOff(lookAt - 0.1);
  cut("see", lookAt - 0.1, 0.95);
  timeline.to(chips[1], { opacity: 1, duration: 0.3, ease: "none" }, lookAt + 0.5);
  timeline.to(one("seen"), { autoAlpha: 1, duration: 0.35, ease: "none" }, lookAt + 0.55);
  timeline.to(one("seen"), { autoAlpha: 0, duration: 0.35, ease: "none" }, lookAt + 1.6);
  cut("orb", lookAt + 1.55, 1);
  [human, one("tagHuman")].forEach((el) => { timeline.to(el, { opacity: 0.28, duration: 0.6, ease: "none" }, lookAt + 1.7); });
  timeline.to(orb, { x: 516, y: 150, duration: 0.5, ease: "power2.out" }, lookAt + 1.75);
  timeline.to(orbCursor, { opacity: 1, duration: 0.25, ease: "none" }, lookAt + 1.75);

  const drawAt = lookAt + 2.2;
  timeline.to(chips[2], { opacity: 1, duration: 0.3, ease: "none" }, drawAt);
  const route: Point[] = [[516, 510]];
  DAYS.forEach(([y]) => route.push([548, y], [792, y], [792, y + 140], [640, y + 78]));
  route.forEach(([x, y], index) => { timeline.to(orb, { x, y, duration: 0.22, ease: "sine.inOut" }, drawAt + index * 0.22); });
  appear(rail, drawAt, 0.3);
  dayArt.forEach(([card, node, day, plan], index) => {
    const at = drawAt + 0.22 + index * 0.88;
    appear(card, at, 0.62);
    appear(node, at, 0.2);
    appear(day, at + 0.5, 0.25);
    appear(plan, at + 0.6, 0.25);
  });
  const doneAt = drawAt + 3.2;
  timeline.to(orbCursor, { opacity: 0, duration: 0.25, ease: "none" }, doneAt - 0.1);
  timeline.to(one("orbFrame"), { autoAlpha: 1, duration: 0.3, ease: "none" }, doneAt);
  timeline.to(one("tagOrb"), { autoAlpha: 1, duration: 0.3, ease: "power2.out" }, doneAt);
  appear(arrow, doneAt + 0.1, 0.35);
  say(one("m6"), doneAt);
  cut("all", doneAt + 0.5, 1);
  [human, one("tagHuman")].forEach((el) => { timeline.to(el, { opacity: 1, duration: 0.5, ease: "none" }, doneAt + 0.4); });

  /* Private Orb: same chat, a thread only this person sees. */
  const privateAt = doneAt + 3;
  timeline.addLabel("private", privateAt);
  spotOn(privateAt);
  cut("chat", privateAt, 1);
  timeline.to(one("tabThumb"), { x: 96, duration: 0.45 }, privateAt + 0.75);
  timeline.to(everyone, { height: 0, autoAlpha: 0, duration: 0.35, ease: "power2.inOut" }, privateAt + 0.75);
  say(one("p0"), privateAt + 0.85);
  const asked = type("What did I miss?", privateAt + 1.15, 0.7);
  say(one("p1"), asked);
  say(one("p2"), asked + 0.8);

  /* Screen: Sam presents, the board swings out of the stage it shared. */
  const screenAt = privateAt + 6;
  timeline.addLabel("screen", screenAt);
  spotOff(screenAt - 0.3);
  mode(2, screenAt);
  timeline.to(one("tabThumb"), { x: 0, duration: 0.45 }, screenAt + 0.1);
  timeline.to(privately, { height: 0, autoAlpha: 0, duration: 0.35 }, screenAt + 0.1);
  timeline.to(everyone, { height: "auto", autoAlpha: 1, duration: 0.5 }, screenAt + 0.3);
  timeline.to(one("boardPane"), { rotationY: -70, autoAlpha: 0, duration: 0.9, transformOrigin: "100% 50%" }, screenAt + 0.1);
  timeline.to(one("screenPane"), { rotationY: 0, autoAlpha: 1, duration: 0.9 }, screenAt + 0.1);
  [0, 1, 2].forEach((n) => { timeline.set(one(`ring${n}`), { opacity: n === 2 ? 1 : 0 }, screenAt); });
  timeline.set(film, { speaker: 2 }, screenAt);
  cut("wide", screenAt, 0.9);

  /* Hang up: the call ends and what it made is already there. */
  const leaveAt = screenAt + 3.6;
  timeline.addLabel("hangup", leaveAt);
  cut("leave", leaveAt - 0.5, 0.9);
  timeline.set(film, { speaker: -1 }, leaveAt + 0.8);
  timeline.to(one("cLeave"), { autoAlpha: 1, x: 1190, y: 48, duration: 0.8, ease: "power2.out" }, leaveAt - 0.4);
  timeline.to(one("leave"), { scale: 0.9, duration: 0.1, ease: "none" }, leaveAt + 0.5);
  timeline.to(one("cLeave"), { scale: 0.85, duration: 0.1, ease: "none" }, leaveAt + 0.5);
  timeline.to(one("leave"), { scale: 1, duration: 0.15, ease: "none" }, leaveAt + 0.62);
  timeline.to(one("cLeave"), { autoAlpha: 0, duration: 0.2, ease: "none" }, leaveAt + 0.7);
  cut("docs", leaveAt + 0.75, 0.9);
  timeline.to(one("room"), { scale: 0.86, rotationX: 18, y: -60, opacity: 0, duration: 0.8, ease: "power3.in", transformPerspective: 1800, transformOrigin: "50% 40%" }, leaveAt + 0.75);
  timeline.to(one("docs"), { autoAlpha: 1, duration: 0.5, ease: "none" }, leaveAt + 1.25);
  timeline.to(docs, { y: 0, autoAlpha: 1, rotationX: 0, duration: 1, ease: "power3.out", stagger: 0.16 }, leaveAt + 1.4);
  timeline.to(one("scrub"), { width: "66%", duration: 4, ease: "none" }, leaveAt + 2.2);
  cut("d1", leaveAt + 2.6, 0.8);
  cut("d2", leaveAt + 4, 0.8);
  cut("d3", leaveAt + 5.4, 0.8);
  const endAt = leaveAt + 7;
  timeline.to(one("curtain"), { autoAlpha: 1, duration: 0.55, ease: "none" }, endAt);
  timeline.addLabel("end", endAt + 0.55);
  timeline.to(film, { clock: endAt + 0.55, duration: endAt + 0.55, ease: "none" }, 0);

  const starts = CHAPTERS.map((name) => timeline.labels[name]);
  const finish = timeline.labels.end;

  function draw(): void {
    placeCamera();
    let active: (typeof strokes)[number] | undefined;
    strokes.forEach((stroke) => {
      const count = Math.round(stroke.p * stroke.points.length);
      if (count !== stroke.drawn) {
        stroke.el.setAttribute("d", count > 1 ? inkPath(stroke.points.slice(0, count), stroke.width) : "");
        stroke.drawn = count;
      }
      if (stroke.p > 0 && stroke.p < 1) active = stroke;
    });
    if (active) {
      const [x, y] = active.points[Math.min(active.points.length - 1, Math.round(active.p * active.points.length))];
      maya.x = x;
      maya.y = y;
    }
    mayaCursor.setAttribute("transform", `translate(${maya.x.toFixed(1)} ${maya.y.toFixed(1)})`);
    mayaCursor.style.opacity = String(maya.on);
    orbCursor.setAttribute("transform", `translate(${orb.x.toFixed(1)} ${orb.y.toFixed(1)})`);
    const text = film.typed.slice(0, Math.round(film.typedLength));
    if (typed.textContent !== text) typed.textContent = text;
    const seconds = 40 + Math.floor(film.clock);
    const time = `${12 + Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    if (clock.textContent !== time) clock.textContent = time;

    const now = timeline.time();
    let chapter = 0;
    starts.forEach((start, index) => {
      if (now >= start) chapter = index;
    });
    const next = starts[chapter + 1] ?? finish;
    onFrame(chapter, Math.min(1, (now - starts[chapter]) / (next - starts[chapter])));
  }

  let paused = still;
  let visible = true;
  let destroyed = false;
  const syncPlayback = () => {
    if (!paused && visible && !destroyed) timeline.play();
    else timeline.pause();
  };

  const resize = new ResizeObserver(draw);
  resize.observe(stage);
  const seen = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncPlayback();
  });
  seen.observe(stage);

  /* The people load last and separately: the film plays without them. */
  let people: Awaited<ReturnType<typeof import("./landing-film-people").startFilmPeople>> = null;
  let frame = 0;
  const canvases = [0, 1, 2].map((n) => one(`canvas${n}`) as unknown as HTMLCanvasElement);
  const recording = one("rec") as unknown as HTMLCanvasElement;
  import("./landing-film-people")
    .then(({ startFilmPeople }) => {
      if (destroyed) return;
      people = startFilmPeople(canvases, recording);
      if (!people) return;
      const loop = (now: number) => {
        if (visible && !document.hidden) people?.draw(now, film.speaker);
        if (!still) frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    })
    .catch(() => {});

  let removeTilt = () => {};
  if (!still && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    const tiltX = gsap.quickTo(stage, "rotationX", { duration: 0.8, ease: "power3" });
    const tiltY = gsap.quickTo(stage, "rotationY", { duration: 0.8, ease: "power3" });
    const move = (event: PointerEvent) => {
      const box = stage.getBoundingClientRect();
      tiltY(((event.clientX - box.left) / box.width - 0.5) * 3.2);
      tiltX(-((event.clientY - box.top) / box.height - 0.5) * 2.4);
    };
    const leave = () => {
      tiltX(0);
      tiltY(0);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerleave", leave);
    removeTilt = () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", leave);
    };
  }

  if (still) {
    timeline.seek(doneAt + 1.5, false);
    draw();
  } else {
    draw();
    syncPlayback();
  }

  return {
    seek(chapter) {
      timeline.seek(CHAPTERS[chapter], false);
      draw();
      syncPlayback();
    },
    setPaused(next) {
      paused = next;
      syncPlayback();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      seen.disconnect();
      removeTilt();
      timeline.kill();
      people?.dispose();
    },
  };
}
