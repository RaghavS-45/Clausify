import "dotenv/config";   // ← must be first: loads .env before any other module body runs
import express from "express";
import cors from "cors";
import analyzeRoute from "./routes/analyze.js";

const app = express();
app.use(cors({
  origin: '*',          // allow file:// and any localhost port during dev
  methods: ['POST'],
}));
app.use(express.json());
app.use("/api", analyzeRoute);

app.listen(process.env.PORT || 5000, () => {
    console.log(`Server running on port ${process.env.PORT || 5000}`);
});