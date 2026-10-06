/** 独立插件发布：显式选择认证方式，秘密仅在当前进程使用，不写入 artifact/job outputs。 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('发布服务必须使用 HTTPS');
  return url;
}
function token(value) {
  const result=String(value || '').replace(/^Bearer\s+/i,'');
  if (!result || /\s/.test(result)) throw new Error('认证凭证缺失或格式无效');
  return result;
}
async function jsonRequest(fetcher,url,options={}) {
  const res=await fetcher(httpsUrl(url),{...options, redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!res.ok) throw new Error(`授权或发布请求失败（HTTP ${res.status}）`);
  const data=await res.json();
  if (data.code!==undefined && Number(data.code)!==200) throw new Error(`授权或发布被拒绝（业务码 ${data.code}）`);
  return data;
}
export async function credential(mode,env,fetcher=fetch,mask=value=>console.log(`::add-mask::${value}`)) {
  const keys={pat:'XYCLOUD_PAT',login:'XYCLOUD_LOGIN_TOKEN',shared:'OTOOLS_MARKET_TOKEN'};
  if (keys[mode]) { const value=token(env[keys[mode]]); mask(value); return value; }
  if (mode!=='oidc') throw new Error('未知发布认证方式');
  if (!env.XYCLOUD_OIDC_ISSUER || !env.XYCLOUD_PUBLISHER_ID) throw new Error('请先配置 OIDC 兑换地址和可信发布绑定 ID');
  const url=httpsUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience',env.XYCLOUD_OIDC_AUDIENCE || 'otools-ci');
  const github=await jsonRequest(fetcher,url,{headers:{Authorization:`Bearer ${token(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)}`}});
  const jwt=token(github.value); mask(jwt);
  const result=await jsonRequest(fetcher,env.XYCLOUD_OIDC_ISSUER,{method:'POST',headers:{Authorization:`Bearer ${jwt}`,'Content-Type':'application/json'},
    body:JSON.stringify({publisherId:env.XYCLOUD_PUBLISHER_ID,scope:'otools:plugin:publish'})});
  const access=token(result.data?.access_token); mask(access); return access;
}
export function releaseMeta(manifest,override='',tag='') {
  const version=override || manifest.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('版本号无效');
  const packid=manifest.packid;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(packid)) throw new Error('packid 无效');
  if (tag && tag!==`v${version}`) throw new Error('tag 与 plugin.json 版本不一致');
  return {version,packid,release_tag:tag || `plugin-${packid}-v${version}`};
}
export function marketPayload(manifest,repo,tag,version) {
  const base=`https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
  return {...manifest,version,packageUrl:`${base}/${manifest.packid}-${version}.oplg`,logo:`${base}/logo.svg`};
}
export async function publishMarket(url,access,payload,fetcher=fetch) {
  const result=await jsonRequest(fetcher,url,{method:'POST',headers:{Authorization:`Bearer ${token(access)}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if (Number(result.code)!==200) throw new Error('市场未返回明确的成功状态');
  return result;
}
async function main() {
  const env=process.env;
  const manifest=JSON.parse(fs.readFileSync('plugin.json','utf8'));
  if (process.argv[2]==='meta') {
    const meta=releaseMeta(manifest,env.DISPLAY_VERSION||'',env.RELEASE_SOURCE_TAG||'');
    for(const [k,v] of Object.entries(meta)) fs.appendFileSync(env.GITHUB_OUTPUT,`${k}=${v}\n`);
    return;
  }
  const access=await credential(env.AUTH_MODE,env);
  await publishMarket(env.OTOOLS_MARKET_API || 'https://otools-api.lingyun.net/api/v1/otools/plugin/publish',access,
    marketPayload(manifest,env.GITHUB_REPOSITORY,env.RELEASE_TAG,env.RELEASE_VERSION));
  console.log('插件市场已确认发布成功');
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
