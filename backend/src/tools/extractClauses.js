import { DynamicTool } from "@langchain/core/tools";
import Groq from "groq-sdk";

// Lazy init — avoids instantiating before dotenv.config() runs in index.js
let _groq = null;
const getGroq = () => _groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY });

export const extractClausesTool = new DynamicTool({
    name: "extract_and_classify_clauses",
    description: "Extract all important clauses from the document text and classify each one.",
    func: async (text) => {
        try {
            const response = await getGroq().chat.completions.create({
                model: "llama-3.3-70b-versatile",
                max_tokens: 2000,
                temperature: 0,
                messages: [{
                    role: "user",
                    content: `Extract all important clauses from this employment document.

For each clause return:
{
  "type": "bond/variable_pay/ip_assignment/non_compete/notice_period/probation/nda_scope/payment_terms/...",
  "raw_text": "exact text from document",
  "detected_value": "the specific value/duration/amount mentioned"
}

Return ONLY a valid JSON array. No explanation.

Document:
${text}`
                }]
            });
            return response.choices[0].message.content;
        } catch (err) {
            console.error("extractClauses failed:", err.message);
            // Return empty array so pipeline continues without clauses
            return JSON.stringify([]);
        }
    }
});