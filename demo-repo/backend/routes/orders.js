import { Router } from "express";
import { getOrderById, listOrders } from "../models/order.js";

const router = Router();

// GET /api/orders - list orders (summary shape)
router.get("/", (req, res) => {
  const orders = listOrders().map((order) => ({
    id: order.id,
    customerName: order.customerName,
    total: order.total,
    status: order.status,
  }));
  res.json({ orders });
});

// GET /api/orders/:id - full order detail, consumed by the customer-facing
// order confirmation page (frontend/src/OrderCard.js).
router.get("/:id", (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.json({
    id: order.id,
    customerName: order.customerName,
    total: order.total,
    items: order.items,
    status: order.status,
  });
});

export default router;
