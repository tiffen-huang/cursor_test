// Cursor Learn 中文同步字幕 —— content script
// 通过 background service worker 代理跨域请求（绕过页面 CORS 限制），
// 然后调用共享核心逻辑 window.__CLZS_CORE__(httpGet)。
(function () {
  "use strict";

  function httpGet(url) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "clzsFetch", url }, (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          if (res && res.ok) resolve(res.text);
          else reject(new Error((res && res.error) || "fetch failed: " + url));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  if (typeof window.__CLZS_CORE__ === "function") {
    window.__CLZS_CORE__(httpGet);
  } else {
    console.error("[CLZS] core.js 未加载");
  }
})();
