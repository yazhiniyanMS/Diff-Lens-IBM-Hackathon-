# Orders API

## GET /api/orders/:id

Returns the full detail for a single order. Used by the order confirmation
page (`frontend/src/OrderCard.js`) immediately after checkout.

### Response shape

```json
{
  "id": "ORD-1001",
  "customerName": "Priya Nair",
  "total": 129.5,
  "items": [
    { "sku": "SKU-1", "label": "Wireless Mouse", "qty": 1, "price": 29.5 }
  ],
  "status": "PROCESSING"
}
```

| Field          | Type   | Notes                                  |
| -------------- | ------ | --------------------------------------- |
| `id`           | string | Order identifier                        |
| `customerName` | string | Full name of the customer               |
| `total`        | number | Order total in USD                      |
| `items`        | array  | Line items                              |
| `status`       | string | One of `PROCESSING`, `SHIPPED`, `DONE`  |

Consumers of this endpoint (keep in sync when the response shape changes):

- `frontend/src/OrderCard.js` — reads `customerName`
- `tests/orders.contract.test.js` — asserts the response contract

## GET /api/orders

Returns a summary list of orders using the same field names as the detail
endpoint (`id`, `customerName`, `total`, `status`).
