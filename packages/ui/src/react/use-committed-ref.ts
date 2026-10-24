import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Exposes the latest committed value to callbacks owned by imperative systems.
 * Updating after commit prevents an interrupted render from leaking values that
 * never became part of the mounted React tree.
 */
export function useCommittedRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
