import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import apiRouter from "./routes/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.use("/api", apiRouter);
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Centralized error handler so pipeline/git/patch errors surface as JSON
// instead of crashing the process or leaking stack traces to the client.
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal error" });
});

const PORT = process.env.DIFFLENS_PORT || 5175;
app.listen(PORT, () => {
  console.log(`DiffLens server listening on http://localhost:${PORT}`);
});
