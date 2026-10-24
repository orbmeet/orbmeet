import "react";

declare module "react" {
  interface CSSProperties {
    "--spotlight-x"?: string;
    "--spotlight-y"?: string;
    "--spotlight-color"?: string;
    "--viewport-bottom-mobile"?: string;
    "--viewport-bottom-desktop"?: string;
    "--wb-document-bg"?: string;
    "--whiteboard-toolbar-height"?: string;
    "--whiteboard-toolbar-offset"?: string;
    /** Band reserved by the whiteboard's page rail; overlays clear it. */
    "--wb-page-rail-band"?: string;
    "--wb-page-rail-width"?: string;
    "--wb-controls-band"?: string;
    "--voice"?: string;
    /** Width of the docked participant rail; its tiles size themselves from it. */
    "--rail-width"?: string;
    /** Width of a participant rail docked beside the stage; see MeetingShell. */
    "--chrome-right"?: string;
  }
}
