import type {
  TLDefaultColorStyle,
  TLDefaultFillStyle,
  TLDefaultDashStyle,
  TLDefaultSizeStyle,
} from "tldraw";
import {
  DefaultColorStyle,
  DefaultFillStyle,
  DefaultDashStyle,
  DefaultSizeStyle,
  useEditor,
  useValue,
  useActions,
  track,
} from "tldraw";
import { accent, ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { env } from "@orbmeet/ui/tokens/media.stylex";
import { duration, easing } from "@orbmeet/ui/tokens/motion.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { shadows } from "@orbmeet/ui/tokens/shadows.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { leading, text, tracking, weight } from "@orbmeet/ui/tokens/typography.stylex";
import * as stylex from "@stylexjs/stylex";
import { boardDivider, boardPanel, boardPanelHeader, boardTrigger } from "../styles/board";
import { useWhiteboardToolbarContext } from "./whiteboard-toolbar-context";
import { StyleToolIcon } from "./whiteboard-toolbar-icons";
import { WhiteboardToolbarPopover } from "./whiteboard-toolbar-popover";

interface ToolbarPopoverProps {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}

const COLOR_MAP: Record<TLDefaultColorStyle, string> = {
  black: '#1d1d1d', grey: '#808080', 'light-violet': '#c4a3e5',
  violet: '#9e52d9', blue: '#1d90e0', 'light-blue': '#6eb3d9',
  yellow: '#e0c432', orange: '#e08e32', green: '#46a346',
  'light-green': '#78c06e', 'light-red': '#e88a8a', red: '#e05252',
  white: '#ffffff',
};

const styles = stylex.create({
  headerPad: { paddingInline: space.s3, paddingBlock: space.s2 },
  body: {
    padding: space.s3,
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },

  /**
   * One choice among a small set — fill, dash, size, opacity, layer order.
   * Every one of these was a separate class string that had drifted between
   * two radii; they are one control with one shape now.
   */
  option: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: radii.control,
    fontFamily: "inherit",
    cursor: "pointer",
    transitionProperty: "background-color, color, border-color",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  },
  /** A labelled row button ("None / Semi / Solid"). */
  optionFill: { height: space.s8, flexGrow: 1, flexShrink: 1, flexBasis: "0%", gap: space.s1_5 },
  /** A plain tile (dash, size, opacity, layer order). */
  optionTile: { height: space.s7, flexGrow: 1, flexShrink: 1, flexBasis: "0%" },
  optionActive: {
    backgroundColor: accent.a800,
    borderColor: accent.a800,
    color: ink.onDark,
    boxShadow: shadows.hairline,
  },
  optionIdle: {
    backgroundColor: { default: neutral.n100, [env.hoverable]: { default: neutral.n100, ":hover": neutral.n200 } },
    borderColor: { default: "transparent", [env.hoverable]: { default: "transparent", ":hover": neutral.n300 } },
    color: neutral.n700,
  },
  optionLabel: {
    fontSize: text.xs2,
    lineHeight: leading.xs2,
    fontWeight: weight.medium,
  },

  swatchRow: { display: "flex", flexWrap: "wrap", gap: space.s1_5 },
  fillRow: { display: "flex", gap: space.s1 },
  opacityRow: { display: "flex", gap: space.s1_5 },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: space.s3,
  },

  sectionLabel: {
    marginBottom: space.s1_5,
    paddingInline: space.s0_5,
    fontSize: text.xs2,
    lineHeight: leading.xs2,
    fontWeight: weight.semibold,
    textTransform: "uppercase",
    letterSpacing: tracking.wider,
    color: neutral.n400,
  },

  /** The stroke-colour dot itself. The colour is tldraw's, so it stays dynamic. */
  swatch: (color: string) => ({
    width: 16,
    height: 16,
    flexShrink: 0,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: "solid",
    backgroundColor: color,
    cursor: "pointer",
    transitionProperty: "transform, box-shadow",
    transitionDuration: { default: duration.fast, [env.reducedMotion]: "0s" },
    transitionTimingFunction: easing.stiff,
  }),
  swatchActive: {
    transform: "scale(1.25)",
    // A hairline lift plus the old `ring-1 ring-offset-1 ring-accent-800/40`,
    // flattened into one shadow: 1px of white, then the accent ring.
    boxShadow: `${shadows.hairline}, 0 0 0 1px ${surface.raised}, 0 0 0 2px color-mix(in oklab, ${accent.a800} 40%, transparent)`,
  },
  swatchIdle: {
    transform: { default: "none", [env.hoverable]: { default: "none", ":hover": "scale(1.1)" } },
    boxShadow: shadows.hairline,
  },
  /** White needs an edge to be visible on the panel; the rest do not. */
  swatchWhite: { borderColor: neutral.n300 },
  swatchClear: { borderColor: "transparent" },

  sizeDot: (px: number) => ({
    width: px,
    height: px,
    borderRadius: radii.pill,
    backgroundColor: "currentColor",
  }),
});

export const PropertiesPanelToggle = track(function PropertiesPanelToggle({
  isOpen,
  onToggle,
  onClose,
}: ToolbarPopoverProps) {
  const editor = useEditor();
  const { isCompactChrome } = useWhiteboardToolbarContext();
  const compact = !!isCompactChrome;

  const currentColor = useValue('propertiesColor', () => {
    const shared = editor.getSharedStyles().get(DefaultColorStyle);
    if (shared?.type === 'shared') return shared.value;
    return (editor.getInstanceState().stylesForNextShape[DefaultColorStyle.id] as TLDefaultColorStyle) ?? 'black';
  }, [editor]);

  const hasSelected = useValue('hasSelected', () => editor.getSelectedShapes().length > 0, [editor]);
  const actions = useActions();

  const dotColor = COLOR_MAP[currentColor] ?? '#1d1d1d';

  return (
    <WhiteboardToolbarPopover
      label="Shape properties"
      isOpen={isOpen}
      onToggle={onToggle}
      onClose={onClose}
      width={compact ? 260 : 240}
      sx={boardPanel.surface}
      trigger={
        <button
          type="button"
          {...stylex.props(
            boardTrigger.base,
            compact ? boardTrigger.compact : boardTrigger.regular,
            isOpen ? boardTrigger.open : boardTrigger.idle,
          )}
          title="Style"
          aria-label="Style"
        >
          <StyleToolIcon color={dotColor} />
        </button>
      }
    >
        <div {...stylex.props(boardPanelHeader.strip, styles.headerPad)}>
          <span {...stylex.props(boardPanelHeader.title)}>Properties</span>
        </div>
        <div {...stylex.props(styles.body)}>

          {/* Stroke color */}
          <PropertiesSection label="Stroke">
            <div {...stylex.props(styles.swatchRow)}>
              {(['black','red','blue','green','yellow','orange','violet','grey','light-blue','light-green'] as TLDefaultColorStyle[]).map(c => (
                <PanelColorSwatch key={c} value={c} />
              ))}
            </div>
          </PropertiesSection>

          <div {...stylex.props(boardDivider.horizontal)} />

          {/* Fill */}
          <PropertiesSection label="Fill">
            <div {...stylex.props(styles.fillRow)}>
              <FillOption value="none" label="None" />
              <FillOption value="semi" label="Semi" />
              <FillOption value="solid" label="Solid" />
            </div>
          </PropertiesSection>

          <div {...stylex.props(boardDivider.horizontal)} />

          <div {...stylex.props(styles.twoCol)}>
            {/* Stroke style */}
            <PropertiesSection label="Style">
              <div {...stylex.props(styles.fillRow)}>
                <DashOption value="draw" />
                <DashOption value="dashed" />
                <DashOption value="dotted" />
              </div>
            </PropertiesSection>

            {/* Stroke width */}
            <PropertiesSection label="Width">
              <div {...stylex.props(styles.fillRow)}>
                <SizeOption value="s" />
                <SizeOption value="m" />
                <SizeOption value="l" />
                <SizeOption value="xl" />
              </div>
            </PropertiesSection>
          </div>

          <div {...stylex.props(boardDivider.horizontal)} />

          {/* Opacity */}
          <PropertiesSection label="Opacity">
            <OpacitySlider />
          </PropertiesSection>

          {/* Layers — only when shapes selected */}
          {hasSelected && (
            <>
              <div {...stylex.props(boardDivider.horizontal)} />
              <PropertiesSection label="Layers">
                <div {...stylex.props(styles.fillRow)}>
                  {[
                    { id: 'send-to-back', title: 'Send to back', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 11 12 6 7 11" /><polyline points="17 18 12 13 7 18" /></svg> },
                    { id: 'send-backward', title: 'Send backward', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 15 12 10 7 15" /></svg> },
                    { id: 'bring-forward', title: 'Bring forward', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 9 12 14 7 9" /></svg> },
                    { id: 'bring-to-front', title: 'Bring to front', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 6 12 11 7 6" /><polyline points="17 13 12 18 7 13" /></svg> },
                  ].map(({ id, title, icon }) => (
                    <button
                      key={id}
                      type="button"
                       onClick={() => {
                         void actions[id]?.onSelect('toolbar');
                       }}
                      {...stylex.props(styles.option, styles.optionTile, styles.optionIdle)}
                      title={title}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </PropertiesSection>
            </>
          )}
      </div>
    </WhiteboardToolbarPopover>
  );
});

function OpacitySlider() {
  const editor = useEditor();
  const opacity = useValue('opacity', () => {
    const shared = editor.getSharedOpacity();
    if (shared.type === 'shared') return shared.value;
    return editor.getInstanceState().opacityForNextShape;
  }, [editor]);

  const opacities = [
    { value: 0.1, label: '10%' },
    { value: 0.25, label: '25%' },
    { value: 0.5, label: '50%' },
    { value: 0.75, label: '75%' },
    { value: 1, label: '100%' },
  ];

  return (
    <div {...stylex.props(styles.opacityRow)}>
      {opacities.map((op) => (
        <button
          key={op.value}
          type="button"
          onClick={() => {
            editor.setOpacityForNextShapes(op.value);
            editor.setOpacityForSelectedShapes(op.value);
          }}
          {...stylex.props(
            styles.option,
            styles.optionTile,
            styles.optionLabel,
            Math.abs(opacity - op.value) < 0.01 ? styles.optionActive : styles.optionIdle,
          )}
          title={op.label}
        >
          {op.value * 100}%
        </button>
      ))}
    </div>
  );
}

function FillOption({ value, label }: { value: TLDefaultFillStyle; label: string }) {
  const editor = useEditor();
  const sharedFill = useValue('sharedFill', () => {
    const shared = editor.getSharedStyles().get(DefaultFillStyle);
    if (shared?.type === 'shared') return shared.value;
    return editor.getInstanceState().stylesForNextShape[DefaultFillStyle.id] as TLDefaultFillStyle | undefined;
  }, [editor]);
  const isActive = sharedFill === value;

  const fills: Record<string, React.ReactNode> = {
    none: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="12" height="12" rx="2" strokeDasharray="2 2" />
      </svg>
    ),
    semi: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor" fillOpacity="0.3" />
      </svg>
    ),
    solid: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor" />
      </svg>
    ),
    pattern: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
        <circle cx="10" cy="10" r="1" fill="currentColor" />
        <circle cx="6" cy="10" r="1" fill="currentColor" />
        <circle cx="10" cy="6" r="1" fill="currentColor" />
      </svg>
    ),
  };

  return (
    <button
      type="button"
      onClick={() => {
        editor.setStyleForNextShapes(DefaultFillStyle, value);
        editor.setStyleForSelectedShapes(DefaultFillStyle, value);
      }}
      {...stylex.props(
        styles.option,
        styles.optionFill,
        styles.optionLabel,
        isActive ? styles.optionActive : styles.optionIdle,
      )}
      title={label}
    >
      {fills[value]}
      <span {...stylex.props(styles.optionLabel)}>{label}</span>
    </button>
  );
}

function DashOption({ value }: { value: TLDefaultDashStyle }) {
  const editor = useEditor();
  const currentDash = useValue('sharedDash', () => {
    const shared = editor.getSharedStyles().get(DefaultDashStyle);
    if (shared?.type === 'shared') return shared.value;
    return editor.getInstanceState().stylesForNextShape[DefaultDashStyle.id] as TLDefaultDashStyle | undefined;
  }, [editor]);
  const isActive = currentDash === value;

  const dashes: Record<string, React.ReactNode> = {
    draw: (
      <svg width="24" height="8" viewBox="0 0 24 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="0" y1="4" x2="24" y2="4" />
      </svg>
    ),
    dashed: (
      <svg width="24" height="8" viewBox="0 0 24 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="0" y1="4" x2="8" y2="4" />
        <line x1="16" y1="4" x2="24" y2="4" />
      </svg>
    ),
    dotted: (
      <svg width="24" height="8" viewBox="0 0 24 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="4" cy="4" r="1.5" fill="currentColor" />
        <circle cx="12" cy="4" r="1.5" fill="currentColor" />
        <circle cx="20" cy="4" r="1.5" fill="currentColor" />
      </svg>
    ),
  };

  return (
    <button
      type="button"
      onClick={() => {
        editor.setStyleForNextShapes(DefaultDashStyle, value);
        editor.setStyleForSelectedShapes(DefaultDashStyle, value);
      }}
      {...stylex.props(
        styles.option,
        styles.optionFill,
        isActive ? styles.optionActive : styles.optionIdle,
      )}
      title={value}
      aria-label={`Set line style to ${value}`}
    >
      {dashes[value]}
    </button>
  );
}

function SizeOption({ value }: { value: TLDefaultSizeStyle }) {
  const editor = useEditor();
  const currentSize = useValue('sharedSize', () => {
    const shared = editor.getSharedStyles().get(DefaultSizeStyle);
    if (shared?.type === 'shared') return shared.value;
    return editor.getInstanceState().stylesForNextShape[DefaultSizeStyle.id] as TLDefaultSizeStyle | undefined;
  }, [editor]);
  const isActive = currentSize === value;

  const sizes: Record<string, number> = {
    s: 3,
    m: 5,
    l: 7,
    xl: 9,
  };

  return (
    <button
      type="button"
      onClick={() => {
        editor.setStyleForNextShapes(DefaultSizeStyle, value);
        editor.setStyleForSelectedShapes(DefaultSizeStyle, value);
      }}
      {...stylex.props(
        styles.option,
        styles.optionFill,
        isActive ? styles.optionActive : styles.optionIdle,
      )}
      title={value}
      aria-label={`Set drawing size to ${value}`}
    >
      <div {...stylex.props(styles.sizeDot(sizes[value] || 5))} />
    </button>
  );
}

function PropertiesSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div {...stylex.props(styles.sectionLabel)}>{label}</div>
      {children}
    </div>
  );
}

function PanelColorSwatch({ value }: { value: TLDefaultColorStyle }) {
  const editor = useEditor();
  const currentColor = useValue('panelColor', () => {
    const shared = editor.getSharedStyles().get(DefaultColorStyle);
    if (shared?.type === 'shared') return shared.value;
    return editor.getInstanceState().stylesForNextShape[DefaultColorStyle.id] as TLDefaultColorStyle | undefined;
  }, [editor]);
  const isActive = currentColor === value;

  return (
    <button
      type="button"
      onClick={() => {
        editor.setStyleForNextShapes(DefaultColorStyle, value);
        editor.setStyleForSelectedShapes(DefaultColorStyle, value);
      }}
      {...stylex.props(
        styles.swatch(COLOR_MAP[value]),
        isActive ? styles.swatchActive : styles.swatchIdle,
        value === 'white' ? styles.swatchWhite : styles.swatchClear,
      )}
      title={value}
      aria-label={`Color: ${value}`}
    />
  );
}
