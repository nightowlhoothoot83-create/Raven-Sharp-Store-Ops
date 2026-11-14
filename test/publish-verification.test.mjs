import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/agent-publish.js';
import { encryptValue, sessionCookie } from '../src/security.js';

const env={ETSY_KEYSTRING:'test-key',ETSY_SHARED_SECRET:'test-shared',SESSION_SECRET:'test-session-secret-at-least-thirty-two-characters'};
const listing={listing_id:123,shop_id:9,state:'draft',title:'Test download',description:'Test description',price:{amount:1200,divisor:100},taxonomy_id:1,listing_type:'download'};
async function attempt({verification='active',confirmation='yes',csrf='test-csrf',owner=9}={}) {
  const session={shopId:9,accessToken:'test-token',csrf:'test-csrf',expiresAt:Date.now()+3600000};
  const cookie=sessionCookie(await encryptValue(session,env.SESSION_SECRET)).split(';')[0];
  const body=new URLSearchParams({csrf,confirm_publish:confirmation});
  const original=globalThis.fetch, oldError=console.error;let patches=0;
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(input);assert.equal(url.origin,'https://openapi.etsy.com');
    if(options.method==='PATCH'){patches++;assert.equal(options.body.get('state'),'active');return Response.json({listing_id:123,state:'active'});}
    if(url.pathname.endsWith('/images')||url.pathname.endsWith('/files'))return Response.json({results:[{id:1}]});
    assert.ok(url.pathname.endsWith('/listings/123'));
    if(patches){
      if(verification==='unavailable')throw Error('Simulated read-back failure');
      if(verification==='empty')return new Response(null,{status:204});
      return Response.json({...listing,state:verification==='wrong-owner'?'active':verification,shop_id:verification==='wrong-owner'?55:9});
    }
    return Response.json({...listing,shop_id:owner});
  };
  console.error=()=>{};
  try{
    const response=await app.fetch(new Request('https://store.test/agent/listings/123/publish',{method:'POST',headers:{Cookie:cookie,Origin:'https://store.test'},body}),env);
    const location=new URL(response.headers.get('Location'),'https://store.test');
    return {patches,status:response.status,error:location.searchParams.get('error'),notice:location.searchParams.get('notice')};
  }finally{globalThis.fetch=original;console.error=oldError;}
}
test('reports success only after confirming the owned listing is active',async()=>{
  const result=await attempt();assert.equal(result.patches,1);assert.match(result.notice,/published/);assert.equal(result.error,null);
});
test('failed read-back never claims a successful publication',async()=>{
  const result=await attempt({verification:'unavailable'});assert.equal(result.patches,1);assert.equal(result.notice,null);assert.match(result.error,/could not verify|verification unavailable/i);
});
test('empty read-back never claims a successful publication',async()=>{
  const result=await attempt({verification:'empty'});assert.equal(result.notice,null);assert.match(result.error,/could not verify|verification unavailable/i);
});
test('read-back must still be active',async()=>{
  const result=await attempt({verification:'draft'});assert.equal(result.notice,null);assert.match(result.error,/still draft/);
});
test('read-back must still belong to the connected shop',async()=>{
  const result=await attempt({verification:'wrong-owner'});assert.equal(result.notice,null);assert.ok(result.error);
});
test('missing approval and incorrect CSRF never send a publish request',async()=>{
  for(const options of [{confirmation:''},{csrf:'incorrect'}]){const result=await attempt(options);assert.equal(result.patches,0);assert.ok(result.error);}
});
test('unowned draft never sends a publish request',async()=>{
  const result=await attempt({owner:55});assert.equal(result.patches,0);assert.ok(result.error);
});
