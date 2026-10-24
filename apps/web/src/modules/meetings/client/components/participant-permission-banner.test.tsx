/**
 * The banner's button must never end a share the attendee is presenting:
 * "Dismiss" once withdrew the grant, which stopped the share mid-presentation.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ParticipantPermissionBanner } from "./participant-permission-banner";

type Props = React.ComponentProps<typeof ParticipantPermissionBanner>;

function props(overrides: Partial<Props>): Props {
  return {
    state: "idle",
    isPreparing: false,
    hasPrepared: false,
    hasPermission: false,
    onCancel: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

/** The banner's one button, found in the element tree it returns. */
function button(element: React.ReactNode): React.ReactElement<{ onClick: () => void }> {
  const found: React.ReactElement<{ onClick: () => void }>[] = [];
  const visit = (node: React.ReactNode) => {
    if (!React.isValidElement(node)) return;
    const { children, onClick } = node.props as { children?: React.ReactNode; onClick?: unknown };
    if (node.type === "button" && typeof onClick === "function") {
      found.push(node as React.ReactElement<{ onClick: () => void }>);
    }
    React.Children.forEach(children, visit);
  };
  visit(element);
  if (found.length !== 1) throw new Error(`expected one button, found ${found.length}`);
  return found[0];
}

describe("ParticipantPermissionBanner", () => {
  it("says nothing once an approved share is being presented", () => {
    expect(renderToStaticMarkup(
      <ParticipantPermissionBanner {...props({ state: "approved", hasPrepared: false, hasPermission: true })} />,
    )).toBe("");
  });

  it("cancels an approved share that has not started yet", () => {
    const p = props({ state: "approved", hasPrepared: true });
    expect(renderToStaticMarkup(<ParticipantPermissionBanner {...p} />)).toContain("Cancel");
    button(ParticipantPermissionBanner(p)).props.onClick();
    expect(p.onCancel).toHaveBeenCalledOnce();
  });

  it("only hides a denial when dismissed", () => {
    const p = props({ state: "denied" });
    button(ParticipantPermissionBanner(p)).props.onClick();
    expect(p.onDismiss).toHaveBeenCalledOnce();
    expect(p.onCancel).not.toHaveBeenCalled();
  });
});
