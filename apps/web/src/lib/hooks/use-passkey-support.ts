import { useState } from "react";

export function usePasskeySupport() {
  const [supported] = useState(() =>
    typeof window !== "undefined" && "PublicKeyCredential" in window
  );

  return supported;
}
