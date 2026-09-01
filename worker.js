// ============================================================================
// Walk-Off Sports Cards & Comics — Checkout Worker
// Automatic-capture Stripe flow + KV-backed orders & short-lived item reservations
// + Live inventory display sourced from the vending software's own Worker
// (still-resonance-4f87, repo squeebmike/ArSca) via a Service Binding
// ============================================================================
//
// SETUP:
// 1. Confirm/set these Variables (not secrets, plain text is fine):
//      WO_STORE_ID            = 0f9dd4bc-42a7-487e-a972-2905d24513e9
//      WO_INVENTORY_API_BASE  = https://still-resonance-4f87.swarnerauto.workers.dev
//    (defaults below match these — only add them if you want to override without redeploying)
// 2. Add a Service Binding (Cloudflare dashboard -> wo-checkout -> Settings ->
//    Bindings -> Add -> Service binding):
//      Variable name: INVENTORY_API
//      Service:       still-resonance-4f87
//      Environment:   production
//    This is required -- fetchInventoryApi() throws a clear error if it's missing.
// 3. Confirm these Secrets are already set:
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//    (still needed for order writes, membership/pledge, and the stock
//    decrement-on-sale side effect -- just not for reading the live catalog
//    or computing price anymore, see FIX (2026-08-03) below.)
// 4. On any Webflow page, drop a plain HTML embed containing:
//      <div id="wo-live-shop"></div>
//    and it will fill in with live inventory automatically.
//
// FIX (2026-07-25): handleInventoryList used to read Supabase directly
// instead of fetching the vending software's HTTP API, because Cloudflare
// blocks direct fetch() calls between two *.workers.dev subdomains (Error
// 1042) -- that was the root cause of the 502/404 on /api/inventory at the
// time. Superseded by the FIX (2026-08-03) below, which solves the same
// problem a different way.
//
// FIX (2026-07-27): brought pricing in line with the vending software's
// dashboard/storefront rules (market price, floor, override, signature
// value not yet included -- see FIX (2026-08-03) below for why that gap
// existed and how it's closed).
//
// FIX (2026-08-03): removed this Worker's own duplicate inventory query and
// price formula entirely. It had silently drifted from the real one on the
// vending software's side -- signature-value pricing was never added here,
// so a signed item both displayed AND was charged at the wrong (lower)
// price on walkoffsc.com, and there was no comic book detail data at all.
// handleInventoryList and handleCreateIntent's stock/price verification now
// both call the vending software's /public/storefront and
// /public/storefront/item routes via a Cloudflare Service Binding
// (INVENTORY_API, see SETUP above) instead of reading Supabase and
// recomputing price here. A Service Binding is a same-account Worker-to-
// Worker call, not a public internet fetch, so it isn't subject to the
// *.workers.dev restriction that caused the 2026-07-25 workaround --
// there's no reason left for a second implementation of "what's for sale
// and at what price" to exist.
//
// FIX (2026-08-05): the entire cart drawer, checkout modal, and live
// inventory grid were hardcoded to a fixed light theme (inline
// background:#fff / color:#1a1a1a etc everywhere) with no connection at
// all to the site's --wo-surface/--wo-surface-alt/--wo-accent/--wo-text
// theme-picker variables, which live on document.documentElement and are
// already used successfully throughout the rest of the site. Every inline
// color below is now a var(--team-*) reference instead of a literal hex
// value, so this UI now actually follows whichever team the visitor has
// picked, the same as everything else on the page. Also: category filtering
// for the live inventory grid never worked, because renderLiveInventory()
// never added a data-category attribute to its cards, never built any
// on-page filter/search UI, and the pre-existing initShopUrlFilter()/
// applyFilters() logic was written years earlier for a different, static
// Webflow-CMS product grid (.product-card) that these live cards don't
// use. Added: (1) a real search + category filter bar rendered above the
// live grid, styled with the same classes already themed in Webflow
// (.wo-store-controls / .wo-store-search-field / .wo-store-control-field)
// so it matches the rest of the site with zero extra CSS; (2) a
// data-category attribute on every live card; (3) filtering logic that
// actually reads and filters the live cards; (4) initShopUrlFilter rewritten
// to filter directly by category instead of hunting for a button that was
// never created.
//
// FIX (2026-08-06): three things.
// (1) Local pickup was never an option -- every checkout charged a
// shipping fee and required a full U.S. street address, even though this
// is a local card shop with walk-in/meetup customers. Checkout is now two
// steps (fulfillment + contact fields first, actual card payment second,
// same shape as the vending software's own storefront.html) with a real
// Ship / Pickup (Fed Way Commons) / Pickup (Kitsap County) picker, so the
// PaymentIntent amount is only computed once the fulfillment method (and
// therefore whether shipping applies) is known.
// (2) Orders placed here only ever existed in this Worker's own WO_ORDERS
// KV store and its own token-gated /admin page -- completely invisible in
// the vending software's dashboard Orders tab that's actually used day to
// day. handleConfirmOrder now also calls the vending software's new
// POST /public/storefront/record-order (via the same INVENTORY_API Service
// Binding already used for stock/price checks) to write a matching
// pos_sales/pos_sale_lines/pos_payments/storefront_orders record, keyed by
// this Worker's own real Stripe PaymentIntent id -- the vending software's
// existing Stripe webhook fulfills it automatically from there, with no
// idea which Worker created the intent. This is additive/best-effort: the
// existing WO_ORDERS write and /admin page are untouched.
// (3) --team-primary/--team-secondary/--team-accent/--team-text, referenced
// throughout the cart/checkout/live-shop CSS since the 2026-08-05 fix
// above, are not the variables the site's actual team-picker (wo-ui.js)
// sets -- it writes --wo-primary/--wo-surface/--wo-accent/--wo-text/etc.
// The 2026-08-05 fix was reading static, never-changing defaults the whole
// time. Renamed every reference to the real --wo-surface/--wo-surface-alt/
// --wo-accent/--wo-text variables so this UI actually re-themes when a
// visitor picks a team.
// ============================================================================

var ALLOWED_ORIGINS = [
  "https://www.walkoffsc.com",
  "https://walkoffsc.com",
    "https://themanapocket.com",

    "https://www.themanapocket.com",

  "https://walk-off-sports-cards-b0d22f.webflow.io",
  "http://localhost:3000",
  "http://localhost:1337"
];

var RESERVE_TTL_SECONDS = 15 * 60; // 15 minute hold once checkout starts

var DEFAULT_SHIPPING_TIERS = [
  { max: 20, rate: 2.00 },
  { max: 50, rate: 3.50 },
  { max: 100, rate: 6.00 },
  { max: null, rate: 9.00 }
];

// ----------------------------------------------------------------------------
// Limited "run drop" stock counters — independent of the Supabase card
// inventory. Each colorway/edition (not each signed/unsigned variant) gets
// its own cap: a cart item id like "dougvana-color-signed" is stripped of
// its trailing "-signed"/"-unsigned" suffix to find its colorway key
// ("dougvana-color"), which is looked up in RUN_DROP_LIMITS. Sold count
// lives in WO_ORDERS as a plain integer string, incremented as soon as an
// order is placed and the card is charged (see handleConfirmOrder) — capture
// is automatic now, so handleAdminCapture does not touch this counter.
//
// Limited Run 1 quantities, confirmed 2026-07-17: hand-signed, hand-numbered,
// 100 full-color prints, single edition. Every print gets the same gold-ink
// signature — no chase/lottery variants. Remarques (standard/deluxe) are
// paid opt-in upsells selected by the buyer at checkout, not randomly
// assigned; every remarque variant still counts against this same 100 cap.
// ----------------------------------------------------------------------------
var RUN_DROP_LIMITS = {
  "dougvana-color": 100
};

// Strips legacy "-signed"/"-unsigned" suffixes and remarque add-on suffixes
// (e.g. "dougvana-color--remarque-standard-cassette", "dougvana-color--remarque-deluxe")
// so every variant of a run-drop item still counts against the same colorway cap
// and still gets free shipping.
function getRunDropKey(itemId) {
  if (!itemId) return null;
  const stripped = itemId.replace(/--remarque-.*$/, "").replace(/-(signed|unsigned)$/, "");
  return Object.prototype.hasOwnProperty.call(RUN_DROP_LIMITS, stripped) ? stripped : null;
}

// Defensive: a KV lookup hiccup here (missing binding, transient error) must
// never block real checkout. Worst case, the run-drop cap just isn't enforced
// for that one request and stock display goes blank — it does not 500 the cart.
async function getRunDropSold(env, key) {
  try {
    if (!env.WO_ORDERS) return 0;
    const val = await env.WO_ORDERS.get("rundrop:" + key + ":sold");
    return val ? (parseInt(val, 10) || 0) : 0;
  } catch (e) {
    console.error("[WO] getRunDropSold failed for", key, e && e.message);
    return 0;
  }
}

async function incrRunDropSold(env, key, qty) {
  try {
    if (!env.WO_ORDERS) return null;
    const current = await getRunDropSold(env, key);
    const next = current + Math.max(1, parseInt(qty, 10) || 1);
    await env.WO_ORDERS.put("rundrop:" + key + ":sold", String(next));
    return next;
  } catch (e) {
    console.error("[WO] incrRunDropSold failed for", key, e && e.message);
    return null;
  }
}

// Releases stock back into the pool when an order that had counted against
// a run-drop cap is cancelled (never captured).
async function decrRunDropSold(env, key, qty) {
  try {
    if (!env.WO_ORDERS) return null;
    const current = await getRunDropSold(env, key);
    const next = Math.max(0, current - Math.max(1, parseInt(qty, 10) || 1));
    await env.WO_ORDERS.put("rundrop:" + key + ":sold", String(next));
    return next;
  } catch (e) {
    console.error("[WO] decrRunDropSold failed for", key, e && e.message);
    return null;
  }
}

// Accepts either ?key=dougvana-color (single) or ?keys=dougvana-color,dougvana-sketch (batch).
async function handleRunDropStock(request, env, origin) {
  const url = new URL(request.url);
  const keysParam = url.searchParams.get("keys") || url.searchParams.get("key") || "";
  const keys = keysParam.split(",").map((k) => k.trim()).filter(Boolean);
  if (!keys.length) return json({ error: "Missing key(s)" }, 400, corsHeaders(origin));
  const runs = {};
  for (const key of keys) {
    const limit = RUN_DROP_LIMITS[key];
    if (!limit) { runs[key] = { error: "Unknown run" }; continue; }
    const sold = await getRunDropSold(env, key);
    runs[key] = { limit, sold, remaining: Math.max(0, limit - sold) };
  }
  return json({ runs }, 200, corsHeaders(origin));
}

// ----------------------------------------------------------------------------
// Live inventory (Supabase-backed, via the vending software's existing
// public storefront endpoint for reads; direct Supabase writes for decrement)
// ----------------------------------------------------------------------------
var DEFAULT_STORE_ID = "0f9dd4bc-42a7-487e-a972-2905d24513e9";
var DEFAULT_INVENTORY_API_BASE = "https://still-resonance-4f87.swarnerauto.workers.dev";
var INVENTORY_CACHE_TTL_SECONDS = 300; // was 45s -- too short to protect a cold cache from Lighthouse/first-visit
                                        // hits, which pay the full cost of the live pass-through call to the
                                        // ArSca storefront API on every miss; that's the dominant LCP cost on the
                                        // homepage. Inventory doesn't need to be fresher than a few minutes.

function getStoreId(env) { return env.WO_STORE_ID || DEFAULT_STORE_ID; }
function getInventoryApiBase(env) { return (env.WO_INVENTORY_API_BASE || DEFAULT_INVENTORY_API_BASE).replace(/\/$/, ""); }

// Calls the vending software's own public-storefront routes (still-resonance-4f87,
// repo squeebmike/ArSca) via a Cloudflare Service Binding instead of reading
// Supabase directly here. A Service Binding is a same-account Worker-to-Worker
// call, not a public fetch, so it isn't subject to the *.workers.dev
// cross-fetch block (Error 1042) that forced this Worker into its own
// duplicate Supabase query and price formula back on 2026-07-25 -- that
// duplicate was never updated when signature-value pricing and comic
// details were added on the other side, so signed items silently displayed
// AND were charged at the wrong price on walkoffsc.com. Now there's exactly
// one place price/stock rules live; this Worker just calls it.
//
// Requires a Service Binding named INVENTORY_API pointed at still-resonance-4f87
// (Cloudflare dashboard -> wo-checkout -> Settings -> Bindings -> Add -> Service binding).
async function fetchInventoryApi(env, path) {
  if (!env.INVENTORY_API) {
    const err = new Error("INVENTORY_API service binding is not configured -- add it in Cloudflare dashboard -> wo-checkout -> Settings -> Bindings -> Service binding -> still-resonance-4f87");
    err.status = 501;
    throw err;
  }
  const url = getInventoryApiBase(env) + path;
  const res = await env.INVENTORY_API.fetch(url);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data: data || {} };
}

function getShippingTiers(env) {
  if (env.WO_SHIPPING_TIERS) {
    try {
      const parsed = JSON.parse(env.WO_SHIPPING_TIERS);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {
      console.error("[WO] Invalid WO_SHIPPING_TIERS, falling back to defaults:", e.message);
    }
  }
  return DEFAULT_SHIPPING_TIERS;
}

function shippingForPrice(price, tiers, itemId) {
  if (getRunDropKey(itemId)) return 0; // Dougvana run-drop items ship free — cost absorbed into margin
  const p = Number(price) || 0;
  for (const tier of tiers) {
    if (tier.max === null || tier.max === undefined || p <= tier.max) return Number(tier.rate) || 0;
  }
  return Number(tiers[tiers.length - 1].rate) || 0;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-cache, no-store"
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {})
  });
}

function uid(prefix) {
  return (prefix || "id") + "_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function stripeRequest(secretKey, method, path, params) {
  const url = "https://api.stripe.com" + path;
  const headers = {
    "Authorization": "Bearer " + secretKey,
    "Content-Type": "application/x-www-form-urlencoded"
  };
  let body;
  if (params && method !== "GET") {
    body = formEncode(params);
  }
  const res = await fetch(url + (params && method === "GET" ? "?" + formEncode(params) : ""), {
    method,
    headers,
    body
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || "Stripe request failed");
    err.stripeError = data.error;
    throw err;
  }
  return data;
}

function formEncode(params, prefix) {
  const parts = [];
  for (const key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    const value = params[key];
    const fullKey = prefix ? prefix + "[" + key + "]" : key;
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      parts.push(formEncode(value, fullKey));
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === "object") parts.push(formEncode(v, fullKey + "[" + i + "]"));
        else parts.push(encodeURIComponent(fullKey + "[" + i + "]") + "=" + encodeURIComponent(v));
      });
    } else {
      parts.push(encodeURIComponent(fullKey) + "=" + encodeURIComponent(value));
    }
  }
  return parts.filter(Boolean).join("&");
}

// fulfillMethod: shipping fees only apply when the customer actually chose
// shipping -- pickup orders (added 2026-08-06) are always $0 shipping.
function cartTotals(items, tiers, fulfillMethod) {
  let subtotal = 0;
  let shipping = 0;
  let qtyTotal = 0;
  (items || []).forEach((it) => {
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const price = Number(it.price) || 0;
    subtotal += price * qty;
    if (fulfillMethod === 'shipping') shipping += shippingForPrice(price, tiers, it.id) * qty;
    qtyTotal += qty;
  });
  const grand = Math.round((subtotal + shipping) * 100) / 100;
  return { subtotal: round2(subtotal), shipping: round2(shipping), grand, qtyTotal };
}

function validateFulfillment(fulfillment) {
  const method = String(fulfillment?.method || '');
  if (!['pickup_fedway', 'pickup_kitsap', 'shipping'].includes(method)) return 'A valid fulfillment method is required';
  const name = String(fulfillment?.name || '').trim();
  const phone = String(fulfillment?.phone || '').trim();
  if (!name || !phone) return 'Name and phone number are required';
  if (method === 'shipping') {
    const addr = fulfillment?.shippingAddress || {};
    if (!addr.line1 || !addr.city || !addr.state || !addr.zip) return 'A complete shipping address is required';
  }
  return null;
}
function round2(n) { return Math.round(n * 100) / 100; }

// Store policy: market-tracked prices ring up as whole dollars, rounded UP
// (e.g. $7.01 market -> $8, never down). A deliberate override or floor is
// respected exactly as entered -- this only rounds the raw market figure.
function roundUpToDollar(value) {
  const n = Number(value) || 0;
  if (!isFinite(n) || n <= 0) return 0;
  return Math.ceil(n - 1e-9);
}

// Same price rule as the vending software: market price, unless there's a
// Price and availability now come from the vending software's own
// /public/storefront/item route (see fetchInventoryApi above) instead of a
// duplicate Supabase query + price formula here -- that duplicate is what
// let signature-value pricing silently drift out of sync in the first
// place. There's exactly one place those rules live now.

async function isReserved(env, productId, reservationId) {
  const val = await env.WO_RESERVATIONS.get("item:" + productId);
  if (!val) return false;
  try {
    const data = JSON.parse(val);
    return data.reservationId !== reservationId;
  } catch (e) {
    return true;
  }
}

async function handleCreateIntent(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: "Cart is empty" }, 400, corsHeaders(origin));

  const fulfillment = body.fulfillment || {};
  const fulfillErr = validateFulfillment(fulfillment);
  if (fulfillErr) return json({ error: fulfillErr }, 400, corsHeaders(origin));

  // The exclusive per-id reservation lock below is designed for unique 1-of-1
  // items (each trading card id = one physical card, so only one buyer should
  // ever hold it). Run-drop items (e.g. "dougvana-color") represent MANY
  // identical numbered units sharing one id — locking the id would let only
  // one customer check out per colorway at a time. Those are exempted here
  // and instead governed purely by the capacity check below.
  const reservationId = uid("res");
  for (const it of items) {
    if (!it.id || getRunDropKey(it.id)) continue;
    const blocked = await isReserved(env, it.id, reservationId);
    if (blocked) {
      return json({ error: `"${it.name || it.id}" was just reserved by another order. Refresh your cart.` }, 409, corsHeaders(origin));
    }
  }

  // Run-drop capacity check (e.g. Dougvana Limited Run 1) — blocks checkout
  // if this cart would push a limited run over its cap. "sold" counts orders
  // as soon as they're placed (handleConfirmOrder), not just captured ones,
  // so this is a real-time cap, not just a post-hoc one.
  const runQtyRequested = {};
  for (const it of items) {
    const runKey = getRunDropKey(it.id);
    if (!runKey) continue;
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    runQtyRequested[runKey] = (runQtyRequested[runKey] || 0) + qty;
  }
  for (const runKey in runQtyRequested) {
    const sold = await getRunDropSold(env, runKey);
    const limit = RUN_DROP_LIMITS[runKey];
    if (sold + runQtyRequested[runKey] > limit) {
      return json({ error: "Sorry — this limited run is sold out or doesn't have enough left." }, 409, corsHeaders(origin));
    }
  }

  // Server-side stock + PRICE check against the vending software's own
  // real-time storefront data (via the INVENTORY_API Service Binding --
  // see fetchInventoryApi above), not a duplicate Supabase query here.
  // Never trust qty *or price* from the client cart: nothing on the
  // frontend enforces either against real data. A stale cart from before
  // stock or a price changed, or a tampered cart in browser storage, could
  // otherwise both oversell an item and charge the wrong amount. This
  // overwrites it.price with the freshly-verified server price (which
  // already includes signature value, floor, and override -- the exact
  // same formula the item's own product page shows) before totals/the
  // Stripe amount are computed below, so what's actually charged always
  // matches current real inventory data -- not whatever price the item
  // happened to show when it was added to the cart.
  for (const it of items) {
    if (!it.id || getRunDropKey(it.id)) continue; // run-drop items aren't in Supabase inventory_items; capped separately above
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    try {
      const result = await fetchInventoryApi(env, "/public/storefront/item?store_id=" + encodeURIComponent(getStoreId(env)) + "&id=" + encodeURIComponent(it.id));
      const item = result.data && result.data.item;
      if (!result.ok || !result.data || !result.data.ok || !item || Number(item.quantity || 0) < qty) {
        return json({ error: `"${it.name || it.id}" doesn't have ${qty} available. Refresh your cart and try again.` }, 409, corsHeaders(origin));
      }
      it.price = Number(item.price || 0);
    } catch (e) {
      console.error("[WO] Stock check failed for", it.id, e.message);
      return json({ error: "Could not verify stock. Please try again." }, 502, corsHeaders(origin));
    }
  }

  const tiers = getShippingTiers(env);
  const totals = cartTotals(items, tiers, fulfillment.method);
  if (totals.grand <= 0) return json({ error: "Invalid cart total" }, 400, corsHeaders(origin));

  const stripeKey = env.STRIPE_SECRET_KEY || "";
  if (!stripeKey) return json({ error: "Payment is not configured. Please contact Walk-Off directly." }, 500, corsHeaders(origin));

  let stripeCustomerId = "";
  const email = (body.email || "").trim();
  try {
    if (email) {
      const search = await stripeRequest(stripeKey, "GET", "/v1/customers", { email, limit: 1 });
      if (search.data && search.data.length) {
        stripeCustomerId = search.data[0].id;
      } else {
        const created = await stripeRequest(stripeKey, "POST", "/v1/customers", { email, name: body.name || undefined });
        stripeCustomerId = created.id;
      }
    }
  } catch (e) {
    console.error("[WO] Stripe customer error:", e.message);
  }

  const piParams = {
    amount: Math.round(totals.grand * 100),
    currency: "usd",
    capture_method: "automatic",
    automatic_payment_methods: { enabled: true },
    metadata: {
      reservationId,
      itemIds: items.map((i) => i.id).filter(Boolean).join(","),
      source: "walkoffsc-checkout",
      fulfillmentMethod: fulfillment.method
    }
  };
  if (stripeCustomerId) piParams.customer = stripeCustomerId;

  let pi;
  try {
    pi = await stripeRequest(stripeKey, "POST", "/v1/payment_intents", piParams);
  } catch (e) {
    return json({ error: e.message || "Could not start payment" }, 500, corsHeaders(origin));
  }

  await Promise.all(
    items.filter((i) => i.id && !getRunDropKey(i.id)).map((it) =>
      env.WO_RESERVATIONS.put(
        "item:" + it.id,
        JSON.stringify({ reservationId, paymentIntentId: pi.id, at: Date.now() }),
        { expirationTtl: RESERVE_TTL_SECONDS }
      )
    )
  );

  return json({
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    reservationId,
    totals,
    amountCents: Math.round(totals.grand * 100)
  }, 200, corsHeaders(origin));
}

async function handleReleaseReservation(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  await Promise.all(items.filter((i) => i.id).map((it) => env.WO_RESERVATIONS.delete("item:" + it.id)));
  return json({ released: true }, 200, corsHeaders(origin));
}

async function handleConfirmOrder(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const piId = body.paymentIntentId;
  if (!piId) return json({ error: "Missing paymentIntentId" }, 400, corsHeaders(origin));

  const stripeKey = env.STRIPE_SECRET_KEY || "";
  let pi;
  try {
    pi = await stripeRequest(stripeKey, "GET", "/v1/payment_intents/" + piId);
  } catch (e) {
    return json({ error: "Could not verify payment" }, 500, corsHeaders(origin));
  }
  if (pi.status !== "requires_capture" && pi.status !== "succeeded") {
    return json({ error: "Payment not authorized yet (status: " + pi.status + ")" }, 400, corsHeaders(origin));
  }

  const order = {
    id: piId,
    paymentIntentId: piId,
    // capture_method is "automatic" now, so a successful confirm almost
    // always means the card was already charged. "pending_capture" is kept
    // only as a fallback for the rare case a payment method needs a manual
    // capture step Stripe didn't finish inline (still shows Capture/Cancel
    // in /admin for that case).
    status: pi.status === "succeeded" ? "paid" : "pending_capture",
    createdAt: new Date().toISOString(),
    items: body.items || [],
    totals: body.totals || {},
    customer: body.customer || {},
    shipping: body.shipping || {},
    notes: body.notes || ""
  };
  try {
    await env.WO_ORDERS.put("order:" + piId, JSON.stringify(order));
  } catch (e) {
    console.error("[WO] Failed to save order:", e.message);
  }
  // Count run-drop items against their cap as soon as the order is placed
  // (card authorized), not only once captured — otherwise the "X left" cap
  // doesn't actually stop overselling while orders sit pending_capture.
  await Promise.all(
    (order.items || [])
      .filter((i) => i.id && getRunDropKey(i.id))
      .map((it) => incrRunDropSold(env, getRunDropKey(it.id), it.qty))
  );

  // Also record this order into the vending software's own ledger
  // (pos_sales/pos_sale_lines/pos_payments/storefront_orders via the
  // INVENTORY_API Service Binding) so it shows up in the dashboard's Orders
  // tab -- this Worker's own WO_ORDERS write above stays as the source for
  // /admin, but until now that was the ONLY record; walkoffsc.com orders
  // were invisible in the tool actually used day to day. Best-effort: the
  // card is already charged, so a failure here must never surface as a
  // customer-facing error (same reasoning as the WO_ORDERS write above).
  try {
    const fulfillment = body.fulfillment || {
      method: body.shipping && body.shipping.address1 ? 'shipping' : 'pickup_fedway',
      name: (body.customer || {}).name || '',
      phone: '',
      email: (body.customer || {}).email || '',
      shippingAddress: body.shipping && body.shipping.address1 ? { line1: body.shipping.address1, city: body.shipping.city, state: body.shipping.state, zip: body.shipping.zip } : null,
    };
    const recordItems = (order.items || []).map((it) => ({
      itemId: getRunDropKey(it.id) ? null : (it.id || null),
      name: it.name || 'Item',
      price: Number(it.price || 0),
      quantity: Math.max(1, parseInt(it.qty, 10) || 1),
      category: getRunDropKey(it.id) ? 'Print' : 'Card',
    }));
    const recordRes = await env.INVENTORY_API.fetch(getInventoryApiBase(env) + '/public/storefront/record-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId: getStoreId(env),
        stripePaymentIntentId: piId,
        items: recordItems,
        fulfillment,
        shippingFeeCents: Math.round(Number((order.totals || {}).shipping || 0) * 100),
        mode: pi.livemode ? 'live' : 'test',
      }),
    });
    if (!recordRes.ok) console.error('[WO] record-order failed:', recordRes.status, await recordRes.text().catch(() => ''));
  } catch (e) {
    console.error('[WO] record-order call failed:', e.message);
  }

  return json({ ok: true, orderId: piId }, 200, corsHeaders(origin));
}

async function requireAdmin(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token") || "";
  return token && env.WO_ADMIN_TOKEN && token === env.WO_ADMIN_TOKEN;
}

async function handleAdminOrders(request, env, origin) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, corsHeaders(origin));
  const list = await env.WO_ORDERS.list({ prefix: "order:" });
  const orders = [];
  for (const key of list.keys) {
    const val = await env.WO_ORDERS.get(key.name);
    if (val) orders.push(JSON.parse(val));
  }
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return json({ orders }, 200, corsHeaders(origin));
}

async function handleAdminCapture(request, env, origin) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, corsHeaders(origin));
  const body = await request.json().catch(() => ({}));
  const piId = body.paymentIntentId;
  if (!piId) return json({ error: "Missing paymentIntentId" }, 400, corsHeaders(origin));

  const stripeKey = env.STRIPE_SECRET_KEY || "";
  try {
    const pi = await stripeRequest(stripeKey, "POST", "/v1/payment_intents/" + piId + "/capture");
    const orderRaw = await env.WO_ORDERS.get("order:" + piId);
    if (orderRaw) {
      const order = JSON.parse(orderRaw);
      order.status = "captured";
      order.capturedAt = new Date().toISOString();
      await env.WO_ORDERS.put("order:" + piId, JSON.stringify(order));
      await Promise.all((order.items || []).filter((i) => i.id).map((it) => env.WO_RESERVATIONS.delete("item:" + it.id)));
      // Decrement live inventory in Supabase so it also shows sold-out in the vending software
      if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
        await Promise.all((order.items || []).filter((i) => i.id).map((it) => decrementInventoryItem(env, it.id, it.qty)));
        // Inventory just changed — drop the cached storefront list so the site reflects it immediately
        try { await env.WO_RESERVATIONS.delete("inventory:" + getStoreId(env)); } catch (e) {}
      }
      // Run-drop counters (e.g. Dougvana) were already counted against their
      // cap when the order was placed (see handleConfirmOrder) — capture
      // doesn't touch them again.
    }
    return json({ ok: true, status: pi.status }, 200, corsHeaders(origin));
  } catch (e) {
    return json({ error: e.message || "Capture failed" }, 500, corsHeaders(origin));
  }
}

async function handleAdminCancel(request, env, origin) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, corsHeaders(origin));
  const body = await request.json().catch(() => ({}));
  const piId = body.paymentIntentId;
  if (!piId) return json({ error: "Missing paymentIntentId" }, 400, corsHeaders(origin));

  const stripeKey = env.STRIPE_SECRET_KEY || "";
  try {
    await stripeRequest(stripeKey, "POST", "/v1/payment_intents/" + piId + "/cancel");
    const orderRaw = await env.WO_ORDERS.get("order:" + piId);
    if (orderRaw) {
      const order = JSON.parse(orderRaw);
      order.status = "cancelled";
      order.cancelledAt = new Date().toISOString();
      await env.WO_ORDERS.put("order:" + piId, JSON.stringify(order));
      await Promise.all((order.items || []).filter((i) => i.id).map((it) => env.WO_RESERVATIONS.delete("item:" + it.id)));
      // Release any run-drop stock this cancelled order had counted against its cap.
      await Promise.all(
        (order.items || [])
          .filter((i) => i.id && getRunDropKey(i.id))
          .map((it) => decrRunDropSold(env, getRunDropKey(it.id), it.qty))
      );
    }
    return json({ ok: true }, 200, corsHeaders(origin));
  } catch (e) {
    return json({ error: e.message || "Cancel failed" }, 500, corsHeaders(origin));
  }
}

// For orders that already charged (status "paid"/"captured") — cancel only
// works pre-capture, so undoing a paid order means a real Stripe refund.
async function handleAdminRefund(request, env, origin) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, corsHeaders(origin));
  const body = await request.json().catch(() => ({}));
  const piId = body.paymentIntentId;
  if (!piId) return json({ error: "Missing paymentIntentId" }, 400, corsHeaders(origin));

  const stripeKey = env.STRIPE_SECRET_KEY || "";
  try {
    await stripeRequest(stripeKey, "POST", "/v1/refunds", { payment_intent: piId });
    const orderRaw = await env.WO_ORDERS.get("order:" + piId);
    if (orderRaw) {
      const order = JSON.parse(orderRaw);
      order.status = "refunded";
      order.refundedAt = new Date().toISOString();
      await env.WO_ORDERS.put("order:" + piId, JSON.stringify(order));
      // Release any run-drop stock this refunded order had counted against its cap.
      await Promise.all(
        (order.items || [])
          .filter((i) => i.id && getRunDropKey(i.id))
          .map((it) => decrRunDropSold(env, getRunDropKey(it.id), it.qty))
      );
    }
    return json({ ok: true }, 200, corsHeaders(origin));
  } catch (e) {
    return json({ error: e.message || "Refund failed" }, 500, corsHeaders(origin));
  }
}

async function handleMembershipSubscribe(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const tier = body.tier === "patron" ? "patron" : "supporter";
  const amount = Math.round(Number(body.amount) * 100);
  const email = (body.email || "").trim();
  const minCents = tier === "patron" ? 1000 : 300;
  if (!amount || amount < minCents) {
    return json({ error: "Minimum for this tier is $" + (minCents / 100).toFixed(2) }, 400, corsHeaders(origin));
  }
  const stripeKey = env.STRIPE_SECRET_KEY || "";
  if (!stripeKey) return json({ error: "Payments not configured" }, 500, corsHeaders(origin));

  const tierLabel = tier === "patron" ? "Walk-Off Fan Club — Patron" : "Walk-Off Fan Club — Supporter";
  const successUrl = (env.WO_SITE_URL || origin || "https://www.walkoffsc.com") + "/fan-club?joined=1&session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl = (env.WO_SITE_URL || origin || "https://www.walkoffsc.com") + "/fan-club";

  try {
    const params = {
      mode: "subscription",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": amount,
      "line_items[0][price_data][recurring][interval]": "month",
      "line_items[0][price_data][product_data][name]": tierLabel,
      metadata: { tier, source: "walkoffsc-fanclub" }
    };
    if (email) params.customer_email = email;
    const session = await stripeRequest(stripeKey, "POST", "/v1/checkout/sessions", params);
    return json({ url: session.url }, 200, corsHeaders(origin));
  } catch (e) {
    return json({ error: e.message || "Could not start membership checkout" }, 500, corsHeaders(origin));
  }
}

async function handlePledgeDonate(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const amount = Math.round(Number(body.amount) * 100);
  const email = (body.email || "").trim();
  if (!amount || amount < 100) {
    return json({ error: "Minimum pledge is $1.00" }, 400, corsHeaders(origin));
  }
  const stripeKey = env.STRIPE_SECRET_KEY || "";
  if (!stripeKey) return json({ error: "Payments not configured" }, 500, corsHeaders(origin));

  const successUrl = (env.WO_SITE_URL || origin || "https://www.walkoffsc.com") + "/fan-club?pledged=1&session_id={CHECKOUT_SESSION_ID}";
  const cancelUrl = (env.WO_SITE_URL || origin || "https://www.walkoffsc.com") + "/fan-club";

  try {
    const params = {
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": amount,
      "line_items[0][price_data][product_data][name]": "Walk-Off Publishing — One-Time Pledge",
      metadata: { source: "walkoffsc-pledge" }
    };
    if (email) params.customer_email = email;
    const session = await stripeRequest(stripeKey, "POST", "/v1/checkout/sessions", params);
    return json({ url: session.url }, 200, corsHeaders(origin));
  } catch (e) {
    return json({ error: e.message || "Could not start pledge checkout" }, 500, corsHeaders(origin));
  }
}

// ----------------------------------------------------------------------------
// Live inventory: READ side — reads Supabase directly instead of proxying
// through the vending software's HTTP API. Cross-worker fetches between two
// *.workers.dev subdomains are blocked by Cloudflare (Error 1042) — that was
// the root cause of the previous 502/404 here. Mirrors the same field
// mapping /public/storefront uses on the vending software side, including
// the per-item minimum-price floor.
// ----------------------------------------------------------------------------
async function handleInventoryList(request, env, origin) {
  const storeId = getStoreId(env);
  const incoming = new URL(request.url);
  const forwarded = new URLSearchParams();
  ['limit','offset','category','type','q','sort'].forEach(function(key){
    const value = incoming.searchParams.get(key);
    if (value) forwarded.set(key, value.slice(0, 160));
  });
  const queryString = forwarded.toString();
  const cacheKey = "inventory:database-facets-1:" + storeId + (queryString ? ':' + queryString : '');

  try {
    const cached = await env.WO_RESERVATIONS.get(cacheKey);
    if (cached) return new Response(cached, { headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(origin)) });
  } catch (e) {}

  try {
    // Straight pass-through of the vending software's own /public/storefront
    // list (via the INVENTORY_API Service Binding -- see fetchInventoryApi
    // above), not a duplicate Supabase query + price formula here. This is
    // also where comic/signature/photo data now comes from -- fields this
    // Worker never had before because it never asked the real source for
    // them.
    const result = await fetchInventoryApi(env, "/public/storefront?store_id=" + encodeURIComponent(storeId) + (queryString ? '&' + queryString : ''));
    if (!result.ok || !result.data || !result.data.ok) {
      const message = (result.data && result.data.error) || "Storefront is not published";
      return json({ ok: false, error: message }, result.status || 502, corsHeaders(origin));
    }
    var items = result.data.items || [];

    var payload = JSON.stringify({ ok: true, items: items, total:result.data.total == null ? items.length : result.data.total, offset:result.data.offset || 0, limit:result.data.limit || items.length, hasMore:result.data.hasMore === true, nextOffset:result.data.nextOffset, facets:result.data.facets || [], filterOptions:result.data.filterOptions || null });
    try { await env.WO_RESERVATIONS.put(cacheKey, payload, { expirationTtl: INVENTORY_CACHE_TTL_SECONDS }); } catch (e) {}
    return new Response(payload, { headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(origin)) });
  } catch (e) {
    return json({ ok: false, error: "Could not load inventory: " + e.message }, 502, corsHeaders(origin));
  }
}

function shareEscape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; });
}

async function handleItemShare(request, env) {
  const url = new URL(request.url);
  const itemId = String(url.searchParams.get('id') || '').trim();
  if (!itemId) return new Response('Missing item', { status:400 });
  try {
    const result = await fetchInventoryApi(env, '/public/storefront/item?store_id=' + encodeURIComponent(getStoreId(env)) + '&id=' + encodeURIComponent(itemId));
    if (!result.ok || !result.data?.item) return new Response('Item unavailable', { status:404 });
    const item = result.data.item;
    const destination = 'https://themanapocket.com/shop?item=' + encodeURIComponent(item.id);
    const description = ['$'+Number(item.price || 0).toFixed(2), item.comic?.description || [item.category,item.set,item.year,item.variant,item.condition].filter(Boolean).join(' · '), 'Available from The Mana Pocket'].filter(Boolean).join(' · ').slice(0, 280);
    const title = shareEscape(item.name || 'The Mana Pocket item');
    const image = shareEscape([item.image,...(item.photos || [])].find(value => /^https?:\/\//i.test(value || '')) || '');
    // Keep crawlers on the item-specific canonical page. A meta refresh or
    // canonical pointing at /shop can replace the product preview with its logo.
    const canonical = url.origin + '/share/item?id=' + encodeURIComponent(item.id);
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><meta name="description" content="'+shareEscape(description)+'"><meta property="og:type" content="product"><meta property="og:site_name" content="The Mana Pocket"><meta property="og:title" content="'+title+'"><meta property="og:description" content="'+shareEscape(description)+'"><meta property="og:url" content="'+shareEscape(canonical)+'"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="'+title+'"><meta name="twitter:description" content="'+shareEscape(description)+'">'+(image?'<meta property="og:image" content="'+image+'"><meta property="og:image:alt" content="'+title+'"><meta name="twitter:image" content="'+image+'">':'')+'<meta property="product:price:amount" content="'+Number(item.price||0).toFixed(2)+'"><meta property="product:price:currency" content="USD"><link rel="canonical" href="'+shareEscape(canonical)+'"></head><body><h1>'+title+'</h1>'+(image?'<img src="'+image+'" alt="'+title+'" style="max-width:440px;width:100%">':'')+'<p>'+shareEscape(description)+'</p><p><a href="'+shareEscape(destination)+'">View '+title+' at The Mana Pocket</a></p><script>location.replace('+JSON.stringify(destination)+')<\/script></body></html>';
    return new Response(html, { headers:{ 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'public, max-age=300' } });
  } catch (e) {
    return new Response('Item unavailable', { status:502 });
  }
}

// ----------------------------------------------------------------------------
// Live inventory: WRITE side — direct Supabase decrement on sale
// ----------------------------------------------------------------------------
async function supabaseFetch(env, path, options) {
  // Defensive: tolerate a SUPABASE_URL secret pasted without "https://" or
  // with stray whitespace/trailing slash — those otherwise produce a
  // malformed fetch URL and a bare "Invalid path specified in request URL"
  // error from Cloudflare's edge that gives no hint what's actually wrong.
  let base = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
  // The secret was set to the full REST endpoint (".../rest/v1") rather than
  // just the project URL -- strip it back off, since the "/rest/v1/" below
  // adds it again. Without this, every request doubled up as
  // ".../rest/v1/rest/v1/...", which Supabase's gateway rejects outright.
  base = base.replace(/\/rest\/v1\/?$/i, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!base || !key) throw new Error("Supabase is not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)");
  const headers = Object.assign(
    { "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    (options && options.headers) || {}
  );
  const res = await fetch(base + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = raw; }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || ("Supabase " + res.status));
  return data;
}

async function decrementInventoryItem(env, itemId, qty) {
  qty = Math.max(1, parseInt(qty, 10) || 1);
  try {
    const rows = await supabaseFetch(env, "inventory_items?id=eq." + encodeURIComponent(itemId) + "&select=id,data,status");
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) {
      console.error("[WO] No inventory_items row found for id:", itemId);
      return;
    }
    const currentData = row.data || {};
    const currentQty = Number(currentData.quantity ?? currentData.qty ?? 1);
    const newQty = Math.max(0, currentQty - qty);
    const newData = Object.assign({}, currentData, { quantity: newQty, qty: newQty });
    const newStatus = newQty <= 0 ? "sold" : (row.status || "in_stock");

    await supabaseFetch(env, "inventory_items?id=eq." + encodeURIComponent(itemId), {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify({ data: newData, status: newStatus, updated_at: new Date().toISOString() })
    });
  } catch (e) {
    console.error("[WO] Failed to decrement inventory item:", itemId, e.message);
  }
}

// ----------------------------------------------------------------------------
// Self-test endpoint — confirms Supabase + inventory API are wired correctly
// WITHOUT exposing any secret values. Admin-token protected.
// ----------------------------------------------------------------------------
async function handleDebugSupabase(request, env, origin) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, corsHeaders(origin));

  // The project URL itself isn't sensitive (Supabase project URLs are meant
  // to be public-safe, unlike the service role key) — surfacing it here,
  // normalized exactly the way supabaseFetch() will use it, over encoded so
  // any stray/invisible characters become visible instead of hiding in a
  // rendered string.
  let resolvedSupabaseUrl = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (resolvedSupabaseUrl && !/^https?:\/\//i.test(resolvedSupabaseUrl)) resolvedSupabaseUrl = "https://" + resolvedSupabaseUrl;

  const result = {
    supabaseUrlConfigured: !!env.SUPABASE_URL,
    supabaseUrlRawLength: String(env.SUPABASE_URL || "").length,
    resolvedSupabaseUrl: resolvedSupabaseUrl,
    resolvedSupabaseUrlEncoded: encodeURIComponent(resolvedSupabaseUrl),
    supabaseServiceKeyConfigured: !!env.SUPABASE_SERVICE_ROLE_KEY,
    storeId: getStoreId(env),
    inventoryApiBase: getInventoryApiBase(env)
  };

  // Test 1: direct Supabase read (proves the secrets actually work, not just present)
  if (result.supabaseUrlConfigured && result.supabaseServiceKeyConfigured) {
    try {
      const rows = await supabaseFetch(env, "inventory_items?store_id=eq." + encodeURIComponent(getStoreId(env)) + "&select=id&limit=1");
      result.supabaseReadTest = "ok";
      result.supabaseSampleRowFound = Array.isArray(rows) && rows.length > 0;
    } catch (e) {
      result.supabaseReadTest = "failed";
      result.supabaseReadError = e.message;
    }
  } else {
    result.supabaseReadTest = "skipped (secrets not configured)";
  }

  // Test 2: live inventory list via the same code path /api/inventory uses
  // now (direct Supabase reads) — confirms the read side end-to-end.
  try {
    const rows = await supabaseFetch(env, "inventory_items?store_id=eq." + encodeURIComponent(getStoreId(env)) + "&select=id&limit=1000");
    result.inventoryApiTest = "ok";
    result.inventoryItemCount = Array.isArray(rows) ? rows.length : null;
  } catch (e) {
    result.inventoryApiTest = "failed";
    result.inventoryApiError = e.message;
  }

  return json(result, 200, corsHeaders(origin));
}

// ----------------------------------------------------------------------------
// Frontend: cart + checkout modal script served at /wo-cart.js
// ----------------------------------------------------------------------------
function buildCartScript(stripePk, workerOrigin, tiers, accountApiBase, storeId) {
  return `
(function(){
var STRIPE_PK = ${JSON.stringify(stripePk)};
var API_BASE = ${JSON.stringify(workerOrigin)};
var SHIP_TIERS = ${JSON.stringify(tiers)};
var CART_KEY = 'wo_cart_v1';
// Account routes live on the vending software's own Worker (the same one
// that supplies live inventory above via the Service Binding) -- called
// directly from the browser here instead, since /public/account/* is
// already public + bearer-token gated and CORS-open, unlike the
// inventory/checkout calls which go through INVENTORY_API server-side.
var ACCOUNT_API_BASE = ${JSON.stringify(accountApiBase)};
var WO_STORE_ID = ${JSON.stringify(storeId)};

function getCart(){ try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch(e){ return []; } }
function setCart(c){ localStorage.setItem(CART_KEY, JSON.stringify(c)); renderCartBadge(); }
// sourceEl is whatever the customer actually clicked (an "Add to Cart"
// button) -- used only to find a nearby product image for the flourish
// animation below. Never required: callers that don't have one (e.g. a
// deep-link auto-add) just get a flourish variant that doesn't need it.
function addToCart(item, sourceEl){
  var cart = getCart();
  // "available" comes from the item's real Supabase stock count (embedded
  // on the card by renderLiveInventory / the wo-d-qty carrier field) --
  // falls back to 1 for pages/products that don't provide it, preserving
  // the old conservative one-at-a-time behavior there.
  var available = Math.max(1, parseInt(item.available, 10) || 1);
  var existing = cart.find(function(i){ return i.id === item.id; });
  if (existing) {
    if (existing.qty >= available) {
      alert('Only ' + available + ' of "' + (item.name || 'this item') + '" available — you already have the max in your cart.');
      return;
    }
    existing.qty = (existing.qty || 1) + 1;
  } else {
    cart.push(Object.assign({}, item, { qty: 1 }));
  }
  setCart(cart);
  // The drawer used to pop open on every add, which cut a browsing session
  // short every single time -- a quick flourise toward the cart icon
  // confirms the add without stopping anyone from grabbing more stuff.
  playAddToCartFlourish(sourceEl);
}
// Four 90s-throwback ways to confirm something landed in the cart, picked
// at random so it stays fun instead of samey. Two fly a copy of the
// product from wherever it was clicked over to the cart icon (trading-card
// catch, comic-panel swipe); two land entirely at the cart icon itself
// (arcade combo counter, foil pack-rip shimmer) -- those two also work
// fine with no sourceEl. Pure visual sugar: setCart()/renderCartBadge()
// above have already done the real work by the time any of this runs.
function findNearbyProductImage(el){
  var node = el;
  for (var i = 0; i < 6 && node; i++) {
    if (node.querySelector) {
      var img = node.querySelector('img');
      if (img && (img.currentSrc || img.src)) return img;
    }
    node = node.parentElement;
  }
  return null;
}
function ensureAddToCartAnimCss(){
  if (document.getElementById('wo-atc-anim-css')) return;
  var style = document.createElement('style');
  style.id = 'wo-atc-anim-css';
  style.textContent =
    '@keyframes woAtcPop{0%{transform:translate(-50%,-40%) scale(.3);opacity:0}35%{transform:translate(-50%,-95%) scale(1.15);opacity:1}70%{transform:translate(-50%,-118%) scale(1);opacity:1}100%{transform:translate(-50%,-155%) scale(.85);opacity:0}}' +
    '@keyframes woAtcBounce{0%,100%{transform:scale(1)}30%{transform:scale(1.35)}50%{transform:scale(.9)}70%{transform:scale(1.12)}100%{transform:scale(1)}}';
  document.head.appendChild(style);
}
// #wo-cart-toggle sits alongside the hamburger button in the nav bar, not
// nested inside the collapsible mobile menu, so the menu's own collapse
// was never actually the problem. What DOES hide it is the nav's separate
// scroll-to-hide behavior (#navbarID.is-hidden, a translateY(-110%) that
// still reports a nonzero-width rect since it's a transform, not a
// display change) -- scroll down on mobile, add something to the cart,
// and the icon is laid out fine but currently off the top of the screen.
// Un-hides the nav first so there's always something real and visible to
// animate toward, on any device, in any scroll position.
function resolveCartFlourishTarget(){
  var navbar = document.getElementById('navbarID');
  if (navbar) navbar.classList.remove('is-hidden');
  var toggle = document.getElementById('wo-cart-toggle');
  if (!toggle) return null;
  var rect = toggle.getBoundingClientRect();
  if (!rect.width || rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
  return toggle;
}
function bounceCartIcon(target){
  var el = target || resolveCartFlourishTarget();
  if (!el) return;
  el.style.animation = 'none';
  void el.offsetWidth; // restart the CSS animation if it's already mid-bounce from a fast double-add
  el.style.animation = 'woAtcBounce .5s cubic-bezier(.34,1.56,.64,1)';
}
function flyClone(visual, fromRect, toRect, buildKeyframes, duration, target){
  var clone = visual.cloneNode(false);
  clone.style.cssText = 'position:fixed;left:' + fromRect.left + 'px;top:' + fromRect.top + 'px;width:' + fromRect.width + 'px;height:' + fromRect.height + 'px;margin:0;z-index:2147483600;pointer-events:none;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);object-fit:cover;background:' + (visual.tagName === 'IMG' ? 'transparent' : 'var(--wo-accent,#8bd450)') + ';';
  document.body.appendChild(clone);
  var dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
  var dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
  var anim = clone.animate(buildKeyframes(dx, dy), { duration: duration, easing: 'cubic-bezier(.3,.6,.3,1)', fill: 'forwards' });
  anim.onfinish = function(){ clone.remove(); bounceCartIcon(target); };
}
function playAddToCartFlourish(sourceEl){
  var toggle = resolveCartFlourishTarget();
  if (!toggle) return;
  var toRect = toggle.getBoundingClientRect();
  if (!toRect.width) return;
  ensureAddToCartAnimCss();
  var variant = sourceEl ? Math.floor(Math.random() * 4) : (Math.random() < 0.5 ? 2 : 3);
  if (variant === 0 || variant === 1) {
    var img = findNearbyProductImage(sourceEl);
    var fromRect = (img || sourceEl).getBoundingClientRect();
    if (!fromRect.width) { bounceCartIcon(toggle); return; }
    var size = Math.min(64, fromRect.width, fromRect.height) || 48;
    var startRect = { left: fromRect.left + fromRect.width / 2 - size / 2, top: fromRect.top + fromRect.height / 2 - size / 2, width: size, height: size };
    var visual = img ? img.cloneNode(false) : document.createElement('div');
    if (variant === 0) {
      // Trading-card catch: arcs up and spins into the cart with a holofoil
      // brightness/hue flash mid-flight, like a pack pull landing in a box.
      flyClone(visual, startRect, toRect, function(dx, dy){
        return [
          { transform: 'translate(0,0) scale(1) rotate(0deg)', filter: 'brightness(1) saturate(1)', offset: 0 },
          { transform: 'translate(' + (dx * 0.5) + 'px,' + (dy * 0.5 - 60) + 'px) scale(.8) rotate(160deg)', filter: 'brightness(1.6) saturate(2) hue-rotate(40deg)', offset: .5 },
          { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.15) rotate(380deg)', filter: 'brightness(1) saturate(1)', opacity: 0, offset: 1 },
        ];
      }, 650, toggle);
    } else {
      // Comic-panel swipe: a skewed dash across the screen, like flipping
      // to the next panel, rather than a straight-line fly-to-cart.
      flyClone(visual, startRect, toRect, function(dx, dy){
        return [
          { transform: 'translate(0,0) skewX(0deg) scale(1)', offset: 0 },
          { transform: 'translate(' + (dx * 0.35) + 'px,' + (dy * 0.15) + 'px) skewX(-18deg) scale(.9)', offset: .25 },
          { transform: 'translate(' + (dx * 0.75) + 'px,' + (dy * 0.6) + 'px) skewX(14deg) scale(.5)', offset: .7 },
          { transform: 'translate(' + dx + 'px,' + dy + 'px) skewX(0deg) scale(.15)', opacity: 0, offset: 1 },
        ];
      }, 550, toggle);
    }
  } else if (variant === 2) {
    // Arcade combo counter: a bold outlined "+1" pops straight up out of
    // the cart icon, like a score bump.
    var counter = document.createElement('div');
    counter.textContent = '+1';
    counter.style.cssText = 'position:fixed;left:' + (toRect.left + toRect.width / 2) + 'px;top:' + toRect.top + 'px;z-index:2147483600;pointer-events:none;font-family:Impact,Haettenschweiler,"Arial Narrow Bold",sans-serif;font-size:22px;font-weight:900;color:#ffd23f;-webkit-text-stroke:2px #1a1a1a;text-shadow:2px 2px 0 #1a1a1a;animation:woAtcPop .75s ease-out forwards;';
    document.body.appendChild(counter);
    setTimeout(function(){ counter.remove(); bounceCartIcon(toggle); }, 750);
  } else {
    // Foil pack-rip: a rainbow diagonal shine sweeps across the cart icon,
    // like the foil on a freshly opened booster.
    var shine = document.createElement('div');
    shine.style.cssText = 'position:fixed;left:' + toRect.left + 'px;top:' + toRect.top + 'px;width:' + toRect.width + 'px;height:' + toRect.height + 'px;z-index:2147483600;pointer-events:none;overflow:hidden;border-radius:6px;';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:-50%;left:-60%;width:40%;height:200%;background:linear-gradient(120deg,transparent,rgba(255,255,255,.9) 40%,#ffd23f 48%,#ff5fa2 55%,#5fd0ff 62%,rgba(255,255,255,.9) 70%,transparent);transform:rotate(20deg);';
    shine.appendChild(bar);
    document.body.appendChild(shine);
    var anim = bar.animate([{ left: '-60%' }, { left: '140%' }], { duration: 520, easing: 'ease-in-out' });
    anim.onfinish = function(){ shine.remove(); bounceCartIcon(toggle); };
  }
}
function removeFromCart(id){ setCart(getCart().filter(function(i){ return i.id !== id; })); renderDrawerItems(); }
// Lets a customer bump quantity up/down right in the cart drawer instead of
// having to close it and re-find the item on the page -- purely local cart
// state, no network round trip, so it works fine even on a slow connection.
function changeCartQty(id, delta){
  var cart = getCart();
  var line = cart.find(function(i){ return i.id === id; });
  if(!line) return;
  var available = Math.max(1, parseInt(line.available, 10) || 1);
  var next = (parseInt(line.qty, 10) || 1) + delta;
  if(next <= 0){ removeFromCart(id); return; }
  if(next > available){ alert('Only ' + available + ' of "' + (line.name || 'this item') + '" available.'); return; }
  line.qty = next;
  setCart(cart);
  renderDrawerItems();
}

function renderCartBadge(){
  var badge = document.getElementById('wo-cart-badge');
  if(badge) badge.textContent = getCart().reduce(function(s,i){ return s + Math.max(1, parseInt(i.qty,10)||1); }, 0);
}

var WO_CLOSE_BTN_CSS = 'background:none;border:none;font-size:26px;line-height:1;width:40px;height:40px;min-width:40px;border-radius:50%;cursor:pointer;color:var(--wo-text,#1a1a1a);display:flex;align-items:center;justify-content:center;transition:background .15s ease;';

function ensureDrawer(){
  if(document.getElementById('wo-cart-drawer')) return;
  var bd = document.createElement('div');
  bd.id = 'wo-cart-backdrop';
  bd.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0);z-index:99998;display:none;transition:background .25s ease;';
  document.body.appendChild(bd);
  bd.onclick = closeCartDrawer;

  var d = document.createElement('div');
  d.id = 'wo-cart-drawer';
  d.style.cssText = 'position:fixed;top:0;right:-420px;width:400px;max-width:92vw;height:100%;background:var(--wo-surface,#fff);color:var(--wo-text,#1a1a1a);box-shadow:-8px 0 32px rgba(0,0,0,.22);z-index:99999;transition:right .28s ease;display:flex;flex-direction:column;font-family:inherit;';
  d.innerHTML = '<div style="padding:20px 16px 20px 24px;border-bottom:1px solid rgba(255,255,255,.12);display:flex;justify-content:space-between;align-items:center;">' +
      '<strong style="font-size:20px;color:var(--wo-text,#1a1a1a);">Your Cart</strong>' +
      '<button id="wo-cart-close" aria-label="Close cart" style="'+WO_CLOSE_BTN_CSS+'">&times;</button>' +
    '</div>' +
    '<div id="wo-cart-items" style="flex:1;overflow-y:auto;padding:16px 24px;"></div>' +
    '<div style="padding:20px 24px;border-top:1px solid rgba(255,255,255,.12);background:var(--wo-surface-alt,#fafafa);">' +
    '<div id="wo-cart-totals" style="font-size:15px;color:var(--wo-text,#444);margin-bottom:14px;"></div>' +
    '<button id="wo-cart-checkout" style="width:100%;padding:15px;background:var(--wo-accent,#1a1a1a);color:var(--wo-surface,#fff);border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:filter .15s ease;">Checkout</button>' +
    '</div>';
  document.body.appendChild(d);
  document.getElementById('wo-cart-close').onmouseenter = function(){ this.style.background = 'rgba(255,255,255,.1)'; };
  document.getElementById('wo-cart-close').onmouseleave = function(){ this.style.background = 'none'; };
  document.getElementById('wo-cart-close').onclick = closeCartDrawer;
  document.getElementById('wo-cart-checkout').onclick = openCheckoutModal;
  document.getElementById('wo-cart-checkout').onmouseenter = function(){ this.style.filter = 'brightness(1.1)'; };
  document.getElementById('wo-cart-checkout').onmouseleave = function(){ this.style.filter = 'none'; };
}
function openCartDrawer(){
  ensureDrawer();
  renderDrawerItems();
  document.getElementById('wo-cart-drawer').style.right = '0';
  var bd = document.getElementById('wo-cart-backdrop');
  bd.style.display = 'block';
  requestAnimationFrame(function(){ bd.style.background = 'rgba(0,0,0,.35)'; });
}
function closeCartDrawer(){
  var d = document.getElementById('wo-cart-drawer'); if(d) d.style.right = '-420px';
  var bd = document.getElementById('wo-cart-backdrop');
  if(bd){ bd.style.background = 'rgba(0,0,0,0)'; setTimeout(function(){ bd.style.display = 'none'; }, 250); }
}

var FREE_SHIP_PREFIXES = ['dougvana-color'];
function shippingForPrice(price, id){
  if (id && FREE_SHIP_PREFIXES.some(function(p){ return id.indexOf(p) === 0; })) return 0;
  var p = Number(price) || 0;
  for (var i=0;i<SHIP_TIERS.length;i++){
    var tier = SHIP_TIERS[i];
    if (tier.max === null || tier.max === undefined || p <= tier.max) return Number(tier.rate)||0;
  }
  return Number(SHIP_TIERS[SHIP_TIERS.length-1].rate)||0;
}
function computeTotals(cart){
  var subtotal = cart.reduce(function(s,i){ var qty = Math.max(1, parseInt(i.qty,10)||1); return s + (Number(i.price)||0) * qty; }, 0);
  // Comic preorders (kind:'preorder') never pay this flat per-order shipping
  // tier -- their own checkout (a separate step, per FOC cycle) quotes real
  // pickup/shipping on its own, so folding them into this estimate would
  // just be wrong, not just redundant.
  var shipping = cart.reduce(function(s,i){ if(i.kind==='preorder')return s; var qty = Math.max(1, parseInt(i.qty,10)||1); return s + shippingForPrice(i.price, i.id) * qty; }, 0);
  var hasPreorder = cart.some(function(i){ return i.kind==='preorder'; });
  return { subtotal: subtotal, shipping: shipping, grand: subtotal + shipping, hasPreorder: hasPreorder };
}

function renderDrawerItems(){
  var cart = getCart();
  var wrap = document.getElementById('wo-cart-items');
  if(!wrap) return;
  if(!cart.length){
    wrap.innerHTML = '<div style="text-align:center;padding:48px 12px;color:var(--wo-text,#999);opacity:.7;"><div style="font-size:40px;margin-bottom:10px;">\\ud83d\\uded2</div><p style="font-size:15px;">Your cart is empty.</p></div>';
  } else {
    wrap.innerHTML = cart.map(function(i){
      var qty = Math.max(1, parseInt(i.qty,10)||1);
      var available = Math.max(1, parseInt(i.available,10)||1);
      var lineTotal = (Number(i.price)||0) * qty;
      return '<div style="display:flex;gap:14px;margin-bottom:18px;align-items:center;padding-bottom:18px;border-bottom:1px solid rgba(255,255,255,.1);">' +
        (i.image ? '<img src="'+i.image+'" style="width:84px;height:84px;object-fit:cover;border-radius:10px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.25);">' : '') +
        '<div style="flex:1;min-width:0;"><div style="font-size:16px;font-weight:700;color:var(--wo-text,#1a1a1a);line-height:1.3;margin-bottom:4px;">'+(i.name||'Item')+'</div>' +
        (i.kind==='preorder' ? '<div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--wo-accent,#8bd450);margin:-2px 0 6px;">Comic preorder'+(i.focDate?' · FOC '+i.focDate:'')+'</div>' : '') +
        '<div style="font-size:15px;color:var(--wo-text,#555);opacity:.85;font-weight:600;margin-bottom:8px;">$'+(Number(i.price)||0).toFixed(2)+(qty>1?' \\u00d7 '+qty+' = $'+lineTotal.toFixed(2):'')+'</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<button data-qty-id="'+i.id+'" data-qty-delta="-1" aria-label="Decrease quantity" style="width:28px;height:28px;border:1px solid rgba(255,255,255,.25);border-radius:6px;background:var(--wo-surface-alt,#fff);color:var(--wo-text,#1a1a1a);font-size:16px;font-weight:800;cursor:pointer;line-height:1;padding:0;">\\u2212</button>' +
          '<span style="min-width:18px;text-align:center;font-size:13px;font-weight:700;color:var(--wo-text,#1a1a1a);">'+qty+'</span>' +
          '<button data-qty-id="'+i.id+'" data-qty-delta="1" aria-label="Increase quantity" style="width:28px;height:28px;border:1px solid rgba(255,255,255,.25);border-radius:6px;background:var(--wo-surface-alt,#fff);color:var(--wo-text,#1a1a1a);font-size:16px;font-weight:800;cursor:pointer;line-height:1;padding:0;"'+(qty>=available?' disabled':'')+'>+</button>' +
        '</div></div>' +
        '<button data-id="'+i.id+'" class="wo-remove-item" aria-label="Remove item" style="background:none;border:1px solid rgba(255,255,255,.2);color:#e5798a;cursor:pointer;font-size:13px;font-weight:700;padding:8px 12px;border-radius:8px;flex-shrink:0;transition:background .15s ease;">Remove</button></div>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('.wo-remove-item'), function(btn){
      btn.onclick = function(){ removeFromCart(btn.getAttribute('data-id')); };
      btn.onmouseenter = function(){ this.style.background = 'rgba(255,255,255,.08)'; };
      btn.onmouseleave = function(){ this.style.background = 'none'; };
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-qty-delta]'), function(btn){
      btn.onclick = function(){ changeCartQty(btn.getAttribute('data-qty-id'), parseInt(btn.getAttribute('data-qty-delta'),10)); };
    });
  }
  var totals = computeTotals(cart);
  var totalsEl = document.getElementById('wo-cart-totals');
  if(totalsEl) totalsEl.innerHTML =
    '<div style="display:flex;justify-content:space-between;margin-bottom:6px;color:var(--wo-text,#444);"><span>Subtotal</span><span>$'+totals.subtotal.toFixed(2)+'</span></div>' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:10px;color:var(--wo-text,#777);opacity:.7;"><span>Shipping</span><span>$'+totals.shipping.toFixed(2)+'</span></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:18px;font-weight:800;color:var(--wo-text,#1a1a1a);padding-top:10px;border-top:1px solid rgba(255,255,255,.15);"><span>Total</span><span>$'+totals.grand.toFixed(2)+'</span></div>' +
    (totals.hasPreorder ? '<div style="font-size:11px;color:var(--wo-text,#888);opacity:.75;margin-top:10px;line-height:1.4;">Comic preorders are paid separately, one FOC week at a time, with their own pickup/shipping choice -- checkout will walk you through each.</div>' : '');
  renderCartBadge();
}

var _stripe=null,_elements=null,_pe=null,_cs=null,_reservationId=null,_piId=null;
// FIX (2026-08-06): pickup was never an option here -- every order paid a
// shipping fee and required a full street address, even for a local card
// shop with walk-in customers. Checkout is now two steps (fulfillment/
// contact fields first, payment second) like the vending software's own
// storefront.html, so the PaymentIntent amount is created AFTER the
// fulfillment method is known (pickup = $0 shipping) instead of being
// locked in the instant the modal opens. Also: successful orders are now
// additionally recorded into the vending software's own storefront_orders
// table (via the INVENTORY_API Service Binding), so they show up in the
// dashboard's Orders tab -- previously the only record was this Worker's
// own separate WO_ORDERS KV store and its own token-gated /admin page.
var _fulfillMethod = 'pickup_fedway';
var FULFILL_OPTIONS = [
  { method:'pickup_fedway', label:'Local Pickup — Fed Way Commons', desc:'We’re there most weekends. We’ll text/call to arrange a pickup time.' },
  { method:'pickup_kitsap', label:'Local Meetup — Kitsap County', desc:'We’ll coordinate a meeting spot and time with you directly.' },
  { method:'shipping', label:'Ship to me', desc:'$3 flat rate for 3 raw singles or less, $7 for everything else.' }
];

var WO_INPUT_CSS = 'width:100%;box-sizing:border-box;padding:13px 14px;margin-bottom:10px;border:1.5px solid rgba(255,255,255,.2);border-radius:9px;font-size:15px;color:var(--wo-text,#1a1a1a);background:var(--wo-surface-alt,#fafafa);outline:none;transition:border-color .15s ease,background .15s ease;';

function fulfillOptsHtml(){
  return FULFILL_OPTIONS.map(function(o){
    var on = o.method === _fulfillMethod;
    return '<div class="wo-fulfill-opt" data-method="'+o.method+'" style="border:2px solid '+(on?'var(--wo-accent,#1a1a1a)':'rgba(255,255,255,.15)')+';border-radius:10px;padding:12px 14px;cursor:pointer;'+(on?'background:rgba(255,255,255,.06);':'')+'">' +
      '<b style="display:block;font-size:14px;color:var(--wo-text,#1a1a1a);">'+o.label+'</b>' +
      '<span style="font-size:12px;color:var(--wo-text,#888);opacity:.75;">'+o.desc+'</span>' +
    '</div>';
  }).join('');
}

function ensureModal(){
  if(document.getElementById('wo-checkout-backdrop')) return;
  var m = document.createElement('div');
  // NOTE: the outer full-screen layer is id="wo-checkout-backdrop", NOT
  // "wo-checkout-modal" — a site-wide CSS rule force-styles #wo-checkout-modal
  // as a themed, opaque panel, which used to sit on this exact outer element
  // and silently kill the dark dim-behind-modal effect. That id now belongs
  // to the actual inner panel below, where that rule is correct.
  m.id = 'wo-checkout-backdrop';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0);z-index:100000;display:none;align-items:center;justify-content:center;transition:background .2s ease;';
  m.innerHTML = '<div id="wo-checkout-modal" style="background:var(--wo-surface,#fff);color:var(--wo-text,#1a1a1a);border-radius:16px;max-width:440px;width:92vw;max-height:88vh;overflow-y:auto;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.4);">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;"><strong style="font-size:20px;color:var(--wo-text,#1a1a1a);">Checkout</strong><button id="wo-co-close" aria-label="Close checkout" style="'+WO_CLOSE_BTN_CSS+'">&times;</button></div>' +
    '<div id="wo-co-step1">' +
      '<div id="wo-co-fulfill-opts" style="display:grid;gap:8px;margin-bottom:14px;">'+fulfillOptsHtml()+'</div>' +
      '<input id="wo-co-name" placeholder="Full name" autocomplete="name" style="'+WO_INPUT_CSS+'">' +
      '<input id="wo-co-phone" type="tel" placeholder="Phone number" autocomplete="tel" style="'+WO_INPUT_CSS+'">' +
      '<input id="wo-co-email" type="email" placeholder="Email (optional)" autocomplete="email" style="'+WO_INPUT_CSS+'">' +
      '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--wo-text,#1a1a1a);margin:-4px 0 12px;"><input id="wo-co-sms-consent" type="checkbox" style="margin-top:3px;"> I agree to receive SMS/text messages about this order from The Mana Pocket. Message frequency depends on order activity. Msg &amp; data rates may apply. Reply STOP to cancel, HELP for help. See our <a href="https://themanapocket.com/privacy-policy" target="_blank" style="color:inherit;">Privacy Policy</a> and <a href="https://themanapocket.com/terms-and-conditions" target="_blank" style="color:inherit;">Terms</a>.</label>' +
      '<div id="wo-co-shipping-fields" style="display:'+(_fulfillMethod==='shipping'?'block':'none')+';">' +
        '<div style="font-size:12px;color:var(--wo-text,#999);opacity:.7;margin:2px 0 8px;">Ships within the U.S. only.</div>' +
        '<input id="wo-co-addr1" placeholder="Address" autocomplete="address-line1" style="'+WO_INPUT_CSS+'">' +
        '<div style="display:flex;gap:8px;">' +
          '<input id="wo-co-city" placeholder="City" autocomplete="address-level2" style="'+WO_INPUT_CSS+'flex:2;">' +
          '<input id="wo-co-state" placeholder="State" autocomplete="address-level1" maxlength="2" style="'+WO_INPUT_CSS+'flex:1;text-transform:uppercase;">' +
          '<input id="wo-co-zip" placeholder="ZIP" autocomplete="postal-code" inputmode="numeric" style="'+WO_INPUT_CSS+'flex:1;">' +
        '</div>' +
      '</div>' +
      '<div id="wo-co-err1" style="color:#e5798a;font-size:13px;margin-bottom:10px;"></div>' +
      '<button id="wo-co-continue" style="width:100%;padding:15px;background:var(--wo-accent,#1a1a1a);color:var(--wo-surface,#fff);border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:filter .15s ease;">Continue to Payment</button>' +
    '</div>' +
    '<div id="wo-co-step2" style="display:none;">' +
      '<div id="wo-co-total-line" style="font-size:14px;margin-bottom:12px;color:var(--wo-text,#1a1a1a);"></div>' +
      '<div id="wo-co-payment-element" style="margin:16px 0;"></div>' +
      '<div id="wo-co-err2" style="color:#e5798a;font-size:13px;margin-bottom:10px;"></div>' +
      '<button id="wo-co-pay" style="width:100%;padding:15px;background:var(--wo-accent,#1a1a1a);color:var(--wo-surface,#fff);border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:filter .15s ease;">Place Order</button>' +
      '<div style="text-align:center;font-size:12px;color:var(--wo-text,#999);opacity:.7;margin-top:10px;">Secured by Stripe — your card is charged immediately and your order goes straight into the fulfillment queue.</div>' +
    '</div>' +
    '<div id="wo-co-success" style="display:none;text-align:center;padding:24px 0;">' +
      '<div style="font-size:44px;margin-bottom:12px;">✅</div>' +
      '<h3 style="font-size:20px;margin:0 0 8px;color:var(--wo-text,#1a1a1a);">Order confirmed!</h3>' +
      '<p style="color:var(--wo-text,#666);opacity:.8;font-size:14px;line-height:1.5;">Your payment went through and your order is ready to be fulfilled. A confirmation email is on its way.</p>' +
    '</div>' +
  '</div>';
  document.body.appendChild(m);
  m.onclick = function(e){ if(e.target === m) closeCheckoutModal(); };
  document.getElementById('wo-checkout-modal').onclick = function(e){ e.stopPropagation(); };
  document.getElementById('wo-co-close').onmouseenter = function(){ this.style.background = 'rgba(255,255,255,.1)'; };
  document.getElementById('wo-co-close').onmouseleave = function(){ this.style.background = 'none'; };
  document.getElementById('wo-co-close').onclick = closeCheckoutModal;
  document.getElementById('wo-co-continue').onclick = submitCheckoutStep1;
  document.getElementById('wo-co-pay').onmouseenter = function(){ this.style.filter = 'brightness(1.1)'; };
  document.getElementById('wo-co-pay').onmouseleave = function(){ this.style.filter = 'none'; };
  document.getElementById('wo-co-pay').onclick = confirmCheckoutPayment;
  Array.prototype.forEach.call(m.querySelectorAll('#wo-co-fulfill-opts [data-method]'), function(el){
    el.onclick = function(){ setCheckoutFulfillment(el.getAttribute('data-method')); };
  });
  Array.prototype.forEach.call(m.querySelectorAll('#wo-co-step1 input'), function(inp){
    // setProperty(...,'important') because a site-wide rule force-sets
    // #wo-checkout-modal input { border:1px solid ... !important }, which
    // would otherwise silently swallow this focus highlight.
    inp.onfocus = function(){ this.style.setProperty('border-color', 'var(--wo-accent,#1a1a1a)', 'important'); };
    inp.onblur = function(){ this.style.setProperty('border-color', 'rgba(255,255,255,.2)', 'important'); };
  });
}

function setCheckoutFulfillment(method){
  _fulfillMethod = method;
  var host = document.getElementById('wo-co-fulfill-opts');
  if(host) host.innerHTML = fulfillOptsHtml();
  Array.prototype.forEach.call(document.querySelectorAll('#wo-co-fulfill-opts [data-method]'), function(el){
    el.onclick = function(){ setCheckoutFulfillment(el.getAttribute('data-method')); };
  });
  var shipFields = document.getElementById('wo-co-shipping-fields');
  if(shipFields) shipFields.style.display = method === 'shipping' ? 'block' : 'none';
}

function showErr1(msg){ var e=document.getElementById('wo-co-err1'); if(e) e.textContent = msg || ''; }
function showErr2(msg){ var e=document.getElementById('wo-co-err2'); if(e) e.textContent = msg || ''; }

function openCheckoutModal(){
  var cart = getCart();
  if(!cart.length) return;
  ensureModal();
  _fulfillMethod = 'pickup_fedway';
  setCheckoutFulfillment('pickup_fedway');
  document.getElementById('wo-co-step1').style.display = 'block';
  document.getElementById('wo-co-step2').style.display = 'none';
  document.getElementById('wo-co-success').style.display = 'none';
  showErr1(''); showErr2('');
  var m = document.getElementById('wo-checkout-backdrop');
  m.style.display = 'flex';
  requestAnimationFrame(function(){ m.style.background = 'rgba(0,0,0,.5)'; });
}

function closeCheckoutModal(){
  var m = document.getElementById('wo-checkout-backdrop');
  if(!m) return;
  m.style.background = 'rgba(0,0,0,0)';
  setTimeout(function(){ m.style.display = 'none'; }, 200);
}

function validateContactFields(name, phone, addr1, city, state, zip){
  if(!name || name.trim().length < 2 || !/[a-zA-Z]/.test(name)){
    return 'Please enter your full name.';
  }
  if(!phone || phone.replace(/\D/g,'').length < 7){
    return 'Please enter a valid phone number.';
  }
  if(_fulfillMethod !== 'shipping') return null;
  if(!addr1 || addr1.trim().length < 4 || !/\d/.test(addr1)){
    return 'Please enter a valid street address (with a number).';
  }
  if(!city || city.trim().length < 2 || !/[a-zA-Z]/.test(city)){
    return 'Please enter a valid city.';
  }
  if(!state || !/^[a-zA-Z]{2}$/.test(state.trim())){
    return 'Please enter your 2-letter state (e.g. WA).';
  }
  var zipDigits = (zip || '').replace(/\D/g, '');
  if(zipDigits.length !== 5 && zipDigits.length !== 9){
    return 'Please enter a valid 5-digit ZIP code.';
  }
  return null;
}

// Step 1: validate contact/fulfillment fields, then create the Stripe
// PaymentIntent server-side (amount now correctly reflects $0 shipping for
// pickup) before moving on to the actual card entry step.
function submitCheckoutStep1(){
  var name = (document.getElementById('wo-co-name').value || '').trim();
  var phone = (document.getElementById('wo-co-phone').value || '').trim();
  var email = (document.getElementById('wo-co-email').value || '').trim();
  var addr1 = (document.getElementById('wo-co-addr1').value || '').trim();
  var city = (document.getElementById('wo-co-city').value || '').trim();
  var state = (document.getElementById('wo-co-state').value || '').trim().toUpperCase();
  var zipRaw = (document.getElementById('wo-co-zip').value || '').trim();
  var fieldErr = validateContactFields(name, phone, addr1, city, state, zipRaw);
  if(fieldErr){ showErr1(fieldErr); return; }
  var zipDigits = zipRaw.replace(/\D/g, '');
  var zip = zipDigits.length === 9 ? zipDigits.slice(0,5) + '-' + zipDigits.slice(5) : zipDigits;
  showErr1('');
  var shippingAddress = _fulfillMethod === 'shipping' ? { line1: addr1, city: city, state: state, zip: zip } : null;
  var cart = getCart();
  var btn = document.getElementById('wo-co-continue');
  btn.disabled = true; btn.textContent = 'Please wait…';
  fetch(API_BASE + '/api/cart/create-intent', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      items: cart, email: email,
      fulfillment: { method: _fulfillMethod, name: name, phone: phone, email: email, shippingAddress: shippingAddress }
    })
  }).then(function(r){ return r.json(); }).then(function(d){
    btn.disabled = false; btn.textContent = 'Continue to Payment';
    if(d.error){ showErr1(d.error); return; }
    _cs = d.clientSecret; _piId = d.paymentIntentId; _reservationId = d.reservationId;
    _checkoutContact = { name: name, phone: phone, email: email, shippingAddress: shippingAddress };
    _checkoutAmountCents = d.amountCents;
    showPaymentStep(d);
  }).catch(function(){
    btn.disabled = false; btn.textContent = 'Continue to Payment';
    showErr1('Could not start checkout. Try again.');
  });
}

var _checkoutContact = null, _checkoutAmountCents = 0;

function showPaymentStep(data){
  document.getElementById('wo-co-step1').style.display = 'none';
  document.getElementById('wo-co-step2').style.display = 'block';
  var totalLine = document.getElementById('wo-co-total-line');
  if(totalLine) totalLine.innerHTML = 'Total: <b>$'+((data.amountCents||0)/100).toFixed(2)+'</b>';
  mountStripe();
}

function mountStripe(){
  if(window.Stripe){ doMount(); }
  else { var sc=document.createElement('script'); sc.src='https://js.stripe.com/v3/'; sc.onload=doMount; document.head.appendChild(sc); }
}
function doMount(){
  if(!_stripe) _stripe = Stripe(STRIPE_PK);
  var rootStyles = getComputedStyle(document.documentElement);
  var woAccent = rootStyles.getPropertyValue('--wo-accent').trim() || '#1a1a1a';
  _elements = _stripe.elements({ clientSecret: _cs, appearance: { theme: 'stripe', variables: { colorPrimary: woAccent, borderRadius: '8px' } } });
  _pe = _elements.create('payment', {
    fields: { billingDetails: { name: 'never', email: 'never', address: 'never' } }
  });
  _pe.mount('#wo-co-payment-element');
}

// Step 2: actually charge the card, then record the completed order.
function confirmCheckoutPayment(){
  if(!_stripe || !_elements){ showErr2('Payment form still loading, one sec.'); return; }
  var c = _checkoutContact || {};
  showErr2('');
  var payDetails = { name: c.name, email: c.email };
  if(c.shippingAddress) payDetails.address = { line1: c.shippingAddress.line1, city: c.shippingAddress.city, state: c.shippingAddress.state, postal_code: c.shippingAddress.zip, country: 'US' };
  _stripe.confirmPayment({
    elements: _elements, redirect: 'if_required',
    confirmParams: { payment_method_data: { billing_details: payDetails } }
  }).then(function(res){
    if(res.error){ showErr2(res.error.message); return; }
    var cart = getCart();
    var totals = computeTotals(cart);
    return fetch(API_BASE + '/api/order/confirm', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        paymentIntentId: _piId,
        items: cart, totals: totals,
        customer: { name: c.name, email: c.email },
        shipping: c.shippingAddress ? { address1: c.shippingAddress.line1, city: c.shippingAddress.city, state: c.shippingAddress.state, zip: c.shippingAddress.zip } : {},
        fulfillment: { method: _fulfillMethod, name: c.name, phone: c.phone, email: c.email, shippingAddress: c.shippingAddress },
        amountCents: _checkoutAmountCents
      })
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(data){
        // The card was already charged by confirmPayment() above — never tell
        // the customer this step "failed" (that risks a confused retry and a
        // duplicate charge). Always show success; if saving the order details
        // failed, surface it loudly for us instead so it can be fixed by hand.
        setCart([]);
        document.getElementById('wo-co-step2').style.display = 'none';
        var successEl = document.getElementById('wo-co-success');
        if(successEl) successEl.style.display = 'block';
        if(!r.ok || data.error){
          console.error('[WO] order/confirm failed after a successful charge', _piId, data && data.error);
          if(successEl){
            var note = document.createElement('p');
            note.style.cssText = 'color:#e5798a;font-size:12px;margin-top:8px;';
            note.textContent = 'Your payment went through, but we hit a snag saving your order. Please email us your payment reference: ' + _piId;
            successEl.appendChild(note);
          }
        }
      });
    });
  }).catch(function(err){ showErr2((err && err.message) ? err.message : 'Something went wrong. Please try again.'); });
}

function initTeamTheme(){
  var carriers = document.querySelectorAll('.wo-cart-data');
  if(carriers.length !== 1) return;
  var dataEl = carriers[0];
  var primaryEl = dataEl.querySelector('.wo-d-team-primary');
  var secondaryEl = dataEl.querySelector('.wo-d-team-secondary');
  var accentEl = dataEl.querySelector('.wo-d-team-accent');
  var primary = primaryEl ? primaryEl.textContent.trim() : '';
  if(!primary) return;
  var secondary = secondaryEl ? secondaryEl.textContent.trim() : '';
  var accent = accentEl ? accentEl.textContent.trim() : '';
  var root = document.documentElement.style;
  root.setProperty('--wo-theme-primary', primary);
  if(secondary) root.setProperty('--wo-theme-secondary', secondary);
  if(accent) root.setProperty('--wo-theme-accent', accent);
}

function initProductBrowsing(){
  var carriers = document.querySelectorAll('.wo-cart-data');
  if(carriers.length !== 1) return;
  var dataEl = carriers[0];
  var slugEl = dataEl.querySelector('.wo-d-slug');
  var catEl = dataEl.querySelector('.wo-d-category');
  var slug = slugEl ? slugEl.textContent.trim() : '';
  var category = catEl ? catEl.textContent.trim() : '';
  if(!slug) return;

  var nav = document.createElement('div');
  nav.id = 'wo-product-nav';
  nav.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin:16px 0;font-size:14px;';
  nav.innerHTML = '<button id="wo-prev-btn" style="background:none;border:1px solid rgba(255,255,255,.25);color:var(--wo-text,#1a1a1a);border-radius:8px;padding:8px 14px;cursor:pointer;" disabled>&#8592; Previous</button>' +
    '<span id="wo-nav-position" style="color:var(--wo-text,#888);opacity:.7;font-size:12px;"></span>' +
    '<button id="wo-next-btn" style="background:none;border:1px solid rgba(255,255,255,.25);color:var(--wo-text,#1a1a1a);border-radius:8px;padding:8px 14px;cursor:pointer;" disabled>Next &#8594;</button>';
  dataEl.parentElement.insertBefore(nav, dataEl);

  fetch(API_BASE + '/api/product-neighbors?slug=' + encodeURIComponent(slug) + '&category=' + encodeURIComponent(category))
    .then(function(r){ return r.json(); })
    .then(function(d){
      var prevBtn = document.getElementById('wo-prev-btn');
      var nextBtn = document.getElementById('wo-next-btn');
      var posEl = document.getElementById('wo-nav-position');
      if(d.total) posEl.textContent = category + ' \\u2014 ' + d.position + ' of ' + d.total;
      if(d.prev){
        prevBtn.disabled = false;
        prevBtn.title = d.prev.name || '';
        prevBtn.onclick = function(){ window.location.href = '/product/' + d.prev.slug; };
      }
      if(d.next){
        nextBtn.disabled = false;
        nextBtn.title = d.next.name || '';
        nextBtn.onclick = function(){ window.location.href = '/product/' + d.next.slug; };
      }
    })
    .catch(function(){});
}

// Category taxonomy: maps the short slugs used in nav links (?cat=sports-cards
// etc) to the substrings we'll match against each item's real category field
// coming out of Supabase. Kept intentionally loose (substring, case-insensitive)
// because the exact category strings sellers type into inventory aren't
// standardized -- "Pokemon", "Pokémon TCG", "MTG", "Magic: The Gathering" etc
// should all count as a match for the "tcg" slug. Edit the right-hand arrays
// here if a slug isn't catching everything it should.
var CATEGORY_SLUG_MAP = {
  'sports-cards': ['sport', 'baseball', 'basketball', 'football', 'hockey'],
  'pokemon': ['pokemon', 'pok\\u00e9mon'],
  'mtg': ['mtg', 'magic'],
  'one-piece': ['one piece'],
  'yugioh': ['yugioh', 'yu-gi-oh', 'yu gi oh'],
  'lorcana': ['lorcana'],
  'tcg': ['pokemon', 'pok\\u00e9mon', 'mtg', 'magic', 'one piece', 'yugioh', 'yu-gi-oh', 'lorcana'],
  'comics': ['comic'],
  'collectibles': ['collectible', 'figure', 'toy', 'plush', 'apparel', 'statue'],
  'supplies': ['supply', 'supplies', 'toploader', 'sleeve', 'binder', 'playmat']
};
var CATEGORY_SLUG_LABELS = {
  'all': 'All departments',
  'sports-cards': 'Sports Cards',
  'pokemon': 'Pok\\u00e9mon',
  'mtg': 'Magic: The Gathering',
  'one-piece': 'One Piece',
  'yugioh': 'Yu-Gi-Oh!',
  'lorcana': 'Disney Lorcana',
  'comics': 'Comics',
  'collectibles': 'Collectibles',
  'supplies': 'Supplies'
};

function categoryMatchesSlug(itemCategory, slug){
  if(slug === 'all' || !slug) return true;
  var cat = (itemCategory || '').toLowerCase();
  var needles = CATEGORY_SLUG_MAP[slug];
  if(!needles) return cat.indexOf(slug.replace(/-/g,' ')) !== -1;
  return needles.some(function(n){ return cat.indexOf(n) !== -1; });
}

// Builds the search + category filter bar above the live inventory grid.
// Uses the same wo-store-controls/wo-store-search-field/wo-store-control-field
// classes already styled in Webflow (themed to --wo-surface/secondary/text),
// so this picks up the site's look with zero extra CSS of its own.
function buildLiveShopControls(items, onFilterChange){
  if(!document.getElementById('wo-store-controls-mobile-style')){
    var style=document.createElement('style');style.id='wo-store-controls-mobile-style';
    style.textContent='.wo-store-controls-toggle{display:none}.wo-store-controls-fields{display:contents}@media(max-width:767px){.wo-store-controls{display:block!important;padding:8px!important;overflow-anchor:none;transition:box-shadow .2s ease}.wo-store-controls-toggle{display:flex;width:100%;min-height:48px;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--wo-text,#222);font:700 15px system-ui,sans-serif;text-align:left;cursor:pointer}.wo-store-controls-summary{overflow:hidden;color:var(--wo-text,#666);font-size:12px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}.wo-store-controls-chevron{flex:none;transition:transform .22s ease}.wo-store-controls-fields{display:grid;grid-template-columns:1fr;gap:10px;max-height:360px;margin-top:8px;opacity:1;overflow:hidden;transform:translateY(0);transition:max-height .24s ease,margin .24s ease,opacity .18s ease,transform .24s ease}.wo-store-controls-fields>*{box-sizing:border-box;width:100%;min-width:0!important;max-width:none!important}.wo-store-controls.is-collapsed .wo-store-controls-fields{max-height:0;margin-top:0;opacity:0;pointer-events:none;transform:translateY(-8px)}.wo-store-controls.is-collapsed .wo-store-controls-chevron{transform:rotate(180deg)}}@media(prefers-reduced-motion:reduce){.wo-store-controls,.wo-store-controls-fields,.wo-store-controls-chevron{transition:none!important}}';
    document.head.appendChild(style);
  }
  var bar=document.createElement('div');
  bar.className='wo-store-controls';
  bar.style.cssText='display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:20px;padding:14px;border-radius:12px;';
  var toggle=document.createElement('button');toggle.type='button';toggle.className='wo-store-controls-toggle';
  toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-controls','wo-store-controls-fields');
  toggle.innerHTML='<span>Search &amp; filters</span><span class="wo-store-controls-summary">All items</span><span class="wo-store-controls-chevron" aria-hidden="true">&#9652;</span>';
  var fields=document.createElement('div');fields.id='wo-store-controls-fields';fields.className='wo-store-controls-fields';
  var search=document.createElement('input');
  search.type='search';search.placeholder='Search name, player, set, number...';
  search.setAttribute('aria-label','Search inventory');
  search.className='wo-store-search-field';
  search.style.cssText='flex:2;min-width:180px;padding:10px 12px;border-radius:8px;font:16px system-ui,sans-serif;';
  function makeSelect(label,cls){
    var el=document.createElement('select');el.className=cls;el.setAttribute('aria-label',label);
    el.style.cssText='flex:1;min-width:180px;max-width:100%;padding:10px 12px;border-radius:8px;font:16px system-ui,sans-serif;';return el;
  }
  var select=makeSelect('Category','wo-store-control-field');
  var type=makeSelect('Product type','wo-store-type-field');
  var sort=makeSelect('Sort results','wo-store-sort-field');
  function productTypeOptions(options,category){
    var result=(options||[]).slice();
    var normalized=String(category||'').trim().toLowerCase();
    if((normalized==='comic'||normalized==='comics')&&!result.some(function(entry){return entry.value==='preorders';})){
      result.push({value:'preorders',label:'Comic preorders'});
    }
    return result;
  }
  function populate(el,options,allLabel,current){
    el.replaceChildren();
    [{value:'all',label:allLabel}].concat(options||[]).forEach(function(entry){
      var option=document.createElement('option');option.value=entry.value;
      option.textContent=entry.label+(entry.count==null?'':' ('+entry.count+')');el.appendChild(option);
    });
    if(current && current!=='all' && !Array.from(el.options).some(function(o){return o.value===current;})){
      var option=document.createElement('option');option.value=current;option.textContent=CATEGORY_SLUG_LABELS[current]||current;el.appendChild(option);
    }
    el.value=current||'all';
  }
  populate(select,[],'All categories');populate(type,[],'All product types');
  populate(sort,[{value:'price-asc',label:'Price: low to high'},{value:'price-desc',label:'Price: high to low'},{value:'name',label:'Name: A to Z'}],'Recently updated');
  var clear=document.createElement('button');clear.type='button';clear.textContent='Clear filters';clear.style.cssText='min-height:44px;padding:10px 14px;border:1px solid currentColor;border-radius:8px;cursor:pointer;font:600 14px system-ui,sans-serif;background:var(--wo-surface,#fff);color:var(--wo-text,#222);';
  [search,select,type,sort,clear].forEach(function(el){fields.appendChild(el);});
  bar.appendChild(toggle);bar.appendChild(fields);
  function updateSummary(){
    var parts=[];
    if(select.value&&select.value!=='all')parts.push(select.options[select.selectedIndex]?select.options[select.selectedIndex].textContent:select.value);
    if(type.value&&type.value!=='all')parts.push(type.options[type.selectedIndex]?type.options[type.selectedIndex].textContent:type.value);
    if(search.value.trim())parts.push('\u201c'+search.value.trim()+'\u201d');
    var summary=toggle.querySelector('.wo-store-controls-summary');if(summary)summary.textContent=parts.join(' \u00b7 ')||'All items';
  }
  var scrollTransitionLocked=false,scrollTravel=0,scrollDirection=0;
  function setCollapsed(collapsed,lockScroll){
    if(bar.classList.contains('is-collapsed')===collapsed)return;
    bar.classList.toggle('is-collapsed',collapsed);toggle.setAttribute('aria-expanded',collapsed?'false':'true');
    if(lockScroll){
      scrollTransitionLocked=true;
      window.setTimeout(function(){lastScrollY=window.scrollY;scrollTravel=0;scrollDirection=0;scrollTransitionLocked=false;},420);
    }
  }
  toggle.addEventListener('click',function(){setCollapsed(!bar.classList.contains('is-collapsed'));});
  fields.addEventListener('focusin',function(){setCollapsed(false);});
  var lastScrollY=window.scrollY;
  window.addEventListener('scroll',function(){
    if(!window.matchMedia('(max-width: 767px)').matches)return;
    var y=window.scrollY,delta=y-lastScrollY;lastScrollY=y;
    if(!delta||fields.contains(document.activeElement)||scrollTransitionLocked)return;
    var direction=delta>0?1:-1;
    if(direction!==scrollDirection){scrollDirection=direction;scrollTravel=0;}
    scrollTravel+=Math.abs(delta);
    if(direction>0&&y>120&&scrollTravel>=48)setCollapsed(true,true);
    else if(direction<0&&scrollTravel>=96)setCollapsed(false,true);
  },{passive:true});
  function fire(){updateSummary();onFilterChange(select.value,type.value||'all',search.value.trim(),sort.value);}
  search.addEventListener('input',fire);
  select.addEventListener('change',function(){populate(type,productTypeOptions([],select.value),'All product types');fire();});
  type.addEventListener('change',fire);sort.addEventListener('change',fire);
  clear.addEventListener('click',function(){select.value='all';populate(type,[],'All product types');search.value='';sort.value='all';search.dispatchEvent(new Event('input',{bubbles:true}));});
  function update(options){
    if(!options)return;
    populate(select,options.categories,'All categories',select.value);
    populate(type,productTypeOptions(options.types,select.value),'All product types',type.value);
    updateSummary();
  }
  return {el:bar,select:select,type:type,search:search,sort:sort,fire:fire,update:update,populate:populate,productTypeOptions:productTypeOptions};
}

function initShopUrlFilter(controls){
  var params=new URLSearchParams(window.location.search);
  var cat=params.get('cat')||params.get('category')||'all';
  controls.populate(controls.select,[],'All categories',cat);
  controls.populate(controls.type,controls.productTypeOptions([],cat),'All product types',params.get('type')||params.get('subcat')||'all');
  controls.search.value=params.get('q')||params.get('search')||'';
  controls.sort.value=params.get('sort')||'all';
  controls.fire();
}

// ----------------------------------------------------------------------------
// NEW: live inventory shop — fills #wo-live-shop with real cards from Supabase
// (via the vending software's public storefront endpoint)
// ----------------------------------------------------------------------------
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}

// Book details/story/creators block for comic items -- the vending
// software only attaches 'comic' when the item actually has a saved Metron
// record, so this renders nothing otherwise. Mirrors the same section on
// the vending software's own storefront.html.
function woComicDetailHtml(c){
  if(!c) return '';
  var stats = [['Series', c.seriesName], ['Issue #', c.number], ['Publisher', c.publisher], ['Cover date', c.coverDate], ['Series began', c.seriesYearBegan]].filter(function(pair){ return pair[1]; });
  var credits = (c.credits||[]).map(function(cr){ return [cr.creator, (cr.roles||[]).join(', ')].filter(Boolean).join(' \\u2014 '); }).join('; ');
  var hasContent = stats.length || c.description || (c.writers||[]).length || (c.artists||[]).length || (c.coverArtists||[]).length;
  if(!hasContent) return '';
  var html = '<div style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,255,255,.12);">';
  html += '<div style="font-weight:700;font-size:13px;margin-bottom:8px;color:var(--wo-text,#1a1a1a);">Book Details, Story &amp; Creators</div>';
  if(stats.length){
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;margin-bottom:10px;">';
    stats.forEach(function(pair){
      html += '<div style="background:var(--wo-surface-alt,#f5f7fa);border-radius:6px;padding:6px 8px;"><div style="font-size:8px;color:var(--wo-text,#888);opacity:.7;text-transform:uppercase;">'+escapeHtml(pair[0])+'</div><div style="font-size:12px;font-weight:600;color:var(--wo-text,#1a1a1a);">'+escapeHtml(String(pair[1]))+'</div></div>';
    });
    html += '</div>';
  }
  if(c.description) html += '<div style="font-size:12px;line-height:1.6;margin-bottom:10px;color:var(--wo-text,#1a1a1a);">'+escapeHtml(c.description)+'</div>';
  if((c.writers||[]).length) html += '<div style="font-size:12px;margin-bottom:2px;color:var(--wo-text,#1a1a1a);"><b>Writer:</b> '+escapeHtml(c.writers.join(', '))+'</div>';
  if((c.artists||[]).length) html += '<div style="font-size:12px;margin-bottom:2px;color:var(--wo-text,#1a1a1a);"><b>Artist:</b> '+escapeHtml(c.artists.join(', '))+'</div>';
  if((c.coverArtists||[]).length) html += '<div style="font-size:12px;margin-bottom:2px;color:var(--wo-text,#1a1a1a);"><b>Cover artist:</b> '+escapeHtml(c.coverArtists.join(', '))+'</div>';
  if(credits) html += '<div style="font-size:11px;color:var(--wo-text,#888);opacity:.7;margin-top:6px;">'+escapeHtml(credits)+'</div>';
  html += '</div>';
  return html;
}

// Live-inventory cards used to have nothing to click but "Add to Cart" --
// no detail view at all, so signature status and comic info (both now
// present on 'item' since renderLiveInventory calls the real
// /public/storefront data via the vending software's Worker) had nowhere
// to show. This is a lightweight in-page modal instead of a real detail
// page/route, so it works regardless of whether this item also happens to
// have a mirrored Webflow CMS record.
function openWoLiveItemDetail(item){
  var existing = document.getElementById('wo-live-detail-overlay');
  if(existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'wo-live-detail-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 12px;';
  overlay.addEventListener('click', function(e){ if(e.target === overlay) overlay.remove(); });
  var metaLine = [item.set, item.year, item.variant, item.condition].filter(Boolean).join(' \\u00b7 ');
  var stockQty = Math.max(0, parseInt(item.quantity, 10) || 0);
  var shareUrl = API_BASE + '/share/item?id=' + encodeURIComponent(item.id);
  var card = document.createElement('div');
  card.style.cssText = 'width:100%;max-width:520px;background:var(--wo-surface,#fff);color:var(--wo-text,#1a1a1a);border-radius:14px;padding:20px;position:relative;';
  card.innerHTML =
    '<button data-wo-close-detail aria-label="Close" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:22px;cursor:pointer;color:var(--wo-text,#888);opacity:.7;line-height:1;">&times;</button>' +
    (item.image ? '<img src="'+escapeHtml(item.image)+'" alt="'+escapeHtml(item.name)+'" style="width:100%;max-height:340px;object-fit:contain;border-radius:8px;background:var(--wo-surface-alt,#f2f2f2);">' : '') +
    '<div style="font-size:11px;color:var(--wo-text,#888);opacity:.7;text-transform:uppercase;margin-top:14px;">'+escapeHtml(item.category||'')+'</div>' +
    '<div style="font-size:20px;font-weight:800;margin-top:4px;color:var(--wo-text,#1a1a1a);">'+escapeHtml(item.name)+'</div>' +
    (metaLine ? '<div style="font-size:12px;color:var(--wo-text,#888);opacity:.7;margin-top:4px;">'+escapeHtml(metaLine)+'</div>' : '') +
    (item.isSigned ? '<div style="display:inline-block;margin-top:8px;padding:3px 8px;border-radius:6px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;">\\u270D Signed'+(item.signedBy ? ' by '+escapeHtml(item.signedBy) : '')+'</div>' : '') +
    '<div style="font-size:22px;font-weight:800;margin-top:10px;color:var(--wo-text,#1a1a1a);">$'+Number(item.price||0).toFixed(2)+'</div>' +
    (stockQty > 0 && stockQty <= 3 ? '<div style="font-size:11px;color:#e5798a;font-weight:700;">Only '+stockQty+' left</div>' : '') +
    '<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:14px;">' +
    '<button data-wo-add-to-cart style="min-width:0;padding:12px;background:var(--wo-accent,#1a1a1a);color:var(--wo-surface,#fff);border:none;border-radius:8px;font-weight:600;cursor:pointer;">Add to Cart</button>' +
    '<button data-wo-share-item type="button" style="padding:12px 16px;background:transparent;color:var(--wo-text,#1a1a1a);border:1px solid currentColor;border-radius:8px;font-weight:600;cursor:pointer;">Share</button></div>' +
    woComicDetailHtml(item.comic);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector('[data-wo-close-detail]').addEventListener('click', function(){ overlay.remove(); });
  card.querySelector('[data-wo-add-to-cart]').addEventListener('click', function(e){
    e.preventDefault();
    addToCart({ id:item.id, name:item.name, price:Number(item.price||0), image:item.image||'', available: stockQty || 1 }, e.currentTarget);
    overlay.remove();
  });
  card.querySelector('[data-wo-share-item]').addEventListener('click', function(){
    if(navigator.share){
      navigator.share({ title:item.name, text:(item.comic&&item.comic.description)||metaLine||'Available from The Mana Pocket', url:shareUrl }).catch(function(){});
      return;
    }
    window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(shareUrl), '_blank', 'noopener,noreferrer,width=640,height=520');
  });
}

// Server-paged storefront renderer. Only a small first batch is downloaded
// and turned into DOM nodes; later batches arrive when the customer reaches
// the sentinel. Filtering starts a fresh server query instead of constructing
// hundreds of hidden cards and repeatedly laying all of them out.
function renderLiveInventoryPaged(){
  var mount = document.getElementById('wo-live-shop');
  if(!mount) return;
  mount.setAttribute('data-wo-server-paged','true');
  mount.innerHTML = '';
  var grid = document.createElement('div');
  grid.className = 'wo-live-grid';
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;align-items:stretch;min-height:110vh;';
  var status = document.createElement('div');
  status.setAttribute('aria-live','polite');
  status.style.cssText = 'padding:18px;text-align:center;color:var(--wo-text,#888);opacity:.8;';
  var sentinel = document.createElement('div');
  sentinel.style.cssText = 'height:1px;grid-column:1/-1;';
  var pageSize = window.matchMedia && window.matchMedia('(max-width: 767px)').matches ? 12 : 36;
  var state = { offset:0, total:0, hasMore:true, loading:false, category:'all', type:'all', query:'', sort:'all', token:0 };
  var timer = 0;

  function itemCard(item, prioritizeImage){
    var card = document.createElement('article');
    card.className = 'wo-live-card';
    card.setAttribute('data-category', item.categorySlug || (item.category || '').toLowerCase());
    card.setAttribute('data-product-type', item.productTypeSlug || '');
    card.style.cssText = 'border:1px solid rgba(255,255,255,.12);border-radius:12px;overflow:hidden;background:var(--wo-surface-alt,#fff);color:var(--wo-text,#1a1a1a);display:flex;flex-direction:column;cursor:pointer;content-visibility:auto;contain-intrinsic-size:420px;';
    var stockQty = Math.max(0, parseInt(item.quantity, 10) || 0);
    var metaLine = [item.set,item.year,item.variant,item.condition].filter(Boolean).join(' \u00b7 ');
    var image = item.image
      ? '<img loading="'+(prioritizeImage?'eager':'lazy')+'"'+(prioritizeImage?' fetchpriority="high"':'')+' decoding="async" src="'+escapeHtml(item.image)+'" alt="'+escapeHtml(item.name)+'" width="440" height="440" style="width:100%;aspect-ratio:1/1;object-fit:contain;background:var(--wo-surface,#f2f2f2);">'
      : '<div aria-hidden="true" style="width:100%;aspect-ratio:1/1;background:var(--wo-surface,#f2f2f2);"></div>';
    card.innerHTML = image +
      '<div class="wo-live-card-body" style="padding:12px;display:flex;flex-direction:column;gap:6px;flex:1;">' +
      '<div style="font-size:14px;font-weight:600;color:var(--wo-text,#1a1a1a);">'+escapeHtml(item.name)+'</div>' +
      (metaLine?'<div style="font-size:12px;color:var(--wo-text,#888);opacity:.75;">'+escapeHtml(metaLine)+'</div>':'') +
      (item.productType?'<div style="font-size:10px;color:var(--wo-text,#888);opacity:.7;text-transform:uppercase;">'+escapeHtml(item.productType)+'</div>':'') +
      (item.isSigned?'<div style="font-size:10px;font-weight:700;color:#92400e;">\u270D Signed'+(item.signedBy?' by '+escapeHtml(item.signedBy):'')+'</div>':'') +
      (stockQty>0?'<div style="font-size:11px;color:'+(stockQty<=3?'#e5798a':'var(--wo-text,#888)')+';font-weight:'+(stockQty<=3?'700':'400')+';">'+(stockQty<=3?'Only '+stockQty+' left':stockQty+' in stock')+'</div>':'') +
      '<div style="font-size:15px;font-weight:700;margin-top:auto;color:var(--wo-text,#1a1a1a);">$'+Number(item.price||0).toFixed(2)+'</div>' +
      '<button data-wo-add-to-cart style="min-height:44px;padding:10px;background:var(--wo-accent,#1a1a1a);color:var(--wo-surface,#fff);border:none;border-radius:8px;font-weight:600;cursor:pointer;">Add to Cart</button>' +
      '<div class="wo-cart-data" style="display:none;"><span class="wo-d-slug">'+escapeHtml(item.id)+'</span><span class="wo-d-name">'+escapeHtml(item.name)+'</span><span class="wo-d-price">'+Number(item.price||0).toFixed(2)+'</span><img class="wo-d-image" src="'+escapeHtml(item.image||'')+'"><span class="wo-d-category">'+escapeHtml(item.category||'')+'</span><span class="wo-d-qty">'+(stockQty||1)+'</span></div></div>';
    card.addEventListener('click',function(event){ if(!event.target.closest('[data-wo-add-to-cart]')) openWoLiveItemDetail(item); });
    card.querySelector('[data-wo-add-to-cart]').addEventListener('click',function(event){
      event.preventDefault();
      event.stopPropagation();
      addToCart({id:item.id,name:item.name,price:Number(item.price||0),image:item.image||'',available:stockQty||1},event.currentTarget);
    });
    return card;
  }

  function load(reset){
    if(!reset && (state.loading || !state.hasMore)) return;
    if(reset){ state.offset=0;state.hasMore=true;grid.innerHTML='';mount.removeAttribute('data-wo-loaded');state.token++; }
    var token = state.token;
    state.loading = true;
    status.textContent = state.offset ? 'Loading more\u2026' : 'Loading inventory\u2026';
    var params = new URLSearchParams({limit:String(pageSize),offset:String(state.offset)});
    if(state.category && state.category!=='all') params.set('category',state.category);
    if(state.type && state.type!=='all') params.set('type',state.type);
    if(state.query) params.set('q',state.query);
    if(state.sort && state.sort!=='all') params.set('sort',state.sort);
    var requestKey=params.toString(),prefetch=state.offset===0&&window.__MP_STOREFRONT_PREFETCH__&&window.__MP_STOREFRONT_PREFETCH__.key===requestKey?window.__MP_STOREFRONT_PREFETCH__:null;
    var inventoryRequest=prefetch?prefetch.promise:fetch(API_BASE+'/api/inventory?'+requestKey);
    if(prefetch)window.__MP_STOREFRONT_PREFETCH__=null;
    inventoryRequest
      .then(function(response){ if(!response.ok) throw new Error('Inventory unavailable'); return response.json(); })
      .then(function(data){
        if(token!==state.token) return;
        controls.update(data.filterOptions);
        var items=(data&&data.items)||[];
        items.forEach(function(item,index){ grid.appendChild(itemCard(item,state.offset===0&&index===0)); });
        state.total=data.total==null?items.length:Number(data.total);
        state.offset=(Number(data.offset)||0)+items.length;
        state.hasMore=data.hasMore===true;
        if(state.offset || !state.total) grid.style.minHeight='0';
        status.textContent=state.total ? 'Showing '+state.offset+' of '+state.total : 'Nothing available in this section right now.';
        if(state.hasMore) grid.appendChild(sentinel);
        mount.setAttribute('data-wo-loaded','true');
      })
      .catch(function(){ if(token===state.token){ status.textContent='Could not load inventory right now.';mount.setAttribute('data-wo-loaded','true'); } })
      .finally(function(){ if(token===state.token) state.loading=false; });
  }

  var controls=buildLiveShopControls([],function(category,type,query,sort){
    clearTimeout(timer);
    state.token++;state.loading=true;
    timer=setTimeout(function(){
      state.category=category||'all';state.type=type||'all';state.query=query||'';state.sort=sort||'all';
      var url=new URL(location.href);
      ['cat','category','type','subcat','q','search','sort'].forEach(function(key){url.searchParams.delete(key);});
      if(state.category!=='all')url.searchParams.set('cat',state.category);
      if(state.type!=='all')url.searchParams.set('type',state.type);
      if(state.query)url.searchParams.set('q',state.query);
      if(state.sort!=='all')url.searchParams.set('sort',state.sort);
      history.replaceState(null,'',url);load(true);
    },220);
  });
  mount.appendChild(controls.el);
  mount.appendChild(grid);
  mount.appendChild(status);
  var observer=new IntersectionObserver(function(entries){if(entries.some(function(entry){return entry.isIntersecting;}))load(false);},{rootMargin:'600px 0px'});
  observer.observe(sentinel);
  initShopUrlFilter(controls);

  var deepLink=new URLSearchParams(location.search).get('item');
  if(deepLink){
    fetch(ACCOUNT_API_BASE+'/public/storefront/item?store_id='+encodeURIComponent(WO_STORE_ID)+'&id='+encodeURIComponent(deepLink))
      .then(function(response){return response.json();})
      .then(function(data){if(data&&data.item)openWoLiveItemDetail(data.item);})
      .catch(function(){});
  }
}

function joinFanClub(tier, amount, email, btn){
  if(btn){ btn.disabled = true; btn.dataset.origText = btn.textContent; btn.textContent = 'Redirecting...'; }
  fetch(API_BASE + '/api/membership/subscribe', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ tier: tier, amount: amount, email: email })
  }).then(function(r){ return r.json(); }).then(function(d){
    if(d.error){ alert(d.error); if(btn){ btn.disabled = false; btn.textContent = btn.dataset.origText; } return; }
    window.location.href = d.url;
  }).catch(function(){
    alert('Something went wrong starting checkout. Please try again.');
    if(btn){ btn.disabled = false; btn.textContent = btn.dataset.origText; }
  });
}
function makePledge(amount, email, btn){
  if(btn){ btn.disabled = true; btn.dataset.origText = btn.textContent; btn.textContent = 'Redirecting...'; }
  fetch(API_BASE + '/api/pledge/donate', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ amount: amount, email: email })
  }).then(function(r){ return r.json(); }).then(function(d){
    if(d.error){ alert(d.error); if(btn){ btn.disabled = false; btn.textContent = btn.dataset.origText; } return; }
    window.location.href = d.url;
  }).catch(function(){
    alert('Something went wrong starting checkout. Please try again.');
    if(btn){ btn.disabled = false; btn.textContent = btn.dataset.origText; }
  });
}

window.WO = window.WO || {};
window.WO.addToCart = addToCart;
window.WO.openCart = openCartDrawer;
window.WO.joinFanClub = joinFanClub;
window.WO.makePledge = makePledge;
window.WO.getCart = getCart;
window.WO.removeFromCart = removeFromCart;
// Exposed so the comic-preorder flow (preorders.js, loaded site-wide) can
// merge saved picks back in with an exact quantity and remove just-paid
// preorder lines after its own checkout -- addToCart only ever does "add
// one more", which can't restore an exact server-saved quantity or do a
// partial (preorder-lines-only) cart clear.
window.WO.setCart = setCart;
// Lets other cart-writing code (preorders.js, adding a comic preorder)
// trigger the exact same add-to-cart flourish instead of building its own,
// so a comic pull lands with the same 90s flair as a regular item.
window.WO.playAddToCartFlourish = playAddToCartFlourish;

// Account modal (email/password + a mandatory phone-verify gate before
// showing any account data) retired -- superseded by the /account,
// /account-orders, etc. pages (wo-scripts' account.js), which sign in the
// same way but never block on phone: email alone unlocks orders and comic
// preorders, and linking a phone for loyalty/trade-credit/in-store history
// is offered as an optional follow-up, not a gate. #wo-account-toggle below
// just navigates there now.

function findDataCarrier(btn){
  var node = btn.parentElement;
  for (var i = 0; i < 6 && node; i++){
    var found = node.querySelector('.wo-cart-data');
    if(found) return found;
    node = node.parentElement;
  }
  return null;
}
function readProductFromCarrier(dataEl){
  if(!dataEl) return null;
  var slugEl = dataEl.querySelector('.wo-d-slug');
  var nameEl = dataEl.querySelector('.wo-d-name');
  var priceEl = dataEl.querySelector('.wo-d-price');
  var imgEl = dataEl.querySelector('.wo-d-image');
  var qtyEl = dataEl.querySelector('.wo-d-qty');
  var priceText = priceEl ? priceEl.textContent.replace(/[^0-9.]/g,'') : '0';
  return {
    id: slugEl ? slugEl.textContent.trim() : '',
    name: nameEl ? nameEl.textContent.trim() : 'Item',
    price: parseFloat(priceText) || 0,
    image: imgEl ? (imgEl.currentSrc || imgEl.src || imgEl.getAttribute('src') || '') : '',
    // Only present on the live-inventory cards (wo-d-qty holds real Supabase
    // stock); falls back to 1 for other product cards on the site that
    // don't carry a stock count, preserving the old one-at-a-time behavior.
    available: qtyEl ? (parseInt(qtyEl.textContent, 10) || 1) : 1
  };
}
document.addEventListener('DOMContentLoaded', function(){
  var params = new URLSearchParams(window.location.search);
  if(params.get('joined') || params.get('pledged')){
    var banner = document.createElement('div');
    banner.style.cssText = 'max-width:600px;margin:24px auto;padding:16px 20px;background:#e8f7ee;border:1px solid #34a35a;border-radius:12px;text-align:center;font-weight:600;color:#1d6b34;';
    banner.textContent = params.get('joined') ? "You're in! Thanks for joining the Fan Club." : 'Thank you for your pledge — it means a lot.';
    document.body.insertBefore(banner, document.body.firstChild);
  }
  var toggle = document.getElementById('wo-cart-toggle');
  if(toggle){ toggle.addEventListener('click', function(e){ e.preventDefault(); openCartDrawer(); }); }
  var acctToggle = document.getElementById('wo-account-toggle');
  if(acctToggle){ acctToggle.addEventListener('click', function(e){
    e.preventDefault();
    var signedIn = false;
    try { signedIn = !!(JSON.parse(localStorage.getItem('mp-foc-session-v1') || 'null') || {}).access_token; } catch(_){}
    location.href = signedIn ? '/account' : '/login?next=' + encodeURIComponent('/account');
  }); }

  initProductBrowsing();
  initTeamTheme();
  renderLiveInventoryPaged();

  var allCards = [];
  Array.prototype.forEach.call(document.querySelectorAll('.wo-cart-data'), function(dataEl){
    var card = dataEl.closest('.product-card') || dataEl.parentElement;
    if(!card) return;
    var catEl = dataEl.querySelector('.wo-d-category');
    var nameEl = dataEl.querySelector('.wo-d-name');
    var priceEl = dataEl.querySelector('.wo-d-price');
    var cat = catEl ? catEl.textContent.trim().toLowerCase() : '';
    var name = nameEl ? nameEl.textContent.trim().toLowerCase() : '';
    var price = priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.]/g,'')) || 0 : 0;
    if(cat) card.setAttribute('data-category', cat);
    if(name) card.setAttribute('data-search-terms', name);
    card.setAttribute('data-price', price);
    allCards.push(card);
  });

  var filterBtns = document.querySelectorAll('[data-filter]');
  var searchInput = document.querySelector('[data-search-products]');
  var sortSelect = document.querySelector('[data-sort-products]');
  var grid = allCards.length ? allCards[0].parentElement : null;

  function applyFilters(){
    var activeBtn = document.querySelector('[data-filter].is-active');
    var filter = activeBtn ? activeBtn.getAttribute('data-filter') : 'all';
    var query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    allCards.forEach(function(card){
      var matchesFilter = filter === 'all' || card.getAttribute('data-category') === filter;
      var matchesSearch = !query || (card.getAttribute('data-search-terms') || '').indexOf(query) !== -1;
      card.style.display = (matchesFilter && matchesSearch) ? '' : 'none';
    });
  }

  Array.prototype.forEach.call(filterBtns, function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      Array.prototype.forEach.call(filterBtns, function(b){ b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      applyFilters();
    });
  });
  if(searchInput) searchInput.addEventListener('input', applyFilters);

  if(sortSelect && !sortSelect.options.length){
    [['featured','Featured'],['price-asc','Price: Low to High'],['price-desc','Price: High to Low'],['name-asc','Name: A to Z']].forEach(function(opt){
      var o = document.createElement('option'); o.value = opt[0]; o.textContent = opt[1]; sortSelect.appendChild(o);
    });
  }
  if(sortSelect){
    sortSelect.addEventListener('change', function(){
      if(!grid) return;
      var sorted = allCards.slice();
      var mode = sortSelect.value;
      if(mode === 'price-asc') sorted.sort(function(a,b){ return parseFloat(a.getAttribute('data-price')) - parseFloat(b.getAttribute('data-price')); });
      else if(mode === 'price-desc') sorted.sort(function(a,b){ return parseFloat(b.getAttribute('data-price')) - parseFloat(a.getAttribute('data-price')); });
      else if(mode === 'name-asc') sorted.sort(function(a,b){ return (a.getAttribute('data-search-terms')||'').localeCompare(b.getAttribute('data-search-terms')||''); });
      sorted.forEach(function(card){ grid.appendChild(card); });
    });
  }
  applyFilters();

  Array.prototype.forEach.call(document.querySelectorAll('[data-wo-add-to-cart]'), function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var product = readProductFromCarrier(findDataCarrier(btn));
      if(!product || !product.id){ console.warn('[WO] Could not find product data for this button.'); return; }
      addToCart(product, btn);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('.product-card'), function(card){
    var dataEl = card.querySelector('.wo-cart-data');
    if(!dataEl) return;
    var slugEl = dataEl.querySelector('.wo-d-slug');
    var slug = slugEl ? slugEl.textContent.trim() : '';
    if(!slug) return;
    card.style.cursor = 'pointer';
    card.addEventListener('click', function(e){
      if(e.target.closest('[data-wo-add-to-cart]')) return;
      window.location.href = '/product/' + slug;
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-wo-fanclub-tier]'), function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var tier = btn.getAttribute('data-wo-fanclub-tier');
      var amountEl = document.getElementById(tier + '-amount');
      var emailEl = document.getElementById(tier + '-email');
      joinFanClub(tier, amountEl ? amountEl.value : 0, emailEl ? emailEl.value : '', btn);
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-wo-pledge-preset]'), function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var amountEl = document.getElementById('pledge-amount');
      if(amountEl) amountEl.value = btn.getAttribute('data-wo-pledge-preset');
    });
  });

  var pledgeSubmit = document.querySelector('[data-wo-pledge-submit]');
  if(pledgeSubmit){
    pledgeSubmit.addEventListener('click', function(e){
      e.preventDefault();
      var amountEl = document.getElementById('pledge-amount');
      var emailEl = document.getElementById('pledge-email');
      makePledge(amountEl ? amountEl.value : 0, emailEl ? emailEl.value : '', pledgeSubmit);
    });
  }

  renderCartBadge();
});
})();
`;
}

function buildAdminPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Walk-Off Orders</title>
<style>
body{font-family:-apple-system,Segoe UI,sans-serif;margin:0;background:#f7f7f8;color:#1a1a1a;}
header{padding:16px 24px;background:#1a1a1a;color:#fff;display:flex;justify-content:space-between;align-items:center;}
.wrap{padding:20px;max-width:960px;margin:0 auto;}
input#tok{padding:8px;border-radius:6px;border:1px solid #ccc;width:260px;}
.order{background:#fff;border-radius:10px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
.order h3{margin:0 0 6px;font-size:15px;}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;}
.badge.pending_capture{background:#fff3cd;color:#926f00;}
.badge.captured,.badge.paid{background:#d4edda;color:#1d6b34;}
.badge.cancelled,.badge.refunded{background:#f8d7da;color:#a32030;}
.rfd{background:#a32030;color:#fff;}
.items{font-size:13px;color:#555;margin:8px 0;}
.ship{font-size:13px;color:#1a1a1a;font-weight:600;margin:4px 0;}
.ship.missing{color:#a32030;font-weight:600;}
button{padding:8px 14px;border-radius:6px;border:none;cursor:pointer;font-weight:600;margin-right:8px;}
.cap{background:#1a1a1a;color:#fff;}
.cxl{background:#eee;color:#a32030;}
</style></head><body>
<header><strong>Walk-Off Orders</strong><div><input id="tok" placeholder="Admin token"><button onclick="load()" class="cap">Load</button></div></header>
<div class="wrap" id="orders"></div>
<script>
function tok(){ return document.getElementById('tok').value || new URLSearchParams(location.search).get('token') || ''; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function load(){
  fetch('/api/admin/orders?token=' + encodeURIComponent(tok())).then(r=>r.json()).then(d=>{
    if(d.error){ document.getElementById('orders').innerHTML = '<p style="color:#a32030;">'+d.error+'</p>'; return; }
    document.getElementById('orders').innerHTML = (d.orders||[]).map(o => {
      var items = (o.items||[]).map(i => esc(i.name) + ' ($' + Number(i.price||0).toFixed(2) + ')').join(', ');
      var s = o.shipping || {};
      var addrParts = [s.address1, s.city, s.state, s.zip].filter(Boolean);
      var addrHtml = addrParts.length
        ? '<div class="ship">\\ud83d\\udce6 ' + esc(addrParts.join(', ')) + '</div>'
        : '<div class="ship missing">No shipping address on file</div>';
      return '<div class="order"><h3>'+esc(o.customer&&o.customer.name||'Unknown')+' <span class="badge '+o.status+'">'+o.status+'</span></h3>' +
        '<div>'+esc(o.customer&&o.customer.email||'')+' &middot; '+new Date(o.createdAt).toLocaleString()+'</div>' +
        addrHtml +
        '<div class="items">'+items+'</div>' +
        '<div><strong>Total: $'+Number(o.totals&&o.totals.grand||0).toFixed(2)+'</strong></div>' +
        (o.status==='pending_capture' ? '<div style="margin-top:10px;"><button class="cap" onclick="act(\\''+o.paymentIntentId+'\\',\\'capture\\')">Capture</button><button class="cxl" onclick="act(\\''+o.paymentIntentId+'\\',\\'cancel\\')">Cancel</button></div>' : '') +
        (o.status==='paid' ? '<div style="margin-top:10px;"><button class="rfd" onclick="if(confirm(\\'Refund this order?\\'))act(\\''+o.paymentIntentId+'\\',\\'refund\\')">Refund</button></div>' : '') +
        '</div>';
    }).join('') || '<p>No orders yet.</p>';
  });
}
function act(piId, action){
  fetch('/api/admin/'+action, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ paymentIntentId: piId, token: tok() }) })
    .then(r=>r.json()).then(()=>load());
}
if(new URLSearchParams(location.search).get('token')){ document.getElementById('tok').value = new URLSearchParams(location.search).get('token'); load(); }
</script>
</body></html>`;
}

// ----------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const ch = corsHeaders(origin);
    // Everything below is wrapped so that ANY unexpected exception still comes
    // back with proper CORS headers. Without this, a thrown error anywhere in
    // a handler produces Cloudflare's bare default error response (no CORS
    // headers at all), which the browser reports as a confusing "CORS policy"
    // failure that hides the real error. This turns that into a normal JSON
    // 500 with the actual message, on every response path, including OPTIONS.
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: ch });

      if (path === "/wo-cart.js") {
        const script = buildCartScript(env.STRIPE_PUBLISHABLE_KEY || "", url.origin, getShippingTiers(env), getInventoryApiBase(env), getStoreId(env));
        return new Response(script, { headers: Object.assign({ "Content-Type": "application/javascript; charset=utf-8" }, ch) });
      }
      if (path === "/api/cart/create-intent" && request.method === "POST") return await handleCreateIntent(request, env, origin);
      if (path === "/api/cart/release" && request.method === "POST") return await handleReleaseReservation(request, env, origin);
      if (path === "/api/order/confirm" && request.method === "POST") return await handleConfirmOrder(request, env, origin);
      if (path === "/api/admin/orders" && request.method === "GET") return await handleAdminOrders(request, env, origin);
      if (path === "/api/admin/capture" && request.method === "POST") return await handleAdminCapture(request, env, origin);
      if (path === "/api/admin/cancel" && request.method === "POST") return await handleAdminCancel(request, env, origin);
      if (path === "/api/admin/refund" && request.method === "POST") return await handleAdminRefund(request, env, origin);
      if (path === "/api/inventory" && request.method === "GET") return await handleInventoryList(request, env, origin);
      if (path === "/share/item" && request.method === "GET") return await handleItemShare(request, env);
      if (path === "/api/rundrop-stock" && request.method === "GET") return await handleRunDropStock(request, env, origin);
      if (path === "/api/debug-supabase" && request.method === "GET") return await handleDebugSupabase(request, env, origin);
      if (path === "/api/membership/subscribe" && request.method === "POST") return await handleMembershipSubscribe(request, env, origin);
      if (path === "/api/pledge/donate" && request.method === "POST") return await handlePledgeDonate(request, env, origin);
      if (path === "/admin") return new Response(buildAdminPage(), { headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, ch) });

      return json({ error: "Not found" }, 404, ch);
    } catch (e) {
      console.error("[WO] Unhandled worker exception:", e && e.stack || e);
      return json({ error: (e && e.message) || "Internal error" }, 500, ch);
    }
  }
};
