/**
 * Clausify — Knowledge Base Ingestion Script
 * Ingests all .txt documents in this directory into Pinecone.
 *
 * Uses HuggingFace Inference API for embeddings (same as searchKB.js).
 *
 * Usage:
 *   node ingestKB.js           # incremental upsert
 *   node ingestKB.js --fresh   # delete all vectors first, then re-ingest
 *
 * Requires in ../.env:
 *   PINECONE_API_KEY
 *   PINECONE_INDEX_NAME   (e.g. "contracts")
 *   HUGGINGFACE_API_KEY
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { Pinecone } from "@pinecone-database/pinecone";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const KB_DIR       = __dirname;
const CHUNK_SIZE   = 800;    // characters per chunk
const CHUNK_OVERLAP = 120;   // overlap keeps context across chunks
const BATCH_SIZE   = 96;     // HF Inference API: keep under 100 to be safe

// Maps each KB file slug → document types it applies to (used as metadata)
const DOCUMENT_TYPE_MAP = {
  offer_letter_ctc_components:    ["offer_letter", "employment_contract"],
  offer_letter_red_flags:         ["offer_letter"],
  notice_period_standards:        ["employment_contract", "offer_letter"],
  non_compete_standards:          ["employment_contract", "offer_letter"],
  probation_and_termination:      ["employment_contract", "offer_letter"],
  ip_and_confidentiality:         ["employment_contract", "offer_letter", "nda"],
  nda_standards:                  ["nda"],
  internship_agreement_standards: ["internship_agreement"],
  esop_and_equity:                ["offer_letter", "employment_contract"],
  work_location_and_relocation:   ["employment_contract", "offer_letter"],
  employment_bonds:               ["employment_contract", "offer_letter", "internship_agreement"],
  leave_and_benefits:             ["employment_contract", "offer_letter"],
  dispute_resolution:             ["employment_contract", "offer_letter", "nda", "internship_agreement"],
  questions_to_ask_before_signing:["offer_letter", "employment_contract", "internship_agreement", "nda"],
  negotiation_strategies:         ["offer_letter", "employment_contract", "internship_agreement"],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugToTitle(slug) {
  return slug.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

async function loadDocuments() {
  const files = fs
    .readdirSync(KB_DIR)
    .filter(f => f.endsWith(".txt"));

  const docs = [];
  for (const file of files) {
    const slug = path.basename(file, ".txt");
    const fullPath = path.join(KB_DIR, file);
    const text = fs.readFileSync(fullPath, "utf-8");
    docs.push({ slug, text, file });
    console.log(`📄 Loaded: ${file} (${text.length} chars)`);
  }
  return docs;
}

async function splitDocuments(docs) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: ["\n---\n", "\n\n", "\n", " "],
  });

  const chunks = [];
  for (const doc of docs) {
    const parts = await splitter.createDocuments(
      [doc.text],
      [{
        source: doc.file,
        slug: doc.slug,
        title: slugToTitle(doc.slug),
        applicable_to: DOCUMENT_TYPE_MAP[doc.slug] ?? [],
      }]
    );
    chunks.push(...parts);
    console.log(`✂️  ${doc.slug}: ${parts.length} chunks`);
  }
  return chunks;
}

async function embedAndUpsert(chunks, index) {
  // ── Use HuggingFace Inference API (same model as searchKB.js) ──
  const embedder = new HuggingFaceInferenceEmbeddings({
    apiKey: process.env.HUGGINGFACE_API_KEY,
    model: "sentence-transformers/all-MiniLM-L6-v2",
  });

  console.log(`\n🔢 Embedding ${chunks.length} chunks via HF Inference API...`);
  console.log(`   Model: sentence-transformers/all-MiniLM-L6-v2\n`);

  let batchNum = 0;
  const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    batchNum++;
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map(c => c.pageContent);

    let embeddings;
    try {
      embeddings = await embedder.embedDocuments(texts);
    } catch (err) {
      console.error(`\n❌ Embedding failed on batch ${batchNum}:`, err.message);
      console.error("   Check your HUGGINGFACE_API_KEY and try again.");
      process.exit(1);
    }

    const vectors = batch.map((chunk, j) => ({
      id: `${chunk.metadata.slug}_chunk_${i + j}`,
      values: embeddings[j],
      metadata: {
        text: chunk.pageContent,
        source: chunk.metadata.source,
        title: chunk.metadata.title,
        slug: chunk.metadata.slug,
        applicable_to: chunk.metadata.applicable_to,
      },
    }));

    await index.upsert(vectors);
    console.log(`  ✅ Batch ${batchNum}/${totalBatches} upserted (${batch.length} vectors)`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Clausify — Knowledge Base Ingestion");
  console.log("═══════════════════════════════════════════════\n");

  // Validate env
  const required = ["PINECONE_API_KEY", "PINECONE_INDEX_NAME", "HUGGINGFACE_API_KEY"];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`❌ Missing env var: ${key}`);
      process.exit(1);
    }
  }

  // Init Pinecone
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const index = pc.index(process.env.PINECONE_INDEX_NAME);

  // Optional: clear existing vectors before re-ingesting
  if (process.argv.includes("--fresh")) {
    console.log("🗑️  --fresh flag detected: deleting all existing vectors...");
    try {
      await index.deleteAll();
      console.log("   Done.\n");
    } catch (err) {
      // 404 = index is already empty (no namespace exists yet) — safe to continue
      if (err.name === "PineconeNotFoundError" || err.message?.includes("404")) {
        console.log("   Index was empty, nothing to delete. Continuing...\n");
      } else {
        throw err; // unexpected error — re-throw
      }
    }
  }

  const docs   = await loadDocuments();
  const chunks = await splitDocuments(docs);

  console.log(`\n📊 Total chunks to embed: ${chunks.length}`);

  await embedAndUpsert(chunks, index);

  console.log("\n🎉 Ingestion complete!");
  console.log(`   Documents ingested : ${docs.length}`);
  console.log(`   Total vectors      : ${chunks.length}`);
  console.log(`   Pinecone index     : ${process.env.PINECONE_INDEX_NAME}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
