// Cursor Learn 中文同步字幕 —— background service worker
// 作为跨域 fetch 代理：content script 无法直接请求 mux.com / googleapis.com（CORS），
// 由拥有 host_permissions 的 service worker 代为请求并回传文本。

const ALLOWED_HOST_RE = /(^|\.)(mux\.com|googleapis\.com)$/i;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "clzsFetch" || typeof msg.url !== "string") return;

  let host;
  try {
    host = new URL(msg.url).hostname;
  } catch (_) {
    sendResponse({ ok: false, error: "invalid url" });
    return; // 同步返回
  }
  if (!ALLOWED_HOST_RE.test(host)) {
    sendResponse({ ok: false, error: "host not allowed: " + host });
    return;
  }

  fetch(msg.url, { credentials: "omit", cache: "no-store" })
    .then(async (r) => {
      const text = await r.text();
      if (!r.ok) {
        sendResponse({ ok: false, error: "HTTP " + r.status });
        return;
      }
      sendResponse({ ok: true, text });
    })
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));

  return true; // 异步 sendResponse
});
