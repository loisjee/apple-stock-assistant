(() => {
  const hostId = 'shike-stock-extension-root';
  if (document.getElementById(hostId)) return;
  const host = document.createElement('div');
  host.id = hostId;
  const shadow = host.attachShadow({mode: 'closed'});
  const style = document.createElement('style');
  style.textContent = ':host{all:initial!important;position:fixed!important;right:16px!important;top:72px!important;z-index:2147483647!important;display:block!important}iframe{width:310px;height:min(578px,calc(100vh - 94px));max-width:calc(100vw - 30px);border:1px solid #e7edf5;border-radius:13px;background:#fff;box-shadow:0 10px 40px #1d335324;display:block}button{all:initial;display:none;background:#0a84f7;color:#fff;border-radius:22px;padding:11px 14px;cursor:pointer;font:11px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 5px 20px #1d335324}button:focus-visible{outline:3px solid #87b6ff;outline-offset:3px}';
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL(`panel.html?embedded=1&parent=${encodeURIComponent(location.origin)}`);
  frame.title = 'Apple · 抢购助手';
  const reopen = document.createElement('button');
  reopen.textContent = 'Apple · 抢购助手';
  const collapse = (value) => {frame.style.display = value ? 'none' : 'block'; reopen.style.display = value ? 'block' : 'none';};
  // Shared only with this extension's isolated content-script world.
  // Temporarily remove our overlay from hit testing while clicking the page.
  let suspended = 0;
  globalThis.__shikeOverlay = {
    suspend() { suspended += 1; frame.style.visibility = 'hidden'; reopen.style.visibility = 'hidden'; },
    resume() { suspended = Math.max(0, suspended - 1); if (!suspended) { frame.style.visibility = ''; reopen.style.visibility = ''; } },
  };
  reopen.addEventListener('click', () => collapse(false));
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
    if (event.data?.type === 'SHIKE_COLLAPSE') collapse(true);
  });
  shadow.append(style, frame, reopen);
  document.documentElement.append(host);
})();
