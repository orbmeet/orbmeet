import * as stylex from "@stylexjs/stylex";
import { ink, neutral, surface } from "@orbmeet/ui/tokens/colors.stylex";
import { radii } from "@orbmeet/ui/tokens/radii.stylex";
import { space } from "@orbmeet/ui/tokens/space.stylex";
import { text, weight } from "@orbmeet/ui/tokens/typography.stylex";

/** Shared rhythm for the three workspace libraries; the home page owns its layout. */
export const collection = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.s6 },
  header: { marginBottom: space.s2 },
  toolbar: {
    display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between",
    gap: space.s3, paddingBottom: space.s4,
    borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: neutral.n150,
  },
  label: { margin: 0, fontSize: text.sm, fontWeight: weight.medium, color: ink.body },
  count: { marginLeft: space.s2, fontSize: text.xs, fontWeight: weight.normal, color: ink.muted },
  grid: {
    display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 17rem), 1fr))",
    gap: space.s5, alignItems: "stretch",
  },
  empty: {
    borderWidth: 1, borderStyle: "dashed", borderColor: neutral.n300,
    borderRadius: radii.card, backgroundColor: surface.raised, paddingBlock: space.s9,
  },
});
