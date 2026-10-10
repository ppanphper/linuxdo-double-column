// ==UserScript==
// @name         Linux.do 双栏阅读预览
// @namespace    https://linux.do/
// @version      0.15.0
// @description  在 Linux.do 话题列表中用右侧面板预览帖子（支持原始楼层与树状评论双视图、热门排序、回复/点赞/话题与楼层收藏/投票/时间线及阅读时长上报）
// @match        https://linux.do/*
// @homepageURL  https://github.com/ppanphper/linuxdo-double-column
// @supportURL   https://github.com/ppanphper/linuxdo-double-column/issues
// @updateURL    https://raw.githubusercontent.com/ppanphper/linuxdo-double-column/main/linuxdo-double-column.user.js
// @downloadURL  https://raw.githubusercontent.com/ppanphper/linuxdo-double-column/main/linuxdo-double-column.user.js
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'ld-double-column-panel';
  const STYLE_ID = 'ld-double-column-style';
  const WIDTH_KEY = 'ld-double-column-width';
  const VIEW_KEY = 'ld-double-column-view';
  const TREE_SORT_KEY = 'ld-double-column-tree-sort';
  const DEFAULT_WIDTH = 600;
  const MAX_WIDTH = 680;
  const MIN_WIDTH = 380;
  const MOBILE_BREAKPOINT = 780;
  const POSTS_PER_BATCH = 20;
  const PAGINATION_PREFETCH_PX = 800;
  const CACHE_LIMIT = 30;
  const CACHE_TTL = 5 * 60 * 1000;
  const HOVER_DELAY = 80;
  const MAX_PREFETCH = 4;
  const LIKE_ACTION_ID = 2;
  const TIMINGS_TICK_MS = 1000;
  const TIMINGS_FLUSH_MS = 20000;
  const LIGHTBOX_MIN_SCALE = 0.5;
  const LIGHTBOX_MAX_SCALE = 5;
  const NOTIFICATION_LEVELS = [
    { level: 3, name: '关注', desc: '此话题有新回复就通知' },
    { level: 2, name: '跟踪', desc: '显示新回复数量' },
    { level: 1, name: '普通', desc: '被 @ 或收到回复时通知' },
    { level: 0, name: '免打扰', desc: '不接收任何通知' },
  ];

  const state = {
    panel: null,
    scroll: null,
    list: null,
    sentinel: null,
    topSentinel: null,
    timeline: null,
    timelineHandle: null,
    timelineLabel: null,
    timelineStart: null,
    timelineLast: null,
    backButton: null,
    currentPostNumber: 0,
    notifMenu: null,
    notifButton: null,
    postMenu: null,
    postMenuButton: null,
    postFilter: null,
    postFilterLoading: false,
    postFilterToken: 0,
    postFilterRestoreIndex: 0,
    timelineDragging: false,
    observer: null,
    title: null,
    status: null,
    toast: null,
    composer: null,
    composerTarget: null,
    composerTargetText: null,
    composerTargetSwitch: null,
    replyBar: null,
    composerInput: null,
    composerError: null,
    composerSend: null,
    composerPreview: null,
    composerPreviewButton: null,
    composerPreviewTimer: null,
    pendingUploads: 0,
    lightbox: null,
    lightboxStage: null,
    lightboxImg: null,
    lightboxPrev: null,
    lightboxNext: null,
    lightboxCounter: null,
    lightboxClose: null,
    lightboxImages: [],
    lightboxIndex: -1,
    lightboxFitScale: 1,
    lightboxScale: 1,
    lightboxX: 0,
    lightboxY: 0,
    lightboxPointerId: null,
    lightboxDragStartX: 0,
    lightboxDragStartY: 0,
    lightboxDragOriginX: 0,
    lightboxDragOriginY: 0,
    lightboxReturnFocus: null,
    liveChannel: '',
    liveHandler: null,
    replyToNumber: null,
    submittingReply: false,
    currentUrl: '',
    currentTopicId: '',
    topicLoadFailed: false,
    loadToken: 0,
    stream: [],
    streamIndex: new Map(),
    topicMeta: null,
    topicBookmarkButton: null,
    startIdx: 0,
    endIdx: -1,
    currentIdx: 0,
    loadedIds: new Set(),
    allPosts: new Map(),
    viewMode: localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'original',
    treeSort: localStorage.getItem(TREE_SORT_KEY) === 'time' ? 'time' : 'hot',
    treeExpanded: new Set(),
    treeRepliesLoaded: new Set(),
    treeRepliesLoading: new Set(),
    treeReplyIds: new Map(),
    treeDirectReplyIds: new Map(),
    treeBranchReplyIds: new Map(),
    viewBar: null,
    viewNote: null,
    treeButton: null,
    treeSortSelect: null,
    paginationFrame: 0,
    loadingMore: false,
    loadingBefore: false,
    hoverTimer: 0,
    hoverLink: null,
    open: false,
    fullscreen: false,
    width: readWidth(),
    savedScrollY: 0,
    parentUrl: '',
    historyActive: false,
    closeFromHistory: false,
  };

  const topicCache = new Map();
  const pendingFetches = new Map();
  const trackedTopicViews = new Set();
  const localLastRead = new Map();
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  let csrfToken = '';
  let toastTimer = 0;

  // 请求均使用页面上下文的原生 fetch：浏览器会自动附带真实 User-Agent，
  // same-origin credentials 同时保留登录态及 Cloudflare 相关 Cookie。

  const readTracker = {
    timings: new Map(),
    topicTime: 0,
    tickTimer: 0,
    flushTimer: 0,
    disabled: false,
  };

  function readWidth() {
    const value = Number.parseInt(localStorage.getItem(WIDTH_KEY), 10);
    return Number.isFinite(value) ? value : DEFAULT_WIDTH;
  }

  function clampWidth(value) {
    const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.6)));
    return Math.min(Math.max(value, MIN_WIDTH), max);
  }

  function normalizeTopicUrl(href) {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;
      if (!/^\/t\/[^/]+\/\d+(?:\/\d+)?$/.test(url.pathname)) return null;
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function topicIdFromUrl(href) {
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return '';
      return url.pathname.match(/^\/t\/[^/]+\/(\d+)/)?.[1] || '';
    } catch {
      return '';
    }
  }

  function floorFromUrl(href) {
    try {
      const match = new URL(href, location.href).pathname.match(/^\/t\/[^/]+\/\d+\/(\d+)/);
      return match ? Number(match[1]) : 0;
    } catch {
      return 0;
    }
  }

  function isModifiedClick(event) {
    return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  }

  function hasFreshCache(topicId) {
    const entry = topicCache.get(topicId);
    return Boolean(entry && Date.now() - entry.time < CACHE_TTL);
  }

  function fetchTopic(topicId, { force = false, trackView = false } = {}) {
    // 每个话题在本页面会话内只上报一次浏览；悬停预取不传 trackView，不计入浏览数。
    const shouldTrack = trackView && !trackedTopicViews.has(String(topicId));
    if (!force) {
      const entry = topicCache.get(topicId);
      if (entry && Date.now() - entry.time < CACHE_TTL) {
        topicCache.delete(topicId);
        topicCache.set(topicId, entry);
        if (shouldTrack) requestTopic(topicId, true).catch(() => {});
        return Promise.resolve(entry.data);
      }
      const pending = pendingFetches.get(topicId);
      if (pending) {
        if (shouldTrack) requestTopic(topicId, true).catch(() => {});
        return pending;
      }
    }
    return requestTopic(topicId, shouldTrack);
  }

  function requestTopic(topicId, trackView) {
    const params = new URLSearchParams({ include_suggested: 'false' });
    const headers = { Accept: 'application/json' };
    if (trackView) {
      // 与原生前端 lib/ajax.js 一致：服务端只在收到这两个请求头时写入 topic_views，
      // 计入用户的浏览话题数；track_visit 则更新 topic_users 的最近访问时间。
      params.set('track_visit', 'true');
      headers['Discourse-Track-View'] = 'true';
      headers['Discourse-Track-View-Topic-Id'] = String(topicId);
      trackedTopicViews.add(String(topicId));
    }

    // 不带 slug：/t/topic/{id}.json 遇到 slug 不符的话题会 301 重定向并丢弃 track_visit。
    const request = fetch(`/t/${topicId}.json?${params}`, {
      credentials: 'same-origin',
      headers,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        topicCache.set(topicId, { time: Date.now(), data });
        while (topicCache.size > CACHE_LIMIT) {
          topicCache.delete(topicCache.keys().next().value);
        }
        return data;
      })
      .catch((error) => {
        if (trackView) trackedTopicViews.delete(String(topicId));
        throw error;
      })
      .finally(() => {
        if (pendingFetches.get(topicId) === request) pendingFetches.delete(topicId);
      });

    pendingFetches.set(topicId, request);
    return request;
  }

  function getCsrfToken(force = false) {
    if (!force) {
      if (csrfToken) return Promise.resolve(csrfToken);
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta?.content) {
        csrfToken = meta.content;
        return Promise.resolve(csrfToken);
      }
    }

    return fetch('/session/csrf.json', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!data?.csrf) throw new Error('无法获取 CSRF token');
        csrfToken = data.csrf;
        return csrfToken;
      });
  }

  async function apiRequest(method, path, body, retried = false) {
    const token = await getCsrfToken(retried);
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 403 && !retried) {
      csrfToken = '';
      return apiRequest(method, path, body, true);
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = Array.isArray(data?.errors) && data.errors.length
        ? data.errors.join('；')
        : `请求失败（HTTP ${response.status}）`;
      throw new Error(message);
    }
    return data;
  }

  function addStyle() {
    if (!document.head || document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      :root {
        --ld-preview-width: ${state.width}px;
      }

      #${PANEL_ID} {
        position: fixed;
        /* 低于站点头部 (z-index: 1000)，让头像弹出的通知菜单能盖在面板上方 */
        z-index: 999;
        inset: var(--ld-preview-top, 0px) 0 0 auto;
        display: none;
        width: var(--ld-preview-width);
        min-width: 0;
        flex-direction: column;
        overflow: hidden;
        background: var(--secondary, #ffffff);
        color: var(--primary, #202124);
        border-left: 1px solid var(--primary-low, #d7d7d7);
        box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
      }

      body.ld-double-column-open #${PANEL_ID} {
        display: flex;
      }

      body.ld-double-column-open #main-outlet-wrapper {
        width: calc(100% - var(--ld-preview-width)) !important;
        max-width: none !important;
        min-width: 0 !important;
        margin-left: 0 !important;
        margin-right: var(--ld-preview-width) !important;
        box-sizing: border-box !important;
      }

      body.ld-double-column-open #main-outlet {
        width: 100% !important;
        max-width: none !important;
        min-width: 0 !important;
        margin-right: 0 !important;
      }

      body.ld-double-column-open #main-outlet > .container,
      body.ld-double-column-open #main-outlet .topic-list,
      body.ld-double-column-open #main-outlet .topic-list-body {
        width: 100% !important;
        max-width: none !important;
        min-width: 0 !important;
      }

      body.ld-double-column-fullscreen #${PANEL_ID} {
        width: 100vw;
      }

      body.ld-double-column-fullscreen #main-outlet {
        visibility: hidden !important;
      }

      #${PANEL_ID} .ld-preview-resizer {
        position: absolute;
        z-index: 2;
        top: 0;
        bottom: 0;
        left: -5px;
        width: 10px;
        cursor: col-resize;
        touch-action: none;
      }

      #${PANEL_ID} .ld-preview-resizer::after {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 4px;
        width: 2px;
        content: '';
        background: transparent;
        transition: background 120ms ease;
      }

      #${PANEL_ID} .ld-preview-resizer:hover::after,
      body.ld-double-column-resizing #${PANEL_ID} .ld-preview-resizer::after {
        background: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 42px;
        padding: 0 8px 0 14px;
        color: var(--primary, #202124);
        background: var(--secondary, #ffffff);
        border-bottom: 1px solid var(--primary-low, #d7d7d7);
      }

      #${PANEL_ID} .ld-preview-view-bar {
        display: flex;
        min-height: 46px;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        color: var(--primary-medium, #757575);
        background: var(--secondary, #ffffff);
        border-bottom: 1px solid var(--primary-low, #d7d7d7);
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-view-bar[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-view-title {
        color: var(--primary, #202124);
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-view-note {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-tree-sort,
      #${PANEL_ID} .ld-preview-view-switch {
        width: auto;
        max-width: 132px;
        flex-shrink: 0;
        padding: 5px 8px;
        color: var(--primary, #202124);
        background: var(--secondary, #ffffff);
        border: 1px solid var(--primary-low-mid, #cccccc);
        border-radius: 5px;
        cursor: pointer;
        font: inherit;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-timeline {
        display: none !important;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-scroll {
        padding-right: 18px;
      }

      #${PANEL_ID} .ld-preview-heading {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.3;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-heading.is-retryable,
      #${PANEL_ID} .ld-preview-status.is-retryable {
        cursor: pointer;
      }

      #${PANEL_ID} .ld-preview-heading.is-retryable:focus-visible,
      #${PANEL_ID} .ld-preview-status.is-retryable:focus-visible {
        outline: 2px solid currentColor;
        outline-offset: 2px;
      }

      #${PANEL_ID} .ld-preview-action {
        display: inline-grid;
        width: 30px;
        height: 30px;
        flex: 0 0 30px;
        place-items: center;
        padding: 0;
        color: inherit;
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 18px;
        line-height: 1;
      }

      #${PANEL_ID} .ld-preview-action:hover,
      #${PANEL_ID} .ld-preview-action:focus-visible {
        background: var(--primary-low, #e9e9e9);
        outline: none;
      }

      #${PANEL_ID} .ld-preview-content {
        position: relative;
        min-height: 0;
        flex: 1;
        background: var(--secondary, #ffffff);
      }

      #${PANEL_ID} .ld-preview-scroll {
        height: 100%;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 0 18px 30px;
        opacity: 1;
        transition: opacity 120ms ease;
      }

      #${PANEL_ID}.is-loading .ld-preview-scroll {
        opacity: 0.35;
      }

      #${PANEL_ID} .ld-preview-timeline {
        position: absolute;
        z-index: 2;
        top: 8px;
        right: 6px;
        bottom: 8px;
        display: none;
        width: 48px;
        flex-direction: column;
        align-items: center;
        gap: 6px;
      }

      #${PANEL_ID}.has-timeline .ld-preview-timeline {
        display: flex;
      }

      #${PANEL_ID}.has-timeline .ld-preview-scroll {
        padding-right: 64px;
      }

      #${PANEL_ID} .ld-preview-timeline-btn {
        display: inline-grid;
        width: 26px;
        height: 26px;
        place-items: center;
        padding: 0;
        color: var(--primary-medium, #757575);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 15px;
        line-height: 1;
      }

      #${PANEL_ID} .ld-preview-timeline-btn:hover,
      #${PANEL_ID} .ld-preview-timeline-btn:focus-visible {
        background: var(--primary-low, #e9e9e9);
        outline: none;
      }

      #${PANEL_ID} .ld-preview-timeline-track {
        position: relative;
        width: 26px;
        flex: 1;
        cursor: pointer;
        touch-action: none;
      }

      #${PANEL_ID} .ld-preview-timeline-track::before {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        width: 8px;
        content: '';
        background: var(--primary-low, #d7d7d7);
        border-radius: 4px;
        transform: translateX(-50%);
        transition: background 120ms ease;
      }

      #${PANEL_ID} .ld-preview-timeline-track:hover::before {
        background: var(--primary-low-mid, #c2c2c2);
      }

      #${PANEL_ID} .ld-preview-timeline-handle {
        position: absolute;
        top: 0;
        left: 50%;
        display: grid;
        width: 26px;
        height: 32px;
        place-items: center;
        color: var(--secondary, #ffffff);
        background: var(--tertiary, #0088cc);
        border-radius: 8px;
        box-shadow: 0 1px 5px rgba(0, 0, 0, 0.3);
        cursor: grab;
        font-size: 14px;
        line-height: 1;
        user-select: none;
        transform: translate(-50%, -50%);
      }

      #${PANEL_ID} .ld-preview-timeline-handle:active {
        cursor: grabbing;
      }

      #${PANEL_ID} .ld-preview-timeline-back {
        position: absolute;
        top: 0;
        right: calc(100% + 4px);
        z-index: 1;
        padding: 3px 9px;
        color: var(--secondary, #ffffff);
        background: var(--tertiary, #0088cc);
        border: 0;
        border-radius: 12px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 1.4;
        white-space: nowrap;
        transform: translateY(-50%);
      }

      #${PANEL_ID} .ld-preview-timeline-back::after {
        position: absolute;
        top: 50%;
        left: 100%;
        width: 14px;
        height: 2px;
        content: '';
        background: var(--tertiary, #0088cc);
        transform: translateY(-50%);
      }

      #${PANEL_ID} .ld-preview-timeline-back[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-timeline-label {
        min-height: 28px;
        color: var(--primary-medium, #757575);
        font-size: 11px;
        line-height: 1.25;
        text-align: center;
        white-space: pre-line;
        user-select: none;
      }

      #${PANEL_ID} .ld-preview-timeline-date {
        max-width: 48px;
        padding: 2px 0;
        color: var(--primary-medium, #757575);
        background: transparent;
        border: 0;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 1.2;
        text-align: center;
      }

      #${PANEL_ID} .ld-preview-timeline-date:hover {
        color: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-timeline-foot {
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: center;
      }

      #${PANEL_ID} .ld-preview-notif-menu {
        position: absolute;
        right: 100%;
        bottom: 0;
        z-index: 3;
        display: flex;
        flex-direction: column;
        min-width: 108px;
        margin-right: 4px;
        padding: 4px;
        background: var(--secondary, #ffffff);
        border: 1px solid var(--primary-low, #d7d7d7);
        border-radius: 6px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
      }

      #${PANEL_ID} .ld-preview-notif-menu[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-notif-option {
        padding: 6px 10px;
        color: var(--primary, #202124);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        text-align: left;
      }

      #${PANEL_ID} .ld-preview-notif-option:hover {
        background: var(--primary-low, #e9e9e9);
      }

      #${PANEL_ID} .ld-preview-bookmark.is-bookmarked {
        color: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-post {
        --ld-post-avatar-size: 32px;
        --ld-post-header-gap: 8px;
        padding: 14px 0 2px;
        border-bottom: 1px solid var(--primary-low, #e3e3e3);
      }

      #${PANEL_ID} .ld-preview-tree-op {
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 2px solid var(--primary-low, #e3e3e3);
      }

      #${PANEL_ID} .ld-preview-tree-op > .ld-preview-post {
        border-bottom: 0;
      }

      #${PANEL_ID} .ld-preview-tree-node {
        --ld-tree-axis: 14px;
        --ld-tree-indent: clamp(17px, 2vw, 22px);
        --ld-tree-connector: rgba(127, 127, 127, 0.24);
        --ld-tree-connector: color-mix(in srgb, var(--primary, #202124) 18%, transparent);
        position: relative;
        min-width: 0;
      }

      #${PANEL_ID} .ld-preview-tree-node > .ld-preview-post {
        position: relative;
        border-bottom: 0;
      }

      #${PANEL_ID} .ld-preview-tree-children {
        position: relative;
        margin-left: var(--ld-tree-axis);
        padding-left: var(--ld-tree-indent);
      }

      #${PANEL_ID} .ld-preview-tree-children[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-tree-rail {
        position: absolute;
        z-index: 1;
        top: 0;
        bottom: 0;
        left: 0;
        width: 14px;
        padding: 0;
        border: 0;
        outline: 0;
        background: transparent;
        cursor: pointer;
        transform: translateX(-50%);
      }

      #${PANEL_ID} .ld-preview-tree-stem {
        position: absolute;
        z-index: 1;
        top: 36px;
        bottom: 0;
        left: var(--ld-tree-axis);
        width: 14px;
        padding: 0;
        border: 0;
        outline: 0;
        background: transparent;
        cursor: pointer;
        transform: translateX(-50%);
      }

      #${PANEL_ID} .ld-preview-tree-stem::before {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        width: 1px;
        background: var(--ld-tree-connector);
        content: '';
        transform: translateX(-50%);
        transition: background-color 120ms ease;
      }

      #${PANEL_ID} .ld-preview-tree-stem::after {
        position: absolute;
        bottom: 9px;
        left: 50%;
        display: flex;
        width: 14px;
        height: 14px;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        color: var(--ld-tree-connector);
        background: var(--secondary, #ffffff);
        border: 1px solid var(--ld-tree-connector);
        border-radius: 50%;
        content: '−';
        font-size: 10px;
        font-weight: 600;
        line-height: 1;
        transform: translate(-50%, 50%);
        transition: color 120ms ease, border-color 120ms ease;
      }

      #${PANEL_ID} .ld-preview-tree-node.is-tree-rail-hovered > .ld-preview-post > .ld-preview-tree-stem::before {
        background: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-tree-node.is-tree-rail-hovered > .ld-preview-post > .ld-preview-tree-stem::after {
        color: var(--tertiary, #0088cc);
        background: var(--secondary, #ffffff);
        border-color: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-tree-children > .ld-preview-tree-node::before {
        position: absolute;
        z-index: 0;
        top: 0;
        left: calc(var(--ld-tree-indent) * -1);
        width: var(--ld-tree-indent);
        height: 22px;
        box-sizing: border-box;
        border-bottom: 1px solid var(--ld-tree-connector);
        border-left: 1px solid var(--ld-tree-connector);
        border-bottom-left-radius: 8px;
        content: '';
        pointer-events: none;
        transition: border-color 120ms ease;
      }

      #${PANEL_ID} .ld-preview-tree-node.is-tree-rail-hovered > .ld-preview-tree-children > .ld-preview-tree-node::before {
        border-color: var(--tertiary, #0088cc);
      }

      /* 非末尾兄弟负责延续竖线；最后一条只保留上方弯折，自然收尾。 */
      #${PANEL_ID} .ld-preview-tree-children > .ld-preview-tree-node:not(:last-of-type)::after {
        position: absolute;
        z-index: 0;
        top: 22px;
        bottom: -2px;
        left: calc(var(--ld-tree-indent) * -1);
        width: 1px;
        background: var(--ld-tree-connector);
        content: '';
        pointer-events: none;
        transform: translateX(-50%);
        transition: background-color 120ms ease;
      }

      #${PANEL_ID} .ld-preview-tree-node.is-tree-rail-hovered > .ld-preview-tree-children > .ld-preview-tree-node:not(:last-of-type)::after {
        background: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-tree-collapse {
        display: inline-flex;
        width: auto;
        height: 22px;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        margin: 0 auto 0 0;
        padding: 0 7px;
        color: var(--tertiary, #0088cc);
        background: rgba(0, 136, 204, 0.12);
        border: 1px solid var(--tertiary, #0088cc);
        border-radius: 11px;
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 1;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-tree-collapse:disabled {
        cursor: wait;
        opacity: 0.7;
      }

      #${PANEL_ID} .ld-preview-tree-collapse:hover {
        color: var(--secondary, #ffffff);
        background: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-tree-empty {
        padding: 28px 12px;
        color: var(--primary-medium, #757575);
        text-align: center;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-tree-op {
        margin-bottom: 5px;
        padding-bottom: 3px;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-post {
        --ld-post-avatar-size: 28px;
        --ld-post-header-gap: 7px;
        padding-top: 8px;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-post-header {
        margin-bottom: 3px;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-avatar {
        width: var(--ld-post-avatar-size);
        height: var(--ld-post-avatar-size);
        flex-basis: var(--ld-post-avatar-size);
      }

      #${PANEL_ID}.is-tree-view .ld-preview-post .cooked {
        line-height: 1.5;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-post .cooked > :first-child {
        margin-top: 0;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-post .cooked > :last-child {
        margin-bottom: 3px;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-post .cooked p {
        margin-block: 4px;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-post-footer {
        min-height: 24px;
        align-items: center;
        padding: 0 0 2px;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-post-action {
        padding: 2px 6px;
        line-height: 1.25;
      }

      #${PANEL_ID}.is-tree-view .ld-preview-tree-node + .ld-preview-tree-node {
        margin-top: 2px;
      }

      #${PANEL_ID} .ld-preview-post-header {
        display: flex;
        align-items: center;
        gap: var(--ld-post-header-gap);
        margin-bottom: 8px;
      }

      #${PANEL_ID} .ld-preview-avatar {
        width: var(--ld-post-avatar-size);
        height: var(--ld-post-avatar-size);
        flex: 0 0 var(--ld-post-avatar-size);
        border-radius: 50%;
      }

      #${PANEL_ID} .ld-preview-username {
        overflow: hidden;
        color: var(--primary, #202124);
        font-size: 14px;
        font-weight: 600;
        text-decoration: none;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-post-meta {
        margin-left: auto;
        flex-shrink: 0;
        color: var(--primary-medium, #757575);
        font-size: 12px;
      }

      #${PANEL_ID} .ld-preview-post .cooked {
        font-size: 15px;
        line-height: 1.65;
        overflow-wrap: break-word;
      }

      /* 正文与用户名对齐；回复树的层级缩进仍由 tree-children 单独控制。 */
      #${PANEL_ID} .ld-preview-post > .cooked {
        margin-inline-start: calc(var(--ld-post-avatar-size) + var(--ld-post-header-gap));
      }

      #${PANEL_ID} .ld-preview-post .cooked img:not(.emoji) {
        max-width: 100%;
        height: auto;
        cursor: zoom-in;
      }

      #ld-preview-lightbox {
        position: fixed;
        z-index: 2147483100;
        inset: 0;
        display: none;
        overflow: hidden;
        background: rgba(0, 0, 0, 0.88);
        color: #ffffff;
        user-select: none;
      }

      #ld-preview-lightbox.is-open {
        display: block;
      }

      #ld-preview-lightbox .ld-preview-lightbox-stage {
        position: absolute;
        inset: 24px;
        display: flex;
        overflow: hidden;
        align-items: center;
        justify-content: center;
        cursor: zoom-out;
      }

      #ld-preview-lightbox .ld-preview-lightbox-image {
        width: auto;
        height: auto;
        max-width: none;
        max-height: none;
        object-fit: contain;
        border-radius: 4px;
        box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
        cursor: zoom-in;
        flex: 0 0 auto;
        touch-action: none;
        transform-origin: center;
        will-change: transform;
      }

      #ld-preview-lightbox.is-pannable .ld-preview-lightbox-image {
        cursor: grab;
      }

      #ld-preview-lightbox.is-zoomed .ld-preview-lightbox-image {
        cursor: grab;
      }

      #ld-preview-lightbox.is-dragging .ld-preview-lightbox-image {
        cursor: grabbing;
      }

      #ld-preview-lightbox .ld-preview-lightbox-button {
        position: absolute;
        z-index: 1;
        display: grid;
        width: 44px;
        height: 52px;
        place-items: center;
        padding: 0;
        color: #ffffff;
        background: rgba(20, 20, 20, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.35);
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 34px;
        line-height: 1;
      }

      #ld-preview-lightbox .ld-preview-lightbox-button:hover:not(:disabled),
      #ld-preview-lightbox .ld-preview-lightbox-button:focus-visible {
        background: rgba(60, 60, 60, 0.9);
        border-color: rgba(255, 255, 255, 0.75);
        outline: none;
      }

      #ld-preview-lightbox .ld-preview-lightbox-button:disabled {
        cursor: default;
        opacity: 0.25;
      }

      #ld-preview-lightbox .ld-preview-lightbox-prev,
      #ld-preview-lightbox .ld-preview-lightbox-next {
        top: 50%;
        transform: translateY(-50%);
      }

      #ld-preview-lightbox .ld-preview-lightbox-prev {
        left: 16px;
      }

      #ld-preview-lightbox .ld-preview-lightbox-next {
        right: 16px;
      }

      #ld-preview-lightbox .ld-preview-lightbox-close {
        top: 14px;
        right: 16px;
        width: 40px;
        height: 40px;
        font-size: 28px;
      }

      #ld-preview-lightbox .ld-preview-lightbox-counter {
        position: absolute;
        z-index: 1;
        top: 14px;
        left: 50%;
        min-width: 92px;
        padding: 7px 10px;
        background: rgba(20, 20, 20, 0.72);
        border-radius: 4px;
        font-size: 13px;
        line-height: 1.2;
        text-align: center;
        transform: translateX(-50%);
      }

      #ld-preview-lightbox [hidden] {
        display: none !important;
      }

      @media (max-width: 600px) {
        #ld-preview-lightbox .ld-preview-lightbox-stage {
          inset: 12px;
        }

        #ld-preview-lightbox .ld-preview-lightbox-button {
          width: 40px;
          height: 48px;
        }

        #ld-preview-lightbox .ld-preview-lightbox-prev {
          left: 8px;
        }

        #ld-preview-lightbox .ld-preview-lightbox-next {
          right: 8px;
        }

        #ld-preview-lightbox .ld-preview-lightbox-close {
          top: 8px;
          right: 8px;
          height: 40px;
        }

        #ld-preview-lightbox .ld-preview-lightbox-counter {
          top: 8px;
        }
      }

      #${PANEL_ID} .ld-preview-post .cooked pre {
        overflow-x: auto;
      }

      #${PANEL_ID} .ld-preview-reply-to {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        margin-left: auto;
        flex-shrink: 0;
        padding: 2px 6px;
        color: var(--primary-medium, #757575);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        line-height: 1.4;
      }

      #${PANEL_ID} .ld-preview-reply-to-avatar {
        width: 20px;
        height: 20px;
        border-radius: 50%;
      }

      #${PANEL_ID} .ld-preview-reply-to:hover {
        color: var(--tertiary, #0088cc);
        background: var(--primary-low, #e9e9e9);
      }

      #${PANEL_ID} .ld-preview-reply-to.is-open {
        color: var(--tertiary, #0088cc);
        background: var(--primary-low, #e9e9e9);
      }

      #${PANEL_ID} .ld-preview-reply-to + .ld-preview-post-meta {
        margin-left: 0;
      }

      #${PANEL_ID} .ld-preview-replies-toggle {
        margin-right: auto;
        padding: 3px 10px;
        background: var(--primary-low, #e9e9e9);
      }

      #${PANEL_ID} .ld-preview-embedded-replies {
        margin: 4px 0 12px 12px;
        padding: 6px 0 0 18px;
        border-left: 1px solid var(--primary-low-mid, #cccccc);
      }

      #${PANEL_ID} .ld-preview-embedded-parents {
        margin-top: 0;
      }

      #${PANEL_ID} .ld-preview-embedded-reply {
        display: flex;
        gap: 10px;
        padding: 8px 0;
      }

      #${PANEL_ID} .ld-preview-avatar-small {
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
      }

      #${PANEL_ID} .ld-preview-embedded-main {
        flex: 1;
        min-width: 0;
      }

      #${PANEL_ID} .ld-preview-embedded-head {
        display: flex;
        align-items: baseline;
        gap: 8px;
        margin-bottom: 4px;
      }

      #${PANEL_ID} .ld-preview-embedded-name {
        overflow: hidden;
        color: var(--primary, #202124);
        font-size: 14px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-embedded-floor {
        flex-shrink: 0;
        color: var(--primary-medium, #757575);
        font-size: 12px;
      }

      #${PANEL_ID} .ld-preview-username-secondary {
        overflow: hidden;
        flex-shrink: 2;
        color: var(--primary-medium, #757575);
        font-size: 13px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-user-title {
        overflow: hidden;
        flex-shrink: 3;
        color: var(--primary-medium, #757575);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-flair {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
        border-radius: 4px;
        object-fit: contain;
      }

      #${PANEL_ID} .ld-preview-staff-tag {
        flex-shrink: 0;
        font-size: 12px;
        line-height: 1;
      }

      #${PANEL_ID} .ld-preview-owner-tag {
        flex-shrink: 0;
        padding: 0 5px;
        color: var(--tertiary, #0088cc);
        border: 1px solid var(--tertiary, #0088cc);
        border-radius: 4px;
        font-size: 11px;
        line-height: 1.6;
      }

      #${PANEL_ID} .ld-preview-embedded-reply .cooked {
        font-size: 14px;
        line-height: 1.55;
      }

      #${PANEL_ID} .ld-preview-embedded-jump {
        margin-top: 6px;
        padding: 0;
        color: var(--primary-medium, #757575);
        background: transparent;
        border: 0;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-embedded-jump:hover {
        color: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-embedded-collapse {
        display: grid;
        width: 30px;
        height: 26px;
        place-items: center;
        margin: 4px 0 6px;
        padding: 0;
        color: var(--primary-medium, #757575);
        background: transparent;
        border: 1px solid var(--primary-low-mid, #cccccc);
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        line-height: 1;
      }

      #${PANEL_ID} .ld-preview-embedded-collapse:hover {
        background: var(--primary-low, #e9e9e9);
      }

      #${PANEL_ID} .ld-preview-embedded-empty {
        padding: 6px 0;
        color: var(--primary-medium, #757575);
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-post-footer {
        display: flex;
        gap: 4px;
        justify-content: flex-end;
        padding: 4px 0 6px;
      }

      #${PANEL_ID} .ld-preview-post-action {
        padding: 3px 8px;
        color: var(--primary-medium, #757575);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        line-height: 1.4;
      }

      #${PANEL_ID} .ld-preview-post-action:hover:not(:disabled),
      #${PANEL_ID} .ld-preview-post-action:focus-visible {
        background: var(--primary-low, #e9e9e9);
        outline: none;
      }

      #${PANEL_ID} .ld-preview-post-action:disabled {
        cursor: default;
        opacity: 0.6;
      }

      #${PANEL_ID} .ld-preview-post-more-wrap {
        position: relative;
        display: inline-flex;
      }

      #${PANEL_ID} .ld-preview-post-menu {
        position: absolute;
        right: 0;
        bottom: calc(100% + 4px);
        z-index: 6;
        display: flex;
        width: max-content;
        min-width: 168px;
        max-width: min(260px, calc(100vw - 24px));
        flex-direction: column;
        padding: 4px;
        background: var(--secondary, #ffffff);
        border: 1px solid var(--primary-low, #d7d7d7);
        border-radius: 6px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
      }

      #${PANEL_ID} .ld-preview-post-menu[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-post-menu.opens-down {
        top: calc(100% + 4px);
        bottom: auto;
      }

      #${PANEL_ID} .ld-preview-post-menu-option {
        overflow: hidden;
        padding: 7px 10px;
        color: var(--primary, #202124);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        line-height: 1.35;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-post-menu-option:hover:not(:disabled),
      #${PANEL_ID} .ld-preview-post-menu-option:focus-visible {
        background: var(--primary-low, #e9e9e9);
        outline: none;
      }

      #${PANEL_ID} .ld-preview-post-menu-option:disabled {
        cursor: default;
        opacity: 0.65;
      }

      #${PANEL_ID} .ld-preview-post-menu-separator {
        height: 1px;
        margin: 4px 6px;
        background: var(--primary-low, #d7d7d7);
      }

      #${PANEL_ID} .ld-preview-filter-banner {
        display: flex;
        min-height: 34px;
        align-items: center;
        gap: 10px;
        padding: 7px 12px;
        color: var(--primary, #202124);
        background: var(--primary-very-low, #f5f5f5);
        border-bottom: 1px solid var(--primary-low, #d7d7d7);
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-filter-label {
        overflow: hidden;
        flex: 1;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${PANEL_ID} .ld-preview-filter-clear {
        flex-shrink: 0;
        padding: 3px 7px;
        color: var(--tertiary, #0088cc);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-filter-clear:hover,
      #${PANEL_ID} .ld-preview-filter-clear:focus-visible {
        background: var(--primary-low, #e9e9e9);
        outline: none;
      }

      #${PANEL_ID} .ld-preview-like.is-liked {
        color: var(--love, #fa6c8d);
      }

      #${PANEL_ID} .ld-preview-poll {
        margin: 8px 0;
        padding: 10px 12px;
        border: 1px solid var(--primary-low, #d7d7d7);
        border-radius: 6px;
      }

      #${PANEL_ID} .ld-preview-poll-head {
        margin-bottom: 6px;
        color: var(--primary-medium, #757575);
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-poll-option {
        display: flex;
        width: 100%;
        margin: 4px 0;
        gap: 8px;
        align-items: center;
        padding: 6px 8px;
        color: var(--primary, #202124);
        background: transparent;
        border: 1px solid var(--primary-low, #d7d7d7);
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        text-align: left;
      }

      #${PANEL_ID} .ld-preview-poll-option:hover:not(:disabled) {
        background: var(--primary-very-low, #f5f5f5);
      }

      #${PANEL_ID} .ld-preview-poll-option:disabled {
        cursor: default;
      }

      #${PANEL_ID} .ld-preview-poll-option.is-voted,
      #${PANEL_ID} .ld-preview-poll-option.is-selected {
        border-color: var(--tertiary, #0088cc);
        box-shadow: inset 0 0 0 1px var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-poll-label {
        min-width: 0;
        flex: 1;
      }

      #${PANEL_ID} .ld-preview-poll-count {
        margin-left: auto;
        flex-shrink: 0;
        color: var(--primary-medium, #757575);
        font-size: 12px;
      }

      #${PANEL_ID} .ld-preview-poll-note {
        margin-top: 6px;
        color: var(--primary-medium, #757575);
        font-size: 12px;
      }

      #${PANEL_ID} .ld-preview-poll-submit {
        margin-top: 6px;
        padding: 5px 14px;
        color: var(--secondary, #ffffff);
        background: var(--tertiary, #0088cc);
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-poll-submit:disabled {
        cursor: default;
        opacity: 0.5;
      }

      #${PANEL_ID} .ld-preview-sentinel {
        display: block;
        width: 100%;
        min-height: 32px;
        padding: 12px 0 24px;
        color: var(--primary-medium, #757575);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        text-align: center;
      }

      #${PANEL_ID} .ld-preview-sentinel:hover:not(:disabled),
      #${PANEL_ID} .ld-preview-sentinel:focus-visible {
        color: var(--tertiary, #0088cc);
        background: var(--primary-very-low, #f5f5f5);
        outline: none;
      }

      #${PANEL_ID} .ld-preview-sentinel:disabled {
        cursor: wait;
      }

      #${PANEL_ID} .ld-preview-sentinel[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-status {
        position: absolute;
        top: 50%;
        left: 50%;
        z-index: 1;
        max-width: min(80%, 360px);
        padding: 12px 16px;
        color: var(--primary, #202124);
        background: var(--secondary, #ffffff);
        border: 1px solid var(--primary-low, #d7d7d7);
        border-radius: 6px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
        font-size: 14px;
        line-height: 1.5;
        text-align: center;
        transform: translate(-50%, -50%);
      }

      #${PANEL_ID} .ld-preview-status[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-toast {
        position: absolute;
        bottom: 16px;
        left: 50%;
        z-index: 3;
        max-width: 85%;
        padding: 8px 14px;
        color: var(--secondary, #ffffff);
        background: var(--primary, #333333);
        border-radius: 4px;
        font-size: 13px;
        opacity: 0;
        pointer-events: none;
        transform: translateX(-50%) translateY(8px);
        transition: opacity 150ms ease, transform 150ms ease;
      }

      #${PANEL_ID} .ld-preview-toast.is-visible {
        opacity: 0.95;
        transform: translateX(-50%) translateY(0);
      }

      #${PANEL_ID} .ld-preview-composer {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 14px 12px;
        background: var(--secondary, #ffffff);
        border-top: 1px solid var(--primary-low, #d7d7d7);
      }

      #${PANEL_ID} .ld-preview-composer[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-composer-target {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--primary-medium, #757575);
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-composer-switch {
        padding: 2px 8px;
        color: var(--tertiary, #0088cc);
        background: transparent;
        border: 1px solid var(--tertiary, #0088cc);
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
      }

      #${PANEL_ID} .ld-preview-composer-switch[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-reply-bar {
        padding: 14px 0 6px;
        text-align: center;
      }

      #${PANEL_ID} .ld-preview-reply-bar[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-reply-bar-button {
        padding: 7px 22px;
        color: var(--secondary, #ffffff);
        background: var(--tertiary, #0088cc);
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 14px;
      }

      #${PANEL_ID} .ld-preview-composer-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 2px;
      }

      #${PANEL_ID} .ld-preview-composer-tool {
        display: inline-grid;
        min-width: 26px;
        height: 24px;
        place-items: center;
        padding: 0 6px;
        color: var(--primary-medium, #757575);
        background: transparent;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        line-height: 1;
      }

      #${PANEL_ID} .ld-preview-composer-tool:hover {
        color: var(--primary, #202124);
        background: var(--primary-low, #e9e9e9);
      }

      #${PANEL_ID} .ld-preview-composer-tool.is-active {
        color: var(--tertiary, #0088cc);
        background: var(--tertiary-low, #d1f0ff);
      }

      #${PANEL_ID} .ld-preview-composer-preview {
        max-height: 200px;
        box-sizing: border-box;
        padding: 8px;
        overflow: auto;
        border: 1px dashed var(--primary-low-mid, #cccccc);
        border-radius: 4px;
        font-size: 14px;
        line-height: 1.5;
        overflow-wrap: break-word;
      }

      #${PANEL_ID} .ld-preview-composer-preview[hidden] {
        display: none;
      }

      #${PANEL_ID} .ld-preview-composer-preview img:not(.emoji) {
        max-width: 100%;
        height: auto;
      }

      #${PANEL_ID} .ld-preview-composer-input {
        width: 100%;
        min-height: 90px;
        box-sizing: border-box;
        padding: 8px;
        color: var(--primary, #202124);
        background: var(--secondary, #ffffff);
        border: 1px solid var(--primary-low-mid, #cccccc);
        border-radius: 4px;
        font: inherit;
        font-size: 14px;
        line-height: 1.5;
        resize: vertical;
      }

      #${PANEL_ID} .ld-preview-composer-error {
        color: var(--danger, #e45735);
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-composer-error:empty {
        display: none;
      }

      #${PANEL_ID} .ld-preview-composer-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }

      #${PANEL_ID} .ld-preview-composer-actions button {
        padding: 6px 14px;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 13px;
      }

      #${PANEL_ID} .ld-preview-composer-cancel {
        color: var(--primary, #202124);
        background: var(--primary-low, #e9e9e9);
      }

      #${PANEL_ID} .ld-preview-composer-send {
        color: var(--secondary, #ffffff);
        background: var(--tertiary, #0088cc);
      }

      #${PANEL_ID} .ld-preview-composer-send:disabled {
        cursor: default;
        opacity: 0.6;
      }

      body.ld-double-column-resizing,
      body.ld-double-column-resizing * {
        cursor: col-resize !important;
        user-select: none !important;
      }

      @media (max-width: ${MOBILE_BREAKPOINT}px) {
        #${PANEL_ID} {
          width: 100vw;
        }

        body.ld-double-column-open #main-outlet-wrapper,
        body.ld-double-column-open #main-outlet {
          width: 100% !important;
          margin-right: 0 !important;
        }

        body.ld-double-column-open:not(.ld-double-column-fullscreen) #main-outlet {
          visibility: hidden !important;
        }

        #${PANEL_ID} .ld-preview-resizer {
          display: none;
        }

        #${PANEL_ID} .ld-preview-view-note {
          display: none;
        }

        #${PANEL_ID} .ld-preview-view-switch {
          padding-inline: 7px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createButton(icon, label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ld-preview-action';
    button.textContent = icon;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', handler);
    return button;
  }

  function ensurePanel() {
    if (state.panel) return;
    addStyle();

    const panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-label', '帖子预览');

    const resizer = document.createElement('div');
    resizer.className = 'ld-preview-resizer';
    resizer.title = '拖动调整宽度';
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');

    const toolbar = document.createElement('div');
    toolbar.className = 'ld-preview-toolbar';

    const heading = document.createElement('div');
    heading.className = 'ld-preview-heading';
    heading.textContent = '帖子预览';
    heading.title = '帖子预览';
    heading.addEventListener('click', () => {
      if (state.topicLoadFailed) reloadCurrentTopic();
    });
    heading.addEventListener('keydown', (event) => {
      if (!state.topicLoadFailed || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      reloadCurrentTopic();
    });

    const content = document.createElement('div');
    content.className = 'ld-preview-content';

    const viewBar = document.createElement('div');
    viewBar.className = 'ld-preview-view-bar';
    viewBar.hidden = true;

    const viewTitle = document.createElement('span');
    viewTitle.className = 'ld-preview-view-title';
    viewTitle.textContent = '🌳 树状评论';

    const viewNote = document.createElement('span');
    viewNote.className = 'ld-preview-view-note';
    viewNote.textContent = 'Nested Replies';

    const treeSortSelect = document.createElement('select');
    treeSortSelect.className = 'ld-preview-tree-sort';
    treeSortSelect.title = '树状评论排序';
    treeSortSelect.append(new Option('热门', 'hot'), new Option('时间', 'time'));
    treeSortSelect.value = state.treeSort;
    treeSortSelect.addEventListener('change', () => {
      state.treeSort = treeSortSelect.value === 'time' ? 'time' : 'hot';
      localStorage.setItem(TREE_SORT_KEY, state.treeSort);
      if (state.viewMode === 'tree') renderTreeView();
    });

    const originalViewButton = document.createElement('button');
    originalViewButton.type = 'button';
    originalViewButton.className = 'ld-preview-view-switch';
    originalViewButton.textContent = '切换到原始视图';
    originalViewButton.addEventListener('click', () => setViewMode('original'));
    viewBar.append(viewTitle, viewNote, treeSortSelect, originalViewButton);

    const scroll = document.createElement('div');
    scroll.className = 'ld-preview-scroll';
    scroll.addEventListener('click', handlePanelClick);

    const list = document.createElement('div');
    list.className = 'ld-preview-list';

    const sentinel = document.createElement('button');
    sentinel.type = 'button';
    sentinel.className = 'ld-preview-sentinel';
    sentinel.title = '加载更多评论';
    sentinel.addEventListener('click', loadAfter);
    sentinel.hidden = true;

    const topSentinel = document.createElement('button');
    topSentinel.type = 'button';
    topSentinel.className = 'ld-preview-sentinel';
    topSentinel.title = '加载之前的楼层';
    topSentinel.addEventListener('click', loadBefore);
    topSentinel.hidden = true;

    const replyBar = document.createElement('div');
    replyBar.className = 'ld-preview-reply-bar';
    replyBar.hidden = true;

    const replyBarButton = document.createElement('button');
    replyBarButton.type = 'button';
    replyBarButton.className = 'ld-preview-reply-bar-button';
    replyBarButton.textContent = '回复主题';
    replyBarButton.addEventListener('click', () => openComposer(null, ''));
    replyBar.appendChild(replyBarButton);

    const status = document.createElement('div');
    status.className = 'ld-preview-status';
    status.hidden = true;
    status.addEventListener('click', () => {
      if (state.topicLoadFailed) reloadCurrentTopic();
    });
    status.addEventListener('keydown', (event) => {
      if (!state.topicLoadFailed || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      reloadCurrentTopic();
    });

    const toast = document.createElement('div');
    toast.className = 'ld-preview-toast';

    const timeline = document.createElement('div');
    timeline.className = 'ld-preview-timeline';

    const timelineStart = document.createElement('button');
    timelineStart.type = 'button';
    timelineStart.className = 'ld-preview-timeline-date';
    timelineStart.title = '跳到第一楼';
    timelineStart.addEventListener('click', () => jumpToIndex(0));

    const timelineTrack = document.createElement('div');
    timelineTrack.className = 'ld-preview-timeline-track';

    const timelineHandle = document.createElement('div');
    timelineHandle.className = 'ld-preview-timeline-handle';
    timelineHandle.textContent = '≡';
    timelineTrack.appendChild(timelineHandle);

    const timelineLabel = document.createElement('div');
    timelineLabel.className = 'ld-preview-timeline-label';

    const backButton = document.createElement('button');
    backButton.type = 'button';
    backButton.className = 'ld-preview-timeline-back';
    backButton.textContent = '返回';
    backButton.hidden = true;
    backButton.addEventListener('pointerdown', (event) => event.stopPropagation());
    backButton.addEventListener('click', () => {
      const lastRead = state.topicMeta?.lastReadPostNumber;
      if (lastRead) jumpToPostNumber(lastRead);
    });
    timelineTrack.appendChild(backButton);

    const timelineLast = document.createElement('button');
    timelineLast.type = 'button';
    timelineLast.className = 'ld-preview-timeline-date';
    timelineLast.title = '跳到最后一楼';
    timelineLast.addEventListener('click', () => jumpToIndex(state.stream.length - 1));

    const timelineFoot = document.createElement('div');
    timelineFoot.className = 'ld-preview-timeline-foot';

    const timelineReplyButton = document.createElement('button');
    timelineReplyButton.type = 'button';
    timelineReplyButton.className = 'ld-preview-timeline-btn';
    timelineReplyButton.textContent = '↩';
    timelineReplyButton.title = '回复主题';
    timelineReplyButton.addEventListener('click', () => openComposer(null, ''));

    const notifButton = document.createElement('button');
    notifButton.type = 'button';
    notifButton.className = 'ld-preview-timeline-btn';
    notifButton.textContent = '🔔';
    notifButton.title = '通知级别';
    notifButton.addEventListener('click', toggleNotifMenu);

    const notifMenu = document.createElement('div');
    notifMenu.className = 'ld-preview-notif-menu';
    notifMenu.hidden = true;

    timelineFoot.append(timelineReplyButton, notifButton);
    timeline.append(timelineStart, timelineTrack, timelineLabel, timelineLast, timelineFoot, notifMenu);

    const topicBookmarkButton = createButton('☆', '收藏话题（书签）', toggleTopicBookmark);
    topicBookmarkButton.classList.add('ld-preview-bookmark');
    const replyButton = createButton('✎', '回复主题', () => {
      if (state.currentTopicId) openComposer(null, '');
    });
    const originalButton = createButton('↗', '在原页面打开', () => {
      if (state.currentUrl) window.open(state.currentUrl, '_blank', 'noopener,noreferrer');
    });
    const refreshButton = createButton('↻', '刷新预览', reloadCurrentTopic);
    const treeButton = createButton('🌳', '切换到树状评论', () => {
      setViewMode(state.viewMode === 'tree' ? 'original' : 'tree');
    });
    const fullscreenButton = createButton('⛶', '放大预览', () => {
      state.fullscreen = !state.fullscreen;
      document.body.classList.toggle('ld-double-column-fullscreen', state.fullscreen);
      fullscreenButton.title = state.fullscreen ? '恢复双栏' : '放大预览';
      fullscreenButton.setAttribute('aria-label', fullscreenButton.title);
    });
    const closeButton = createButton('×', '关闭预览', closePanel);

    const composer = document.createElement('div');
    composer.className = 'ld-preview-composer';
    composer.hidden = true;

    const composerTarget = document.createElement('div');
    composerTarget.className = 'ld-preview-composer-target';

    const composerTargetText = document.createElement('span');
    composerTargetText.className = 'ld-preview-composer-target-text';

    const composerTargetSwitch = document.createElement('button');
    composerTargetSwitch.type = 'button';
    composerTargetSwitch.className = 'ld-preview-composer-switch';
    composerTargetSwitch.textContent = '改为回复主题';
    composerTargetSwitch.hidden = true;
    composerTargetSwitch.addEventListener('click', () => setComposerTarget(null, ''));

    composerTarget.append(composerTargetText, composerTargetSwitch);

    const composerInput = document.createElement('textarea');
    composerInput.className = 'ld-preview-composer-input';
    composerInput.placeholder = '支持 Markdown，可粘贴/拖入图片，Ctrl+Enter 发送';
    composerInput.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        submitReply();
      } else if ((event.ctrlKey || event.metaKey) && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault();
        composerWrap('**', '**', '加粗文字');
      } else if ((event.ctrlKey || event.metaKey) && (event.key === 'i' || event.key === 'I')) {
        event.preventDefault();
        composerWrap('*', '*', '斜体文字');
      }
    });
    composerInput.addEventListener('paste', (event) => {
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length) {
        event.preventDefault();
        uploadFiles(files);
      }
    });
    composerInput.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    });
    composerInput.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length) {
        event.preventDefault();
        uploadFiles(files);
      }
    });
    composerInput.addEventListener('input', () => {
      if (!state.composerPreview || state.composerPreview.hidden) return;
      clearTimeout(state.composerPreviewTimer);
      state.composerPreviewTimer = setTimeout(refreshComposerPreview, 400);
    });

    const composerFileInput = document.createElement('input');
    composerFileInput.type = 'file';
    composerFileInput.multiple = true;
    composerFileInput.hidden = true;
    composerFileInput.addEventListener('change', () => {
      uploadFiles(composerFileInput.files);
      composerFileInput.value = '';
    });

    const composerTools = document.createElement('div');
    composerTools.className = 'ld-preview-composer-tools';
    const addTool = (label, title, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ld-preview-composer-tool';
      button.textContent = label;
      button.title = title;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', handler);
      composerTools.appendChild(button);
      return button;
    };
    addTool('B', '加粗 (Ctrl+B)', () => composerWrap('**', '**', '加粗文字'));
    addTool('I', '斜体 (Ctrl+I)', () => composerWrap('*', '*', '斜体文字'));
    addTool('🔗', '插入链接', () => composerWrap('[', '](https://)', '链接文字'));
    addTool('❝', '引用', () => composerLinePrefix('> '));
    addTool('</>', '代码', composerCode);
    addTool('•', '列表', () => composerLinePrefix('- '));
    addTool('🖼', '上传图片或附件', () => composerFileInput.click());
    const composerPreviewButton = addTool('👁', '预览', toggleComposerPreview);

    const composerPreview = document.createElement('div');
    composerPreview.className = 'ld-preview-composer-preview cooked';
    composerPreview.hidden = true;

    const composerError = document.createElement('div');
    composerError.className = 'ld-preview-composer-error';

    const composerActions = document.createElement('div');
    composerActions.className = 'ld-preview-composer-actions';

    const composerCancel = document.createElement('button');
    composerCancel.type = 'button';
    composerCancel.className = 'ld-preview-composer-cancel';
    composerCancel.textContent = '取消';
    composerCancel.addEventListener('click', () => closeComposer());

    const composerSend = document.createElement('button');
    composerSend.type = 'button';
    composerSend.className = 'ld-preview-composer-send';
    composerSend.textContent = '发送';
    composerSend.addEventListener('click', submitReply);

    composerActions.append(composerCancel, composerSend);
    composer.append(composerTarget, composerTools, composerInput, composerFileInput, composerPreview, composerError, composerActions);

    toolbar.append(heading, topicBookmarkButton, replyButton, treeButton, originalButton, refreshButton, fullscreenButton, closeButton);
    scroll.append(topSentinel, list, sentinel, replyBar);
    content.append(scroll, timeline, status, toast);
    panel.append(resizer, toolbar, viewBar, content, composer);
    document.body.appendChild(panel);

    state.panel = panel;
    state.scroll = scroll;
    state.list = list;
    state.sentinel = sentinel;
    state.topSentinel = topSentinel;
    state.replyBar = replyBar;
    state.timeline = timeline;
    state.timelineHandle = timelineHandle;
    state.timelineLabel = timelineLabel;
    state.timelineStart = timelineStart;
    state.timelineLast = timelineLast;
    state.backButton = backButton;
    state.notifMenu = notifMenu;
    state.notifButton = notifButton;
    state.title = heading;
    state.topicBookmarkButton = topicBookmarkButton;
    state.status = status;
    state.toast = toast;
    state.viewBar = viewBar;
    state.viewNote = viewNote;
    state.treeButton = treeButton;
    state.treeSortSelect = treeSortSelect;
    state.composer = composer;
    state.composerTarget = composerTarget;
    state.composerTargetText = composerTargetText;
    state.composerTargetSwitch = composerTargetSwitch;
    state.composerInput = composerInput;
    state.composerError = composerError;
    state.composerSend = composerSend;
    state.composerPreview = composerPreview;
    state.composerPreviewButton = composerPreviewButton;

    state.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (entry.target === state.sentinel) loadAfter();
        else if (entry.target === state.topSentinel) loadBefore();
      }
    }, { root: scroll, rootMargin: '800px 0px' });
    state.observer.observe(sentinel);
    state.observer.observe(topSentinel);

    let timelineSyncFrame = 0;
    scroll.addEventListener('scroll', () => {
      if (timelineSyncFrame) return;
      timelineSyncFrame = requestAnimationFrame(() => {
        timelineSyncFrame = 0;
        syncTimelineToScroll();
        checkPaginationThresholds();
      });
    }, { passive: true });

    installResizer(resizer);
    installTimeline(timelineTrack);
  }

  function installResizer(resizer) {
    let pointerId = null;
    let pendingWidth = null;
    let resizeFrame = 0;

    const flushResize = () => {
      resizeFrame = 0;
      if (pendingWidth === null) return;
      setWidth(pendingWidth, false);
      pendingWidth = null;
    };

    resizer.addEventListener('pointerdown', (event) => {
      if (!state.open || window.innerWidth <= MOBILE_BREAKPOINT) return;
      pointerId = event.pointerId;
      resizer.setPointerCapture(pointerId);
      document.body.classList.add('ld-double-column-resizing');
      event.preventDefault();
    });

    resizer.addEventListener('pointermove', (event) => {
      if (pointerId !== event.pointerId) return;
      pendingWidth = window.innerWidth - event.clientX;
      if (!resizeFrame) resizeFrame = requestAnimationFrame(flushResize);
    });

    const stopResize = (event) => {
      if (pointerId !== event.pointerId) return;
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      flushResize();
      localStorage.setItem(WIDTH_KEY, String(state.width));
      pointerId = null;
      document.body.classList.remove('ld-double-column-resizing');
      try {
        resizer.releasePointerCapture(event.pointerId);
      } catch {
        // The pointer may already have been released by the browser.
      }
    };

    resizer.addEventListener('pointerup', stopResize);
    resizer.addEventListener('pointercancel', stopResize);
  }

  function installTimeline(track) {
    let pointerId = null;

    const ratioFromEvent = (event) => {
      const rect = track.getBoundingClientRect();
      if (!rect.height) return 0;
      return Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
    };

    const targetFromEvent = (event) =>
      Math.round(ratioFromEvent(event) * Math.max(0, state.stream.length - 1));

    const scrub = (event) => {
      const target = targetFromEvent(event);
      if (target >= state.startIdx && target <= state.endIdx) scrollToStreamIndex(target);
      else updateTimelinePosition(target, state.stream.length);
    };

    track.addEventListener('pointerdown', (event) => {
      if (!state.stream.length) return;
      pointerId = event.pointerId;
      state.timelineDragging = true;
      track.setPointerCapture(pointerId);
      scrub(event);
      event.preventDefault();
    });

    track.addEventListener('pointermove', (event) => {
      if (pointerId !== event.pointerId) return;
      scrub(event);
    });

    const stopDrag = (event) => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      state.timelineDragging = false;
      try {
        track.releasePointerCapture(event.pointerId);
      } catch {
        // The pointer may already have been released by the browser.
      }
      jumpToIndex(targetFromEvent(event));
    };

    track.addEventListener('pointerup', stopDrag);
    track.addEventListener('pointercancel', (event) => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      state.timelineDragging = false;
    });
  }

  function setWidth(value, persist = true) {
    const width = clampWidth(value);
    if (state.width === width) return;
    state.width = width;
    document.documentElement.style.setProperty('--ld-preview-width', `${state.width}px`);
    if (persist) localStorage.setItem(WIDTH_KEY, String(state.width));
  }

  function updatePanelTop() {
    // 面板顶到站点头部下沿，避免遮住右上角的头像与通知入口。
    const header = document.querySelector('header.d-header');
    const bottom = header ? header.getBoundingClientRect().bottom : 0;
    document.documentElement.style.setProperty('--ld-preview-top', `${Math.max(0, Math.round(bottom))}px`);
  }

  function setStatus(message) {
    if (!state.status) return;
    state.status.textContent = message;
    state.status.hidden = !message;
  }

  function setTopicLoadFailed(failed) {
    state.topicLoadFailed = failed;
    for (const element of [state.title, state.status]) {
      if (!element) continue;
      element.classList.toggle('is-retryable', failed);
      element.tabIndex = failed ? 0 : -1;
      if (failed) {
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', '加载失败，点击重试');
      } else {
        element.removeAttribute('role');
        element.removeAttribute('aria-label');
      }
    }
  }

  function reloadCurrentTopic() {
    if (!state.currentTopicId || state.panel?.classList.contains('is-loading')) return;
    loadTopic(state.currentTopicId, state.currentUrl, true);
  }

  function showToast(message) {
    if (!state.toast) return;
    state.toast.textContent = message;
    state.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => state.toast.classList.remove('is-visible'), 3000);
  }

  function setPreviewHistory(url, replace) {
    const base = new URL(state.parentUrl || location.href);
    base.hash = `ld-preview=${encodeURIComponent(new URL(url).pathname)}`;
    const previousState = history.state && typeof history.state === 'object' ? history.state : {};
    const nextState = {
      ...previousState,
      ldDoubleColumn: true,
      ldPreviewUrl: url,
      ldPreviewBase: state.parentUrl,
    };

    if (replace) history.replaceState(nextState, '', base.href);
    else history.pushState(nextState, '', base.href);
  }

  function avatarUrl(template) {
    if (!template) return '';
    try {
      return new URL(template.replace('{size}', '48'), location.origin).href;
    } catch {
      return '';
    }
  }

  function likeSummary(post) {
    if (!Array.isArray(post.actions_summary)) post.actions_summary = [];
    let entry = post.actions_summary.find((action) => action.id === LIKE_ACTION_ID);
    if (!entry) {
      entry = { id: LIKE_ACTION_ID, count: 0, acted: false };
      post.actions_summary.push(entry);
    }
    return entry;
  }

  function updateLikeButton(button, post) {
    const entry = likeSummary(post);
    const count = entry.count || 0;
    button.textContent = `${entry.acted ? '♥' : '♡'}${count ? ` ${count}` : ''}`;
    button.classList.toggle('is-liked', Boolean(entry.acted));
    button.title = entry.acted ? '取消点赞' : '点赞';
    if (post.yours) {
      button.disabled = true;
      button.title = '不能给自己的帖子点赞';
    }
  }

  function createLikeButton(post) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ld-preview-post-action ld-preview-like';
    updateLikeButton(button, post);
    let busy = false;

    button.addEventListener('click', async () => {
      if (busy || post.yours) return;
      busy = true;
      button.disabled = true;
      const entry = likeSummary(post);
      try {
        if (entry.acted) {
          await apiRequest('DELETE', `/post_actions/${post.id}.json`, { post_action_type_id: LIKE_ACTION_ID });
          entry.acted = false;
          entry.count = Math.max(0, (entry.count || 0) - 1);
          showToast('已取消点赞');
        } else {
          await apiRequest('POST', '/post_actions.json', {
            id: post.id,
            post_action_type_id: LIKE_ACTION_ID,
            flag_topic: false,
          });
          entry.acted = true;
          entry.count = (entry.count || 0) + 1;
          showToast('已点赞');
        }
      } catch (error) {
        showToast(error.message || '操作失败');
      } finally {
        busy = false;
        button.disabled = false;
        updateLikeButton(button, post);
      }
    });

    return button;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
      ? `${date.getMonth() + 1}月${date.getDate()}日`
      : `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  function formatRelative(iso) {
    const time = new Date(iso).getTime();
    if (Number.isNaN(time)) return '';
    const seconds = Math.floor((Date.now() - time) / 1000);
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return `${seconds} 秒前`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    return formatDate(iso);
  }

  function createBookmarkButton(post) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ld-preview-post-action ld-preview-bookmark';
    const sync = () => {
      button.textContent = post.bookmarked ? '★' : '☆';
      button.classList.toggle('is-bookmarked', Boolean(post.bookmarked));
      button.title = post.bookmarked ? '取消收藏（书签）' : '收藏此楼（书签）';
    };
    sync();
    let busy = false;

    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      // 先取引用：请求期间切换话题时，书签仍记到发起请求的话题上。
      const bookmarks = topicBookmarks();
      try {
        if (post.bookmarked) {
          const bookmarkId = post.bookmark_id || bookmarks.find((bookmark) => (
            bookmark.bookmarkable_type === 'Post' && bookmark.bookmarkable_id === post.id
          ))?.id;
          if (!bookmarkId) {
            showToast('该收藏需在原页面管理');
            return;
          }
          await apiRequest('DELETE', `/bookmarks/${bookmarkId}.json`);
          post.bookmarked = false;
          post.bookmark_id = null;
          removeBookmarkEntry(bookmarks, bookmarkId);
          showToast('已取消收藏');
        } else {
          const data = await apiRequest('POST', '/bookmarks.json', {
            bookmarkable_id: post.id,
            bookmarkable_type: 'Post',
          });
          post.bookmarked = true;
          if (data?.id) {
            post.bookmark_id = data.id;
            bookmarks.push({
              id: data.id,
              bookmarkable_id: post.id,
              bookmarkable_type: 'Post',
              post_number: post.post_number,
            });
          }
          showToast('已收藏，可在「我的活动 - 书签」中查看');
        }
        sync();
        updateTopicBookmarkButton();
      } catch (error) {
        showToast(error.message || '操作失败');
      } finally {
        busy = false;
      }
    });

    return button;
  }

  // 与 topicCache 中的 data.bookmarks 是同一个数组，原地修改可让缓存同步书签状态。
  function topicBookmarks() {
    return state.topicMeta?.bookmarks || [];
  }

  function removeBookmarkEntry(bookmarks, bookmarkId) {
    const index = bookmarks.findIndex((bookmark) => bookmark.id === bookmarkId);
    if (index >= 0) bookmarks.splice(index, 1);
  }

  function updateTopicBookmarkButton() {
    const button = state.topicBookmarkButton;
    if (!button) return;
    const bookmarks = topicBookmarks();
    const bookmarked = bookmarks.some((bookmark) => bookmark.bookmarkable_type === 'Topic');
    const postCount = bookmarks.filter((bookmark) => bookmark.bookmarkable_type === 'Post').length;
    const label = bookmarked ? '取消收藏话题（书签）' : '收藏话题（书签）';
    button.textContent = bookmarked ? '★' : '☆';
    button.classList.toggle('is-bookmarked', bookmarked);
    button.title = postCount ? `${label}，本话题另有 ${postCount} 个楼层书签` : label;
    button.setAttribute('aria-label', button.title);
  }

  async function toggleTopicBookmark() {
    const meta = state.topicMeta;
    const button = state.topicBookmarkButton;
    // 加载中或加载失败时 topicMeta 仍是上一个话题，不能把书签记到它上面。
    if (!meta || !button || button.disabled || state.panel?.classList.contains('is-loading')) return;
    if (String(meta.topicId) !== String(state.currentTopicId)) return;

    button.disabled = true;
    const bookmarks = meta.bookmarks;
    try {
      const bookmark = bookmarks.find((entry) => entry.bookmarkable_type === 'Topic');
      if (bookmark) {
        if (!bookmark.id) {
          showToast('该收藏需在原页面管理');
          return;
        }
        await apiRequest('DELETE', `/bookmarks/${bookmark.id}.json`);
        removeBookmarkEntry(bookmarks, bookmark.id);
        showToast('已取消收藏话题');
      } else {
        const data = await apiRequest('POST', '/bookmarks.json', {
          bookmarkable_id: meta.topicId,
          bookmarkable_type: 'Topic',
        });
        bookmarks.push({ id: data?.id, bookmarkable_id: meta.topicId, bookmarkable_type: 'Topic' });
        showToast('已收藏话题，可在「我的活动 - 书签」中查看');
      }
    } catch (error) {
      showToast(error.message || '操作失败');
    } finally {
      button.disabled = false;
      updateTopicBookmarkButton();
    }
  }

  async function copyPostLink(post) {
    const url = `${location.origin}/t/topic/${state.currentTopicId}/${post.post_number}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('链接已复制');
    } catch {
      const input = document.createElement('textarea');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      showToast(copied ? '链接已复制' : '复制失败');
    }
  }

  function updateNotifButton() {
    if (!state.notifButton) return;
    const level = state.topicMeta?.notificationLevel ?? 1;
    const item = NOTIFICATION_LEVELS.find((entry) => entry.level === level);
    state.notifButton.title = `通知级别：${item ? item.name : level}`;
  }

  function hideNotifMenu() {
    if (state.notifMenu) state.notifMenu.hidden = true;
  }

  function toggleNotifMenu() {
    const menu = state.notifMenu;
    if (!menu) return;
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }

    const current = state.topicMeta?.notificationLevel ?? 1;
    menu.textContent = '';
    for (const item of NOTIFICATION_LEVELS) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'ld-preview-notif-option';
      option.textContent = `${item.level === current ? '✓ ' : ''}${item.name}`;
      option.title = item.desc;
      option.addEventListener('click', () => setNotificationLevel(item.level, item.name));
      menu.appendChild(option);
    }
    menu.hidden = false;
  }

  function hidePostMenu() {
    if (state.postMenu) state.postMenu.hidden = true;
    if (state.postMenuButton) state.postMenuButton.setAttribute('aria-expanded', 'false');
    state.postMenu = null;
    state.postMenuButton = null;
  }

  function togglePostMenu(menu, button) {
    const wasOpen = state.postMenu === menu && !menu.hidden;
    hidePostMenu();
    if (wasOpen) return;
    hideNotifMenu();
    state.postMenu = menu;
    state.postMenuButton = button;
    menu.classList.remove('opens-down');
    menu.hidden = false;
    const buttonRect = button.getBoundingClientRect();
    const scrollRect = state.scroll?.getBoundingClientRect();
    if (scrollRect) {
      const spaceAbove = buttonRect.top - scrollRect.top - 6;
      const spaceBelow = scrollRect.bottom - buttonRect.bottom - 6;
      menu.classList.toggle('opens-down', spaceAbove < menu.offsetHeight && spaceBelow > spaceAbove);
    }
    button.setAttribute('aria-expanded', 'true');
  }

  function postFilterLabel(filter = state.postFilter) {
    if (!filter) return '';
    return filter.kind === 'owner'
      ? '只看楼主'
      : `只看 @${filter.username || '该用户'}`;
  }

  function matchesPostFilter(post, filter = state.postFilter) {
    if (!filter || !post) return true;
    if (filter.userId && post.user_id) return Number(post.user_id) === Number(filter.userId);
    return Boolean(filter.username)
      && String(post.username || '').toLowerCase() === filter.username.toLowerCase();
  }

  function samePostFilter(filter) {
    if (!state.postFilter || !filter) return false;
    if (state.postFilter.userId && filter.userId) {
      return Number(state.postFilter.userId) === Number(filter.userId);
    }
    return Boolean(state.postFilter.username && filter.username)
      && state.postFilter.username.toLowerCase() === filter.username.toLowerCase();
  }

  function createPostMenu(post, moreButton) {
    const wrap = document.createElement('span');
    wrap.className = 'ld-preview-post-more-wrap';
    const menu = document.createElement('div');
    menu.className = 'ld-preview-post-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const addOption = (label, handler, { disabled = false, title = '' } = {}) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'ld-preview-post-menu-option';
      option.textContent = label;
      option.title = title;
      option.disabled = disabled;
      option.setAttribute('role', 'menuitem');
      option.addEventListener('click', () => {
        hidePostMenu();
        handler();
      });
      menu.appendChild(option);
    };

    if (state.postFilter) addOption('显示全部评论', clearPostFilter);

    const ownerFilter = {
      kind: 'owner',
      userId: state.topicMeta?.ownerId || 0,
      username: state.topicMeta?.ownerUsername || '',
    };
    if (ownerFilter.userId || ownerFilter.username) {
      const active = samePostFilter(ownerFilter);
      addOption(active ? '✓ 只看楼主' : '只看楼主', () => applyPostFilter(ownerFilter), {
        disabled: active,
      });
    }

    const userFilter = {
      kind: 'user',
      userId: post.user_id || 0,
      username: post.username || '',
    };
    const isOwner = ownerFilter.userId && userFilter.userId
      ? Number(ownerFilter.userId) === Number(userFilter.userId)
      : ownerFilter.username && userFilter.username
        && ownerFilter.username.toLowerCase() === userFilter.username.toLowerCase();
    if ((userFilter.userId || userFilter.username) && !isOwner) {
      const active = samePostFilter(userFilter);
      const username = userFilter.username || post.name || '该用户';
      addOption(active ? `✓ 只看 @${username}` : `只看 @${username}`, () => applyPostFilter(userFilter), {
        disabled: active,
        title: `只看 ${username} 的评论`,
      });
    }

    const separator = document.createElement('div');
    separator.className = 'ld-preview-post-menu-separator';
    separator.setAttribute('role', 'separator');
    menu.appendChild(separator);
    addOption('在原页面打开', () => {
      window.open(
        `${location.origin}/t/topic/${state.currentTopicId}/${post.post_number}`,
        '_blank',
        'noopener,noreferrer',
      );
    });

    moreButton.title = '更多操作';
    moreButton.setAttribute('aria-label', '更多操作');
    moreButton.setAttribute('aria-haspopup', 'menu');
    moreButton.setAttribute('aria-expanded', 'false');
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePostMenu(menu, moreButton);
    });
    wrap.append(moreButton, menu);
    return wrap;
  }

  async function setNotificationLevel(level, name) {
    hideNotifMenu();
    if (!state.currentTopicId) return;
    try {
      await apiRequest('POST', `/t/${state.currentTopicId}/notifications.json`, { notification_level: level });
      if (state.topicMeta) state.topicMeta.notificationLevel = level;
      updateNotifButton();
      showToast(`通知级别已设为「${name}」`);
    } catch (error) {
      showToast(error.message || '设置失败');
    }
  }

  function buildPollUi(post, poll) {
    const supported = (poll.type === 'regular' || poll.type === 'multiple') && poll.status === 'open';
    const votedSet = new Set(post.polls_votes?.[poll.name] || []);
    const isMultiple = poll.type === 'multiple';
    const selection = new Set(votedSet);

    const box = document.createElement('div');
    box.className = 'ld-preview-poll';
    box.dataset.ldPollName = poll.name;

    const head = document.createElement('div');
    head.className = 'ld-preview-poll-head';
    head.textContent = `投票 · ${poll.voters ?? 0} 人已投${poll.status === 'closed' ? ' · 已结束' : ''}`;
    box.appendChild(head);

    let submitButton = null;
    const syncSubmit = () => {
      if (!submitButton) return;
      const min = poll.min || 1;
      const max = poll.max || poll.options.length;
      submitButton.disabled = selection.size < min || selection.size > max;
    };

    for (const option of poll.options || []) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ld-preview-poll-option';

      const label = document.createElement('span');
      label.className = 'ld-preview-poll-label';
      label.innerHTML = option.html || '';

      const count = document.createElement('span');
      count.className = 'ld-preview-poll-count';
      if (typeof option.votes === 'number') count.textContent = `${option.votes} 票`;

      row.append(label, count);
      if (votedSet.has(option.id)) row.classList.add('is-voted');

      if (!supported) {
        row.disabled = true;
      } else if (isMultiple) {
        if (selection.has(option.id)) row.classList.add('is-selected');
        row.addEventListener('click', () => {
          if (selection.has(option.id)) selection.delete(option.id);
          else selection.add(option.id);
          row.classList.toggle('is-selected', selection.has(option.id));
          syncSubmit();
        });
      } else {
        row.addEventListener('click', () => submitVote(post, poll.name, [option.id], box));
      }

      box.appendChild(row);
    }

    if (supported && isMultiple) {
      submitButton = document.createElement('button');
      submitButton.type = 'button';
      submitButton.className = 'ld-preview-poll-submit';
      submitButton.textContent = votedSet.size ? '修改投票' : '提交投票';
      submitButton.addEventListener('click', () => submitVote(post, poll.name, [...selection], box));
      syncSubmit();
      box.appendChild(submitButton);
    }

    if (!supported && poll.status === 'open') {
      const note = document.createElement('div');
      note.className = 'ld-preview-poll-note';
      note.textContent = '该投票类型暂不支持在预览中操作，请在原页面投票';
      box.appendChild(note);
    }

    return box;
  }

  async function submitVote(post, pollName, options, box) {
    if (!options.length) return;
    try {
      const data = await apiRequest('PUT', '/polls/vote.json', {
        post_id: post.id,
        poll_name: pollName,
        options,
      });
      if (data?.poll && Array.isArray(post.polls)) {
        const index = post.polls.findIndex((item) => item.name === pollName);
        if (index >= 0) post.polls[index] = data.poll;
        if (!post.polls_votes || typeof post.polls_votes !== 'object') post.polls_votes = {};
        post.polls_votes[pollName] = data.vote || options;
        const updated = post.polls[index >= 0 ? index : 0];
        if (updated) box.replaceWith(buildPollUi(post, updated));
      }
      showToast('投票成功');
    } catch (error) {
      showToast(error.message || '投票失败');
    }
  }

  function enhancePolls(article, post) {
    if (!Array.isArray(post.polls) || !post.polls.length) return;
    const containers = article.querySelectorAll('.cooked div.poll[data-poll-name]');
    containers.forEach((container) => {
      const poll = post.polls.find((item) => item.name === container.dataset.pollName);
      if (poll) container.replaceWith(buildPollUi(post, poll));
    });
  }

  function appendUserBadges(container, post) {
    if (post.name && post.username && post.name !== post.username) {
      const secondary = document.createElement('span');
      secondary.className = 'ld-preview-username-secondary';
      secondary.textContent = post.username;
      container.appendChild(secondary);
    }
    if (post.user_title) {
      const title = document.createElement('span');
      title.className = 'ld-preview-user-title';
      title.textContent = post.user_title;
      if (post.title_is_group && post.primary_group_name) title.title = post.primary_group_name;
      container.appendChild(title);
    }
    if (post.flair_url && /^(https?:)?\//.test(post.flair_url)) {
      try {
        const flair = document.createElement('img');
        flair.className = 'ld-preview-flair';
        flair.src = new URL(post.flair_url, location.origin).href;
        flair.alt = '';
        flair.title = post.flair_name || '';
        flair.loading = 'lazy';
        if (post.flair_bg_color) flair.style.background = `#${post.flair_bg_color}`;
        container.appendChild(flair);
      } catch {
        // Malformed flair URL; skip the icon.
      }
    }
    if (post.admin || post.moderator) {
      const staff = document.createElement('span');
      staff.className = 'ld-preview-staff-tag';
      staff.textContent = '🛡';
      staff.title = post.admin ? '管理员' : '版主';
      container.appendChild(staff);
    }
    if (state.topicMeta?.ownerId && post.user_id === state.topicMeta.ownerId
      && post.post_number > 1) {
      const owner = document.createElement('span');
      owner.className = 'ld-preview-owner-tag';
      owner.textContent = '楼主';
      container.appendChild(owner);
    }
  }

  function renderEmbeddedReply(reply, jumpText = '↓ 跳到帖子') {
    const item = document.createElement('div');
    item.className = 'ld-preview-embedded-reply';

    const avatar = document.createElement('img');
    avatar.className = 'ld-preview-avatar ld-preview-avatar-small';
    avatar.src = avatarUrl(reply.avatar_template);
    avatar.alt = '';
    avatar.loading = 'lazy';

    const main = document.createElement('div');
    main.className = 'ld-preview-embedded-main';

    const head = document.createElement('div');
    head.className = 'ld-preview-embedded-head';

    const name = document.createElement('span');
    name.className = 'ld-preview-embedded-name';
    name.textContent = reply.name || reply.username || '匿名';
    head.appendChild(name);
    appendUserBadges(head, reply);
    if (reply.post_number) {
      const floor = document.createElement('span');
      floor.className = 'ld-preview-embedded-floor';
      floor.textContent = `#${reply.post_number}`;
      head.appendChild(floor);
    }

    const body = document.createElement('div');
    body.className = 'cooked';
    body.innerHTML = reply.cooked || '';

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'ld-preview-embedded-jump';
    jump.textContent = jumpText;
    jump.addEventListener('click', () => jumpToPostNumber(reply.post_number));

    main.append(head, body, jump);
    item.append(avatar, main);
    return item;
  }

  function createEmbeddedCollapse(title, onCollapse) {
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'ld-preview-embedded-collapse';
    collapse.textContent = '⌃';
    collapse.title = title;
    collapse.addEventListener('click', onCollapse);
    return collapse;
  }

  function createRepliesToggle(post, article) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ld-preview-post-action ld-preview-replies-toggle';
    const label = `${post.reply_count} 个回复`;
    toggle.textContent = `${label} ⌄`;
    toggle.title = '查看对此楼的回复';
    let box = null;
    let loading = false;

    const setExpanded = (expanded) => {
      if (box) box.hidden = !expanded;
      toggle.textContent = expanded ? `${label} ⌃` : `${label} ⌄`;
    };

    toggle.addEventListener('click', async () => {
      if (loading) return;
      if (box) {
        setExpanded(box.hidden);
        return;
      }
      loading = true;
      toggle.disabled = true;
      toggle.textContent = `${label} …`;
      try {
        const response = await fetch(`/posts/${post.id}/replies.json`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const replies = await response.json();
        box = document.createElement('div');
        box.className = 'ld-preview-embedded-replies';
        if (Array.isArray(replies) && replies.length) {
          for (const reply of replies) box.appendChild(renderEmbeddedReply(reply));
        } else {
          const empty = document.createElement('div');
          empty.className = 'ld-preview-embedded-empty';
          empty.textContent = '（回复在下方相邻楼层）';
          box.appendChild(empty);
        }
        box.appendChild(createEmbeddedCollapse('收起回复', () => setExpanded(false)));
        article.appendChild(box);
        setExpanded(true);
      } catch {
        showToast('回复列表加载失败');
        toggle.textContent = `${label} ⌄`;
      } finally {
        loading = false;
        toggle.disabled = false;
      }
    });
    return toggle;
  }

  async function fetchReplyParents(post) {
    const response = await fetch(`/posts/${post.id}/reply-history.json`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length) return data;
    }
    const fallback = await fetch(`/posts/by_number/${state.currentTopicId}/${post.reply_to_post_number}.json`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
    return [await fallback.json()];
  }

  function renderPost(post, { treeMode = false } = {}) {
    const article = document.createElement('article');
    article.className = 'ld-preview-post';
    article.dataset.postNumber = post.post_number != null ? String(post.post_number) : '';
    article.dataset.postId = String(post.id);
    article.dataset.createdAt = post.created_at || '';

    const header = document.createElement('header');
    header.className = 'ld-preview-post-header';

    const avatar = document.createElement('img');
    avatar.className = 'ld-preview-avatar';
    avatar.src = avatarUrl(post.avatar_template);
    avatar.alt = '';
    avatar.loading = 'lazy';

    const author = document.createElement('a');
    author.className = 'ld-preview-username';
    author.textContent = post.name || post.username || '匿名';
    author.href = post.username ? `/u/${post.username}` : '#';

    const meta = document.createElement('span');
    meta.className = 'ld-preview-post-meta';
    let timeText = '';
    if (post.created_at) {
      const created = new Date(post.created_at);
      if (!Number.isNaN(created.getTime())) {
        timeText = formatRelative(post.created_at);
        meta.title = dateFormat.format(created);
      }
    }
    meta.textContent = timeText ? `#${post.post_number} · ${timeText}` : `#${post.post_number}`;

    header.append(avatar, author);
    appendUserBadges(header, post);
    if (!treeMode && post.reply_to_post_number) {
      const replyToUser = post.reply_to_user;
      const replyTo = document.createElement('button');
      replyTo.type = 'button';
      replyTo.className = 'ld-preview-reply-to';
      replyTo.title = `回复了 #${post.reply_to_post_number}，点击展开原帖`;
      const replyToArrow = document.createElement('span');
      replyToArrow.textContent = '↪';
      replyTo.appendChild(replyToArrow);
      if (replyToUser?.avatar_template) {
        const replyToAvatar = document.createElement('img');
        replyToAvatar.className = 'ld-preview-reply-to-avatar';
        replyToAvatar.src = avatarUrl(replyToUser.avatar_template);
        replyToAvatar.alt = '';
        replyToAvatar.loading = 'lazy';
        replyTo.appendChild(replyToAvatar);
      }
      const replyToName = document.createElement('span');
      replyToName.textContent = replyToUser?.name || replyToUser?.username
        || `#${post.reply_to_post_number}`;
      replyTo.appendChild(replyToName);

      let parentsBox = null;
      let parentsLoading = false;
      const setParentsExpanded = (expanded) => {
        if (parentsBox) parentsBox.hidden = !expanded;
        replyTo.classList.toggle('is-open', Boolean(parentsBox) && expanded);
      };
      replyTo.addEventListener('click', async () => {
        if (parentsLoading) return;
        if (parentsBox) {
          setParentsExpanded(parentsBox.hidden);
          return;
        }
        parentsLoading = true;
        replyToArrow.textContent = '…';
        try {
          const parents = await fetchReplyParents(post);
          parentsBox = document.createElement('div');
          parentsBox.className = 'ld-preview-embedded-replies ld-preview-embedded-parents';
          for (const parent of parents) {
            parentsBox.appendChild(renderEmbeddedReply(parent, '↑ 跳到原楼层'));
          }
          parentsBox.appendChild(createEmbeddedCollapse('收起原帖', () => setParentsExpanded(false)));
          article.insertBefore(parentsBox, article.querySelector(':scope > .cooked'));
          setParentsExpanded(true);
        } catch {
          showToast('原帖加载失败');
        } finally {
          parentsLoading = false;
          replyToArrow.textContent = '↪';
        }
      });
      header.appendChild(replyTo);
    }
    header.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'cooked';
    body.innerHTML = post.cooked || '';

    const footer = document.createElement('footer');
    footer.className = 'ld-preview-post-footer';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'ld-preview-post-action';
    copyButton.textContent = '🔗';
    copyButton.title = '复制此楼链接';
    copyButton.addEventListener('click', () => copyPostLink(post));

    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'ld-preview-post-action';
    moreButton.textContent = '⋯';
    const moreWrap = createPostMenu(post, moreButton);

    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.className = 'ld-preview-post-action';
    replyButton.textContent = '回复';
    replyButton.title = `回复 #${post.post_number}`;
    replyButton.addEventListener('click', () => openComposer(post.post_number, post.username || ''));

    if (!treeMode && post.reply_count > 0) footer.appendChild(createRepliesToggle(post, article));
    footer.append(createBookmarkButton(post), createLikeButton(post), copyButton, moreWrap, replyButton);

    article.append(header, body, footer);
    enhancePolls(article, post);
    return article;
  }

  function postLikeCount(post) {
    const action = Array.isArray(post.actions_summary)
      ? post.actions_summary.find((item) => item.id === LIKE_ACTION_ID)
      : null;
    return Number(action?.count ?? post.like_count ?? 0) || 0;
  }

  function treeHotScore(post, directChildren = 0) {
    const likes = postLikeCount(post);
    const replies = Math.max(Number(post.reply_count) || 0, directChildren);
    // 点赞权重略高于回复；楼层号仅用作分数相同时的稳定排序依据。
    return likes * 4 + replies * 2;
  }

  function sortTreeSiblings(posts, childrenByParent) {
    return posts.sort((left, right) => {
      if (state.treeSort === 'hot') {
        const leftScore = treeHotScore(left, childrenByParent.get(Number(left.post_number))?.length || 0);
        const rightScore = treeHotScore(right, childrenByParent.get(Number(right.post_number))?.length || 0);
        if (leftScore !== rightScore) return rightScore - leftScore;
      }
      return (Number(left.post_number) || 0) - (Number(right.post_number) || 0);
    });
  }

  async function loadTreeReplies(post) {
    const number = Number(post.post_number) || 0;
    if (!number || state.treeRepliesLoaded.has(number) || state.treeRepliesLoading.has(number)) return;
    const token = state.loadToken;
    const topicId = state.currentTopicId;
    state.treeRepliesLoading.add(number);
    renderTreeView({ anchorPostNumber: number });
    try {
      let branchReplyIds = state.treeBranchReplyIds.get(post.id);
      if (!branchReplyIds) {
        const response = await fetchWithBackoff(`/posts/${post.id}/reply-ids.json`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (token !== state.loadToken || topicId !== state.currentTopicId) return;
        const entries = Array.isArray(data)
          ? data.map((item) => ({
            id: Number(item && typeof item === 'object' ? item.id : item),
            level: Math.max(1, Number(item && typeof item === 'object' ? item.level : 1) || 1),
          })).filter((item) => item.id)
          : [];
        branchReplyIds = entries.map((entry) => entry.id);
        state.treeBranchReplyIds.set(post.id, branchReplyIds);
        // reply-ids 是深度优先的 { id, level } 列表。按 level 还原父子关系，
        // 每个节点只保存它的直接回复 ID，不再把整棵子树算作该层回复。
        const directIds = new Map([[post.id, []]]);
        const ancestors = [post.id];
        for (const entry of entries) {
          const level = Math.min(entry.level, ancestors.length);
          const parentId = ancestors[level - 1] || post.id;
          if (!directIds.has(parentId)) directIds.set(parentId, []);
          directIds.get(parentId).push(entry.id);
          if (!directIds.has(entry.id)) directIds.set(entry.id, []);
          ancestors.length = level;
          ancestors[level] = entry.id;
          ancestors.length = level + 1;
        }
        for (const [postId, ids] of directIds) {
          state.treeDirectReplyIds.set(postId, ids);
        }
      }
      if (token !== state.loadToken || topicId !== state.currentTopicId) return;
      const directReplyIds = state.treeDirectReplyIds.get(post.id) || [];
      if (!branchReplyIds.length && Number(post.reply_count) > 0) {
        throw new Error('回复 ID 列表暂时为空');
      }
      state.treeReplyIds.set(number, directReplyIds);

      // 用户点击一次后，一次请求取回这条分支的所有后代评论。
      const missingIds = branchReplyIds.filter((id) => !state.allPosts.has(id));
      if (missingIds.length) {
        const replies = await fetchPostsByIds(topicId, missingIds);
        if (token !== state.loadToken || topicId !== state.currentTopicId) return;
        for (const reply of replies) {
          if (reply?.id) state.allPosts.set(reply.id, reply);
        }
        const unresolved = missingIds.filter((id) => !state.allPosts.has(id));
        if (unresolved.length) throw new Error(`有 ${unresolved.length} 条回复暂时不可用`);
      }

      // 整条分支已加载：建立每层的直接回复索引，并自动展开所有层级。
      const branchPosts = [post, ...branchReplyIds.map((id) => state.allPosts.get(id)).filter(Boolean)];
      for (const branchPost of branchPosts) {
        const branchNumber = Number(branchPost.post_number) || 0;
        if (!branchNumber) continue;
        const childIds = state.treeDirectReplyIds.get(branchPost.id) || [];
        state.treeReplyIds.set(branchNumber, childIds);
        state.treeRepliesLoaded.add(branchNumber);
        if (childIds.length || Number(branchPost.reply_count) > 0) {
          state.treeExpanded.add(branchNumber);
        }
      }
    } catch (error) {
      if (token !== state.loadToken || topicId !== state.currentTopicId) return;
      state.treeExpanded.delete(number);
      const reason = error?.message && !/^HTTP 429$/.test(error.message)
        ? `：${error.message}`
        : '';
      showToast(`#${number} 的回复加载失败${reason}，点击可重试`);
    } finally {
      if (token === state.loadToken && topicId === state.currentTopicId) {
        state.treeRepliesLoading.delete(number);
        if (state.viewMode === 'tree') renderTreeView({ anchorPostNumber: number });
      }
    }
  }

  function renderTreeNode(post, childrenByParent, visited) {
    const number = Number(post.post_number) || 0;
    if (visited.has(number)) return null;
    visited.add(number);

    const node = document.createElement('section');
    node.className = 'ld-preview-tree-node';
    node.dataset.postNumber = String(number);
    const article = renderPost(post, { treeMode: true });
    node.appendChild(article);

    const children = sortTreeSiblings([...(childrenByParent.get(number) || [])], childrenByParent);
    const repliesLoading = state.treeRepliesLoading.has(number);
    const directReplyCount = Math.max(0, Number(post.reply_count) || 0);
    // reply_count 为 0 的叶子节点不显示任何展开/收起控件。
    const hasReplies = directReplyCount > 0;
    if (hasReplies) {
      const expanded = state.treeExpanded.has(number);
      if (!expanded) {
        const expandButton = document.createElement('button');
        expandButton.type = 'button';
        expandButton.className = 'ld-preview-tree-collapse';
        expandButton.textContent = `＋ ${directReplyCount} 条回复`;
        expandButton.title = `加载并展开全部 ${directReplyCount} 条直接回复及其后续对话`;
        expandButton.setAttribute('aria-label', expandButton.title);
        expandButton.setAttribute('aria-expanded', 'false');
        expandButton.disabled = repliesLoading;
        expandButton.addEventListener('click', () => {
          state.treeExpanded.add(number);
          if (!state.treeRepliesLoaded.has(number)) {
            loadTreeReplies(post);
          } else {
            renderTreeView({ anchorPostNumber: number });
          }
        });
        const footer = article.querySelector(':scope > .ld-preview-post-footer');
        if (footer) footer.insertBefore(expandButton, footer.firstChild);
      }

      if (expanded) {
        const collapseBranch = (event) => {
          event.stopPropagation();
          state.treeExpanded.delete(number);
          renderTreeView({ anchorPostNumber: number });
        };
        const bindBranchControl = (control) => {
          control.title = `收起 #${number} 的回复`;
          control.setAttribute('aria-label', control.title);
          control.addEventListener('click', collapseBranch);
          control.addEventListener('pointerenter', () => node.classList.add('is-tree-rail-hovered'));
          control.addEventListener('pointerleave', () => node.classList.remove('is-tree-rail-hovered'));
          control.addEventListener('focus', () => node.classList.add('is-tree-rail-hovered'));
          control.addEventListener('blur', () => node.classList.remove('is-tree-rail-hovered'));
        };

        // 父评论内部的上半段：圆形折叠点位于操作区下方，而非子树顶端。
        const stem = document.createElement('button');
        stem.type = 'button';
        stem.className = 'ld-preview-tree-stem';
        bindBranchControl(stem);
        article.appendChild(stem);

        const childBox = document.createElement('div');
        childBox.className = 'ld-preview-tree-children';
        const rail = document.createElement('button');
        rail.type = 'button';
        rail.className = 'ld-preview-tree-rail';
        bindBranchControl(rail);
        childBox.appendChild(rail);
        for (const child of children) {
          const childNode = renderTreeNode(child, childrenByParent, visited);
          if (childNode) childBox.appendChild(childNode);
        }
        if (repliesLoading) {
          const loading = document.createElement('div');
          loading.className = 'ld-preview-embedded-empty';
          loading.textContent = '正在加载此分支…';
          childBox.appendChild(loading);
        }
        node.appendChild(childBox);
      }
    }
    return node;
  }

  function renderTreeView({ preserveScroll = true, anchorPostNumber = 0 } = {}) {
    if (!state.list) return;
    const previousScrollTop = state.scroll.scrollTop;
    let effectiveAnchorNumber = anchorPostNumber;
    if (!effectiveAnchorNumber && preserveScroll) {
      const scrollTop = state.scroll.getBoundingClientRect().top;
      const firstVisible = [...state.list.querySelectorAll('article.ld-preview-post')]
        .find((article) => article.getBoundingClientRect().bottom >= scrollTop + 4);
      effectiveAnchorNumber = Number(firstVisible?.dataset.postNumber) || 0;
    }
    const previousAnchor = effectiveAnchorNumber
      ? state.list.querySelector(`article[data-post-number="${effectiveAnchorNumber}"]`)
      : null;
    const previousAnchorTop = previousAnchor
      ? previousAnchor.getBoundingClientRect().top - state.scroll.getBoundingClientRect().top
      : null;
    const posts = [...state.allPosts.values()].filter((post) => post?.post_number != null);
    const byNumber = new Map(posts.map((post) => [Number(post.post_number), post]));
    const childrenByParent = new Map();
    const roots = [];
    const op = byNumber.get(1) || null;

    for (const post of posts) {
      const number = Number(post.post_number);
      if (number === 1) continue;
      const parentNumber = Number(post.reply_to_post_number) || 0;
      if (parentNumber && parentNumber !== number && byNumber.has(parentNumber)) {
        if (!childrenByParent.has(parentNumber)) childrenByParent.set(parentNumber, []);
        childrenByParent.get(parentNumber).push(post);
      } else {
        // 父评论尚未加载、已删除或不可见时，先作为顶层节点显示，
        // 避免该评论因无法挂载到本地父节点而从树中消失。
        roots.push(post);
      }
    }

    // Discourse 中回复主题首帖的帖子属于顶层评论，不额外缩进一层。
    if (op && childrenByParent.has(1)) roots.push(...childrenByParent.get(1));
    const rootPosts = sortTreeSiblings(roots, childrenByParent);
    const fragment = document.createDocumentFragment();
    const visited = new Set();

    if (op) {
      visited.add(1);
      const opWrap = document.createElement('div');
      opWrap.className = 'ld-preview-tree-op';
      opWrap.appendChild(renderPost(op, { treeMode: true }));
      fragment.appendChild(opWrap);
    }
    for (const post of rootPosts) {
      const node = renderTreeNode(post, childrenByParent, visited);
      if (node) fragment.appendChild(node);
    }
    state.list.textContent = '';
    if (posts.length) state.list.appendChild(fragment);
    else {
      const empty = document.createElement('div');
      empty.className = 'ld-preview-tree-empty';
      empty.textContent = '暂无评论';
      state.list.appendChild(empty);
    }
    state.loadedIds = new Set(posts.map((post) => post.id));
    const loadedStreamCount = state.stream.reduce(
      (count, id) => count + (state.allPosts.has(id) ? 1 : 0),
      0,
    );
    if (state.viewNote) state.viewNote.textContent = `按需加载 ${loadedStreamCount}/${state.stream.length} 楼`;
    if (previousAnchorTop != null) {
      const nextAnchor = state.list.querySelector(`article[data-post-number="${effectiveAnchorNumber}"]`);
      if (nextAnchor) {
        const nextAnchorTop = nextAnchor.getBoundingClientRect().top - state.scroll.getBoundingClientRect().top;
        state.scroll.scrollTop += nextAnchorTop - previousAnchorTop;
      }
    } else if (preserveScroll) {
      state.scroll.scrollTop = previousScrollTop;
    }
  }

  function renderOriginalView() {
    let contiguousEnd = -1;
    while (contiguousEnd + 1 < state.stream.length
      && state.allPosts.has(state.stream[contiguousEnd + 1])) contiguousEnd += 1;
    const posts = state.stream
      .slice(0, contiguousEnd + 1)
      .map((id) => state.allPosts.get(id))
      .filter(Boolean);
    state.list.textContent = '';
    state.loadedIds = new Set();
    state.startIdx = 0;
    state.endIdx = contiguousEnd;
    appendPosts(posts);
    updateSentinels();
    state.scroll.scrollTop = 0;
    updateTimelinePosition(0, state.stream.length);
  }

  function renderFilteredView({ preserveScroll = false } = {}) {
    if (!state.postFilter || !state.list) return;
    hidePostMenu();
    const previousScrollTop = preserveScroll ? state.scroll.scrollTop : 0;
    const posts = state.stream
      .map((id) => state.allPosts.get(id))
      .filter((post) => post && matchesPostFilter(post));
    const fragment = document.createDocumentFragment();

    const banner = document.createElement('div');
    banner.className = 'ld-preview-filter-banner';
    const label = document.createElement('span');
    label.className = 'ld-preview-filter-label';
    label.textContent = `${postFilterLabel()} · ${posts.length} 楼`;
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'ld-preview-filter-clear';
    clearButton.textContent = '显示全部';
    clearButton.addEventListener('click', clearPostFilter);
    banner.append(label, clearButton);
    fragment.appendChild(banner);

    for (const post of posts) fragment.appendChild(renderPost(post));
    if (!posts.length) {
      const empty = document.createElement('div');
      empty.className = 'ld-preview-tree-empty';
      empty.textContent = '没有找到该用户的评论';
      fragment.appendChild(empty);
    }

    state.list.textContent = '';
    state.list.appendChild(fragment);
    state.loadedIds = new Set(posts.map((post) => post.id));
    state.startIdx = 0;
    state.endIdx = state.stream.length - 1;
    state.topSentinel.hidden = true;
    state.topSentinel.textContent = '';
    state.sentinel.hidden = true;
    state.sentinel.textContent = '';
    state.panel.classList.remove('has-timeline');
    if (state.viewNote) state.viewNote.textContent = `${postFilterLabel()} · ${posts.length} 楼`;
    state.scroll.scrollTop = previousScrollTop;
  }

  async function applyPostFilter(filter) {
    if (!filter || state.postFilterLoading || !state.currentTopicId) return;
    hidePostMenu();
    const requestToken = ++state.postFilterToken;
    const loadToken = state.loadToken;
    const topicId = state.currentTopicId;
    const missingIds = state.stream.filter((id) => !state.allPosts.has(id));
    if (!state.postFilter) state.postFilterRestoreIndex = state.currentIdx;
    state.postFilterLoading = true;
    state.panel.classList.add('is-loading');

    try {
      for (let offset = 0; offset < missingIds.length; offset += POSTS_PER_BATCH) {
        const ids = missingIds.slice(offset, offset + POSTS_PER_BATCH);
        setStatus(`正在加载全部评论 ${Math.min(offset + ids.length, missingIds.length)}/${missingIds.length}…`);
        const posts = await fetchPostsByIds(topicId, ids);
        if (requestToken !== state.postFilterToken
          || loadToken !== state.loadToken
          || topicId !== state.currentTopicId) return;
        for (const post of posts) {
          if (post) state.allPosts.set(post.id, post);
        }
      }
      if (requestToken !== state.postFilterToken
        || loadToken !== state.loadToken
        || topicId !== state.currentTopicId) return;
      state.postFilter = filter;
      state.currentIdx = state.stream.findIndex((id) => matchesPostFilter(state.allPosts.get(id), filter));
      if (state.currentIdx < 0) state.currentIdx = 0;
      renderFilteredView();
      showToast(`${postFilterLabel()}，共 ${state.loadedIds.size} 楼`);
    } catch (error) {
      if (requestToken === state.postFilterToken) {
        showToast(`加载评论失败：${error.message || '请稍后重试'}`);
      }
    } finally {
      if (requestToken === state.postFilterToken) {
        state.postFilterLoading = false;
        state.panel.classList.remove('is-loading');
        setStatus('');
      }
    }
  }

  function clearPostFilter() {
    if (!state.postFilter && !state.postFilterLoading) return;
    state.postFilterToken += 1;
    state.postFilterLoading = false;
    state.postFilter = null;
    hidePostMenu();
    state.panel.classList.remove('is-loading');
    setStatus('');
    state.panel.classList.toggle('has-timeline', state.stream.length > 1);

    if (state.viewMode === 'tree') {
      renderTreeView({ preserveScroll: false });
      updateSentinels();
      state.scroll.scrollTop = 0;
      schedulePaginationCheck();
      return;
    }

    const target = Math.min(
      Math.max(state.postFilterRestoreIndex || 0, 0),
      Math.max(0, state.stream.length - 1),
    );
    const start = Math.max(0, target - 3);
    const ids = state.stream.slice(start, start + POSTS_PER_BATCH);
    const posts = ids.map((id) => state.allPosts.get(id)).filter(Boolean);
    state.list.textContent = '';
    state.loadedIds = new Set();
    state.startIdx = start;
    state.endIdx = start + ids.length - 1;
    appendPosts(posts);
    updateSentinels();
    scrollToStreamIndex(target);
    schedulePaginationCheck();
  }

  function updateViewUi() {
    const isTree = state.viewMode === 'tree';
    state.panel?.classList.toggle('is-tree-view', isTree);
    if (state.viewBar) state.viewBar.hidden = !isTree;
    if (state.treeButton) {
      state.treeButton.textContent = isTree ? '▤' : '🌳';
      state.treeButton.title = isTree ? '切换到原始视图' : '切换到树状评论';
      state.treeButton.setAttribute('aria-label', state.treeButton.title);
    }
  }

  async function setViewMode(mode, { persist = true } = {}) {
    const nextMode = mode === 'tree' ? 'tree' : 'original';
    state.viewMode = nextMode;
    if (persist) localStorage.setItem(VIEW_KEY, nextMode);
    updateViewUi();
    if (!state.currentTopicId || !state.stream.length) return;
    if (state.postFilter) {
      renderFilteredView();
      return;
    }

    if (nextMode === 'tree') {
      let contiguousEnd = -1;
      while (contiguousEnd + 1 < state.stream.length
        && state.allPosts.has(state.stream[contiguousEnd + 1])) contiguousEnd += 1;
      state.startIdx = 0;
      state.endIdx = contiguousEnd;
      renderTreeView({ preserveScroll: false });
      updateSentinels();
      state.scroll.scrollTop = 0;
    } else {
      renderOriginalView();
    }
    schedulePaginationCheck();
  }

  function appendPosts(posts) {
    for (const post of posts) {
      if (post) state.allPosts.set(post.id, post);
    }
    if (state.postFilter) {
      if (posts.some((post) => matchesPostFilter(post))) renderFilteredView({ preserveScroll: true });
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const post of posts) {
      if (!post) continue;
      if (state.loadedIds.has(post.id)) continue;
      state.loadedIds.add(post.id);
      if (state.viewMode !== 'tree') fragment.appendChild(renderPost(post));
    }
    if (state.viewMode === 'tree') renderTreeView();
    else state.list.appendChild(fragment);
  }

  function prependPosts(posts) {
    if (state.postFilter) return;
    const fragment = document.createDocumentFragment();
    for (const post of posts) {
      if (!post) continue;
      state.allPosts.set(post.id, post);
      if (state.loadedIds.has(post.id)) continue;
      state.loadedIds.add(post.id);
      if (state.viewMode !== 'tree') fragment.appendChild(renderPost(post));
    }
    if (state.viewMode === 'tree') {
      renderTreeView();
      return;
    }
    const previousHeight = state.scroll.scrollHeight;
    state.list.insertBefore(fragment, state.list.firstChild);
    state.scroll.scrollTop += state.scroll.scrollHeight - previousHeight;
  }

  function updateSentinels() {
    if (state.postFilter) {
      state.topSentinel.hidden = true;
      state.topSentinel.textContent = '';
      state.sentinel.hidden = true;
      state.sentinel.textContent = '';
      return;
    }
    if (state.viewMode === 'tree') {
      state.topSentinel.hidden = true;
      state.topSentinel.textContent = '';
      state.sentinel.hidden = state.endIdx >= state.stream.length - 1;
      state.sentinel.textContent = state.sentinel.hidden ? '' : '继续滚动，按需加载更多评论…';
      state.sentinel.disabled = state.loadingMore;
      return;
    }
    const total = state.stream.length;
    state.sentinel.hidden = state.endIdx >= total - 1;
    state.sentinel.textContent = state.sentinel.hidden ? '' : '继续滚动，按需加载更多评论…';
    state.sentinel.disabled = state.loadingMore;
    state.topSentinel.hidden = state.startIdx <= 0;
    state.topSentinel.textContent = state.topSentinel.hidden ? '' : '继续滚动，按需加载之前的楼层…';
    state.topSentinel.disabled = state.loadingBefore;
  }

  function checkPaginationThresholds() {
    if (!state.open || state.postFilter || !state.scroll || !state.currentTopicId) return;
    const distanceToBottom = Math.max(
      0,
      state.scroll.scrollHeight - state.scroll.clientHeight - state.scroll.scrollTop,
    );
    if (state.endIdx < state.stream.length - 1 && distanceToBottom <= PAGINATION_PREFETCH_PX) {
      loadAfter();
    }
    if (state.startIdx > 0 && state.scroll.scrollTop <= PAGINATION_PREFETCH_PX) {
      loadBefore();
    }
  }

  function schedulePaginationCheck() {
    if (state.paginationFrame) return;
    state.paginationFrame = requestAnimationFrame(() => {
      state.paginationFrame = 0;
      checkPaginationThresholds();
    });
  }

  function updateTimelinePosition(index, total) {
    if (!state.timelineHandle) return;
    const ratio = total > 1 ? index / (total - 1) : 0;
    state.timelineHandle.style.top = `${ratio * 100}%`;
    const id = state.stream[index];
    const article = id != null ? state.list.querySelector(`article[data-post-id="${id}"]`) : null;
    const postNumber = article?.dataset.postNumber || String(index + 1);
    const displayTotal = state.topicMeta?.highestPostNumber || total;
    const dateText = article?.dataset.createdAt ? formatDate(article.dataset.createdAt) : '';
    state.timelineLabel.textContent = `${postNumber} / ${displayTotal}${dateText ? `\n${dateText}` : ''}`;
    state.currentPostNumber = Number(postNumber) || 0;
    updateBackButton();
  }

  function approxIndexForPostNumber(postNumber) {
    const article = state.list.querySelector(`article[data-post-number="${postNumber}"]`);
    if (article) {
      const index = state.streamIndex.get(Number(article.dataset.postId));
      if (index != null) return index;
    }
    return Math.min(Math.max(Math.round(postNumber) - 1, 0), Math.max(0, state.stream.length - 1));
  }

  function updateBackButton() {
    if (!state.backButton) return;
    const lastRead = state.topicMeta?.lastReadPostNumber || 0;
    const total = state.stream.length;
    const highest = state.topicMeta?.highestPostNumber || total;
    // Match Discourse hasBackPosition: hidden near the start, near the
    // current position, or when the read frontier is already at the end.
    const show = total > 1 && lastRead > 3
      && Math.abs((state.currentPostNumber || 0) - lastRead) > 3
      && Math.abs(lastRead - highest) > 1;
    state.backButton.hidden = !show;
    if (!show) return;
    const ratio = approxIndexForPostNumber(lastRead) / (total - 1);
    state.backButton.style.top = `clamp(16px, ${(ratio * 100).toFixed(2)}%, calc(100% - 16px))`;
    state.backButton.title = `回到上次阅读位置 (#${lastRead})`;
  }

  async function jumpToPostNumber(postNumber) {
    if (!state.stream.length) return;
    const approx = Math.min(Math.max(Math.round(postNumber) - 1, 0), state.stream.length - 1);
    await jumpToIndex(approx);

    let best = null;
    let bestDiff = Infinity;
    for (const article of state.list.querySelectorAll('article.ld-preview-post')) {
      const number = Number(article.dataset.postNumber);
      if (!number) continue;
      const diff = Math.abs(number - postNumber);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = article;
      }
    }
    if (best) {
      const index = state.streamIndex.get(Number(best.dataset.postId));
      if (index != null) scrollToStreamIndex(index);
    }
  }

  function syncTimelineToScroll() {
    if (state.postFilter || state.viewMode === 'tree' || state.timelineDragging || !state.stream.length) return;
    const viewTop = state.scroll.getBoundingClientRect().top;
    let currentIndex = state.currentIdx;
    for (const article of state.list.querySelectorAll('article.ld-preview-post')) {
      const rect = article.getBoundingClientRect();
      if (rect.bottom >= viewTop + 20) {
        const index = state.streamIndex.get(Number(article.dataset.postId));
        if (index != null) currentIndex = index;
        break;
      }
    }
    state.currentIdx = currentIndex;
    updateTimelinePosition(currentIndex, state.stream.length);
  }

  function scrollToStreamIndex(index) {
    const id = state.stream[index];
    const article = state.list.querySelector(`article[data-post-id="${id}"]`);
    if (article) {
      const articleRect = article.getBoundingClientRect();
      const scrollRect = state.scroll.getBoundingClientRect();
      state.scroll.scrollTop += articleRect.top - scrollRect.top - 8;
    }
    state.currentIdx = index;
    updateTimelinePosition(index, state.stream.length);
  }

  async function fetchWithBackoff(path, options, maxRetries = 2) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(path, options);
      if (response.status !== 429 || attempt >= maxRetries) return response;

      const retryAfter = response.headers.get('Retry-After');
      let waitMs = Number(retryAfter) * 1000;
      if (!Number.isFinite(waitMs) || waitMs <= 0) {
        const retryDate = Date.parse(retryAfter || '');
        waitMs = Number.isFinite(retryDate) ? retryDate - Date.now() : 0;
      }
      if (!Number.isFinite(waitMs) || waitMs <= 0) waitMs = 1500 * (2 ** attempt);
      waitMs = Math.min(Math.max(waitMs, 1000), 10000);
      showToast(`请求较频繁，${Math.ceil(waitMs / 1000)} 秒后自动重试`);
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    }
  }

  async function fetchPostsByIds(topicId, ids) {
    const params = new URLSearchParams();
    for (const id of ids) params.append('post_ids[]', id);
    const response = await fetchWithBackoff(`/t/${topicId}/posts.json?${params}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.post_stream?.posts || [];
  }

  async function jumpToIndex(index) {
    const total = state.stream.length;
    if (!total || !state.currentTopicId) return;
    const target = Math.min(Math.max(index, 0), total - 1);

    if (state.viewMode === 'tree') {
      const id = state.stream[target];
      const article = state.list.querySelector(`article[data-post-id="${id}"]`);
      if (article) {
        const articleRect = article.getBoundingClientRect();
        const scrollRect = state.scroll.getBoundingClientRect();
        state.scroll.scrollTop += articleRect.top - scrollRect.top - 8;
        state.currentIdx = target;
        updateTimelinePosition(target, total);
      }
      return;
    }

    if (target >= state.startIdx && target <= state.endIdx) {
      scrollToStreamIndex(target);
      return;
    }

    const token = ++state.loadToken;
    const start = Math.max(0, target - 3);
    const ids = state.stream.slice(start, start + POSTS_PER_BATCH);
    state.panel.classList.add('is-loading');

    try {
      const posts = await fetchPostsByIds(state.currentTopicId, ids);
      if (token !== state.loadToken) return;
      state.list.textContent = '';
      state.loadedIds = new Set();
      state.loadingMore = false;
      state.loadingBefore = false;
      state.startIdx = start;
      state.endIdx = start + ids.length - 1;
      appendPosts(posts);
      updateSentinels();
      scrollToStreamIndex(target);
    } catch {
      if (token === state.loadToken) showToast('跳转失败，请重试');
    } finally {
      if (token === state.loadToken) state.panel.classList.remove('is-loading');
    }
  }

  function renderTopic(data, topicUrl) {
    const posts = data.post_stream?.posts || [];
    state.stream = data.post_stream?.stream || [];
    state.streamIndex = new Map(state.stream.map((id, index) => [id, index]));
    state.loadedIds = new Set();
    state.postFilterToken += 1;
    state.postFilter = null;
    state.postFilterLoading = false;
    state.postFilterRestoreIndex = 0;
    hidePostMenu();
    state.allPosts = new Map(posts.filter(Boolean).map((post) => [post.id, post]));
    state.treeExpanded = new Set();
    state.treeRepliesLoaded = new Set();
    state.treeRepliesLoading = new Set();
    state.treeReplyIds = new Map();
    state.treeDirectReplyIds = new Map();
    state.treeBranchReplyIds = new Map();
    state.loadingMore = false;
    state.loadingBefore = false;
    state.startIdx = 0;
    state.endIdx = posts.length - 1;
    state.currentIdx = 0;
    if (!Array.isArray(data.bookmarks)) data.bookmarks = [];
    state.topicMeta = {
      topicId: data.id || Number(state.currentTopicId),
      bookmarks: data.bookmarks,
      createdAt: data.created_at || '',
      lastPostedAt: data.last_posted_at || '',
      highestPostNumber: data.highest_post_number || state.stream.length,
      ownerId: data.details?.created_by?.id || 0,
      ownerUsername: data.details?.created_by?.username || '',
      lastReadPostNumber: Math.max(
        data.last_read_post_number || 0,
        localLastRead.get(String(state.currentTopicId)) || 0,
      ),
      notificationLevel: data.details?.notification_level ?? 1,
    };
    updateTopicBookmarkButton();
    state.list.textContent = '';
    state.sentinel.textContent = '';
    state.topSentinel.textContent = '';
    closeComposer();
    appendPosts(posts);
    updateSentinels();

    const topicTitle = (data.title || '').trim();
    state.title.textContent = topicTitle || '帖子预览';
    state.title.title = topicTitle || topicUrl;
    state.replyBar.hidden = false;
    state.timelineStart.textContent = formatDate(state.topicMeta.createdAt) || '开始';
    state.timelineLast.textContent = formatRelative(state.topicMeta.lastPostedAt) || '最后';
    hideNotifMenu();
    updateNotifButton();
    state.panel.classList.toggle('has-timeline', state.stream.length > 1);
    updateViewUi();
    updateTimelinePosition(0, state.stream.length);
    state.scroll.scrollTop = 0;
    if (state.viewMode === 'tree') setViewMode('tree', { persist: false });
    schedulePaginationCheck();
  }

  function unsubscribeLiveUpdates() {
    if (!state.liveChannel || !state.liveHandler) return;
    try {
      window.MessageBus?.unsubscribe(state.liveChannel, state.liveHandler);
    } catch {
      // MessageBus may be gone; nothing to clean up.
    }
    state.liveChannel = '';
    state.liveHandler = null;
  }

  function subscribeLiveUpdates(topicId) {
    unsubscribeLiveUpdates();
    const bus = window.MessageBus;
    if (!bus?.subscribe) return;
    const channel = `/topic/${topicId}`;
    const handler = (msg) => handleLiveMessage(topicId, msg);
    try {
      bus.subscribe(channel, handler);
      state.liveChannel = channel;
      state.liveHandler = handler;
    } catch {
      // Live updates degrade silently; manual refresh still works.
    }
  }

  async function handleLiveMessage(topicId, msg) {
    if (!state.open || String(topicId) !== String(state.currentTopicId)) return;
    if (!msg || msg.type !== 'created' || !msg.id) return;
    if (state.streamIndex.has(msg.id)) return;
    topicCache.delete(topicId);
    const wasAtEnd = state.endIdx >= state.stream.length - 1;
    state.stream.push(msg.id);
    state.streamIndex.set(msg.id, state.stream.length - 1);
    if (state.topicMeta && msg.post_number > state.topicMeta.highestPostNumber) {
      state.topicMeta.highestPostNumber = msg.post_number;
    }
    if (wasAtEnd) {
      try {
        const posts = await fetchPostsByIds(topicId, [msg.id]);
        if (!state.open || String(topicId) !== String(state.currentTopicId)) return;
        appendPosts(posts);
        state.endIdx = state.stream.length - 1;
        showToast(`收到新回复 #${msg.post_number}`);
      } catch {
        // The bottom sentinel picks the post up on the next scroll.
      }
    }
    updateSentinels();
    updateTimelinePosition(state.currentIdx, state.stream.length);
  }

  async function loadTopic(topicId, topicUrl, force = false) {
    const token = ++state.loadToken;
    state.postFilterToken += 1;
    state.postFilter = null;
    state.postFilterLoading = false;
    hidePostMenu();
    setTopicLoadFailed(false);
    const cached = !force && hasFreshCache(topicId);
    state.panel.classList.add('is-loading');
    state.title.textContent = '正在加载帖子...';
    state.title.title = topicUrl;
    if (!cached) setStatus('正在加载帖子...');

    try {
      const data = await fetchTopic(topicId, { force, trackView: true });
      if (token !== state.loadToken) return;
      state.panel.classList.remove('is-loading');
      setTopicLoadFailed(false);
      setStatus('');
      renderTopic(data, topicUrl);
      const floor = floorFromUrl(topicUrl);
      if (state.viewMode === 'tree') {
        // 树状视图按分支或热度排列，不自动套用原始时间线的续读位置。
      } else if (floor > 1) {
        jumpToIndex(Math.min(floor - 1, state.stream.length - 1));
      } else {
        const lastRead = state.topicMeta.lastReadPostNumber || 0;
        if (lastRead > 1) {
          // Resume at the first unread floor; fully-read topics land on the last one.
          const target = lastRead >= state.topicMeta.highestPostNumber ? lastRead : lastRead + 1;
          jumpToPostNumber(target);
        }
      }
      subscribeLiveUpdates(topicId);
    } catch {
      if (token !== state.loadToken) return;
      state.panel.classList.remove('is-loading');
      setTopicLoadFailed(true);
      setStatus('加载失败，点击标题或 ↻ 重试');
      state.title.textContent = '帖子预览';
      state.title.title = '加载失败，点击标题重试';
    }
  }

  async function loadAfter() {
    if (state.postFilter || state.loadingMore || !state.currentTopicId) return;
    const from = state.endIdx + 1;
    const ids = state.stream.slice(from, from + POSTS_PER_BATCH);
    if (!ids.length) return;

    const token = state.loadToken;
    state.loadingMore = true;
    state.sentinel.disabled = true;
    state.sentinel.textContent = '正在加载更多回复...';
    let loaded = false;

    try {
      const posts = await fetchPostsByIds(state.currentTopicId, ids);
      if (token !== state.loadToken) return;
      appendPosts(posts);
      state.endIdx = from + ids.length - 1;
      loaded = true;
      state.sentinel.textContent = '';
      updateSentinels();
    } catch {
      if (token === state.loadToken) state.sentinel.textContent = '加载更多失败，点击重试';
    } finally {
      if (token === state.loadToken) {
        state.loadingMore = false;
        state.sentinel.disabled = false;
        if (loaded) schedulePaginationCheck();
      }
    }
  }

  async function loadBefore() {
    if (state.postFilter || state.loadingBefore || !state.currentTopicId || state.startIdx <= 0) return;
    const start = Math.max(0, state.startIdx - POSTS_PER_BATCH);
    const ids = state.stream.slice(start, state.startIdx);
    if (!ids.length) return;

    const token = state.loadToken;
    state.loadingBefore = true;
    state.topSentinel.disabled = true;
    state.topSentinel.textContent = '正在加载之前的楼层...';
    let loaded = false;

    try {
      const posts = await fetchPostsByIds(state.currentTopicId, ids);
      if (token !== state.loadToken) return;
      prependPosts(posts);
      state.startIdx = start;
      loaded = true;
      state.topSentinel.textContent = '';
      updateSentinels();
    } catch {
      if (token === state.loadToken) state.topSentinel.textContent = '加载失败，点击重试';
    } finally {
      if (token === state.loadToken) {
        state.loadingBefore = false;
        state.topSentinel.disabled = false;
        if (loaded) schedulePaginationCheck();
      }
    }
  }

  function tickReadTracker() {
    if (readTracker.disabled || !state.open || !state.currentTopicId) return;
    if (document.visibilityState !== 'visible') return;

    const viewRect = state.scroll.getBoundingClientRect();
    let sawVisible = false;
    let maxVisibleNumber = 0;
    let minVisibleNumber = Infinity;
    for (const article of state.list.querySelectorAll('article.ld-preview-post')) {
      const postNumber = article.dataset?.postNumber;
      if (!postNumber) continue;
      const rect = article.getBoundingClientRect();
      if (rect.bottom < viewRect.top || rect.top > viewRect.bottom) continue;
      readTracker.timings.set(postNumber, (readTracker.timings.get(postNumber) || 0) + TIMINGS_TICK_MS);
      sawVisible = true;
      if (Number(postNumber) > maxVisibleNumber) maxVisibleNumber = Number(postNumber);
      if (Number(postNumber) < minVisibleNumber) minVisibleNumber = Number(postNumber);
    }
    if (sawVisible) {
      readTracker.topicTime += TIMINGS_TICK_MS;
      // Advance the read frontier only while reading contiguously from it;
      // jumping elsewhere via the timeline must leave the back target fixed.
      if (state.topicMeta) {
        const lastRead = state.topicMeta.lastReadPostNumber || 0;
        if (!state.postFilter && state.viewMode !== 'tree'
          && maxVisibleNumber > lastRead && minVisibleNumber <= lastRead + 3) {
          state.topicMeta.lastReadPostNumber = maxVisibleNumber;
          localLastRead.set(String(state.currentTopicId), maxVisibleNumber);
          updateBackButton();
        }
      }
    }
  }

  async function flushReadTimings(topicId = state.currentTopicId) {
    if (readTracker.disabled || !topicId || !readTracker.timings.size) return;
    const timings = readTracker.timings;
    const topicTime = readTracker.topicTime;
    readTracker.timings = new Map();
    readTracker.topicTime = 0;

    const send = async (forceToken) => {
      const token = await getCsrfToken(forceToken);
      const params = new URLSearchParams();
      params.set('topic_id', topicId);
      params.set('topic_time', String(topicTime));
      for (const [postNumber, ms] of timings) params.set(`timings[${postNumber}]`, String(ms));
      return fetch('/topics/timings', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRF-Token': token,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: params.toString(),
      });
    };

    try {
      let response = await send(false);
      if (response.status === 403) {
        csrfToken = '';
        response = await send(true);
        if (response.status === 403) readTracker.disabled = true;
      }
    } catch {
      // 网络异常时丢弃本次增量，避免重复上报
    }
  }

  function startReadTracker() {
    if (readTracker.tickTimer) return;
    readTracker.tickTimer = window.setInterval(tickReadTracker, TIMINGS_TICK_MS);
    readTracker.flushTimer = window.setInterval(() => flushReadTimings(), TIMINGS_FLUSH_MS);
  }

  function stopReadTracker() {
    clearInterval(readTracker.tickTimer);
    clearInterval(readTracker.flushTimer);
    readTracker.tickTimer = 0;
    readTracker.flushTimer = 0;
  }

  function composerWrap(prefix, suffix, placeholder) {
    const input = state.composerInput;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const selected = input.value.slice(start, end) || placeholder;
    input.setRangeText(prefix + selected + suffix, start, end, 'end');
    input.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    input.focus();
  }

  function composerLinePrefix(prefix) {
    const input = state.composerInput;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const lineStart = input.value.lastIndexOf('\n', start - 1) + 1;
    const block = input.value.slice(lineStart, end) || '';
    const replaced = block.split('\n').map((line) => prefix + line).join('\n');
    input.setRangeText(replaced, lineStart, end, 'end');
    input.focus();
  }

  function composerCode() {
    const input = state.composerInput;
    if (!input) return;
    const selected = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
    if (selected.includes('\n')) composerWrap('```\n', '\n```', '代码');
    else composerWrap('`', '`', '代码');
  }

  function insertComposerText(text) {
    const input = state.composerInput;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    input.setRangeText(text, start, input.selectionEnd ?? start, 'end');
  }

  function replaceComposerText(oldText, newText) {
    const input = state.composerInput;
    if (!input) return;
    const index = input.value.indexOf(oldText);
    if (index < 0) {
      if (newText) insertComposerText(newText);
      return;
    }
    input.setRangeText(newText, index, index + oldText.length, 'end');
  }

  async function uploadFile(file, retried = false) {
    const token = await getCsrfToken(retried);
    const form = new FormData();
    form.append('type', 'composer');
    form.append('upload_type', 'composer');
    form.append('name', file.name);
    form.append('file', file, file.name);
    const response = await fetch('/uploads.json', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': token,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: form,
    });
    if (response.status === 403 && !retried) {
      csrfToken = '';
      return uploadFile(file, true);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.url) {
      const message = Array.isArray(data?.errors) && data.errors.length
        ? data.errors.join('；')
        : `上传失败（HTTP ${response.status}）`;
      throw new Error(message);
    }
    return data;
  }

  async function uploadFiles(files) {
    const list = Array.from(files || []).filter((file) => file && file.size);
    if (!list.length) return;
    for (const file of list) {
      const placeholder = `[上传中：${file.name}…]() `;
      insertComposerText(placeholder);
      state.pendingUploads += 1;
      try {
        const data = await uploadFile(file);
        const name = data.original_filename || file.name;
        const url = data.short_url || data.url;
        const isImage = /^image\//i.test(file.type)
          || /^(png|jpe?g|gif|webp|avif|svg)$/i.test(data.extension || '');
        const dims = isImage && data.width && data.height ? `|${data.width}x${data.height}` : '';
        const markdown = isImage
          ? `![${name}${dims}](${url}) `
          : `[${name}|attachment](${url}) `;
        replaceComposerText(placeholder, markdown);
      } catch (error) {
        replaceComposerText(placeholder, '');
        showToast(error.message || '上传失败');
      } finally {
        state.pendingUploads -= 1;
      }
    }
  }

  async function cookMarkdown(raw) {
    try {
      const text = window.require?.('discourse/lib/text');
      const cook = text?.cook || text?.cookAsync;
      if (cook) return String(await cook(raw));
    } catch {
      // The page bundle may not expose the renderer; preview degrades below.
    }
    return null;
  }

  async function refreshComposerPreview() {
    const html = await cookMarkdown(state.composerInput?.value || '');
    if (html == null || !state.composerPreview || state.composerPreview.hidden) return;
    state.composerPreview.innerHTML = html
      || '<p style="color: var(--primary-medium, #757575)">（无内容）</p>';
  }

  async function toggleComposerPreview() {
    const preview = state.composerPreview;
    if (!preview) return;
    if (!preview.hidden) {
      preview.hidden = true;
      preview.innerHTML = '';
      state.composerPreviewButton?.classList.remove('is-active');
      return;
    }
    const html = await cookMarkdown(state.composerInput?.value || '');
    if (html == null) {
      showToast('预览不可用：页面渲染器未就绪');
      return;
    }
    preview.innerHTML = html
      || '<p style="color: var(--primary-medium, #757575)">（无内容）</p>';
    preview.hidden = false;
    state.composerPreviewButton?.classList.add('is-active');
  }

  function setComposerTarget(replyToNumber, username) {
    state.replyToNumber = replyToNumber || null;
    state.composerTargetText.textContent = state.replyToNumber
      ? `回复 #${state.replyToNumber}${username ? ` @${username}` : ''}`
      : '回复主题';
    state.composerTargetSwitch.hidden = !state.replyToNumber;
  }

  function openComposer(replyToNumber, username) {
    ensurePanel();
    setComposerTarget(replyToNumber, username);
    state.composerError.textContent = '';
    state.composer.hidden = false;
    state.composerInput.focus();
  }

  function closeComposer(clearDraft = true) {
    if (!state.composer) return;
    state.composer.hidden = true;
    state.replyToNumber = null;
    state.composerError.textContent = '';
    if (clearDraft) state.composerInput.value = '';
    if (state.composerPreview) {
      state.composerPreview.hidden = true;
      state.composerPreview.innerHTML = '';
    }
    state.composerPreviewButton?.classList.remove('is-active');
  }

  async function submitReply() {
    if (state.submittingReply || !state.currentTopicId) return;
    if (state.pendingUploads > 0) {
      state.composerError.textContent = '附件上传中，请稍候再发送';
      return;
    }
    const raw = state.composerInput.value.trim();
    if (!raw) {
      state.composerError.textContent = '回复内容不能为空';
      return;
    }

    state.submittingReply = true;
    state.composerSend.disabled = true;
    state.composerSend.textContent = '发送中...';
    state.composerError.textContent = '';

    try {
      const body = { raw, topic_id: Number(state.currentTopicId) };
      if (state.replyToNumber) body.reply_to_post_number = state.replyToNumber;
      const data = await apiRequest('POST', '/posts.json', body);

      state.composerInput.value = '';
      closeComposer();

      if (data?.id && typeof data.cooked === 'string') {
        const atEnd = state.endIdx >= state.stream.length - 1;
        state.stream.push(data.id);
        state.streamIndex.set(data.id, state.stream.length - 1);
        if (atEnd) {
          appendPosts([data]);
          state.endIdx = state.stream.length - 1;
          updateSentinels();
          state.scroll.scrollTop = state.scroll.scrollHeight;
        }
        updateTimelinePosition(state.currentIdx, state.stream.length);
        showToast('回复成功');
      } else {
        showToast('回复已提交，可能需要审核');
      }
    } catch (error) {
      state.composerError.textContent = error.message || '发送失败，请稍后重试';
    } finally {
      state.submittingReply = false;
      state.composerSend.disabled = false;
      state.composerSend.textContent = '发送';
    }
  }

  function openPanel(url, options = {}) {
    const normalizedUrl = normalizeTopicUrl(url);
    if (!normalizedUrl) return;
    const topicId = topicIdFromUrl(normalizedUrl);
    if (!topicId) return;
    ensurePanel();
    updatePanelTop();

    if (!state.open) {
      state.open = true;
      state.fullscreen = false;
      state.savedScrollY = window.scrollY;
      state.parentUrl = location.href;
      state.historyActive = !options.fromHistory;
      document.body.classList.add('ld-double-column-open');
      document.body.classList.remove('ld-double-column-fullscreen');
      if (!options.fromHistory) setPreviewHistory(normalizedUrl, false);
      startReadTracker();
      requestAnimationFrame(() => window.scrollTo(0, state.savedScrollY));
    } else if (!options.fromHistory && state.historyActive) {
      setPreviewHistory(normalizedUrl, true);
    }

    if (state.currentTopicId === topicId) {
      state.currentUrl = normalizedUrl;
      if (state.topicLoadFailed) {
        reloadCurrentTopic();
        return;
      }
      const floor = floorFromUrl(normalizedUrl);
      if (floor >= 1 && state.stream.length) {
        jumpToIndex(Math.min(floor - 1, state.stream.length - 1));
      }
      return;
    }

    flushReadTimings(state.currentTopicId);
    state.currentUrl = normalizedUrl;
    state.currentTopicId = topicId;
    loadTopic(topicId, normalizedUrl);
  }

  function closePanel() {
    if (!state.open) return;
    flushReadTimings(state.currentTopicId);
    stopReadTracker();
    unsubscribeLiveUpdates();
    closeLightbox();
    const shouldGoBack = state.historyActive && history.state?.ldDoubleColumn && !state.closeFromHistory;
    state.closeFromHistory = false;
    state.open = false;
    state.fullscreen = false;
    state.currentUrl = '';
    state.currentTopicId = '';
    setTopicLoadFailed(false);
    state.loadToken += 1;
    if (state.paginationFrame) cancelAnimationFrame(state.paginationFrame);
    state.paginationFrame = 0;
    state.postFilterToken += 1;
    state.postFilter = null;
    state.postFilterLoading = false;
    hidePostMenu();
    closeComposer();
    hideNotifMenu();
    document.body.classList.remove('ld-double-column-open', 'ld-double-column-fullscreen');
    state.panel.classList.remove('is-loading', 'has-timeline');
    setStatus('');
    state.title.textContent = '帖子预览';
    state.title.title = '帖子预览';
    requestAnimationFrame(() => window.scrollTo(0, state.savedScrollY));

    if (shouldGoBack) {
      state.historyActive = false;
      history.back();
    }
  }

  function ensureLightbox() {
    if (state.lightbox) return;
    const overlay = document.createElement('div');
    overlay.id = 'ld-preview-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', '图片预览');

    const stage = document.createElement('div');
    stage.className = 'ld-preview-lightbox-stage';

    const img = document.createElement('img');
    img.className = 'ld-preview-lightbox-image';
    img.alt = '';
    img.draggable = false;
    img.addEventListener('load', () => {
      positionLightboxAtStart();
    });
    img.addEventListener('pointerdown', handleLightboxPointerDown);
    img.addEventListener('pointermove', handleLightboxPointerMove);
    img.addEventListener('pointerup', finishLightboxDrag);
    img.addEventListener('pointercancel', finishLightboxDrag);
    stage.appendChild(img);

    const createLightboxButton = (className, label, title, handler) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ld-preview-lightbox-button ${className}`;
      button.textContent = label;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.addEventListener('click', handler);
      return button;
    };
    const prev = createLightboxButton(
      'ld-preview-lightbox-prev',
      '‹',
      '上一张（←）',
      () => showLightboxImage(state.lightboxIndex - 1),
    );
    const next = createLightboxButton(
      'ld-preview-lightbox-next',
      '›',
      '下一张（→）',
      () => showLightboxImage(state.lightboxIndex + 1),
    );
    const close = createLightboxButton(
      'ld-preview-lightbox-close',
      '×',
      '关闭图片预览（Esc）',
      closeLightbox,
    );
    const counter = document.createElement('div');
    counter.className = 'ld-preview-lightbox-counter';
    counter.setAttribute('aria-live', 'polite');

    overlay.append(stage, prev, next, counter, close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target === stage) closeLightbox();
    });
    overlay.addEventListener('wheel', handleLightboxWheel, { passive: false });
    document.body.appendChild(overlay);
    state.lightbox = overlay;
    state.lightboxStage = stage;
    state.lightboxImg = img;
    state.lightboxPrev = prev;
    state.lightboxNext = next;
    state.lightboxCounter = counter;
    state.lightboxClose = close;
  }

  function getLightboxSource(image) {
    const lightboxLink = image.closest('a.lightbox[href]');
    return lightboxLink?.href || image.currentSrc || image.src || '';
  }

  function collectLightboxImages(activeImage) {
    const images = Array.from(state.list?.querySelectorAll('.cooked img:not(.emoji)') || [])
      .filter((image) => {
        const link = image.closest('a');
        return image.getClientRects().length > 0 && (!link || link.classList.contains('lightbox'));
      })
      .map((image) => ({
        element: image,
        src: getLightboxSource(image),
        alt: image.alt || '',
      }))
      .filter((item) => item.src);
    const index = images.findIndex((item) => item.element === activeImage);
    if (index >= 0) return { images, index };
    const src = getLightboxSource(activeImage);
    return src
      ? { images: [{ element: activeImage, src, alt: activeImage.alt || '' }], index: 0 }
      : { images: [], index: -1 };
  }

  function updateLightboxControls() {
    const count = state.lightboxImages.length;
    const hasMultiple = count > 1;
    if (state.lightboxPrev) {
      state.lightboxPrev.hidden = !hasMultiple;
      state.lightboxPrev.disabled = state.lightboxIndex <= 0;
    }
    if (state.lightboxNext) {
      state.lightboxNext.hidden = !hasMultiple;
      state.lightboxNext.disabled = state.lightboxIndex >= count - 1;
    }
    if (state.lightboxCounter) {
      state.lightboxCounter.textContent = count
        ? `${state.lightboxIndex + 1} / ${count} · ${Math.round(state.lightboxScale * 100)}%`
        : '';
    }
  }

  function updateLightboxTransform() {
    if (!state.lightboxImg) return;
    state.lightboxImg.style.transform = `translate3d(${state.lightboxX}px, ${state.lightboxY}px, 0) scale(${state.lightboxScale})`;
    state.lightbox?.classList.toggle('is-zoomed', state.lightboxScale > state.lightboxFitScale + 0.001);
    state.lightbox?.classList.toggle('is-pannable', canPanLightbox());
    updateLightboxControls();
  }

  function canPanLightbox() {
    if (!state.lightboxImg || !state.lightboxStage) return false;
    const width = state.lightboxImg.offsetWidth * state.lightboxScale;
    const height = state.lightboxImg.offsetHeight * state.lightboxScale;
    return width > state.lightboxStage.clientWidth + 1
      || height > state.lightboxStage.clientHeight + 1;
  }

  function clampLightboxPan() {
    if (!state.lightboxImg || !state.lightboxStage) {
      state.lightboxX = 0;
      state.lightboxY = 0;
      return;
    }
    const maxX = Math.max(
      0,
      (state.lightboxImg.offsetWidth * state.lightboxScale - state.lightboxStage.clientWidth) / 2,
    );
    const maxY = Math.max(
      0,
      (state.lightboxImg.offsetHeight * state.lightboxScale - state.lightboxStage.clientHeight) / 2,
    );
    state.lightboxX = Math.max(-maxX, Math.min(maxX, state.lightboxX));
    state.lightboxY = Math.max(-maxY, Math.min(maxY, state.lightboxY));
  }

  function positionLightboxAtStart() {
    if (!state.lightboxImg || !state.lightboxStage) return;
    const naturalWidth = state.lightboxImg.naturalWidth || state.lightboxImg.offsetWidth;
    const naturalHeight = state.lightboxImg.naturalHeight || state.lightboxImg.offsetHeight;
    const stageWidth = state.lightboxStage.clientWidth;
    const stageHeight = state.lightboxStage.clientHeight;
    const fitScale = naturalWidth > 0 && naturalHeight > 0 && stageWidth > 0 && stageHeight > 0
      ? Math.min(1, stageWidth / naturalWidth, stageHeight / naturalHeight)
      : 1;
    state.lightboxFitScale = Math.max(0.01, fitScale);
    state.lightboxScale = state.lightboxFitScale;
    state.lightboxX = 0;
    state.lightboxY = 0;
    clampLightboxPan();
    updateLightboxTransform();
  }

  function resetLightboxTransform() {
    finishLightboxDrag();
    state.lightboxFitScale = 1;
    state.lightboxScale = 1;
    state.lightboxX = 0;
    state.lightboxY = 0;
    updateLightboxTransform();
  }

  function showLightboxImage(index) {
    if (index < 0 || index >= state.lightboxImages.length || !state.lightboxImg) return;
    state.lightboxIndex = index;
    resetLightboxTransform();
    const item = state.lightboxImages[index];
    state.lightboxImg.alt = item.alt;
    state.lightboxImg.src = item.src;
    updateLightboxControls();
    requestAnimationFrame(() => {
      if (state.lightboxIndex !== index) return;
      if (state.lightboxImg.complete) positionLightboxAtStart();
    });
  }

  function handleLightboxWheel(event) {
    if (!state.lightbox?.classList.contains('is-open') || !state.lightboxStage) return;
    event.preventDefault();
    const deltaMultiplier = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2 ? state.lightboxStage.clientHeight : 1;
    const factor = Math.exp(-event.deltaY * deltaMultiplier * 0.0015);
    const previousScale = state.lightboxScale;
    const nextScale = Math.min(
      LIGHTBOX_MAX_SCALE,
      Math.max(Math.min(LIGHTBOX_MIN_SCALE, state.lightboxFitScale), previousScale * factor),
    );
    if (Math.abs(nextScale - previousScale) < 0.001) return;

    const stageRect = state.lightboxStage.getBoundingClientRect();
    const cursorX = event.clientX - (stageRect.left + stageRect.width / 2);
    const cursorY = event.clientY - (stageRect.top + stageRect.height / 2);
    state.lightboxX = cursorX - (cursorX - state.lightboxX) * (nextScale / previousScale);
    state.lightboxY = cursorY - (cursorY - state.lightboxY) * (nextScale / previousScale);
    state.lightboxScale = nextScale;
    clampLightboxPan();
    updateLightboxTransform();
  }

  function handleLightboxPointerDown(event) {
    if (event.button !== 0 || !canPanLightbox()) return;
    event.preventDefault();
    event.stopPropagation();
    state.lightboxPointerId = event.pointerId;
    state.lightboxDragStartX = event.clientX;
    state.lightboxDragStartY = event.clientY;
    state.lightboxDragOriginX = state.lightboxX;
    state.lightboxDragOriginY = state.lightboxY;
    state.lightboxImg.setPointerCapture(event.pointerId);
    state.lightbox?.classList.add('is-dragging');
  }

  function handleLightboxPointerMove(event) {
    if (event.pointerId !== state.lightboxPointerId) return;
    event.preventDefault();
    state.lightboxX = state.lightboxDragOriginX + event.clientX - state.lightboxDragStartX;
    state.lightboxY = state.lightboxDragOriginY + event.clientY - state.lightboxDragStartY;
    clampLightboxPan();
    updateLightboxTransform();
  }

  function finishLightboxDrag(event) {
    if (state.lightboxPointerId == null) return;
    if (event && event.pointerId !== state.lightboxPointerId) return;
    if (state.lightboxImg?.hasPointerCapture(state.lightboxPointerId)) {
      state.lightboxImg.releasePointerCapture(state.lightboxPointerId);
    }
    state.lightboxPointerId = null;
    state.lightbox?.classList.remove('is-dragging');
  }

  function openLightbox(image) {
    if (!image) return;
    const collection = collectLightboxImages(image);
    if (!collection.images.length) return;
    ensureLightbox();
    state.lightboxImages = collection.images;
    state.lightboxReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    state.lightbox.classList.add('is-open');
    showLightboxImage(collection.index);
    state.lightboxClose.focus({ preventScroll: true });
  }

  function closeLightbox() {
    if (!state.lightbox) return;
    const returnFocus = state.lightboxReturnFocus;
    finishLightboxDrag();
    state.lightbox.classList.remove('is-open');
    state.lightbox.classList.remove('is-zoomed', 'is-pannable', 'is-dragging');
    state.lightboxImg.removeAttribute('src');
    state.lightboxImg.alt = '';
    state.lightboxImg.style.transform = '';
    state.lightboxImages = [];
    state.lightboxIndex = -1;
    state.lightboxFitScale = 1;
    state.lightboxScale = 1;
    state.lightboxX = 0;
    state.lightboxY = 0;
    state.lightboxReturnFocus = null;
    updateLightboxControls();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  function handlePanelClick(event) {
    if (isModifiedClick(event) || event.defaultPrevented) return;
    const rawTarget = event.target;
    if (!rawTarget || typeof rawTarget.closest !== 'function') return;
    const image = rawTarget.closest('.cooked img');
    if (image && !image.classList.contains('emoji')) {
      const imageLink = image.closest('a');
      if (!imageLink || imageLink.classList.contains('lightbox')) {
        event.preventDefault();
        event.stopPropagation();
        openLightbox(image);
        return;
      }
    }
    const link = rawTarget.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;

    event.preventDefault();
    const topicUrl = normalizeTopicUrl(link.href);
    if (topicUrl) openPanel(topicUrl);
    else window.open(link.href, '_blank', 'noopener,noreferrer');
  }

  function clearHoverPreload() {
    clearTimeout(state.hoverTimer);
    state.hoverTimer = 0;
    state.hoverLink = null;
  }

  function handleTopicPointerOver(event) {
    if (window.innerWidth <= MOBILE_BREAKPOINT) return;
    const rawTarget = event.target;
    const link = rawTarget && typeof rawTarget.closest === 'function'
      ? rawTarget.closest('a.title.raw-topic-link[href]')
      : null;
    if (!link || link === state.hoverLink) return;

    const topicUrl = normalizeTopicUrl(link.href);
    const topicId = topicUrl ? topicIdFromUrl(topicUrl) : '';
    if (!topicId) return;

    clearHoverPreload();
    state.hoverLink = link;
    state.hoverTimer = window.setTimeout(() => {
      state.hoverTimer = 0;
      state.hoverLink = null;
      if (hasFreshCache(topicId) || pendingFetches.size >= MAX_PREFETCH) return;
      fetchTopic(topicId).catch(() => {});
    }, HOVER_DELAY);
  }

  function handleTopicPointerOut(event) {
    if (!state.hoverTimer || !state.hoverLink) return;
    if (event.relatedTarget instanceof Node && state.hoverLink.contains(event.relatedTarget)) return;
    clearHoverPreload();
  }

  function handleTopicClick(event) {
    if (isModifiedClick(event) || event.defaultPrevented) return;
    clearHoverPreload();
    const rawTarget = event.target;
    const target = rawTarget && typeof rawTarget.closest === 'function'
      ? rawTarget.closest('a[href]')
      : null;
    if (!target || target.closest(`#${PANEL_ID}`)) return;
    if (!target.matches('a.title.raw-topic-link') && !target.closest('tr.topic-list-item')) return;

    const topicUrl = normalizeTopicUrl(target.href);
    if (!topicUrl) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    openPanel(topicUrl);
  }

  function handleHistoryChange() {
    const historyState = history.state;
    if (historyState?.ldDoubleColumn && historyState.ldPreviewUrl) {
      openPanel(historyState.ldPreviewUrl, { fromHistory: true });
      return;
    }

    if (state.open) {
      state.closeFromHistory = true;
      closePanel();
    }
  }

  function start() {
    addStyle();
    window.addEventListener('click', handleTopicClick, true);
    window.addEventListener('pointerover', handleTopicPointerOver, true);
    window.addEventListener('pointerout', handleTopicPointerOut, true);
    window.addEventListener('resize', () => {
      updatePanelTop();
      if (state.lightbox?.classList.contains('is-open')) {
        if (Math.abs(state.lightboxScale - state.lightboxFitScale) < 0.001) {
          positionLightboxAtStart();
        } else {
          clampLightboxPan();
          updateLightboxTransform();
        }
      }
    });
    window.addEventListener('popstate', handleHistoryChange);
    window.addEventListener('click', (event) => {
      if (!state.notifMenu || state.notifMenu.hidden) return;
      if (state.notifMenu.contains(event.target) || event.target === state.notifButton) return;
      hideNotifMenu();
    }, true);
    window.addEventListener('click', (event) => {
      if (!state.postMenu || state.postMenu.hidden) return;
      if (state.postMenu.contains(event.target) || event.target === state.postMenuButton) return;
      hidePostMenu();
    }, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushReadTimings();
    });
    window.addEventListener('pagehide', () => flushReadTimings());
    window.addEventListener('keydown', (event) => {
      if (state.lightbox?.classList.contains('is-open')) {
        if (event.key === 'Escape') closeLightbox();
        else if (event.key === 'ArrowLeft') showLightboxImage(state.lightboxIndex - 1);
        else if (event.key === 'ArrowRight') showLightboxImage(state.lightboxIndex + 1);
        else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Escape') return;
      if (!state.open) return;
      if (state.postMenu && !state.postMenu.hidden) hidePostMenu();
      else if (state.composer && !state.composer.hidden) closeComposer(false);
      else closePanel();
    });
    setWidth(state.width);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
