import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../worker.js';
const response=await worker.fetch(new Request('https://wo.test/wo-cart.js'),{STRIPE_PUBLISHABLE_KEY:'pk_test',WO_RESERVATIONS:{get:async()=>null},WO_ORDERS:{get:async()=>null}},{});
const script=await response.text();
const lines=[],events=[];
const context={getCart:()=>lines,setCart:()=>{},trackStorefrontEvent:(...args)=>events.push(args),analyticsItem:item=>({item_id:item.id}),playAddToCartFlourish(){},alert(){}};
vm.createContext(context);
vm.runInContext(script.slice(script.indexOf('function woPriceConfirmed('),script.indexOf('function renderLiveInventoryPaged(')),context);
vm.runInContext(script.slice(script.indexOf('function addToCart('),script.indexOf('// Four 90s-throwback')),context);
for(const price of [0,-1,undefined,NaN,Infinity,'not a price']){
 assert.equal(context.woItemPriceLabel({price}),'Price to be confirmed');
 assert.equal(context.woItemCanBuy({price,quantity:1}),false);
 assert.equal(context.addToCart({id:'pending',price,available:1}),false);
}
assert.equal(context.addToCart({id:'sold',price:10,available:0}),false);
assert.equal(lines.length,0);assert.equal(events.length,0,'unpriced or unavailable additions never emit successful add events');
assert.equal(context.woItemCanBuy({price:10,quantity:0}),false);
assert.equal(context.woItemPriceLabel({price:10}),'$10.00');
context.addToCart({id:'priced',name:'Real priced item',price:10,available:1});
assert.equal(lines.length,1);assert.equal(lines[0].qty,1);assert.equal(events.length,1);
context.addToCart({id:'priced',price:10,available:1});
assert.equal(lines[0].qty,1,'the existing stock cap remains intact');
assert.equal(events.length,1);
assert.equal((script.match(/woItemCanBuy\(item\)\?'':'disabled aria-disabled="true"/g)||[]).length,2,'both grid and detail buttons use the purchase gate');
console.log('Pending prices, sold-out stock, cart boundary, event accuracy and normal purchases checked without a charge');
