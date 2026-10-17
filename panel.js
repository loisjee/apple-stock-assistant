const $=id=>document.getElementById(id);
const extension=typeof chrome!=='undefined'&&Boolean(chrome.runtime?.id);
const embedded=new URLSearchParams(location.search).has('embedded');
$('pickup-mode').href='monitor.html'+location.search;
if(!extension)document.documentElement.classList.add('preview-mode');
if(embedded)document.body.classList.add('embedded');else $('collapse').hidden=true;
const PRESETS={duo:{partNumber:'MK2T4CH/A',productUrl:'https://www.apple.com.cn/shop/product/MK2T4CH/A'},test:{partNumber:'MJYJ4CH/A',productUrl:'https://www.apple.com.cn/shop/buy-iphone/iphone-18-pro/mjyj4ch/a'}};
const STEPS=[['product','商品规格页'],['bag','购物袋'],['guest','游客结账'],['shipping','配送信息与验证'],['billing','选择支付渠道'],['review','核对并提交订单'],['awaitingPayment','等待你付款']];
const SHIPPING_FIELDS={lastName:'last-name',firstName:'first-name',province:'province',city:'city',district:'district',detailAddress:'detail-address',recipientPhone:'recipient-phone',contactPhone:'contact-phone',email:'email'};
let state;
let demo={config:{...PRESETS.duo,fulfillment:'delivery',paymentMethod:'alipay',retrySeconds:5,maxRefreshes:0,maxTotal:0,quantity:1,submitEnabled:false,shipping:{}},running:false,scans:0,clicks:0,refreshes:0,errors:0,stage:'idle',error:'',notice:'界面预览 · 未连接官网，不会刷新页面或下单。',nextRetryAt:0,lastScanAt:0,tabId:null,order:{status:'idle',message:'先配置商品、金额上限及收货方式。',stage:'idle'}};
async function rpc(type,data={}){
  if(!extension){
    if(type==='SAVE_CONFIG'){demo.config=structuredClone(data.config);demo.order.message='预览配置已保存，不会操作官网。';}
    else if(type==='START'){demo.running=true;demo.stage='product';demo.order={status:'waiting',stage:'product',message:'预览：等待商品页按钮。不会打开或操作真实网站。'};}
    else if(type==='STOP'){demo.running=false;demo.order.status='paused';demo.order.message='预览已暂停。';}
    else if(type==='RESUME'){demo.running=true;demo.order.status='waiting';}
    else if(type==='CHECK_NOW'){demo.scans++;demo.lastScanAt=Date.now();}
    else if(type==='RESET'){demo.running=false;demo.stage='idle';demo.tabId=null;demo.order={status:'idle',stage:'idle',message:'预览已重置，不会自动开始。'};demo.scans=0;demo.clicks=0;demo.refreshes=0;}
    else if(type!=='GET_STATE')throw new Error('此功能需先在 Chrome / Edge 中加载插件。');
    return structuredClone(demo);
  }
  const response=await chrome.runtime.sendMessage({type,...data});
  if(!response?.ok)throw new Error(response?.error||'无法连接插件后台，请重新加载扩展。');
  return response.state;
}
function text(id,value){$(id).textContent=value;}
function showError(value){text('notice',value);$('notice').hidden=!value;if($('settings').open){text('settings-error',value);$('settings-error').hidden=!value;}}
function stepIndex(stage){
  const normalized=String(stage||'').toLowerCase();
  if(/awaiting|complete|pending/.test(normalized))return 6;
  if(/review|submit|processing/.test(normalized))return 5;
  if(/billing|paymentmethod/.test(normalized))return 4;
  if(/shipping|fulfillment|pickup|verification/.test(normalized))return 3;
  if(/signin|guest|privacy/.test(normalized))return 2;
  if(/bag|attach/.test(normalized))return 1;
  if(/product|entry|buy/.test(normalized))return 0;
  return -1;
}
function render(next){
  state=next;const config=state.config;const order=state.order||{};
  const rawPhase=state.stage||order.stage||'idle';const phase=['blocked','unknown'].includes(rawPhase)?order.awaitedStage?.[0]||order.lastAction?.stage||'product':rawPhase;const current=stepIndex(phase);
  const completed=order.status==='awaitingPayment'||phase==='awaitingPayment';
  const paused=!state.running&&['paused','human','uncertain'].includes(order.status);
  text('status-title',completed?'订单等待付款':state.running?'正在执行':paused?'已暂停，等你处理':'准备就绪');
  text('status-tag',!extension?'演示模式':state.running?'页面点击模式':completed?'已停止':'页面点击模式');
  $('status-dot').className=`status-dot ${completed?'complete':state.running?'running':paused?'paused':''}`;
  text('status-description',state.error||order.message||'从所选规格页开始，自动识别下一步按钮。');
  text('last-check',state.lastScanAt?`检查于 ${new Date(state.lastScanAt).toLocaleTimeString('zh-CN',{hour12:false})}`:'尚未检查页面');
  text('scans',state.scans||0);text('clicks',state.clicks||0);text('refreshes',state.refreshes||0);
  text('product-name',config.partNumber==='MK2T4CH/A'?'iPhone Duo 1TB 星光白色':config.partNumber==='MJYJ4CH/A'?'iPhone 18 Pro Max 1TB 冰川蓝色':config.partNumber);
  text('product-meta',`${config.partNumber} · 页面按钮操作`);
  text('fulfillment-label',config.fulfillment==='pickup'?'门店自提':'送货上门');text('payment-label',config.paymentMethod==='wechat'?'微信支付':'支付宝');text('submit-label',config.submitEnabled?`提交上限 ¥${config.maxTotal}`:'确认页暂停');
  text('stage-label',current>=0?`${current+1} / ${STEPS.length}`:'等待开始');
  $('workflow-list').replaceChildren(...STEPS.map(([key,label],index)=>{
    const row=document.createElement('li');row.className=`step ${index<current?'done':index===current?'current':''}`;
    const number=document.createElement('span');number.className='step-number';number.textContent=index<current?'✓':String(index+1);
    const name=document.createElement('span');name.textContent=label;
    const status=document.createElement('small');status.textContent=index<current?'已通过':index===current?(completed?'已停止':paused?'待处理':'当前步骤'):'';
    row.append(number,name,status);return row;
  }));
  text('toggle',state.running?'暂停':'开始抢购');$('toggle').disabled=completed;$('resume').disabled=Boolean(state.running||completed||!state.tabId&&extension);
  $('new-run').hidden=!completed;
  const message=state.notice||(!extension?demo.notice:'');text('notice',message);$('notice').hidden=!message;
  if(!extension)text('fineprint','界面预览 · 未连接官网 · 不会刷新或下单');
  updateCountdown();
}
function updateCountdown(){if(!state)return;const seconds=Math.ceil(((state.nextRetryAt||0)-Date.now())/1000);text('next-check',state.running?(seconds>0?`${seconds} 秒后重试`:'等待页面反馈'):`重试间隔 ${state.config.retrySeconds} 秒`);}
async function action(button,type){button.disabled=true;let failure='';try{render(await rpc(type));}catch(error){failure=error.message;}finally{button.disabled=false;if(state)render(state);if(failure)showError(failure);}}
function openSettings(){
  const config=state.config;
  $('preset').value=config.partNumber==='MK2T4CH/A'?'duo':config.partNumber==='MJYJ4CH/A'?'test':'custom';
  for(const [key,id] of Object.entries({partNumber:'part-number',productUrl:'product-url',fulfillment:'fulfillment',paymentMethod:'payment-method',retrySeconds:'retry-seconds',maxRefreshes:'max-refreshes',maxTotal:'max-total'}))$(id).value=config[key]??'';
  $('allow-submit').checked=Boolean(config.submitEnabled);
  for(const [key,id] of Object.entries(SHIPPING_FIELDS))$(id).value=config.shipping?.[key]||'';
  $('settings-error').hidden=true;$('settings').showModal();
}
$('configure').addEventListener('click',openSettings);$('close-settings').addEventListener('click',()=>$('settings').close());
$('preset').addEventListener('change',()=>{const preset=PRESETS[$('preset').value];if(preset){$('part-number').value=preset.partNumber;$('product-url').value=preset.productUrl;}});
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();$('save-settings').disabled=true;
  try{
    const config={partNumber:$('part-number').value.trim(),productUrl:$('product-url').value.trim(),fulfillment:$('fulfillment').value,paymentMethod:$('payment-method').value,retrySeconds:Number($('retry-seconds').value),maxRefreshes:Number($('max-refreshes').value),maxTotal:Number($('max-total').value),quantity:1,submitEnabled:$('allow-submit').checked,shipping:Object.fromEntries(Object.entries(SHIPPING_FIELDS).map(([key,id])=>[key,$(id).value.trim()]))};
    if(config.submitEnabled&&config.maxTotal<=0)throw new Error('允许提交订单时，请填写大于 0 的总额上限。');
    if(!Number.isInteger(config.retrySeconds)||config.retrySeconds<3||config.retrySeconds>30)throw new Error('重试间隔须为 3–30 秒。');
    render(await rpc('SAVE_CONFIG',{config}));$('settings').close();
  }catch(error){text('settings-error',error.message);$('settings-error').hidden=false;}finally{$('save-settings').disabled=false;}
});
$('toggle').addEventListener('click',()=>action($('toggle'),state.running?'STOP':'START'));
for(const [id,type] of Object.entries({resume:'RESUME','open-product':'OPEN_PRODUCT','open-bag':'OPEN_BAG','check-now':'CHECK_NOW','new-run':'RESET','test-notification':'TEST_NOTIFICATION'}))$(id).addEventListener('click',()=>action($(id),type));
$('collapse').addEventListener('click',()=>{const parent=new URLSearchParams(location.search).get('parent');if(parent&&/^https:\/\/(?:www|secure\d*\.www)\.apple\.com\.cn$/.test(parent))window.parent.postMessage({type:'SHIKE_COLLAPSE'},parent);});
if(extension)chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.app?.newValue)render(changes.app.newValue);});
rpc('GET_STATE').then(render).catch(error=>{showError(error.message);$('toggle').disabled=true;});
setInterval(updateCountdown,1000);
