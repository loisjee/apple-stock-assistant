import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createMonitorServer,validatePublicOrigin} from '../server/http.mjs';
const password='test-only-long-management-password';
async function fixture(t,options={}){
  const actions=[];const monitor={state:()=>({config:{address:'示例地区'},running:false,stores:[],notification:{configured:false}})};
  for(const method of ['saveConfig','start','stop','checkNow'])monitor[method]=async value=>{actions.push([method,value]);};
  const server=createMonitorServer({monitor,password,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url=`http://127.0.0.1:${server.address().port}`;
  const request=(path,opts={})=>fetch(`${url}${path}`,opts);
  const raw=(path,options={})=>new Promise((resolve,reject)=>{const req=httpRequest(`${url}${path}`,options,res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});req.on('error',reject);req.end(options.body);});
  const post=(path,data={},headers={})=>request(path,{method:'POST',headers:{'Content-Type':'application/json','X-Monitor-Request':'1',...headers},body:JSON.stringify(data)});
  const login=async()=>{const result=await post('/api/login',{password});assert.equal(result.status,200);return result.headers.get('set-cookie').split(';')[0];};
  return {server,url,request,raw,post,login,actions};
}
test('server requires a long access password, and public origins use HTTPS without paths or credentials',()=>{
  assert.throws(()=>createMonitorServer({monitor:{},password:'short'}),/20/);
  assert.equal(validatePublicOrigin('https://stock.example.com/'),'https://stock.example.com');
  for(const value of ['http://stock.example.com','https://user:pass@stock.example.com','https://stock.example.com/path','https://stock.example.com/?key=value'])assert.throws(()=>validatePublicOrigin(value));
});
test('server hides location/state until login, uses HttpOnly cookies, and logout invalidates the session',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/state')).status,401);
  assert.equal((await f.post('/api/start')).status,401);assert.equal(f.actions.length,0);
  const response=await f.post('/api/login',{password});const cookie=response.headers.get('set-cookie');
  assert.equal(response.status,200);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.doesNotMatch(cookie,/test-only/);
  const token=cookie.split(';')[0];const headers={Cookie:token};
  const state=await f.request('/api/state',{headers});assert.equal(state.status,200);assert.equal((await state.json()).state.notificationsEnabled,false);
  assert.equal((await f.post('/api/start',{},headers)).status,200);assert.equal(f.actions[0][0],'start');
  assert.equal((await f.post('/api/logout',{},headers)).status,200);
  assert.equal((await f.request('/api/state',{headers})).status,401);
});
test('cross-origin, cross-site, and missing custom-header mutations are rejected before reaching monitor',async t=>{
  const f=await fixture(t);const token=await f.login();const headers={Cookie:token};
  assert.equal((await f.post('/api/start',{}, {...headers,Origin:'https://evil.example'})).status,403);
  assert.equal((await f.post('/api/start',{}, {...headers,'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await f.request('/api/start',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await f.raw('/api/state',{headers:{...headers,Host:'evil.example'}})).status,403);
  assert.equal((await f.request('/api/stop',{method:'GET',headers})).status,404);assert.equal(f.actions.length,0);
});
test('invalid or oversized JSON does not mutate monitor; static serving cannot expose source or state files',async t=>{
  const f=await fixture(t);const Cookie=await f.login();
  assert.equal((await f.request('/api/config',{method:'POST',headers:{Cookie,'Content-Type':'text/plain','X-Monitor-Request':'1'},body:'{}'})).status,415);
  assert.equal((await f.request('/api/config',{method:'POST',headers:{Cookie,'Content-Type':'application/json','X-Monitor-Request':'1'},body:'{bad'})).status,400);
  assert.equal((await f.post('/api/config',{config:{address:'x'.repeat(17000)}},{Cookie})).status,413);
  assert.equal(f.actions.length,0);
  for(const path of ['/data/state.json','/.env','/server/http.mjs','/../core.mjs'])assert.equal((await f.request(path)).status,404);
  const script=await f.request('/stock-history-view.js');assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);assert.match(await script.text(),/window.StockHistoryView/);
});
test('bad login is rate-limited; correct password cannot skip an active cooldown',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.post('/api/login',{password:'incorrect'})).status,401);
  assert.equal((await f.post('/api/login',{password})).status,429);
});
test('sessions expire and public HTTPS configuration uses Secure cookies and the configured host only',async t=>{
  let now=100000;const f=await fixture(t,{now:()=>now});const Cookie=await f.login();
  now+=12*60*60*1000+1;assert.equal((await f.request('/api/state',{headers:{Cookie}})).status,401);
  const secure=await fixture(t,{publicOrigin:'https://stock.example.com'});
  assert.equal((await secure.request('/api/session')).status,403);
  const response=await secure.raw('/api/login',{method:'POST',headers:{Host:'stock.example.com',Origin:'https://stock.example.com','Content-Type':'application/json','X-Monitor-Request':'1'},body:JSON.stringify({password})});
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/; Secure/);
});
