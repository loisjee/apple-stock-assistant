import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';

const PUBLIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const COOKIE='pickup_session';
const MAX_BODY=16384;
const SESSION_MS=12*60*60*1000;
function json(res, status, data, headers={}) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data)); }
function failure(res,status,error){json(res,status,{ok:false,error});}
function cookieValue(req){const value=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(`${COOKIE}=`));return value?.slice(COOKIE.length+1)||'';}
function loopback(hostname){return ['localhost','127.0.0.1','[::1]'].includes(hostname);}
export function validatePublicOrigin(value='') {
  if(!value)return '';
  let url;try{url=new URL(value);}catch{throw new Error('MONITOR_PUBLIC_ORIGIN 须为完整 HTTPS 域名。');}
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol!=='https:')throw new Error('MONITOR_PUBLIC_ORIGIN 须为 HTTPS 源地址，例如 https://stock.example.com。');
  return url.origin;
}
async function body(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw Object.assign(new Error('请使用 JSON 请求。'),{status:415});
  if(Number(req.headers['content-length'])>MAX_BODY)throw Object.assign(new Error('请求内容过长。'),{status:413});
  let size=0;const parts=[];
  for await(const part of req){size+=part.length;if(size>MAX_BODY)throw Object.assign(new Error('请求内容过长。'),{status:413});parts.push(part);}
  try{const data=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();return data;}
  catch{throw Object.assign(new Error('请求内容不是有效对象。'),{status:400});}
}
export function createMonitorServer({monitor,password,publicOrigin='',cookieSecure=false,now=Date.now}) {
  if(!monitor)throw new Error('缺少库存监控服务。');
  if(typeof password!=='string'||password.length<20||password.length>512)throw new Error('请通过 MONITOR_PASSWORD 设置 20 至 512 个字符的管理密码。');
  publicOrigin=validatePublicOrigin(publicOrigin);
  const salt=randomBytes(16),passwordHash=scryptSync(password,salt,32),sessions=new Map(),attempts=new Map();
  const secure=cookieSecure||publicOrigin.startsWith('https:');
  const sessionCookie=(value,age)=>`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;
  function authenticated(req){const key=cookieValue(req),expires=sessions.get(key);if(!expires)return false;if(expires<=now()){sessions.delete(key);return false;}return true;}
  function originAllowed(req){
    let host;try{host=new URL(`http://${req.headers.host||''}`);}catch{return false;}
    const expected=publicOrigin||`http://${host.host}`;
    if(publicOrigin ? host.host!==new URL(publicOrigin).host : !loopback(host.hostname))return false;
    return (!req.headers.origin||req.headers.origin===expected)&&req.headers['sec-fetch-site']!=='cross-site';
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try{
      if(!originAllowed(req))return failure(res,403,'请求来源不受信任，请通过配置的管理地址访问。');
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      if(req.method==='GET'&&path==='/healthz')return json(res,200,{ok:true});
      if(req.method==='GET'&&PUBLIC.has(path)){
        const [file,type]=PUBLIC.get(path),data=await readFile(new URL(`./public/${file}`,import.meta.url));
        res.writeHead(200,{'Content-Type':type});res.end(data);return;
      }
      if(!path.startsWith('/api/'))return failure(res,404,'页面不存在。');
      if(!['GET','POST'].includes(req.method))return failure(res,405,'请求方法不支持。');
      if(req.method==='POST'&&req.headers['x-monitor-request']!=='1')return failure(res,403,'请求缺少管理页标识。');
      if(path==='/api/session'&&req.method==='GET')return authenticated(req)?json(res,200,{ok:true,authenticated:true}):failure(res,401,'请先登录管理页。');
      if(path==='/api/login'&&req.method==='POST'){
        const data=await body(req),key=req.socket.remoteAddress||'local';
        for(const [k,v]of attempts)if(v.until<=now())attempts.delete(k);
        const record=attempts.get(key)||{count:0,until:now()+600000};
        if(record.count>=10)return failure(res,429,'尝试次数较多，请十分钟后重试。');
        record.count++;attempts.set(key,record);
        if(attempts.size>1024)attempts.delete(attempts.keys().next().value);
        const supplied=typeof data.password==='string'&&data.password.length<=512?data.password:'';
        const matches=timingSafeEqual(scryptSync(supplied,salt,32),passwordHash);
        if(!matches)return failure(res,401,'管理密码不正确。');
        attempts.delete(key);
        for(const [k,v]of sessions)if(v<=now())sessions.delete(k);
        if(sessions.size>=256)sessions.delete(sessions.keys().next().value);
        const id=randomBytes(32).toString('hex');sessions.set(id,now()+SESSION_MS);
        return json(res,200,{ok:true},{'Set-Cookie':sessionCookie(id,SESSION_MS/1000)});
      }
      if(!authenticated(req))return failure(res,401,'登录已过期，请重新输入管理密码。');
      if(req.method==='POST'&&path==='/api/logout'){
        await body(req);sessions.delete(cookieValue(req));return json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)});
      }
      const snapshot=()=>({...monitor.state(),notificationsEnabled:Boolean(monitor.state().notification?.configured)});
      if(req.method==='GET'&&path==='/api/state')return json(res,200,{ok:true,state:snapshot()});
      if(req.method==='POST'){
        const data=await body(req);
        try{
          if(path==='/api/config')await monitor.saveConfig(data.config);
          else if(path==='/api/start')await monitor.start();
          else if(path==='/api/stop')await monitor.stop();
          else if(path==='/api/check')await monitor.checkNow();
          else return failure(res,404,'操作不存在。');
          return json(res,200,{ok:true,state:snapshot()});
        }catch(error){return failure(res,400,typeof error?.message==='string'?error.message.slice(0,300):'操作未完成，请稍后重试。');}
      }
      return failure(res,404,'操作不存在。');
    }catch(error){if(!res.headersSent)failure(res,error.status||500,error.status?error.message:'管理服务暂时无法完成请求。');else res.end();}
  });
  server.requestTimeout=70000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return server;
}
