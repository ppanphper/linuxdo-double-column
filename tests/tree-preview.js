/* 仅用于本地浏览器回归：载入真实脚本，在内存中导出函数，不修改发布代码。 */
(async () => {
  'use strict';
  const source = await (await fetch('../linuxdo-double-column.user.js')).text();
  const startup = source.lastIndexOf("\n  if (document.readyState === 'loading')");
  if (startup < 0) throw new Error('未找到 userscript 启动入口');
  const script = document.createElement('script');
  script.textContent = `${source.slice(0, startup)}
    window.treeTestApi = { state, ensurePanel, renderTopic, renderTreeView, loadTreeReplies,
      focusTreeBranch, restoreTreeFocus, jumpToPostNumber, updateTreeLayout, setViewMode,
      captureTreePosition, renderFilteredView, checkPaginationThresholds, loadAfter };
  })();`;
  document.head.appendChild(script);
  const api = window.treeTestApi;
  const { state } = api;
  const $ = (selector) => document.querySelector(selector);
  const settle = async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  };
  let data = [], requests = [], delayedResponse = null;
  const names = ['青禾', '星河', '木木', '北辰'];
  function makePosts(branches = false) {
    const posts = Array.from({length:101}, (_,index) => {
      const number = index + 1;
      const parent = branches ? ({39:12,53:39,66:5,83:70,93:83})[number] || number - 1 : number - 1;
      const avatar = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="24" fill="${['#506c61','#5e6786','#807251','#785f70'][index % 4]}"/><text x="24" y="31" text-anchor="middle" font-size="21" fill="white">${names[index % 4][0]}</text></svg>`;
      return { id:1000+number, post_number:number, reply_to_post_number:parent || null,
        username:`member${index % 4}`, name:names[index % 4], user_title:index % 3===0?'社区成员':'',
        avatar_template:`data:image/svg+xml,${encodeURIComponent(avatar)}`, reply_count:0,
        created_at:'2026-10-01T10:00:00Z', actions_summary:[{id:2,count:index % 7}],
        cooked:`<p>这是 #${number} 楼，直接回复 #${parent}。${branches?'同一个父评论可以有多个子分支，子回复仍然可以继续嵌套。':'这是一个回复嵌套另一个回复的连续链条。即使来到第 100 层，正文也应该保持足够的阅读宽度。'}</p>` };
    });
    posts.forEach(post => {if(post.reply_to_post_number)posts[post.reply_to_post_number-1].reply_count++;});
    posts[0].cooked='<p>模拟主题：这里有完整的 100 层回复，所有楼层保留真实父子关系。</p>';
    posts[100].cooked='<p>已到第 100 层回复（#101）。这条回复的直接父帖是 #100，继续向上可追溯到主帖 #1。</p><p>正文没有随着这 100 层对话无限右移；点击“回复 #100”可以就地查看原话。</p>';
    return posts;
  }
  function entriesBelow(id) {
    const result=[];
    function visit(parent,level) {
      for(const child of data.filter(post=>post.reply_to_post_number===parent.post_number)) {
        result.push({id:child.id,level});visit(child,level+1);
      }
    }
    // Discourse 按 ID 返回索引，不能假设是深度优先顺序。
    visit(data.find(post=>post.id===id),1);return result.sort((a,b)=>a.id-b.id);
  }
  window.fetch = async (input, options={}) => {
    const url = new URL(input, location.href);
    requests.push(url.pathname+url.search);
    if (options.method && options.method !== 'GET') throw new Error('测试页禁止写操作');
    const override = delayedResponse?.(url, options);
    if (override) return override;
    const numberMatch = url.pathname.match(/\/posts\/by_number\/[^/]+\/(\d+)\.json$/);
    if(numberMatch){const post=data.find(item=>item.post_number===Number(numberMatch[1]));return Response.json(post||{},{status:post?200:404});}
    const branchMatch = url.pathname.match(/\/posts\/(\d+)\/reply-ids\.json$/);
    if(branchMatch)return Response.json(entriesBelow(Number(branchMatch[1])));
    const repliesMatch = url.pathname.match(/\/posts\/(\d+)\/replies\.json$/);
    if(repliesMatch){const parent=data.find(post=>post.id===Number(repliesMatch[1]));return Response.json(data.filter(post=>post.reply_to_post_number===parent.post_number&&post.post_number>Number(url.searchParams.get('after')||1)).sort((a,b)=>a.post_number-b.post_number).slice(0,20));}
    if(url.pathname.endsWith('/posts.json'))return Response.json({post_stream:{posts:data.filter(post=>url.searchParams.getAll('post_ids[]').includes(String(post.id)))}});
    throw new Error(`未模拟的 API: ${url.pathname}`);
  };
  api.ensurePanel();
  state.observer.disconnect();
  state.panel.style.cssText='position:relative;inset:auto;display:flex;width:600px;max-width:100%;height:680px;margin:20px auto;border:1px solid #4b5350;border-radius:12px;';
  $('#fixture').appendChild(state.panel);
  function initialize(branches=false, {all=true, count=101}={}) {
    data=makePosts(branches);requests=[];delayedResponse=null;state.loadToken++;
    state.currentTopicId='4321';state.currentUrl=`${location.origin}/t/test/4321`;state.viewMode='tree';state.treeSort='time';state.open=false;
    state.treeSortSelect.value='time';
    api.renderTopic({id:4321,title:branches?'正式脚本 · 分支里再分支':'正式脚本 · 100 层连续嵌套',post_stream:{posts:data.slice(0,count),stream:data.map(p=>p.id)}},state.currentUrl);
    if(all){state.treeExpanded=new Set(data.filter(p=>p.reply_count).map(p=>p.post_number));state.treeRepliesLoaded=new Set(data.map(p=>p.post_number));}
    api.renderTreeView({preserveScroll:false});state.scroll.scrollTop=0;
  }
  function article(number){return state.list.querySelector(`article[data-post-number="${number}"]`);}
  function node(number){return state.list.querySelector(`section[data-post-number="${number}"]`);}
  const assert=(condition,message)=>{if(!condition)throw new Error(message);};
  const visibleCount=()=>state.list.querySelectorAll('article.ld-preview-post').length;
  const width=async(value)=>{state.panel.style.width=`${value}px`;await settle();api.updateTreeLayout();};
  const noOverflow=()=>state.scroll.scrollWidth<=state.scroll.clientWidth+1;
  async function waitUntil(predicate) {
    for(let attempt=0;attempt<60;attempt++) {if(predicate())return;await settle();}
    throw new Error('等待异步渲染超时');
  }
  function initializeReplies(parents) {
    initialize(false,{all:false,count:2});
    data=data.slice(0,parents.length);
    data.forEach((post,index)=>{post.reply_to_post_number=parents[index];post.reply_count=0;});
    data.forEach(post=>{if(post.reply_to_post_number)data[post.reply_to_post_number-1].reply_count++;});
    state.stream=data.map(post=>post.id);state.streamIndex=new Map(state.stream.map((id,index)=>[id,index]));
    api.renderTreeView();
  }
  let running=false;
  async function runTests() {
    if(running)return;running=true;$('#run-tests').disabled=true;$('#test-results').replaceChildren();
    const results=[];
    async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message});}const li=document.createElement('li');li.textContent=`${results.at(-1).pass?'✓':'✗'} ${name}${results.at(-1).error?` — ${results.at(-1).error}`:''}`;$('#test-results').appendChild(li);}
    await test('100 层单链：101 楼完整显示，真实 DOM 父子结构不变',async()=>{
      initialize();await settle();assert(visibleCount()===101,'楼层缺失');assert(node(101).dataset.depth==='99','链条深度不正确');assert(node(101).parentElement.parentElement===node(100),'真实父子关系被压平');
    });
    await test('600px 面板最多 72px 缩进，第 100 层无横向溢出',async()=>{
      await width(600);assert(state.treeDepthLimit===3,'宽面板层级错误');assert(Math.abs(article(101).getBoundingClientRect().left-article(2).getBoundingClientRect().left-72)<1,'缩进未封顶');assert(noOverflow(),'横向溢出');
    });
    await test('380px 窄面板最多 48px 缩进，操作区可以换行',async()=>{
      await width(380);assert(state.treeDepthLimit===2,'窄面板层级错误');assert(Math.abs(article(101).getBoundingClientRect().left-article(2).getBoundingClientRect().left-48)<1,'窄面板位移错误');assert(noOverflow(),'窄面板横向溢出');
    });
    await test('父评论预览仅显示直接父帖；已有数据不重复请求',async()=>{
      const count=requests.length;article(101).querySelector('.ld-preview-reply-to').click();await settle();assert(article(101).querySelectorAll('.ld-preview-embedded-reply').length===1,'预览展示了多个祖先');assert(article(101).querySelector('.ld-preview-embedded-floor').textContent==='#100','父楼层错误');assert(requests.length===count,'重复请求已加载父帖');
    });
    await test('拖动宽度保留已打开的父帖预览',async()=>{
      const before=article(101);await width(600);assert(article(101)===before,'宽度变化重建了评论');assert(article(101).querySelector('.ld-preview-reply-to').getAttribute('aria-expanded')==='true','预览被关闭');
    });
    await test('深层节点仍可收起全部后代并重新展开',async()=>{
      article(50).querySelector('.ld-preview-tree-collapse').click();assert(visibleCount()===50,'收起未覆盖所有后代');assert(!article(51),'后代仍显示');article(50).querySelector('.ld-preview-tree-collapse').click();assert(visibleCount()===101,'展开丢失后代');
    });
    await test('多分叉：折叠 #40 不影响同级分支 #53',async()=>{
      initialize(true);assert(node(40).parentElement===node(53).parentElement,'兄弟分支挂载错误');assert(node(39).parentElement.parentElement===node(12),'嵌套父节点错误');article(40).querySelector('.ld-preview-tree-collapse').click();assert(!article(41)&&article(53),'折叠影响兄弟分支');
    });
    await test('热门排序只调整同级顺序，不改变回复关系',async()=>{
      data[52].actions_summary=[{id:2,count:100}];state.treeSort='hot';api.renderTreeView();const siblings=[...node(39).querySelector(':scope > .ld-preview-tree-children').children].filter(n=>n.matches('section'));assert(siblings[0].dataset.postNumber==='53','热门排序未生效');assert(node(53).parentElement.parentElement===node(39),'排序改变父节点');
    });
    await test('分支聚焦、再次聚焦、逐级返回保留展开状态和阅读锚点',async()=>{
      initialize(true);await api.jumpToPostNumber(39);const position=api.captureTreePosition();const expanded=[...state.treeExpanded].join(',');api.focusTreeBranch(data[38]);assert(visibleCount()===27,'聚焦混入无关楼层');assert(node(39).dataset.depth==='0','聚焦未重置视觉起点');api.focusTreeBranch(data[52]);assert(visibleCount()===13,'再次聚焦不正确');api.restoreTreeFocus();assert(state.treeFocusNumber===39,'没有返回上一级');api.restoreTreeFocus();assert(state.treeFocusNumber===0,'没有返回完整讨论');assert([...state.treeExpanded].join(',')===expanded,'展开状态未恢复');assert(Math.abs(api.captureTreePosition(position.anchorPostNumber).anchorTop-position.anchorTop)<2,'滚动锚点未恢复');
    });
    await test('聚焦时不会因滚动或加载按钮请求其他分支',async()=>{
      api.focusTreeBranch(data[38]);state.endIdx=19;state.open=true;requests=[];api.checkPaginationThresholds();await api.loadAfter();assert(state.sentinel.hidden,'主题分页入口未隐藏');assert(requests.length===0,'聚焦触发全主题分页');state.open=false;
    });
    await test('从聚焦分支定位父帖，保留返回路径',async()=>{
      await api.jumpToPostNumber(12);assert(state.treeFocusNumber===12&&article(12),'没有定位到正确父帖');api.restoreTreeFocus();assert(state.treeFocusNumber===39,'父帖跳转丢失返回路径');
    });
    await test('按需加载整条 100 层回复链并建立每层折叠关系',async()=>{
      initialize(false,{all:false,count:2});state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(visibleCount()===101,'按需加载后楼层缺失');assert(state.treeRepliesLoaded.has(101),'叶子加载状态错误');assert(state.treeReplyIds.get(100)[0]===1101,'直接回复索引错误');assert(requests.length===2,'分支加载请求数异常');assert(noOverflow(),'按需加载后宽度失控');
    });
    await test('按 ID 排序的分叉索引，直接回复数与真实父帖一致',async()=>{
      initializeReplies([null,1,2,2,3,4]);state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);
      assert(state.treeReplyIds.get(3).join(',')==='1005','把 #5 挂到错误父帖');assert(state.treeReplyIds.get(4).join(',')==='1006','把 #6 挂到错误父帖');assert(node(5).parentElement.parentElement===node(3),'#5 层级错误');assert(requests.length===2,'完整索引触发了多余请求');
    });
    await test('索引为空但有一条回复，备用接口补齐回复及后续对话',async()=>{
      initializeReplies([null,1,2,3]);delayedResponse=url=>url.pathname.endsWith('/reply-ids.json')?Response.json([]):null;
      state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(article(3)&&article(4),'备用回复未展开');assert(state.treeRepliesLoaded.has(2)&&state.treeRepliesLoaded.has(3),'加载状态不完整');assert(requests.some(path=>path==='/posts/1002/replies.json'),'未调用备用接口');
    });
    await test('索引为空时复用已加载子帖，不误报失败或重复请求',async()=>{
      initializeReplies([null,1,2]);state.allPosts.set(1003,data[2]);delayedResponse=()=>Response.json([]);
      state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(article(3),'本地回复没有展开');assert(requests.length===1,'重复请求本地已有回复');
    });
    await test('多重引用回复可在当前分支预览，保留原父帖并支持定位',async()=>{
      initializeReplies([null,1,1,3]);data[1].reply_count=1;state.allPosts.set(1003,data[2]);
      delayedResponse=url=>url.pathname==='/posts/1002/replies.json'?Response.json([data[3]]):null;
      state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);
      const preview=node(2).querySelector('.ld-preview-tree-references');assert(preview?.querySelector('.ld-preview-embedded-floor').textContent==='#4','引用回复未显示');assert(data[3].reply_to_post_number===3,'原父帖被改写');assert(state.treeRepliesLoaded.has(2),'引用回复被误判不可用');
      api.focusTreeBranch(data[1]);node(2).querySelector('.ld-preview-embedded-jump').click();await waitUntil(()=>Boolean(article(4)));assert(state.treeFocusNumber===4,'引用回复定位失败');
    });
    await test('部分索引遗漏引用回复时补齐并按 ID 去重',async()=>{
      initializeReplies([null,1,2,1]);data[1].reply_count=2;
      delayedResponse=url=>url.pathname==='/posts/1002/replies.json'?Response.json([data[2],data[3]]):null;
      state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(state.treeReplyIds.get(2).join(',')==='1003,1004','回复重复或遗漏');assert(node(2).querySelectorAll('.ld-preview-tree-references .ld-preview-embedded-reply').length===1,'引用预览重复');assert(node(3).parentElement.parentElement===node(2),'直接回复归属被改写');
    });
    await test('备用接口超过 20 条时分页加载，包含最后一条',async()=>{
      initializeReplies([null,1,...Array(25).fill(2)]);delayedResponse=url=>url.pathname.endsWith('/reply-ids.json')?Response.json([]):null;
      state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(state.treeReplyIds.get(2).length===25&&article(27),'备用接口只取了第一页');assert(requests.includes('/posts/1002/replies.json?after=22'),'分页没有使用最后楼层号');
    });
    await test('两个接口均为空时显示可见性提示；重试重新请求并恢复',async()=>{
      initializeReplies([null,1,2]);delayedResponse=()=>Response.json([]);
      state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(!state.treeRepliesLoaded.has(2),'空结果被标成完整');assert(node(2).textContent.includes('暂时没有可见回复'),'未提示可见性或计数延迟');
      delayedResponse=null;node(2).querySelector('.ld-preview-tree-retry').click();await waitUntil(()=>state.treeRepliesLoaded.has(2));assert(article(3),'重试未恢复');assert(requests.filter(path=>path==='/posts/1002/reply-ids.json').length===2,'重试复用了空索引');assert(!node(2).querySelector('.ld-preview-tree-retry'),'成功后重试提示未清理');
    });
    await test('部分回复不可见时仍展示可用回复，并保留重试入口',async()=>{
      initializeReplies([null,1,2]);data[1].reply_count=2;state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);
      assert(article(3),'部分不可见导致已知回复丢失');assert(node(2).textContent.includes('部分回复暂不可见')&&!state.treeRepliesLoaded.has(2),'部分结果被错误缓存为完整');
    });
    await test('备用接口网络失败后可重新请求，不保留失败索引',async()=>{
      initializeReplies([null,1,2]);delayedResponse=url=>Response.json([], {status:url.pathname.endsWith('/replies.json')?500:200});
      state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(!state.treeRepliesLoading.has(2)&&!state.treeRepliesLoaded.has(2),'失败状态未清理');assert(state.toast.textContent.includes('HTTP 500'),'没有显示请求失败');
      delayedResponse=null;state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(article(3),'失败后重试未恢复');assert(requests.filter(path=>path.endsWith('/reply-ids.json')).length===2,'失败索引没有重新请求');
    });
    await test('备用接口响应到达前切换话题，旧回复及状态不污染新话题',async()=>{
      initializeReplies([null,1,2]);let resolve;const pending=new Promise(r=>{resolve=r;});
      delayedResponse=url=>url.pathname.endsWith('/reply-ids.json')?Response.json([]):pending;
      state.treeExpanded.add(2);const loading=api.loadTreeReplies(data[1]);await waitUntil(()=>requests.includes('/posts/1002/replies.json'));const old=data[2];
      initializeReplies([null,1,2]);resolve(Response.json([old]));await loading;assert(!state.allPosts.has(old.id)&&!state.treeRepliesLoaded.has(2)&&!state.treeRepliesIncomplete.has(2),'旧话题数据或状态泄漏');
    });
    await test('父帖未加载时仅取直接父帖，点击定位准确返回',async()=>{
      initialize();state.allPosts.delete(1050);api.renderTreeView();article(51).querySelector('.ld-preview-reply-to').click();await waitUntil(()=>Boolean(article(51)?.querySelector('.ld-preview-embedded-reply')));assert(requests.some(path=>path.endsWith('/50.json')),'没有按需获取父帖');assert(article(51).querySelectorAll('.ld-preview-embedded-reply').length===1,'错误展开祖先链');await api.jumpToPostNumber(50);assert(article(50),'准确父帖未显示');
    });
    await test('父帖请求返回时已切换话题，旧响应不污染新话题',async()=>{
      initialize();state.allPosts.delete(1050);api.renderTreeView();let resolve;const pending=new Promise(r=>{resolve=r;});delayedResponse=()=>pending;article(51).querySelector('.ld-preview-reply-to').click();const old=data[49];initialize(true);state.allPosts.delete(1050);resolve(Response.json(old));await settle();assert(!state.allPosts.has(1050),'旧响应进入新话题');assert(!state.list.querySelector('.ld-preview-embedded-parents'),'旧预览进入新话题');
    });
    await test('分支加载期间收起，响应完成后不会自动重新展开',async()=>{
      initialize(false,{all:false,count:2});state.treeExpanded.add(2);let resolve;const pending=new Promise(r=>{resolve=r;});delayedResponse=()=>pending;const loading=api.loadTreeReplies(data[1]);state.treeExpanded.delete(2);const entries=entriesBelow(1002);delayedResponse=null;resolve(Response.json(entries));await loading;assert(state.allPosts.size===101,'分支数据未缓存');assert(!state.treeExpanded.has(2)&&visibleCount()===2,'用户收起状态被覆盖');
    });
    await test('加载失败可重试，不残留忙碌状态',async()=>{
      initialize(false,{all:false,count:2});state.treeExpanded.add(2);delayedResponse=async()=>Response.json({},{status:500});await api.loadTreeReplies(data[1]);assert(!state.treeExpanded.has(2)&&!state.treeRepliesLoading.has(2),'失败状态未清理');const toggle=article(2).querySelector('.ld-preview-tree-collapse');assert(!toggle.disabled,'不能重试');delayedResponse=null;state.treeExpanded.add(2);await api.loadTreeReplies(data[1]);assert(visibleCount()===101,'重试失败');
    });
    await test('不存在的父楼层给出反馈，不跳转到相邻楼层',async()=>{
      initialize();await api.jumpToPostNumber(50);const before=state.scroll.scrollTop;await api.jumpToPostNumber(999);assert(state.scroll.scrollTop===before,'错误跳到了相邻楼层');assert(state.toast.textContent.includes('暂不可用'),'没有显示失败反馈');
    });
    await test('原始视图、作者过滤、新话题切换不会残留分支导航',async()=>{
      initialize(true);api.focusTreeBranch(data[38]);await api.setViewMode('original',{persist:false});assert(state.treeFocusBar.hidden,'原始视图残留导航');assert(article(40).querySelector('header .ld-preview-reply-to'),'原始回复对象丢失');await api.setViewMode('tree',{persist:false});state.postFilter={username:'member0'};api.renderFilteredView();assert(state.treeFocusBar.hidden,'过滤视图残留导航');initialize();assert(state.treeFocusNumber===0&&state.treeFocusHistory.length===0&&state.treeFocusBar.hidden,'新话题残留聚焦');
    });
    const failures=results.filter(result=>!result.pass);
    $('#test-status').textContent=`${results.length-failures.length} / ${results.length} 项通过${failures.length?'，请展开记录查看失败原因':' · 当前展示真实脚本的第 100 层回复'}`;
    $('#test-status').dataset.failures=String(failures.length);
    window.treeTestResults=results;
    initialize();await width(600);await api.jumpToPostNumber(101);running=false;$('#run-tests').disabled=false;
  }
  $('#run-tests').addEventListener('click',runTests);
  $('#show-chain').addEventListener('click',async()=>{initialize();await api.jumpToPostNumber(101);});
  $('#show-branches').addEventListener('click',()=>{initialize(true);state.treeExpanded.delete(40);state.treeExpanded.delete(53);api.focusTreeBranch(data[38]);});
  $('#jump-last').addEventListener('click',()=>api.jumpToPostNumber(101));
  $('#test-width').addEventListener('change',event=>width(Number(event.target.value)));
  await runTests();
})().catch(error=>{document.querySelector('#test-status').textContent=`测试启动失败：${error.stack}`;});
