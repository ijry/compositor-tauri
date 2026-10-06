import test from 'node:test';
import assert from 'node:assert/strict';
import { credential, marketPayload, publishMarket, releaseMeta } from './publish-market.mjs';
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => data });
test('OIDC extracts GitHub value and xycloud data.access_token within one job', async () => {
  const calls=[];
  const token=await credential('oidc', { XYCLOUD_OIDC_ISSUER:'https://api.test/api/v1/user_pat/workload/token', XYCLOUD_PUBLISHER_ID:'grant1', ACTIONS_ID_TOKEN_REQUEST_URL:'https://github.test/token?a=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN:'request-secret' }, async (url, options) => {
    calls.push({url:String(url),options});
    return calls.length===1?response({value:'signed.github.jwt'}):response({code:200,data:{access_token:'xy_access_short'}});
  }, () => {});
  assert.equal(token,'xy_access_short');
  assert.match(calls[0].url,/audience=otools-ci/);
  assert.equal(calls[1].options.headers.Authorization,'Bearer signed.github.jwt');
  assert.equal(JSON.parse(calls[1].options.body).publisherId,'grant1');
});
test('PAT, login and official shared secret are explicit independent modes',async()=>{
  for (const [mode, key, value] of [['pat','XYCLOUD_PAT','xy_pat_test'],['login','XYCLOUD_LOGIN_TOKEN','Bearer session-jwt'],['shared','OTOOLS_MARKET_TOKEN','official-secret']]) {
    assert.equal(await credential(mode,{[key]:value},()=>{throw Error('no exchange');},()=>{}), value.replace(/^Bearer /,''));
  }
  await assert.rejects(credential('oidc',{OTOOLS_MARKET_TOKEN:'must-not-fallback'},()=>{},()=>{}));
});
test('HTTP and application errors fail rather than claiming publication success',async()=>{
  await assert.rejects(publishMarket('https://api.test/publish','xy_pat_test',{},async()=>response({code:403,msg:'no'})));
  await assert.rejects(publishMarket('https://api.test/publish','xy_pat_test',{},async()=>response({},false)));
  await assert.rejects(publishMarket('https://api.test/publish','xy_pat_test',{},async()=>response({error:'unexpected'})));
});
test('market payload uses actual packageUrl and release asset logo fields',()=>{
  const p=marketPayload({packid:'plugin-a',uuid:'plugin-a',version:'1.0.0',displayName:'A'},'owner/repo','v1.0.0','1.0.0');
  assert.equal(p.packageUrl,'https://github.com/owner/repo/releases/download/v1.0.0/plugin-a-1.0.0.oplg');
  assert.equal(p.logo,'https://github.com/owner/repo/releases/download/v1.0.0/logo.svg');
});
test('version inputs cannot inject shell or publish a mismatched tag',()=>{
  assert.throws(()=>releaseMeta({packid:'a',version:'1.0.0'},'1.0.0; echo bad',''));
  assert.throws(()=>releaseMeta({packid:'a',version:'1.0.0'},'','v2.0.0'));
  assert.equal(releaseMeta({packid:'a',version:'1.0.0'},'','v1.0.0').version,'1.0.0');
});
