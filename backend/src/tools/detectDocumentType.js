import { DynamicTool } from "@langchain/core/tools";
import Groq from "groq-sdk";

// Lazy init — avoids instantiating before dotenv.config() runs in index.js
let _groq = null;
const getGroq = () => _groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY });

export const detectDocumentTypeTool = new DynamicTool({
    name: "detect_document_type",
    description: "Detect what type of employment document this is based on its content.",
    func: async (text) => {
        try {
            const response = await getGroq().chat.completions.create({
                model: "llama-3.3-70b-versatile",
                max_tokens: 200,
                temperature: 0,
                messages: [{
                    role: "user",
                    content: `Classify this document as exactly one of:
offer_letter, employment_contract, internship_agreement, freelancer_contract, nda

Return ONLY valid JSON: { "type": "...", "confidence": "high/medium/low" }

Document text (first 800 chars):
${text.slice(0, 800)}`
                }]
            });
            return response.choices[0].message.content;
        } catch (err) {
            console.error("detectDocumentType failed:", err.message);
            // Graceful degradation — return low-confidence unknown
            return JSON.stringify({ type: "employment_contract", confidence: "low", error: err.message });
        }
    }
});