import assert from 'node:assert/strict';
import worker from '../worker.js';

// Store report (mobile): the cart drawer, checkout modal, and item-detail
// modal all left the page scrolling in the background behind the modal, and
// the phone's back button/gesture navigated away from the shop entirely
// instead of just closing whatever modal was open.
//
// Fix: a shared iOS-safe body-scroll lock (position:fixed + restore
// scrollY, not just overflow:hidden, which iOS Safari can still scroll
// past) and a shared history-stack so every close -- the X button, tapping
// outside, Escape, or a successful "Add to Cart" -- goes through one path
// (woRequestModalClose -> history.back() -> the popstate handler, which is
// the ONLY place that actually performs the close) instead of the DOM
// removal and the browser history drifting out of sync with each other.

const env = {
  STRIPE_PUBLISHABLE_KEY: 'pk_test',
  WO_RESERVATIONS: { get: async () => null, put: async () => {} },
  WO_ORDERS: { get: async () => null, put: async () => {} },
};
const response = await worker.fetch(new Request('https://wo.test/wo-cart.js', { headers: { origin: 'https://themanapocket.com' } }), env, {});
const script = await response.text();
assert.doesNotThrow(() => new Function(script), 'served cart script must parse');

// The shared utility itself.
assert.match(script, /function woLockBodyScroll\(\)/, 'a shared body-scroll lock must exist');
assert.match(script, /function woUnlockBodyScroll\(\)/, 'a shared body-scroll unlock must exist');
assert.match(script, /document\.body\.style\.position = 'fixed'/, 'the lock must use position:fixed, not just overflow:hidden, which iOS Safari can scroll past underneath');
assert.match(script, /window\.scrollTo\(0, _woScrollLockY\)/, 'unlocking must restore the exact scroll position the page was at before it was locked');
assert.match(script, /_woScrollLockCount/, 'the lock must be counted, not a plain boolean, so one modal opening while another is already open (checkout from the cart drawer) does not unlock the page early when only the inner one closes');

assert.match(script, /var _woModalStack = \[\];/, 'a shared modal history stack must exist');
assert.match(script, /window\.addEventListener\('popstate', function\(\)\{[\s\S]*?_woModalStack\.pop\(\)/, 'the popstate handler must be the thing that actually pops the modal stack');
assert.match(script, /function woPushModal\(onClose\)\{[\s\S]{0,200}history\.pushState/, 'opening a modal must push a real history entry, or the phone back button has nothing to catch');
assert.match(script, /function woRequestModalClose\(\)\{[\s\S]{0,80}history\.back\(\)/, 'requesting a close must go through history.back(), never remove the modal directly -- otherwise the pushed history entry is stranded and a later back press does nothing visible');

// Every modal's open must register with the stack (and therefore the
// scroll lock, which woPushModal itself triggers).
assert.match(script, /woPushModal\(closeCartDrawer\)/, 'opening the cart drawer must register it with the shared modal stack');
assert.match(script, /woPushModal\(closeCheckoutModal\)/, 'opening the checkout modal must register it with the shared modal stack');
assert.match(script, /woPushModal\(closeDetail\)/, 'opening the item detail modal must register it with the shared modal stack');

// Every modal's real closer must release the scroll lock.
assert.match(script, /function closeCartDrawer\(\)\{\s*woUnlockBodyScroll\(\)/, 'closing the cart drawer must release the scroll lock');
assert.match(script, /function closeCheckoutModal\(\)\{\s*woUnlockBodyScroll\(\)/, 'closing the checkout modal must release the scroll lock');
assert.match(script, /function closeDetail\(\)\{\s*woUnlockBodyScroll\(\)/, 'closing the item detail modal must release the scroll lock');

// No UI-triggered close path may call a modal's real closer directly --
// every one of them must go through woRequestModalClose so the history
// stack this relies on can never drift out of sync with what's on screen.
for (const directClose of ['closeCartDrawer()', 'closeCheckoutModal()', 'closeDetail()']) {
  const onclickDirect = new RegExp('onclick\\s*=\\s*' + directClose.replace(/[()]/g, '\\$&').slice(0, -2));
  assert.doesNotMatch(script, onclickDirect, `${directClose} must never be wired directly to a click handler -- always through woRequestModalClose`);
}
assert.match(script, /bd\.onclick = woRequestModalClose;/, 'the cart drawer backdrop must close through the shared path');
assert.match(script, /'wo-cart-close'\)\.onclick = woRequestModalClose;/, 'the cart drawer X button must close through the shared path');
assert.match(script, /if\(e\.target === m\) woRequestModalClose\(\);/, 'the checkout modal backdrop must close through the shared path');
assert.match(script, /'wo-co-close'\)\.onclick = woRequestModalClose;/, 'the checkout modal X button must close through the shared path');
assert.match(script, /if\(e\.target === overlay\) woRequestModalClose\(\);/, 'the item detail overlay (tap outside) must close through the shared path');
assert.match(script, /closeButton\.addEventListener\('click', woRequestModalClose\);/, 'the item detail X button must close through the shared path');
assert.match(script, /addToCart\(\{[^}]*\}, e\.currentTarget\);\s*woRequestModalClose\(\);/, 'a successful Add to Cart must close through the shared path too, or the stray history entry it leaves behind eats the shopper\'s next real back press');

console.log('Modal scroll-lock and back-button-closes-modal checks passed.');
