import express from "express";
import multer from "multer";
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
  if (err instanceof multer.MulterError) {
    const friendly = {
      LIMIT_FILE_COUNT: "That folder has too many files to upload. DiffLens already skips node_modules/dist/build/.git objects aside — try excluding other large generated folders, or upload a .zip instead.",
      LIMIT_FILE_SIZE: "One of the files is larger than the 150MB per-file upload limit.",
    }[err.code];
    return res.status(413).json({ error: friendly || `Upload rejected: ${err.message}` });
  }
  res.status(500).json({ error: err.message || "Internal error" });
});

// DIFFLENS_PORT is DiffLens's own override; PORT is the convention most
// PaaS hosts (Render, Railway, Heroku, ...) inject automatically.
const PORT = process.env.DIFFLENS_PORT || process.env.PORT || 5175;
app.listen(PORT, () => {
  console.log(`DiffLens server listening on http://localhost:${PORT}`);
});
