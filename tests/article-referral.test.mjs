import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import worker from '../worker.js';
// 2026-11-12: website orders from buyers who read one of Sean's articles on
// themanapocket.com in the 7 days before checkout carry that article.
const response = await worker.fetch(new Request('https://wo.test/wo-cart.js'), { STRIPE_PUBLISHABLE_KEY: 'pk_test', WO_RESERVATIONS: { get: async () => null }, WO_ORDERS: { get: async () => null } }, {});
const script = await response.text();
const store = new Map();
const context = { localStorage: { getItem: k => store.get(k) ?? null }, Date, JSON };
vm.createContext(context);
vm.runInContext(script.slice(script.indexOf('function articleRef('), script.indexOf('// Step 2: actually charge the card')), context);
assert.equal(context.articleRef(), '', 'no article read');
store.set('mp_article_ref', JSON.stringify({ s: 'spider-woman-1-the-return-of-cletus', at: Date.now() - 2 * 864e5 }));
assert.equal(context.articleRef(), 'article:spider-woman-1-the-return-of-cletus');
store.set('mp_article_ref', JSON.stringify({ s: 'old-one', at: Date.now() - 8 * 864e5 }));
assert.equal(context.articleRef(), '', 'older than 7 days');
store.set('mp_article_ref', JSON.stringify({ s: 'bad"slug', at: Date.now() }));
assert.equal(context.articleRef(), '');
store.set('mp_article_ref', '{nope');
assert.equal(context.articleRef(), '');
assert.ok(script.includes('ref: articleRef()'), 'the order carries it');
const src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
assert.ok(src.includes("referral: String(body.ref)") && src.includes("/^article:[a-z0-9-]{3,120}$/.test(String(body.ref || ''))"), 'passed on to the dashboard, only that shape');
console.log('Article referral: remembered 7 days, sent with the order, passed to the dashboard');
