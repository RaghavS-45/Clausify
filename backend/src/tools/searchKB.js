import { DynamicTool } from "@langchain/core/tools";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { PineconeStore } from "@langchain/community/vectorstores/pinecone";
import { getPineconeIndex } from "../vectorstore/client.js";

// Timeout wrapper — rejects after ms milliseconds
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        )
    ]);
}

export const searchKBTool = new DynamicTool({
    name: "search_clause_kb",
    description: "Search the knowledge base for plain-English explanation and risk assessment of a specific clause type.",
    func: async (query) => {
        try {
            const index = await withTimeout(getPineconeIndex(), 8000, "Pinecone connect");
            const vectorStore = await PineconeStore.fromExistingIndex(
                new HuggingFaceInferenceEmbeddings({
                    apiKey: process.env.HUGGINGFACE_API_KEY,
                    model: "sentence-transformers/all-MiniLM-L6-v2",
                }),
                { pineconeIndex: index }
            );
            const results = await withTimeout(
                vectorStore.similaritySearch(query, 3),
                10000,
                "Pinecone search"
            );
            if (results.length === 0) return "No relevant information found in knowledge base.";
            return results.map(r => r.pageContent).join("\n\n---\n\n");
        } catch (err) {
            console.error("searchKB failed (non-fatal):", err.message);
            // Non-fatal — the LLM synthesis can proceed without KB context
            return "Knowledge base temporarily unavailable. Proceeding with general employment law knowledge.";
        }
    }
});