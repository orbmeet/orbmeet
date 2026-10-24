export class ResponseBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response body exceeds ${maxBytes} bytes`);
    this.name = "ResponseBodyTooLargeError";
  }
}

export class ResponseBodyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Response body timed out after ${timeoutMs}ms`);
    this.name = "ResponseBodyTimeoutError";
  }
}

/** Read an upstream body completely, with one deadline and a hard byte cap. */
export async function readResponseBodyBytes(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new ResponseBodyTimeoutError(timeoutMs);
      void reader.cancel(error).catch(() => undefined);
      reject(error);
    }, timeoutMs);
  });

  const read = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          const error = new ResponseBodyTooLargeError(maxBytes);
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
        chunks.push(value);
      }

      const buffer = new ArrayBuffer(totalBytes);
      const body = new Uint8Array(buffer);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return buffer;
    } finally {
      reader.releaseLock();
    }
  };

  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
