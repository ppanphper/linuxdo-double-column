/* 本地集成回归：使用正式启动入口，模拟 Discourse 通知菜单与通知页的原生点击处理。 */
(async () => {
  'use strict';
  const source = await (await fetch('../linuxdo-double-column.user.js')).text();
  const startup = source.lastIndexOf("\n  if (document.readyState === 'loading')");
  if (startup < 0) throw new Error('未找到 userscript 启动入口');
  const $ = selector => document.querySelector(selector);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate) {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await wait(20); }
    throw new Error('等待异步状态超时');
  }
  const settle = async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  let requests = [];
  const markedRead = [], routed = [], docClicks = [], readIds = new Set();
  function postsFor(id) {
    return Array.from({ length:60 }, (_, i) => ({
      id:Number(id) * 1000 + i + 1, post_number:i < 2 ? i + 1 : i + 2,
      topic_id:Number(id), username:'local_test', name:'本地测试用户',
      avatar_template:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Crect width="48" height="48" rx="24" fill="%23dce8e1"/%3E%3C/svg%3E', created_at:'2026-10-01T10:00:00Z', reply_count:0,
      reply_to_post_number:null, actions_summary:[],
      cooked:`<p>这是话题 ${id} 的第 ${i < 2 ? i + 1 : i + 2} 楼。</p><p>通知点击后在右侧显示对应内容，左侧保留当前页面。</p>`,
    }));
  }
  window.fetch = async (input, options = {}) => {
    const url = new URL(input, location.href);
    requests.push({ path:url.pathname + url.search, headers:options.headers || {} });
    if (options.method && options.method !== 'GET') throw new Error('测试页禁止写操作');
    const topic = url.pathname.match(/^\/t\/(\d+)\.json$/);
    if (topic) {
      const posts = postsFor(topic[1]);
      return Response.json({ id:Number(topic[1]), title:`通知预览 · 话题 ${topic[1]}`, highest_post_number:61,
        last_read_post_number:12, post_stream:{ posts:posts.slice(0,20), stream:posts.map(post => post.id) } });
    }
    const batch = url.pathname.match(/^\/t\/(\d+)\/posts\.json$/);
    if (batch) {
      return Response.json({ post_stream:{ posts:postsFor(batch[1]).filter(post => url.searchParams.getAll('post_ids[]').includes(String(post.id))) } });
    }
    const numbered = url.pathname.match(/^\/posts\/by_number\/(\d+)\/(\d+)\.json$/);
    if (numbered) {
      const post = postsFor(numbered[1]).find(item => item.post_number === Number(numbered[2]));
      return Response.json(post || {}, { status:post ? 200 : 404 });
    }
    throw new Error(`未模拟的 API: ${url.pathname}`);
  };

  // 与 discourse/lib/intercept-click 的 wantsNewWindow 保持一致：默认行为已取消时不路由。
  const wantsNewWindow = event => event.defaultPrevented || event.shiftKey || event.metaKey || event.ctrlKey
    || (event.button && event.button !== 0);
  // 对应 lib/user-menu/notification-item.js 与 base-item.js 的 onClick。
  function bindNativeItem(link, { inMenu }) {
    link.addEventListener('click', event => {
      const item = link.parentElement;
      if (item.classList.contains('notification') && !readIds.has(link.id)) {
        readIds.add(link.id); markedRead.push(link.id); item.classList.replace('unread', 'read');
      }
      if (wantsNewWindow(event)) return;
      event.preventDefault();
      if (inMenu) setMenuOpen(false);
      routed.push(link.id);
    });
  }
  const MENU_TABS = {
    'all-notifications': [
      ['menu-reply', 'notification unread replied', '/t/notify-demo/100/4', '青', '回复了你的帖子'],
      ['menu-like', 'notification read liked', '/t/notify-demo/100/5', '星', '赞了你的帖子'],
      ['menu-edited', 'notification unread edited', '/t/notify-demo/100/2', '木', '编辑了你的帖子'],
      ['menu-badge', 'notification unread granted-badge', '/badges/1/basic?username=test', '', '获得徽章'],
      ['menu-group', 'notification unread group-message-summary', '/u/test/messages/group/staff', '', '群组收件箱有新消息'],
    ],
    messages: [['menu-message', 'message unread', '/t/notify-demo/200/35', '水', '私信 · 首批之外的未读楼层']],
    bookmarks: [
      // bookmarkable_url 为完整 URL。
      ['menu-bookmark', 'bookmark', `${location.origin}/t/notify-demo/500/9`, '', '楼层书签'],
      ['menu-chat-bookmark', 'bookmark', '/chat/c/general/1/123', '', '聊天消息书签'],
    ],
    review: [['menu-review', 'reviewable pending', '/review/1', '', '待审核']],
  };
  let menuOpen = false, menuTab = 'all-notifications', toggleClicks = 0;
  function renderMenu() {
    const slot = $('#user-menu-slot'), toggle = $('#toggle-current-user');
    // 与线上一致：菜单关闭时不渲染 aria-expanded。
    if (menuOpen) toggle.setAttribute('aria-expanded', 'true'); else toggle.removeAttribute('aria-expanded');
    $('#current-user').classList.toggle('active', menuOpen);
    slot.replaceChildren();
    if (!menuOpen) return;
    const menu = document.createElement('div');
    menu.className = 'user-menu revamped menu-panel drop-down';
    menu.dataset.tabId = menuTab;
    menu.innerHTML = `<div class="panel-body"><div class="panel-body-contents">
      <div class="menu-tabs-container">${Object.keys(MENU_TABS).map(tab => `<button type="button" data-tab="${tab}">${tab}</button>`).join('')}</div>
      <div class="quick-access-panel" id="quick-access-${menuTab}"><ul class="user-menu-button-${menuTab}"></ul></div>
    </div></div>`;
    const list = menu.querySelector('ul');
    for (const [id, className, href, label, description] of MENU_TABS[menuTab]) {
      const item = document.createElement('li');
      item.className = readIds.has(id) ? className.replace('unread', 'read') : className;
      item.innerHTML = `<a id="${id}" href="${href}"><span>•</span><div>${label ? `<span class="item-label">${label}</span>` : ''}<span class="item-description">${description}</span></div></a>`;
      bindNativeItem(item.firstElementChild, { inMenu:true });
      list.appendChild(item);
    }
    menu.querySelector('.menu-tabs-container').addEventListener('click', event => {
      const tab = event.target.closest('button')?.dataset.tab;
      if (tab) { menuTab = tab; renderMenu(); }
    });
    slot.appendChild(menu);
  }
  // Glimmer 在 autorun 中重新渲染，菜单 DOM 在事件处理结束后才移除。
  function setMenuOpen(open) { menuOpen = open; queueMicrotask(renderMenu); }
  $('#toggle-current-user').addEventListener('click', event => {
    toggleClicks++;
    if (wantsNewWindow(event)) return;
    event.preventDefault(); setMenuOpen(!menuOpen);
  });
  document.querySelectorAll('.user-notifications-list li > a').forEach(link => bindNativeItem(link, { inMenu:false }));

  const script = document.createElement('script');
  script.textContent = source.slice(0, startup)
    + '\n  window.notificationTestApi = { state, closePanel, clearHoverPreload };\n'
    + source.slice(startup);
  document.head.appendChild(script);
  const { state, closePanel, clearHoverPreload } = window.notificationTestApi;
  // 记录事件是否仍传播到站点的文档级处理器，并阻止测试页实际离开。
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link) { docClicks.push({ id:link.id, prevented:event.defaultPrevented }); event.preventDefault(); }
  });
  const click = (selector, options = {}) => $(selector).dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, button:0, ...options }));
  const hover = selector => $(selector).dispatchEvent(new PointerEvent('pointerover', { bubbles:true }));
  const article = number => state.list?.querySelector(`article[data-post-number="${number}"]`);
  async function openMenu(tab = 'all-notifications') {
    menuTab = tab;
    if (menuOpen) renderMenu(); else $('#toggle-current-user').click();
    await until(() => Boolean($(`#quick-access-${tab}`)));
  }
  async function closeMenu() {
    if (menuOpen) $('#toggle-current-user').click();
    await until(() => !$('.user-menu'));
  }
  async function loaded(id) {
    await until(() => state.currentTopicId === String(id) && !state.panel.classList.contains('is-loading') && !state.topicLoadFailed);
    await settle();
  }
  async function close() {
    if (state.open) closePanel();
    await until(() => !history.state?.ldDoubleColumn);
    await settle();
  }
  let running = false;
  async function runTests() {
    if (running) return;
    running = true; $('#run-tests').disabled = true; $('#test-results').replaceChildren();
    if (state.open) await close();
    await closeMenu();
    const base = new URL(location.href); base.hash = ''; base.search = '?filter=all';
    history.replaceState({ fixture:true }, '', base.href);
    const originalUrl = location.href;
    const results = [];
    async function test(name, fn) {
      try { await fn(); results.push({ name, pass:true }); }
      catch (error) { results.push({ name, pass:false, error:`${error.message}（话题 ${state.currentTopicId}，楼层 ${state.currentPostNumber}，加载 ${state.panel?.classList.contains('is-loading')}，目标 ${state.currentUrl}）` }); }
      const result = results.at(-1), li = document.createElement('li');
      li.textContent = `${result.pass ? '✓' : '✗'} ${name}${result.error ? ` — ${result.error}` : ''}`;
      $('#test-results').appendChild(li);
    }
    await test('悬停通知项预取话题，且不记录话题浏览', async () => {
      await openMenu(); requests = []; hover('#menu-reply .item-description'); await wait(120);
      if (innerWidth > 780) {
        assert(requests.some(r => r.path.startsWith('/t/100.json')), '没有预取');
        assert(requests.every(r => !r.headers['Discourse-Track-View']), '预取错误记录浏览');
      } else assert(requests.length === 0, '移动端不应悬停预取');
      clearHoverPreload();
    });
    await test('点击未读回复通知：预览定位楼层，站点仍标记已读且不跳转', async () => {
      state.viewMode = 'original'; click('#menu-reply');
      assert(markedRead.includes('menu-reply'), '站点没有标记已读');
      assert(!routed.includes('menu-reply'), '站点仍执行了路由跳转');
      assert(docClicks.at(-1)?.id === 'menu-reply' && docClicks.at(-1).prevented, '点击未继续传播或默认行为未取消');
      assert(menuOpen, '菜单在站点处理点击前被关闭');
      await loaded(100); await until(() => state.currentPostNumber === 4);
      assert(state.parentUrl === originalUrl && history.state.fixture && history.state.ldDoubleColumn, '原页面 URL 或历史状态丢失');
    });
    await test('站点处理完点击后关闭头像菜单', async () => {
      await until(() => !$('.user-menu'));
      assert(!$('#current-user').classList.contains('active'), '菜单开关状态未复位');
    });
    await test('面板打开时切换到私信标签页，替换预览记录并加载首批之外的楼层', async () => {
      const length = history.length; await openMenu('messages'); click('#menu-message');
      await loaded(200); await until(() => state.currentPostNumber === 35 && Boolean(article(35)));
      assert(history.length === length, '切换通知堆积历史记录');
      assert(!routed.includes('menu-message'), '私信项仍执行了路由跳转');
      await until(() => !$('.user-menu'));
    });
    await test('重新打开菜单后点击已读通知，同话题内切换楼层', async () => {
      await openMenu(); assert($('#menu-reply').parentElement.classList.contains('read'), '已读状态未保留');
      click('#menu-like'); await loaded(100); await until(() => state.currentPostNumber === 5);
      await until(() => !$('.user-menu'));
    });
    await test('通知页列表项打开预览并标记已读，不触发菜单开关', async () => {
      const toggles = toggleClicks; click('#page-mention'); await loaded(300); await until(() => state.currentPostNumber === 4);
      assert(markedRead.includes('page-mention') && !routed.includes('page-mention'), '通知页项状态不正确');
      await wait(30); assert(toggleClicks === toggles, '通知页点击误触菜单开关');
    });
    await test('未带楼层号的话题通知按续读位置打开', async () => {
      click('#page-first-post'); await loaded(400); await until(() => state.currentPostNumber === 13);
    });
    await test('后退关闭预览并还原通知页 URL', async () => {
      history.back(); await until(() => !state.open);
      assert(location.href === originalUrl, '后退没有还原通知页 URL');
    });
    await test('书签标签页按楼层打开预览并关闭菜单', async () => {
      await openMenu('bookmarks'); click('#menu-bookmark');
      assert(!routed.includes('menu-bookmark'), '书签项仍执行了路由跳转');
      await loaded(500); await until(() => state.currentPostNumber === 9);
      await until(() => !$('.user-menu')); await close();
    });
    await test('非话题通知、编辑通知、聊天书签与审核项保持原生跳转', async () => {
      for (const [tab, id] of [['all-notifications','menu-edited'], ['all-notifications','menu-badge'], ['all-notifications','menu-group'], ['bookmarks','menu-chat-bookmark'], ['review','menu-review']]) {
        await openMenu(tab); click(`#${id}`);
        assert(routed.includes(id), `${id} 被错误拦截`); await until(() => !$('.user-menu'));
      }
      for (const id of ['page-edited', 'page-follow', 'nav-summary']) {
        click(`#${id}`); assert(id === 'nav-summary' || routed.includes(id), `${id} 被错误拦截`);
      }
      assert(!state.open, '原生跳转的通知打开了预览');
    });
    await test('修饰键与中键保留站点和浏览器默认行为', async () => {
      await openMenu();
      for (const options of [{ ctrlKey:true }, { metaKey:true }, { shiftKey:true }, { altKey:true }, { button:1 }]) {
        click('#menu-reply', options); assert(!state.open, '修饰键被拦截');
        if (!menuOpen) await openMenu();
      }
      await closeMenu();
    });
    await test('通知中的站外话题链接不被接管', async () => {
      await openMenu(); const link = $('#menu-like'); link.href = 'https://example.com/t/notify-demo/100/5';
      click('#menu-like'); assert(routed.at(-1) === 'menu-like' && !state.open, '站外链接被接管');
      await until(() => !$('.user-menu'));
    });
    await test('双栏收窄后通知页无横向溢出，关闭恢复布局', async () => {
      click('#page-mention'); await loaded(300); await settle();
      const wrapper = $('#main-outlet-wrapper'), content = $('.user-content');
      assert(content.scrollWidth <= content.clientWidth + 1, '通知列表撑破左栏');
      if (innerWidth > 780) assert(wrapper.getBoundingClientRect().right <= state.panel.getBoundingClientRect().left + 1, '左右栏重叠');
      else assert(getComputedStyle($('#main-outlet')).visibility === 'hidden', '移动端列表未隐藏');
      await close(); assert(!document.body.classList.contains('ld-double-column-open'), '关闭后残留双栏样式');
    });
    const failures = results.filter(result => !result.pass);
    $('#test-status').textContent = `${results.length - failures.length} / ${results.length} 项通过`;
    $('#test-status').dataset.failures = String(failures.length);
    clearHoverPreload(); state.viewMode = 'original';
    await openMenu(); click('#menu-reply'); await loaded(100); await openMenu();
    window.scrollTo(0,0); await settle();
    window.notificationTestResults = results; running = false; $('#run-tests').disabled = false;
  }
  $('#run-tests').addEventListener('click', runTests);
  await runTests();
})().catch(error => { document.querySelector('#test-status').textContent = `测试启动失败：${error.stack}`; });
