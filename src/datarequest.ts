import { Queue } from "bullmq";
import { prisma } from "../tools/prisma.ts";
import { chunkText } from "../tools/VectorTable.ts";
import { buildOrgIndex, deriveDocumentMetadata, toPrismaDate } from "../tools/documentMetadata.ts";

const docQueue = new Queue("document-processing", {
    connection: {
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
    },
});

async function request(apiPath: string, options?: RequestInit): Promise<any> {
    const res = await fetch(`https://datarequest.cgcharitable.org/${apiPath}`, {
        headers: { Authorization: process.env.DR_API_KEY! },
        ...options
    });
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (error) {
        console.warn(`Failed to parse JSON response from ${apiPath}`);
        return text;
    }
}

async function exportDataRequest(governmentId: string, year: number): Promise<string> {
    const res = await fetch(`https://datarequest.cgcharitable.org/api/exportDataRequest/${governmentId}/${year}`, {
        headers: { Authorization: process.env.DR_API_KEY! },
    });
    return await res.text();
}

interface OrgDataRequest {
    year: number;
    status: string;
    id: string;
    approvalStatus: string;
}

interface Org {
    name: string;
    govId: string;
    dataRequests: OrgDataRequest[];
}

async function getOrgs(): Promise<Org[]> {
    const orgs = await request("api/organization");
    const dqs = await request("api/dataRequest")
    const joined = orgs.map((org: any) => {
        const dq = dqs.filter((dq: any) => dq.organizationId === org.id);
        return { ...org, dataRequests: dq };
    });
    const result = joined.map((e: any) => {
        const obj = {
            name: e.name,
            govId: e.govId,
            dataRequests: e.dataRequests?.map((dq: any) => ({
                year: dq.year,
                status: dq.status,
                id: dq.id,
                approvalStatus: dq.approvalStatus,
            })) || []
        }
        return obj;
    });
    return result;
}

interface DataRequestDoc extends OrgDataRequest {
    govId: string;
    orgName: string;
    markdown: string;
}

async function getAllDataRequestDocs(): Promise<DataRequestDoc[]> {
    const orgs = await getOrgs();
    const allDocs: DataRequestDoc[] = [];
    for (const org of orgs) {
        for (const dq of org.dataRequests) {
            const markdown = await exportDataRequest(org.govId, dq.year);
            allDocs.push({ ...dq, govId: org.govId, orgName: org.name, markdown });
        }
    }
    return allDocs;
}

/** Stable key identifying "this org's data request for this year", used to find and replace a prior ingest. */
function dataRequestStorageKey(govId: string, year: number): string {
    return `datarequest://${govId}/${year}`;
}

/**
 * Fetch every org's data-request export and queue it for embedding into the knowledge base.
 * A document already ingested for the same org+year (matched by storageUrl) is replaced in
 * place: its old chunks are dropped so the re-embed reflects the fresh export instead of
 * leaving stale duplicates behind.
 */
async function queueDataRequestDocs(): Promise<void> {
    const docs = await getAllDataRequestDocs();
    const db = prisma as any;
    const orgIndex = buildOrgIndex(docs.map((d) => ({ name: d.orgName, govId: d.govId })));

    for (const doc of docs) {
        if (typeof doc.markdown !== "string" || !doc.markdown.trim()) {
            console.warn(`[datarequest] empty export for ${doc.orgName} (${doc.govId}) ${doc.year}, skipping`);
            continue;
        }

        const storageUrl = dataRequestStorageKey(doc.govId, doc.year);
        const filename = `${doc.orgName} - ${doc.year} Data Request.md`;
        const meta = deriveDocumentMetadata({ storageUrl, filename, status: "PENDING", errorMessage: null }, orgIndex);
        const metaFields = {
            orgGovId: meta.orgGovId,
            orgName: meta.orgName,
            fundingStatus: meta.fundingStatus,
            documentYear: meta.documentYear,
            documentDate: toPrismaDate(meta.documentDate),
            category: meta.category,
            language: meta.language,
            docProvenance: meta.docProvenance,
            isTemplate: meta.isTemplate,
            containsPii: meta.containsPii,
        };
        const existing = await db.knowledgeDocument.findFirst({ where: { storageUrl } });

        let documentId: string;
        if (existing) {
            await db.knowledgeChunk.deleteMany({ where: { documentId: existing.id } });
            await db.knowledgeDocument.update({
                where: { id: existing.id },
                data: { filename, rawText: doc.markdown, status: "CHUNKING", errorMessage: null, ...metaFields },
            });
            documentId = existing.id;
            console.log(`[datarequest] replacing existing document for ${filename}`);
        } else {
            const created = await db.knowledgeDocument.create({
                data: { filename, fileType: "MD", storageUrl, rawText: doc.markdown, status: "CHUNKING", ...metaFields },
            });
            documentId = created.id;
            console.log(`[datarequest] creating new document for ${filename}`);
        }

        const textChunks = chunkText(doc.markdown);
        await db.knowledgeChunk.createMany({
            data: textChunks.map((content: string, index: number) => ({ documentId, chunkIndex: index, content })),
        });

        await db.knowledgeDocument.update({ where: { id: documentId }, data: { status: "READY" } });
        await docQueue.add("embed-chunks", { documentId });
        console.log(`[datarequest] queued embed-chunks for ${filename} (${textChunks.length} chunks)`);
    }
}

// Allow running standalone: `bun src/datarequest.ts`
if (import.meta.main) {
    queueDataRequestDocs()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

export { getOrgs, exportDataRequest, getAllDataRequestDocs, queueDataRequestDocs };
