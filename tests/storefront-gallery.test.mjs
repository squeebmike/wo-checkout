import assert from 'node:assert/strict';
import worker from '../worker.js';
import vm from 'node:vm';

const env={
  STRIPE_PUBLISHABLE_KEY:'pk_test',
  WO_RESERVATIONS:{get:async()=>null,put:async()=>{}},
  WO_ORDERS:{get:async()=>null,put:async()=>{}},
};
const response=await worker.fetch(new Request('https://wo.test/wo-cart.js',{headers:{origin:'https://themanapocket.com'}}),env,{});
const script=await response.text();
assert.doesNotThrow(()=>new Function(script),'served cart script must parse');
assert.match(script,/function woItemImages\(item\)/,'the storefront must normalize every item image source');
assert.match(script,/item&&item\.photos/,'saved photos must be included');
assert.match(script,/item&&item\.images/,'legacy and Pocket Scout images must be included');
assert.match(script,/data-wo-item-gallery/,'the item modal must render a gallery');
assert.match(script,/data-wo-gallery-thumbs/,'multi-image items must expose selectable thumbnails');
assert.match(script,/data-wo-gallery-prev/,'the gallery must provide a previous-image control');
assert.match(script,/data-wo-gallery-next/,'the gallery must provide a next-image control');
assert.match(script,/aria-current/,'the selected thumbnail must be announced accessibly');
assert.match(script,/showGalleryImage/,'gallery controls must update the main product image');

const helperStart=script.indexOf('function woItemImages');
const helperEnd=script.indexOf('// Live-inventory cards',helperStart);
assert.ok(helperStart>=0&&helperEnd>helperStart,'gallery helpers must be available in the served browser script');
const context={escapeHtml:value=>String(value)};
vm.runInNewContext(script.slice(helperStart,helperEnd)+';this.woItemImages=woItemImages;this.woItemGalleryHtml=woItemGalleryHtml;',context);
const first='https://example.com/front.jpg',second='https://example.com/back.jpg',third='https://example.com/detail.jpg';
const images=Array.from(context.woItemImages({image:first,photos:[second,first],images:[third,second]}));
assert.deepEqual(images,[first,second,third],'the browser gallery must preserve image order and remove duplicates');
const gallery=context.woItemGalleryHtml({name:'Multi-photo item',image:first,photos:[second,third]});
assert.match(gallery,/1 \/ 3/,'the gallery must show the total image count');
assert.equal((gallery.match(/data-wo-image-index=/g)||[]).length,3,'the gallery must render one thumbnail for every image');

console.log('Storefront multi-image gallery checks passed.');
