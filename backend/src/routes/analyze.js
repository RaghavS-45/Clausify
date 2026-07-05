import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import fs from "fs";
import { runContractAgent, NotAContractError } from "../agents/contractAgent.js";

const router = express.Router();

// ── File size and type constraints ────────────────────────────────────────
const upload = multer({
    dest: "uploads/",
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    fileFilter: (req, file, cb) => {
        const allowed = ["application/pdf", "text/plain"];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            // Pass error through multer so it reaches the error handler
            cb(Object.assign(new Error(
                `Unsupported file type "${file.mimetype}". Please upload a PDF or plain-text (.txt) file.`
            ), { code: "INVALID_FILE_TYPE", statusCode: 415 }));
        }
    }
});

// ── Multer error middleware ───────────────────────────────────────────────
function handleMulterError(err, req, res, next) {
    if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
            error: "File too large. The maximum allowed size is 10 MB.",
            code: "FILE_TOO_LARGE"
        });
    }
    if (err.code === "INVALID_FILE_TYPE") {
        return res.status(415).json({
            error: err.message,
            code: "INVALID_FILE_TYPE"
        });
    }
    next(err);
}

// ── Main analysis endpoint ────────────────────────────────────────────────
router.post("/analyze", (req, res, next) => {
    upload.single("document")(req, res, err => {
        if (err) return handleMulterError(err, req, res, next);
        next();
    });
}, async (req, res) => {
    const filePath = req.file?.path;

    try {
        if (!req.file) {
            return res.status(400).json({
                error: "No file uploaded. Please attach a document to the request.",
                code: "NO_FILE"
            });
        }

        let documentText;

        if (req.file.mimetype === "text/plain") {
            documentText = fs.readFileSync(filePath, "utf-8");
        } else {
            // Parse PDF
            let buffer;
            try {
                buffer = fs.readFileSync(filePath);
            } catch {
                return res.status(500).json({
                    error: "Could not read the uploaded file. Please try again.",
                    code: "FILE_READ_ERROR"
                });
            }

            try {
                const parsed = await pdfParse(buffer);
                documentText = parsed.text;
            } catch (pdfErr) {
                return res.status(422).json({
                    error: "Could not parse the PDF. The file may be corrupted, password-protected, or a scanned image without selectable text.",
                    code: "PDF_PARSE_ERROR"
                });
            }
        }

        // Minimum viable text length
        if (!documentText || documentText.trim().length < 100) {
            return res.status(422).json({
                error: "The document appears to be empty or contains only scanned images. Make sure the PDF has selectable text (not a scan).",
                code: "INSUFFICIENT_TEXT"
            });
        }

        const result = await runContractAgent(documentText);

        // Flag partial results to the client
        if (result._partial) {
            return res.status(206).json({
                success: true,
                partial: true,
                data: result
            });
        }

        res.json({ success: true, data: result });

    } catch (err) {
        console.error("Agent error:", err);

        // Document type mismatch — user-facing 422
        if (err instanceof NotAContractError) {
            return res.status(422).json({
                error: err.message,
                code: "NOT_A_CONTRACT"
            });
        }

        // Timeout — let the client know to retry
        if (err.message?.includes("timed out")) {
            return res.status(504).json({
                error: "Analysis took too long. This sometimes happens with complex documents — please try again.",
                code: "TIMEOUT"
            });
        }

        // Generic fallback
        res.status(500).json({
            error: "An unexpected error occurred during analysis. Please try again in a moment.",
            code: "INTERNAL_ERROR",
            detail: process.env.NODE_ENV === "development" ? err.message : undefined
        });

    } finally {
        // Always clean up the uploaded file
        try {
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (cleanupErr) {
            console.error("File cleanup failed:", cleanupErr.message);
        }
    }
});

export default router;