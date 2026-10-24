/** The text forms understood by asciimath2tex, shared with the complexity scan. */
export function readAsciiMathText(input: string, start: number): { text: string; end: number } | null {
  if (input[start] === '"') {
    const end = input.indexOf('"', start + 1);
    return end < 0 ? null : { text: input.slice(start + 1, end), end: end + 1 };
  }
  const match = /^(?:text|mbox)\s*([({\[])/.exec(input.slice(start));
  if (!match) return null;
  const contentStart = start + match[0].length;
  const close = { "(": ")", "[": "]", "{": "}" }[match[1]]!;
  const end = input.indexOf(close, contentStart);
  return {
    text: input.slice(contentStart, end < 0 ? input.length : end),
    end: end < 0 ? input.length : end + 1,
  };
}
