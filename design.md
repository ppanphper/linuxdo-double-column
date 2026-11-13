# 搜索结果页双栏预览

## 目标与入口

在 `/search?q=…` 点击话题搜索结果标题时复用现有 JSON 预览面板，保留搜索条件与列表位置。脚本已有 `https://linux.do/*` 匹配，无需更改安装范围。

- 使用同一个链接识别函数处理点击及悬停预取，支持列表标题、列表内话题链接以及 `.search-container .fps-result a.search-link`。
- 继续使用全局事件代理，支持 Discourse 单页导航和动态追加结果。
- 只接管同源合法话题 URL；保留用户、分类、标签导航以及 Ctrl/Command/Shift/Alt/中键行为。
- 搜索容器、标题和输入框在面板打开时允许收缩和换行；关闭后恢复站点样式。

## 楼层与历史

- 明确指定的楼层优先于续读位置，包括 `/1`。先查本地帖子缓存，必要时通过既有按楼层接口取得帖子，原始视图按帖子 ID 查找 stream 下标，树状视图复用分支定位。
- 同话题初次加载或补载楼层期间点击其他结果，加载完成后以最后一次点击的 URL 定位。
- 首次打开压入一条预览历史，切换结果替换该记录；预览 hash 保留原 URL 的查询参数。
- 前进恢复面板时从 `ldPreviewBase` 恢复原搜索 URL，并保留关闭时后退的能力。
- 前插分页回复时以插入前的滚动位置计算补偿，避免与浏览器滚动锚定叠加。

## 验证依据

- 搜索结构来源：[Discourse 搜索结果组件](https://github.com/discourse/discourse/blob/main/frontend/discourse/app/components/search-result-entry.gjs)、[搜索页模板](https://github.com/discourse/discourse/blob/main/frontend/discourse/app/templates/full-page-search.gjs)、[搜索页样式](https://github.com/discourse/discourse/blob/main/app/assets/stylesheets/common/base/search.scss)。
- `tests/search-preview.html` 运行正式事件、历史和渲染逻辑；API 全部本地模拟，不修改线上数据。
- `tests/tree-preview.html` 保留原有深层回复回归。
- 当前内置浏览器访问 Linux.do 搜索页跳转登录页，线上登录态及站点定制主题尚需实际安装验证。

# 通知双栏预览

## 目标与入口

点击头像菜单或通知页 `/u/<用户名>/notifications` 中指向话题的通知时，在右侧预览面板打开并定位到通知楼层，保留当前页面。

- 两处都由 Discourse `MenuItem` 渲染为 `li.notification > a`；头像菜单的私信标签页为 `li.message > a`。选择器并入现有链接识别函数，点击和悬停预取共用。
- 只接管同源话题 URL。徽章、关注、群组收件箱等非话题通知，以及书签、审核项保持原生跳转。
- 编辑通知 `li.edited` 保持原生跳转：站点会在打开话题后弹出修订记录，预览面板不提供修订对比。
- 通知页的回复、提及等子页属于用户动态流，不在本次范围。

## 已读与菜单

- 站点在通知项冒泡阶段标记已读：更新本地状态，写入 `cn` cookie，下一次请求由服务端清除。随后 `wantsNewWindow` 发现默认行为已取消，跳过路由和关闭菜单。
- 因此通知链接只调用 `preventDefault`，不阻止事件传播；其他入口仍使用 `stopImmediatePropagation`。
- 头像菜单内的点击在事件结束后检测 `.user-menu.revamped`，菜单仍在时点击 `#toggle-current-user` 关闭。菜单关闭时线上不渲染 `aria-expanded`，不能作为判断依据。

## 验证依据

- 结构与行为来源：[MenuItem](https://github.com/discourse/discourse/blob/main/frontend/discourse/app/components/user-menu/menu-item.gjs)、[通知项点击](https://github.com/discourse/discourse/blob/main/frontend/discourse/app/lib/user-menu/notification-item.js)、[基础点击](https://github.com/discourse/discourse/blob/main/frontend/discourse/app/lib/user-menu/base-item.js)、[wantsNewWindow](https://github.com/discourse/discourse/blob/main/frontend/discourse/app/lib/intercept-click.js)、[服务端清除](https://github.com/discourse/discourse/blob/main/app/controllers/application_controller.rb)、[通知页模板](https://github.com/discourse/discourse/blob/main/frontend/discourse/app/templates/user/notifications-index.gjs)。
- 2026-11-13 只读核对 linux.do（Discourse 2026.11.0-latest）通知页：60 条通知均为 `li.notification > a` 且指向话题 URL；左栏 680px 时无可见溢出，424px 时个人资料头部按钮会被面板遮挡，属用户页原有布局。
- 头像菜单打开会把通知计为已查看，未在线上打开；菜单 DOM 依据源码及 `tests/notification-preview.html` 验证。
