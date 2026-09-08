import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from '../worker.js';

const response=await worker.fetch(new Request('https://wo.test/wo-cart.js'),{STRIPE_PUBLISHABLE_KEY:'pk_test'},{});
const script=await response.text();
const aliases=script.slice(script.indexOf('var CATEGORY_SLUG_MAP'),script.indexOf('// Builds the search'));
const update=script.slice(script.indexOf('  function update(options){'),script.indexOf('  return {el:bar,select:select'));
function optionsFor(current,categories){
 let result;
 const select={value:current};
 const context=vm.createContext({select,type:{value:'all'},populate:(el,options)=>{if(el===select)result=options;},productTypeOptions:()=>[],updateSummary:()=>{}});
 vm.runInContext(aliases+update,context);
 context.update({categories,types:[]});
 return JSON.parse(JSON.stringify(result));
}
for(const [slug,value,label] of [['sports-cards','sports','Sports'],['pokemon','pokemon tcg','Pokemon TCG'],['mtg','magic: the gathering','Magic: The Gathering'],['comics','comic','Comic']]){
 const original=[{value,label,count:140}];
 assert.deepEqual(optionsFor(slug,original),[{value:slug,label,count:140}]);
 assert.equal(original[0].value,value,'API facets must not be mutated');
}
const split=[{value:'baseball',label:'Baseball',count:3},{value:'football',label:'Football',count:4}];
assert.deepEqual(optionsFor('sports-cards',split),split,'an aggregate Sports filter must not replace either narrower category');
const unknown=[{value:'new game',label:'New Game',count:1}];
assert.deepEqual(optionsFor('new game',unknown),unknown,'unknown database categories must stay available');
assert.deepEqual(optionsFor('tcg',[{value:'pokemon tcg',label:'Pokemon TCG',count:2}]),[{value:'pokemon tcg',label:'Pokemon TCG',count:2}],'TCG remains an aggregate filter');
console.log('Navigation aliases reuse matching database facets without hiding distinct or unknown categories.');
