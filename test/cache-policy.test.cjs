const {test}=require('node:test');
const assert=require('node:assert/strict');
const {getCachePolicy,responseCacheControl}=require('../src/cachePolicy.js');
const policy=value=>getCachePolicy({headers:{'cAcHe-CoNtRoL':value}});
test('explicit cache directives define access and preserve cache policy',()=>{
 for(const [value,mode] of [['public, max-age=31536000, immutable','public'],['private','authenticate'],['PRIVATE, no-cache','authenticate'],['no-store, must-revalidate','authorize'],['','authorize'],['public, private','authenticate'],['private="Set-Cookie"','authenticate']])assert.equal(policy(value).policy,mode);
 for(const value of ['public, max-age=31536000, immutable','private','private, no-cache','private, max-age=3600','no-store, must-revalidate'])assert.equal(responseCacheControl([policy(value)]),value);
 assert.equal(responseCacheControl([policy('')]),'no-store');
});
test('recursive includes restrict the combined response',()=>{
 const root=policy('public, max-age=31536000, immutable');
 assert.equal(responseCacheControl([root,policy('private, max-age=60')]),'private, max-age=60');
 assert.equal(responseCacheControl([root,policy('private, no-cache')]),'private, no-cache');
 assert.equal(responseCacheControl([root,policy('no-store, must-revalidate')]),'no-store');
});

test('must-revalidate controls authorization without disabling browser freshness',()=>{
 for(const value of ['private, max-age=3600, must-revalidate','public, max-age=3600, must-revalidate','must-revalidate']) {
  assert.equal(policy(value).policy,'authorize');
  assert.equal(responseCacheControl([policy(value)]),value);
 }
 assert.equal(responseCacheControl([policy('public, max-age=3600'),policy('private, max-age=60, must-revalidate')]),'private, max-age=60, must-revalidate');
});

test('directive values and partial names cannot grant public access',()=>{
 for(const value of ['x-public','extension="public"','extension="anything, public"'])assert.equal(policy(value).policy,'authorize');
});


test('HTTP 304 requires matching validators and ETag takes precedence',()=>{
 const file={src:'file',modified:{on:'2026-09-22T12:00:00.123Z'},headers:{'cache-control':'public, immutable',ETag:'"v2"'}};
 assert.equal(getCachePolicy(file).status,200);
 assert.equal(getCachePolicy(file,{headers:{'If-None-Match':'W/"v2"'}}).status,304);
 assert.equal(getCachePolicy(file,{headers:{'If-None-Match':'"v1"','If-Modified-Since':'2026-09-23T00:00:00Z'}}).status,200);
 assert.equal(getCachePolicy(file,{headers:{'If-Modified-Since':'Tue, 22 Sep 2026 12:00:00 GMT'}}).status,304);
 assert.equal(getCachePolicy(file,{headers:{'If-Modified-Since':'Tue, 22 Sep 2026 11:59:00 GMT'}}).status,200);
 assert.equal(getCachePolicy(file,{method:'POST',headers:{'If-None-Match':'"v2"'}}).status,200);
});
