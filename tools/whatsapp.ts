import type { Hono } from "hono";

const LOG = true;

const BASE_URL = "https://graph.facebook.com/v20.0";

function token() {
  return process.env.WHATSAPP_ACCESS_TOKEN || "";
}

function phoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID || "";
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | "image" | "document" | "audio" | "video" | "sticker" | "interactive" | "unknown";
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  interactive?: {
    type: "list_reply" | "button_reply";
    list_reply?: { id: string; title: string };
    button_reply?: { id: string; title: string };
  };
}

export interface WhatsAppImageDownload {
  data: ArrayBuffer;
  mimeType: string;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        if (LOG) console.warn(`WhatsApp send attempt ${i + 1} failed, retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (LOG) console.log(`WhatsApp API response [${res.status}]:`, JSON.stringify(json));
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

export async function sendWhatsAppText(to: string, text: string): Promise<string> {
  if (LOG) console.log(`Sending WhatsApp text to ${to}`);
  return withRetry(async () => {
    const res = (await apiPost(`/${phoneNumberId()}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    })) as { messages: { id: string }[] };
    return res.messages[0].id;
  });
}

export async function sendWhatsAppImage(
  to: string,
  imageUrl: string,
  caption?: string
): Promise<string> {
  if (LOG) console.log(`Sending WhatsApp image URL to ${to}`);
  const image: Record<string, string> = { link: imageUrl };
  if (caption) image.caption = caption;
  const res = (await apiPost(`/${phoneNumberId()}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image,
  })) as { messages: { id: string }[] };
  return res.messages[0].id;
}

export async function sendWhatsAppImageFile(
  to: string,
  filePath: string,
  caption?: string
): Promise<string> {
  if (LOG) console.log(`Uploading and sending WhatsApp image file to ${to}`);

  const file = Bun.file(filePath);
  const mimeType = file.type || "image/jpeg";

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([await file.arrayBuffer()], { type: mimeType }), filePath);

  const uploadRes = await fetch(`${BASE_URL}/${phoneNumberId()}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  });
  const uploadJson = (await uploadRes.json()) as { id: string };
  if (!uploadRes.ok) throw new Error(JSON.stringify(uploadJson));

  const image: Record<string, string> = { id: uploadJson.id };
  if (caption) image.caption = caption;

  const res = (await apiPost(`/${phoneNumberId()}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image,
  })) as { messages: { id: string }[] };
  return res.messages[0].id;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title?: string;
  rows: ListRow[];
}

export async function sendWhatsAppListMessage(
  to: string,
  body: string,
  buttonLabel: string,
  sections: ListSection[],
  opts?: { header?: string; footer?: string }
): Promise<string> {
  if (LOG) console.log(`Sending WhatsApp list message to ${to}`);
  return withRetry(async () => {
    const interactive: Record<string, unknown> = {
      type: "list",
      body: { text: body },
      action: { button: buttonLabel, sections },
    };
    if (opts?.header) interactive.header = { type: "text", text: opts.header };
    if (opts?.footer) interactive.footer = { text: opts.footer };

    const res = (await apiPost(`/${phoneNumberId()}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive,
    })) as { messages: { id: string }[] };
    return res.messages[0].id;
  });
}

export async function downloadWhatsAppMedia(mediaId: string): Promise<WhatsAppImageDownload> {
  if (LOG) console.log(`Downloading WhatsApp media ${mediaId}`);

  const metaRes = await fetch(`${BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  const meta = (await metaRes.json()) as { url: string; mime_type: string };
  if (!metaRes.ok) throw new Error(JSON.stringify(meta));

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!fileRes.ok) throw new Error(`Media download failed: ${fileRes.status}`);

  return { data: await fileRes.arrayBuffer(), mimeType: meta.mime_type };
}

export function setupWhatsAppWebhook(
  app: Hono,
  onMessage: (message: WhatsAppMessage) => Promise<void>
): void {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || "";

  app.get("/whatsapp/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const challenge = c.req.query("hub.challenge");
    const token = c.req.query("hub.verify_token");

    if (mode === "subscribe" && token === verifyToken) {
      if (LOG) console.log("WhatsApp webhook verified");
      return c.text(challenge ?? "");
    }
    return c.text("Forbidden", 403);
  });

  app.post("/whatsapp/webhook", async (c) => {
    const body = await c.req.json<{
      entry?: {
        changes?: {
          value?: {
            messages?: WhatsAppMessage[];
          };
        }[];
      }[];
    }>();

    const messages = body?.entry?.flatMap(
      (e) => e.changes?.flatMap((ch) => ch.value?.messages ?? []) ?? []
    ) ?? [];

    for (const msg of messages) {
      try {
        await onMessage(msg);
      } catch (err) {
        console.error("WhatsApp onMessage error:", err);
      }
    }

    return c.json({ status: "ok" });
  });

  if (LOG) console.log("WhatsApp webhook registered at /whatsapp/webhook");
}
