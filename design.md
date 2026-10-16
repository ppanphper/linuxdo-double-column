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
