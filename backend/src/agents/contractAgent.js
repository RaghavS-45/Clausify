import Groq from "groq-sdk";
import { detectDocumentTypeTool } from "../tools/detectDocumentType.js";
import { extractClausesTool } from "../tools/extractClauses.js";
import { searchKBTool } from "../tools/searchKB.js";
import { calculateCTCTool } from "../tools/calculateCTC.js";

// ─── Custom error for documents that aren't contracts ──────────────────────
export class NotAContractError extends Error {
    constructor(message) {
        super(message);
        this.name = "NotAContractError";
        this.statusCode = 422;
    }
}

// ─── Groq call with timeout ────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        )
    ]);
}

// ─── Content sanity check ─────────────────────────────────────────────────
const CONTRACT_KEYWORDS = [
    "employment", "offer", "salary", "ctc", "compensation", "designation",
    "joining", "position", "role", "notice period", "probation", "contract",
    "agreement", "nda", "confidential", "internship", "stipend",
    "clause", "terms", "conditions", "party", "employer", "employee",
    "remuneration", "payment", "package", "work", "duties"
];

function looksLikeContract(text) {
    const lower = text.toLowerCase();
    const hits = CONTRACT_KEYWORDS.filter(kw => lower.includes(kw));
    return hits.length >= 3; // at least 3 contract-related keywords
}

// ─── Main pipeline ────────────────────────────────────────────────────────
export async function runContractAgent(documentText) {

    // ── Guard: not a contract ──────────────────────────────────────────────
    if (!looksLikeContract(documentText)) {
        throw new NotAContractError(
            "The uploaded document doesn't appear to be an employment contract, " +
            "offer letter, NDA, or internship agreement. Please upload a relevant legal document."
        );
    }

    console.log("\n🔍 Step 1: Detecting document type...");
    const docTypeRaw = await detectDocumentTypeTool.func(documentText);
    const docType = safeParseJSON(docTypeRaw);
    console.log("   →", docType);

    console.log("\n📋 Step 2: Extracting clauses...");
    const clausesRaw = await extractClausesTool.func(documentText);
    const clauses = safeParseJSON(clausesRaw);
    console.log(`   → ${Array.isArray(clauses) ? clauses.length : "?"} clauses found`);

    console.log("\n📚 Step 3: Searching knowledge base...");
    const clauseTypes = Array.isArray(clauses) && clauses.length > 0
        ? clauses.map(c => c.type).join(", ")
        : "notice period bond non-compete NDA IP assignment";
    const kbContext = await searchKBTool.func(`${clauseTypes} employment India`);
    console.log("   → KB context retrieved");

    console.log("\n💰 Step 4: Calculating CTC (if applicable)...");
    let ctcResult = null;

    // Strategy 1: find a clause that looks like compensation
    let ctcAnnual = null;
    if (Array.isArray(clauses)) {
        const compTypes = /salary|ctc|compensation|pay|package|remuneration|cost.to.company/i;
        const compClause = clauses.find(c =>
            compTypes.test(c.type + " " + (c.detected_value || ""))
        );
        if (compClause?.detected_value) {
            const nums = (compClause.detected_value + " " + (compClause.raw_text || ""))
                .replace(/,/g, "")
                .match(/\d{4,}/g);
            if (nums) {
                const biggest = Math.max(...nums.map(Number));
                ctcAnnual = biggest < 200 ? biggest * 100000 : biggest;
            }
        }
    }

    // Strategy 2: scan raw document for CTC/salary figures as fallback
    if (!ctcAnnual) {
        const ctcMatch = documentText.match(
            /(?:total\s+)?(?:ctc|cost\s+to\s+company|annual\s+(?:ctc|salary|package))[\s\S]{0,80}?(?:INR|Rs\.?|₹)?\s*([\d,]+)/i
        );
        if (ctcMatch) {
            const raw = parseInt(ctcMatch[1].replace(/,/g, ""));
            ctcAnnual = raw < 200 ? raw * 100000 : raw;
        }
    }

    if (ctcAnnual && ctcAnnual > 50000) {
        let variablePct = 0;
        const varMatch = documentText.match(/variable[\s\S]{0,60}?(\d{1,2})\s*%/i)
            || documentText.match(/(\d{1,2})\s*%[\s\S]{0,60}?variable/i);
        if (varMatch) variablePct = Math.min(parseInt(varMatch[1]), 50);

        try {
            const raw = await calculateCTCTool.func(JSON.stringify({
                ctc_annual: ctcAnnual,
                variable_percent: variablePct,
                pf_included: true
            }));
            ctcResult = safeParseJSON(raw);
            console.log(`   → CTC: ${ctcAnnual} (variable: ${variablePct}%)`, ctcResult);
        } catch (err) {
            console.error("   → CTC calculation failed (non-fatal):", err.message);
        }
    } else {
        console.log("   → No compensation data found, skipping CTC");
    }

    console.log("\n✍️  Step 5: Synthesizing final analysis...");
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    let synthesis;
    try {
        synthesis = await withTimeout(
            groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                max_tokens: 3500,
                temperature: 0,
                messages: [
                    {
                        role: "system",
                        content: `You are an employment contract analyzer for Indian professionals.
Return ONLY a valid JSON object — no markdown, no explanation outside the JSON.`
                    },
                    {
                        role: "user",
                        content: `Analyze this employment document and return a structured JSON explanation.

DOCUMENT TYPE DETECTED: ${JSON.stringify(docType)}

EXTRACTED CLAUSES: ${JSON.stringify(clauses, null, 2)}

KNOWLEDGE BASE CONTEXT (Indian employment law benchmarks):
${kbContext}

CTC BREAKDOWN: ${ctcResult ? JSON.stringify(ctcResult) : "N/A"}

IMPORTANT — for each clause, use the KNOWLEDGE BASE CONTEXT above to fill in:
- standard_assessment: compare the detected_value against typical Indian market norms from the KB.
  Use exactly one of: "standard" | "above_average" | "unusual"
  • standard = falls within normal range for Indian employment
  • above_average = better or stricter than typical (e.g. longer notice, larger bond) but not uncommon
  • unusual = significantly outside norms, employer-favourable, or potentially unenforceable
- standard_note: one sentence explaining why (cite the relevant benchmark, e.g. "Typical notice period in India is 30–90 days")

Return this exact JSON structure:
{
  "document_type": "offer_letter | employment_contract | internship_agreement | freelancer_contract | nda",
  "summary": "2-3 sentence plain English overview",
  "risk_level": "low | medium | high",
  "ctc": ${ctcResult ? JSON.stringify(ctcResult) : "null"},
  "clauses": [
    {
      "type": "clause type",
      "severity": "low | medium | high",
      "detected_value": "what the document says",
      "plain_english": "what this means for you in simple terms",
      "is_red_flag": true or false,
      "standard_assessment": "standard | above_average | unusual",
      "standard_note": "one sentence citing the KB benchmark, e.g. Typical notice period in India is 30-90 days",
      "recommendation": "specific action or question to ask"
    }
  ],
  "red_flags": ["list of the most concerning issues"],
  "questions_to_ask": ["3-5 specific questions to ask HR or the other party"],
  "disclaimer": "This analysis is for informational purposes only and does not constitute legal advice. Consult a qualified lawyer before signing."
}`
                    }
                ]
            }),
            60000, // 60-second hard timeout on final synthesis
            "LLM synthesis"
        );
    } catch (err) {
        // If synthesis itself times out, return a partial result from what we know
        console.error("LLM synthesis failed:", err.message);
        return buildFallbackResult(docType, clauses, ctcResult, err.message);
    }

    const output = synthesis.choices[0].message.content;
    const parsed = safeParseJSON(output);

    // If JSON was malformed, try to recover from partial output
    if (parsed.error) {
        console.warn("LLM returned malformed JSON — attempting recovery:", parsed.raw_output?.slice(0, 100));
        const recovered = aggressiveJSONRecovery(output);
        if (recovered && !recovered.error) {
            console.log("   → JSON recovery succeeded");
            if (ctcResult) recovered.ctc = ctcResult;
            return recovered;
        }
        // Last resort: return a partial result with whatever we extracted
        return buildFallbackResult(docType, clauses, ctcResult, "Response parsing failed");
    }

    // Force-inject ctcResult — the LLM often ignores the template value and returns null
    if (ctcResult && typeof ctcResult === "object" && !parsed.error) {
        parsed.ctc = ctcResult;
    }

    console.log("\n✅ Analysis complete. CTC injected:", parsed.ctc ? "yes" : "no");
    return parsed;
}

// ─── JSON helpers ─────────────────────────────────────────────────────────

function safeParseJSON(raw) {
    if (typeof raw !== "string") return raw;
    const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        return { error: "Unparseable output", raw_output: raw.slice(0, 500) };
    }
}

// Tries to extract a valid JSON object even from a truncated/partially-streamed response
function aggressiveJSONRecovery(raw) {
    try {
        // Strip markdown fences
        let text = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

        // Try as-is first
        try { return JSON.parse(text); } catch { /* continue */ }

        // Find the first { and try to balance braces
        const start = text.indexOf("{");
        if (start === -1) return null;

        let depth = 0;
        let end = -1;
        for (let i = start; i < text.length; i++) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") {
                depth--;
                if (depth === 0) { end = i; break; }
            }
        }

        if (end !== -1) {
            const slice = text.slice(start, end + 1);
            try { return JSON.parse(slice); } catch { /* continue */ }
        }

        // Try closing an unclosed JSON object (truncated LLM output)
        if (end === -1 && depth > 0) {
            const closed = text.slice(start) + "}".repeat(depth);
            try { return JSON.parse(closed); } catch { /* continue */ }
        }

        return null;
    } catch {
        return null;
    }
}

// Build a minimal valid result when full synthesis fails
function buildFallbackResult(docType, clauses, ctcResult, reason) {
    console.warn("Building fallback result due to:", reason);
    return {
        document_type: docType?.type || "employment_contract",
        summary: "The document was uploaded and partially analyzed. Full synthesis was unavailable — please try again.",
        risk_level: "medium",
        ctc: ctcResult || null,
        clauses: Array.isArray(clauses) ? clauses.map(c => ({
            type: c.type,
            severity: "medium",
            detected_value: c.detected_value || "",
            plain_english: c.raw_text?.slice(0, 200) || "",
            is_red_flag: false,
            recommendation: "Review this clause carefully with a legal advisor."
        })) : [],
        red_flags: ["Full analysis could not be completed — please retry or consult a lawyer."],
        questions_to_ask: ["Please re-analyze the document for specific questions."],
        disclaimer: "This analysis is for informational purposes only and does not constitute legal advice. Consult a qualified lawyer before signing.",
        _partial: true,
        _reason: reason
    };
}