const $=id=>document.getElementById(id);
const extension=typeof chrome!=='undefined'&&Boolean(chrome.runtime?.id);
const query=new URLSearchParams(location.search);
const PRESETS={duo:{productName:'iPhone Duo 1TB 星光白色',partNumber:'MK2T4CH/A',productUrl:'https://www.apple.com.cn/shop/product/MK2T4CH/A'},test:{productName:'iPhone 18 Pro Max 1TB 冰川蓝色',partNumber:'MJYJ4CH/A',productUrl:'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a'}};
const LABELS={idle:'等待开始',checking:'正在检查官网',watching:'正在监控',available:'发现可自提门店',paused:'监控已暂停',error:'需要检查页面'};
const CONTROLS=['toggle','check-now','open-monitor','test-notification','configure','save-settings'];
let state=null,busy=false,operationError='';
let demo={config:{...PRESETS.duo,address:'',intervalSeconds:60,maxStores:10,notifyEnabled:true},running:false,status:'idle',notice:'界面预览 · 未连接官网，不会打开网站或发送真实提醒。',error:'',checks:0,lastCheckAt:0,nextCheckAt:0,tabId:null,stores:[{id:'demo-1',name:'附近门店示例一',address:'此行仅用于界面展示',distanceText:'',availability:'unavailable',availabilityText:'暂无可自提库存',pickupText:''},{id:'demo-2',name:'附近门店示例二',address:'实际顺序以官网为准',distanceText:'',availability:'unknown',availabilityText:'等待官网返回状态',pickupText:''}]};
if(!extension)document.documentElement.classList.add('preview-mode');
if(query.has('embedded'))document.body.classList.add('embedded');else $('collapse').hidden=true;
$('purchase-link').href=`panel.html${location.search}`;
function setText(id,value){$(id).textContent=String(value??'');}
async function rpc(type,data={}){
  if(!extension){
    if(type==='PICKUP_SAVE_CONFIG'){demo.config=structuredClone(data.config);demo.notice='预览配置已保存，未连接官网。';}
    else if(type==='PICKUP_START'){if(!demo.config.address.trim())throw new Error('请先配置所在省、市、区县。');demo.running=true;demo.status='watching';demo.notice='预览：监控界面已启动，不会打开或操作真实网站。';demo.nextCheckAt=Date.now()+demo.config.intervalSeconds*1000;}
    else if(type==='PICKUP_STOP'){demo.running=false;demo.status='paused';demo.notice='预览监控已暂停。';demo.nextCheckAt=0;}
    else if(type==='PICKUP_CHECK_NOW'){if(!demo.config.address.trim())throw new Error('请先配置所在省、市、区县。');demo.checks++;demo.lastCheckAt=Date.now();demo.notice='预览检查完成。下方为示例数据，非真实库存。';}
    else if(type!=='PICKUP_GET_STATE')throw new Error('此功能需先在 Chrome / Edge 中加载插件。');
    return structuredClone(demo);
  }
  const response=await chrome.runtime.sendMessage({type,...data});
  if(!response?.ok)throw new Error(response?.error||'无法连接插件后台，请重新加载扩展。');
  return response.state;
}
function isStale(){return Boolean(state?.stale||state?.lastCheckAt&&Date.now()-state.lastCheckAt>Math.max(120000,(state.config.intervalSeconds||60)*2000));}
function updateControls(){
  for(const id of CONTROLS)$(id).disabled=busy||!state;
  if(state&&!busy){const noAddress=!state.config.address?.trim();$('toggle').disabled=!state.running&&noAddress;$('check-now').disabled=noAddress;$('toggle').title=noAddress?'请先配置所在地区':'';}
}
function showNotice(){const message=operationError||state?.error||state?.notice||'';setText('notice',message);$('notice').hidden=!message;}
function render(next){
  state=next;const config=state.config;const stores=Array.isArray(state.stores)?state.stores.slice(0,config.maxStores):[];const stale=isStale();const nearest=stores.find(store=>store.availability==='available');
  setText('status-title',stale&&state.status==='available'?'上次发现可自提':LABELS[state.status]||'等待页面反馈');
  setText('status-tag',!extension?'演示模式':'页面读取');
  $('status-dot').className=`status-dot ${state.status==='available'&&!stale?'available':state.running?'running':['paused','error'].includes(state.status)?'paused':''}`;
  setText('status-description',state.error||(state.status==='checking'?'正在读取官网自提门店状态。':!config.address?'先配置目标规格及所在省、市、区县。':state.status==='available'&&nearest?`${stale?'上次结果中首家可自提':'最近可自提（官网排序）'}：${nearest.name}${nearest.distanceText?' · '+nearest.distanceText:''}。请到官网确认。`:state.running?'按设置间隔检查附近门店，发现可自提时提醒。':'配置保存在本机，开始后打开专用官网监控页。'));
  setText('last-check',state.lastCheckAt?`检查于 ${new Date(state.lastCheckAt).toLocaleTimeString('zh-CN',{hour12:false})}`:'尚未检查');
  setText('checks',state.checks||0);setText('store-count',stores.length);setText('available-count',stores.filter(store=>store.availability==='available').length);
  setText('product-name',config.productName||config.partNumber);setText('product-meta',config.partNumber);setText('address-summary',config.address||'请设置所在地区');
  setText('notification-label',config.notifyEnabled?'系统提醒已开':'系统提醒已关');
  setText('freshness',!extension?'示例数据':!state.lastCheckAt?'等待首次检查':stale?'上次结果 · 已过期':'上次检查结果');
  $('stores').classList.toggle('stale',stale);
  $('stores').replaceChildren(...stores.map(store=>{
    const row=document.createElement('li');row.className='store';
    const top=document.createElement('div');top.className='store-top';
    const availability=['available','unavailable','unknown'].includes(store.availability)?store.availability:'unknown';
    const badge=document.createElement('span');badge.className=`availability ${availability}`;badge.textContent={available:'可自提',unavailable:'暂无',unknown:'未知'}[availability];
    const name=document.createElement('span');name.className='store-name';name.textContent=store.name||'门店名称未返回';
    top.append(badge,name);
    if(store.distanceText){const distance=document.createElement('span');distance.className='distance';distance.textContent=store.distanceText;top.append(distance);}
    const detail=document.createElement('p');detail.className='store-detail';detail.textContent=[...new Set([store.availabilityText,store.pickupText,store.address].filter(Boolean))].join(' · ');
    row.append(top,detail);return row;
  }));
  $('empty-stores').hidden=stores.length>0;
  setText('toggle',state.running?'暂停':'开始监控');
  if(!extension)setText('fineprint','界面预览 · 示例库存 · 不会操作官网或下单');
  showNotice();updateControls();updateCountdown();
}
function updateCountdown(){if(!state)return;const seconds=Math.ceil(((state.nextCheckAt||0)-Date.now())/1000);setText('next-check',state.running?(seconds>0?`${seconds} 秒后检查`:'等待页面反馈'):`每 ${state.config.intervalSeconds} 秒`);if(extension&&isStale()){setText('freshness','上次结果 · 已过期');$('stores').classList.add('stale');if(state.status==='available'){setText('status-title','上次发现可自提');$('status-dot').classList.remove('available');}}}
async function action(type){if(busy)return;busy=true;operationError='';updateControls();try{render(await rpc(type));}catch(error){operationError=error.message;}finally{busy=false;updateControls();showNotice();}}
function openSettings(){if(!state||busy)return;const config=state.config;$('preset').value=Object.keys(PRESETS).find(key=>PRESETS[key].partNumber===config.partNumber)||'custom';for(const [key,id] of Object.entries({productName:'product-name-input',partNumber:'part-number',productUrl:'product-url',address:'address',intervalSeconds:'interval-seconds',maxStores:'max-stores'}))$(id).value=config[key]??'';$('notify-enabled').checked=Boolean(config.notifyEnabled);$('settings-error').hidden=true;$('settings').showModal();}
$('configure').addEventListener('click',openSettings);
$('close-settings').addEventListener('click',()=>{if(!busy)$('settings').close();});
$('preset').addEventListener('change',()=>{const preset=PRESETS[$('preset').value];if(preset){$('product-name-input').value=preset.productName;$('part-number').value=preset.partNumber;$('product-url').value=preset.productUrl;}});
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;operationError='';updateControls();
  try{
    const config={productName:$('product-name-input').value.trim(),partNumber:$('part-number').value.trim().toUpperCase(),productUrl:$('product-url').value.trim(),address:$('address').value.trim(),intervalSeconds:Number($('interval-seconds').value),maxStores:Number($('max-stores').value),notifyEnabled:$('notify-enabled').checked};
    if(!Number.isInteger(config.intervalSeconds)||config.intervalSeconds<30||config.intervalSeconds>3600)throw new Error('检查间隔须为 30–3600 秒。');
    if(!Number.isInteger(config.maxStores)||config.maxStores<1||config.maxStores>20)throw new Error('展示门店数须为 1–20。');
    render(await rpc('PICKUP_SAVE_CONFIG',{config}));$('settings').close();
  }catch(error){setText('settings-error',error.message);$('settings-error').hidden=false;}finally{busy=false;updateControls();}
});
$('toggle').addEventListener('click',()=>action(state?.running?'PICKUP_STOP':'PICKUP_START'));
for(const [id,type] of Object.entries({'check-now':'PICKUP_CHECK_NOW','open-monitor':'PICKUP_OPEN','test-notification':'PICKUP_TEST_NOTIFICATION'}))$(id).addEventListener('click',()=>action(type));
$('collapse').addEventListener('click',()=>{const parent=query.get('parent');if(parent&&/^https:\/\/(?:www|secure\d*\.www)\.apple\.com\.cn$/.test(parent))window.parent.postMessage({type:'SHIKE_COLLAPSE'},parent);});
if(extension)chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.pickupMonitorState?.newValue){operationError='';render(changes.pickupMonitorState.newValue);}});
updateControls();rpc('PICKUP_GET_STATE').then(render).catch(error=>{operationError=error.message;showNotice();});
setInterval(updateCountdown,1000);
