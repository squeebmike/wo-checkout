import assert from 'node:assert/strict';
import worker from '../worker.js';

class MemoryKV {
  constructor(){ this.values=new Map(); }
  async get(key){ return this.values.get(key) ?? null; }
  async put(key,value){ this.values.set(key,String(value)); }
  async delete(key){ this.values.delete(key); }
}

const reservations=new MemoryKV();
const orders=new MemoryKV();
let recordedOrder=null;
const inventoryItem={id:'sports-test-1',name:'Test Sports Single',price:12,quantity:1,category:'Sports'};
const env={
  STRIPE_SECRET_KEY:'sk_test_local_only',
  STRIPE_PUBLISHABLE_KEY:'pk_test_local_only',
  WO_RESERVATIONS:reservations,
  WO_ORDERS:orders,
  INVENTORY_API:{
    async fetch(input,init={}){
      const url=new URL(String(input));
      if(url.pathname==='/public/storefront/item')return Response.json({ok:true,item:inventoryItem});
      if(url.pathname==='/public/storefront/record-order'){
        recordedOrder=JSON.parse(init.body);
        return Response.json({ok:true});
      }
      throw new Error('Unexpected inventory request: '+url.pathname);
    }
  }
};

const originalFetch=globalThis.fetch;
globalThis.fetch=async function(input,init={}){
  const url=new URL(String(input));
  if(url.origin!=='https://api.stripe.com')return originalFetch(input,init);
  if(url.pathname==='/v1/payment_intents'&&init.method==='POST')return Response.json({id:'pi_local_funnel',client_secret:'pi_local_funnel_secret'});
  if(url.pathname==='/v1/payment_intents/pi_local_funnel'&&init.method==='GET')return Response.json({id:'pi_local_funnel',status:'succeeded',livemode:false});
  throw new Error('Unexpected Stripe request: '+init.method+' '+url.pathname);
};

try {
  const create=await worker.fetch(new Request('https://wo.test/api/cart/create-intent',{
    method:'POST',
    headers:{Origin:'https://themanapocket.com','Content-Type':'application/json'},
    body:JSON.stringify({items:[{id:inventoryItem.id,name:inventoryItem.name,price:1,qty:1}],fulfillment:{method:'pickup_fedway',name:'Test Customer',phone:'5555550100',email:'',shippingAddress:null}})
  }),env,{});
  assert.equal(create.status,200,'a filtered storefront item must be able to enter checkout');
  const intent=await create.json();
  assert.equal(intent.amountCents,1200,'checkout must replace the browser price with the current inventory price');
  assert.equal(intent.totals.shipping,0,'pickup must remain free');
  assert.ok(await reservations.get('item:'+inventoryItem.id),'checkout must reserve the selected inventory item');

  const confirm=await worker.fetch(new Request('https://wo.test/api/order/confirm',{
    method:'POST',
    headers:{Origin:'https://themanapocket.com','Content-Type':'application/json'},
    body:JSON.stringify({paymentIntentId:intent.paymentIntentId,items:[{id:inventoryItem.id,name:inventoryItem.name,price:12,qty:1}],totals:intent.totals,customer:{name:'Test Customer',email:''},shipping:{},fulfillment:{method:'pickup_fedway',name:'Test Customer',phone:'5555550100',email:'',shippingAddress:null},amountCents:intent.amountCents})
  }),env,{});
  assert.equal(confirm.status,200,'a succeeded payment must reach order confirmation');
  assert.deepEqual(await confirm.json(),{ok:true,orderId:'pi_local_funnel'});
  const saved=JSON.parse(await orders.get('order:pi_local_funnel'));
  assert.equal(saved.status,'paid','the confirmed order must be recorded as paid');
  assert.equal(recordedOrder.stripePaymentIntentId,'pi_local_funnel','confirmation must also reach the inventory/order ledger');
  assert.equal(recordedOrder.mode,'test','the local funnel test must never create a live transaction');

  const scriptResponse=await worker.fetch(new Request('https://wo.test/wo-cart.js',{headers:{Origin:'https://themanapocket.com'}}),env,{});
  const script=await scriptResponse.text();
  assert.match(script,/trackStorefrontEvent\('begin_checkout'/,'the browser funnel must record checkout entry');
  assert.match(script,/Order confirmed!/,'the browser funnel must expose a confirmation state');
  assert.match(script,/trackStorefrontEvent\('purchase'/,'the browser funnel must record completed purchases');
  console.log('Storefront checkout and confirmation integration checks passed without a live charge.');
} finally {
  globalThis.fetch=originalFetch;
}
