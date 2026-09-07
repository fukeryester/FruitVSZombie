/**
 * 游戏入口：画布初始化、主循环、触摸分发、全局上下文
 */
import { StateMachine } from './core/stateMachine.js';
import { AudioMgr, storage } from './core/utils.js';
import { updateToasts, renderToasts } from './ui/widgets.js';
import { applyPixelCtx } from './ui/pixel.js';
import { preloadSprites } from './ui/assets.js';
import LobbyState from './states/lobbyState.js';
import FruitMergeState from './states/fruitMergeState.js';
import FruitVsZombieState from './states/fruitVsZombieState.js';
import FruitVsSnakeState from './states/fruitVsSnakeState.js';
import ResultState from './states/resultState.js';
import { STAGE_IDS } from './config/stages.js';
import { playerLevelStart, resetPlayerLevel } from './config/level.js';

/**
 * 设计分辨率宽度
 * ------------------------------------------------------------------
 * 全部 UI（字号、卡牌宽高、弹窗尺寸、球半径、警戒线位置）都是按 **750 宽**
 * 的设计稿写死的（例：标题 76px、副标题 17 字 ≈476px、卡牌 min(230,(W-90)/3-10)、
 * 弹窗 min(560, W-80)）。此前逻辑画布宽度直接用 windowWidth（约 390），等于把
 * 整套 UI 放大约 2 倍，固定 px 的文字于是全部穿透容器。
 * 现在统一按 750 出设计稿，再等比缩放到真机屏幕。
 */
export const DESIGN_WIDTH = 750;

export default class Main {
  constructor() {
    // 画布
    this.canvas = wx.createCanvas();
    this.ctx = this.canvas.getContext('2d');
    // 新版基础库推荐 getWindowInfo；旧版回退 getSystemInfoSync
    const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync();
    const winW = info.windowWidth || info.screenWidth;
    const winH = info.windowHeight || info.screenHeight;
    const dpr = info.pixelRatio || 2;

    // 设计单位 → 设备 px 的缩放比（游戏内逻辑坐标统一使用设计单位）
    this.uiScale = winW / DESIGN_WIDTH;
    this.screenW = DESIGN_WIDTH;
    this.screenH = Math.round(winH / this.uiScale); // 保持真实宽高比，不拉伸
    this.pixelRatio = dpr;

    // 顶部安全区（刘海/灵动岛），换算成设计单位后供顶部 HUD 使用，取不到时兜底 20
    this.safeTop = ((info.safeArea && typeof info.safeArea.top === 'number')
      ? info.safeArea.top
      : 20) / this.uiScale;

    // 高分屏 + 设计稿缩放：设备像素 = 设计单位 × uiScale × dpr
    this.canvas.width = Math.round(winW * dpr);
    this.canvas.height = Math.round(winH * dpr);
    this.ctx.setTransform(dpr * this.uiScale, 0, 0, dpr * this.uiScale, 0, 0);
    applyPixelCtx(this.ctx);
    preloadSprites();

    // 全局
    this.audio = new AudioMgr();
    this.bestScore = storage.getBest();
    this.saveBest = () => storage.setBest(this.bestScore);

    // 局内"等级"：**每阶段独立**，每次进入新阶段时由 onEnter → resetPlayerLevel()
    // 重置回 playerLevelStart（1）。两个 state 只共享分数、不共享等级 —— 让玩家
    // 在每个阶段都从 Lv.1 起手，避免把第一阶段的成长雪球带到第二阶段。
    // 这里初始化的 playerLevel 主要是兜底（main.js 构造到首次 onEnter 之间的间隙）。
    this.playerLevel = playerLevelStart;
    this.resetPlayerLevel = () => { this.playerLevel = resetPlayerLevel(); };

    // 状态机 + 状态工厂（延迟创建，保证每次进入都是全新状态）
    this.states = new StateMachine(this);
    this.createLobbyState = () => new LobbyState(this);

    // ---- 线性关卡流程：大厅 → 水果合成 → 水果大战僵尸 → … →（最终关）结算 ----
    // 顺序唯一声明处在 config/stages.js 的 STAGE_IDS；这里只登记各阶段工厂。
    // 新增阶段：STAGE_IDS 追加 id + 此处补一个工厂即可，
    // 晋级 / 调试跳段 / 最终关进结算全部自动生效。
    const stageFactories = {
      // 第一阶段：水果合成（原 PlayingState，重命名以区分两个局内阶段）
      fruitMerge: () => new FruitMergeState(this),
      // 第二阶段：水果大战僵尸（携带前一阶段分数进入）
      fruitVsZombie: (carryScore) => new FruitVsZombieState(this, carryScore),
      // 第三阶段：水果大战怪蛇（500 节蜿蜒蛇 + 双向链表 + 卡牌节点）
      fruitVsSnake: (carryScore) => new FruitVsSnakeState(this, carryScore)
    };
    this.stageFlow = STAGE_IDS.map((id) => ({ id, create: stageFactories[id] }));
    this.createPlayingState = () => this.createStageState('fruitMerge'); // 大厅等处的旧别名

    /** 创建指定阶段的实例（不校验顺序，仅按 id 查工厂） */
    this.createStageState = (id, carryScore = 0) => {
      const s = this.stageFlow.find((it) => it.id === id);
      return s ? s.create(carryScore) : null;
    };
    /** 当前阶段是否还有后续阶段（false = 已是最终关，通关即结算） */
    this.hasNextStage = (id) => {
      const i = this.stageFlow.findIndex((it) => it.id === id);
      return i >= 0 && i + 1 < this.stageFlow.length;
    };
    /** 创建下一阶段实例；没有下一阶段时返回 null（调用方应转入结算） */
    this.createNextStageState = (currentId, carryScore = 0) => {
      const i = this.stageFlow.findIndex((it) => it.id === currentId);
      if (i < 0 || i + 1 >= this.stageFlow.length) return null;
      return this.stageFlow[i + 1].create(carryScore);
    };

    this.createResultState = (playing, opts) => new ResultState(this, playing, opts);

    this.states.switchTo(this.createLobbyState());

    // 触摸事件
    wx.onTouchStart((e) => {
      for (const t of e.touches) this.states.touchStart(this._toTouch(t));
    });
    wx.onTouchMove((e) => {
      for (const t of e.touches) this.states.touchMove(this._toTouch(t));
    });
    wx.onTouchEnd((e) => {
      for (const t of e.changedTouches) this.states.touchEnd(this._toTouch(t));
    });

    // 主循环
    this.lastTime = Date.now();
    this.loop = this.loop.bind(this);
    this._rafId = requestAnimationFrame(this.loop);
  }

  _toTouch(t) {
    // 兼容不同基础库的触摸字段：优先 x/y，回退 clientX/clientY，再回退 pageX/pageY
    const rx = t.x ?? t.clientX ?? t.pageX ?? 0;
    const ry = t.y ?? t.clientY ?? t.pageY ?? 0;
    // 触摸上报的是设备 px，换算回设计单位（与 screenW/screenH 同一坐标系）
    return { x: rx / this.uiScale, y: ry / this.uiScale, identifier: t.identifier };
  }

  loop() {
    const now = Date.now();
    const dt = Math.min(0.033, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // 异常保护：单帧出错只跳过该帧，绝不中断 rAF 链（否则画面永久冻结）
    try {
      applyPixelCtx(this.ctx);
      this.states.update(dt);
      this.states.render(this.ctx);
      updateToasts(dt);
      renderToasts(this.ctx, this.screenW, this.screenH);
    } catch (err) {
      console.error('[game loop]', err);
    }

    requestAnimationFrame(this.loop);
  }
}
