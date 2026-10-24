/**
 * Extract the payload string from a single Server-Sent Events block.
 *
 * Joins multi-line `data:` continuations and removes only the one optional
 * space after the colon, as the SSE field parser does; other whitespace
 * belongs to the payload. Lines that are not `data` fields (comments, other
 * fields, indented text) are ignored. The `[DONE]` sentinel and empty blocks
 * yield null. `JSON.parse` and typing are left to the caller.
 *
 * Shared by the Worker (parsing Gemini's upstream SSE) and the browser
 * (parsing the whiteboard agent's action stream) so the two cannot drift.
 */
export function extractSseData(event: string): string | null {
  const dataLines: string[] = [];
  for (const line of event.replace(/\r\n?/g, "\n").split("\n")) {
    if (line !== "data" && !line.startsWith("data:")) continue;
    let value = line === "data" ? "" : line.slice(5);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  }
  const payload = dataLines.join("\n");
  return payload && payload.trim() !== "[DONE]" ? payload : null;
}
