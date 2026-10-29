import assert from 'node:assert/strict';
import worker from '../worker.js';

// Store, 2026-10-29: a customer buying Absolute Batman #25 Cvr L (17 copies)
// "doesn't let me go to card information page after I enter my shipping
// details". Every item got an exclusive 15-minute hold at that step -- built
// for one-of-a-kind cards -- so a second try (or another shopper) on a
// many-copy comic was refused as "reserved by another order".
class MemoryKV {
  constructor(){ this.values=new Map(); }
  async get(key){ return this.values.get(key) ?? null; }
  async put(key,value){ this.values.set(key,String(value)); }
  async delete(key){ this.values.delete(key); }
}
const stock={
  'batman-25-l':{id:'batman-25-l',name:'ABSOLUTE BATMAN #25 CVR L',price:8.99,quantity:17,category:'Comic'},
  'one-card':{id:'one-card',name:'Charizard',price:40,quantity:1,category:'Pokemon TCG'},
};
const reservations=new MemoryKV();
const env={
  STRIPE_SECRET_KEY:'sk_test_local_only', STRIPE_PUBLISHABLE_KEY:'pk_test_local_only',
  WO_RESERVATIONS:reservations, WO_ORDERS:new MemoryKV(),
  INVENTORY_API:{ async fetch(input){
    const url=new URL(String(input)), item=stock[url.searchParams.get('id')];
    if(url.pathname==='/public/storefront/item')return item?Response.json({ok:true,item}):Response.json({ok:false,error:'Item is not currently available'},{status:409});
    throw new Error('Unexpected inventory request: '+url.pathname);
  }},
};
const originalFetch=globalThis.fetch;
let n=0;
globalThis.fetch=async function(input,init={}){
  const url=new URL(String(input));
  if(url.origin==='https://api.stripe.com'&&url.pathname==='/v1/payment_intents'&&init.method==='POST'){n++;return Response.json({id:'pi_'+n,client_secret:'pi_'+n+'_secret'});}
  return originalFetch(input,init);
};
const ship={method:'shipping',name:'Test Customer',phone:'5555550100',email:'',shippingAddress:{line1:'1 Main St',city:'Seattle',state:'WA',zip:'98101'}};
const start=(id,extra={})=>worker.fetch(new Request('https://wo.test/api/cart/create-intent',{method:'POST',headers:{Origin:'https://themanapocket.com','Content-Type':'application/json'},
  body:JSON.stringify({items:[{id,name:stock[id]?.name||id,price:1,qty:1}],fulfillment:ship,...extra})}),env,{});

try {
  // A comic with 17 copies: two shoppers (or one shopper twice) both get to the card page.
  let res=await start('batman-25-l');
  assert.equal(res.status,200,'first shopper reaches the card page');
  res=await start('batman-25-l');
  assert.equal(res.status,200,'a second shopper (or a retry) is not blocked by the first');
  assert.equal(await reservations.get('item:batman-25-l'),null,'no exclusive hold on a many-copy item');

  // A one-of-a-kind card keeps its hold -- except for the shopper who holds it.
  res=await start('one-card');
  assert.equal(res.status,200);
  const mine=(await res.json()).reservationId;
  assert.ok(await reservations.get('item:one-card'),'the last copy is held');
  res=await start('one-card');
  assert.equal(res.status,409,'someone else is refused while it is held');
  assert.match((await res.json()).error,/someone else's checkout/);
  res=await start('one-card',{reservationId:mine});
  assert.equal(res.status,200,'the same shopper going back and trying again gets through');

  // Taken off the site: a clear message.
  res=await start('gone-item');
  assert.equal(res.status,409);
  assert.match((await res.json()).error,/no longer available online/);

  // The browser sends its hold back on a retry.
  const page=await (await worker.fetch(new Request('https://wo.test/wo-cart.js',{headers:{origin:'https://themanapocket.com'}}),env,{})).text();
  assert.match(page,/items: cart, email: email, reservationId: _reservationId \|\| ''/);
} finally { globalThis.fetch=originalFetch; }
console.log('checkout hold checks passed');
