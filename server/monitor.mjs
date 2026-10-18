import {restoreStockHistory, recordStockHistory} from '../stock-history.mjs';
import {readFile,mkdir,writeFile,rename,unlink,chmod} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {normalizePickupConfig,DEFAULT_PICKUP_CONFIG} from '../pickup-monitor.mjs';
import {isSafeEntryUrl} from '../core.mjs';
import {isReadonlyProductUrl} from './browser.mjs';

const text=(value,limit=300)=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,limit);
const clone=value=>structuredClone(value);
export function normalizeServerConfig(input={}){
  if(input?.productUrl){let url;try{url=new URL(input.productUrl);}catch{throw new Error('请填写有效的 Apple 中国官网商品链接。');}
    if(!isSafeEntryUrl(url)||url.search||url.hash||/(?:^|\/)(?:bag|checkout|attach|signin|sign-in|payment|billing)(?:\/|$)/i.test(url.pathname))throw new Error('监控链接须为无查询参数的官网商品页，不能包含购物袋或结账步骤。');}
  const config=normalizePickupConfig(input);
  if(!isReadonlyProductUrl(config.productUrl,config.partNumber))throw new Error('请使用包含目标商品编号的苹果中国官网具体商品链接。');
  if(config.address.length>200)throw new Error('当前位置最多填写 200 个字符。');
  return config;
}
function cleanStores(input,maxStores=20){
  const values=[],seen=new Set();
  for(const raw of Array.isArray(input)?input:[]){
    if(!raw||!['available','unavailable','unknown'].includes(raw.availability))continue;
    const name=text(raw.name).trim();if(!name)continue;
    const id=text(raw.id||`${name}|${raw.address||''}`);if(seen.has(id))continue;seen.add(id);
    values.push({id,name,address:text(raw.address),distanceText:text(raw.distanceText),availability:raw.availability,availabilityText:text(raw.availabilityText),pickupText:text(raw.pickupText)});
    if(values.length>=maxStores)break;
  }
  return values;
}
const initial=(config,now)=>({schemaVersion:1,config,running:false,status:'idle',notice:'填写目标商品与当前位置后开始监控。',error:'',checks:0,lastCheckAt:0,nextCheckAt:0,stores:[],stale:false,stockHistory:restoreStockHistory(null,now),history:[],errors:[],lastNotified:{},notification:{configured:false,lastSuccessAt:0,lastError:''},generation:0});
const keyFor=(config,id)=>createHash('sha256').update(JSON.stringify([config.partNumber,config.address.toLowerCase(),id])).digest('hex');

export class PickupMonitor{
  constructor({browser,storePath=resolve('data/state.json'),notify=null,now=Date.now,timers={setTimeout,clearTimeout}}={}){
    if(!browser||typeof browser.check!=='function')throw new Error('库存页面读取器未配置。');
    this.browser=browser;this.storePath=resolve(storePath);this.notify=typeof notify==='function'?notify:null;this.now=now;this.timers=timers;
    this._data=initial(normalizeServerConfig(DEFAULT_PICKUP_CONFIG),this.now());this._data.notification.configured=Boolean(this.notify);
    this._persistQueue=Promise.resolve();this._timer=null;this._flight=null;this._flightGeneration=null;this._controller=null;this._initialized=false;this._closed=false;this._initializing=null;
  }
  state(){return clone(this._data);}
  async _persist(){
    const path=this.storePath;
    const job=this._persistQueue.then(async()=>{const json=JSON.stringify(this._data,null,2)+'\n';await mkdir(dirname(path),{recursive:true,mode:0o700});const temporary=`${path}.${randomUUID()}.tmp`;try{await writeFile(temporary,json,{encoding:'utf8',mode:0o600});await rename(temporary,path);await chmod(path,0o600);}finally{await unlink(temporary).catch(()=>{});}});
    this._persistQueue=job.catch(()=>{});
    try{await job;}catch{this._cancel();this._data.generation++;this._data.running=false;this._data.status='error';this._data.error='监控状态无法保存，监控已暂停。请检查服务器数据目录的空间与权限。';this._data.notice=this._data.error;this._data.nextCheckAt=0;throw new Error(this._data.error);}
  }
  async init(){
    if(this._initialized)return this.state();if(this._initializing)return this._initializing;
    this._initializing=(async()=>{
      try{
        const content=await readFile(this.storePath,'utf8');if(Buffer.byteLength(content)>8*1024*1024)throw new Error('oversized state');const saved=JSON.parse(content);
        if(saved?.schemaVersion!==1)throw new Error('invalid schema');
        const config=normalizeServerConfig(saved.config),restored=initial(config,this.now());
        restored.stockHistory=restoreStockHistory(saved.stockHistory,this.now());
        restored.running=saved.running===true;restored.status=restored.running?'watching':'paused';restored.notice=restored.running?'服务已恢复，将继续检查附近门店。':'已恢复设置；监控处于暂停状态。';
        restored.checks=Number.isSafeInteger(saved.checks)&&saved.checks>=0?saved.checks:0;restored.lastCheckAt=Number.isFinite(saved.lastCheckAt)?saved.lastCheckAt:0;restored.stores=cleanStores(saved.stores,config.maxStores);restored.stale=restored.stores.length>0;
        restored.history=Array.isArray(saved.history)?saved.history.slice(-100).map(row=>({at:Number(row.at)||0,status:text(row.status,20),available:Number(row.available)||0,summary:text(row.summary)})):[];
        restored.errors=Array.isArray(saved.errors)?saved.errors.slice(-20).map(row=>({at:Number(row.at)||0,message:'此前检查未取得有效结果。'})):[];
        restored.lastNotified=Object.fromEntries(Object.entries(saved.lastNotified&&typeof saved.lastNotified==='object'?saved.lastNotified:{}).filter(([key,value])=>/^[a-f0-9]{64}$/.test(key)&&typeof value==='boolean').slice(-500));
        restored.notification={configured:Boolean(this.notify),lastSuccessAt:Number(saved.notification?.lastSuccessAt)||0,lastError:''};restored.generation=Number.isSafeInteger(saved.generation)?saved.generation+1:1;
        this._data=restored;
      }catch(error){if(error.code!=='ENOENT'){this._data.status='error';this._data.error='保存的监控状态无法读取，请重新保存设置。';this._data.running=false;}}
      this._initialized=true;await this._persist();if(this._data.running){this._data.nextCheckAt=this.now();this._schedule(0);}return this.state();
    })();return this._initializing;
  }
  _assertOpen(){if(this._closed)throw new Error('监控服务已关闭。');if(!this._initialized)throw new Error('监控服务尚未初始化。');}
  _clearTimer(){if(this._timer!==null){this.timers.clearTimeout(this._timer);this._timer=null;}}
  _cancel(){this._clearTimer();this._controller?.abort();}
  _schedule(delay){
    this._clearTimer();if(this._closed||!this._data.running)return;
    this._timer=this.timers.setTimeout(()=>{this._timer=null;void this._requestCheck().catch(()=>{});},delay);this._timer?.unref?.();
  }
  async saveConfig(input){
    this._assertOpen();const config=normalizeServerConfig(input),before=this._data.config;
    this._cancel();this._data.generation++;this._data.running=false;this._data.nextCheckAt=0;this._data.status='paused';this._data.config=config;this._data.error='';this._data.notice='设置已保存。点击开始后使用新设置监控。';
    if(before.partNumber!==config.partNumber||before.productUrl!==config.productUrl||before.address!==config.address){this._data.stores=[];this._data.stale=false;this._data.checks=0;this._data.lastCheckAt=0;this._data.history=[];this._data.errors=[];}
    await this._persist();return this.state();
  }
  async start(){
    this._assertOpen();if(!this._data.config.address)throw new Error('请先填写当前位置、城市或邮政编码。');if(this._data.running)return this.state();
    this._data.running=true;this._data.generation++;const generation=this._data.generation;this._data.status='watching';this._data.notice='正在等待官网库存检查。';this._data.error='';this._data.nextCheckAt=this.now();await this._persist();if(generation===this._data.generation)this._schedule(0);return this.state();
  }
  async stop(){
    this._assertOpen();this._cancel();this._data.generation++;this._data.running=false;this._data.status='paused';this._data.nextCheckAt=0;this._data.notice='库存监控已暂停。';await this._persist();return this.state();
  }
  async checkNow(){this._assertOpen();if(!this._data.config.address)throw new Error('请先填写当前位置、城市或邮政编码。');this._clearTimer();return this._requestCheck();}
  async _requestCheck(){
    if(this._closed)return this.state();const generation=this._data.generation;
    if(this._flight){if(this._flightGeneration===generation)return this._flight;await this._flight;if(this._closed||generation!==this._data.generation)return this.state();return this._requestCheck();}
    const controller=new AbortController();this._controller=controller;this._flightGeneration=generation;
    this._flight=this._performCheck(generation,controller).finally(()=>{this._flight=null;this._flightGeneration=null;if(this._controller===controller)this._controller=null;if(!this._closed&&this._data.running){const delay=Math.max(0,(this._data.nextCheckAt||this.now())-this.now());this._schedule(delay);}});
    return this._flight;
  }
  _current(generation,signal){return !this._closed&&!signal.aborted&&generation===this._data.generation;}
  _history(status,summary,available=0){this._data.history.push({at:this.now(),status,summary,available});this._data.history=this._data.history.slice(-100);}
  async _performCheck(generation,controller){
    const {signal}=controller,config=clone(this._data.config);this._data.status='checking';this._data.error='';this._data.notice='正在读取官网附近门店的自提库存。';this._data.nextCheckAt=0;await this._persist();
    let result;
    try{if(!this._current(generation,signal))return this.state();result=await this.browser.check(config,{signal});}
    catch{if(!this._current(generation,signal))return this.state();return this._failure(generation,'本次未能读取官网库存，将在下次检查时重试。');}
    if(!this._current(generation,signal))return this.state();
    this._data.lastCheckAt=this.now();this._data.checks++;
    if(result?.requiresHuman){this._data.running=false;this._data.status='paused';this._data.stale=this._data.stores.length>0;this._data.notice='官网要求人工处理安全验证或位置确认，监控已暂停。';this._data.nextCheckAt=0;this._history('paused',this._data.notice);await this._persist();return this.state();}
    const stores=result?.ok===true?cleanStores(result.stores,config.maxStores):[];
    if(!stores.length){const status=result?.diagnostic?.httpStatus,officialFailure=result?.diagnostic?.code==='OFFICIAL_HTTP_ERROR'&&Number.isInteger(status)&&status>=400&&status<=599;return this._failure(generation,officialFailure?`官网供货信息请求失败（HTTP ${status}），本轮没有库存结果。`:'官网暂未展示可识别的附近门店，保留上次结果并稍后重试。',{counted:true});}
    this._data.stockHistory=recordStockHistory(this._data.stockHistory,config,stores,this._data.lastCheckAt);
    this._data.stores=stores;this._data.stale=false;this._data.error='';const available=stores.filter(store=>store.availability==='available');this._data.status=available.length?'available':'watching';
    this._data.notice=available.length?`官网显示 ${available.length} 家门店可自提，请到官网核对。`:'已检查附近门店，继续等待可自提库存。';this._data.nextCheckAt=this._data.running?this.now()+config.intervalSeconds*1000:0;
    const newlyAvailable=[];
    for(const store of stores){const key=keyFor(config,store.id);if(store.availability==='unavailable')this._data.lastNotified[key]=false;else if(store.availability==='available'&&this._data.lastNotified[key]!==true)newlyAvailable.push({key,store});}
    this._data.lastNotified=Object.fromEntries(Object.entries(this._data.lastNotified).slice(-500));this._history(this._data.status,this._data.notice,available.length);await this._persist();
    if(!this._current(generation,signal))return this.state();
    if(this._current(generation,signal)&&config.notifyEnabled&&newlyAvailable.length&&this.notify){
      try{
        const response=await this.notify({event:'pickup.available',productName:config.productName,partNumber:config.partNumber,stores:newlyAvailable.map(item=>item.store),checkedAt:this._data.lastCheckAt},{signal});
        if(response===false||response?.ok===false)throw new Error('notification rejected');
        if(this._current(generation,signal)){for(const {key} of newlyAvailable)this._data.lastNotified[key]=true;this._data.lastNotified=Object.fromEntries(Object.entries(this._data.lastNotified).slice(-500));this._data.notification.lastSuccessAt=this.now();this._data.notification.lastError='';await this._persist();}
      }catch{if(this._current(generation,signal)){this._data.notification.lastError='通知发送失败，将在下次确认有货时重试。';this._data.notice='已发现可自提库存，但通知发送失败。请检查服务器通知配置；下次检查会重试。';await this._persist();}}
    }else if(available.length&&!this.notify){this._data.notice+=' 当前仅在仪表盘显示，尚未配置外部通知。';await this._persist();}
    return this.state();
  }
  async _failure(generation,message,{counted=false}={}){
    if(this._closed||generation!==this._data.generation)return this.state();if(!counted){this._data.checks++;this._data.lastCheckAt=this.now();}
    this._data.status='error';this._data.error=message;this._data.notice=this._data.stores.length?'本次检查失败，以下保留上次门店记录。':'本次检查失败，等待下次重试。';this._data.stale=true;this._data.nextCheckAt=this._data.running?this.now()+this._data.config.intervalSeconds*1000:0;
    this._data.errors.push({at:this.now(),message});this._data.errors=this._data.errors.slice(-20);this._history('error',message);await this._persist();return this.state();
  }
  async close(){
    if(this._closed)return;this._closed=true;this._cancel();this._data.generation++;this._data.nextCheckAt=0;let persistenceError;
    try{await this._persist();}catch(error){persistenceError=error;}
    try{await this.browser.close?.();}finally{await this._flight?.catch(()=>{});await this._persistQueue;}
    if(persistenceError)throw persistenceError;
  }
}
