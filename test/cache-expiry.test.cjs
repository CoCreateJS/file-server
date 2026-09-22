const {test}=require('node:test');
const assert=require('node:assert/strict');
const {getCacheExpiry}=require('../src/cachePolicy.js');
const now=Date.parse('2026-09-22T12:00:00Z');
const future=new Date(now+60000).toUTCString();
const past=new Date(now-30000).toUTCString();
test('max-age uses stored Date and overrides Expires',()=>{
 const headers={'Cache-Control':'private, max-age=60, must-revalidate',Date:past,Expires:new Date(now-1000).toUTCString()};
 assert.deepEqual(getCacheExpiry(headers,now),{maxAge:60,expires:now+30000,expired:false});
 assert.equal(getCacheExpiry(headers,now+30000).expired,true);
 assert.equal(getCacheExpiry({...headers,Age:'60'},now).expired,true);
});
test('Expires fallback and missing or invalid freshness',()=>{
 assert.equal(getCacheExpiry({expires:future},now).expired,false);
 for(const headers of [{},{Expires:'bad'},{Expires:past},{'cache-control':'max-age=60',Expires:future},{'cache-control':'max-age=bad',Date:past,Expires:future}])assert.equal(getCacheExpiry(headers,now).expired,true);
});
test('no-cache and no-store do not defer access checks',()=>{
 for(const directive of ['no-cache','no-store'])assert.equal(getCacheExpiry({'cache-control':`${directive}, max-age=60`,Date:past,Expires:future},now).expired,true);
});
