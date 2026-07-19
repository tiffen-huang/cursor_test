// ==UserScript==
// @name         Cursor Learn 中文同步字幕 / Chinese Synced Subtitles
// @name:zh-CN   Cursor Learn 中文同步字幕
// @namespace    https://github.com/cursor-learn-zh-subs
// @version      1.0.0
// @description  在 Cursor 官方教程站 (cursor.com/learn) 的英文视频正下方同步显示中文字幕：拉取 Mux 英文字幕 → 机翻中文 → 按 currentTime 实时同步。支持中英双语与重新翻译。
// @description:zh-CN 在 Cursor Learn 英文视频正下方同步显示中文字幕（Mux 英文字幕 → 机翻 → 按播放进度同步）。
// @author       cursor-learn-zh-subs
// @match        https://cursor.com/*
// @match        https://www.cursor.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      mux.com
// @connect      edgemv.mux.com
// @connect      stream.mux.com
// @connect      translate.googleapis.com
// @connect      googleapis.com
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/cursor-learn-zh-subs
// ==/UserScript==

/* eslint-disable no-undef */
(function () {
  "use strict";

  // ------------------------------------------------------------------
  // 配置
  // ------------------------------------------------------------------
  const LOG_PREFIX = "[CLZS]";
  const CACHE_VERSION = 1;

  // slug -> Mux playbackId 兜底表（当页面上拿不到 playback-id 时使用）。
  // 只要页面能读到 playback-id，就不需要这张表；这里保留已知条目方便离线兜底。
  const SLUG_PLAYBACK_MAP = {
    "how-ai-models-work": "00SK9XD8m5fIm100PWABbCMNLn00geS7EwpcGM7JQW02oaU",
  };

  const log = (...a) => console.log(LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(LOG_PREFIX, ...a);

  // ------------------------------------------------------------------
  // 跨域 HTTP（Tampermonkey / Greasemonkey 通用）
  // ------------------------------------------------------------------
  function gmGet(url) {
    return new Promise((resolve, reject) => {
      const fn =
        (typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest) ||
        (typeof GM !== "undefined" && GM.xmlHttpRequest);
      if (!fn) {
        // 退化为普通 fetch（部分资源可能因 CORS 失败）。
        fetch(url)
          .then((r) => r.text())
          .then(resolve)
          .catch(reject);
        return;
      }
      fn({
        method: "GET",
        url,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error("HTTP " + res.status + " for " + url));
        },
        onerror: () => reject(new Error("Network error for " + url)),
        ontimeout: () => reject(new Error("Timeout for " + url)),
        timeout: 30000,
      });
    });
  }

  // ------------------------------------------------------------------
  // 共享核心逻辑（与扩展 content.js 保持一致）
  // ------------------------------------------------------------------
  CLZSCore(gmGet);

  // ==================================================================
  // 下面是与浏览器扩展共享的核心实现。为便于单文件分发，此处内联一份。
  // httpGet: (url) => Promise<string>
  // ==================================================================
  function CLZSCore(httpGet) {
    const STATE = {
      playbackId: null,
      mediaEl: null,
      cues: [], // [{s,e,en,zh}]
      panel: null,
      zhLine: null,
      enLine: null,
      statusLine: null,
      bilingual: true,
      activeIdx: -1,
      running: false,
      rafId: null,
    };

    // ---------- Mux 字幕抓取 ----------
    function parseAttrs(line) {
      const attrs = {};
      const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
      let m;
      while ((m = re.exec(line))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
      return attrs;
    }

    async function getSubtitlePlaylistUrl(playbackId) {
      const master = await httpGet(
        "https://stream.mux.com/" + playbackId + ".m3u8"
      );
      const lines = master.split(/\r?\n/);
      let best = null;
      for (const line of lines) {
        if (!line.startsWith("#EXT-X-MEDIA:")) continue;
        if (!/TYPE=SUBTITLES/.test(line)) continue;
        const a = parseAttrs(line);
        if (!a.URI) continue;
        const lang = (a.LANGUAGE || "").toLowerCase();
        const cand = { uri: a.URI, lang, name: a.NAME || "" };
        if (lang.startsWith("en")) return cand.uri; // 优先英文
        if (!best) best = cand;
      }
      if (best) return best.uri;
      throw new Error("在 Mux master playlist 中未找到字幕轨");
    }

    async function fetchAllVttCues(playbackId) {
      const subPlaylistUrl = await getSubtitlePlaylistUrl(playbackId);
      const playlist = await httpGet(subPlaylistUrl);
      const base = subPlaylistUrl.replace(/[^/]*$/, "");
      const segUrls = playlist
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => (/^https?:/i.test(l) ? l : base + l));

      const texts = await Promise.all(segUrls.map((u) => httpGet(u).catch(() => "")));
      const cues = [];
      const seen = new Set();
      for (const vtt of texts) {
        for (const c of parseVtt(vtt)) {
          const key = c.s.toFixed(3) + "|" + c.text;
          if (seen.has(key)) continue;
          seen.add(key);
          cues.push(c);
        }
      }
      cues.sort((a, b) => a.s - b.s);
      return cues;
    }

    function tsToSec(ts) {
      // hh:mm:ss.mmm 或 mm:ss.mmm
      const parts = ts.split(":");
      let s = 0;
      for (const p of parts) s = s * 60 + parseFloat(p);
      return s;
    }

    function parseVtt(text) {
      if (!text) return [];
      const out = [];
      const blocks = text.replace(/\r/g, "").split(/\n\n+/);
      for (const block of blocks) {
        const lines = block.split("\n").filter((l) => l.length);
        const idx = lines.findIndex((l) => l.includes("-->"));
        if (idx === -1) continue;
        const m = lines[idx].match(
          /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})/
        );
        if (!m) continue;
        const s = tsToSec(m[1].replace(",", "."));
        const e = tsToSec(m[2].replace(",", "."));
        const textLines = lines.slice(idx + 1);
        const raw = textLines
          .join(" ")
          .replace(/<[^>]+>/g, "") // 去掉 VTT 标签
          .replace(/\s+/g, " ")
          .trim();
        if (!raw) continue;
        out.push({ s, e, en: raw, text: raw, zh: "" });
      }
      return out;
    }

    // ---------- 翻译（批量 + 缓存） ----------
    function lsGet(k) {
      try {
        return localStorage.getItem(k);
      } catch (_) {
        return null;
      }
    }
    function lsSet(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch (_) {}
    }

    function cacheKey(playbackId) {
      return "clzs:cues:v" + CACHE_VERSION + ":" + playbackId;
    }

    async function translateCues(playbackId, cues, onProgress) {
      // 先按字符预算/条数分批
      const batches = [];
      let cur = [];
      let curLen = 0;
      for (const c of cues) {
        const one = c.en.replace(/\n+/g, " ");
        if ((curLen + one.length > 1400 || cur.length >= 80) && cur.length) {
          batches.push(cur);
          cur = [];
          curLen = 0;
        }
        cur.push(one);
        curLen += one.length + 1;
      }
      if (cur.length) batches.push(cur);

      const results = [];
      let done = 0;
      for (const batch of batches) {
        let translated;
        try {
          translated = await translateBatch(batch);
        } catch (e) {
          warn("批量翻译失败，逐条重试", e);
          translated = [];
          for (const t of batch) {
            try {
              translated.push((await translateBatch([t]))[0] || t);
            } catch (_) {
              translated.push(t);
            }
          }
        }
        if (translated.length !== batch.length) {
          // 对齐失败：逐条兜底
          translated = [];
          for (const t of batch) {
            try {
              translated.push((await translateBatch([t]))[0] || t);
            } catch (_) {
              translated.push(t);
            }
          }
        }
        for (const t of translated) results.push(t);
        done += batch.length;
        if (onProgress) onProgress(done, cues.length);
      }

      for (let i = 0; i < cues.length; i++) cues[i].zh = results[i] || cues[i].en;
      lsSet(
        cacheKey(playbackId),
        JSON.stringify({
          v: CACHE_VERSION,
          cues: cues.map((c) => ({ s: c.s, e: c.e, en: c.en, zh: c.zh })),
        })
      );
      return cues;
    }

    async function translateBatch(texts) {
      const q = texts.join("\n");
      const url =
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=" +
        encodeURIComponent(q);
      const raw = await httpGet(url);
      const data = JSON.parse(raw);
      let joined = "";
      if (Array.isArray(data) && Array.isArray(data[0])) {
        for (const seg of data[0]) if (seg && seg[0]) joined += seg[0];
      }
      const lines = joined.split("\n");
      // 规整：去掉尾部空白行差异
      while (lines.length > texts.length && lines[lines.length - 1].trim() === "")
        lines.pop();
      return lines.map((l) => l.trim());
    }

    // ---------- 播放器 & DOM ----------
    function findMediaEl() {
      return (
        document.querySelector("mux-player") ||
        document.querySelector("mux-video") ||
        document.querySelector("video")
      );
    }

    function detectPlaybackId(mediaEl) {
      if (mediaEl) {
        const pid =
          mediaEl.getAttribute && mediaEl.getAttribute("playback-id");
        if (pid) return pid.trim();
      }
      // 兜底：从 URL slug 推断
      const m = location.pathname.match(/\/learn\/([^/?#]+)/);
      if (m && SLUG_PLAYBACK_MAP[m[1]]) return SLUG_PLAYBACK_MAP[m[1]];
      return null;
    }

    function findVideoContainer(mediaEl) {
      let el = mediaEl;
      for (let i = 0; el && i < 8; i++) {
        if (el.classList && [...el.classList].some((c) => c.includes("aspect-video")))
          return el;
        el = el.parentElement;
      }
      return mediaEl && mediaEl.parentElement;
    }

    function buildPanel() {
      const panel = document.createElement("div");
      panel.id = "clzs-panel";
      panel.setAttribute("data-clzs", "1");
      panel.style.cssText = [
        "position:sticky",
        "top:8px",
        "z-index:2147483000",
        "margin:10px 0 16px",
        "padding:12px 16px",
        "border-radius:12px",
        "background:rgba(17,17,20,0.92)",
        "color:#fff",
        "box-shadow:0 6px 24px rgba(0,0,0,0.28)",
        "backdrop-filter:blur(6px)",
        "font-family:system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif",
        "line-height:1.5",
      ].join(";");

      const bar = document.createElement("div");
      bar.style.cssText =
        "display:flex;align-items:center;gap:12px;margin-bottom:8px;font-size:12px;opacity:.85;";

      const title = document.createElement("span");
      title.textContent = "中文同步字幕";
      title.style.cssText = "font-weight:600;letter-spacing:.02em;";

      const status = document.createElement("span");
      status.id = "clzs-status";
      status.style.cssText = "flex:1;opacity:.8;";

      const biBtn = mkBtn(STATE.bilingual ? "双语：开" : "双语：关");
      biBtn.onclick = () => {
        STATE.bilingual = !STATE.bilingual;
        biBtn.textContent = STATE.bilingual ? "双语：开" : "双语：关";
        STATE.enLine.style.display = STATE.bilingual ? "block" : "none";
      };

      const reBtn = mkBtn("重新翻译");
      reBtn.onclick = () => {
        try {
          localStorage.removeItem(cacheKey(STATE.playbackId));
        } catch (_) {}
        start(true);
      };

      bar.append(title, status, biBtn, reBtn);

      const zh = document.createElement("div");
      zh.id = "clzs-zh";
      zh.style.cssText =
        "font-size:20px;font-weight:600;min-height:28px;color:#fff;";

      const en = document.createElement("div");
      en.id = "clzs-en";
      en.style.cssText =
        "font-size:14px;margin-top:4px;color:#c9c9cf;min-height:18px;display:" +
        (STATE.bilingual ? "block" : "none");

      panel.append(bar, zh, en);
      STATE.panel = panel;
      STATE.zhLine = zh;
      STATE.enLine = en;
      STATE.statusLine = status;
      return panel;
    }

    function mkBtn(label) {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = [
        "cursor:pointer",
        "border:1px solid rgba(255,255,255,0.25)",
        "background:rgba(255,255,255,0.08)",
        "color:#fff",
        "font-size:12px",
        "padding:4px 10px",
        "border-radius:999px",
      ].join(";");
      b.onmouseenter = () => (b.style.background = "rgba(255,255,255,0.18)");
      b.onmouseleave = () => (b.style.background = "rgba(255,255,255,0.08)");
      return b;
    }

    function mountPanel() {
      const container = findVideoContainer(STATE.mediaEl);
      if (!container || !container.parentElement) return false;
      const old = document.getElementById("clzs-panel");
      if (old) old.remove();
      const panel = buildPanel();
      container.insertAdjacentElement("afterend", panel);
      return true;
    }

    function setStatus(txt) {
      if (STATE.statusLine) STATE.statusLine.textContent = txt;
    }

    // ---------- 同步循环 ----------
    function currentTime() {
      const el = STATE.mediaEl;
      if (!el) return 0;
      if (typeof el.currentTime === "number") return el.currentTime;
      return 0;
    }

    function findCueIdx(t) {
      const cues = STATE.cues;
      // 线性/局部搜索即可（字幕量级不大）
      let idx = STATE.activeIdx;
      if (idx >= 0 && idx < cues.length && t >= cues[idx].s && t < cues[idx].e)
        return idx;
      // 二分
      let lo = 0,
        hi = cues.length - 1,
        res = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].s <= t) {
          res = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (res >= 0 && t < cues[res].e) return res;
      return -1;
    }

    function tick() {
      if (!STATE.running) return;
      const t = currentTime();
      const idx = findCueIdx(t);
      if (idx !== STATE.activeIdx) {
        STATE.activeIdx = idx;
        if (idx === -1) {
          STATE.zhLine.textContent = "";
          STATE.enLine.textContent = "";
        } else {
          STATE.zhLine.textContent = STATE.cues[idx].zh || STATE.cues[idx].en;
          STATE.enLine.textContent = STATE.cues[idx].en;
        }
      }
      STATE.rafId = requestAnimationFrame(tick);
    }

    function startTicking() {
      if (STATE.rafId) cancelAnimationFrame(STATE.rafId);
      STATE.running = true;
      STATE.activeIdx = -2;
      tick();
    }

    // ---------- 主流程 ----------
    async function start(force) {
      const mediaEl = findMediaEl();
      if (!mediaEl) return;
      const playbackId = detectPlaybackId(mediaEl);
      if (!playbackId) {
        warn("未能确定 playbackId");
        return;
      }
      STATE.mediaEl = mediaEl;
      STATE.playbackId = playbackId;

      if (!mountPanel()) {
        warn("未能挂载字幕面板");
        return;
      }

      setStatus("加载英文字幕…");

      // 缓存命中？
      if (!force) {
        const cached = lsGet(cacheKey(playbackId));
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.cues && parsed.cues.length) {
              STATE.cues = parsed.cues.map((c) => ({ ...c, text: c.en }));
              setStatus("已就绪（缓存）· " + STATE.cues.length + " 条");
              startTicking();
              return;
            }
          } catch (_) {}
        }
      }

      let cues;
      try {
        cues = await fetchAllVttCues(playbackId);
      } catch (e) {
        warn("字幕抓取失败", e);
        setStatus("字幕抓取失败：" + e.message);
        return;
      }
      if (!cues.length) {
        setStatus("未获取到字幕");
        return;
      }
      STATE.cues = cues;
      startTicking(); // 先显示英文，翻译好一段即可用
      setStatus("翻译中… 0/" + cues.length);

      try {
        await translateCues(playbackId, cues, (d, total) =>
          setStatus("翻译中… " + d + "/" + total)
        );
        setStatus("已就绪 · " + cues.length + " 条");
      } catch (e) {
        warn("翻译失败", e);
        setStatus("翻译部分失败（显示英文兜底）");
      }
      STATE.activeIdx = -2; // 强制刷新当前行
    }

    // ---------- SPA 路由 & 播放器变化监听 ----------
    function isLearnPage() {
      return /\/learn(\/|$|\?)/.test(location.pathname + location.search) ||
        /\/learn$/.test(location.pathname);
    }

    let lastKey = "";
    function maybeInit() {
      if (!isLearnPage()) {
        const old = document.getElementById("clzs-panel");
        if (old) old.remove();
        STATE.running = false;
        lastKey = "";
        return;
      }
      const mediaEl = findMediaEl();
      const pid = detectPlaybackId(mediaEl);
      const key = location.pathname + "::" + (pid || "");
      if (mediaEl && pid && key !== lastKey) {
        lastKey = key;
        log("初始化课程", pid);
        start(false);
      }
    }

    // 轮询 + history 补丁，兼容 Next.js 客户端路由与懒加载播放器
    const _push = history.pushState;
    history.pushState = function () {
      _push.apply(this, arguments);
      setTimeout(maybeInit, 300);
    };
    const _replace = history.replaceState;
    history.replaceState = function () {
      _replace.apply(this, arguments);
      setTimeout(maybeInit, 300);
    };
    window.addEventListener("popstate", () => setTimeout(maybeInit, 300));
    setInterval(maybeInit, 1200);
    maybeInit();

    log("已启动");
  }
})();
