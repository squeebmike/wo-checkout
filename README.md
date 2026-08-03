# wo-checkout

Cloudflare Worker powering walkoffsc.com's checkout (Stripe automatic-capture flow)
and its live, Supabase-backed inventory display (`#wo-live-shop` on the site,
filled in by the `<script src=".../wo-cart.js">` embed).

This repo did not exist until 2026-08-03 — the Worker had been hand-edited directly
in the Cloudflare dashboard's Quick Edit view with no version history. `worker.js` in
this initial commit is an exact capture of what was live in production at that point,
before any further changes.

## Bindings this Worker expects (Cloudflare dashboard → wo-checkout → Settings → Bindings)

- KV namespace `WO_RESERVATIONS` — short-lived stock reservations + a 45s inventory list cache
- KV namespace `WO_ORDERS` — order records
- Secret `STRIPE_SECRET_KEY`
- Secret `SUPABASE_URL`
- Secret `SUPABASE_SERVICE_ROLE_KEY`
- Var `STRIPE_PUBLISHABLE_KEY`
- Var `WO_STORE_ID` = 0f9dd4bc-42a7-487e-a972-2905d24513e9
- Var `WO_ADMIN_TOKEN`
- Var `WO_SITE_URL`
- Var `WO_SHIPPING_TIERS` (optional)
- Var `WO_INVENTORY_API_BASE` (legacy — see below)

## Known issue this repo exists to fix

`handleInventoryList` and the checkout price-verification step both reimplement
their own copy of "read inventory + compute price" against Supabase directly,
instead of using the vending software's own Worker (`still-resonance-4f87`,
repo `squeebmike/ArSca`) which already does this correctly and includes
signature-value pricing and comic book details. The two copies drifted apart:
this Worker's price formula never got the signature-value addition, so a
signed item is both displayed AND charged at the wrong (lower) price, and
there's no comic detail data or click-to-detail UI on the live shop cards at all.

The two Workers couldn't originally call each other because Cloudflare blocks
direct `fetch()` calls between two `*.workers.dev` subdomains (Error 1042) --
that's why this Worker ended up with its own duplicate Supabase query in the
first place. The fix is a Cloudflare Service Binding (same-account Worker-to-
Worker call, not a public fetch, so the restriction doesn't apply) instead of
a duplicate implementation.
