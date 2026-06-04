import { readFileSync } from "fs";

(async () => {
  if (process.env.AI_CHAT_PROVIDER !== "ollama") return;
  const base = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { models } = (await res.json()) as { models: { name: string }[] };
    const names = models.map((m) => m.name).join(", ") || "(none)";
    console.log(`✅ Ollama connected at ${base} — available models: ${names}`);
    if (!models.some((m) => m.name.startsWith("gemma4"))) {
      console.warn(
        `⚠️  Model gemma4:latest not found. Run: ollama pull gemma4`,
      );
    }
  } catch (err) {
    console.warn(`⚠️  Ollama not reachable at ${base}: ${err}`);
    console.warn(`   AI replies will fall back to the static message.`);
    console.warn(
      `   To start Ollama: it should already be running as a tray app on Windows.`,
    );
    console.warn(`   If not, open the Ollama app or run: ollama serve`);
  }
})();

export type AIProvider = "Ollama" | "OpenAI" | "Anthropic";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function ollamaBaseUrl() {
  return (
    process.env.OLLAMA_BASE_URL ||
    process.env.OLLAMA_HOST ||
    "http://localhost:11434"
  );
}

function openaiBaseUrl() {
  return process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
}

export class AI {
  private provider: AIProvider;
  private model: string;
  private systemPrompt: string = "";

  constructor(provider: AIProvider, model: string) {
    this.provider = provider;
    this.model = model;
  }

  loadInstruction(filePath: string): this {
    this.systemPrompt = readFileSync(filePath, "utf-8");
    return this;
  }

  async respond(history: ChatMessage[]): Promise<string> {
    const messages: ChatMessage[] = this.systemPrompt
      ? [{ role: "system", content: this.systemPrompt }, ...history]
      : [...history];

    switch (this.provider) {
      case "Ollama":
        return this.callOllama(messages);
      case "OpenAI":
        return this.callOpenAI(messages);
      case "Anthropic":
        return this.callAnthropic(messages);
      default:
        throw new Error(`Unknown provider: ${this.provider}`);
    }
  }

  private async callOllama(messages: ChatMessage[]): Promise<string> {
    const res = await fetch(`${ollamaBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, stream: false }),
    });
    if (!res.ok)
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { message: { content: string } };
    return json.message.content;
  }

  private async callOpenAI(messages: ChatMessage[]): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY || "";
    const res = await fetch(`${openaiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages }),
    });
    if (!res.ok)
      throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return json.choices[0].message.content;
  }

  private async callAnthropic(messages: ChatMessage[]): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY || "";
    const system = messages.find((m) => m.role === "system")?.content;
    const nonSystem = messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: nonSystem,
    };
    if (system) body.system = system;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { content: { text: string }[] };
    return json.content[0].text;
  }
}
