import { type Context, Hono } from "hono";
import { AI, type AIProvider, type ChatMessage } from "../../../tools/ai.ts";
import { knowledgeBase, type KnowledgeChunkRow, type KnowledgeDocSource } from "./queries.ts";

function createChatAI(): AI {
  const raw = (process.env.AI_CHAT_PROVIDER || "ollama").toLowerCase();
  const providerMap: Record<string, AIProvider> = {
    ollama: "Ollama",
    anthropic: "Anthropic",
    openai: "OpenAI",
  };
  const provider: AIProvider = providerMap[raw] ?? "Ollama";
  const defaultModel =
    provider === "Anthropic" ? "claude-sonnet-4-6"
    : provider === "OpenAI"  ? "gpt-4o"
    :                           "llama3.2";
  const model = process.env.AI_CHAT_MODEL || defaultModel;
  return new AI(provider, model);
}

function buildSystemPrompt(sources: (KnowledgeChunkRow & { source: KnowledgeDocSource; similarity: number })[]): string {
  if (!sources.length) {
    return `You are a helpful coaching assistant for a non-profit organization. \
Answer based on your general knowledge. If you are unsure about something, say so clearly rather than guessing.`;
  }

  const blocks = sources
    .map((s, i) => {
      const pct = Math.round(s.similarity * 100);
      const text = s.editedContent ?? s.content;
      return `[Source ${i + 1}: ${s.source.filename} — ${pct}% match]\n${text}`;
    })
    .join("\n\n---\n\n");

  return `You are a helpful coaching assistant for a non-profit organization. \
Use the knowledge base excerpts below to answer the user's question. \
Cite sources naturally when you draw from them (e.g. "According to [filename]…"). \
If the context does not address the question, acknowledge that honestly rather than fabricating an answer.

KNOWLEDGE BASE CONTEXT:
${blocks}`;
}

export function setupKnowledgeChatRoutes(app: Hono, checkPermissions: (action: string, c: Context) => boolean): void {
  app.post("/api/knowledge/chat", async (c) => {
    if (!checkPermissions("chat", c)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const body = await c.req.json<{
      message: string;
      history?: { role: "user" | "assistant"; content: string }[];
    }>();

    const { message, history = [] } = body;
    if (!message?.trim()) {
      return c.json({ error: "message is required" }, 400);
    }

    const raw = await knowledgeBase.findDetailed<KnowledgeChunkRow, KnowledgeDocSource>(
      message, { limit: 8 },
    );
    const topScore = raw[0]?.similarity ?? 0;
    const floor = Math.max(0.40, topScore * 0.70);
    const sources = raw.filter(c => c.similarity >= floor).slice(0, 3);

    console.log(`[chat] query: "${message.slice(0, 60)}" — top score ${Math.round(topScore * 100)}%, using ${sources.length}/${raw.length} chunks`);

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(sources) },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: message },
    ];

    const ai = createChatAI();
    const reply = await ai.respond(messages);

    return c.json({
      reply,
      sources: sources.map(s => ({
        id: s.id,
        filename: s.source.filename,
        fileType: s.source.fileType,
        similarity: s.similarity,
        content: s.editedContent ?? s.content,
      })),
    });
  });
}
