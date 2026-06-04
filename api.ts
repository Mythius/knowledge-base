import { Context, Hono } from "hono";
import type { Session } from "./tools/auth.ts";
import { exposePrismaCRUD, prisma } from "./tools/prisma.ts";
import { handleFileUpload } from "./tools/fileUpload.ts";
import { AI, type ChatMessage } from "./tools/ai.ts";
import { setupKnowledgeUploadRoutes } from "./src/routes/knowledge/upload.ts";
import { setupKnowledgeCurateRoutes } from "./src/routes/knowledge/curate.ts";
import { setupKnowledgeChatRoutes } from "./src/routes/knowledge/chat.ts";

function getSession(c: Context): Session {
  return c.get("session") as Session;
}

export function publicRoutes(app: Hono): void {
  app.get("/hello", (c) => c.json({ message: "Hello World" }));

  app.post("/file-upload", async (c) => {
    const result = await handleFileUpload(c);
    console.log("File upload result:", result);
    return "error" in result ? c.json(result, 400) : c.json(result, 201);
  });
}

function checkPermissions(action: string, context: Context): boolean {
  const session = getSession(context);
  const role = (session.db as any)?.role;
  if (role === "admin") return true;
  if (action === "chat") return true; // any authenticated user can chat
  return false;
}

export function privateRoutes(app: Hono): void {
  app.get("/user", (c) => {
    const session = getSession(c);
    let result = session.cas_data!;
    result.db = session.db;
    // console.log("Checking session: ", session);
    return c.json(result || {});
  });

  setupKnowledgeUploadRoutes(app, checkPermissions);
  setupKnowledgeCurateRoutes(app, checkPermissions);
  setupKnowledgeChatRoutes(app, checkPermissions);

  exposePrismaCRUD("api", app, checkPermissions);
}

export async function onLogin(session: Session): Promise<void> {
  let user = await prisma.user
    .upsert({
      where: { email: session.email! },
      update: {
        name: session.username,
        email: session.email,
      },
      create: {
        name: session.username!,
        email: session.email!,
        role: "none",
      },
    })
    .catch((err) => {
      console.error("Error upserting user on login:", err);
    });
  console.log("User upserted on login:", user);
  session.db = user;
}
