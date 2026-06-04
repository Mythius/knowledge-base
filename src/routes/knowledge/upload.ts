import { join } from "path";
import { type Context, Hono } from "hono";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Queue } from "bullmq";
import { prisma } from "../../../tools/prisma.ts";
import { writeFileToDisk } from "../../../tools/fileUpload.ts";

let _s3: S3Client | null = null;
function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
      forcePathStyle: true,
    });
  }
  return _s3;
}

const docQueue = new Queue("document-processing", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

const MIME_TO_FILE_TYPE: Record<string, "PDF" | "DOCX" | "PPTX" | "MD"> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
  "text/markdown": "MD",
  "text/x-markdown": "MD",
  "text/plain": "MD",
};

async function storeFile(file: File): Promise<string> {
  const key = `${crypto.randomUUID()}/${file.name}`;

  if (process.env.STORAGE_PROVIDER === "local") {
    return await writeFileToDisk(file, join("./uploads/knowledge", key));
  }

  await getS3().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: `knowledge/${key}`,
      Body: new Uint8Array(await file.arrayBuffer()),
      ContentType: file.type,
    }),
  );
  return `knowledge/${key}`;
}

export function setupKnowledgeUploadRoutes(app: Hono, checkPermissions: (action: string, c: Context) => boolean): void {
  app.post("/api/knowledge/upload", async (c) => {
    if (!checkPermissions("upload", c)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const file = formData.get("file") as File | null;
    if (!file) {
      return c.json({ error: "file field is required" }, 400);
    }

    const fileType = MIME_TO_FILE_TYPE[file.type];
    if (!fileType) {
      return c.json({ error: "File must be PDF, DOCX, PPTX, or MD" }, 400);
    }

    let storageUrl: string;
    try {
      storageUrl = await storeFile(file);
    } catch (err) {
      console.error("File storage failed:", err);
      return c.json({ error: "File upload to storage failed" }, 500);
    }

    const db = prisma as any;
    const doc = await db.knowledgeDocument.create({
      data: {
        filename: file.name,
        fileType,
        storageUrl,
        status: "PENDING",
      },
    });

    await docQueue.add("extract", { documentId: doc.id });

    return c.json(doc, 201);
  });
}
