import "react";

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "react" {
  interface CSSProperties {
    "--viewport-bottom-mobile"?: string;
    "--viewport-bottom-desktop"?: string;
    "--wb-document-bg"?: string;
    "--whiteboard-toolbar-height"?: string;
    "--whiteboard-toolbar-offset"?: string;
    "--wb-page-rail-band"?: string;
    "--wb-page-rail-width"?: string;
    "--wb-controls-band"?: string;
  }
}
