export async function apiRequest(path, options = {}, sessionId = "") {
  const headers = new Headers(options.headers || {});
  if (sessionId) headers.set("X-Session-Id", sessionId);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    throw new Error(
      "The local runner could not be reached. Restart the app, confirm the runner is still open, and try again.",
      { cause: error },
    );
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(typeof data === "object" && data?.error ? data.error : `Request failed with status ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function downloadAuthenticatedFile(path, sessionId, filename) {
  const response = await fetch(path, { headers: { "X-Session-Id": sessionId } });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Download failed.");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
