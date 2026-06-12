import { type Context, Hono } from "hono";
import { Queue } from "bullmq";
import { prisma } from "../../../tools/prisma.ts";
import { knowledgeBase, type KnowledgeChunkRow, type KnowledgeDocSource } from "./queries.ts";

const docQueue = new Queue("document-processing", {
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
});

export function setupKnowledgeCurateRoutes(app: Hono, checkPermissions: (action: string, c: Context) => boolean): void {
  // List all documents
  app.get("/api/knowledge/documents", async (c) => {
    if (!checkPermissions("documents", c)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const db = prisma as any;
    const docs = await db.knowledgeDocument.findMany({
      include: { _count: { select: { chunks: true } } },
      orderBy: { createdAt: "desc" },
    });

    return c.json(docs);
  });

  // List all chunks for a document
  app.get("/api/knowledge/documents/:documentId/chunks", async (c) => {
    if (!checkPermissions("curate", c)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const documentId = c.req.param("documentId");
    const db = prisma as any;

    const doc = await db.knowledgeDocument.findUnique({ where: { id: documentId } });
    if (!doc) return c.json({ error: "Document not found" }, 404);

    const chunks = await db.knowledgeChunk.findMany({
      where: { documentId },
      select: { id: true, chunkIndex: true, content: true, editedContent: true, enabled: true },
      orderBy: { chunkIndex: "asc" },
    });

    return c.json(chunks);
  });

  // Update a chunk's enabled flag or editedContent
  app.patch("/api/knowledge/chunks/:chunkId", async (c) => {
    if (!checkPermissions("curate", c)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const chunkId = c.req.param("chunkId");
    const body = await c.req.json<{ enabled?: boolean; editedContent?: string }>();

    const db = prisma as any;
    const chunk = await db.knowledgeChunk.findUnique({ where: { id: chunkId } });
    if (!chunk) return c.json({ error: "Chunk not found" }, 404);

    const updateData: Record<string, unknown> = {};
    if (body.enabled !== undefined) updateData.enabled = body.enabled;
    if (body.editedContent !== undefined) updateData.editedContent = body.editedContent;

    if (body.editedContent !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE "KnowledgeChunk" SET embedding = NULL WHERE id = $1`,
        chunkId,
      );
    }

    const updated = await db.knowledgeChunk.update({
      where: { id: chunkId },
      data: updateData,
    });

    if (body.editedContent !== undefined) {
      await docQueue.add("embed-chunks", { documentId: chunk.documentId });
    }

    return c.json(updated);
  });

  // Re-queue embedding for a document
  app.post("/api/knowledge/documents/:documentId/embed", async (c) => {
    if (!checkPermissions("curate", c)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const documentId = c.req.param("documentId");
    const db = prisma as any;

    const doc = await db.knowledgeDocument.findUnique({ where: { id: documentId } });
    if (!doc) return c.json({ error: "Document not found" }, 404);

    await docQueue.add("embed-chunks", { documentId });
    return c.json({ queued: true });
  });

  // Delete a document and all its chunks
  app.delete("/api/knowledge/documents/:documentId", async (c) => {
    if (!checkPermissions("curate", c)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const documentId = c.req.param("documentId");
    const db = prisma as any;

    const doc = await db.knowledgeDocument.findUnique({ where: { id: documentId } });
    if (!doc) return c.json({ error: "Document not found" }, 404);

    await db.knowledgeChunk.deleteMany({ where: { documentId } });
    await db.knowledgeDocument.delete({ where: { id: documentId } });

    return c.json({ success: true });
  });

}

export function setupKnowledgeSearchRoutes(app: Hono, checkPermissions: (action: string, c: Context) => boolean): void {
  app.get("/api/knowledge/search", async (c) => {
    if (!checkPermissions("search", c)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const q = c.req.query("q")?.trim();
    const limit = Math.min(parseInt(c.req.query("limit") ?? "5", 10), 20);

    if (!q) return c.json({ error: "q is required" }, 400);

    const results = await knowledgeBase.findDetailed<KnowledgeChunkRow, KnowledgeDocSource>(
      q, { limit },
    );
    return c.json(results.map(r => ({
      id: r.id,
      documentId: r.documentId,
      content: r.content,
      editedContent: r.editedContent,
      similarity: r.similarity,
      filename: r.source.filename,
      fileType: r.source.fileType,
    })));
  });
}
