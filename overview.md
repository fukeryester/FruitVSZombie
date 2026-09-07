# 项目总览（截至 2026-09-06）

微信小游戏"合成大西瓜 + 水果大战僵尸 + 水果大战怪蛇"三阶段玩法。

## 当前结构

### 关卡流程（线性，STAGE_IDS 单一声明）
```
大厅 → 水果合成（Lv.X 卡池 / 合成抽卡） → 水果大战僵尸（双线战场 / 击杀抽卡） → 水果大战怪蛇（500 节蜿蜒大蛇 / 砸破抽卡） → 结算
```
新增阶段：往 `STAGE_IDS` 追加 id + `main.js` 的 stageFactories 补工厂即可。

### 局内等级系统（Lv.X，**每阶段独立，分数共享**）
- `game.playerLevel` 挂在 Main 上；**每次进入新阶段 onEnter 会调 `g.resetPlayerLevel()` 把等级拉回 1**
- 分数仍跨阶段共享（fruitVsZombie / fruitVsSnake 构造时接收 carryScore 进入）
- `getCardTriggerCount(stageId, level)` 计算阈值：base + (level-1)*step
- 触发抽卡时 `playerLevel++` + 顶部 Lv.X 徽标弹动
- 三阶段阈值（`js/config/level.js`）：
  - 合成 `fruitMerge`：10 → 12 → 14 → …
  - 击杀 `fruitVsZombie`：18 → 20 → 22 → …
  - 砸节 `fruitVsSnake`：25 → 28 → 31 → …
- **未登记的 stageId 抛 throw**（早期 return Infinity 会让测试死循环）
- 作用：每个阶段 Lv.1 起手 → 雪球不跨阶段；上一阶段升级的等级不会再顺延
- 左上角 Lv.X 徽标（圆角胶囊 + 金色五角星 + 升级时弹大 + 外发光）
- 配置：`js/config/level.js`

### 第一阶段：水果合成（fruitMergeState）
- 750 设计基准合成大西瓜玩法
- 触底越线判负，分数达标切第二阶段
- 卡牌：multishot / split_fruit / freeze / sort_horizontal / destroy_small / bomb
- 调试包体在左下角有 ⏭ 跳段按钮（携带分数跳到下一阶段）
- 状态分数进度条 + 合成抽卡进度条 + "下一个" 预览 + 设置按钮 + Lv.X 徽标

### 第二阶段：水果大战僵尸（fruitVsZombieState）
- 双线战场：
  - 中隔墙把警戒线以下分成左右半区（左半 420 / 右半 330，arenaLeftRatio=0.56）
  - 右半：僵尸出怪区（更频繁更大批量更弱更慢 + 概率方阵）
  - 左半：3×3 神器格 + 12 段血墙（按行递增）+ 墙13 + 尸核舱 + 尸核（5000 血静态球）
- 水果规则：
  - 砸水平血墙 → 墙掉血 + 水果自毁
  - 砸**竖直墙**（隔板/中隔墙）→ **没有任何水果走自毁**：
    - 等级 ≥ 1（樱桃及以上）→ 分裂成 (level+1) 个等级 0 葡萄（noMerge=true）
    - 等级 0 葡萄 → 只"受到碰撞"被弹开，留在场上
  - 砸尸核 → 掉血 + 孵化小僵尸 + 水果自毁
  - 砸神器 → 得卡 + 神器与水果消失
- 僵尸规则：
  - 仅右半区生成，爬升净加速度 120 + 终端速度封顶 300 px/s
  - 出怪间隔 2.0s → 0.7s，每波 3 → 8 只
  - 等级 0 起步封顶 3，15% 概率方阵
  - 越线扣血，归零失败（可复活）
- 胜利：摧毁尸核（顶部进度条 + 百分比）
- 调试包体左下 ⏭ 跳到结算按钮
- UI：尸核血条 + 玩家血条 + 分数 + 击杀抽卡进度 + Lv.X 徽标

### 结算（resultState）
- 携带晋级分数显示 win/lose 文案
- 复活按钮（仅 lose 模式）、回到大厅按钮
- Lv.X 不显示（结算页不参与局内等级）
- **结算过程中等级不重置**（玩家回大厅后才会在下一阶段 onEnter 自动重置回 1）

### 第三阶段：水果大战怪蛇（fruitVsSnakeState）
- 数据结构：**双向链表**（~500 节"尸核"节点串联），节点不入 PhysicsWorld
  - 只在 `FruitVsSnakeState` 内部检测水果 vs 蛇节（绕过 O(n²)）
- 蛇节点几何（**每个节点都比等级 4 水果大**）：
  - `snakeNodeRadius = 160`（直径 320 = 屏宽 43%，比番茄 r=154 还略大，压迫感强）
  - `snakeSpacing = r × 1.5 = 240`（相邻节点重叠 25%，肉感）
  - 500 节 × 240 = 120000 px 弧长
- 蜿蜒曲线（**sine 平滑曲线**，8 个完整周期）：
  - 方向：t = s / totalLen，从 t=0（蛇头起步位置 = 屏幕底部中心）到 t=1（蛇头抵线 = 顶部阈值线）
  - `x(t) = W/2 + lerp(210, 105, t) × sin(2π × 8 × (1-t))` （r+amp=370，留 5px 不越屏）
- 移动：`snakeSpeed = 440 px/s` 单调推进 `snakeHeadS += speed × dt`（约 4.5 分钟通关）
  - freeze_snake 减半 6 秒
- 血量梯度：`lerp(5, 30, idx/499)`，蛇头 5-10 下、蛇尾 30+ 下
- **每个蛇节自带头下迷你血条 + 数字 "X/Y"**（满血不画数字，视觉清爽）
- 卡牌节点：每 15 节抽 1（共 ~33 个），从 `snakeCardPool` 抽，缤纷彩色 + 0.8Hz 脉冲
  - 卡牌节点血量 × `rand(1.5, 3)`
- 砸破节奏：
  - 任意节 hp ≤ 0 → 链表前后重连 → 反弹伤害 = `base × Math.min(8, idx+1) × (卡牌节×1.5)`
  - 卡牌节点首次破 → grantCard；后续破不再发卡
  - 玩家 HP=100：可承受 6 个普通节 / 4 个卡牌节，不会一击濒死
- 失败：蛇头到达阈值线 (`snakeHeadS >= snakeTotalLen`)
- 胜利：所有节被摧毁（**顶部进度条 + "🐍 剩余尸核 X/Y" + "Z%" 大字号**）
- 卡牌：复用僵尸阶段 7 张（clear_half / shrink_all / force_level / no_collide / random_force / split_fruit / multi_shot）+ 新卡 freeze_snake
- 调试包体左下 ⏭ "跳到结算"按钮
- UI：玩家血条 + 蛇进度条 + **剩余尸核 + 百分比醒目** + 顶部阈值线 + 卡牌节点彩虹 + Lv.X 徽标
- Toast：onEnter/onExit 调 `clearToasts()`（防止上一阶段"升级 / 砸墙"Toast 残留）
- 配置：`js/config/snake.js`

## 关键配置入口
| 文件 | 关键项 |
|------|--------|
| `js/config/level.js` | 等级系统（base/step/start） |
| `js/config/balls.js` | 水果表（11 级，名称/半径/颜色/得分） |
| `js/config/zombies.js` | 双线战场 + 出怪 + 伤害 + 墙血量 |
| `js/config/snake.js` | 蛇蜿蜒曲线 + 节距 + 血量梯度 + 速度 + 反伤 |
| `js/config/cards.js` | 卡池 + 触发阈值（已不主用）+ 阶段卡池导出 |
| `js/config/stages.js` | 阶段顺序 + 通关分 + 横幅 |
| `js/config/debug.js` | `isDebugBuild()` 调试包判定 |

## 文件结构
```
js/
├── main.js                       # Main 类：画布 / 主循环 / 状态机 / 触摸
├── cards/                        # CardSystem + 各派生卡（含 freeze_snake）
├── config/                       # 全是纯数据 + 热更新 setter（含 snake.js）
├── core/                         # stateMachine / physics / utils
├── states/                       # lobby / fruitMerge / fruitVsZombie / fruitVsSnake / result
└── ui/                           # ballRenderer（含 drawSnakeNode）+ widgets
```

## 测试
- `D:/Temp/UserTemp/suika-test/test.mjs`：mock wx/canvas，无头逻辑测试
- `D:/Temp/UserTemp/suika-test/sim*.mjs`：AI 对局模拟（手速 0.5s/投、瞄准/选卡策略）
- 当前 **325 断言 0 失败**，连跑 2 次稳定（[33] 蛇阶段 11 项 + [34] 蛇节尺寸+血量 13 项）
- 流程：[28] 线性关卡流程（3 阶段）/ [31] 拆分砸墙 / [32] 等级系统
       / [33] 蛇阶段（曲线采样 / 双向链表 / 卡牌节点 / 反伤封顶 / 复活）

## 测试副本同步提醒
- 测试目录 `D:/Temp/UserTemp/suika-test/js/` 是项目目录 `E:/wx-minigame/js/` 的独立副本
- 改了项目目录的 .js 文件后必须 `cp` 同步到测试目录，否则测试用的是过时的旧代码
- 同步只需要 `cp "E:/wx-minigame/js/..." "D:/Temp/UserTemp/suika-test/js/..."`（无测试专用 hack，可直接覆盖）