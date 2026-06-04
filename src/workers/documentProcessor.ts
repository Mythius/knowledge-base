import { Worker, Queue } from "bullmq";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { unlink, writeFile } from "node:fs/promises";
import { prisma } from "../../tools/prisma.ts";
import { embedText, chunkText } from "../../tools/VectorTable.ts";

const redisConnection = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
};

const s3 = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
});

const docQueue = new Queue("document-processing", { connection: redisConnection });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchFile(storageUrl: string): Promise<Buffer> {
  // Local path (STORAGE_PROVIDER=local) — read directly from disk
  if (process.env.STORAGE_PROVIDER === "local" || storageUrl.startsWith("./") || storageUrl.startsWith("/")) {
    const data = await Bun.file(storageUrl).arrayBuffer();
    return Buffer.from(data);
  }

  // S3 / R2 key
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: storageUrl }),
  );
  if (!Body) throw new Error(`Empty S3 response for key: ${storageUrl}`);
  return Buffer.from(await new Response(Body as ReadableStream).arrayBuffer());
}


async function extractText(buffer: Buffer, fileType: string): Promise<string> {
  if (fileType === "MD") {
    return buffer.toString("utf-8");
  }

  // Write to tmp file with correct extension so officeparser detects the format reliably
  const tmpPath = `/tmp/${crypto.randomUUID()}.${fileType.toLowerCase()}`;
  await writeFile(tmpPath, buffer);
  try {
    const officeparser = await import("officeparser");
    return (await (await officeparser.default.parseOffice(tmpPath)).to("text")).value as string;
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

async function handleExtract(data: { documentId: string; orgId: number }): Promise<void> {
  const { documentId } = data;
  const db = prisma as any;

  const doc = await db.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new Error(`Document not found: ${documentId}`);

  console.log(`[extract] ${documentId} — "${doc.filename}" (${doc.fileType}, org ${doc.orgId})`);
  console.log(`[extract] storage: ${doc.storageUrl}`);

  await db.knowledgeDocument.update({ where: { id: documentId }, data: { status: "EXTRACTING" } });

  console.log(`[extract] fetching file…`);
  const buffer = await fetchFile(doc.storageUrl);
  console.log(`[extract] fetched ${(buffer.length / 1024).toFixed(1)} KB`);

  console.log(`[extract] parsing text from ${doc.fileType}…`);
  const rawText = await extractText(buffer, doc.fileType);
  console.log(`[extract] extracted ${rawText.length} chars`);

  await db.knowledgeDocument.update({
    where: { id: documentId },
    data: { rawText, status: "CHUNKING" },
  });

  const textChunks = chunkText(rawText);
  console.log(`[extract] created ${textChunks.length} chunks`);

  await db.knowledgeChunk.createMany({
    data: textChunks.map((content, index) => ({
      documentId,
      orgId: doc.orgId,
      chunkIndex: index,
      content,
    })),
  });

  await db.knowledgeDocument.update({ where: { id: documentId }, data: { status: "READY" } });
  console.log(`[extract] "${doc.filename}" → READY, queuing embed-chunks`);
  await docQueue.add("embed-chunks", { documentId });
}

async function handleEmbedChunks(data: { documentId: string }): Promise<void> {
  const { documentId } = data;

  const chunks = await prisma.$queryRaw<{ id: string; content: string; editedContent: string | null }[]>`
    SELECT id, content, "editedContent"
    FROM "KnowledgeChunk"
    WHERE "documentId" = ${documentId}
      AND enabled = true
      AND embedding IS NULL
  `;

  if (!chunks.length) {
    console.log(`[embed] ${documentId} — no chunks need embedding`);
    return;
  }

  const batchSize = 10;
  const totalBatches = Math.ceil(chunks.length / batchSize);
  console.log(`[embed] ${documentId} — embedding ${chunks.length} chunks in ${totalBatches} batch(es)`);

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    console.log(`[embed] batch ${batchNum}/${totalBatches} (chunks ${i + 1}–${i + batch.length})`);

    await Promise.all(
      batch.map(async (chunk) => {
        const text = chunk.editedContent ?? chunk.content;
        const embedding = await embedText(text);
        await prisma.$executeRawUnsafe(
          `UPDATE "KnowledgeChunk" SET embedding = $1::vector WHERE id = $2`,
          `[${embedding.join(",")}]`,
          chunk.id,
        );
      }),
    );

    if (i + batchSize < chunks.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }

  console.log(`[embed] ${documentId} — all chunks embedded`);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export function startWorker(): Worker {
  const worker = new Worker(
    "document-processing",
    async (job) => {
      const documentId = (job.data as any).documentId as string | undefined;
      console.log(`[worker] job "${job.name}" ${job.id} received`, job.data);
      try {
        if (job.name === "extract") {
          await handleExtract(job.data as { documentId: string; orgId: number });
        } else if (job.name === "embed-chunks") {
          await handleEmbedChunks(job.data as { documentId: string });
        } else {
          console.warn(`[worker] unknown job name: ${job.name}`);
        }
      } catch (err) {
        console.error(`[worker] job "${job.name}" ${job.id} threw:`, err);
        if (documentId) {
          const db = prisma as any;
          await db.knowledgeDocument
            .update({ where: { id: documentId }, data: { status: "FAILED" } })
            .catch((dbErr: unknown) => console.error(`[worker] failed to mark document FAILED:`, dbErr));
        }
        throw err;
      }
    },
    { connection: redisConnection },
  );

  worker.on("completed", (job) => console.log(`[worker] "${job.name}" ${job.id} completed`));
  worker.on("failed", (job, err) =>
    console.error(`[worker] "${job?.name}" ${job?.id} failed: ${err.message}`),
  );

  console.log(`Document processor worker started`);
  console.log(`  Redis:    ${redisConnection.host}:${redisConnection.port}`);
  console.log(`  Storage:  ${process.env.STORAGE_PROVIDER ?? "s3 (default)"}`);
  console.log(`  Embedder: ${process.env.EMBEDDING_PROVIDER ?? "voyageai (default)"}`);

  return worker;
}

// Allow running standalone: `bun src/workers/documentProcessor.ts`
if (import.meta.main) {
  startWorker();
}

