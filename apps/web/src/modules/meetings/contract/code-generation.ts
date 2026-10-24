import { containsBlockedMeetingCodeTerm } from "./code-blocklist";
import { MEETING_CODE_GROUPS } from "./constants";

export function generateMeetingCode(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const threshold = Math.floor(256 / alphabet.length) * alphabet.length;
  const pickCharacter = (): string => {
    while (true) {
      const byte = crypto.getRandomValues(new Uint8Array(1))[0];
      if (byte < threshold) return alphabet[byte % alphabet.length];
    }
  };
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = MEETING_CODE_GROUPS
      .map((size) => Array.from({ length: size }, pickCharacter).join(""))
      .join("-");
    if (!containsBlockedMeetingCodeTerm(code)) return code;
  }
  throw new Error("Unable to generate an acceptable meeting code");
}
