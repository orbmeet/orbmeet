import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy text to the clipboard with a transient "copied" indicator.
 *
 * `copied` only turns on when the write actually succeeded — writeText
 * rejects when the document is unfocused or permission is denied, and
 * `navigator.clipboard` is absent entirely outside secure contexts — so
 * callers never show a false "Copied!" state.
 */
export function useCopyToClipboard(resetDelayMs = 2000): {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      if (typeof navigator === "undefined" || !navigator.clipboard) {
        return false;
      }
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), resetDelayMs);
      return true;
    },
    [resetDelayMs],
  );

  return { copied, copy };
}
