# wo-checkout

Cloudflare Worker powering walkoffsc.com's checkout (Stripe automatic-capture flow)
and its live inventory display (`#wo-live-shop` on the site, filled in by the
`<script src=".../wo-cart.js">` embed) -- sourced from the vending software's own
Worker (`still-resonance-4f87`, repo `squeebmike/ArSca`) via a Service Binding,
not a duplicate Supabase query.

This repo did not exist until 2026-08-03 — the Worker had been hand-edited directly
in the Cloudflare dashboard's Quick Edit view with no version history. The first
commit is an exact capture of what was live in production at that point.

## Deploying

Pushes to `main` that touch `worker.js`, `wrangler.jsonc`, or the workflow file
auto-deploy via `.github/workflows/deploy-worker.yml` (same pattern as the
`squeebmike/ArSca` repo's `deploy-worker.yml`): validates config and secrets,
syntax-checks both the outer Worker script and the embedded `/wo-cart.js`
frontend template it serves, deploys with `wrangler deploy --keep-vars`, then
smoke-tests two read-only endpoints.

### One-time setup required

**GitHub repo secrets** (Settings → Secrets and variables → Actions):
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

(Same values already used for the `squeebmike/ArSca` repo's own `deploy-worker.yml`.)

**`wrangler.jsonc`'s two KV namespace IDs are placeholders** — `wrangler deploy`
treats bindings as authoritative and will happily delete a binding that exists
on the live Worker but isn't declared here, so these can't be left blank or
guessed. Get the real IDs from Cloudflare dashboard → wo-checkout → Settings →
Bindings, and replace:
- `WO_RESERVATIONS` binding's `id`
- `WO_ORDERS` binding's `id`

The deploy workflow's "Validate Wrangler config" step refuses to deploy while
either is still a placeholder, so a forgotten ID fails loudly in CI instead of
silently wiping a live binding.

**Cloudflare Service Binding** (Cloudflare dashboard → wo-checkout → Settings →
Bindings → Add → Service binding) — also required before this Worker can serve
inventory or complete checkout at all:
- Variable name: `INVENTORY_API`
- Service: `still-resonance-4f87`
- Environment: `production`

`wrangler.jsonc` already declares this binding, so once it exists in the
dashboard, subsequent deploys keep it in sync automatically.

### Vars and secrets NOT in wrangler.jsonc

`STRIPE_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (secrets), and
`STRIPE_PUBLISHABLE_KEY`, `WO_STORE_ID`, `WO_ADMIN_TOKEN`, `WO_SITE_URL`,
`WO_SHIPPING_TIERS` (vars) already exist on the live Worker from before this
repo existed. They're deliberately left out of `wrangler.jsonc` and the deploy
uses `--keep-vars`, which leaves anything not declared in the config alone
instead of deleting it. No action needed for these.

## Why the inventory/price logic changed on 2026-08-03

`handleInventoryList` and the checkout price-verification step used to each
have their own copy of "read inventory + compute price" against Supabase
directly, instead of using the vending software's own Worker (which already
did this correctly, including signature-value pricing and comic book
details). The two copies drifted apart: this Worker's price formula never
got the signature-value addition, so a signed item was both displayed AND
charged at the wrong (lower) price, and there was no comic detail data or
click-to-detail UI on the live shop cards at all.

The two Workers couldn't originally call each other because Cloudflare blocks
direct `fetch()` calls between two `*.workers.dev` subdomains (Error 1042) --
that's why this Worker ended up with its own duplicate Supabase query in the
first place. The fix is the Cloudflare Service Binding described above
(same-account Worker-to-Worker call, not a public fetch, so the restriction
doesn't apply) instead of a duplicate implementation. `fetchInventoryApi()`
in `worker.js` is now the only place this Worker talks to the real inventory
data, and it throws a clear error (failing checkout loudly) if the Service
Binding isn't configured, rather than silently falling back to an unverified
client-submitted price the way the old code's Supabase-optional guard did.
