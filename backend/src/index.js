import "dotenv/config";   // ← must be first: loads .env before any other module body runs
import express from "express";
import cors from "cors";
import analyzeRoute from "./routes/analyze.js";

const app = express();
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? 'https://clausify.vercel.app'
    : '*',
  methods: ['GET', 'POST']
}));

app.use(express.json());

// Health check endpoint — keeps Render alive + used by cron-job.org
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", analyzeRoute);

app.listen(process.env.PORT || 5000, () => {
  console.log(`Server running on port ${process.env.PORT || 5000}`);
});