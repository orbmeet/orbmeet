import { atom, type Atom, type Editor } from "tldraw";

/**
 * Whether this viewer has Show sources on. It is a way of looking at the
 * board, not a change to it, so it stays in this tab: never synced, never
 * stored, and off again on the next visit.
 */
const showSourcesByEditor = new WeakMap<Editor, Atom<boolean>>();

function showSourcesAtom(editor: Editor): Atom<boolean> {
  let value = showSourcesByEditor.get(editor);
  if (!value) {
    value = atom("show sources", false);
    showSourcesByEditor.set(editor, value);
  }
  return value;
}

export function isShowingSources(editor: Editor): boolean {
  return showSourcesAtom(editor).get();
}

export function setShowingSources(editor: Editor, showing: boolean): void {
  showSourcesAtom(editor).set(showing);
}
