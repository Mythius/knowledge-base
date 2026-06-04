import { VectorTable } from "../../../tools/VectorTable.ts";

export type KnowledgeDocSource = {
  id: string;
  filename: string;
  fileType: string;
  orgId: number;
  status: string;
};

export type KnowledgeChunkRow = {
  id: string;
  documentId: string;
  content: string;
  editedContent: string | null;
  metadata: unknown;
  orgId: number;
  enabled: boolean;
  chunkIndex: number;
};

export const knowledgeBase = new VectorTable("KnowledgeChunk", {
  sourceTable: "KnowledgeDocument",
  sourceKey: "documentId",
  defaultWhere: { enabled: true },
});
