import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink, writeFile } from "node:fs/promises";

/**
 * Extract plain text from a document buffer. MD is read as-is; PDF/DOCX/PPTX go through
 * officeparser, which only accepts a file path, so the buffer is spilled to a temp file.
 */
export async function extractText(buffer: Buffer, fileType: string): Promise<string> {
  if (fileType === "MD") {
    return buffer.toString("utf-8");
  }

  const tmpPath = join(tmpdir(), `${crypto.randomUUID()}.${fileType.toLowerCase()}`);
  await writeFile(tmpPath, buffer);
  try {
    const officeparser = await import("officeparser");
    const text = (await (await officeparser.default.parseOffice(tmpPath)).to("text")).value as string;
    // Postgres text columns reject embedded NUL bytes, which some malformed PDFs yield.
    return text.split("\0").join("");
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
