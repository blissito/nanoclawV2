---
name: mercadopago
description: Create MercadoPago payment links to collect payments in MXN. Auth via OneCLI proxy.
allowed-tools: Bash(mercadopago:*)
---

# MercadoPago Payment Links

Create payment links for MercadoPago Checkout Pro. Auth is handled by OneCLI — the script always passes `Authorization: Bearer placeholder` and the HTTPS proxy rewrites it with the real `MP_ACCESS_TOKEN` at `api.mercadopago.com`.

## Usage

```bash
# Create a payment link
mercadopago create-link <amount> "<description>"

# Examples
mercadopago create-link 50 "Cooperación por preguntar el modelo"
mercadopago create-link 100 "Servicio premium"
```

## Output

Returns a checkout URL (the `init_point`) that the user can open to pay. Send it back via `send_message`.

## Important

- Amount is in MXN (Mexican pesos). For other currencies, edit the `currency_id` in the script.
- Links expire after 24 hours.
- Do NOT call the MercadoPago API directly — always use this script. The script's auth header is intentionally `placeholder` and will fail outside the proxy.

## Troubleshooting

- **`unauthorized` from MercadoPago**: OneCLI secret for MercadoPago not configured or not assigned to this agent. Tell the user to re-run `/add-mercadopago` on the host.
- **`invalid_amount`**: Check the amount is a positive number with no currency symbol.
