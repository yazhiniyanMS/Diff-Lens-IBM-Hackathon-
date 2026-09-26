// Thin API client used by the order confirmation page.

export async function fetchOrder(orderId) {
  const res = await fetch(`/api/orders/${orderId}`);
  if (!res.ok) {
    throw new Error(`Failed to load order ${orderId}: ${res.status}`);
  }
  return res.json();
}
