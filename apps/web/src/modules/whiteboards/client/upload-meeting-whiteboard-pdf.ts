/**
 * Uploads a rendered meeting whiteboard PDF via the 3-step grant -> R2 PUT -> finalize flow.
 */
export async function uploadMeetingWhiteboardPdf(
  meetingId: string,
  pdf: Blob,
): Promise<void> {
  const uploadEndpoint = `/api/whiteboard/pdf-upload?meetingId=${encodeURIComponent(meetingId)}`;

  const grantResponse = await fetch(`${uploadEndpoint}&phase=grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileSize: pdf.size }),
    credentials: "same-origin",
  });
  if (!grantResponse.ok) {
    throw new Error(`PDF upload grant failed: ${grantResponse.status}`);
  }
  const grant = (await grantResponse.json()) as {
    uploadId: string;
    uploadUrl: string;
  };

  const uploadResponse = await fetch(grant.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/pdf",
    },
    body: pdf,
  });
  if (!uploadResponse.ok) {
    throw new Error(`PDF upload failed: ${uploadResponse.status}`);
  }

  const finalizeResponse = await fetch(`${uploadEndpoint}&phase=finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileSize: pdf.size, uploadId: grant.uploadId }),
    credentials: "same-origin",
  });
  if (!finalizeResponse.ok) {
    throw new Error(`PDF finalize failed: ${finalizeResponse.status}`);
  }
}
