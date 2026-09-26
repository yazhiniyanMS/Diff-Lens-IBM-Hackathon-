// In-memory order store for the demo application.

const orders = new Map([
  [
    "ORD-1001",
    {
      id: "ORD-1001",
      customerName: "Priya Nair",
      total: 129.5,
      items: [
        { sku: "SKU-1", label: "Wireless Mouse", qty: 1, price: 29.5 },
        { sku: "SKU-2", label: "Mechanical Keyboard", qty: 1, price: 100 },
      ],
      status: "PROCESSING",
    },
  ],
  [
    "ORD-1002",
    {
      id: "ORD-1002",
      customerName: "Daniel Kim",
      total: 49.99,
      items: [{ sku: "SKU-3", label: "USB-C Cable", qty: 2, price: 24.995 }],
      status: "SHIPPED",
    },
  ],
]);

export function getOrderById(id) {
  return orders.get(id) || null;
}

export function listOrders() {
  return Array.from(orders.values());
}
