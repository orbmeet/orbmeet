import type { Editor } from "tldraw";

export function applyOrbmeetTldrawTheme(editor: Editor) {
  editor.updateThemes((themes) => {
    const t = themes.default;
    return {
      ...themes,
      default: {
        ...t,
        colors: {
          light: {
            ...t.colors.light,
            black: {
              ...t.colors.light.black,
              highlightSrgb: "#555555",
              highlightP3: "color(display-p3 0.333 0.333 0.333)",
            },
          },
          dark: {
            ...t.colors.dark,
            black: {
              ...t.colors.dark.black,
              highlightSrgb: "#aaaaaa",
              highlightP3: "color(display-p3 0.667 0.667 0.667)",
            },
          },
        },
      },
    };
  });
}
