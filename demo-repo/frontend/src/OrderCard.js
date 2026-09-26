import { fetchOrder } from "./api.js";

// Renders the customer-facing order confirmation card.
// Relies on the /api/orders/:id response shape documented in
// docs/api/orders.md (fields: id, customerName, total, items, status).
export async function renderOrderCard(orderId, container) {
  const order = await fetchOrder(orderId);

  const el = document.createElement("div");
  el.className = "order-card";
  el.innerHTML = `
    <h2>Thank you, ${order.customerName}!</h2>
    <p>Order ${order.id} — $${order.total.toFixed(2)}</p>
    <ul>
      ${order.items.map((item) => `<li>${item.label} x${item.qty}</li>`).join("")}
    </ul>
    <span class="status">${order.status}</span>
  `;
  container.appendChild(el);
  return order;
}
