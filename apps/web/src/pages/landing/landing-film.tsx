import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { Lock, Monitor, SquarePen, Users } from "lucide-react";
import { BrandMark } from "@orbmeet/ui/react";
import { focus, motion } from "@orbmeet/ui/styles/atoms";
import { accent, border, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { fonts } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import type { FilmControls } from "./landing-film-director";
import { film } from "./landing-film.stylex";

/** In script order; `landing-film-director.ts` seeks by this index. */
const CHAPTERS = ["Talk", "Board", "Ask Orb", "Private Orb", "Screen", "Hang up"];

const CAPTIONS: readonly [who: string, words: string][] = [
  ["Maya", "Let’s get the train on Friday at 6."],
  ["Priya", "Then we hike on Saturday."],
  ["Sam", "And home Sunday night."],
  ["Maya", "Hang on, I’ll sketch it."],
];

const TILES = [
  { name: "Maya", initial: "M" },
  { name: "Priya", initial: "P" },
  { name: "Sam", initial: "S" },
];

const rise = stylex.keyframes({ from: { opacity: 0, transform: "translateY(18px)" }, to: { opacity: 1, transform: "none" } });
const NARROW = "@media (max-width: 700px)";

/**
 * The room is laid out once, at 1280×800, and the director moves a camera over
 * it. Sizes here are that room's pixels, not the screen's.
 */
const styles = stylex.create({
  film: { animationName: { default: rise, [env.reducedMotion]: "none" }, animationDuration: "800ms", animationTimingFunction: "cubic-bezier(.2,.7,.2,1)", animationFillMode: "both" },
  perspective: { perspective: 1800 },
  stage: {
    position: "relative",
    width: { default: "min(100%, 1208px, max(460px, calc((100svh - 186px) * 1.6)))", [NARROW]: "min(100%, max(280px, calc((100svh - 290px) * 0.8)))" },
    aspectRatio: { default: "16 / 10", [NARROW]: "4 / 5" },
    marginInline: "auto",
    overflow: "hidden",
    borderRadius: 22,
    backgroundColor: surface.canvas,
    boxShadow: film.stageShadow,
    transformStyle: "preserve-3d",
  },
  camera: { position: "absolute", left: 0, top: 0, width: 1280, height: 800, transformOrigin: "0 0", fontSize: 15, color: ink.strong, textAlign: "start" },
  curtain: { position: "absolute", zIndex: 10, inset: 0, backgroundColor: surface.canvas, pointerEvents: "none" },
  abs: { position: "absolute" },
  bar: { position: "absolute", zIndex: 3, left: 12, top: 12, width: 1256, height: 60, borderRadius: 16, backgroundColor: surface.raised, fontSize: 14, color: neutral.n700 },
  meta: { position: "absolute", left: 14, top: 10, display: "flex", alignItems: "center", gap: 10 },
  meetingTitle: { fontWeight: 600, color: ink.strong, lineHeight: 1.25 },
  status: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: film.statusText, fontVariantNumeric: "tabular-nums" },
  statusDot: { width: 7, height: 7, borderRadius: "50%", backgroundColor: film.statusDot },
  modes: { position: "absolute", left: 372, top: 10, width: 264, height: 40, padding: 3, display: "flex", borderRadius: 12, backgroundColor: surface.canvas, boxSizing: "border-box" },
  modeThumb: { position: "absolute", left: 3, top: 3, width: 86, height: 34, borderRadius: 9, backgroundColor: surface.raised, boxShadow: film.modeShadow },
  mode: { position: "relative", width: 86, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontWeight: 500 },
  controls: { position: "absolute", left: 660, top: 10, height: 40, display: "flex", alignItems: "center", gap: 2 },
  control: { display: "flex", alignItems: "center", height: 40, paddingInline: 11, whiteSpace: "nowrap" },
  leave: { position: "absolute", right: 10, top: 10, height: 40, paddingInline: 16, display: "flex", alignItems: "center", borderRadius: 12, backgroundColor: film.leave, color: ink.onDark, fontWeight: 600 },

  tile: { position: "absolute", zIndex: 2, overflow: "hidden", borderRadius: 18, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 44, fontWeight: 600 },
  tileMaya: { left: 12, top: 96, width: 412, height: 580, backgroundColor: film.mayaBackdrop, color: film.mayaInitial },
  tilePriya: { left: 434, top: 96, width: 412, height: 580, backgroundColor: film.priyaBackdrop, color: film.priyaInitial },
  tileSam: { left: 856, top: 96, width: 412, height: 580, backgroundColor: film.samBackdrop, color: film.samInitial },
  tileCanvas: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" },
  tileName: { position: "absolute", left: 10, bottom: 10, paddingBlock: 3, paddingInline: 9, borderRadius: 8, backgroundColor: film.nameplate, color: ink.onDark, fontSize: 13, fontWeight: 400 },
  speaking: { position: "absolute", inset: 0, borderRadius: "inherit", boxShadow: film.speakingRing, opacity: 0 },
  firstSpeaking: { opacity: 1 },

  caption: { position: "absolute", zIndex: 3, left: 340, top: 692, width: 600, minHeight: 76, borderRadius: 16, backgroundColor: film.caption, color: ink.onDark, fontSize: 22, lineHeight: 1.3, letterSpacing: "-0.01em" },
  captionLine: { position: "absolute", left: 22, right: 22, top: "50%", transform: "translateY(-50%)" },
  captionHidden: { opacity: 0 },
  captionWho: { fontWeight: 600, marginInlineEnd: 8 },
  word: { textDecorationLine: "none" },

  pane: { position: "absolute", zIndex: 1, left: 12, top: 84, width: 900, height: 704, borderRadius: 18, backgroundColor: surface.board, visibility: "hidden" },
  page: { position: "absolute", left: 28, top: 28, width: 844, height: 648, backgroundColor: film.paper, boxShadow: film.pageShadow },
  svg: { display: "block", width: "100%", height: "100%", fontFamily: fonts.sans },

  presenting: { position: "absolute", left: 18, top: 14, paddingBlock: 6, paddingInline: 12, borderRadius: 9, backgroundColor: ink.strong, color: ink.onDark, fontSize: 13 },
  window: { position: "absolute", left: 44, top: 60, width: 812, height: 612, borderRadius: 14, backgroundColor: surface.raised, overflow: "hidden", boxShadow: film.windowShadow },
  chrome: { height: 42, display: "flex", alignItems: "center", gap: 7, paddingInline: 16, borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: border.subtle, color: ink.muted, fontSize: 13 },
  chromeDot: { width: 10, height: 10, borderRadius: "50%", backgroundColor: border.subtle },
  chromeTitle: { marginInlineStart: 12 },
  site: { paddingBlock: 60, paddingInline: 70, display: "flex", flexDirection: "column", gap: 22 },
  siteTitle: { fontSize: 58, fontWeight: 600, lineHeight: 1.02, letterSpacing: "-0.04em" },
  siteText: { fontSize: 21, color: ink.body, lineHeight: 1.4 },
  siteButton: { alignSelf: "flex-start", paddingBlock: 15, paddingInline: 28, borderRadius: 999, backgroundColor: accent.a600, color: ink.onAccent, fontSize: 18, fontWeight: 500 },

  chat: { position: "absolute", zIndex: 2, left: 924, top: 178, width: 344, height: 610, borderRadius: 18, backgroundColor: surface.raised, overflow: "hidden", display: "flex", flexDirection: "column", visibility: "hidden" },
  chatHead: { display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 14, paddingBottom: 8, paddingInline: 16, fontWeight: 600, fontSize: 16 },
  speech: { display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 500, color: neutral.n800 },
  toggle: { position: "relative", width: 30, height: 18, borderRadius: 9, backgroundColor: accent.a600 },
  toggleKnob: { position: "absolute", right: 2, top: 2, width: 14, height: 14, borderRadius: "50%", backgroundColor: film.paper },
  tabs: { position: "relative", display: "flex", gap: 4, paddingBottom: 10, paddingInline: 12, borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: border.subtle, fontSize: 14, fontWeight: 500 },
  tabThumb: { position: "absolute", left: 12, top: 0, width: 92, height: 34, borderRadius: 10, backgroundColor: accent.a100 },
  tab: { position: "relative", width: 92, height: 34, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 },
  feed: { flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", overflow: "hidden", paddingBottom: 8, paddingInline: 16, lineHeight: 1.42 },
  message: { overflow: "hidden", height: 0, opacity: 0, visibility: "hidden" },
  messageBody: { paddingTop: 13 },
  who: { display: "block", fontSize: 13, fontWeight: 600 },
  whoOrb: { color: accent.a700 },
  time: { fontWeight: 400, color: ink.muted, marginInlineStart: 6 },
  said: { color: neutral.n700 },
  heard: { paddingBlock: 1, paddingInline: 3, marginInline: -3, borderRadius: 5 },
  mine: { display: "flex", justifyContent: "flex-end" },
  mineBubble: { maxWidth: "90%", paddingBlock: 9, paddingInline: 13, borderTopLeftRadius: 15, borderTopRightRadius: 15, borderBottomRightRadius: 4, borderBottomLeftRadius: 15, backgroundColor: accent.a600, color: ink.onAccent },
  mineDark: { backgroundColor: ink.strong },
  bubble: { display: "block", marginTop: 4, paddingBlock: 9, paddingInline: 12, borderRadius: 12, borderWidth: 1, borderStyle: "solid", borderColor: accent.a200, backgroundColor: film.orbBubble, color: neutral.n800 },
  chips: { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5, fontSize: 12, color: neutral.n700 },
  chip: { paddingBlock: 4, paddingInline: 9, borderRadius: 999, backgroundColor: surface.canvas },
  privateRow: { display: "flex", justifyContent: "center" },
  privatePill: { paddingBlock: 5, paddingInline: 12, borderRadius: 999, backgroundColor: surface.canvas, fontSize: 13, color: neutral.n700, display: "flex", alignItems: "center", gap: 6 },
  composer: { position: "relative", marginTop: 6, marginBottom: 12, marginInline: 12, height: 46, paddingInline: 14, borderWidth: 1, borderStyle: "solid", borderColor: accent.a600, borderRadius: 13, display: "flex", alignItems: "center", color: ink.muted, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden" },
  placeholder: { position: "absolute" },
  typed: { color: ink.strong },
  caret: { display: "inline-block", width: 1.5, height: 17, marginInlineStart: 1, backgroundColor: accent.a600, opacity: 0 },
  spot: { position: "absolute", zIndex: 5, left: 924, top: 178, width: 344, height: 610, borderRadius: 18, boxShadow: film.spotlight, pointerEvents: "none", visibility: "hidden" },

  docs: { position: "absolute", left: 0, top: 0, width: 1280, height: 800, backgroundColor: surface.raised, visibility: "hidden" },
  ended: { position: "absolute", left: 0, right: 0, top: 66, textAlign: "center" },
  endedLabel: { display: "block", marginBottom: 6, color: ink.body, fontSize: 17 },
  endedTitle: { display: "block", fontSize: 50, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1.1 },
  doc: { position: "absolute", top: 244, width: 372, height: 416, padding: 18, boxSizing: "border-box", borderWidth: 1, borderStyle: "solid", borderColor: border.subtle, borderRadius: 18, backgroundColor: surface.raised, boxShadow: film.docShadow, display: "flex", flexDirection: "column", gap: 14, visibility: "hidden" },
  docBoard: { left: 48 },
  docNotes: { left: 454 },
  docRecording: { left: 860 },
  docTitle: { marginTop: "auto", fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" },
  docText: { fontSize: 16, lineHeight: 1.45, color: neutral.n700 },
  art: { position: "relative", height: 262, borderRadius: 10, overflow: "hidden", backgroundColor: film.docArt },
  notes: { display: "flex", flexDirection: "column", gap: 12, fontSize: 17, lineHeight: 1.42, color: neutral.n800 },
  notesLabel: { display: "block", fontSize: 14, fontWeight: 600, color: ink.strong, marginBottom: 3 },
  recording: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", backgroundColor: film.mayaBackdrop },
  scrubTrack: { position: "absolute", left: 12, right: 12, bottom: 12, height: 4, borderRadius: 2, backgroundColor: film.scrubTrack },
  scrub: { display: "block", height: 4, width: "12%", borderRadius: 2, backgroundColor: film.paper },

  chapters: { display: "flex", flexWrap: "wrap", justifyContent: "center", columnGap: "clamp(12px, 2.2vw, 30px)", rowGap: 4, marginTop: 4 },
  chapter: {
    position: "relative",
    minHeight: 44,
    paddingTop: 10, paddingBottom: 8,
    paddingInline: 2,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 15,
    color: { default: ink.muted, [env.hoverable]: { default: ink.muted, ":hover": ink.strong } },
  },
  chapterOn: { color: ink.strong, fontWeight: 500 },
  chapterBar: { position: "absolute", left: 0, right: 0, bottom: 3, height: 2, backgroundColor: accent.a600, transform: "scaleX(0)", transformOrigin: "0 50%" },
});

function Pointer({ color, name, labelWidth, f }: { color: string; name: string; labelWidth: number; f: string }) {
  return (
    <g data-f={f}>
      <path d="M0 0L0 22L6 16.5L10.5 26L14.5 24.2L10 15L17.5 15Z" fill={color} stroke="#fff" strokeWidth="1.5" />
      <rect x="16" y="24" width={labelWidth} height="26" rx="13" fill={color} />
      <text x={16 + labelWidth / 2} y="42" textAnchor="middle" fontSize="14" fontWeight="500" fill="#fff">{name}</text>
    </g>
  );
}

function Message({ f, kind, children }: { f: string; kind: "everyone" | "private"; children: ReactNode }) {
  return (
    <div data-f={f} data-g={`message ${kind}`} {...stylex.props(styles.message)}>
      <div {...stylex.props(styles.messageBody)}>{children}</div>
    </div>
  );
}

function Heard({ children }: { children: string }) {
  return <span data-g="heard" {...stylex.props(styles.heard)}>{children}</span>;
}

function Spoken({ f, who, time, children }: { f: string; who: string; time: string; children: ReactNode }) {
  return (
    <Message f={f} kind="everyone">
      <span {...stylex.props(styles.who)}>{who}<time {...stylex.props(styles.time)}>{time}</time></span>
      <span {...stylex.props(styles.said)}>{children}</span>
    </Message>
  );
}

/** Never re-renders once mounted: from then on the director owns these nodes. */
const FilmStage = memo(function FilmStage({ stageRef }: { stageRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={stageRef}
      role="img"
      aria-label="A film of one meeting. In Talk mode three people say their weekend plans, with live captions. In Board mode Maya sketches three rough boxes in black ink. Orb is asked to draw the plan. It reads the transcript, looks at the sketch, and draws a Friday to Sunday timeline beside it in violet, labelled Drawn by Orb. One person privately asks Orb what they missed. In Screen mode Sam presents. When they leave, a PDF of the board, notes and the recording are ready."
      {...stylex.props(styles.stage)}
    >
      <div data-f="camera" {...stylex.props(styles.camera)}>
        <div data-f="room">
          <div data-f="screenPane" {...stylex.props(styles.pane)}>
            <span {...stylex.props(styles.presenting)}>Sam is presenting</span>
            <div {...stylex.props(styles.window)}>
              <div {...stylex.props(styles.chrome)}>
                <i {...stylex.props(styles.chromeDot)} /><i {...stylex.props(styles.chromeDot)} /><i {...stylex.props(styles.chromeDot)} />
                <span {...stylex.props(styles.chromeTitle)}>Trains to Lakeside</span>
              </div>
              <div {...stylex.props(styles.site)}>
                <span {...stylex.props(styles.siteTitle)}>Friday, 6:00 PM</span>
                <span {...stylex.props(styles.siteText)}>Platform 4. Arrives at Lakeside at 8:12 PM.</span>
                <span {...stylex.props(styles.siteButton)}>Book 3 tickets</span>
              </div>
            </div>
          </div>

          <div data-f="boardPane" {...stylex.props(styles.pane)}>
            <div {...stylex.props(styles.page)}>
              <svg viewBox="0 0 844 648" {...stylex.props(styles.svg)}>
                <defs><g id="landing-film-board"><g data-f="human" /><g data-f="orbArt" /></g></defs>
                <use href="#landing-film-board" />
                <g fontSize="15" fontWeight="500">
                  <g data-f="seen"><rect x="44" y="70" width="336" height="524" rx="14" fill="#5838ee" fillOpacity=".07" stroke="#5838ee" strokeWidth="2.5" /></g>
                  <g data-f="tagHuman"><rect x="48" y="34" width="118" height="28" rx="14" fill="#16161b" /><text x="107" y="53" textAnchor="middle" fill="#fff">Maya’s sketch</text></g>
                  <g data-f="orbFrame"><rect x="470" y="50" width="340" height="540" rx="14" fill="none" stroke="#5838ee" strokeWidth="2" strokeDasharray="7 7" /></g>
                  <g data-f="tagOrb"><rect x="470" y="16" width="136" height="28" rx="14" fill="#5838ee" /><circle cx="486" cy="30" r="7" fill="#9580ff" /><text x="500" y="35" fill="#fff">Drawn by Orb</text></g>
                </g>
                <Pointer f="cMaya" color="#047857" name="Maya" labelWidth={58} />
                <Pointer f="cOrb" color="#5838ee" name="Orb" labelWidth={46} />
              </svg>
            </div>
          </div>

          <div data-f="chat" {...stylex.props(styles.chat)}>
            <div {...stylex.props(styles.chatHead)}>
              Chat
              <span {...stylex.props(styles.speech)}>Show speech<i {...stylex.props(styles.toggle)}><i {...stylex.props(styles.toggleKnob)} /></i></span>
            </div>
            <div {...stylex.props(styles.tabs)}>
              <span data-f="tabThumb" {...stylex.props(styles.tabThumb)} />
              <span {...stylex.props(styles.tab)}>Everyone</span>
              <span {...stylex.props(styles.tab)}><BrandMark size={14} />Orb</span>
            </div>
            <div {...stylex.props(styles.feed)}>
              <Spoken f="m1" who="Maya" time="8:42 PM">Let’s get the train on <Heard>Friday at 6</Heard>.</Spoken>
              <Spoken f="m2" who="Priya" time="8:43 PM">Then we <Heard>hike on Saturday</Heard>.</Spoken>
              <Spoken f="m3" who="Sam" time="8:43 PM">And <Heard>home Sunday night</Heard>.</Spoken>
              <Message f="m4" kind="everyone"><div {...stylex.props(styles.mine)}><span {...stylex.props(styles.mineBubble)}>@Orb draw this plan</span></div></Message>
              <Message f="m5" kind="everyone">
                <div {...stylex.props(styles.chips)}>
                  <span data-f="c0" {...stylex.props(styles.chip)}>✓ Reading the transcript</span>
                  <span data-f="c1" {...stylex.props(styles.chip)}>✓ Looking at the board</span>
                  <span data-f="c2" {...stylex.props(styles.chip)}>✓ Drawing 13 shapes</span>
                </div>
              </Message>
              <Message f="m6" kind="everyone">
                <span {...stylex.props(styles.who, styles.whoOrb)}>Orb</span>
                <span {...stylex.props(styles.bubble)}>Done. Friday to Sunday, from what you said and Maya’s sketch.</span>
              </Message>
              <Message f="p0" kind="private"><div {...stylex.props(styles.privateRow)}><span {...stylex.props(styles.privatePill)}><Lock size={13} strokeWidth={2} />Private with Orb</span></div></Message>
              <Message f="p1" kind="private"><div {...stylex.props(styles.mine)}><span {...stylex.props(styles.mineBubble, styles.mineDark)}>What did I miss?</span></div></Message>
              <Message f="p2" kind="private">
                <span {...stylex.props(styles.who, styles.whoOrb)}>Orb<time {...stylex.props(styles.time)}>only you see this</time></span>
                <span {...stylex.props(styles.bubble)}>You’re taking the 6 PM train on Friday, hiking on Saturday, and coming home Sunday night. The plan is on the board.</span>
              </Message>
            </div>
            <div {...stylex.props(styles.composer)}>
              <span data-f="ph" {...stylex.props(styles.placeholder)}>Message everyone</span>
              <span data-f="typed" {...stylex.props(styles.typed)} />
              <i data-f="caret" {...stylex.props(styles.caret)} />
            </div>
          </div>

          {TILES.map((tile, index) => (
            <div key={tile.name} data-f={`t${index}`} {...stylex.props(styles.tile, index === 0 ? styles.tileMaya : index === 1 ? styles.tilePriya : styles.tileSam)}>
              {tile.initial}
              <canvas data-f={`canvas${index}`} width={480} height={480} {...stylex.props(styles.tileCanvas)} />
              <span {...stylex.props(styles.tileName)}>{tile.name}</span>
              <span data-f={`ring${index}`} {...stylex.props(styles.speaking, index === 0 && styles.firstSpeaking)} />
            </div>
          ))}

          <div data-f="cap" {...stylex.props(styles.caption)}>
            {CAPTIONS.map(([who, words], index) => (
              <div key={words} data-f={`l${index}`} {...stylex.props(styles.captionLine, index > 0 && styles.captionHidden)}>
                <strong {...stylex.props(styles.captionWho)}>{who}</strong>
                {words.split(" ").map((word, position) => (
                  <u key={position} {...stylex.props(styles.word, index > 0 && styles.captionHidden)}>{word} </u>
                ))}
              </div>
            ))}
          </div>
          <div data-f="spot" {...stylex.props(styles.spot)} />

          <div {...stylex.props(styles.bar)}>
            <div {...stylex.props(styles.meta)}>
              <BrandMark size={30} />
              <div>
                <div {...stylex.props(styles.meetingTitle)}>Weekend plan</div>
                <div {...stylex.props(styles.status)}><i {...stylex.props(styles.statusDot)} /><span data-f="clock">12:40</span> · Transcribing</div>
              </div>
            </div>
            <div {...stylex.props(styles.modes)}>
              <span data-f="segThumb" {...stylex.props(styles.modeThumb)} />
              <span {...stylex.props(styles.mode)}><Users size={16} strokeWidth={1.8} />Talk</span>
              <span {...stylex.props(styles.mode)}><SquarePen size={16} strokeWidth={1.8} />Board</span>
              <span {...stylex.props(styles.mode)}><Monitor size={16} strokeWidth={1.8} />Screen</span>
            </div>
            <div {...stylex.props(styles.controls)}>
              {["Mute", "Video", "Captions", "Chat", "People 3"].map((label) => (
                <span key={label} {...stylex.props(styles.control)}>{label}</span>
              ))}
            </div>
            <div data-f="leave" {...stylex.props(styles.leave)}>Leave</div>
          </div>
        </div>

        <div data-f="docs" {...stylex.props(styles.docs)}>
          <div {...stylex.props(styles.ended)}>
            <span {...stylex.props(styles.endedLabel)}>Call ended · 31 minutes</span>
            <strong {...stylex.props(styles.endedTitle)}>Everything’s already here.</strong>
          </div>
          <div data-f="d1" {...stylex.props(styles.doc, styles.docBoard)}>
            <div {...stylex.props(styles.art)}><svg viewBox="0 0 844 648" {...stylex.props(styles.svg)}><use href="#landing-film-board" /></svg></div>
            <span {...stylex.props(styles.docTitle)}>The board, as a PDF</span>
            <span {...stylex.props(styles.docText)}>Maya’s sketch and the plan Orb drew.</span>
          </div>
          <div data-f="d2" {...stylex.props(styles.doc, styles.docNotes)}>
            <div {...stylex.props(styles.notes)}>
              <div><span {...stylex.props(styles.notesLabel)}>Summary</span>Train Friday at 6 PM, hike on Saturday, home Sunday night.</div>
              <div><span {...stylex.props(styles.notesLabel)}>Who’s doing what</span>Sam books the tickets. Maya finds the trail.</div>
              <div><span {...stylex.props(styles.notesLabel)}>Transcript</span>Every word said, and searchable.</div>
            </div>
            <span {...stylex.props(styles.docTitle)}>Notes nobody had to take</span>
            <span {...stylex.props(styles.docText)}>No note-taker to invite.</span>
          </div>
          <div data-f="d3" {...stylex.props(styles.doc, styles.docRecording)}>
            <div {...stylex.props(styles.art)}>
              <canvas data-f="rec" width={480} height={480} {...stylex.props(styles.recording)} />
              <div {...stylex.props(styles.scrubTrack)}><i data-f="scrub" {...stylex.props(styles.scrub)} /></div>
            </div>
            <span {...stylex.props(styles.docTitle)}>The recording</span>
            <span {...stylex.props(styles.docText)}>On Pro and Organization.</span>
          </div>
        </div>

        <svg data-f="cLeave" width="34" height="42" viewBox="0 0 18 28" {...stylex.props(styles.abs)}>
          <path d="M0 0L0 22L6 16.5L10.5 26L14.5 24.2L10 15L17.5 15Z" fill="#16161b" stroke="#fff" strokeWidth="1.5" />
        </svg>
      </div>
      <div data-f="curtain" {...stylex.props(styles.curtain)} />
    </div>
  );
});

/**
 * One call, start to finish, in place of a page of claims. The stage is server
 * rendered behind a curtain; the animation and the people load after it.
 */
export function LandingFilm() {
  const stageRef = useRef<HTMLDivElement>(null);
  const controls = useRef<FilmControls | null>(null);
  const bars = useRef<(HTMLElement | null)[]>([]);
  const [chapter, setChapter] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import("./landing-film-director")
      .then(({ startFilm }) => {
        if (cancelled || !stageRef.current) return;
        controls.current = startFilm(stageRef.current, {
          onFrame: (current, fraction) => {
            setChapter(current);
            bars.current.forEach((bar, index) => {
              if (bar) bar.style.transform = `scaleX(${index === current ? fraction.toFixed(3) : 0})`;
            });
          },
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controls.current?.destroy();
      controls.current = null;
    };
  }, []);

  const togglePaused = useCallback(() => {
    setPaused((was) => {
      controls.current?.setPaused(!was);
      return !was;
    });
  }, []);

  return (
    <div {...stylex.props(styles.film)}>
      <div {...stylex.props(styles.perspective)}>
        <FilmStage stageRef={stageRef} />
      </div>
      <div {...stylex.props(styles.chapters)}>
        {CHAPTERS.map((label, index) => (
          <button
            key={label}
            type="button"
            aria-current={chapter === index ? "step" : undefined}
            onClick={() => controls.current?.seek(index)}
            {...stylex.props(styles.chapter, chapter === index && styles.chapterOn, focus.ring, motion.tint)}
          >
            {label}
            <i ref={(el) => { bars.current[index] = el; }} {...stylex.props(styles.chapterBar)} />
          </button>
        ))}
        <button type="button" onClick={togglePaused} {...stylex.props(styles.chapter, focus.ring, motion.tint)}>
          {paused ? "Play" : "Pause"}
        </button>
      </div>
    </div>
  );
}
