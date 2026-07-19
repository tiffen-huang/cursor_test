// 运行在页面主世界 (MAIN world) 的时间读取器。
// 内容脚本运行在隔离世界，无法读取 <mux-player> 由页面 JS 定义的 currentTime 访问器，
// 因此这里在主世界持续读取真实播放时间，并写入 <html data-clzs-ct>（属性经 DOM 跨世界共享）。
(function () {
  "use strict";
  if (window.__clzsTimeMain) return;
  window.__clzsTimeMain = true;

  function pick() {
    const players = document.querySelectorAll("mux-player, mux-video");
    for (const p of players) {
      const ct = p.currentTime;
      if (typeof ct === "number" && isFinite(ct)) return ct;
    }
    // 兜底：穿透 shadow DOM 找原生 <video> 的最大 currentTime
    let best = null;
    (function walk(root) {
      let list;
      try {
        list = root.querySelectorAll("*");
      } catch (_) {
        return;
      }
      for (const el of list) {
        if (el.tagName === "VIDEO") {
          const t = el.currentTime;
          if (isFinite(t) && (best === null || t > best)) best = t;
        }
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(document);
    return best;
  }

  function loop() {
    try {
      const t = pick();
      if (t != null)
        document.documentElement.setAttribute("data-clzs-ct", String(t));
    } catch (_) {}
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
