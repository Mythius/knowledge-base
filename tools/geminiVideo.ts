const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_MODEL = process.env.GEMINI_VIDEO_MODEL || "gemini-3.6-flash";
const FILE_ACTIVE_TIMEOUT_MS = 30 * 60 * 1000;
const FILE_ACTIVE_POLL_MS = 8000;

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state: "PROCESSING" | "ACTIVE" | "FAILED";
}

async function uploadFile(filePath: string, mimeType: string, displayName: string): Promise<GeminiFile> {
  const size = Bun.file(filePath).size;

  const startRes = await fetch(`${GEMINI_BASE}/upload/v1beta/files?key=${apiKey()}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startRes.ok) throw new Error(`Gemini upload start failed ${startRes.status}: ${await startRes.text()}`);

  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini upload start did not return an upload URL");

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "Content-Length": String(size),
    },
    body: Bun.file(filePath).stream(),
  });
  if (!uploadRes.ok) throw new Error(`Gemini upload failed ${uploadRes.status}: ${await uploadRes.text()}`);

  const { file } = (await uploadRes.json()) as { file: GeminiFile };
  return file;
}

async function waitUntilActive(name: string): Promise<GeminiFile> {
  const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${GEMINI_BASE}/v1beta/${name}?key=${apiKey()}`);
    if (!res.ok) throw new Error(`Gemini file status check failed ${res.status}: ${await res.text()}`);
    const file = (await res.json()) as GeminiFile;
    if (file.state === "ACTIVE") return file;
    if (file.state === "FAILED") throw new Error(`Gemini failed processing uploaded file ${name}`);
    await new Promise((resolve) => setTimeout(resolve, FILE_ACTIVE_POLL_MS));
  }
  throw new Error(`Timed out waiting for Gemini to finish processing ${name}`);
}

async function deleteFile(name: string): Promise<void> {
  await fetch(`${GEMINI_BASE}/v1beta/${name}?key=${apiKey()}`, { method: "DELETE" }).catch(() => {});
}

const TRANSCRIBE_PROMPT = `Watch this video and produce markdown for a nonprofit's internal knowledge base, in exactly this format:

## Summary
A concise 3-6 sentence summary of what the video shows and its purpose.

## Transcript
A full transcript of anything spoken, in paragraph form. Where there is no dialogue, briefly describe (in square brackets) what is shown on screen instead. If the video has no spoken audio at all, write "(no spoken audio)" followed by a visual description of the video's content.`;

/**
 * Upload a video file to Gemini, wait for it to finish processing, and ask for a
 * transcript + summary. Returns markdown text ready to be chunked and embedded.
 */
export async function transcribeVideo(filePath: string, mimeType: string, displayName: string): Promise<string> {
  const uploaded = await uploadFile(filePath, mimeType, displayName);
  try {
    const active = await waitUntilActive(uploaded.name);

    const res = await fetch(`${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { fileData: { fileUri: active.uri, mimeType: active.mimeType } },
              { text: TRANSCRIBE_PROMPT },
            ],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Gemini generateContent failed ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as { candidates?: { content: { parts: { text: string }[] } }[] };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    if (!text.trim()) throw new Error("Gemini returned an empty transcript");
    return text;
  } finally {
    await deleteFile(uploaded.name);
  }
}
