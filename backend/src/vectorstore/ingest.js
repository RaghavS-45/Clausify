import fs from "fs";
import path from "path";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { PineconeStore } from "@langchain/community/vectorstores/pinecone";
import { Document } from "langchain/document";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { getPineconeIndex } from "./client.js";
import dotenv from "dotenv";
dotenv.config();

async function ingest() {
    const kbDir = path.resolve("kb");
    const files = fs.readdirSync(kbDir).filter(f => f.endsWith(".txt"));

    const docs = files.map(file => {
        const content = fs.readFileSync(path.join(kbDir, file), "utf-8");
        const clauseMatch = content.match(/Clause:\s*(.+)/);
        const appliesToMatch = content.match(/Applies to:\s*(.+)/);
        const categoryMatch = content.match(/Category:\s*(.+)/);

        return new Document({
            pageContent: content,
            metadata: {
                clause: clauseMatch?.[1]?.trim() || file,
                applies_to: appliesToMatch?.[1]?.trim() || "all",
                category: categoryMatch?.[1]?.trim() || "general",
                source: file
            }
        });
    });

    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 600,
        chunkOverlap: 60,
    });

    const chunks = await splitter.splitDocuments(docs);
    console.log(`Embedding ${chunks.length} chunks from ${docs.length} documents...`);

    const embeddings = new HuggingFaceInferenceEmbeddings({
        apiKey: process.env.HUGGINGFACE_API_KEY,
        model: "sentence-transformers/all-MiniLM-L6-v2",
    });

    const index = await getPineconeIndex();
    await PineconeStore.fromDocuments(chunks, embeddings, { pineconeIndex: index });

    console.log("✅ KB ingested successfully into Pinecone.");
}

ingest().catch(console.error);