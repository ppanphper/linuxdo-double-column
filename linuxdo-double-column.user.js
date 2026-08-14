// ==UserScript==
// @name         Linux.do 双栏阅读预览
// @namespace    https://linux.do/
// @version      0.9.1
// @description  在 Linux.do 话题列表中用右侧面板预览帖子（JSON API 直接渲染，支持回复/点赞/收藏/投票/复制链接/时间线快捷翻页/通知级别，阅读时长正常上报）
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
  const DEFAULT_WIDTH = 600;
  const MAX_WIDTH = 680;
  const MIN_WIDTH = 380;
  const MOBILE_BREAKPOINT = 780;
  const POSTS_PER_BATCH = 20;
  const CACHE_LIMIT = 30;
  const CACHE_TTL = 5 * 60 * 1000;
  const HOVER_DELAY = 80;
  const MAX_PREFETCH = 4;
  const LIKE_ACTION_ID = 2;
  const TIMINGS_TICK_MS = 1000;
  const TIMINGS_FLUSH_MS = 20000;
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
    lightboxImg: null,
    liveChannel: '',
    liveHandler: null,
    replyToNumber: null,
    submittingReply: false,
    currentUrl: '',
    currentTopicId: '',
    loadToken: 0,
    stream: [],
    streamIndex: new Map(),
    topicMeta: null,
    bookmarkIds: new Map(),
    startIdx: 0,
    endIdx: -1,
    currentIdx: 0,
    loadedIds: new Set(),
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
  const localLastRead = new Map();
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  let csrfToken = '';
  let toastTimer = 0;

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

  function fetchTopic(topicId, { force = false } = {}) {
    if (!force) {
      const entry = topicCache.get(topicId);
      if (entry && Date.now() - entry.time < CACHE_TTL) {
        topicCache.delete(topicId);
        topicCache.set(topicId, entry);
        return Promise.resolve(entry.data);
      }
      const pending = pendingFetches.get(topicId);
      if (pending) return pending;
    }

    const request = fetch(`/t/topic/${topicId}.json?include_suggested=false`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
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
      .finally(() => pendingFetches.delete(topicId));

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
        z-index: 2147483000;
        inset: 0 0 0 auto;
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
        padding: 14px 0 2px;
        border-bottom: 1px solid var(--primary-low, #e3e3e3);
      }

      #${PANEL_ID} .ld-preview-post-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      #${PANEL_ID} .ld-preview-avatar {
        width: 32px;
        height: 32px;
        flex: 0 0 32px;
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
        place-items: center;
        padding: 24px;
        background: rgba(0, 0, 0, 0.88);
        cursor: zoom-out;
      }

      #ld-preview-lightbox.is-open {
        display: grid;
      }

      #ld-preview-lightbox img {
        max-width: calc(100vw - 48px);
        max-height: calc(100vh - 48px);
        object-fit: contain;
        border-radius: 4px;
        box-shadow: 0 4px 30px rgba(0, 0, 0, 0.5);
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
        min-height: 32px;
        padding: 12px 0 24px;
        color: var(--primary-medium, #757575);
        font-size: 13px;
        text-align: center;
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

    const content = document.createElement('div');
    content.className = 'ld-preview-content';

    const scroll = document.createElement('div');
    scroll.className = 'ld-preview-scroll';
    scroll.addEventListener('click', handlePanelClick);

    const list = document.createElement('div');
    list.className = 'ld-preview-list';

    const sentinel = document.createElement('div');
    sentinel.className = 'ld-preview-sentinel';
    sentinel.hidden = true;

    const topSentinel = document.createElement('div');
    topSentinel.className = 'ld-preview-sentinel';
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

    const replyButton = createButton('✎', '回复主题', () => {
      if (state.currentTopicId) openComposer(null, '');
    });
    const originalButton = createButton('↗', '在原页面打开', () => {
      if (state.currentUrl) window.open(state.currentUrl, '_blank', 'noopener,noreferrer');
    });
    const refreshButton = createButton('↻', '刷新预览', () => {
      if (state.currentTopicId) loadTopic(state.currentTopicId, state.currentUrl, true);
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

    toolbar.append(heading, replyButton, originalButton, refreshButton, fullscreenButton, closeButton);
    scroll.append(topSentinel, list, sentinel, replyBar);
    content.append(scroll, timeline, status, toast);
    panel.append(resizer, toolbar, content, composer);
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
    state.status = status;
    state.toast = toast;
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

  function setStatus(message) {
    if (!state.status) return;
    state.status.textContent = message;
    state.status.hidden = !message;
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
      try {
        if (post.bookmarked) {
          const bookmarkId = post.bookmark_id || state.bookmarkIds.get(post.id);
          if (!bookmarkId) {
            showToast('该收藏需在原页面管理');
            return;
          }
          await apiRequest('DELETE', `/bookmarks/${bookmarkId}.json`);
          post.bookmarked = false;
          post.bookmark_id = null;
          state.bookmarkIds.delete(post.id);
          showToast('已取消收藏');
        } else {
          const data = await apiRequest('POST', '/bookmarks.json', {
            bookmarkable_id: post.id,
            bookmarkable_type: 'Post',
          });
          post.bookmarked = true;
          if (data?.id) {
            post.bookmark_id = data.id;
            state.bookmarkIds.set(post.id, data.id);
          }
          showToast('已收藏，可在「我的活动 - 书签」中查看');
        }
        sync();
      } catch (error) {
        showToast(error.message || '操作失败');
      } finally {
        busy = false;
      }
    });

    return button;
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

  function renderEmbeddedReply(reply) {
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

    const body = document.createElement('div');
    body.className = 'cooked';
    body.innerHTML = reply.cooked || '';

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'ld-preview-embedded-jump';
    jump.textContent = '↓ 跳到帖子';
    jump.addEventListener('click', () => jumpToPostNumber(reply.post_number));

    main.append(head, body, jump);
    item.append(avatar, main);
    return item;
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
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'ld-preview-embedded-collapse';
        collapse.textContent = '⌃';
        collapse.title = '收起回复';
        collapse.addEventListener('click', () => setExpanded(false));
        box.appendChild(collapse);
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

  function renderPost(post) {
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
    if (post.reply_to_post_number) {
      const replyToUser = post.reply_to_user;
      const replyTo = document.createElement('button');
      replyTo.type = 'button';
      replyTo.className = 'ld-preview-reply-to';
      replyTo.title = `回复了 #${post.reply_to_post_number}，点击跳转`;
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
      replyTo.addEventListener('click', () => jumpToPostNumber(post.reply_to_post_number));
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
    moreButton.title = '更多操作（在原页面打开）';
    moreButton.addEventListener('click', () => {
      window.open(`${location.origin}/t/topic/${state.currentTopicId}/${post.post_number}`, '_blank', 'noopener,noreferrer');
    });

    const replyButton = document.createElement('button');
    replyButton.type = 'button';
    replyButton.className = 'ld-preview-post-action';
    replyButton.textContent = '回复';
    replyButton.title = `回复 #${post.post_number}`;
    replyButton.addEventListener('click', () => openComposer(post.post_number, post.username || ''));

    if (post.reply_count > 0) footer.appendChild(createRepliesToggle(post, article));
    footer.append(createBookmarkButton(post), createLikeButton(post), copyButton, moreButton, replyButton);

    article.append(header, body, footer);
    enhancePolls(article, post);
    return article;
  }

  function appendPosts(posts) {
    const fragment = document.createDocumentFragment();
    for (const post of posts) {
      if (!post || state.loadedIds.has(post.id)) continue;
      state.loadedIds.add(post.id);
      fragment.appendChild(renderPost(post));
    }
    state.list.appendChild(fragment);
  }

  function prependPosts(posts) {
    const fragment = document.createDocumentFragment();
    for (const post of posts) {
      if (!post || state.loadedIds.has(post.id)) continue;
      state.loadedIds.add(post.id);
      fragment.appendChild(renderPost(post));
    }
    const previousHeight = state.scroll.scrollHeight;
    state.list.insertBefore(fragment, state.list.firstChild);
    state.scroll.scrollTop += state.scroll.scrollHeight - previousHeight;
  }

  function updateSentinels() {
    const total = state.stream.length;
    state.sentinel.hidden = state.endIdx >= total - 1;
    if (state.sentinel.hidden) state.sentinel.textContent = '';
    state.topSentinel.hidden = state.startIdx <= 0;
    if (state.topSentinel.hidden) state.topSentinel.textContent = '';
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
    for (const article of state.list.children) {
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
    if (state.timelineDragging || !state.stream.length) return;
    const viewTop = state.scroll.getBoundingClientRect().top;
    let currentIndex = state.currentIdx;
    for (const article of state.list.children) {
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

  async function fetchPostsByIds(topicId, ids) {
    const params = new URLSearchParams();
    for (const id of ids) params.append('post_ids[]', id);
    const response = await fetch(`/t/${topicId}/posts.json?${params}`, {
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
    state.loadingMore = false;
    state.loadingBefore = false;
    state.startIdx = 0;
    state.endIdx = posts.length - 1;
    state.currentIdx = 0;
    state.topicMeta = {
      createdAt: data.created_at || '',
      lastPostedAt: data.last_posted_at || '',
      highestPostNumber: data.highest_post_number || state.stream.length,
      ownerId: data.details?.created_by?.id || 0,
      lastReadPostNumber: Math.max(
        data.last_read_post_number || 0,
        localLastRead.get(String(state.currentTopicId)) || 0,
      ),
      notificationLevel: data.details?.notification_level ?? 1,
    };
    state.bookmarkIds = new Map((data.bookmarks || [])
      .filter((bookmark) => bookmark.bookmarkable_type === 'Post')
      .map((bookmark) => [bookmark.bookmarkable_id, bookmark.id]));
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
    updateTimelinePosition(0, state.stream.length);
    state.scroll.scrollTop = 0;
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
    const cached = !force && hasFreshCache(topicId);
    state.panel.classList.add('is-loading');
    state.title.textContent = '正在加载帖子...';
    state.title.title = topicUrl;
    if (!cached) setStatus('正在加载帖子...');

    try {
      const data = await fetchTopic(topicId, { force });
      if (token !== state.loadToken) return;
      state.panel.classList.remove('is-loading');
      setStatus('');
      renderTopic(data, topicUrl);
      const floor = floorFromUrl(topicUrl);
      if (floor > 1) {
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
      setStatus('加载失败，点击 ↻ 重试');
      state.title.textContent = '帖子预览';
      state.title.title = topicUrl;
    }
  }

  async function loadAfter() {
    if (state.loadingMore || !state.currentTopicId) return;
    const from = state.endIdx + 1;
    const ids = state.stream.slice(from, from + POSTS_PER_BATCH);
    if (!ids.length) return;

    const token = state.loadToken;
    state.loadingMore = true;
    state.sentinel.textContent = '正在加载更多回复...';

    try {
      const posts = await fetchPostsByIds(state.currentTopicId, ids);
      if (token !== state.loadToken) return;
      appendPosts(posts);
      state.endIdx = from + ids.length - 1;
      state.sentinel.textContent = '';
      updateSentinels();
    } catch {
      if (token === state.loadToken) state.sentinel.textContent = '加载更多失败，继续滚动重试';
    } finally {
      if (token === state.loadToken) state.loadingMore = false;
    }
  }

  async function loadBefore() {
    if (state.loadingBefore || !state.currentTopicId || state.startIdx <= 0) return;
    const start = Math.max(0, state.startIdx - POSTS_PER_BATCH);
    const ids = state.stream.slice(start, state.startIdx);
    if (!ids.length) return;

    const token = state.loadToken;
    state.loadingBefore = true;
    state.topSentinel.textContent = '正在加载之前的楼层...';

    try {
      const posts = await fetchPostsByIds(state.currentTopicId, ids);
      if (token !== state.loadToken) return;
      prependPosts(posts);
      state.startIdx = start;
      state.topSentinel.textContent = '';
      updateSentinels();
    } catch {
      if (token === state.loadToken) state.topSentinel.textContent = '加载失败，继续滚动重试';
    } finally {
      if (token === state.loadToken) state.loadingBefore = false;
    }
  }

  function tickReadTracker() {
    if (readTracker.disabled || !state.open || !state.currentTopicId) return;
    if (document.visibilityState !== 'visible') return;

    const viewRect = state.scroll.getBoundingClientRect();
    let sawVisible = false;
    let maxVisibleNumber = 0;
    let minVisibleNumber = Infinity;
    for (const article of state.list.children) {
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
        if (maxVisibleNumber > lastRead && minVisibleNumber <= lastRead + 3) {
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
    state.loadToken += 1;
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
    const img = document.createElement('img');
    img.alt = '';
    overlay.appendChild(img);
    overlay.addEventListener('click', closeLightbox);
    document.body.appendChild(overlay);
    state.lightbox = overlay;
    state.lightboxImg = img;
  }

  function openLightbox(src) {
    if (!src) return;
    ensureLightbox();
    state.lightboxImg.src = src;
    state.lightbox.classList.add('is-open');
  }

  function closeLightbox() {
    if (!state.lightbox) return;
    state.lightbox.classList.remove('is-open');
    state.lightboxImg.src = '';
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
        openLightbox(imageLink?.href || image.currentSrc || image.src);
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
    window.addEventListener('popstate', handleHistoryChange);
    window.addEventListener('click', (event) => {
      if (!state.notifMenu || state.notifMenu.hidden) return;
      if (state.notifMenu.contains(event.target) || event.target === state.notifButton) return;
      hideNotifMenu();
    }, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushReadTimings();
    });
    window.addEventListener('pagehide', () => flushReadTimings());
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (state.lightbox?.classList.contains('is-open')) {
        closeLightbox();
        return;
      }
      if (!state.open) return;
      if (state.composer && !state.composer.hidden) closeComposer(false);
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
