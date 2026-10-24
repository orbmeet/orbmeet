import { DeepgramClient } from "@deepgram/sdk";
import type { AgentConfig } from "../config.js";
import { SAMPLE_RATE } from "./audio-source.js";
import type { DeepgramMessage, DeepgramSocket, OpenDeepgramSocket } from "./deepgram-attempt.js";
import { logError } from "../log.js";

/**
 * Open Deepgram listen sockets through the SDK.
 *
 * `listen.v1.connect()` returns a socket that is not connected: nothing
 * reaches Deepgram until the socket's own `connect()` is called, and without
 * that call `waitForOpen()` never resolves. The SDK's reconnect loop is
 * disabled: a connection that ends is ended, and the supervisor opens the next
 * one with its own timeline.
 */
export function deepgramSocketFactory(config: Pick<AgentConfig, "deepgramApiKey" | "deepgramBaseUrl">): OpenDeepgramSocket {
  return async (language) => {
    const client = new DeepgramClient({ apiKey: config.deepgramApiKey, baseUrl: config.deepgramBaseUrl });
    const socket = await client.listen.v1.connect({
      Authorization: `Token ${config.deepgramApiKey}`,
      model: "nova-3",
      language,
      encoding: "linear16",
      sample_rate: SAMPLE_RATE,
      channels: 1,
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      endpointing: 300,
      // Deepgram's word-gap boundary, for when `speech_final` never comes
      // because the room is never quite silent.
      utterance_end_ms: 1_000,
      reconnectAttempts: 0,
      connectionTimeoutInSeconds: 10,
    });
    let closeHandler: (() => void) | null = null;
    let closeNotified = false;
    const notifyClose = () => {
      if (closeNotified) return;
      closeNotified = true;
      closeHandler?.();
    };
    socket.on("close", notifyClose);
    socket.on("error", (error) => {
      logError("Deepgram socket error", { error });
    });
    socket.connect();
    const adapted: DeepgramSocket = {
      onMessage: (handler) => socket.on("message", (message) => handler(message as DeepgramMessage)),
      onClose: (handler) => {
        closeHandler = handler;
        // A socket can close before its owner is listening.
        if (closeNotified) handler();
      },
      waitForOpen: async () => {
        await socket.waitForOpen();
      },
      sendAudio: (samples) => socket.sendMedia(samples),
      keepAlive: () => socket.sendKeepAlive({ type: "KeepAlive" }),
      finalize: () => socket.sendFinalize({ type: "Finalize" }),
      closeStream: () => socket.sendCloseStream({ type: "CloseStream" }),
      close: () => {
        socket.close();
        notifyClose();
      },
    };
    return adapted;
  };
}
