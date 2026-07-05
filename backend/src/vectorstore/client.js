import { Pinecone } from "@pinecone-database/pinecone";

let pineconeClient = null;

export async function getPineconeIndex() {
    if (!pineconeClient) {
        pineconeClient = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY,
        });
    }
    return pineconeClient.index(process.env.PINECONE_INDEX_NAME);
}