/** Load StyleX's CSS refresh runtime after the document hydrates in development. */
export function startDevStyleXRuntime(): void {
  if (!__STYLEX_DEV__) return;
  // The module is provided by @stylexjs/unplugin only while Vite is serving.
  // @ts-expect-error virtual development module
  void import("virtual:stylex:runtime");
}
