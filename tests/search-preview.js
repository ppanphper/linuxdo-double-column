/* 本地集成回归：使用正式启动入口、事件代理、样式、历史及渲染流程。 */
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
  let requests = [], delayTopic = '', releaseTopic = null, failTopic = '', delayBatch = '', releaseBatch = null;
  const nativeClicks = [];
  function postsFor(id) {
    return Array.from({ length:60 }, (_, i) => ({
      id:Number(id) * 1000 + i + 1, post_number:i < 2 ? i + 1 : i + 2,
      topic_id:Number(id), username:'local_test', name:'本地测试用户',
      avatar_template:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="48" height="48"%3E%3Crect width="48" height="48" rx="24" fill="%23dce8e1"/%3E%3C/svg%3E', created_at:'2026-10-01T10:00:00Z', reply_count:0,
      reply_to_post_number:null, actions_summary:[],
      cooked:`<p>这是话题 ${id} 的第 ${i < 2 ? i + 1 : i + 2} 楼。</p><p>搜索结果点击后在右侧显示对应内容，左侧保留搜索条件和结果。</p>`,
    }));
  }
  window.fetch = async (input, options = {}) => {
    const url = new URL(input, location.href);
    requests.push({ path:url.pathname + url.search, headers:options.headers || {} });
    if (options.method && options.method !== 'GET') throw new Error('测试页禁止写操作');
    const topic = url.pathname.match(/^\/t\/(\d+)\.json$/);
    if (topic) {
      const id = topic[1];
      if (id === delayTopic) await new Promise(resolve => { releaseTopic = resolve; });
      if (id === failTopic) return Response.json({}, { status:500 });
      const posts = postsFor(id);
      return Response.json({ id:Number(id), title:`搜索预览 · 话题 ${id}`, highest_post_number:61,
        last_read_post_number:12, post_stream:{ posts:posts.slice(0,20), stream:posts.map(post => post.id) } });
    }
    const batch = url.pathname.match(/^\/t\/(\d+)\/posts\.json$/);
    if (batch) {
      if (batch[1] === delayBatch) { delayBatch = ''; await new Promise(resolve => { releaseBatch = resolve; }); }
      return Response.json({ post_stream:{ posts:postsFor(batch[1]).filter(post => url.searchParams.getAll('post_ids[]').includes(String(post.id))) } });
    }
    const numbered = url.pathname.match(/^\/posts\/by_number\/(\d+)\/(\d+)\.json$/);
    if (numbered) {
      const post = postsFor(numbered[1]).find(item => item.post_number === Number(numbered[2]));
      return Response.json(post || {}, { status:post ? 200 : 404 });
    }
    throw new Error(`未模拟的 API: ${url.pathname}`);
  };
  const script = document.createElement('script');
  script.textContent = source.slice(0, startup)
    + '\n  window.searchTestApi = { state, closePanel, setViewMode, clearHoverPreload };\n'
    + source.slice(startup);
  document.head.appendChild(script);
  const { state, closePanel, setViewMode, clearHoverPreload } = window.searchTestApi;
  // 未接管的链接阻止实际离开测试页，记录是否仍可到达站点处理器。
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link) { nativeClicks.push(link.id); event.preventDefault(); }
  });
  const click = (selector, options = {}) => $(selector).dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, button:0, ...options }));
  const hover = selector => $(selector).dispatchEvent(new PointerEvent('pointerover', { bubbles:true }));
  const article = number => state.list?.querySelector(`article[data-post-number="${number}"]`);
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
    const base = new URL(location.href); base.hash = ''; base.search = '?q=双栏预览%20in:all&expanded=true';
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
    await test('搜索标题悬停预取，且不记录话题浏览', async () => {
      requests = []; hover('#first-result mark'); await wait(120);
      if (innerWidth > 780) {
        assert(requests.some(r => r.path.startsWith('/t/100.json')), '没有预取');
        assert(requests.every(r => !r.headers['Discourse-Track-View']), '预取错误记录浏览');
      } else assert(requests.length === 0, '移动端不应悬停预取');
    });
    await test('标题内高亮文本可打开预览，明确 /1 不被续读位置覆盖', async () => {
      state.viewMode = 'original'; click('#first-result mark'); await loaded(100);
      assert(state.open && state.currentPostNumber === 1, '未显示首帖');
      assert(!nativeClicks.includes('first-result'), '点击继续传播到站点');
      assert(state.parentUrl === originalUrl && location.search === new URL(originalUrl).search, '搜索条件丢失');
      assert(history.state.fixture && history.state.ldDoubleColumn, '历史状态没有保留');
    });
    await test('同一话题切换命中回复，跳过已删除楼层仍准确定位', async () => {
      const length = history.length; click('#reply-result'); await until(() => state.currentPostNumber === 4);
      assert(history.length === length, '切换结果堆积历史记录');
      assert(article(4) && state.currentUrl.endsWith('/4'), '命中楼层不正确');
    });
    await test('后退关闭并还原搜索 URL，前进恢复命中回复', async () => {
      history.back(); await until(() => !state.open);
      assert(location.href === originalUrl, '后退没有还原搜索 URL');
      history.forward(); await until(() => state.open); await loaded(100);
      await until(() => state.currentPostNumber === 4);
    });
    await test('关闭按钮保留搜索词、筛选条件及列表滚动位置', async () => {
      await close(); window.scrollTo(0,150); await settle(); const scroll = window.scrollY;
      click('#first-result'); await loaded(100); await close();
      assert(location.href === originalUrl && Math.abs(window.scrollY - scroll) < 2, '关闭没有恢复搜索页状态');
    });
    await test('树状视图可打开首批数据之外的搜索命中回复', async () => {
      state.viewMode = 'tree'; click('#deep-result'); await loaded(200);
      await until(() => Boolean(article(35)));
      assert(requests.some(r => r.path === '/posts/by_number/200/35.json'), '没有按楼层补取命中回复');
    });
    await test('原始视图按实际帖子 ID 定位远端楼层', async () => {
      await setViewMode('original', { persist:false }); click('#deep-result');
      await until(() => state.currentPostNumber === 35); assert(article(35), '命中回复未渲染');
    });
    await test('用户、分类、标签、搜索区外链接保留原生导航', async () => {
      for (const id of ['user-link','category-link','tag-link','outside-search','legacy-user']) {
        click(`#${id}`); assert(nativeClicks.includes(id), `${id} 被错误拦截`);
      }
      assert(state.currentTopicId === '200', '普通链接切换了预览');
    });
    await test('搜索结果中的站外话题链接不被接管', async () => {
      const link = $('#reply-result'), href = link.getAttribute('href'), before = nativeClicks.length;
      link.href = 'https://example.com/t/search-demo/100/4'; click('#reply-result'); link.setAttribute('href', href);
      assert(nativeClicks.length === before + 1 && state.currentTopicId === '200', '站外链接被接管');
    });
    await test('修饰键与中键保留浏览器默认行为', async () => {
      for (const options of [{ ctrlKey:true }, { metaKey:true }, { shiftKey:true }, { altKey:true }, { button:1 }]) {
        const before = nativeClicks.length; click('#first-result', options);
        assert(nativeClicks.length === before + 1 && state.currentTopicId === '200', '修饰键被拦截');
      }
    });
    await test('动态追加的搜索结果无需重新绑定事件', async () => {
      const entry = document.createElement('div'); entry.className = 'fps-result';
      entry.innerHTML = '<div class="fps-topic"><a id="dynamic-result" class="search-link" href="/t/search-demo/400/4">动态结果</a></div>';
      $('.fps-result-entries').appendChild(entry); click('#dynamic-result'); await loaded(400);
      await until(() => state.currentPostNumber === 4); entry.remove();
    });
    await test('搜索结果加载期间再次点击同话题，以最后一次命中楼层为准', async () => {
      delayTopic = '500'; releaseTopic = null; const link = $('#reply-result'), href = link.getAttribute('href');
      link.href = '/t/search-demo/500/4'; click('#reply-result'); await until(() => Boolean(releaseTopic));
      link.href = '/t/search-demo/500/35'; click('#reply-result'); releaseTopic(); delayTopic = '';
      await loaded(500); await until(() => state.currentPostNumber === 35); link.setAttribute('href', href);
    });
    await test('加载失败后再次点击搜索标题可以重试', async () => {
      const link = $('#reply-result'), href = link.getAttribute('href'); failTopic = '600'; link.href = '/t/search-demo/600/4';
      click('#reply-result'); await until(() => state.topicLoadFailed); failTopic = '';
      click('#reply-result'); await loaded(600); await until(() => state.currentPostNumber === 4); link.setAttribute('href', href);
    });
    await test('补载命中楼层期间改点同话题其他结果，最终定位最新结果', async () => {
      const link = $('#reply-result'), href = link.getAttribute('href'); delayBatch = '600'; releaseBatch = null;
      link.href = '/t/search-demo/600/50'; click('#reply-result'); await until(() => Boolean(releaseBatch));
      link.href = '/t/search-demo/600/4'; click('#reply-result'); releaseBatch();
      await until(() => state.currentPostNumber === 4 && !state.panel.classList.contains('is-loading')); link.setAttribute('href', href);
    });
    await test('命中楼层已删除时显示提示，保留当前阅读位置', async () => {
      const link = $('#reply-result'), href = link.getAttribute('href'); const before = state.scroll.scrollTop;
      link.href = '/t/search-demo/600/3'; click('#reply-result');
      await until(() => state.toast.textContent.includes('原楼层暂不可用'));
      assert(Math.abs(state.scroll.scrollTop - before) < 2, '不可用楼层错误跳转到相邻回复'); link.setAttribute('href', href);
    });
    await test('原话题列表标题及回复链接保持可用', async () => {
      click('#legacy-title'); await loaded(300); await until(() => state.currentPostNumber === 13);
      click('#legacy-reply'); await until(() => state.currentPostNumber === 4);
    });
    await test('双栏收窄后长搜索标题无横向溢出，关闭恢复布局', async () => {
      await close(); state.viewMode = 'original'; click('#first-result'); await loaded(100); await settle();
      const wrapper = $('#main-outlet-wrapper'), topic = $('#deep-result').closest('.fps-topic');
      assert(topic.scrollWidth <= topic.clientWidth + 1, '长标题撑破搜索结果');
      if (innerWidth > 780) assert(wrapper.getBoundingClientRect().right <= state.panel.getBoundingClientRect().left + 1, '左右栏重叠');
      else assert(getComputedStyle($('#main-outlet')).visibility === 'hidden', '移动端列表未隐藏');
      await close(); assert(!document.body.classList.contains('ld-double-column-open'), '关闭后残留双栏样式');
    });
    const failures = results.filter(result => !result.pass);
    $('#test-status').textContent = `${results.length - failures.length} / ${results.length} 项通过`;
    $('#test-status').dataset.failures = String(failures.length);
    clearHoverPreload(); state.viewMode = 'original'; click('#first-result'); await loaded(100);
    window.scrollTo(0,0); await settle();
    window.searchTestResults = results; running = false; $('#run-tests').disabled = false;
  }
  $('#run-tests').addEventListener('click', runTests);
  await runTests();
})().catch(error => { document.querySelector('#test-status').textContent = `测试启动失败：${error.stack}`; });
