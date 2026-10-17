// Notification destination is supplied by server environment, never client config.
const text=(value,limit=300)=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,limit);
const failure=()=>new Error('通知发送失败，请检查服务器通知配置与网络。');

export function createWebhookNotifier({url='',fetchImpl=globalThis.fetch,timeoutMs=10000,allowHttpLoopback=false,timers={setTimeout,clearTimeout}}={}){
  if(!url)return null;
  let destination;
  try{destination=new URL(url);}catch{throw new Error('服务器通知地址格式不正确。');}
  const loopback=['localhost','127.0.0.1','[::1]'].includes(destination.hostname);
  if(destination.username||destination.password||destination.hash||(destination.protocol!=='https:'&&!(allowHttpLoopback&&destination.protocol==='http:'&&loopback)))throw new Error('服务器通知地址须使用 HTTPS。');
  if(typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new Error('服务器通知配置无效。');
  return async(payload,{signal}={})=>{
    const body={event:'pickup.available',productName:text(payload?.productName,160),partNumber:text(payload?.partNumber,30),
      stores:(Array.isArray(payload?.stores)?payload.stores:[]).slice(0,20).map(store=>({id:text(store.id),name:text(store.name),distanceText:text(store.distanceText),availability:store.availability==='available'?'available':'unknown',availabilityText:text(store.availabilityText),pickupText:text(store.pickupText)})),
      checkedAt:Number.isFinite(payload?.checkedAt)?payload.checkedAt:Date.now()};
    const controller=new AbortController(),abort=()=>controller.abort();
    if(signal?.aborted)throw failure();
    signal?.addEventListener('abort',abort,{once:true});
    const timeout=timers.setTimeout(abort,timeoutMs);
    try{
      const response=await fetchImpl(destination.href,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:controller.signal});
      if(controller.signal.aborted||!response?.ok||response.status>=300)throw failure();
      return {ok:true};
    }catch{throw failure();}
    finally{timers.clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
  };
}
