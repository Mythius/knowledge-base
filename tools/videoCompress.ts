import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${cmd[0]} exited ${exitCode}: ${stderr.slice(-2000)}`);
  }
  return stdout;
}

async function getDurationSeconds(filePath: string): Promise<number> {
  const out = await run([
    "ffprobe",
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const seconds = parseFloat(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe could not determine duration for ${filePath}`);
  }
  return seconds;
}

const AUDIO_BITRATE_KBPS = 128;
const MIN_VIDEO_BITRATE_KBPS = 150;

/**
 * Transcode a video down to roughly `targetMB` so it fits under Gemini's 2GB upload
 * limit. Scales to at most 1280px wide and derives a video bitrate from the target size
 * and duration; audio is kept at a fixed bitrate since transcription accuracy matters more
 * than picture quality here. Returns the path to the compressed temp file — the caller
 * owns it and must delete it when done.
 */
export async function compressVideo(filePath: string, targetMB: number): Promise<string> {
  const duration = await getDurationSeconds(filePath);
  const targetBits = targetMB * 1024 * 1024 * 8;
  const videoBitrateKbps = Math.max(
    MIN_VIDEO_BITRATE_KBPS,
    Math.floor(targetBits / duration / 1000) - AUDIO_BITRATE_KBPS,
  );

  const outPath = join(tmpdir(), `${crypto.randomUUID()}-compressed.mp4`);
  await run([
    "ffmpeg", "-y",
    "-i", filePath,
    "-vf", "scale='min(1280,iw)':-2",
    "-c:v", "libx264", "-preset", "veryfast",
    "-b:v", `${videoBitrateKbps}k`, "-maxrate", `${videoBitrateKbps}k`, "-bufsize", `${videoBitrateKbps * 2}k`,
    "-c:a", "aac", "-b:a", `${AUDIO_BITRATE_KBPS}k`,
    outPath,
  ]);

  return outPath;
}
