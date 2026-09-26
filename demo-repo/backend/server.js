import express from "express";
import ordersRouter from "./routes/orders.js";

const app = express();
app.use(express.json());
app.use("/api/orders", ordersRouter);

const PORT = process.env.PORT || 4100;

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(PORT, () => {
    console.log(`Orders demo API listening on :${PORT}`);
  });
}

export default app;
