# 水果大战僵尸 · 四人联机版

物理合成消除 + 塔防：投放水果 → 同级碰撞合成 → 打穿僵尸与尸核。
支持 **最多 4 人同房联机**，跑在 GameHub 小游戏站（网页版）；打成微信小游戏包时联机入口自动隐藏，退化成与改造前一致的单机。

## 架构

```
├── audio                          // 音频（bgm / boom）
├── js
│   ├── cards
│   │   ├── cardBase.js            // 卡牌基类（虚函数 onApply / onEnterHand）
│   │   ├── cardSystem.js          // 卡牌系统：事件队列 + 简单工厂 + 注册表 + 联机投票
│   │   ├── clearHalfCard.js       // 卡牌：大丰收
│   │   ├── shrinkAllCard.js       // 卡牌：缩小术
│   │   ├── forceLevelCard.js      // 卡牌：橘子雨
│   │   ├── noCollideCard.js       // 卡牌：穿墙术
│   │   ├── randomForceCard.js     // 卡牌：混乱风暴
│   │   └── index.js               // 入口聚合 + 卡牌注册
│   ├── config
│   │   ├── balls.js               // 球体等级配置（名称/半径/颜色/得分/物理材质，热替换中心）
│   │   ├── cards.js               // 卡池配置（可抽到的卡牌 id + 抽取张数 + 触发阈值）
│   │   ├── stages.js              // 阶段顺序与目标分数
│   │   └── net.js                 // 联机参数：人数上限 / 快照频率 / 选卡截止 / 人数缩放
│   ├── core
│   │   ├── physics.js             // 自研二维圆形刚体物理引擎（刚体带 nid + owner）
│   │   ├── stateMachine.js        // 栈式状态机（大厅/房间/局内/结算，统一生命周期）
│   │   ├── adApi.js               // 激励视频广告封装（5 秒逗留判定）
│   │   ├── playerName.js          // 玩家昵称：排行榜主键 + 房间名牌
│   │   ├── leaderboard.js         // 排行榜（以昵称为主键，接真实对局分数）
│   │   └── utils.js               // 随机/存储/音效
│   ├── net                        // ← 联机层
│   │   ├── protocol.js            // 报文类型与实体位掩码（压到最短）
│   │   ├── roomClient.js          // 站点房间 SDK 封装 + 发送限流 + 心跳
│   │   ├── session.js             // 会话：名册 / 房主判定 / 收发分发（game.net）
│   │   ├── snapshot.js            // 快照编解码 + 客户端 lerp 插值缓冲
│   │   └── stageSync.js           // 局内同步控制器（主机权威、客机插值）
│   ├── states
│   │   ├── lobbyState.js          // 大厅
│   │   ├── roomState.js           // 联机房间：建房 / 加房 / 名册 / 开始
│   │   ├── fruitMergeState.js     // 第一阶段：水果合成
│   │   ├── fruitVsZombieState.js  // 第二阶段：水果大战僵尸
│   │   └── resultState.js         // 结算（压栈在局内之上，支持复活回跳）
│   ├── ui
│   │   ├── widgets.js             // 按钮 / Toast / 通用设置弹窗
│   │   ├── cardOverlay.js         // 三选一选卡浮层（含倒计时与各座位选择进度）
│   │   └── netHud.js              // 联机 HUD：他人投射口 + 队伍计分板
│   └── main.js                    // 入口：画布、主循环、触摸分发、联机会话
├── web                            // 网页版外壳（打包进 dist/fvz-mp.zip）
│   ├── index.html                 // 页面外壳 + 昵称输入浮层
│   ├── wx-shim.js                 // 把 wx.* 垫到浏览器 API 上
│   └── gamehub-room.js            // 站点房间 SDK 的本地兜底副本
├── tools                          // 构建与自检（不进包）
├── game.js                        // 主入口
├── game.json                      // 运行时配置
└── project.config.json            // 项目配置
```

## 联机方案

跑在 GameHub 小游戏站的房间服务上（`POST /api/v1/rooms` 建房、`/ws/rooms` 收发），
鉴权走同域 Cookie —— 游戏是在已登录站点的 `/g/{id}/v/{vid}/index.html` 里跑的，
**包里不含任何 Token**。

- **状态同步 + 主机权威**：点「开始游戏」的那个人固定当整局主机，只有他跑物理；
  其余人不跑物理，只把自己的投射口位置与投放请求上报，世界完全由快照重建。
- **lerp 插值**：主机按 `SNAPSHOT_HZ`（10Hz）广播水果 / 僵尸 / 投射口的位置，
  客机在 `INTERP_DELAY_MS` 的延迟窗口里对前后两帧插值，所以低频快照也不抖。
- **报文预算**：站点限流约 20 条/秒、单包 8KB。关键报文（开局、选卡、结算）排队必达，
  快照类超额即丢；快照过大时按距离丢弃次要刚体。
- **共享选卡**：达标后主机开牌并广播候选，**所有人同时暂停**；
  谁选了什么随快照捎带进度，全员选定或 `CARD_PICK_SECONDS`（5 秒）到点即收口，
  没选的人由主机随机代选，最后把**每个人选的卡都作用到同一个世界上**。
- **人数缩放**：目标分、玩家血量、尸核血量、出怪速度按人数放大（见 `js/config/net.js`）。
- **主机掉线**：房主离开则本局中止回房间，不会把其他人卡死在战场里。
- **排行榜**：以玩家自己输入的昵称为主键，结算时把全房间成绩一起并入榜单。

## 快速调参

- **改水果**：编辑 `js/config/balls.js` 的 `levels` 数组（名称/半径/颜色/得分），改 `physicsDefaults` 调手感。
- **加卡片**：在 `js/cards/` 新建继承 `Card` 的派生类（设置 name/desc/icon/color，实现 `onApply(ctx)` 虚函数），再到 `js/cards/index.js` 加一行 `registerCard('id', 类)`，并在 `js/config/cards.js` 的 `cardPool` 中加入该 id。效果通过 `ctx` 门面接口作用于局内，与局内 state 零耦合；联机时由主机对共享世界依次施放，天然全队生效。
- **接广告**：`js/core/adApi.js` 顶部 `AD_UNIT_ID` 填入真实广告位 ID 即可（未配置时走 mock 模拟弹窗）。
- **调联机手感**：`js/config/net.js` 里改快照频率、插值延迟、选卡截止秒数、人数缩放曲线。

## 构建与自检

```bash
node tools/build-web.mjs      # 打出 dist/fvz-mp.zip（网页版，上传用）
node tools/lint.mjs           # 静态自检：把 js/ 下所有模块 import 一遍
node tools/test-mp.mjs        # 协议层：4 端同步 / 限流 / 8KB 上限 / 选卡
node tools/test-stages.mjs    # 真 state 跑全流程：建房 → 两阶段 → 结算 → 复活
node tools/test-web.mjs       # 真浏览器 ×2 + 真 SDK + 本地房间服务，跑完整对局
node tools/probe-live-room.mjs <token>   # 核对线上房间服务的协议字段
node tools/test-live.mjs <token>         # 线上已发布版本的冒烟（含真建房）
```

`test-web.mjs` 会把截图留在 `dist/web-*.png`，`test-live.mjs` 留在 `dist/live-*.png`。

## 快速调参

- **改水果**：编辑 `js/config/balls.js` 的 `levels` 数组（名称/半径/颜色/得分），改 `physicsDefaults` 调手感。
- **加卡片**：在 `js/cards/` 新建继承 `Card` 的派生类（设置 name/desc/icon/color，实现 `onApply(ctx)` 虚函数），再到 `js/cards/index.js` 加一行 `registerCard('id', 类)`，并在 `js/config/cards.js` 的 `cardPool` 中加入该 id。效果通过 `ctx` 门面接口作用于局内，与 PlayingState 零耦合。
- **接广告**：`js/core/adApi.js` 顶部 `AD_UNIT_ID` 填入真实广告位 ID 即可（未配置时走 mock 模拟弹窗）。
- **接排行榜**：`js/core/leaderboard.js` 的 `fetchLeaderboard` 换成服务端请求。

## 玩法特性

- 联机：大厅「联机对战」→ 建房或从列表加入（最多 4 人）→ 房主开始；卡牌效果全队共享，血量与尸核为全队共用
- 每完成 `cardTriggerCount`（默认 10，可配置、可局内热更新）次合成触发三选一选卡（队列化，逐次弹出）；"合成抽卡进度 x/10"显示在分数圈下方
- 局内顶部进度条为分数进度 `score / stageScoreGoal`（默认 1000，见 `js/config/stages.js`，支持 `setStageScoreGoal` 热更新），条内几何中心显示"再得 x 分进入下一阶段"
- 卡片：大丰收（消除一半水果得分，最高等级除外）/ 缩小术（全场半径 -1/3）/ 橘子雨（接下来 5 个固定为橘子）/ 穿墙术（3 秒内水果互相穿透坠落）/ 混乱风暴（3 秒内每秒给所有水果施加随机力）
- 死亡结算：看广告复活（广告内逗留 ≥5 秒才生效），复活继承分数并清除一半水果（最高等级除外）
- 设置弹窗：局内退出回大厅；大厅中退出不响应；音效开关（关掉再开可恢复 BGM）

## 发布到 GameHub 小游戏站（网页版，联机走这条）

```bash
node tools/build-web.mjs
curl -X POST "http://<站点>/api/v1/projects/<game_id>/versions" \
  -H "Authorization: Bearer <token>" \
  -F "archive=@dist/fvz-mp.zip;type=application/zip" \
  -F "package_kind=zip" -F "label=v3" -F "entry_path=index.html" \
  -F "changelog=..."
```

上传即成为当前版本，游玩地址形如 `/g/{game_id}/v/{version_id}/index.html`；
`js/net/roomClient.js` 的 `detectGameId()` 就是从这个路径里拆出 `game_id` 的。
发完跑一遍 `node tools/test-live.mjs <token>` 冒烟。

## 部署到真机（微信小游戏；单机模式）

打成微信小游戏包时 `MatchSession.supported` 为 false，联机入口不显示，玩法与改造前一致。

### 0. 前提条件（最容易卡住的一步）

- **不能用测试号**：测试号只能本地预览，无法上传。需要到 [微信公众平台](https://mp.weixin.qq.com) 注册**小程序**账号，服务类目选 **游戏**（一级类目，注册后不可修改），拿到**正式 AppID**。
- 微信包不依赖任何服务器域名，音频为本地文件，无需配置 request 合法域名。

### 1. 绑定 AppID

开发者工具 → 右上角「详情」→「基本信息」→ 把 AppID 换成你的正式 AppID（也可直接改 `project.config.json` 的 `appid`）。改完重新编译，确认本地能正常玩。

### 2. 上传代码

开发者工具右上角「**上传**」→ 版本号（如 `1.0.0`）+ 项目备注 → 等待上传完成。
成功标志：MP 后台「管理 → 版本管理 → 开发版本」里出现该版本。

### 3. 设为体验版 + 加体验成员

1. MP 后台「管理 → 版本管理」→ 开发版本右侧「**选为体验版**」
2. 「管理 → 成员管理 → **体验成员**」→ 添加你和其他测试者的**微信号**
   （只有被添加的体验成员才能扫体验版二维码，最多 100 人）
3. 复制体验版二维码，用微信扫码即可在手机上玩

### 4. 真机调试（推荐）

开发者工具点「**真机调试**」→ 手机扫码 → 手机端运行时，电脑上的调试器会实时显示手机 Console 日志与报错，排查真机问题效率最高。

### 5. 正式发布需要额外准备的合规材料

体验版自测不受影响；要全网发布则按 2026 年现行规则需补齐：

| 材料 | 说明 |
|------|------|
| 软件著作权 | 必备，名称需与小程序名称一致，办理约 1~2 个月 |
| 游戏自审自查报告 | 微信模板填写，个人签字捺印 |
| 工信部 ICP 备案 | 后台「设置 → 小程序备案」，官方免费，约 3~4 周 |
| 防沉迷 / 适龄提示 | 强制接入（未成年人时长与宵禁限制） |
| 版号 | **纯广告变现的休闲游戏可免**；一旦有内购/虚拟支付则必须版号，且个人主体无法申请版号 |

上线前常见驳回点：截图缺「健康游戏忠告 + 适龄提示 + 游戏名称」、名称含英文或与软著不一致、功能隐瞒（如隐藏付费入口）。

### 6. 上线前自查清单

- [ ] 广告位：`js/core/adApi.js` 顶部 `AD_UNIT_ID` 填入真实激励视频广告位 ID（未配置时走 mock 弹窗）
- [ ] 排行榜：目前以昵称为主键存在本机；要做全服榜就把 `js/core/leaderboard.js` 的读写换成服务端接口
- [ ] 真机验证：首次加载、投放手感、合成音效、结算与复活全流程无报错
