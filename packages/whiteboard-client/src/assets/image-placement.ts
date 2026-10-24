interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Below this share of the page on screen, the view says nothing about where to put it. */
const MIN_VISIBLE_SHARE = 0.2;
const FILL = 0.8;

/**
 * Where an inserted image goes on its page, in the page's own coordinates.
 *
 * Pages are tall and the board scrolls like a notebook, so the middle of the
 * page is often off screen: an image centred there arrived out of sight, with
 * its handles beyond reach. It goes in the middle of the part of the page the
 * person is looking at instead, sized to fit inside it. When almost none of the
 * page is in view, the whole page is the target, as before.
 *
 * `frame` and `view` are page-space bounds; `cascade` steps later images of a
 * batch down and right so they don't stack invisibly.
 */
export function placeImageOnPage(
  image: { w: number; h: number },
  frame: Rect,
  view: Rect | null,
  cascade = 0,
): Rect {
  const page = { x: 0, y: 0, w: frame.w, h: frame.h };
  let target = page;
  if (view) {
    const left = Math.max(view.x, frame.x);
    const top = Math.max(view.y, frame.y);
    const right = Math.min(view.x + view.w, frame.x + frame.w);
    const bottom = Math.min(view.y + view.h, frame.y + frame.h);
    const visible = { x: left - frame.x, y: top - frame.y, w: right - left, h: bottom - top };
    if (
      visible.w >= frame.w * MIN_VISIBLE_SHARE &&
      visible.h >= frame.h * MIN_VISIBLE_SHARE
    ) {
      target = visible;
    }
  }

  const aspect = image.w / image.h;
  let w = target.w * FILL;
  let h = w / aspect;
  if (h > target.h * FILL) {
    h = target.h * FILL;
    w = h * aspect;
  }

  const x = target.x + (target.w - w) / 2 + cascade;
  const y = target.y + (target.h - h) / 2 + cascade;
  return {
    x: Math.max(0, Math.min(x, page.w - w)),
    y: Math.max(0, Math.min(y, page.h - h)),
    w,
    h,
  };
}
