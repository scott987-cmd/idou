# 场景和风格之间的约定

一个**场景**（`scenarios/<id>/`）出结构：`index.html` 和 `site.js`。
一个**风格**（`styles/<id>.css`）出样子，别的什么都不出。

两边只靠下面这份类名清单相认。所以：

- **加一个风格**＝照着这份清单写一个 CSS 文件，五个场景立刻都能穿上它。
- **加一个场景**＝用这份清单里的类名写标签，三个风格立刻都认得它。

场景里不写颜色、字号、阴影和圆角；风格里不写 `display:none` 之外会改变结构含义的东西。
两边都不碰 `data-kind`、`.cell-chip`、`.cell-person` 的**含义**——那是 `Table.paint()` 按字段类型画出来的，风格只决定它们长什么样。

## 变量

每个风格必须在 `:root` 上给全这些，并在 `@media (prefers-color-scheme: dark)` 里给出暗色的一套
（深色起家的风格反过来做，但两套都要有）：

| 变量 | 是什么 |
| --- | --- |
| `--bg` | 页面底色。`body` 必须显式用它，不能透明 |
| `--paper` | 卡片、面板、表格的底色 |
| `--ink` | 正文颜色 |
| `--muted` | 次要文字：说明、表头、时间戳 |
| `--line` | 分隔线和描边 |
| `--accent` | 主色。整页只有一处该抢眼 |
| `--accent-soft` | 主色的浅底，用于标签和悬停 |
| `--shadow` | 卡片的投影，可以是 `none` |
| `--radius` | 圆角 |

## 骨架（每个场景都有）

`body > main.wrap > header.head`：`.eyebrow`（小标签）、`h1`、`.stamp`（右侧时间戳）。
页尾 `footer.foot`。`.sr-only` 只给读屏。`.empty` 是「没有匹配」的那行字。

## 部件

| 类名 | 出现在 | 是什么 |
| --- | --- | --- |
| `.panel` / `.panel-head` | 看板、名单 | 一块有底色的面板和它的头部 |
| `.search input` / `.count` | 看板、名单 | 搜索框和「N / M 条」 |
| `.facet` / `.facet-chip` | 看板、名单、进度、时间线 | 分类筛选条和它的标签，选中的是 `[aria-pressed="true"]` |
| `.tiles` / `.tile`（内含 `b` 和 `span`） | 看板 | 概览数字 |
| `.chart` / `.chart-title` / `.bar-row` / `.bar-label` / `.bar-track` / `.bar-fill` / `.bar-value` | 看板 | 按分类汇总的条形图，没有图表库 |
| `table` / `th .sort` / `th .arrow` / `td.num` / `td.blank` | 看板 | 明细表，表头可点排序 |
| `.cards` / `.card` / `.card dl` / `dt` / `dd` | 名单 | 卡片列表 |
| `.board` / `.column` / `.column-head` / `.column-count` / `.ticket` / `.ticket-title` / `.ticket-meta` | 进度 | 按状态分列的看板 |
| `.timeline` / `.period` / `.period-label` / `.event` / `.event-when` / `.event-body` / `.event-title` | 时间线 | 一条线和线上的事件 |
| `.hero` / `.hero-text` / `.hero-figure` / `.features` / `.feature` / `.cta` | 介绍页 | 主视觉、卖点、行动按钮 |
| `.cell-chip` / `.cell-person` / `[data-kind="link"] a` | 所有接表格的场景 | 单选多选画成标签、人员画成名字、链接画成链接 |

## 两条硬规矩

- **静止时就该是完整的**。可以有入场动画，但起点必须是看得见的状态，不能停在 `opacity:0` 等着谁来触发——分享出去的第一屏和缩略图都只有这一帧。
- **`prefers-reduced-motion: reduce` 时把动画关掉**。「立体」那一套尤其。
