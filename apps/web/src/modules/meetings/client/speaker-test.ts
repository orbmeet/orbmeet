type WebkitAudioWindow = typeof window & {
  webkitAudioContext?: typeof AudioContext;
};

export function canSelectAudioOutput(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}

/** Longer than the tone; how long a stalled audio clock can hold the test. */
const TONE_SETTLE_TIMEOUT_MS = 2_000;

/** Plays a short, quiet two-note tone through the requested output device. */
export async function playSpeakerTestTone(deviceId?: string): Promise<void> {
  const AudioContextCtor =
    window.AudioContext ?? (window as WebkitAudioWindow).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Audio playback is unavailable in this browser.");
  }

  const context = new AudioContextCtor();
  const destination = context.createMediaStreamDestination();
  const gain = context.createGain();
  const oscillator = context.createOscillator();
  const audio = new Audio();

  try {
    // A context can start suspended (WebKit does), and a suspended clock
    // never reaches the tone's end.
    if (context.state === "suspended") await context.resume();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(440, context.currentTime);
    oscillator.frequency.setValueAtTime(554.37, context.currentTime + 0.22);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.025);
    gain.gain.setValueAtTime(0.12, context.currentTime + 0.36);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.5);
    oscillator.connect(gain).connect(destination);

    audio.srcObject = destination.stream;
    if (deviceId && "setSinkId" in audio) {
      await audio.setSinkId(deviceId);
    }
    await audio.play();

    await new Promise<void>((resolve) => {
      // Settles even if the clock stalls, so the test button always recovers.
      const fallback = setTimeout(resolve, TONE_SETTLE_TIMEOUT_MS);
      oscillator.addEventListener("ended", () => {
        clearTimeout(fallback);
        resolve();
      }, { once: true });
      oscillator.start();
      oscillator.stop(context.currentTime + 0.52);
    });
  } finally {
    audio.pause();
    audio.srcObject = null;
    destination.stream.getTracks().forEach((track) => track.stop());
    oscillator.disconnect();
    gain.disconnect();
    await context.close().catch(() => undefined);
  }
}
