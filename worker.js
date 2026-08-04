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
// ============================================================================

var ALLOWED_ORIGINS = [
  "https://www.walkoffsc.com",
  "https://walkoffsc.com",
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
var INVENTORY_CACHE_TTL_SECONDS = 45; // short cache so stock feels live but we're not hammering the API

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

function cartTotals(items, tiers) {
  let subtotal = 0;
  let shipping = 0;
  let qtyTotal = 0;
  (items || []).forEach((it) => {
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const price = Number(it.price) || 0;
    subtotal += price * qty;
    shipping += shippingForPrice(price, tiers, it.id) * qty;
    qtyTotal += qty;
  });
  const grand = Math.round((subtotal + shipping) * 100) / 100;
  return { subtotal: round2(subtotal), shipping: round2(shipping), grand, qtyTotal };
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
  const totals = cartTotals(items, tiers);
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
      source: "walkoffsc-checkout"
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
    totals
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
  const cacheKey = "inventory:" + storeId;

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
    const result = await fetchInventoryApi(env, "/public/storefront?store_id=" + encodeURIComponent(storeId));
    if (!result.ok || !result.data || !result.data.ok) {
      const message = (result.data && result.data.error) || "Storefront is not published";
      return json({ ok: false, error: message }, result.status || 502, corsHeaders(origin));
    }
    var items = result.data.items || [];

    var payload = JSON.stringify({ ok: true, items: items });
    try { await env.WO_RESERVATIONS.put(cacheKey, payload, { expirationTtl: INVENTORY_CACHE_TTL_SECONDS }); } catch (e) {}
    return new Response(payload, { headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(origin)) });
  } catch (e) {
    return json({ ok: false, error: "Could not load inventory: " + e.message }, 502, corsHeaders(origin));
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
function buildCartScript(stripePk, workerOrigin, tiers) {
  return `
(function(){
var STRIPE_PK = ${JSON.stringify(stripePk)};
var API_BASE = ${JSON.stringify(workerOrigin)};
var SHIP_TIERS = ${JSON.stringify(tiers)};
var CART_KEY = 'wo_cart_v1';

function getCart(){ try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch(e){ return []; } }
function setCart(c){ localStorage.setItem(CART_KEY, JSON.stringify(c)); renderCartBadge(); }
function addToCart(item){
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
  openCartDrawer();
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

var WO_CLOSE_BTN_CSS = 'background:none;border:none;font-size:26px;line-height:1;width:40px;height:40px;min-width:40px;border-radius:50%;cursor:pointer;color:#1a1a1a;display:flex;align-items:center;justify-content:center;transition:background .15s ease;';

function ensureDrawer(){
  if(document.getElementById('wo-cart-drawer')) return;
  var bd = document.createElement('div');
  bd.id = 'wo-cart-backdrop';
  bd.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0);z-index:99998;display:none;transition:background .25s ease;';
  document.body.appendChild(bd);
  bd.onclick = closeCartDrawer;

  var d = document.createElement('div');
  d.id = 'wo-cart-drawer';
  d.style.cssText = 'position:fixed;top:0;right:-420px;width:400px;max-width:92vw;height:100%;background:#fff;box-shadow:-8px 0 32px rgba(0,0,0,.22);z-index:99999;transition:right .28s ease;display:flex;flex-direction:column;font-family:inherit;';
  d.innerHTML = '<div style="padding:20px 16px 20px 24px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">' +
      '<strong style="font-size:20px;">Your Cart</strong>' +
      '<button id="wo-cart-close" aria-label="Close cart" style="'+WO_CLOSE_BTN_CSS+'">&times;</button>' +
    '</div>' +
    '<div id="wo-cart-items" style="flex:1;overflow-y:auto;padding:16px 24px;"></div>' +
    '<div style="padding:20px 24px;border-top:1px solid #eee;background:#fafafa;">' +
    '<div id="wo-cart-totals" style="font-size:15px;color:#444;margin-bottom:14px;"></div>' +
    '<button id="wo-cart-checkout" style="width:100%;padding:15px;background:#1a1a1a;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:background .15s ease;">Checkout</button>' +
    '</div>';
  document.body.appendChild(d);
  document.getElementById('wo-cart-close').onmouseenter = function(){ this.style.background = 'rgba(0,0,0,.06)'; };
  document.getElementById('wo-cart-close').onmouseleave = function(){ this.style.background = 'none'; };
  document.getElementById('wo-cart-close').onclick = closeCartDrawer;
  document.getElementById('wo-cart-checkout').onclick = openCheckoutModal;
  document.getElementById('wo-cart-checkout').onmouseenter = function(){ this.style.background = '#4a2f7a'; };
  document.getElementById('wo-cart-checkout').onmouseleave = function(){ this.style.background = '#1a1a1a'; };
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
  var shipping = cart.reduce(function(s,i){ var qty = Math.max(1, parseInt(i.qty,10)||1); return s + shippingForPrice(i.price, i.id) * qty; }, 0);
  return { subtotal: subtotal, shipping: shipping, grand: subtotal + shipping };
}

function renderDrawerItems(){
  var cart = getCart();
  var wrap = document.getElementById('wo-cart-items');
  if(!wrap) return;
  if(!cart.length){
    wrap.innerHTML = '<div style="text-align:center;padding:48px 12px;color:#999;"><div style="font-size:40px;margin-bottom:10px;">\\ud83d\\uded2</div><p style="font-size:15px;">Your cart is empty.</p></div>';
  } else {
    wrap.innerHTML = cart.map(function(i){
      var qty = Math.max(1, parseInt(i.qty,10)||1);
      var available = Math.max(1, parseInt(i.available,10)||1);
      var lineTotal = (Number(i.price)||0) * qty;
      return '<div style="display:flex;gap:14px;margin-bottom:18px;align-items:center;padding-bottom:18px;border-bottom:1px solid #f0f0f0;">' +
        (i.image ? '<img src="'+i.image+'" style="width:84px;height:84px;object-fit:cover;border-radius:10px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.08);">' : '') +
        '<div style="flex:1;min-width:0;"><div style="font-size:16px;font-weight:700;color:#1a1a1a;line-height:1.3;margin-bottom:4px;">'+(i.name||'Item')+'</div>' +
        '<div style="font-size:15px;color:#555;font-weight:600;margin-bottom:8px;">$'+(Number(i.price)||0).toFixed(2)+(qty>1?' \\u00d7 '+qty+' = $'+lineTotal.toFixed(2):'')+'</div>' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<button data-qty-id="'+i.id+'" data-qty-delta="-1" aria-label="Decrease quantity" style="width:28px;height:28px;border:1px solid #ddd;border-radius:6px;background:#fff;font-size:16px;font-weight:800;cursor:pointer;line-height:1;padding:0;">\\u2212</button>' +
          '<span style="min-width:18px;text-align:center;font-size:13px;font-weight:700;">'+qty+'</span>' +
          '<button data-qty-id="'+i.id+'" data-qty-delta="1" aria-label="Increase quantity" style="width:28px;height:28px;border:1px solid #ddd;border-radius:6px;background:#fff;font-size:16px;font-weight:800;cursor:pointer;line-height:1;padding:0;"'+(qty>=available?' disabled':'')+'>+</button>' +
        '</div></div>' +
        '<button data-id="'+i.id+'" class="wo-remove-item" aria-label="Remove item" style="background:none;border:1px solid #eee;color:#a32030;cursor:pointer;font-size:13px;font-weight:700;padding:8px 12px;border-radius:8px;flex-shrink:0;transition:background .15s ease;">Remove</button></div>';
    }).join('');
    Array.prototype.forEach.call(wrap.querySelectorAll('.wo-remove-item'), function(btn){
      btn.onclick = function(){ removeFromCart(btn.getAttribute('data-id')); };
      btn.onmouseenter = function(){ this.style.background = '#fdf0f0'; };
      btn.onmouseleave = function(){ this.style.background = 'none'; };
    });
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-qty-delta]'), function(btn){
      btn.onclick = function(){ changeCartQty(btn.getAttribute('data-qty-id'), parseInt(btn.getAttribute('data-qty-delta'),10)); };
    });
  }
  var totals = computeTotals(cart);
  var totalsEl = document.getElementById('wo-cart-totals');
  if(totalsEl) totalsEl.innerHTML =
    '<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span>Subtotal</span><span>$'+totals.subtotal.toFixed(2)+'</span></div>' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:10px;color:#777;"><span>Shipping</span><span>$'+totals.shipping.toFixed(2)+'</span></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:18px;font-weight:800;color:#1a1a1a;padding-top:10px;border-top:1px solid #e5e5e5;"><span>Total</span><span>$'+totals.grand.toFixed(2)+'</span></div>';
  renderCartBadge();
}

var _stripe=null,_elements=null,_pe=null,_cs=null,_reservationId=null,_piId=null;

var WO_INPUT_CSS = 'width:100%;box-sizing:border-box;padding:13px 14px;margin-bottom:10px;border:1.5px solid #ddd;border-radius:9px;font-size:15px;color:#1a1a1a;background:#fafafa;outline:none;transition:border-color .15s ease,background .15s ease;';

function ensureModal(){
  if(document.getElementById('wo-checkout-backdrop')) return;
  var m = document.createElement('div');
  // NOTE: the outer full-screen layer is id="wo-checkout-backdrop", NOT
  // "wo-checkout-modal" — a site-wide CSS rule force-styles #wo-checkout-modal
  // as a white, opaque panel (background:#fff !important), which used to sit
  // on this exact outer element and silently kill the dark dim-behind-modal
  // effect. That id now belongs to the actual inner white panel below, where
  // that rule is correct.
  m.id = 'wo-checkout-backdrop';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0);z-index:100000;display:none;align-items:center;justify-content:center;transition:background .2s ease;';
  m.innerHTML = '<div id="wo-checkout-modal" style="background:#fff;border-radius:16px;max-width:440px;width:92vw;max-height:88vh;overflow-y:auto;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.3);">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;"><strong style="font-size:20px;">Checkout</strong><button id="wo-co-close" aria-label="Close checkout" style="'+WO_CLOSE_BTN_CSS+'">&times;</button></div>' +
    '<div id="wo-co-form">' +
      '<input id="wo-co-name" placeholder="Full name" autocomplete="name" style="'+WO_INPUT_CSS+'">' +
      '<input id="wo-co-email" type="email" placeholder="Email" autocomplete="email" style="'+WO_INPUT_CSS+'">' +
      '<div style="font-size:12px;color:#999;margin:2px 0 8px;">Ships within the U.S. only.</div>' +
      '<input id="wo-co-addr1" placeholder="Address" autocomplete="address-line1" style="'+WO_INPUT_CSS+'">' +
      '<div style="display:flex;gap:8px;">' +
        '<input id="wo-co-city" placeholder="City" autocomplete="address-level2" style="'+WO_INPUT_CSS+'flex:2;">' +
        '<input id="wo-co-state" placeholder="State" autocomplete="address-level1" maxlength="2" style="'+WO_INPUT_CSS+'flex:1;text-transform:uppercase;">' +
        '<input id="wo-co-zip" placeholder="ZIP" autocomplete="postal-code" inputmode="numeric" style="'+WO_INPUT_CSS+'flex:1;">' +
      '</div>' +
      '<div id="wo-co-payment-element" style="margin:16px 0;"></div>' +
      '<div id="wo-co-err" style="color:#c00;font-size:13px;margin-bottom:10px;"></div>' +
      '<button id="wo-co-pay" style="width:100%;padding:15px;background:#1a1a1a;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:background .15s ease;">Place Order</button>' +
      '<div style="text-align:center;font-size:12px;color:#999;margin-top:10px;">Secured by Stripe \\u2014 your card is charged immediately and your order goes straight into the fulfillment queue.</div>' +
    '</div>' +
    '<div id="wo-co-success" style="display:none;text-align:center;padding:24px 0;">' +
      '<div style="font-size:44px;margin-bottom:12px;">\\u2705</div>' +
      '<h3 style="font-size:20px;margin:0 0 8px;">Order confirmed!</h3>' +
      '<p style="color:#666;font-size:14px;line-height:1.5;">Your payment went through and your order is ready to be fulfilled. A confirmation email is on its way.</p>' +
    '</div>' +
  '</div>';
  document.body.appendChild(m);
  m.onclick = function(e){ if(e.target === m) closeCheckoutModal(); };
  document.getElementById('wo-checkout-modal').onclick = function(e){ e.stopPropagation(); };
  document.getElementById('wo-co-close').onmouseenter = function(){ this.style.background = 'rgba(0,0,0,.06)'; };
  document.getElementById('wo-co-close').onmouseleave = function(){ this.style.background = 'none'; };
  document.getElementById('wo-co-close').onclick = closeCheckoutModal;
  document.getElementById('wo-co-pay').onmouseenter = function(){ this.style.background = '#4a2f7a'; };
  document.getElementById('wo-co-pay').onmouseleave = function(){ this.style.background = '#1a1a1a'; };
  document.getElementById('wo-co-pay').onclick = submitCheckout;
  Array.prototype.forEach.call(m.querySelectorAll('#wo-co-form input'), function(inp){
    // setProperty(...,'important') because a site-wide rule force-sets
    // #wo-checkout-modal input { border:1px solid #ccc !important }, which
    // would otherwise silently swallow this focus highlight.
    inp.onfocus = function(){ this.style.setProperty('border-color', '#1a1a1a', 'important'); this.style.setProperty('background', '#fff', 'important'); };
    inp.onblur = function(){ this.style.setProperty('border-color', '#ddd', 'important'); this.style.setProperty('background', '#fafafa', 'important'); };
  });
}

function showErr(msg){ var e=document.getElementById('wo-co-err'); if(e) e.textContent = msg || ''; }

function openCheckoutModal(){
  var cart = getCart();
  if(!cart.length) return;
  ensureModal();
  var m = document.getElementById('wo-checkout-backdrop');
  m.style.display = 'flex';
  requestAnimationFrame(function(){ m.style.background = 'rgba(0,0,0,.5)'; });
  showErr('');
  initIntent(cart);
}

function closeCheckoutModal(){
  var m = document.getElementById('wo-checkout-backdrop');
  if(!m) return;
  m.style.background = 'rgba(0,0,0,0)';
  setTimeout(function(){ m.style.display = 'none'; }, 200);
}

function initIntent(cart){
  var email = document.getElementById('wo-co-email').value || '';
  fetch(API_BASE + '/api/cart/create-intent', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ items: cart, email: email })
  }).then(function(r){ return r.json(); }).then(function(d){
    if(d.error){ showErr(d.error); return; }
    _cs = d.clientSecret; _piId = d.paymentIntentId; _reservationId = d.reservationId;
    mountStripe();
  }).catch(function(){ showErr('Could not start checkout. Try again.'); });
}

function mountStripe(){
  if(window.Stripe){ doMount(); }
  else { var sc=document.createElement('script'); sc.src='https://js.stripe.com/v3/'; sc.onload=doMount; document.head.appendChild(sc); }
}
function doMount(){
  if(!_stripe) _stripe = Stripe(STRIPE_PK);
  _elements = _stripe.elements({ clientSecret: _cs, appearance: { theme: 'stripe', variables: { colorPrimary: '#1a1a1a', borderRadius: '8px' } } });
  _pe = _elements.create('payment', {
    fields: { billingDetails: { name: 'never', email: 'never', address: 'never' } }
  });
  _pe.mount('#wo-co-payment-element');
}

function validateCheckoutFields(name, email, addr1, city, state, zip){
  if(!name || name.trim().length < 2 || !/[a-zA-Z]/.test(name)){
    return 'Please enter your full name.';
  }
  if(!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(email)){
    return 'Please enter a valid email address.';
  }
  if(!addr1 || addr1.trim().length < 4 || !/\\d/.test(addr1)){
    return 'Please enter a valid street address (with a number).';
  }
  if(!city || city.trim().length < 2 || !/[a-zA-Z]/.test(city)){
    return 'Please enter a valid city.';
  }
  if(!state || !/^[a-zA-Z]{2}$/.test(state.trim())){
    return 'Please enter your 2-letter state (e.g. WA).';
  }
  var zipDigits = (zip || '').replace(/\\D/g, '');
  if(zipDigits.length !== 5 && zipDigits.length !== 9){
    return 'Please enter a valid 5-digit ZIP code.';
  }
  return null;
}

function submitCheckout(){
  if(!_stripe || !_elements){ showErr('Payment form still loading, one sec.'); return; }
  var name = (document.getElementById('wo-co-name').value || '').trim();
  var email = (document.getElementById('wo-co-email').value || '').trim();
  var addr1 = (document.getElementById('wo-co-addr1').value || '').trim();
  var city = (document.getElementById('wo-co-city').value || '').trim();
  var state = (document.getElementById('wo-co-state').value || '').trim().toUpperCase();
  var zipRaw = (document.getElementById('wo-co-zip').value || '').trim();
  var fieldErr = validateCheckoutFields(name, email, addr1, city, state, zipRaw);
  if(fieldErr){ showErr(fieldErr); return; }
  var zipDigits = zipRaw.replace(/\\D/g, '');
  var zip = zipDigits.length === 9 ? zipDigits.slice(0,5) + '-' + zipDigits.slice(5) : zipDigits;
  showErr('');
  _stripe.confirmPayment({
    elements: _elements, redirect: 'if_required',
    confirmParams: { payment_method_data: { billing_details: { name: name, email: email, address: { line1: addr1, city: city, state: state, postal_code: zip, country: 'US' } } } }
  }).then(function(res){
    if(res.error){ showErr(res.error.message); return; }
    var cart = getCart();
    var totals = computeTotals(cart);
    return fetch(API_BASE + '/api/order/confirm', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        paymentIntentId: _piId,
        items: cart, totals: totals,
        customer: { name: name, email: email },
        shipping: { address1: addr1, city: city, state: state, zip: zip }
      })
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(data){
        // The card was already charged by confirmPayment() above — never tell
        // the customer this step "failed" (that risks a confused retry and a
        // duplicate charge). Always show success; if saving the order details
        // failed, surface it loudly for us instead so it can be fixed by hand.
        setCart([]);
        document.getElementById('wo-co-form').style.display = 'none';
        var successEl = document.getElementById('wo-co-success');
        if(successEl) successEl.style.display = 'block';
        if(!r.ok || data.error){
          console.error('[Dougvana] order/confirm failed after a successful charge', _piId, data && data.error);
          if(successEl){
            var note = document.createElement('p');
            note.style.cssText = 'color:#c00;font-size:12px;margin-top:8px;';
            note.textContent = 'Your payment went through, but we hit a snag saving your order. Please email us your payment reference: ' + _piId;
            successEl.appendChild(note);
          }
        }
      });
    });
  }).catch(function(err){ showErr((err && err.message) ? err.message : 'Something went wrong. Please try again.'); });
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
  nav.innerHTML = '<button id="wo-prev-btn" style="background:none;border:1px solid #ccc;border-radius:8px;padding:8px 14px;cursor:pointer;" disabled>&#8592; Previous</button>' +
    '<span id="wo-nav-position" style="color:#888;font-size:12px;"></span>' +
    '<button id="wo-next-btn" style="background:none;border:1px solid #ccc;border-radius:8px;padding:8px 14px;cursor:pointer;" disabled>Next &#8594;</button>';
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

function initShopUrlFilter(){
  var params = new URLSearchParams(window.location.search);
  var cat = params.get('cat');
  if(!cat) return;
  var target = cat.replace(/-/g,' ');
  var btn = document.querySelector('[data-filter="'+target+'"]');
  if(btn) btn.click();
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
  var html = '<div style="margin-top:16px;padding-top:16px;border-top:1px solid #eee;">';
  html += '<div style="font-weight:700;font-size:13px;margin-bottom:8px;">Book Details, Story &amp; Creators</div>';
  if(stats.length){
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;margin-bottom:10px;">';
    stats.forEach(function(pair){
      html += '<div style="background:#f5f7fa;border-radius:6px;padding:6px 8px;"><div style="font-size:8px;color:#888;text-transform:uppercase;">'+escapeHtml(pair[0])+'</div><div style="font-size:12px;font-weight:600;">'+escapeHtml(String(pair[1]))+'</div></div>';
    });
    html += '</div>';
  }
  if(c.description) html += '<div style="font-size:12px;line-height:1.6;margin-bottom:10px;">'+escapeHtml(c.description)+'</div>';
  if((c.writers||[]).length) html += '<div style="font-size:12px;margin-bottom:2px;"><b>Writer:</b> '+escapeHtml(c.writers.join(', '))+'</div>';
  if((c.artists||[]).length) html += '<div style="font-size:12px;margin-bottom:2px;"><b>Artist:</b> '+escapeHtml(c.artists.join(', '))+'</div>';
  if((c.coverArtists||[]).length) html += '<div style="font-size:12px;margin-bottom:2px;"><b>Cover artist:</b> '+escapeHtml(c.coverArtists.join(', '))+'</div>';
  if(credits) html += '<div style="font-size:11px;color:#888;margin-top:6px;">'+escapeHtml(credits)+'</div>';
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
  var card = document.createElement('div');
  card.style.cssText = 'width:100%;max-width:520px;background:#fff;border-radius:14px;padding:20px;position:relative;';
  card.innerHTML =
    '<button data-wo-close-detail aria-label="Close" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1;">&times;</button>' +
    (item.image ? '<img src="'+escapeHtml(item.image)+'" alt="'+escapeHtml(item.name)+'" style="width:100%;max-height:340px;object-fit:contain;border-radius:8px;background:#f2f2f2;">' : '') +
    '<div style="font-size:11px;color:#888;text-transform:uppercase;margin-top:14px;">'+escapeHtml(item.category||'')+'</div>' +
    '<div style="font-size:20px;font-weight:800;margin-top:4px;">'+escapeHtml(item.name)+'</div>' +
    (metaLine ? '<div style="font-size:12px;color:#888;margin-top:4px;">'+escapeHtml(metaLine)+'</div>' : '') +
    (item.isSigned ? '<div style="display:inline-block;margin-top:8px;padding:3px 8px;border-radius:6px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;">\\u270D Signed'+(item.signedBy ? ' by '+escapeHtml(item.signedBy) : '')+'</div>' : '') +
    '<div style="font-size:22px;font-weight:800;margin-top:10px;">$'+Number(item.price||0).toFixed(2)+'</div>' +
    (stockQty > 0 && stockQty <= 3 ? '<div style="font-size:11px;color:#a32030;font-weight:700;">Only '+stockQty+' left</div>' : '') +
    '<button data-wo-add-to-cart style="margin-top:14px;width:100%;padding:12px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">Add to Cart</button>' +
    woComicDetailHtml(item.comic);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  card.querySelector('[data-wo-close-detail]').addEventListener('click', function(){ overlay.remove(); });
  card.querySelector('[data-wo-add-to-cart]').addEventListener('click', function(e){
    e.preventDefault();
    addToCart({ id:item.id, name:item.name, price:Number(item.price||0), image:item.image||'', available: stockQty || 1 });
    overlay.remove();
  });
}

function renderLiveInventory(){
  var mount = document.getElementById('wo-live-shop');
  if(!mount) return;
  mount.innerHTML = '<div style="padding:24px;text-align:center;color:#888;">Loading inventory\\u2026</div>';

  fetch(API_BASE + '/api/inventory')
    .then(function(r){ return r.json(); })
    .then(function(d){
      var items = (d && d.items) || [];
      if(!items.length){
        mount.innerHTML = '<div style="padding:24px;text-align:center;color:#888;">Nothing available right now \\u2014 check back soon.</div>';
        return;
      }
      mount.innerHTML = '';
      var grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;';
      items.forEach(function(item){
        var card = document.createElement('div');
        card.className = 'wo-live-card';
        card.style.cssText = 'border:1px solid #eee;border-radius:12px;overflow:hidden;background:#fff;display:flex;flex-direction:column;cursor:pointer;';
        var imgHtml = item.image ? '<img src="'+escapeHtml(item.image)+'" alt="'+escapeHtml(item.name)+'" style="width:100%;aspect-ratio:1/1;object-fit:cover;">' : '<div style="width:100%;aspect-ratio:1/1;background:#f2f2f2;"></div>';
        var stockQty = Math.max(0, parseInt(item.quantity, 10) || 0);
        var stockLine = stockQty > 0
          ? ('<div style="font-size:11px;color:' + (stockQty <= 3 ? '#a32030' : '#888') + ';font-weight:' + (stockQty <= 3 ? '700' : '400') + ';">' + (stockQty <= 3 ? 'Only ' + stockQty + ' left' : stockQty + ' in stock') + '</div>')
          : '';
        // The public-storefront payload carries set/year/variant/condition
        // as separate fields (not a pre-joined display string), so build
        // the meta line here the same way the detail modal does.
        var metaLine = [item.set, item.year, item.variant, item.condition].filter(Boolean).join(' \\u00b7 ');
        var signedBadge = item.isSigned ? '<div style="font-size:10px;font-weight:700;color:#92400e;">\\u270D Signed'+(item.signedBy ? ' by '+escapeHtml(item.signedBy) : '')+'</div>' : '';
        card.innerHTML = imgHtml +
          '<div style="padding:12px;display:flex;flex-direction:column;gap:6px;flex:1;">' +
          '<div style="font-size:14px;font-weight:600;">'+escapeHtml(item.name)+'</div>' +
          (metaLine ? '<div style="font-size:12px;color:#888;">'+escapeHtml(metaLine)+'</div>' : '') +
          signedBadge +
          stockLine +
          '<div style="font-size:15px;font-weight:700;margin-top:auto;">$'+Number(item.price||0).toFixed(2)+'</div>' +
          '<button data-wo-add-to-cart style="padding:10px;background:#1a1a1a;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;">Add to Cart</button>' +
          '<div class="wo-cart-data" style="display:none;">' +
          '<span class="wo-d-slug">'+escapeHtml(item.id)+'</span>' +
          '<span class="wo-d-name">'+escapeHtml(item.name)+'</span>' +
          '<span class="wo-d-price">'+Number(item.price||0).toFixed(2)+'</span>' +
          '<img class="wo-d-image" src="'+escapeHtml(item.image||'')+'">' +
          '<span class="wo-d-category">'+escapeHtml(item.category||'')+'</span>' +
          '<span class="wo-d-qty">'+(stockQty || 1)+'</span>' +
          '</div></div>';
        card.addEventListener('click', function(e){
          if(e.target.closest('[data-wo-add-to-cart]')) return;
          openWoLiveItemDetail(item);
        });
        grid.appendChild(card);
      });
      mount.appendChild(grid);

      // Wire up the freshly-created Add to Cart buttons
      Array.prototype.forEach.call(mount.querySelectorAll('[data-wo-add-to-cart]'), function(btn){
        btn.addEventListener('click', function(e){
          e.preventDefault();
          var product = readProductFromCarrier(findDataCarrier(btn));
          if(!product || !product.id) return;
          addToCart(product);
        });
      });
    })
    .catch(function(){
      mount.innerHTML = '<div style="padding:24px;text-align:center;color:#c00;">Could not load inventory right now.</div>';
    });
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

  initProductBrowsing();
  initTeamTheme();
  renderLiveInventory();

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
  initShopUrlFilter();

  Array.prototype.forEach.call(document.querySelectorAll('[data-wo-add-to-cart]'), function(btn){
    btn.addEventListener('click', function(e){
      e.preventDefault();
      var product = readProductFromCarrier(findDataCarrier(btn));
      if(!product || !product.id){ console.warn('[WO] Could not find product data for this button.'); return; }
      addToCart(product);
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
        const script = buildCartScript(env.STRIPE_PUBLISHABLE_KEY || "", url.origin, getShippingTiers(env));
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
