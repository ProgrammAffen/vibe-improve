import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudbaseOAuth} from '@cloudbase/js-sdk/oauth';

test('locked CloudBase OAuth client reads unexpired credentials from custom memory storage without networking',async()=>{
  const env='one-person-company-7dao3979fd72e',keys=[],memory=new Map();let requests=0;
  memory.set('credentials_'+env,JSON.stringify({access_token:'SYNTHETIC_ACCESS',refresh_token:'SYNTHETIC_REFRESH',expires_at:new Date(Date.now()+3600_000).toISOString(),expires_in:3600,scope:'user',token_type:'Bearer'}));
  const storage={getItem:async key=>{keys.push(key);return memory.get(key)??null;},getItemSync:key=>memory.get(key)??null,setItem:async(key,value)=>memory.set(key,value),setItemSync:(key,value)=>memory.set(key,value),removeItem:async key=>memory.delete(key),removeItemSync:key=>memory.delete(key)};
  const oauth=new CloudbaseOAuth({env,clientId:env,storage,baseRequest:async()=>{requests++;throw Error('TEST_NETWORK_BLOCKED');},detectSessionInUrl:false,retry:0});
  assert.equal(await oauth.oauth2client.getAccessToken(),'SYNTHETIC_ACCESS');
  assert.deepEqual([...new Set(keys)],['credentials_'+env]);assert.equal(requests,0);
  oauth.oauth2client.destroy();
});

test('locked OAuth client leaves expired credentials idle and refreshes only when access is explicitly requested',async()=>{
 const env='synthetic-idle-oauth',memory=new Map();let refreshes=0,requests=0;
 memory.set('credentials_'+env,JSON.stringify({access_token:'SYNTHETIC_EXPIRED',refresh_token:'SYNTHETIC_REFRESH',expires_at:new Date(Date.now()-3600000).toISOString(),expires_in:7200,token_type:'Bearer'}));
 const storage={getItem:async k=>memory.get(k)??null,getItemSync:k=>memory.get(k)??null,setItem:async(k,v)=>memory.set(k,v),setItemSync:(k,v)=>memory.set(k,v),removeItem:async k=>memory.delete(k),removeItemSync:k=>memory.delete(k)};
 const oauth=new CloudbaseOAuth({env,clientId:env,storage,detectSessionInUrl:false,retry:0,baseRequest:async(_url,options)=>{requests++;assert.equal(options.body.grant_type,'refresh_token');refreshes++;return {access_token:'SYNTHETIC_FRESH',refresh_token:'SYNTHETIC_ROTATED',expires_in:7200,expires_at:new Date(Date.now()+7200000),token_type:'Bearer'};}});
 try {for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));assert.equal(refreshes,0);assert.equal(requests,0);
  const tokens=await Promise.all([oauth.oauth2client.getAccessToken(),oauth.oauth2client.getAccessToken()]);assert.deepEqual(tokens,['SYNTHETIC_FRESH','SYNTHETIC_FRESH']);assert.equal(refreshes,1);assert.equal(requests,1);
 }finally{oauth.oauth2client.destroy();}
});
