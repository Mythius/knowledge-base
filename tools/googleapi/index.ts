// Setup:
// Open https://console.cloud.google.com/apis/credentials
// Create OAuth client ID → Application Type: Desktop App
// Download JSON → save as tools/googleapi/credentials.json
// Run once to authorize: bun run tools/googleapi/index.ts del

import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { createWriteStream } from "fs";
import { rm } from "fs/promises";
import { join } from "path";

// Use `any` for the auth client to avoid the OAuth2Client version mismatch
// between @google-cloud/local-auth and googleapis' internal dependency tree.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthClient = any;

const SCOPES = [
  "https://www.googleapis.com/auth/script.projects",
  "https://www.googleapis.com/auth/script.deployments",
  "https://www.googleapis.com/auth/script.scriptapp",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/script.send_mail",
  "https://www.googleapis.com/auth/script.locale",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

const TOKEN_PATH = join(process.cwd(), "tools/googleapi/token.json");
const CREDENTIALS_PATH = join(process.cwd(), "tools/googleapi/credentials.json");

async function loadSavedCredentialsIfExist(): Promise<AuthClient | null> {
  try {
    const content = await Bun.file(TOKEN_PATH).text();
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch {
    return null;
  }
}

async function saveCredentials(client: AuthClient): Promise<void> {
  const content = await Bun.file(CREDENTIALS_PATH).text();
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  await Bun.write(TOKEN_PATH, JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  }));
}

async function authorize(): Promise<AuthClient> {
  let client = await loadSavedCredentialsIfExist();
  if (client) return client;
  client = await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH });
  if (client.credentials) await saveCredentials(client);
  return client;
}

async function main() {
  await rm(TOKEN_PATH, { force: true });
  console.log("Deleted token");
  await Bun.sleep(300);
  await authorize();
  console.log("Authorized — good to go");
}

if (process.argv.includes("del")) {
  main();
}

export const login = loadSavedCredentialsIfExist;

export async function callAppsScriptFunction(
  scriptId: string,
  functionName: string,
  parameters: unknown[] = []
): Promise<unknown> {
  const auth = await login();
  const script = google.script({ version: "v1", auth });
  try {
    const res = await script.scripts.run({
      scriptId,
      requestBody: { function: functionName, parameters, devMode: true },
    });
    if (res.data.error) {
      console.error("Script error:", res.data.error.details);
      return null;
    }
    return res.data.response?.result ?? null;
  } catch (err) {
    console.error("API error:", err);
    return null;
  }
}

export async function exportPresentation(
  fileId: string,
  name: string,
  type: "pptx" | "pdf" = "pptx"
): Promise<void> {
  const auth = await login();
  const mimeType =
    type === "pptx"
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "application/pdf";
  const drive = google.drive({ version: "v3", auth });
  const result = await drive.files.export(
    { fileId, mimeType },
    { responseType: "stream" }
  );
  await new Promise<void>((resolve, reject) => {
    const dest = createWriteStream(`downloads/${name}.${type}`);
    (result.data as NodeJS.ReadableStream)
      .on("end", resolve)
      .on("error", reject)
      .pipe(dest);
  });
}

export async function downloadFile(fileId: string, name: string): Promise<string> {
  const auth = await login();
  const drive = google.drive({ version: "v3", auth });
  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );
  return new Promise((resolve, reject) => {
    const dest = createWriteStream(name);
    (response.data as NodeJS.ReadableStream).pipe(dest);
    dest.on("finish", () => resolve(`File ${name} downloaded successfully`));
    dest.on("error", reject);
  });
}

async function applySheetFormatting(sheets: any, spreadsheetId: string, data: string[][]): Promise<void> {
  if (!data.length) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Sheet1",
    valueInputOption: "RAW",
    requestBody: { values: data },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
              },
            },
            fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor",
          },
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: data[0]?.length ?? 1 },
          },
        },
      ],
    },
  });
}

export async function shareSheetWithEmail(spreadsheetId: string, email: string): Promise<void> {
  const auth = await loadSavedCredentialsIfExist();
  if (!auth) throw new Error("Google API not authorized. Run: bun run tools/googleapi/index.ts del");
  const drive = google.drive({ version: "v3", auth });
  await shareWithEmail(drive, spreadsheetId, email);
}

async function shareWithEmail(drive: any, fileId: string, email: string): Promise<void> {
  try {
    await drive.permissions.create({
      fileId,
      sendNotificationEmail: true,
      requestBody: { role: "writer", type: "user", emailAddress: email },
    });
  } catch {
    // Already shared with this user — ignore
  }
}

export async function createSharedSheet(
  data: string[][],
  email: string,
  title = "Survey Responses",
  folderId?: string
): Promise<{ spreadsheetId: string; url: string }> {
  const auth = await loadSavedCredentialsIfExist();
  if (!auth) throw new Error("Google API not authorized. Run: bun run tools/googleapi/index.ts del");

  const sheets = google.sheets({ version: "v4", auth });
  const drive  = google.drive({ version: "v3", auth });

  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title } },
  });
  const spreadsheetId = created.data.spreadsheetId!;

  if (folderId) {
    await drive.files.update({
      fileId: spreadsheetId,
      addParents: folderId,
      removeParents: "root",
      fields: "id, parents",
    });
  }

  await applySheetFormatting(sheets, spreadsheetId, data);
  await shareWithEmail(drive, spreadsheetId, email);

  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
}

export async function updateSharedSheet(
  spreadsheetId: string,
  data: string[][]
): Promise<string> {
  const auth = await loadSavedCredentialsIfExist();
  if (!auth) throw new Error("Google API not authorized. Run: bun run tools/googleapi/index.ts del");

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: "Sheet1" });
  await applySheetFormatting(sheets, spreadsheetId, data);

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

export type SurveySheetData = {
  questions: Array<{ id: number; text: string; type: string; options: any }>;
  contacts: Array<{ name: string; externalId: string | null; whatsAppNumber: string }>;
  responses: Array<{ name: string; externalId: string | null; phone: string; date: string; answers: Record<string, string> }>;
};

// Tab layout (matches app's 3 tabs in order):
//   sheetId 0 = Questions  (Survey Editor)
//   sheetId 1 = Contacts   (Contacts & Send) — sheet is source of truth; only written on create
//   sheetId 2 = Responses  (Responses)

function buildQuestionsRows(questions: SurveySheetData["questions"]): string[][] {
  return [
    ["#", "Question", "Type", "Options"],
    ...questions.map((q, i) => {
      const opts: string[] = Array.isArray(q.options) ? q.options :
        (q.options ? (() => { try { return JSON.parse(String(q.options)); } catch { return []; } })() : []);
      return [String(i + 1), q.text, q.type, opts.join(", ")];
    }),
  ];
}

function buildResponsesRows(questions: SurveySheetData["questions"], responses: SurveySheetData["responses"]): string[][] {
  const header = ["Name", "ID", "Phone", "Date", ...questions.map(q => q.text)];
  return [
    header,
    ...responses.map(r => [
      r.name,
      r.externalId ?? "",
      r.phone,
      r.date,
      ...questions.map(q => r.answers[String(q.id)] ?? ""),
    ]),
  ];
}

async function syncQuestionsAndResponses(sheets: any, spreadsheetId: string, data: SurveySheetData): Promise<void> {
  const questionsRows = buildQuestionsRows(data.questions);
  const responsesData = buildResponsesRows(data.questions, data.responses);
  const colCount = Math.max(responsesData[0]?.length ?? 1, 1);

  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges: ["Questions", "Responses"] },
  });

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: "Questions!A1", values: questionsRows },
        { range: "Responses!A1", values: responsesData },
      ],
    },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } } }, fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor" } },
        { repeatCell: { range: { sheetId: 2, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 } } }, fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor" } },
        { autoResizeDimensions: { dimensions: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 4 } } },
        { autoResizeDimensions: { dimensions: { sheetId: 2, dimension: "COLUMNS", startIndex: 0, endIndex: colCount } } },
      ],
    },
  });
}

async function initContactsTab(sheets: any, spreadsheetId: string, contacts: SurveySheetData["contacts"]): Promise<void> {
  const rows = [
    ["Name", "ID", "WhatsApp Number (include country code, e.g. +12025551234)"],
    ...contacts.map(c => [c.name, c.externalId ?? "", c.whatsAppNumber]),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Contacts!A1",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { repeatCell: { range: { sheetId: 1, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.96, blue: 1.0 } } }, fields: "userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor" } },
        { autoResizeDimensions: { dimensions: { sheetId: 1, dimension: "COLUMNS", startIndex: 0, endIndex: 3 } } },
      ],
    },
  });
}

export async function createSurveySheet(
  title: string,
  data: SurveySheetData,
  email: string,
  folderId?: string
): Promise<{ spreadsheetId: string; url: string }> {
  const auth = await loadSavedCredentialsIfExist();
  if (!auth) throw new Error("Google API not authorized. Run: bun run tools/googleapi/index.ts del");

  const sheets = google.sheets({ version: "v4", auth });
  const drive  = google.drive({ version: "v3", auth });

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        { properties: { title: "Questions", sheetId: 0 } },
        { properties: { title: "Contacts", sheetId: 1 } },
        { properties: { title: "Responses", sheetId: 2 } },
      ],
    },
  });
  const spreadsheetId = created.data.spreadsheetId!;

  if (folderId) {
    await drive.files.update({
      fileId: spreadsheetId,
      addParents: folderId,
      removeParents: "root",
      fields: "id, parents",
    });
  }

  await Promise.all([
    syncQuestionsAndResponses(sheets, spreadsheetId, data),
    initContactsTab(sheets, spreadsheetId, data.contacts),
  ]);
  await shareWithEmail(drive, spreadsheetId, email);

  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
}

export async function syncSurveySheet(
  spreadsheetId: string,
  data: SurveySheetData
): Promise<string> {
  const auth = await loadSavedCredentialsIfExist();
  if (!auth) throw new Error("Google API not authorized. Run: bun run tools/googleapi/index.ts del");

  const sheets = google.sheets({ version: "v4", auth });

  // Clear Contacts first, then repopulate all tabs in parallel
  await sheets.spreadsheets.values.batchClear({
    spreadsheetId,
    requestBody: { ranges: ["Contacts"] },
  });

  await Promise.all([
    syncQuestionsAndResponses(sheets, spreadsheetId, data),
    initContactsTab(sheets, spreadsheetId, data.contacts),
  ]);

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

export async function readContactsFromSheet(
  spreadsheetId: string
): Promise<Array<{ name: string; externalId: string | null; whatsAppNumber: string }>> {
  const auth = await loadSavedCredentialsIfExist();
  if (!auth) throw new Error("Google API not authorized. Run: bun run tools/googleapi/index.ts del");

  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Contacts!A2:C",
  });

  // Columns: A=Name, B=ID, C=WhatsApp Number
  return (res.data.values ?? [])
    .filter(row => row[0] || row[2])
    .map(row => ({
      name: String(row[0] || ""),
      externalId: row[1] ? String(row[1]) : null,
      whatsAppNumber: String(row[2] || ""),
    }));
}

export { google };
