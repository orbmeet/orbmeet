export function buildRecorderUrl(
  appUrl: string,
  whiteboardUrl: string,
  recorderToken: string,
  options: {
    livekitUrl?: string | null;
    livekitToken?: string | null;
    meetingCode?: string | null;
    egressMode?: "recording" | "streaming" | null;
  } = {},
): string {
  const params = new URLSearchParams({
    wb_url: whiteboardUrl,
    wb_recorder_token: recorderToken,
  });
  if (options.meetingCode) {
    params.set("meeting_code", options.meetingCode);
  }
  if (options.egressMode) {
    params.set("egress_mode", options.egressMode);
  }
  if (options.livekitUrl) {
    params.set("url", options.livekitUrl);
  }
  if (options.livekitToken) {
    params.set("token", options.livekitToken);
  }
  // LiveKit's room composite egress appends ?url=<ws>&token=<jwt> to this URL.
  // Use hash (#) so the appended ?url=... doesn't collide with existing query
  // params (a double ? breaks URL parsing). parseRecorderHashParams on the
  // recorder page normalizes the injected ? inside the hash fragment into &.
  return `${appUrl}/recorder#${params.toString()}`;
}
