import assert from 'node:assert/strict';
import worker from '../worker.js';

let requestedUrl = '';
const inventory = {
  ok: true,
  items: [{ id:'item-1', name:'Test Comic', categorySlug:'comics', productTypeSlug:'in-stock', quantity:1, price:4.99 }],
  total: 77,
  offset: 36,
  limit: 36,
  hasMore: true,
  nextOffset: 72,
  facets: ['comics'],
};
const env = {
  STRIPE_PUBLISHABLE_KEY: 'pk_test',
  WO_RESERVATIONS: { get:async()=>null, put:async()=>{} },
  WO_ORDERS: { get:async()=>null, put:async()=>{} },
  INVENTORY_API: {
    fetch: async url => {
      requestedUrl = String(url);
      return Response.json(inventory);
    },
  },
};

const response = await worker.fetch(new Request('https://wo.test/api/inventory?limit=36&offset=36&category=comics&type=in-stock&q=x-force', { headers:{ origin:'https://themanapocket.com' } }), env, {});
assert.equal(response.status, 200);
assert.match(requestedUrl, /limit=36/);
assert.match(requestedUrl, /offset=36/);
assert.match(requestedUrl, /category=comics/);
assert.match(requestedUrl, /type=in-stock/);
assert.match(requestedUrl, /q=x-force/);
const payload = await response.json();
assert.equal(payload.items.length, 1);
assert.equal(payload.total, 77);
assert.equal(payload.hasMore, true);
assert.equal(payload.nextOffset, 72);

const scriptResponse = await worker.fetch(new Request('https://wo.test/wo-cart.js', { headers:{ origin:'https://themanapocket.com' } }), env, {});
const script = await scriptResponse.text();
assert.doesNotThrow(() => new Function(script), 'served cart script must parse');
assert.match(script, /function renderLiveInventoryPaged/);
assert.match(script, /new IntersectionObserver/);
assert.match(script, /max-width: 767px/);
assert.match(script, /\? 12 : 36/);
assert.match(script, /limit:String\(pageSize\)/);
assert.match(script, /data-wo-loaded/);
assert.match(script, /prioritizeImage\?'eager':'lazy'/);
assert.match(script, /prioritizeImage\?' fetchpriority="high"'/);
assert.match(script, /state\.offset===0&&index===0/);
assert.match(script, /window\.__MP_STOREFRONT_PREFETCH__/,'the renderer must reuse the earlier site-bundle first-page request');
assert.match(script, /data-wo-share-item/);
assert.match(script, /\/share\/item\?id=/);
assert.match(script, /Disney Lorcana/);
assert.match(script, /Yu-Gi-Oh!/);
assert.match(script, /value:'preorders',label:'Comic preorders'/,'Comic inventory must expose a dedicated preorder product-type filter');
assert.match(script, /productTypeOptions\(options\.types,select\.value\)/,'database filter refreshes must preserve the preorder choice');
assert.match(script, /controls\.productTypeOptions\(\[\],cat\)/,'a comic preorder URL must restore its product-type filter on first load');
assert.match(script, /wo-store-controls-toggle/,'mobile controls must expose a compact filter toggle');
assert.match(script, /aria-expanded/,'the compact filter toggle must announce its state');
assert.match(script, /wo-store-controls\.is-collapsed \.wo-store-controls-fields/,'mobile filter fields must fade and collapse without removing their values');
assert.match(script, /if\(delta>0&&y>120\)setCollapsed\(true\)/,'scrolling down on mobile must collapse the full filter panel');
assert.match(script, /else if\(delta<0\)setCollapsed\(false\)/,'scrolling up on mobile must restore the full filter panel');
assert.match(script, /fields\.contains\(document\.activeElement\)/,'focused filter fields must never auto-collapse');

console.log('Paged storefront, canonical filters, lazy images, and sharing contracts passed.');
