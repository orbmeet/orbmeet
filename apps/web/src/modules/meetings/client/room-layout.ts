/**
 * Where the room puts its people and its panel, as data.
 *
 * Two questions decide most of the room's layout once a board or a shared
 * screen has the stage: which panel is showing beside it, and where the
 * faces go. Answering both here keeps every face in exactly one place.
 */
import type { MeetingSidePanel } from "./use-meeting-ui";

/** The panel's tabs. Faces are not one: they have a place of their own. */
export type MeetingSideColumnTab = "people" | "timeline";

/**
 * Where the faces are.
 *
 * - `stage`   Talk: the faces are the stage.
 * - `column`  on a wide screen with content on the stage: the top of the
 *             column beside it, over the Conversation or People. The column
 *             stays while content is up, panel open or not, so the board is
 *             fitted once and never re-fitted when the Conversation opens.
 * - `row`     under the content, the full width, on a phone or an upright
 *             tablet: an upright board is short and leaves height spare.
 * - `panel`   in the People panel under the content on an upright tablet,
 *             where each face has its actions.
 * - `none`    a phone on its side: the board needs every pixel of a short
 *             screen, and People is one press away in the rail.
 */
type FacesPlacement = "stage" | "column" | "row" | "panel" | "none";

/**
 * Where the panel sits.
 *
 * - `side`   a column beside the stage: landscape screens.
 * - `below`  a band under the content, the full width of the screen: an
 *            upright tablet, whose width is the page's and whose height has
 *            room to spare. The same panel, turned to fit.
 */
type PanelPlacement = "side" | "below";

export interface RoomLayoutInput {
  /** Phones and upright tablets show panels as bottom sheets, not a side column. */
  usesBottomSheets: boolean;
  isPhone: boolean;
  isLandscape: boolean;
  /** The board or a shared screen has the stage. */
  contentOnStage: boolean;
  panel: MeetingSidePanel | null;
}

export interface RoomLayout {
  tabs: MeetingSideColumnTab[];
  /** The tab showing in the panel, or null when the panel is closed. */
  active: MeetingSideColumnTab | null;
  /** Where the panel is, while one is showing. */
  placement: PanelPlacement | null;
  faces: FacesPlacement;
}

export function selectRoomLayout(input: RoomLayoutInput): RoomLayout {
  // An upright tablet docks its panel under the stage, the full width, where
  // a sheet would cover the people or the board being talked about. In Talk
  // that panel is the Conversation; People stays a sheet there, since the
  // people are the stage.
  const below = input.usesBottomSheets && !input.isPhone;
  // A wide screen's panel is beside the stage: the Conversation, and People
  // as a list — who is here, muted or not, what can be done about them, and
  // the door.
  const side = !input.usesBottomSheets;
  const tabs: MeetingSideColumnTab[] = side
    ? ["timeline", "people"]
    : below
      ? input.contentOnStage
        ? ["people", "timeline"]
        : ["timeline"]
      : [];
  const active = input.panel && tabs.includes(input.panel) ? input.panel : null;
  const placement = active ? (below ? "below" : "side") : null;
  return { tabs, active, placement, faces: selectFacesPlacement(input, side, active) };
}

function selectFacesPlacement(
  input: RoomLayoutInput,
  side: boolean,
  active: MeetingSideColumnTab | null,
): FacesPlacement {
  if (!input.contentOnStage) return "stage";
  if (side) return "column";
  // Under an upright board, People is where the faces live, as live tiles.
  if (active === "people") return "panel";
  if (input.isPhone && input.isLandscape) return "none";
  return "row";
}

/**
 * The panel to open when content takes the stage, or null to leave it closed.
 *
 * The Conversation beside a wide screen's board, under the faces, so what is
 * said and written stays in view with who is saying it. People under an
 * upright tablet's board, so the faces stay in view. A phone has no room for
 * a panel: its faces and the Conversation's latest line sit under the board.
 */
export function selectContentPanel(input: { isPhone: boolean; usesBottomSheets: boolean }): MeetingSideColumnTab | null {
  if (!input.usesBottomSheets) return "timeline";
  return input.isPhone ? null : "people";
}
