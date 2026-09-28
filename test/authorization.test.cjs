const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {getCachePolicy}=require('../src/cachePolicy.js');
const source=fs.readFileSync(require.resolve('../src/index.js'),'utf8').replace(/\r\n/g,'\n');
function setup({file,permission=true,allowed}={}){
 let checks=0,decodes=0;
 const server={authenticate:{decodeToken:async token=>{decodes++;assert.equal(token,'token');return {user_id:'user',expires:Date.now()+60000};}},authorize:{check:async request=>{checks++;request.filter.query.owner='user';return permission===true?{authorized:request}:permission;}}};
 const crud={send:async request=>{
  if(request.filter.query.pathname)return {object:file?[file]:[]};
  assert.equal(request.filter.query.owner,'user');return {object:allowed===undefined?[file]:allowed};
 }};
 const code=source.slice(source.indexOf('async function createRequestSession'),source.indexOf('/**\n * Main entry'))+'\n'+source.slice(source.indexOf('async function resolveFile('),source.indexOf('/**\n * Specifically resolves'));
 const api=vm.runInNewContext(code+'\n({createRequestSession,resolveFile})',{server,getCachePolicy,Date,decodeURIComponent,getWildcardPath:()=>'/test/*.html',getDefaultFile:async({fileName})=>({object:[{src:fileName,headers:{'cache-control':'public'}}]})});
 return {...api,crud,counts:()=>({checks,decodes})};
}
const session={user_id:'user',expires:Date.now()+60000,policies:[]};
function resolve(api,extra={}){return api.resolveFile({pathname:'/test/file.html',hostname:'dev.test',organizationId:'org',crud:api.crud,...extra});}
test('one decoded session is reused for direct and recursive files',async()=>{
 const api=setup({file:{_id:'file',src:'content',headers:{'cache-control':'must-revalidate'}}});
 const session=await api.createRequestSession({headers:{authorization:'Bearer token'}},'org','dev.test');
 assert.equal(session.user_id,'user');
 assert.equal((await resolve(api,{session})).statusCode,200);
 assert.equal((await resolve(api,{session,recursive:true})).statusCode,200);
 assert.deepEqual(api.counts(),{checks:2,decodes:1});
});
test('private checks the session even when the client validator matches',async()=>{
 const file={_id:'file',src:'secret',headers:{'cache-control':'private',etag:'"v1"'}};
 const api=setup({file});const request={headers:{'if-none-match':'"v1"'}};
 const denied=await resolve(api,{request});assert.equal(denied.statusCode,403);assert.equal(denied.file.status,403);assert.equal(denied.src,'/403.html');
 const allowed=await resolve(api,{request,session});assert.equal(allowed.statusCode,304);assert.equal(allowed.src,null);assert.equal(api.counts().checks,0);
 assert.equal(file.src,'secret');assert.equal(file.status,undefined);
});
test('authorization runs before 304 and respects query exclusions',async()=>{
 for(const options of [{permission:false},{permission:{error:'denied'}},{allowed:[]}]){
 const api=setup({file:{_id:'file',src:'secret',headers:{'cache-control':'must-revalidate',etag:'"v1"'}},...options});
 const result=await resolve(api,{session,request:{headers:{'if-none-match':'"v1"'}}});
 assert.equal(result.statusCode,403);assert.equal(result.src,'/403.html');
 }
});
test('fresh expiry does not defer authorization or session authentication',async()=>{
 const api=setup({file:{_id:'file',src:'content',headers:{'cache-control':'must-revalidate',Expires:new Date(Date.now()+60000).toUTCString()}}});
 assert.equal((await resolve(api,{session})).statusCode,200);assert.equal(api.counts().checks,1);
 assert.equal((await resolve(api)).statusCode,403);
});
test('immutable HTTP first fetch is 200; recursive file may defer to the client',async()=>{
 const api=setup({file:{_id:'file',src:'content',headers:{'cache-control':'public, max-age=3600, immutable'}}});
 assert.equal((await resolve(api)).statusCode,200);
 const deferred=await resolve(api,{recursive:true});assert.equal(deferred.statusCode,304);assert.equal(deferred.src,null);
});
test('missing files remain 404',async()=>{
 const api=setup();const result=await resolve(api);assert.equal(result.statusCode,404);assert.equal(result.file.status,404);assert.equal(result.src,'/404.html');
});
