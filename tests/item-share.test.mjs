import assert from 'node:assert/strict';
import worker from '../worker.js';
const item={id:'public-1',name:'Jackson <Holliday> & "rookie"',price:12.5,category:'Sports',set:'Topps',image:'https://example.com/card.jpg?a=1&b=2'};
const env={INVENTORY_API:{fetch:async()=>Response.json({ok:true,item})}};
for(const agent of ['facebookexternalhit/1.1','Twitterbot','Mozilla/5.0']){
  const response=await worker.fetch(new Request('https://wo.test/share/item?id=public-1',{headers:{'User-Agent':agent}}),env,{});
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/<meta property="og:image" content="https:\/\/example.com\/card.jpg\?a=1&amp;b=2">/);
  assert.match(html,/Jackson &lt;Holliday&gt; &amp; &quot;rookie&quot;/);
  assert.match(html,/\$12\.50/);
  assert.match(html,/<link rel="canonical" href="https:\/\/wo.test\/share\/item\?id=public-1">/);
  assert.doesNotMatch(html,/http-equiv="refresh"/i,'crawlers must retain product metadata');
  assert.match(html,/twitter:card/);
  assert.match(html,/location.replace\("https:\/\/themanapocket.com\/shop\?item=public-1"\)/);
}
const missing=await worker.fetch(new Request('https://wo.test/share/item?id=hidden'),{INVENTORY_API:{fetch:async()=>Response.json({ok:false},{status:404})}},{});
assert.equal(missing.status,404,'share route must preserve publication checks');
console.log('Item image, information, escaping, canonical, deep-link and visibility verified.');
