const $=id=>document.getElementById(id);
const PRESETS={duo:{productName:'iPhone Duo 1TB 星光白色',partNumber:'MK2T4CH/A',productUrl:'https://www.apple.com.cn/shop/product/MK2T4CH/A'},test:{productName:'iPhone 18 Pro Max 1TB 冰川蓝色',partNumber:'MJYJ4CH/A',productUrl:'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a'}};
const LABELS={idle:'等待开始',checking:'正在检查官网',watching:'正在监控',available:'发现可自提门店',paused:'监控已暂停',error:'需要检查页面'};
let state=null,authenticated=false,busy=false,polling=false,operationError='',connectionError='',viewRevision=0;
const setText=(id,value)=>{$(id).textContent=String(value??'');};
function showLogin(message=''){
  viewRevision++;authenticated=false;state=null;StockHistoryView.render(null);operationError='';connectionError='';
  $('loading').hidden=true;$('dashboard').hidden=true;$('logout').hidden=true;$('login-view').hidden=false;
  if($('settings').open)$('settings').close();
  setText('login-error',message);$('login-error').hidden=!message;syncControls();
}
function showDashboard(){authenticated=true;$('loading').hidden=true;$('login-view').hidden=true;$('dashboard').hidden=false;$('logout').hidden=false;syncControls();}
async function api(path,{method='GET',data,allowUnauthorized=false}={}){
  const requestRevision=viewRevision;
  const options={method,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}};
  if(method==='POST'){options.headers['Content-Type']='application/json';options.headers['X-Monitor-Request']='1';options.body=JSON.stringify(data??{});}
  let response;
  try{response=await fetch(path,options);}catch{throw new Error('无法连接监控服务，请检查服务器是否正在运行。');}
  let result;try{result=await response.json();}catch{throw new Error('监控服务返回了无法读取的结果。');}
  if(response.status===401){if(allowUnauthorized)return{ok:false,unauthorized:true,error:result?.error};if(requestRevision===viewRevision)showLogin('登录已过期，请重新输入管理密码。');throw new Error('登录已过期，请重新输入管理密码。');}
  if(!response.ok||result?.ok!==true)throw new Error(typeof result?.error==='string'?result.error:'操作失败，请稍后重试。');
  return result;
}
function stale(){return Boolean(connectionError||state?.stale||state?.lastCheckAt&&Date.now()-state.lastCheckAt>Math.max(120000,(state.config.intervalSeconds||60)*2000));}
function syncControls(){
  $('login-button').disabled=busy;$('password').disabled=busy;
  for(const id of ['logout','configure','toggle','check-now','save-settings'])$(id).disabled=busy||!authenticated||!state;
  if(authenticated&&!busy&&state){const missing=!state.config.address?.trim();$('toggle').disabled=missing&&!state.running;$('check-now').disabled=missing;$('toggle').title=missing?'请先配置所在地区':'';}
}
function renderNotice(){setText('notice',operationError||connectionError||state?.error||state?.notice||'');$('notice').hidden=!$('notice').textContent;}
function updateClock(){
  if(!state)return;
  const seconds=Math.ceil(((state.nextCheckAt||0)-Date.now())/1000);
  setText('next-check',state.running?(seconds>0?`${seconds} 秒后检查`:'等待服务器反馈'):`每 ${state.config.intervalSeconds} 秒`);
  const old=stale();
  setText('freshness',!state.lastCheckAt?'等待首次检查':old?'上次结果 · 已过期':'上次检查结果');
  $('stores').classList.toggle('stale',old);
  setText('status-title',connectionError?'连接暂时中断':old&&state.status==='available'?'上次发现可自提':LABELS[state.status]||'等待服务器反馈');
  $('status-dot').className=`status-dot ${connectionError?'paused':state.status==='available'&&!old?'available':state.running?'running':['paused','error'].includes(state.status)?'paused':''}`;
}
function render(next){
  state=next;StockHistoryView.render(state);const config=state.config;const stores=Array.isArray(state.stores)?state.stores.slice(0,config.maxStores):[];
  const firstAvailable=stores.find(store=>store.availability==='available');
  setText('status-description',state.error||(state.status==='checking'?'服务器正在读取官网自提状态。':!config.address?'先配置目标规格与所在省、市、区县。':state.status==='available'&&firstAvailable?`官网列表首家可自提：${firstAvailable.name}。请到官网核对。`:state.running?'服务器会按设置间隔持续检查附近门店。':'配置已保存在服务器，开始后持续检查官网页面。'));
  setText('last-check',state.lastCheckAt?`检查于 ${new Date(state.lastCheckAt).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})}`:'尚未检查');
  setText('checks',state.checks||0);setText('store-count',stores.length);setText('available-count',stores.filter(store=>store.availability==='available').length);
  setText('product-name',config.productName||config.partNumber);setText('product-meta',config.partNumber);setText('address-summary',config.address||'请设置所在地区');
  const push=Boolean(state.notificationsEnabled&&config.notifyEnabled);
  setText('notification-label',!state.notificationsEnabled?'未配置推送':push?'服务器推送已开':'服务器推送已关');
  $('notification-dot').className=`status-dot ${push?'running':''}`;
  $('stores').replaceChildren(...stores.map(store=>{
    const row=document.createElement('li');row.className='store';const top=document.createElement('div');top.className='store-top';
    const availability=['available','unavailable','unknown'].includes(store.availability)?store.availability:'unknown';
    const badge=document.createElement('span');badge.className=`availability ${availability}`;badge.textContent={available:'可自提',unavailable:'暂无',unknown:'未知'}[availability];
    const name=document.createElement('span');name.className='store-name';name.textContent=store.name||'门店名称未返回';top.append(badge,name);
    if(store.distanceText){const distance=document.createElement('span');distance.className='distance';distance.textContent=store.distanceText;top.append(distance);}
    const detail=document.createElement('p');detail.className='store-detail';detail.textContent=[store.availabilityText,store.pickupText,store.address].filter(Boolean).join(' · ');row.append(top,detail);return row;
  }));
  $('empty-stores').hidden=stores.length>0;setText('toggle',state.running?'暂停':'开始监控');renderNotice();updateClock();syncControls();
}
async function loadState(){const revision=viewRevision;try{const result=await api('/api/state');if(!authenticated||revision!==viewRevision)return;connectionError='';render(result.state);}catch(error){if(!authenticated||revision===viewRevision)throw error;}}
async function action(path){
  if(busy||!authenticated)return;viewRevision++;busy=true;operationError='';syncControls();
  try{const result=await api(path,{method:'POST',data:{}});connectionError='';if(authenticated)render(result.state);}
  catch(error){operationError=error.message;if(authenticated)renderNotice();}
  finally{busy=false;syncControls();}
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;syncControls();$('login-error').hidden=true;
  try{const result=await api('/api/login',{method:'POST',data:{password:$('password').value},allowUnauthorized:true});if(result.unauthorized)throw new Error(result.error||'管理密码不正确，请重试。');authenticated=true;await loadState();showDashboard();}
  catch(error){showLogin(error.message);}
  finally{$('password').value='';busy=false;syncControls();}
});
$('logout').addEventListener('click',async()=>{if(busy)return;busy=true;syncControls();try{await api('/api/logout',{method:'POST',data:{}});showLogin();}catch(error){if(authenticated){operationError=error.message;renderNotice();}}finally{busy=false;syncControls();}});
$('toggle').addEventListener('click',()=>action(state?.running?'/api/stop':'/api/start'));
$('check-now').addEventListener('click',()=>action('/api/check'));
$('configure').addEventListener('click',()=>{
  if(!state||busy)return;const config=state.config;
  $('preset').value=Object.keys(PRESETS).find(key=>PRESETS[key].partNumber===config.partNumber)||'custom';
  for(const[key,id]of Object.entries({productName:'product-name-input',partNumber:'part-number',productUrl:'product-url',address:'address',intervalSeconds:'interval-seconds',maxStores:'max-stores'}))$(id).value=config[key]??'';
  $('notify-enabled').checked=Boolean(config.notifyEnabled);setText('push-help',state.notificationsEnabled?'推送渠道由服务器环境配置，本页不保存推送密钥。':'服务器未配置推送渠道。可保存此偏好，推送渠道需在服务器环境中设置。');$('settings-error').hidden=true;$('settings').showModal();
});
$('close-settings').addEventListener('click',()=>{if(!busy)$('settings').close();});
$('preset').addEventListener('change',()=>{const preset=PRESETS[$('preset').value];if(preset){$('product-name-input').value=preset.productName;$('part-number').value=preset.partNumber;$('product-url').value=preset.productUrl;}});
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;viewRevision++;busy=true;operationError='';syncControls();
  try{
    const config={productName:$('product-name-input').value.trim(),partNumber:$('part-number').value.trim().toUpperCase(),productUrl:$('product-url').value.trim(),address:$('address').value.trim(),intervalSeconds:Number($('interval-seconds').value),maxStores:Number($('max-stores').value),notifyEnabled:$('notify-enabled').checked};
    if(!Number.isInteger(config.intervalSeconds)||config.intervalSeconds<30||config.intervalSeconds>3600)throw new Error('检查间隔须为 30–3600 秒。');
    if(!Number.isInteger(config.maxStores)||config.maxStores<1||config.maxStores>20)throw new Error('展示门店数须为 1–20。');
    const result=await api('/api/config',{method:'POST',data:{config}});connectionError='';if(authenticated){render(result.state);$('settings').close();}
  }catch(error){if(authenticated){setText('settings-error',error.message);$('settings-error').hidden=false;}}
  finally{busy=false;syncControls();}
});
async function initialize(){
  try{const session=await api('/api/session',{allowUnauthorized:true});if(session.unauthorized||session.authenticated!==true){showLogin();return;}authenticated=true;await loadState();showDashboard();}
  catch(error){showLogin(error.message);}
}
syncControls();void initialize();
setInterval(updateClock,1000);
setInterval(async()=>{if(!authenticated||busy||polling)return;polling=true;try{await loadState();}catch(error){if(authenticated){connectionError=error.message;renderNotice();updateClock();}}finally{polling=false;}},5000);
