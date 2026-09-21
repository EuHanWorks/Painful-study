// ==UserScript==
// @name         学习通讨论题目采集自动回复
// @namespace    chaoxing/auto-reply-qa
// @version      1.2.8
// @description  只复制讨论题目（不复制评论）：题目发给其他 AI 要答案后，把【答案N】格式的答案块贴回面板保存，自动或手动发布到对应话题；无答案的话题发固定文案；已回复的话题自动跳过
// @author       李优涵
// @license      MIT
// @match        https://groupweb.chaoxing.com/course/topic/*
// @match        https://mooc2-ans.chaoxing.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // 防止同一页面被重复注入（避免出现两个面板）
  if (window.__cxarQaLoaded) return;
  window.__cxarQaLoaded = true;

  // ===== 存储键 =====
  const FALLBACK_KEY = "cxar_fallback";
  const FALLBACK_DEFAULT = "坚持自主创新";
  const POS_KEY = "cxar_qa_pos";
  const INTERVAL_KEY = "cxar_qa_interval";
  const DONE_PREFIX = "cxar_batch_done_";
  const QUEUE_KEY = "cxar_qa_queue";
  const SUMMARY_KEY = "cxar_qa_summary";
  const PENDING_KEY = "cxar_qa_pending";
  const LOG_KEY = "cxar_qa_log";
  const TOPICS_KEY = "cxar_qa_topics";
  const ANSWERS_TEXT_KEY = "cxar_qa_answers_text";
  const MIN_PAGE_MS = 5000;
  const MAX_ANSWER_LEN = 2000;
  const MAX_PASTE_LEN = 200000;
  const pageLoadTime = Date.now();

  // 当前激活的 Tab（列表页 / 话题页 各自维护）
  let activeTab = "collect";
  let activeTopicTab = "publish";

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    remove(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const leafText = (n) => (n.textContent || "").replace(/\s+/g, " ").trim();
  const stripHtml = (h) => {
    const d = document.createElement("div");
    d.innerHTML = h || "";
    return (d.textContent || "").replace(/\s+/g, " ").trim();
  };
  const parseList = (j) => {
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.data)) return j.data;
    if (j && j.data && Array.isArray(j.data.list)) return j.data.list;
    if (j && Array.isArray(j.list)) return j.list;
    return null;
  };
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const isHex32 = (s) => typeof s === "string" && /^[0-9a-f]{32}$/i.test(s);
  // 受控 textarea 的 value setter：绕过 React 的 value 劫持，让 input 事件能正常触发
  const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;

  // ===== 页面文字识别规则 =====
  const NOISE = /^(回复|点赞|举报|删除|展开|收起|更多|加载更多|查看全部|评论|赞|顶|踩|分享|置顶|编辑|收藏|时间倒序|时间顺序|按点赞数|按回复时间|按发布时间|最新|最热|热门|全部|回复他|回复她|跟帖|发起讨论|已折叠|展开更多|查看更多回复|共\d+条回复|取消|确定|课程积分)$/;
  const YEAR = /20\d{2}[-.]\d{2}/;
  const TIME = /^\d{4}[-/年]|^\d{1,2}[-月]|^\d{1,2}:\d{2}|^昨天|^今天|^刚刚|^\d+\s*(分钟|小时|天)前/;
  const NUM = /^\d+$/;
  const POST_MARKER = /^(老师|助教|置顶|楼主|阅读|浏览|查看)$/;

  function detectToast() {
    const n = [...document.querySelectorAll("div,span,p")].find(
      (x) =>
        /发布失败|请勿同时|提交失败|操作失败|网络异常/.test(x.textContent || "") &&
        x.children.length === 0 &&
        x.textContent.trim().length <= 40
    );
    return n ? n.textContent.trim() : "";
  }

  // ===== 捕获页面自己发出的请求 =====
  const capturedListData = { items: [] };
  function tryCaptureList(text) {
    try {
      const j = JSON.parse(text);
      if (!j || typeof j !== "object") return;
      const arr = parseList(j);
      if (!arr || !arr.length) return;
      // 只有条目带 topicId 字段才当话题列表，避免把评论数据误当话题
      const isTopicList = arr.some((it) => it && (it.topicId || it.topicid || it.topic_id));
      if (!isTopicList) return;
      const items = [];
      arr.forEach((it) => {
        const id = it.topicId || it.topicid || it.topic_id;
        if (!id) return;
        const title = stripHtml(it.title || it.topicTitle || it.subject || it.content || "").slice(0, 60);
        items.push({ id: String(id), title });
      });
      if (items.length) {
        capturedListData.items = items;
        try {
          if (document.getElementById("cxar-qa-panel") && !parseTopic().topicId) renderListPage();
        } catch (e) {}
      }
    } catch (e) {}
  }
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    p.then((r) => r.clone().text().then((t) => tryCaptureList(t))).catch(() => {});
    return p;
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__cxarUrl = String(url);
    return xhrOpen.call(this, method, url, ...rest);
  };
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...rest) {
    this.addEventListener("load", () => {
      const rt = this.responseType;
      if (rt && rt !== "text") return;
      tryCaptureList(this.responseText);
    });
    return xhrSend.apply(this, rest);
  };

  // ===== 话题解析与链接扫描 =====
  function parseTopic() {
    const parts = location.pathname.split("/");
    const i = parts.indexOf("bbs");
    const bbsId = i >= 0 ? parts[i + 1] : "";
    const topicId = i >= 0 ? parts[i + 2] : "";
    const route = i >= 0 ? parts[i + 3] : "";
    const sp = new URLSearchParams(location.search);
    const courseId = sp.get("courseId") || sp.get("courseid") || "";
    return { bbsId, topicId, courseId, route };
  }

  function scanTopicLinks() {
    const out = [];
    const seen = new Set();

    const tryUrl = (rawUrl, titleSrc) => {
      if (!rawUrl || /^javascript:/i.test(rawUrl) || rawUrl === "#") return;
      let u;
      try { u = new URL(rawUrl, location.href); } catch (e) { return; }
      const path = u.pathname;
      // 方式一：路径里有两个 32 位十六进制 id（bbsId/topicId），注意话题链接可能带 /replysList 尾巴
      let m = path.match(/\/([0-9a-f]{32})\/([0-9a-f]{32})(?:[/?#]|$)/i);
      let id = m ? m[2] : "";
      // 方式二：查询参数带 topicId 之类
      if (!id) {
        const q = new URLSearchParams(u.search);
        const tid = q.get("topicId") || q.get("topicid") || q.get("topic_id") || q.get("topicID");
        if (tid && /^(?:[0-9a-f]{32}|\d{6,})$/i.test(tid) && /bbs|topic/i.test(path)) id = tid;
      }
      if (!id || seen.has(id)) return;
      seen.add(id);
      const title = (titleSrc || "").replace(/\s+/g, " ").trim();
      out.push({ url: u.href, id, title: (title || "话题 " + id.slice(0, 6)).slice(0, 60) });
    };

    const scanDoc = (doc) => {
      doc.querySelectorAll("a[href]").forEach((a) => {
        tryUrl(a.href, a.textContent || a.getAttribute("title") || (a.parentElement ? leafText(a.parentElement) : ""));
      });
      // 有些条目不是 <a>，而是 onclick 里拼网址跳转
      doc.querySelectorAll("[onclick]").forEach((n) => {
        const oc = n.getAttribute("onclick") || "";
        const m = oc.match(/https?:\/\/[^\s'")]+/) || oc.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
        if (m) tryUrl(m[1] || m[0], leafText(n));
      });
    };

    scanDoc(document);
    // 同源 iframe 里也可能有列表
    document.querySelectorAll("iframe").forEach((f) => {
      try {
        const d = f.contentDocument;
        if (d) scanDoc(d);
      } catch (e) {}
    });

    return out;
  }

  // 从页面各处挖本课程的 bbsId（32 位十六进制）
  // 增强来源：URL 参数 / pathname / 带 bbsid 的链接 / iframe src / onclick / 老链接兜底
  function detectBbsidFromDom() {
    // 1) URL 查询参数
    const pageQ = new URLSearchParams(location.search);
    const bUrl = pageQ.get("bbsid") || pageQ.get("bbsId") || pageQ.get("bbs_id");
    if (isHex32(bUrl)) return bUrl;

    // 2) pathname 里的 32 位 id（如 /v3/bbs/{bbsid}/{topicid}/...）
    const m = location.pathname.match(/\/([0-9a-f]{32})(?:\/|$)/i);
    if (m) return m[1];

    // 3) 页面里带 bbsid 参数的 <a>
    const aWithBbs = document.querySelector('a[href*="bbsid="], a[href*="bbsId="]');
    if (aWithBbs) {
      try {
        const q = new URLSearchParams(new URL(aWithBbs.href, location.href).search);
        const bid = q.get("bbsid") || q.get("bbsId");
        if (isHex32(bid)) return bid;
      } catch (e) {}
    }

    // 4) 内嵌 iframe 的 src 里带的 bbsid（新版课程主页常走这条路）
    for (const f of document.querySelectorAll("iframe")) {
      const src = f.src || "";
      if (!src) continue;
      try {
        const u = new URL(src, location.href);
        const q = new URLSearchParams(u.search);
        const bid = q.get("bbsid") || q.get("bbsId");
        if (isHex32(bid)) return bid;
      } catch (e) {}
    }

    // 5) onclick 里明确带 bbsid= 或 bbsid: 的
    for (const n of document.querySelectorAll("[onclick]")) {
      const oc = n.getAttribute("onclick") || "";
      const mB = oc.match(/bbsid["']?\s*[:=]\s*["']?([0-9a-f]{32})/i);
      if (mB) return mB[1];
    }

    // 6) 老逻辑兜底：从 myTopic/myReply/replyMe 链接里挖
    const a = document.querySelector('a[href*="myTopic"], a[href*="myReply"], a[href*="replyMe"]');
    if (a) {
      const m2 = a.href.match(/\/([0-9a-f]{32})\//i);
      if (m2) return m2[1];
    }
    return "";
  }
  const getBbsIdFromPage = () => detectBbsidFromDom();

  // 在当前页面里找讨论区 iframe 的 src（用于跳转到 groupweb 讨论页）
  // 优先级：groupweb 域 + topic/bbs + bbsid > groupweb + topicList > groupweb 讨论相关 > 任意讨论相关
  function findDiscussionIframeSrc() {
    const frames = [...document.querySelectorAll("iframe")].map((f) => f.src || "").filter(Boolean);
    return (
      frames.find((x) => /groupweb\.chaoxing\.com/i.test(x) && /(?:topic|bbs)/i.test(x) && /bbsid=/i.test(x)) ||
      frames.find((x) => /groupweb\.chaoxing\.com.*topicList/i.test(x)) ||
      frames.find((x) => /groupweb\.chaoxing\.com.*(?:topic|bbs|circle)/i.test(x)) ||
      frames.find((x) => /bbs|topic|circle/i.test(x)) ||
      ""
    );
  }

  // 用当前页面参数 + bbsid 拼出 groupweb 的 topicList 链接
  // 尽量把 iframe src 里带的 stuenc/showAIEnc 等参数也带上，避免目标页缺参数
  function buildTopicListUrl(bbsid) {
    const sp = new URLSearchParams(location.search);
    const q = new URLSearchParams();
    const addIf = (k, v) => { if (v) q.set(k, v); };
    addIf("courseid", sp.get("courseid") || sp.get("courseId"));
    addIf("clazzid", sp.get("clazzid") || sp.get("classId"));
    addIf("cpi", sp.get("cpi"));
    addIf("enc", sp.get("enc"));
    addIf("t", sp.get("t") || String(Date.now()));
    if (!q.get("ut")) q.set("ut", "s");
    if (bbsid) q.set("bbsid", bbsid);
    const iframeSrc = findDiscussionIframeSrc();
    if (iframeSrc) {
      try {
        const fq = new URLSearchParams(new URL(iframeSrc, location.href).search);
        ["stuenc", "showAIEnc", "supportAI", "microClassDiscuss"].forEach((k) => {
          if (!q.get(k) && fq.get(k)) q.set(k, fq.get(k));
        });
      } catch (e) {}
    }
    return "https://groupweb.chaoxing.com/course/topic/topicList?" + q.toString();
  }

  // 在学习通顶部找「讨论」菜单，模拟点击
  function tryClickDiscussionMenu() {
    const all = [...document.querySelectorAll("a, span, div, li, button")];
    const isVisible = (n) => {
      if (!n.offsetParent) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // 优先精确匹配、叶子节点
    let target = all.find((n) => {
      const t = (n.textContent || "").replace(/\s+/g, "").trim();
      return t === "讨论" && n.children.length === 0 && isVisible(n);
    });
    if (!target) {
      const cands = all.filter((n) => {
        const t = (n.textContent || "").replace(/\s+/g, "").trim();
        return t === "讨论" && isVisible(n);
      });
      target = cands[cands.length - 1];
    }
    if (!target) return false;

    try {
      target.click();
      log("已尝试点击「讨论」菜单……", "warn");
      // 有些版本事件挂在父级，1.2 秒后补点一次
      if (target.parentElement) {
        setTimeout(() => {
          if (iframeWatchActive && !findDiscussionIframeSrc() && !detectBbsidFromDom()) {
            try { target.parentElement.click(); } catch (e) {}
          }
        }, 1200);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  let iframeWatchActive = false;
  function watchForIframeAndJump() {
    if (iframeWatchActive) return;

    const tryJump = () => {
      const src = findDiscussionIframeSrc();
      if (src) {
        iframeWatchActive = false;
        log("已捕获讨论区入口，正在跳转……", "ok");
        setTimeout(() => { location.href = src; }, 300);
        return true;
      }
      const bbsid = detectBbsidFromDom();
      if (bbsid) {
        iframeWatchActive = false;
        log("已捕获 bbsid，正在跳转……", "ok");
        setTimeout(() => { location.href = buildTopicListUrl(bbsid); }, 300);
        return true;
      }
      return false;
    };

    if (tryJump()) return;
    iframeWatchActive = true;

    const clicked = tryClickDiscussionMenu();
    log(clicked ? "正在等待讨论区加载……（脚本已自动点击「讨论」菜单）" : "页面上未找到「讨论」菜单，等待你手动点击……", clicked ? "strong" : "warn");

    // 5 秒后还没跳，弹窗兜底
    setTimeout(() => {
      if (!iframeWatchActive) return;
      if (clicked) {
        log("提示：脚本已自动点击「讨论」，如仍未跳转，请手动点一次顶部的「讨论」菜单。", "warn");
      } else {
        alert(
          "未检测到本课程的讨论区入口，且未找到「讨论」菜单。\n\n" +
          "请手动点击学习通页面顶部的「讨论」菜单，\n" +
          "脚本会自动捕获入口并跳转到独立讨论页面。\n\n" +
          "（如页面没有「讨论」菜单，请手动打开任意话题后再回来点此按钮。）"
        );
      }
    }, 5000);

    const mo = new MutationObserver(() => { if (tryJump()) mo.disconnect(); });
    try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}

    let elapsed = 0;
    const timer = setInterval(() => {
      if (!iframeWatchActive) { clearInterval(timer); return; }
      if (tryJump()) { clearInterval(timer); mo.disconnect(); return; }
      elapsed += 500;
      if (elapsed === 3000) tryClickDiscussionMenu();
      if (elapsed >= 60000) {
        clearInterval(timer);
        mo.disconnect();
        iframeWatchActive = false;
        log("等待超时（60 秒），未检测到讨论区入口。请刷新页面后重新点击按钮。", "warn");
      }
    }, 500);
  }

  // 从行内属性/onclick 挖话题 id（列表页条目不一定是 <a>）
  function scanTopicRows() {
    const bbsid = getBbsIdFromPage();
    const pageQ = new URLSearchParams(location.search);
    const courseid = pageQ.get("courseid") || pageQ.get("courseId") || "";
    const clazzid = pageQ.get("clazzid") || pageQ.get("classId") || "";
    const cpi = pageQ.get("cpi") || "";
    if (!bbsid || !courseid) return [];
    const out = [];
    const seen = new Set();

    const scanOneDoc = (doc) => {
      doc.querySelectorAll("*").forEach((el) => {
        if (out.length >= 200) return;
        const dataTid = el.getAttribute && (el.getAttribute("data-topicid") || el.getAttribute("data-topicId"));
        const oc = el.getAttribute && (el.getAttribute("onclick") || "");
        let tid = "";
        if (dataTid) {
          const m = String(dataTid).match(/([0-9a-f]{32})/i);
          if (m) tid = m[1];
        }
        if (!tid && oc) {
          const ms = oc.match(/([0-9a-f]{32})/gi);
          if (ms) {
            const others = ms.filter((x) => x !== bbsid);
            // onclick 里同时出现 bbsId+话题Id 的，直接要话题Id；只出现一个 id 的，要求函数名与话题相关
            if (others.length === 1) tid = others[0];
            else if (/topic|discuss|Topic/i.test(oc) && others.length) tid = others[0];
          }
        }
        if (!tid) {
          const cls = el.getAttribute && (el.getAttribute("class") || "");
          if (/topic|discuss/i.test(cls)) {
            for (const att of el.attributes) {
              const m = String(att.value || "").match(/([0-9a-f]{32})/i);
              if (m && m[1] !== bbsid) { tid = m[1]; break; }
            }
          }
        }
        if (!tid || tid === bbsid || seen.has(tid)) return;

        // 从所在行往上找 3 层，挑最像题目的文本
        let node = el;
        for (let i = 0; i < 3 && node.parentElement; i++) {
          if ((node.textContent || "").trim().length >= 20) break;
          node = node.parentElement;
        }
        const isClassList = (t) => t.indexOf("、") >= 0 && /20\d{2}/.test(t);
        let title = "";
        const pick = (t) => {
          if (!t || t.length < 6 || t.length > 120) return;
          if (NOISE.test(t) || POST_MARKER.test(t) || TIME.test(t) || YEAR.test(t) || NUM.test(t)) return;
          if (/置顶|已回复|阅读|浏览|老师/.test(t)) return;
          if (isClassList(t)) return;
          if (t.length > title.length) title = t;
        };
        [...node.querySelectorAll("div,span,p,a")].filter((n) => n.children.length === 0).forEach((n) => pick((n.textContent || "").replace(/\s+/g, " ").trim()));
        if (!title) {
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          const idx = text.indexOf("置顶");
          const before = idx >= 0 ? text.slice(0, idx) : text;
          before.split(" ").forEach(pick);
        }
        seen.add(tid);
        out.push({
          id: tid,
          title: title || "话题 " + tid.slice(0, 6),
          url: `https://groupweb.chaoxing.com/course/topic/v3/bbs/${bbsid}/${tid}/replysList?courseId=${courseid}&classId=${clazzid}&isLearnSilver=0&cpi=${cpi}&knowledgeEnc=&ut=s`,
        });
      });
    };

    scanOneDoc(document);
    document.querySelectorAll("iframe").forEach((f) => {
      try {
        const d = f.contentDocument;
        if (d) scanOneDoc(d);
      } catch (e) {}
    });
    return out;
  }

  function linksFromCapturedList() {
    if (!capturedListData.items.length) return [];
    const bbsid = getBbsIdFromPage();
    const pageQ = new URLSearchParams(location.search);
    const courseid = pageQ.get("courseid") || pageQ.get("courseId") || "";
    const clazzid = pageQ.get("clazzid") || pageQ.get("classId") || "";
    const cpi = pageQ.get("cpi") || "";
    if (!bbsid || !courseid) return [];
    return capturedListData.items.map((it) => ({
      id: String(it.id),
      title: it.title || "话题 " + String(it.id).slice(0, 6),
      url: `https://groupweb.chaoxing.com/course/topic/v3/bbs/${bbsid}/${it.id}/replysList?courseId=${courseid}&classId=${clazzid}&isLearnSilver=0&cpi=${cpi}&knowledgeEnc=&ut=s`,
    }));
  }

  // 优先用 <a> 扫描结果，否则合并行扫描 + 接口数据
  function getAllTopicLinks() {
    const links = scanTopicLinks();
    if (links.length) return links;
    const merged = [];
    const seen = new Set();
    scanTopicRows().forEach((l) => { if (!seen.has(l.id)) { seen.add(l.id); merged.push(l); } });
    linksFromCapturedList().forEach((l) => { if (!seen.has(l.id)) { seen.add(l.id); merged.push(l); } });
    return merged;
  }

  // ===== 队列与已回复记录 =====
  function loadQueue() {
    try { return JSON.parse(store.get(QUEUE_KEY) || "null"); } catch (e) { return null; }
  }
  const saveQueue = (q) => store.set(QUEUE_KEY, JSON.stringify(q));
  const clearQueue = () => store.remove(QUEUE_KEY);
  const isDone = (id) => store.get(DONE_PREFIX + id) === "1";
  const markDone = (id) => store.set(DONE_PREFIX + id, "1");
  function clearAllDone() {
    let n = 0;
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf(DONE_PREFIX) === 0) { localStorage.removeItem(k); n++; }
      }
    } catch (e) {}
    return n;
  }
  const getInterval = () => {
    const n = parseInt(store.get(INTERVAL_KEY) || "30", 10);
    if (!isFinite(n)) return 30;
    return Math.min(600, Math.max(1, n));
  };
  function addSummary(kind) {
    let sum = { ok: 0, fail: 0 };
    try { sum = JSON.parse(store.get(SUMMARY_KEY) || JSON.stringify(sum)); } catch (e) {}
    if (kind === "ok") sum.ok++; else sum.fail++;
    store.set(SUMMARY_KEY, JSON.stringify(sum));
  }

  // ===== 工作集与答案 =====
  function loadTopics() {
    try {
      const a = JSON.parse(store.get(TOPICS_KEY) || "null");
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }
  const saveTopics = (arr) => store.set(TOPICS_KEY, JSON.stringify(arr));
  // 「无答案时发」：没设置过用默认文案；设置成空串表示「无兜底，跳过」
  const getEffectiveFallback = () => (store.get(FALLBACK_KEY) ?? FALLBACK_DEFAULT).trim();

  // 复制出去的题目文本：头部格式约束提示词 + 【编号】题目 逐行
  function buildCopyText(items) {
    const lines = [
      "以下是课程讨论题目。请逐题作答，答案要简短（每道题一般不超过 100 字）。",
      "答案必须严格按以下格式输出，每段以【答案N】开头（N 与题目编号对应），不要输出格式之外的任何多余文字：",
      "【答案1】",
      "答案正文……",
      "【答案2】",
      "答案正文……",
      "题目如下：",
    ];
    items.forEach((it, i) => lines.push(`【${i + 1}】${it.title}`));
    return lines.join("\n");
  }

  // 新旧工作集按 id 合并：仍在工作集的话题答案保留；新题 answer 为空；被移除的丢弃
  function mergeWorkingSet(newItems) {
    const oldMap = new Map(loadTopics().map((e) => [e.id, e]));
    const topics = [];
    let kept = 0, added = 0;
    const seen = new Set();
    newItems.forEach((it) => {
      if (seen.has(it.id)) return;
      seen.add(it.id);
      const old = oldMap.get(it.id);
      if (old) {
        if (old.answer) kept++;
        topics.push({ id: it.id, title: it.title, url: it.url, answer: old.answer || "" });
      } else {
        topics.push({ id: it.id, title: it.title, url: it.url, answer: "" });
        added++;
      }
    });
    const dropped = [...oldMap.keys()].filter((id) => !seen.has(id)).length;
    return { topics, kept, added, dropped };
  }

  // 解析答案块：只认【答案N】段（N 后的文字直到下一个【答案M】为止），其余文字忽略
  function parseAnswerBlock(raw) {
    const map = new Map();
    if (!raw || !raw.trim()) return map;
    const text = raw
      .replace(/\r\n?/g, "\n")
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); // 全角数字转半角
    const parts = text.split(/【答案\s*(\d+)\s*】/);
    if (parts.length < 3) return map;
    const warnedDup = new Set();
    for (let i = 1; i < parts.length; i += 2) {
      const n = parseInt(parts[i], 10);
      let body = (parts[i + 1] || "").trim();
      if (body.length > MAX_ANSWER_LEN) {
        body = body.slice(0, MAX_ANSWER_LEN);
        log(`【答案${n}】超过 ${MAX_ANSWER_LEN} 字符，已截断。`, "warn");
      }
      if (map.has(n) && !warnedDup.has(n)) {
        log(`【答案${n}】出现多次，以后一次为准。`, "warn");
        warnedDup.add(n);
      }
      map.set(n, body);
    }
    return map;
  }

  // 某个话题要发布的内容：工作集有答案用答案；否则用兜底文案；两者都空返回空
  function resolveAnswer(topicId) {
    const ws = loadTopics();
    const idx = ws.findIndex((e) => e.id === topicId);
    const fb = getEffectiveFallback();
    if (idx >= 0) {
      if (ws[idx].answer) return { text: ws[idx].answer, src: "answer", entry: { n: idx + 1, title: ws[idx].title } };
      return { text: fb, src: fb ? "fallback" : "none", entry: { n: idx + 1, title: ws[idx].title } };
    }
    return { text: fb, src: fb ? "fallback" : "none", entry: null };
  }

  // 统计行文案（复制/保存答案后局部刷新用）
  function listStatText() {
    const links = getAllTopicLinks();
    const ws = loadTopics();
    const doneCount = links.filter((l) => isDone(l.id)).length;
    const ansCount = ws.filter((e) => e.answer).length;
    return `共 ${links.length} 个话题 · 已回复 ${doneCount} 个 · 工作集 ${ws.length} 题 · 已存答案 ${ansCount}/${ws.length}`;
  }
  function answerStatText() {
    const ws = loadTopics();
    const ansCount = ws.filter((e) => e.answer).length;
    if (!ws.length) return "工作集为空：请先勾选话题并点「📋 复制全部题目」。";
    if (!ansCount) return `已存答案 0/${ws.length} 题。粘贴答案块后点「保存答案」写入工作集。`;
    return `已存答案 ${ansCount}/${ws.length} 题（存在工作集里，清空输入框不影响已存内容）。`;
  }

  function updateSelectedCount() {
    const span = document.getElementById("cxar-qa-selected");
    if (!span) return;
    const boxes = [...document.querySelectorAll(".cxar-item-check")];
    if (!boxes.length) { span.textContent = ""; return; }
    const sel = boxes.filter((b) => b.checked).length;
    span.textContent = ` · 已选 ${sel}/${boxes.length}`;
  }
  function updateListStats() {
    const stat = document.getElementById("cxar-qa-stat");
    if (stat) stat.innerHTML = esc(listStatText()) + ' <span id="cxar-qa-selected"></span>';
    const astatTop = document.getElementById("cxar-qa-answer-topstat");
    if (astatTop) astatTop.textContent = listStatText();
    const astat = document.getElementById("cxar-qa-answer-stat");
    if (astat) astat.textContent = answerStatText();
    updateSelectedCount();
    // "清除全部已存答案"按钮的可用性
    const btnClearSaved = document.getElementById("cxar-qa-clear-saved");
    if (btnClearSaved) {
      const ansCount = loadTopics().filter((e) => e.answer).length;
      btnClearSaved.disabled = ansCount === 0;
      btnClearSaved.style.opacity = ansCount === 0 ? ".4" : "";
      btnClearSaved.style.cursor = ansCount === 0 ? "not-allowed" : "pointer";
      btnClearSaved.textContent = ansCount === 0
        ? "⚠️ 清除全部已存答案（已为空）"
        : `⚠️ 清除全部已存答案（${ansCount} 题）`;
    }
  }

  // ===== 面板 =====
  let rescanScheduled = false;
  let statLogged = false;
  let draftAnswers = null;
  let deferredRender = false;

  function saveLogEntry(msg, type) {
    try {
      let arr = JSON.parse(store.get(LOG_KEY) || "[]");
      if (!Array.isArray(arr)) arr = [];
      arr.push({ t: Date.now(), m: String(msg).slice(0, 160), y: type || "" });
      if (arr.length > 40) arr = arr.slice(-40);
      store.set(LOG_KEY, JSON.stringify(arr));
    } catch (e) {}
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  // 面板底部「最近操作记录」：从 localStorage 读，跳页/刷新后也能看到刚才干了什么
  function renderHistory() {
    const box = document.getElementById("cxar-qa-history");
    if (!box) return;
    let arr = [];
    try { arr = JSON.parse(store.get(LOG_KEY) || "[]"); } catch (e) {}
    if (!Array.isArray(arr) || !arr.length) { box.innerHTML = ""; return; }
    const list = arr.slice(-15);
    box.innerHTML = '<div class="cxar-hist-title">📋 最近操作记录：</div>' +
      list.map((e) => `<div class="${esc(e.y)}">${esc(fmtTime(e.t))} ${esc(e.m)}</div>`).join("");
  }
  function log(msg, type) {
    saveLogEntry(msg, type);
    const box = document.getElementById("cxar-qa-log");
    if (!box) return;
    const div = document.createElement("div");
    div.className = type || "";
    div.textContent = msg;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    renderHistory();
  }

  // 通用：绑定 Tab 切换（只切 class，不重渲染）
  function bindTabSwitch(body, getTab, setTab) {
    body.querySelectorAll(".cxar-tab").forEach((tabEl) => {
      tabEl.addEventListener("click", () => {
        const t = tabEl.dataset.tab;
        if (getTab() === t) return;
        setTab(t);
        body.querySelectorAll(".cxar-tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === t));
        body.querySelectorAll(".cxar-tab-pane").forEach((x) => x.classList.toggle("active", x.dataset.pane === t));
      });
    });
  }

  // 主按钮（实心蓝底）闪一下：绿=成功，红=失败
  function flashPrimary(btn, msg, ok) {
    if (!btn) return;
    if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent;
    const orig = btn.dataset.origLabel;
    btn.textContent = msg;
    btn.style.background = ok ? "#34c759" : "#ff3b30";
    clearTimeout(btn.__flashTimer);
    btn.__flashTimer = setTimeout(() => {
      btn.textContent = orig;
      btn.style.background = "";
    }, 2200);
  }
  // 次级按钮（浅底描边）闪一下：绿/红色文字 + 半透明底
  function flashSecondary(btn, msg, ok) {
    if (!btn) return;
    if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent;
    const orig = btn.dataset.origLabel;
    btn.textContent = msg;
    btn.style.background = ok ? "rgba(52,199,89,.15)" : "rgba(255,59,48,.15)";
    btn.style.color = ok ? "#34c759" : "#ff3b30";
    btn.style.borderColor = ok ? "rgba(52,199,89,.4)" : "rgba(255,59,48,.4)";
    clearTimeout(btn.__flashTimer);
    btn.__flashTimer = setTimeout(() => {
      btn.textContent = orig;
      btn.style.background = "";
      btn.style.color = "";
      btn.style.borderColor = "";
    }, 2000);
  }

  function initUI() {
    const style = document.createElement("style");
    style.textContent = `
      /* ===== 面板容器（毛玻璃 + 大圆角 + 柔和阴影） ===== */
      #cxar-qa-panel {
        position: fixed; top: 70px; width: 360px; z-index: 2147483000;
        background: rgba(255,255,255,.78);
        backdrop-filter: saturate(180%) blur(24px);
        -webkit-backdrop-filter: saturate(180%) blur(24px);
        border: .5px solid rgba(0,0,0,.08);
        border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.06);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
        color: #1c1c1e;
        -webkit-font-smoothing: antialiased;
        display: flex; flex-direction: column; max-height: 80vh;
        overflow: hidden;
      }
      #cxar-qa-panel .cxar-head {
        flex: none;
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 14px;
        background: rgba(255,255,255,.45);
        border-bottom: .5px solid rgba(0,0,0,.08);
        cursor: move; user-select: none;
      }
      #cxar-qa-panel .cxar-title {
        font-weight: 600; font-size: 13.5px; color: #1c1c1e;
        letter-spacing: -.01em;
      }
      #cxar-qa-panel .cxar-min {
        border: none; background: transparent; color: #007aff;
        font-size: 18px; line-height: 1; cursor: pointer;
        padding: 0 4px; border-radius: 6px;
        transition: background .15s;
      }
      #cxar-qa-panel .cxar-min:hover { background: rgba(0,122,255,.1); }
      #cxar-qa-panel .cxar-body {
        flex: 1; min-height: 0;
        display: flex; flex-direction: column;
        padding: 0;
      }
      #cxar-qa-panel .cxar-tabbar {
        flex: none; display: flex; gap: 2px;
        margin: 10px 12px 0;
        padding: 2px;
        background: rgba(118,118,128,.12);
        border-radius: 9px;
      }
      #cxar-qa-panel .cxar-tab {
        flex: 1; padding: 5px 4px; text-align: center;
        font-size: 12px; font-weight: 500;
        color: #1c1c1e; cursor: pointer; user-select: none;
        border-radius: 7px;
        white-space: nowrap;
        transition: background .2s cubic-bezier(.4,0,.2,1),
                    box-shadow .2s cubic-bezier(.4,0,.2,1);
      }
      #cxar-qa-panel .cxar-tab:hover { background: rgba(255,255,255,.5); }
      #cxar-qa-panel .cxar-tab.active {
        background: #fff;
        box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 0 0 .5px rgba(0,0,0,.05);
        font-weight: 600;
      }
      #cxar-qa-panel .cxar-content {
        flex: 1; min-height: 0; overflow-y: auto;
        padding: 12px 14px 14px;
      }
      #cxar-qa-panel .cxar-tab-pane { display: none; }
      #cxar-qa-panel .cxar-tab-pane.active { display: block; }
      #cxar-qa-panel .cxar-note {
        color: #8e8e93; font-size: 11.5px;
        margin-bottom: 6px; line-height: 1.45;
      }
      #cxar-qa-panel .cxar-stat {
        font-weight: 600; color: #007aff;
        margin: 4px 0 8px; font-size: 12.5px;
        letter-spacing: -.01em;
      }
      #cxar-qa-panel .cxar-row { margin-bottom: 8px; }
      #cxar-qa-panel .cxar-row label {
        display: inline-block; width: 84px;
        color: #3a3a3c; font-size: 12px;
      }
      #cxar-qa-panel .cxar-row input,
      #cxar-qa-panel .cxar-row select {
        width: calc(100% - 92px);
        padding: 6px 9px;
        border: .5px solid rgba(0,0,0,.14);
        border-radius: 8px;
        font-size: 12px;
        background: rgba(255,255,255,.9);
        color: #1c1c1e;
        font-family: inherit;
        transition: border-color .15s, box-shadow .15s;
      }
      #cxar-qa-panel .cxar-row input:focus,
      #cxar-qa-panel .cxar-row select:focus {
        outline: none;
        border-color: #007aff;
        box-shadow: 0 0 0 3px rgba(0,122,255,.15);
      }
      #cxar-qa-panel .cxar-row input.cxar-short { width: 56px; }
      #cxar-qa-panel .cxar-items {
        max-height: 220px; overflow: auto;
        border: none; border-radius: 10px;
        padding: 5px 6px; margin-bottom: 8px;
        background: rgba(118,118,128,.08);
      }
      #cxar-qa-panel .cxar-item {
        display: flex; align-items: center; gap: 6px;
        padding: 4px 6px; border-radius: 6px;
        font-size: 12px; cursor: pointer;
        transition: background .12s;
      }
      #cxar-qa-panel .cxar-item:hover { background: rgba(0,122,255,.08); }
      #cxar-qa-panel .cxar-item.done { color: #8e8e93; }
      #cxar-qa-panel .cxar-item-title {
        flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #cxar-qa-panel .cxar-item-status { flex: none; }
      #cxar-qa-panel .cxar-run {
        width: 100%; margin: 8px 0; padding: 9px 0;
        border: none; border-radius: 10px;
        background: #007aff; color: #fff;
        font-size: 14px; font-weight: 500;
        letter-spacing: -.01em; cursor: pointer;
        font-family: inherit;
        transition: background .15s, transform .1s;
      }
      #cxar-qa-panel .cxar-run:hover { background: #0071e3; }
      #cxar-qa-panel .cxar-run:active { transform: scale(.98); background: #0060c9; }
      #cxar-qa-panel .cxar-run:disabled {
        background: rgba(0,122,255,.4); cursor: wait; transform: none;
      }
      #cxar-qa-panel .cxar-paste {
        width: 100%; margin: 4px 0 8px; padding: 8px 0;
        border: .5px solid rgba(0,122,255,.4);
        border-radius: 10px;
        background: rgba(0,122,255,.08);
        color: #007aff;
        font-size: 13px; font-weight: 500;
        cursor: pointer; font-family: inherit;
        transition: background .15s, transform .1s;
      }
      #cxar-qa-panel .cxar-paste:hover { background: rgba(0,122,255,.14); }
      #cxar-qa-panel .cxar-paste:active { transform: scale(.98); }
      #cxar-qa-panel .cxar-paste.secondary {
        border-color: rgba(0,0,0,.14);
        background: rgba(118,118,128,.08);
        color: #3a3a3c;
      }
      #cxar-qa-panel .cxar-paste.secondary:hover { background: rgba(118,118,128,.14); }
      #cxar-qa-panel .cxar-clear {
        width: 100%; padding: 8px 0;
        border: none; border-radius: 10px;
        background: rgba(255,59,48,.1);
        color: #ff3b30;
        font-size: 12.5px; font-weight: 500;
        cursor: pointer; font-family: inherit;
        transition: background .15s, transform .1s;
      }
      #cxar-qa-panel .cxar-clear:hover { background: rgba(255,59,48,.16); }
      #cxar-qa-panel .cxar-clear:active { transform: scale(.98); }
      #cxar-qa-panel .cxar-icon-btn {
        flex: none;
        width: 28px; height: 28px;
        border: .5px solid rgba(0,0,0,.14);
        border-radius: 8px;
        background: rgba(118,118,128,.08);
        color: #3a3a3c;
        font-size: 13px; line-height: 1;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        padding: 0;
        font-family: inherit;
        transition: background .15s;
      }
      #cxar-qa-panel .cxar-icon-btn:hover { background: rgba(118,118,128,.16); }
      #cxar-qa-panel .cxar-icon-btn:active { background: rgba(118,118,128,.24); }
      #cxar-qa-panel .cxar-answers {
        width: 100%; box-sizing: border-box;
        border: .5px solid rgba(0,0,0,.14);
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
        color: #1c1c1e;
        background: rgba(255,255,255,.9);
        resize: vertical;
        margin-bottom: 8px;
        line-height: 1.5;
        min-height: 160px;
        transition: border-color .15s, box-shadow .15s;
      }
      #cxar-qa-panel .cxar-answers:focus {
        outline: none;
        border-color: #007aff;
        box-shadow: 0 0 0 3px rgba(0,122,255,.15);
      }
      #cxar-qa-panel .cxar-preview {
        max-height: 200px; overflow: auto;
        background: rgba(118,118,128,.08);
        border: none; border-radius: 10px;
        padding: 8px 10px; font-size: 12px;
        white-space: pre-wrap; word-break: break-all;
        margin-bottom: 8px; line-height: 1.5;
      }
      #cxar-qa-panel .cxar-log {
        max-height: 260px; overflow: auto;
        background: rgba(118,118,128,.08);
        border: none; border-radius: 10px;
        padding: 8px 10px; font-size: 12px;
        word-break: break-all; line-height: 1.45;
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      }
      #cxar-qa-panel .cxar-log div { margin: 2px 0; }
      #cxar-qa-panel .cxar-log .ok { color: #34c759; }
      #cxar-qa-panel .cxar-log .warn { color: #ff9500; }
      #cxar-qa-panel .cxar-log .error { color: #ff3b30; }
      #cxar-qa-panel .cxar-log .strong { font-weight: 600; color: #007aff; }
      #cxar-qa-panel .cxar-history {
        margin-top: 10px;
        border-top: .5px solid rgba(0,0,0,.08);
        padding-top: 6px;
        max-height: 160px; overflow: auto;
        font-size: 11px; color: #8e8e93;
        word-break: break-all; line-height: 1.5;
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      }
      #cxar-qa-panel .cxar-history .cxar-hist-title { color: #3a3a3c; margin-bottom: 2px; }
      #cxar-qa-panel .cxar-history .ok { color: #34c759; }
      #cxar-qa-panel .cxar-history .warn { color: #ff9500; }
      #cxar-qa-panel .cxar-history .error { color: #ff3b30; }
      #cxar-qa-panel .cxar-history .strong { color: #007aff; }
      #cxar-qa-panel ::-webkit-scrollbar { width: 8px; height: 8px; }
      #cxar-qa-panel ::-webkit-scrollbar-thumb {
        background: rgba(0,0,0,.18);
        border-radius: 4px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      #cxar-qa-panel ::-webkit-scrollbar-thumb:hover {
        background: rgba(0,0,0,.35);
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      #cxar-qa-panel ::-webkit-scrollbar-track { background: transparent; }
      #cxar-qa-panel.cxar-collapsed .cxar-body { display: none; }
      #cxar-qa-panel.cxar-collapsed { width: auto; max-height: none; }
    `;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "cxar-qa-panel";
    panel.innerHTML = `
      <div class="cxar-head">
        <span class="cxar-title">📝 讨论题目采集自动回复</span>
        <button class="cxar-min" title="收起/展开">—</button>
      </div>
      <div class="cxar-body" id="cxar-qa-body"></div>
    `;
    document.body.appendChild(panel);

    // 位置记忆 + 拖动
    try {
      const pos = JSON.parse(store.get(POS_KEY) || "null");
      if (pos && typeof pos.x === "number" && typeof pos.y === "number" &&
          pos.x > -300 && pos.x < window.innerWidth - 40 && pos.y > -40 && pos.y < window.innerHeight - 40) {
        panel.style.left = pos.x + "px";
        panel.style.top = pos.y + "px";
      } else {
        panel.style.left = Math.max(0, window.innerWidth - 376) + "px";
      }
    } catch (e) {
      panel.style.left = Math.max(0, window.innerWidth - 376) + "px";
    }
    let drag = null;
    panel.querySelector(".cxar-head").addEventListener("mousedown", (e) => {
      if (e.target.closest(".cxar-min")) return;
      drag = { sx: e.clientX - panel.offsetLeft, sy: e.clientY - panel.offsetTop };
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      panel.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.sx)) + "px";
      panel.style.top = Math.max(0, e.clientY - drag.sy) + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      try { store.set(POS_KEY, JSON.stringify({ x: panel.offsetLeft, y: panel.offsetTop })); } catch (e) {}
    });
    panel.querySelector(".cxar-min").addEventListener("click", function () {
      panel.classList.toggle("cxar-collapsed");
      this.textContent = panel.classList.contains("cxar-collapsed") ? "＋" : "—";
    });

    if (parseTopic().topicId) renderTopicPage();
    else renderListPage();

    // 来回切换标签页后，回来刷新列表状态
    window.addEventListener("focus", () => {
      if (!parseTopic().topicId) renderListPage();
    });
  }

  // ===== 列表页面板 =====
  function renderListPage() {
    const body = document.getElementById("cxar-qa-body");
    if (!body) return;
    // 用户正在答案区里打字/粘贴时跳过重渲染，失焦后再补一次（防内容被冲掉）
    const ansFocused = document.getElementById("cxar-qa-answers");
    if (ansFocused && document.activeElement === ansFocused) {
      deferredRender = true;
      return;
    }

    const links = getAllTopicLinks();
    const intervalSec = getInterval();
    const fallback = store.get(FALLBACK_KEY) ?? FALLBACK_DEFAULT;
    const q0 = loadQueue();
    const taskActive = !!(q0 && q0.topics && q0.topics.length);
    const taskIdx = taskActive ? Math.min(q0.index || 0, q0.topics.length - 1) : 0;
    const ws = loadTopics();

    const rows = links.map((l) => {
      const done = isDone(l.id);
      // 已回复的话题也能勾选（复制题目是面向「收集问题」的），默认不勾
      return `<label class="cxar-item${done ? " done" : ""}">
        <input type="checkbox" class="cxar-item-check" data-id="${esc(l.id)}" ${done ? "" : "checked"}>
        <span class="cxar-item-title" title="${esc(l.title)}">${esc(l.title.slice(0, 24))}${l.title.length > 24 ? "…" : ""}</span>
        <span class="cxar-item-status">${done ? "✅" : ""}</span>
      </label>`;
    }).join("");

    const courseIdParam = new URLSearchParams(location.search).get("courseid") || new URLSearchParams(location.search).get("courseId");
    let iframeListSrc = "";
    if (!links.length) iframeListSrc = findDiscussionIframeSrc();

    let itemsHtml = rows || '<div style="color:#999">本页没找到话题链接</div>';
    if (!links.length && (courseIdParam || iframeListSrc)) {
      itemsHtml = '<div style="color:#999">本页没找到话题链接。可以点下面的按钮打开课程讨论列表页：</div>' +
        '<button class="cxar-run" id="cxar-qa-golist" style="margin:6px 0 10px">📋 打开课程讨论列表页</button>';
    }

    const mainBtn = taskActive
      ? `<button class="cxar-run" id="cxar-qa-start">▶ 继续本轮任务（第 ${taskIdx + 1}/${q0.topics.length} 个）</button>
         <button class="cxar-clear" id="cxar-qa-abort" style="margin-bottom:8px">⏹ 放弃本轮任务</button>`
      : `<button class="cxar-run" id="cxar-qa-start">🚀 自动发布（按工作集顺序）</button>`;

    if (!["collect", "answer", "publish", "more"].includes(activeTab)) activeTab = "collect";

    body.innerHTML = `
      <div class="cxar-tabbar">
        <div class="cxar-tab ${activeTab === "collect" ? "active" : ""}" data-tab="collect">📋 采集</div>
        <div class="cxar-tab ${activeTab === "answer" ? "active" : ""}" data-tab="answer">✍️ 答案</div>
        <div class="cxar-tab ${activeTab === "publish" ? "active" : ""}" data-tab="publish">🚀 发布</div>
        <div class="cxar-tab ${activeTab === "more" ? "active" : ""}" data-tab="more">⚙️ 更多</div>
      </div>
      <div class="cxar-content">
        <div class="cxar-tab-pane ${activeTab === "collect" ? "active" : ""}" data-pane="collect">
          <div class="cxar-note">①勾选话题 → ②「复制全部题目」贴给其他 AI → ③切到「答案」粘贴 → ④切到「发布」自动发布。</div>
          <div class="cxar-stat" id="cxar-qa-stat">${listStatText()} <span id="cxar-qa-selected"></span></div>
          <div class="cxar-items">${links.length ? '<label class="cxar-item"><input type="checkbox" id="cxar-qa-check-all"> 全选</label>' + itemsHtml : itemsHtml}</div>
          <button class="cxar-run" id="cxar-qa-copy">📋 复制全部题目（勾选的）</button>
        </div>
        <div class="cxar-tab-pane ${activeTab === "answer" ? "active" : ""}" data-pane="answer">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
            <div class="cxar-stat" id="cxar-qa-answer-topstat" style="flex:1;margin:0">${listStatText()}</div>
            <button class="cxar-icon-btn" id="cxar-qa-refresh" title="刷新面板">🔄</button>
          </div>
          <div style="display:flex;gap:6px;margin:4px 0 8px">
            <button class="cxar-paste" id="cxar-qa-paste" style="flex:1;margin:0">📋 一键粘贴剪贴板内容</button>
            <button class="cxar-paste secondary" id="cxar-qa-clear-answers" style="flex:0 0 96px;margin:0">🗑 清空输入框</button>
          </div>
          <div class="cxar-note">或手动 Ctrl+V 粘贴到这里（只认【答案N】段，多余文字没关系）：</div>
          <textarea id="cxar-qa-answers" class="cxar-answers" rows="12" placeholder="【答案1】&#10;答案正文……&#10;【答案2】&#10;答案正文……"></textarea>
          <button class="cxar-run" id="cxar-qa-save">✔ 保存答案（解析并合并）</button>
          <div class="cxar-note" id="cxar-qa-answer-stat">${answerStatText()}</div>
          <button class="cxar-clear" id="cxar-qa-clear-saved" style="margin-top:8px">⚠️ 清除全部已存答案</button>
        </div>
        <div class="cxar-tab-pane ${activeTab === "publish" ? "active" : ""}" data-pane="publish">
          <div class="cxar-row"><label>无答案时发</label><input id="cxar-qa-fallback" value="${esc(fallback)}"></div>
          <div class="cxar-row"><label>回复间隔</label><input id="cxar-qa-interval" class="cxar-short" type="number" min="1" max="600" value="${intervalSec}"> 秒</div>
          ${mainBtn}
        </div>
        <div class="cxar-tab-pane ${activeTab === "more" ? "active" : ""}" data-pane="more">
          <button class="cxar-clear" id="cxar-qa-clear">🧹 清除「已回复」记录（重新回复全部）</button>
          <div style="margin-top:12px">
            <div class="cxar-log" id="cxar-qa-log"></div>
            <div class="cxar-history" id="cxar-qa-history"></div>
          </div>
        </div>
      </div>
    `;

    bindTabSwitch(body, () => activeTab, (t) => { activeTab = t; });

    const answersEl = body.querySelector("#cxar-qa-answers");
    if (answersEl) {
      const saved = draftAnswers !== null ? draftAnswers : (store.get(ANSWERS_TEXT_KEY) || "");
      answersEl.value = saved;
      answersEl.addEventListener("input", () => { draftAnswers = answersEl.value; });
      answersEl.addEventListener("change", () => {
        draftAnswers = answersEl.value;
        store.set(ANSWERS_TEXT_KEY, answersEl.value);
        if (deferredRender) { deferredRender = false; setTimeout(renderListPage, 0); }
      });
      answersEl.addEventListener("blur", () => {
        if (deferredRender) { deferredRender = false; setTimeout(renderListPage, 0); }
      });
    }
    renderHistory();
    updateSelectedCount();
    updateListStats();

    body.querySelector("#cxar-qa-fallback").addEventListener("change", function () {
      store.set(FALLBACK_KEY, this.value.trim());
      log("「无答案时发」已更新。" + (this.value.trim() ? "" : "（为空：没答案的话题将直接跳过）"));
    });

    body.querySelector("#cxar-qa-interval").addEventListener("change", function () {
      const n = parseInt(this.value || "30", 10);
      store.set(INTERVAL_KEY, String(isFinite(n) ? Math.min(600, Math.max(1, n)) : 30));
      this.value = getInterval();
      if (getInterval() < 30) {
        log(`间隔已设为 ${getInterval()} 秒。低于 30 秒容易触发学习通反频繁限制（请勿同时在多个网页发布话题或回复），失败风险自负。`, "warn");
      } else {
        log(`回复间隔已设为 ${getInterval()} 秒。`);
      }
    });

    const checkAll = body.querySelector("#cxar-qa-check-all");
    if (checkAll) {
      const syncAll = () => {
        const boxes = [...body.querySelectorAll(".cxar-item-check")];
        checkAll.checked = boxes.length > 0 && boxes.every((b) => b.checked);
        updateSelectedCount();
      };
      checkAll.addEventListener("change", function () {
        body.querySelectorAll(".cxar-item-check").forEach((b) => { b.checked = this.checked; });
        updateSelectedCount();
      });
      body.querySelectorAll(".cxar-item-check").forEach((b) => b.addEventListener("change", syncAll));
      syncAll();
    }

    body.querySelector("#cxar-qa-copy").addEventListener("click", copyCheckedTopics);

    // 刷新按钮：重渲染一遍面板，重新扫描链接、重读 localStorage
    body.querySelector("#cxar-qa-refresh").addEventListener("click", function () {
      flashSecondary(this, "已刷新", true);
      renderListPage();
    });

    // 一键粘贴剪贴板
    body.querySelector("#cxar-qa-paste").addEventListener("click", async function () {
      const ta = document.getElementById("cxar-qa-answers");
      if (!ta) return;
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        flashSecondary(this, "❌ 浏览器不支持读取剪贴板", false);
        log("当前浏览器不支持读取剪贴板（navigator.clipboard.readText）。请手动 Ctrl+V 粘贴。", "warn");
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) {
          flashSecondary(this, "⚠️ 剪贴板是空的", false);
          log("剪贴板是空的，请先复制 AI 的答案。", "warn");
          return;
        }
        if (text.length > MAX_PASTE_LEN) {
          flashSecondary(this, "❌ 内容过大", false);
          log(`剪贴板内容过大（${text.length} 字，超过 ${MAX_PASTE_LEN} 上限），未粘贴。`, "error");
          return;
        }
        ta.value = text;
        draftAnswers = text;
        store.set(ANSWERS_TEXT_KEY, text);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        flashSecondary(this, `✅ 已粘贴 ${text.length} 字`, true);
        log(`已从剪贴板粘贴 ${text.length} 字到答案区。请点「保存答案」解析并合并。`, "ok");
      } catch (e) {
        flashSecondary(this, "❌ 读取失败", false);
        log("读取剪贴板失败：" + (e && e.message ? e.message : e) + "。可能是权限被拒绝，请手动 Ctrl+V 粘贴。", "warn");
      }
    });

    // 清空输入框（只清 textarea，不影响已存答案）
    body.querySelector("#cxar-qa-clear-answers").addEventListener("click", function () {
      const ta = document.getElementById("cxar-qa-answers");
      if (!ta) return;
      if (!ta.value.trim()) {
        flashSecondary(this, "已是空的", false);
        return;
      }
      const len = ta.value.length;
      ta.value = "";
      draftAnswers = "";
      store.remove(ANSWERS_TEXT_KEY);
      flashSecondary(this, "✅ 已清空", true);
      log(`已清空答案输入框（${len} 字）。已存答案不受影响。`, "ok");
    });

    // 清除全部已存答案（工作集里所有 answer 字段）
    body.querySelector("#cxar-qa-clear-saved").addEventListener("click", function () {
      const ws2 = loadTopics();
      const ansCount = ws2.filter((e) => e.answer).length;
      if (!ansCount) {
        flashSecondary(this, "已是空的", false);
        return;
      }
      if (!confirm(
        `确定清除全部已存答案吗？\n\n` +
        `将清空工作集里 ${ansCount} 道题的答案。\n` +
        `（答案输入框里的内容不受影响）\n\n` +
        `此操作不可撤销。`
      )) return;
      ws2.forEach((e) => { e.answer = ""; });
      saveTopics(ws2);
      updateListStats();
      flashSecondary(this, `✅ 已清除 ${ansCount} 题`, true);
      log(`已清除全部已存答案（${ansCount} 题）。`, "ok");
    });

    body.querySelector("#cxar-qa-save").addEventListener("click", saveAnswersFromTextarea);

    body.querySelector("#cxar-qa-clear").addEventListener("click", () => {
      const n = clearAllDone();
      log(`已清除 ${n} 条「已回复」记录（与批量版共用，清除后批量版也会重新回复）。`);
      renderListPage();
    });

    const goList = body.querySelector("#cxar-qa-golist");
    if (goList) {
      goList.addEventListener("click", () => {
        const iframeSrc = iframeListSrc || findDiscussionIframeSrc();
        if (iframeSrc) {
          log("正在打开课程讨论列表页……");
          location.href = iframeSrc;
          return;
        }
        const bbsid = getBbsIdFromPage();
        if (bbsid) {
          log("已用页面参数拼出课程讨论列表页链接（含 bbsid），正在打开……", "strong");
          location.href = buildTopicListUrl(bbsid);
          return;
        }
        log("未检测到讨论区入口。已启动自动等待：脚本会尝试自动点击「讨论」菜单。", "warn");
        watchForIframeAndJump();
      });
    }

    if (taskActive) {
      log(`检测到未完成的自动发布任务（第 ${taskIdx + 1}/${q0.topics.length} 个：「${q0.topics[taskIdx].title}」）。点「继续本轮任务」接着跑，本轮已处理的话题不会重复发布。`, "warn");
      body.querySelector("#cxar-qa-start").addEventListener("click", () => {
        location.href = q0.topics[taskIdx].url;
      });
      body.querySelector("#cxar-qa-abort").addEventListener("click", () => {
        clearQueue();
        log("已放弃本轮任务。");
        renderListPage();
      });
    } else {
      body.querySelector("#cxar-qa-start").addEventListener("click", () => {
        const linksNow = getAllTopicLinks();
        if (!linksNow.length && iframeListSrc) {
          if (!loadTopics().length) {
            log("还没有复制题目。请先打开讨论列表页复制题目、保存答案，再点自动发布。", "warn");
            return;
          }
          store.set(PENDING_KEY, "1");
          log("本页没有话题链接。正在先打开课程讨论列表页，打开后会自动开始发布……", "strong");
          setTimeout(() => { location.href = iframeListSrc; }, 1200);
          return;
        }
        startBatch();
      });
    }

    // 从课程首页点「自动发布」跳过来后，检测到 PENDING 标记就自动开始
    if (!taskActive && store.get(PENDING_KEY) && links.length) {
      store.remove(PENDING_KEY);
      renderListPage();
      log("检测到开始指令，正在自动开始……", "strong");
      setTimeout(startBatch, 800);
    }

    const s = store.get(SUMMARY_KEY);
    if (s) {
      try {
        const sum = JSON.parse(s);
        log(`上次自动发布结果：成功 ${sum.ok} 个，未完成 ${sum.fail} 个。`);
      } catch (e) {}
      store.remove(SUMMARY_KEY);
    }

    if (links.length && !statLogged) {
      statLogged = true;
      log(`话题来源统计：链接 ${scanTopicLinks().length} · 行扫描 ${scanTopicRows().length} · 接口数据 ${capturedListData.items.length} · 合计识别 ${links.length}`, "warn");
    }

    if (!links.length) {
      log("本页没有找到话题链接。", "warn");
      if (iframeListSrc) log("发现课程讨论列表页（内嵌在页面里）。点「📋 打开课程讨论列表页」按钮可整页打开。", "warn");
      if (!rescanScheduled) {
        rescanScheduled = true;
        [2500, 6000].forEach((ms) => setTimeout(() => {
          if (!parseTopic().topicId) renderListPage();
        }, ms));
      }
      const samples = new Set();
      document.querySelectorAll("a[href]").forEach((a) => {
        if (samples.size >= 10) return;
        const h = a.href || "";
        if (/bbs|topic|discuss|circle|讨论/i.test(h) || /[0-9a-f]{32}/i.test(h)) samples.add(h);
      });
      if (samples.size) {
        log("诊断：页面里相关链接的样式如下（可以把这些发给我看）：", "warn");
        samples.forEach((h) => log(esc(h.slice(0, 180))));
      } else {
        log(`诊断：当前页面地址：${esc(location.href.slice(0, 180))}`, "warn");
      }
      const iframeSrcs = [...document.querySelectorAll("iframe")].map((f) => f.src).filter((s) => s);
      if (iframeSrcs.length) {
        log(`诊断：页面里有 ${iframeSrcs.length} 个内嵌页面：`, "warn");
        iframeSrcs.slice(0, 5).forEach((s) => log(esc(s.slice(0, 180))));
      }
    }
  }

  // ===== 复制全部题目 =====
  function copyCheckedTopics() {
    const linksNow = getAllTopicLinks();
    if (!linksNow.length) {
      log("本页没有找到话题链接，无法复制。", "warn");
      return;
    }
    const boxes = [...document.querySelectorAll(".cxar-item-check")];
    let items;
    if (boxes.length) {
      const checked = new Set(boxes.filter((b) => b.checked).map((c) => c.dataset.id));
      if (!checked.size) {
        log("没有勾选任何话题。请在清单里勾选要复制的题目，或点「全选」。", "warn");
        return;
      }
      const seen = new Set();
      items = linksNow.filter((l) => {
        if (!checked.has(l.id) || seen.has(l.id)) return false;
        seen.add(l.id);
        return true;
      });
      if (!items.length) {
        log("勾选的话题在本页没找到对应链接，无法复制。", "warn");
        return;
      }
    } else {
      items = linksNow;
    }
    const fallbackTitleN = items.filter((it) => /^话题 [0-9a-f]{6}$/.test(it.title)).length;
    const text = buildCopyText(items);
    const copyBtn = document.getElementById("cxar-qa-copy");

    let ok = false;
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    } catch (e) { ok = false; }

    if (ok) {
      flashPrimary(copyBtn, `✅ 已复制 ${items.length} 道题目`, true);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => {
          flashPrimary(copyBtn, `✅ 已复制 ${items.length} 道题目`, true);
          log("已通过剪贴板 API 复制。");
        })
        .catch(() => {
          flashPrimary(copyBtn, "❌ 复制失败", false);
          setTimeout(() => {
            try { window.prompt("自动复制失败，请手动复制以下内容（Ctrl+C 复制，Esc 关闭）：", text); } catch (e) {}
          }, 120);
        });
    } else {
      flashPrimary(copyBtn, "❌ 复制失败", false);
      setTimeout(() => {
        try { window.prompt("自动复制失败，请手动复制以下内容（Ctrl+C 复制，Esc 关闭）：", text); } catch (e) {}
      }, 120);
    }

    const merged = mergeWorkingSet(items);
    saveTopics(merged.topics);
    updateListStats();
    log(`已复制 ${items.length} 道题目${ok ? "到剪贴板" : ""}（共 ${text.length} 字）。请粘贴给 AI 平台要答案。`, "strong");
    log(`工作集已更新：共 ${merged.topics.length} 题${merged.kept ? `（保留原答案 ${merged.kept} 题）` : ""}${merged.added ? `，新增 ${merged.added} 题` : ""}${merged.dropped ? `，移除 ${merged.dropped} 题` : ""}。自动发布按此工作集进行。`, "strong");
    if (merged.added || merged.dropped) {
      log("⚠️ 题目编号已变化！请把面板里新复制出的题目重新发给 AI 平台，并把新的答案块重新粘贴保存，旧答案块可能对不上号。", "warn");
    }
    if (fallbackTitleN) {
      log(`有 ${fallbackTitleN} 道题的标题未能识别（显示为「话题 xxxxxx」），请展开清单核对后再发给 AI。`, "warn");
    }
  }

  // ===== 保存答案 =====
  function saveAnswersFromTextarea() {
    const ta = document.getElementById("cxar-qa-answers");
    if (!ta) return;
    const raw = ta.value || "";
    if (raw.length > MAX_PASTE_LEN) {
      log("粘贴内容过大（超过 20 万字符，可能粘错了东西），未保存。", "error");
      return;
    }
    if (!raw.trim()) {
      log("答案区是空的。请先把答案块粘贴进来。", "warn");
      return;
    }
    const ws = loadTopics();
    if (!ws.length) {
      log("工作集为空：请先勾选话题并点「📋 复制全部题目」。", "error");
      return;
    }
    const map = parseAnswerBlock(raw);
    if (!map.size) {
      log("没有找到【答案N】段落（格式：每段以【答案1】【答案2】…开头）。未做任何修改。", "error");
      return;
    }
    let saved = 0;
    // 全量覆盖：缺失的编号会清空旧答案
    ws.forEach((e, i) => {
      e.answer = map.has(i + 1) ? map.get(i + 1) : "";
      if (e.answer) saved++;
    });
    const missing = [];
    for (let i = 0; i < ws.length; i++) if (!ws[i].answer) missing.push(i + 1);
    const outOfRange = [...map.keys()].filter((n) => n < 1 || n > ws.length);
    saveTopics(ws);
    draftAnswers = raw;
    store.set(ANSWERS_TEXT_KEY, raw);
    updateListStats();
    if (outOfRange.length) {
      log(`【答案${outOfRange.slice(0, 10).join("】【答案")}】编号超出题目数量（共 ${ws.length} 题），已忽略。`, "warn");
    }
    if (missing.length) {
      log(`答案已保存：${saved}/${ws.length} 题。缺答案编号：${missing.slice(0, 20).join("、")}${missing.length > 20 ? "…" : ""}（这些题将发「无答案时发」文案）。`, "warn");
    } else {
      log(`答案已保存：${saved}/${ws.length} 题，全部齐了。`, "ok");
    }
  }

  // ===== 话题页面板 =====
  function renderTopicPage() {
    const body = document.getElementById("cxar-qa-body");
    const q = loadQueue();
    const t = parseTopic();

    if (!["publish", "log"].includes(activeTopicTab)) activeTopicTab = "publish";

    // 自动发布进行中，且当前话题正好是队列里的 → 自动继续
    if (q && q.topics[q.index] && q.topics[q.index].id === t.topicId) {
      body.innerHTML = `
        <div class="cxar-tabbar">
          <div class="cxar-tab ${activeTopicTab === "publish" ? "active" : ""}" data-tab="publish">📤 发布</div>
          <div class="cxar-tab ${activeTopicTab === "log" ? "active" : ""}" data-tab="log">📊 日志</div>
        </div>
        <div class="cxar-content">
          <div class="cxar-tab-pane ${activeTopicTab === "publish" ? "active" : ""}" data-pane="publish">
            <div class="cxar-note">自动发布进行中</div>
            <div class="cxar-stat">第 ${q.index + 1}/${q.topics.length} 个：「${esc(q.topics[q.index].title)}」</div>
            <div class="cxar-note" id="cxar-qa-batch-src">正在准备发布……</div>
            <button class="cxar-run" id="cxar-qa-stop">⏹ 停止自动发布并返回列表</button>
          </div>
          <div class="cxar-tab-pane ${activeTopicTab === "log" ? "active" : ""}" data-pane="log">
            <div class="cxar-log" id="cxar-qa-log"></div>
            <div class="cxar-history" id="cxar-qa-history"></div>
          </div>
        </div>
      `;
      bindTabSwitch(body, () => activeTopicTab, (v) => { activeTopicTab = v; });
      renderHistory();
      body.querySelector("#cxar-qa-stop").addEventListener("click", () => {
        const listUrl = q.listUrl;
        clearQueue();
        log("已停止自动发布任务，即将返回列表页……");
        setTimeout(() => { location.href = listUrl; }, 1200);
      });
      batchOnTopicPage(q);
      return;
    }

    // 手动发布
    const r = resolveAnswer(t.topicId);
    const doneNow = isDone(t.topicId);
    body.innerHTML = `
      <div class="cxar-tabbar">
        <div class="cxar-tab ${activeTopicTab === "publish" ? "active" : ""}" data-tab="publish">📤 发布</div>
        <div class="cxar-tab ${activeTopicTab === "log" ? "active" : ""}" data-tab="log">📊 日志</div>
      </div>
      <div class="cxar-content">
        <div class="cxar-tab-pane ${activeTopicTab === "publish" ? "active" : ""}" data-pane="publish">
          ${q ? `<button class="cxar-run" id="cxar-qa-resume">▶ 继续自动发布（第 ${Math.min(q.index || 0, q.topics.length - 1) + 1}/${q.topics.length} 个）</button>` : ""}
          <div class="cxar-note" id="cxar-qa-pos-note">${r.entry ? `工作集第 ${r.entry.n} 题：「${esc(r.entry.title)}」` : "该话题不在已复制的工作集中"}</div>
          <div class="cxar-note">答案来源：${r.src === "answer" ? "答案区（已存答案）" : r.src === "fallback" ? "兜底文案（该题没存答案）" : "无（答案区与兜底都为空）"}</div>
          <div class="cxar-preview" id="cxar-qa-preview">${r.text ? esc(r.text) : "（无答案，兜底文案也为空，无法发布）"}</div>
          <div class="cxar-row"><label>无答案时发</label><input id="cxar-qa-fallback" value="${esc(store.get(FALLBACK_KEY) ?? FALLBACK_DEFAULT)}"></div>
          <button class="cxar-run" id="cxar-qa-publish">🚀 发布此答案</button>
          ${doneNow ? '<div class="cxar-note" id="cxar-qa-done-note">该话题已回复 ✅（仍可再次发布）</div>' : ""}
        </div>
        <div class="cxar-tab-pane ${activeTopicTab === "log" ? "active" : ""}" data-pane="log">
          <div class="cxar-log" id="cxar-qa-log"></div>
          <div class="cxar-history" id="cxar-qa-history"></div>
        </div>
      </div>
    `;
    bindTabSwitch(body, () => activeTopicTab, (v) => { activeTopicTab = v; });
    renderHistory();

    const fb = body.querySelector("#cxar-qa-fallback");
    fb.addEventListener("change", () => {
      store.set(FALLBACK_KEY, fb.value.trim());
      renderTopicPage();
    });
    body.querySelector("#cxar-qa-publish").addEventListener("click", async function () {
      const r2 = resolveAnswer(t.topicId);
      if (!r2.text) {
        log("没有可发布的内容：该题没有答案，且「无答案时发」为空。", "warn");
        return;
      }
      this.disabled = true;
      const result = await doReply(r2.text);
      this.disabled = false;
      if (result === "ok") {
        markDone(t.topicId);
        log("已记录该话题为「已回复」，列表页会显示 ✅。", "ok");
        const note = document.getElementById("cxar-qa-done-note");
        if (note) note.textContent = "该话题已回复 ✅（仍可再次发布）";
      }
    });
    const resume = body.querySelector("#cxar-qa-resume");
    if (resume) {
      resume.addEventListener("click", () => {
        if (q && q.topics[q.index]) location.href = q.topics[q.index].url;
      });
    }
  }

  // ===== 发布机制 =====
  async function postReply(content) {
    let textarea = null;
    for (let i = 0; i < 5 && !textarea; i++) {
      textarea = document.querySelector("textarea");
      if (!textarea && document.querySelector(".addReply")) {
        document.querySelector(".addReply").click();
        await sleep(800);
        textarea = document.querySelector("textarea");
      }
      if (!textarea) await sleep(1000);
    }
    if (!textarea) {
      log("当前页面没有回复输入框。请确认你在能看到话题内容和回复框的页面。", "error");
      return false;
    }
    setTextareaValue.call(textarea, content);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(1500);

    let btn = null, p = textarea;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
      btn = [...p.querySelectorAll("button, a, span, div")].find(
        (n) => /^(发布|提交|发送|回复)$/.test(n.textContent.trim()) && n.offsetParent !== null
      );
      if (btn) break;
    }
    if (!btn) {
      log("找到输入框但没找到发布按钮。", "error");
      return false;
    }
    btn.click();
    log("已点击发布……");
    return true;
  }

  // 返回 "ok" | "fail" | "cancel"
  async function doReply(content) {
    try {
      const wait = pageLoadTime + MIN_PAGE_MS - Date.now();
      if (wait > 0) {
        log(`页面刚打开，再等 ${Math.ceil(wait / 1000)} 秒……`);
        await sleep(wait);
      }
      if (!content) {
        log("没有可发布的内容（答案与兜底文案都为空），跳过。", "warn");
        return "cancel";
      }
      log(`即将发布：${content.slice(0, 50)}${content.length > 50 ? "……" : ""}`, "strong");
      const clicked = await postReply(content);
      if (!clicked) return "fail";

      await sleep(1500);
      let toast = detectToast();
      if (!toast) {
        await sleep(2000);
        toast = detectToast();
      }
      if (toast) {
        log(`⚠️ 检测到发布失败提示：「${toast}」`, "error");
        log("原因可能是：间隔太短（发得太频繁），或有其他学习通页面/手机 App 在线。");
        return "fail";
      }
      log("✅ 未检测到失败提示，回复应已发布。", "ok");
      return "ok";
    } catch (e) {
      log(`出错了：${e.message}`, "error");
      return "fail";
    }
  }

  // ===== 自动发布流程 =====
  function startBatch() {
    const ws = loadTopics();
    if (!ws.length) {
      log("工作集为空：请先勾选话题并点「📋 复制全部题目」。", "warn");
      return;
    }
    const fb = getEffectiveFallback();
    const topics = [];
    const skippedNoContent = [];
    ws.forEach((e, i) => {
      if (isDone(e.id)) return;
      if (!e.answer && !fb) { skippedNoContent.push(i + 1); return; }
      topics.push({ id: e.id, title: e.title, url: e.url, answer: e.answer || "" });
    });
    if (!topics.length) {
      log("没有需要发布的话题（工作集里的题都已回复过，或没有可发布内容）。", "warn");
      return;
    }
    if (skippedNoContent.length) {
      log(`以下题号没有答案且「无答案时发」为空，本轮跳过：${skippedNoContent.slice(0, 20).join("、")}${skippedNoContent.length > 20 ? "…" : ""}`, "warn");
    }
    saveQueue({ listUrl: location.href, index: 0, topics });
    log(`开始自动发布：共 ${topics.length} 个话题（已跳过已回复的），每个间隔 ${getInterval()} 秒，本轮使用当前已保存的答案。2 秒后打开第 1 个话题……`, "strong");
    setTimeout(() => { location.href = topics[0].url; }, 2000);
  }

  async function batchOnTopicPage(q) {
    const t = parseTopic();
    if (!t.bbsId || !t.topicId) {
      log("自动发布中断：当前页面不是话题详情页（可能登录已过期）。任务已停止。", "error");
      clearQueue();
      return;
    }
    const cur = q.topics[q.index];
    if (!cur || cur.id !== t.topicId) {
      log("自动发布暂停：当前话题不在任务进度上。点「▶ 继续自动发布」回到任务话题。", "warn");
      return;
    }
    log(`自动发布 ${q.index + 1}/${q.topics.length}：「${cur.title}」`, "strong");
    if (isDone(t.topicId)) {
      log("该话题已回复过，跳过。", "ok");
      advance(q, "ok");
      return;
    }
    const content = cur.answer || getEffectiveFallback();
    const srcNote = document.getElementById("cxar-qa-batch-src");
    if (srcNote) srcNote.textContent = "答案来源：" + (cur.answer ? "答案区（已存答案）" : "兜底文案（该题没存答案）");
    const result = await doReply(content);
    if (result === "ok") markDone(t.topicId);
    advance(q, result);
  }

  function advance(q, result) {
    if (result === "ok") addSummary("ok");
    else if (result === "fail") addSummary("fail");
    q.index++;
    if (q.index >= q.topics.length) {
      log("🎉 全部话题处理完成！3 秒后返回讨论列表页。", "ok");
      const listUrl = q.listUrl;
      clearQueue();
      setTimeout(() => { location.href = listUrl; }, 3000);
      return;
    }
    saveQueue(q);
    const intervalSec = getInterval();
    log(`等待 ${intervalSec} 秒后打开下一个话题：「${q.topics[q.index].title}」……`, "warn");
    setTimeout(() => { location.href = q.topics[q.index].url; }, intervalSec * 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUI);
  } else {
    initUI();
  }
})();