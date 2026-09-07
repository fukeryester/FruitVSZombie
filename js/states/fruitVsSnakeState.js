/**
 * 第三阶段局内状态（FruitVsSnakeState / 水果大战怪蛇）
 * ------------------------------------------------------------------
 * 玩法：
 *   - 整条蛇由 300 个"尸核"节组成（双向链表），沿一条 sine 曲线蜿蜒上升，
 *     8 个完整周期（= 8 个弯）。蛇身总弧长 = 300 × 节距 = 72000 px。
 *   - 蛇头从屏幕底部出发，沿曲线向顶部阈值线推进。
 *   - 玩家从上方投放水果，水果砸蛇节扣血（按 fruitWallDamageMul 计算伤害）。
 *     蛇节 hp ≤ 0 → 砸破：解链表 + 抽卡进度 +1 + 卡牌节点首次
 *     砸破还会调用 grantCard 送卡（缤纷色蛇节是"卡牌节点"）。
 *   - **没有反伤机制**：玩家唯一失败条件是"任意活蛇节越过阈值线"。
 *     设计意图：玩家专注于砸节节奏，不必兼顾"扣血管理"——
 *     反伤频繁让游戏变成"既要砸又要扣血"的双线负担，去掉后节奏更纯粹。
 *   - 蛇节**不入 PhysicsWorld**（避免 300² = 9 万对/帧的 O(n²) 爆炸）；
 *     物理世界只装水果 + 地面 + 左右墙；蛇 vs 水果的碰撞用独立的
 *     _checkSnakeHits() 循环（O(n_fruit × n_alive_nodes)，可控）。
 *   - 蛇节之间也不互相物理挤压 —— 蛇身是"沿曲线均匀分布"的视觉对象，
 *     双向链表只用来表示"前后拼接"语义。
 *   - 胜利条件：整条蛇 300 节都被砸破（snakeAliveCount === 0）；
 *     失败条件：任意蛇节越过阈值线。
 *
 * 与第二阶段的差异：
 *   - 没有僵尸/尸核/神器/墙体；只有蛇 + 水果。
 *   - 卡池改为 snakeCardPool（8 张，复用 zombieCardPool 大半 + 第一阶段全部）；
 *     ctx 不暴露 freezeZombies 而是 freezeSnake（语义对应 freeze_snake 卡）。
 *
 * 共享元素：
 *   - Lv.X 徽标系统、settings 弹窗、广告按钮、调试跳段按钮、
 *     killCount 抽卡进度、卡牌系统 ctx 门面、AudioMgr。
 */
import { BaseState } from '../core/stateMachine.js';
import { PhysicsWorld, Body } from '../core/physics.js';
import { Button, SettingsModal, showToast, clearToasts } from '../ui/widgets.js';
import { CardSystem } from '../cards/index.js';
import { levels, physicsDefaults } from '../config/balls.js';
import { snakeCardPool } from '../config/cards.js';
import { getCardTriggerCount } from '../config/level.js';
import {
  drawBall,
  drawSnakeNode,
  drawSnakeConnection
} from '../ui/ballRenderer.js';
import { applyPixelCtx, drawPixelBurst } from '../ui/pixel.js';
import { THEME, drawStageBg, drawWarnLine, drawDropGuide, drawScoreChip, drawNextChip, drawLevelBadge, drawCardProgress, drawTopBar, drawBanner } from '../ui/hud.js';
import { clamp } from '../core/utils.js';
import {
  snakeWarnY,
  snakeNodeRadius,
  snakeSpacing,
  snakeNodeCount,
  snakeTotalLen,
  snakeWaveCount,
  snakeAmpBottom,
  snakeAmpTaper,
  snakeStartYOffset,
  snakeHeadStartS,
  snakeSpeed,
  snakeHpHead,
  snakeHpTail,
  snakeCardHpMulMin,
  snakeCardHpMulMax,
  snakeCardEvery,
  snakeWarnDistance,
  snakePathAt,
  cardNodeIndices
} from '../config/snake.js';
import {
  fruitWallDamageMul,
  fruitMaxLevelStart,
  fruitMaxLevelCap,
  fruitGrowEvery,
  fruitBiasEvery,
  timedWeightedLevelIndex,
  splitChargesPerCard,
  splitRadiusFactor,
  maxShotSlots,
  minSurviveRadius
} from '../config/zombies.js';
import { FINAL_CLEAR_DELAY } from '../config/stages.js';
import { isDebugBuild } from '../config/debug.js';

/** 首个水果的投放延迟（给玩家一点准备时间） */
const FIRST_DROP_DELAY = 0.6;
/** 投放口 y 坐标 */
const DROP_Y = 212;
/** force_level 卡：接下来固定投放 dropCount 个橘子 */
const FORCE_LEVEL_DROP_COUNT = 5;
const FORCE_LEVEL_INDEX = 2; // 橘子

export default class FruitVsSnakeState extends BaseState {
  /** 线性关卡流程中的阶段 id（main.stageFlow 按此定位下一阶段） */
  get stageId() { return 'fruitVsSnake'; }

  /**
   * @param {object} game
   * @param {number} carryScore 从第二阶段继承的分数（计入总分/最佳分）
   */
  constructor(game, carryScore = 0) {
    super(game);
    this.carryScore = carryScore;
  }

  onEnter() {
    // 防御性清 Toast：跨阶段时若上一阶段的 Toast 还挂着，未清理的"升级提示"
    // 会持续显示在屏幕上 → 进新阶段前清掉，保持各阶段画面独立干净
    clearToasts();
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;

    // 等级每阶段独立：每进入新阶段 → Lv.1（与分数共享不同）
    g.resetPlayerLevel();
    // 分数：继承第二阶段作为基数（跨阶段共享累计总分）
    this.baseScore = this.carryScore;
    this.score = this.carryScore;
    this.dead = false;

    // 物理世界（只装水果；蛇节不入 bodies，自己维护位置）
    this.floorY = H - 20;
    this.warnY = snakeWarnY;
    this.world = new PhysicsWorld(
      { left: 0, right: W, top: 0, bottom: this.floorY },
      (a, b) => this._handleMerge(a, b),
      null,  // 没有 fruit-vs-fruit contact（合成已由 onMerge 处理）
      null   // 没有墙体
    );

    // 蜿蜒蛇：双向链表 + sine 曲线采样
    // snakeHeadS 从 0（蛇头起步位置 = 屏幕底部中心）向 snakeTotalLen 推进；
    // 失败判定改为 onUpdate 里遍历所有活节点 y ≤ warnY → _onSnakeNodeCrossed
    // （蛇头只是会最先越线的节，不是唯一判定）。
    this.snakeHeadS = snakeHeadStartS;
    this.snakeSpeedCur = snakeSpeed;   // 受 freeze_snake 影响
    this.snakeFreezeLeft = 0;          // freeze_snake 剩余秒数
    this.snakeNodes = [];              // 300 个 SnakeNode
    this.snakeAliveCount = snakeNodeCount;
    this.snakeWarnFlash = 0;           // 蛇头接近阈值线的屏幕红闪
    this._buildSnake();

    // 投放
    this.dropY = DROP_Y;
    this.current = null;
    this.fruitMaxLevel = fruitMaxLevelStart; // 必须先于 _randFruitLevel 初始化
    this.elapsed = 0;
    this.forceLevelQueue = [];        // 橘子雨 forceDrops 队列
    this.nextLevel = this._randFruitLevel();
    this.dropped = false;
    this.spawnDelay = FIRST_DROP_DELAY;

    // 砸蛇节抽卡进度（驱动抽卡；阈值随 game.playerLevel 变苛）
    this.killCount = 0;
    this.levelUpFlash = 0;

    // 卡牌增益
    this.shotSlots = 1;
    this.splitCharges = 0;
    this.timedEffects = [];
    this.effects = [];

    // 通关标记：整条蛇被打完 → 横幅倒计时 → 线性流程收尾
    this.stageCleared = false;
    this.clearTimer = 0;

    // 卡牌系统：蛇阶段专属卡池（8 张）
    this.cardSystem = new CardSystem(g, {
      getBodies: () => this.world.bodies.slice(),
      removeBody: (b) => this.world.remove(b),
      resizeBody: (b, r) => this.world.resize(b, r),
      addScore: (n) => { this.score += n; },
      addEffect: (e) => this.effects.push(e),
      toast: showToast,
      playSound: (name) => g.audio.play(name),
      // 蛇阶段没有僵尸：水果永远在动 → 选卡期间场稳定概率低，
      // 简化判定为"无水果"即可（蛇节位置固定，不影响）。
      isFieldCalm: () => this.world.bodies.every(b => b.sleeping || Math.abs(b.vy) < 420),
      startTimedEffect: (opts) => this.startTimedEffect(opts),
      // ---- 蛇阶段专属能力 ----
      addSplitCharges: (n) => { this.splitCharges += n; },
      addShotSlot: () => { this.shotSlots = Math.min(maxShotSlots, this.shotSlots + 1); },
      freezeSnake: (dur) => {
        this.snakeFreezeLeft = dur;
        this.startTimedEffect({ dur, onEnd: () => { this.snakeFreezeLeft = 0; } });
      },
      // ---- 通用能力（复用第一阶段卡牌的语义）----
      forceDrops: (lvl, n) => {
        for (let i = 0; i < n; i++) this.forceLevelQueue.push(lvl);
      },
      applyRandomForces: (min, max) => {
        for (const b of this.world.bodies) {
          const ang = Math.random() * Math.PI * 2;
          const mag = min + Math.random() * (max - min);
          b.vx += Math.cos(ang) * mag;
          b.vy += Math.sin(ang) * mag;
          b.sleeping = false;
        }
      },
      setBodyCollision: (on) => { this.world.noBodyCollide = !on; },
    }, snakeCardPool);

    // UI（与第二阶段同款）
    this.settingsBtn = new Button({
      x: W - 110, y: 50, w: 80, h: 80,
      text: '⚙', bgColor: 'rgba(255,255,255,0.25)', fontSize: 40,
      onTap: () => this.settings.open()
    });
    this.adBtn = new Button({
      x: 38, y: 250, w: 365, h: 108,
      text: '📺 看广告', bgColor: 'rgba(255,255,255,0.18)', fontSize: 48,
      onTap: () => showToast('广告位预留，敬请期待')
    });
    this.settings = new SettingsModal(g, {
      onExitGame: () => {
        g.audio.stopBgm();
        g.states.switchTo(g.createLobbyState());
      }
    });
    this.settings.setExitLabel('退出本局（回大厅）');

    // 调试包体（开发者工具/体验版）专属：左下角"跳到结算"按钮
    this.debugBtn = this._makeDebugSkipButton();

    g.audio.startBgm();
  }

  // ---------------- 蜿蜒蛇生成 ----------------

  /**
   * 一次性创建 300 节 SnakeNode 双向链表 + 沿曲线采样初始位置。
   * 卡牌节点按 ~snakeCardEvery 间距均匀分布（避开蛇头最近节，避免节奏死板）。
   */
  _buildSnake() {
    const W = this.game.screenW;
    const H = this.game.screenH;
    const cardIdxs = new Set(cardNodeIndices());

    let prev = null;
    for (let i = 0; i < snakeNodeCount; i++) {
      const t = i / (snakeNodeCount - 1);
      const baseHp = snakeHpHead + (snakeHpTail - snakeHpHead) * t;
      const isCard = cardIdxs.has(i);
      const mul = isCard
        ? snakeCardHpMulMin + Math.random() * (snakeCardHpMulMax - snakeCardHpMulMin)
        : 1;
      const hp = Math.round(baseHp * mul);
      const node = {
        prev,
        next: null,
        idx: i,
        s: 0,           // 沿曲线参数 s（每帧重算）
        x: 0, y: 0,     // 设计单位坐标（每帧重算）
        r: snakeNodeRadius,
        hp,
        maxHp: hp,
        isHead: i === 0,
        isCard,
        cardId: null,
        cardIcon: null,
        pulseT: Math.random() * 10, // 卡牌节点相位错开，避免同步脉冲
        dead: false,
      };
      // 卡牌 id 从 snakeCardPool 抽（与卡池同分布）
      if (isCard) {
        node.cardId = snakeCardPool[Math.floor(Math.random() * snakeCardPool.length)];
        const probe = CardSystem.createCard(node.cardId);
        node.cardIcon = probe ? probe.icon : '🎴';
      }
      if (prev) prev.next = node;
      prev = node;
      this.snakeNodes.push(node);
    }

    // 首帧采样（避免初始位置 = 0,0 闪烁）
    this._updateSnakePositions();
  }

  /** 按当前 snakeHeadS 更新所有活节点位置（沿 sine 曲线均匀分布） */
  _updateSnakePositions() {
    const W = this.game.screenW;
    const H = this.game.screenH;
    for (const n of this.snakeNodes) {
      if (n.dead) continue;
      const s = this.snakeHeadS - n.idx * snakeSpacing;
      const [x, y] = snakePathAt(s, W, H);
      n.s = s;
      n.x = x;
      n.y = y;
    }
  }

  // ---------------- 调试按钮 ----------------

  _makeDebugSkipButton() {
    if (!isDebugBuild()) return null;
    const g = this.game;
    return new Button({
      x: 30, y: g.screenH - 150, w: 220, h: 96,
      text: '⏭ 跳到结算', bgColor: 'rgba(40,70,30,0.78)', fontSize: 34,
      onTap: () => this._debugSkip()
    });
  }

  _debugSkip() {
    if (this.dead || this.stageCleared) return;
    // 直接把所有蛇节标记为已销毁（保留双向链表结构但 dead=true）
    for (const n of this.snakeNodes) n.dead = true;
    this.snakeAliveCount = 0;
    this.stageCleared = true;
    this.clearTimer = 0;
    this._finishStage();
  }

  onExit() {
    // 退出时清 Toast：避免上一阶段的"升级 / 砸墙"提示残留到下一阶段
    clearToasts();
    this.game.audio.stopBgm();
  }

  // ---------------- 投放 ----------------

  /** 水果等级：与第二阶段同款加权随机 */
  _randFruitLevel() {
    return timedWeightedLevelIndex(this.fruitMaxLevel, this.elapsed, fruitBiasEvery);
  }

  spawnNew() {
    let lvl;
    if (this.forceLevelQueue.length) {
      lvl = this.forceLevelQueue.shift();
    } else {
      lvl = this.nextLevel;
    }
    this.nextLevel = this._randFruitLevel();
    this.current = new Body(
      clamp(this.current ? this.current.x : this.game.screenW / 2,
            levels[lvl].radius, this.game.screenW - levels[lvl].radius),
      this.dropY,
      levels[lvl].radius,
      lvl,
      physicsDefaults
    );
    this.touchX = this.current.x;
  }

  /** 投放：多重射击时并排发射 shotSlots 颗同等级水果 */
  _dropCurrent() {
    if (!this.current || this.cardSystem.active) return;
    const g = this.game;
    const W = g.screenW;
    const lvl = this.current.level;
    const r = this.current.r;
    const n = this.shotSlots;
    const spacing = r * 2 + 16;
    const cx = this.current.x;
    for (let k = 0; k < n; k++) {
      const x = clamp(cx + (k - (n - 1) / 2) * spacing, r, W - r);
      const b = new Body(x, this.dropY, r, lvl, physicsDefaults);
      b.mergeLock = 0.6;
      this.world.add(b);
    }
    this.current = null;
    this.dropped = true;
    this.spawnDelay = 0.35;
  }

// ---------------- 蛇节砸破 / 抽卡 ----------------

/**
   * 砸破蛇节：解链表 + 抽卡进度 + 卡牌节点 grantCard。
   * 设计说明：玩家无 hp 字段，蛇节被砸只影响"是否通关"和"抽卡进度"，
   *   节奏更纯粹（玩家不会被扣血反馈打乱投放节奏）。
   * @param {object} node SnakeNode（hp 已 ≤ 0）
   */
  _destroySnakeNode(node) {
    // 解双向链表
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;

    // 标记死 + 计数
    node.dead = true;
    this.snakeAliveCount--;

    // 卡牌节点首次砸破 → 直接送卡（与第二阶段神器同路径）
    if (node.isCard) {
      const card = this.cardSystem.grantCard(node.cardId);
      const cname = card ? card.name : '卡牌';
      showToast(`🎴 获得「${cname}」！`);
    } else {
      showToast('💥 蛇节破碎');
    }

    // 抽卡进度（驱动 Lv. 升级 + 三选一）
    this.killCount++;
    const need = getCardTriggerCount('fruitVsSnake', this.game.playerLevel);
    if (this.killCount >= need) {
      this.killCount = 0;
      this.game.playerLevel++;
      this.levelUpFlash = 0.9;
      this.cardSystem.trigger();
      showToast(`Lv.${this.game.playerLevel}！`);
    }

    // 爆炸特效
    this.effects.push({ x: node.x, y: node.y, r: node.r * 2, t: 0, dur: 0.35, color: '#ff5a6e' });
    this.game.audio.play('boom');
  }

  // ---------------- 蛇 vs 水果 碰撞 ----------------

  /**
   * 水果 ↔ 蛇节 碰撞（独立循环，不走 PhysicsWorld._collide）。
   *   圆形最近点检测：minDist = r_node + r_fruit，命中即扣 hp。
   *   hp ≤ 0 → _destroySnakeNode；水果销毁。
   *   hp > 0 → 节点红闪 + 水果销毁（蛇节不会被水果"弹开"）。
   *
   * @returns {boolean} 本帧水果是否被销毁
   */
  _checkSnakeHits(fruit) {
    for (const node of this.snakeNodes) {
      if (node.dead) continue;
      const dx = node.x - fruit.x;
      const dy = node.y - fruit.y;
      const dist2 = dx * dx + dy * dy;
      const minD = node.r + fruit.r;
      if (dist2 >= minD * minD) continue;
      // 命中
      const dmg = Math.round(fruit.r * fruitWallDamageMul);
      node.hp -= dmg;
      if (node.hp <= 0) {
        this._destroySnakeNode(node);
      } else {
        // 击中但没死：节点红闪
        this.effects.push({ x: node.x, y: node.y, r: node.r, t: 0, dur: 0.15, color: '#ff3b30' });
      }
      // 水果被销毁（弹起 + 反作用力等都不需要：水果直接消失）
      this._destroyFruit(fruit);
      return true;
    }
    return false;
  }

  _destroyFruit(b) {
    this.effects.push({ x: b.x, y: b.y, r: b.r, t: 0, dur: 0.3, color: '#ffffff' });
    this.world.remove(b);
  }

// ---------------- 蛇节越线 / 通关 ----------------

/**
 * 任意活蛇节 y ≤ warnY → 直接判负。
 * 设计要点：去掉了"只看蛇头"的判定，改为遍历所有活节点。
 *   - 蛇头当然会最先越线（它 y 最大），但万一有玩家用卡牌把蛇头
 *     砸/冻回到后面，靠蛇身中部或尾部越线也算失败。
 *   - 提示语区分蛇头/普通节，玩家能直观知道失败原因。
 */
  _onSnakeNodeCrossed(node) {
    this.dead = true;
    this.game.audio.play('boom');
    const isHead = node && node.isHead;
    showToast(isHead ? '🐍 蛇头已抵达顶部！' : '🐍 蛇节越过阈值线！');
    this._gotoResult();
  }

  /** 整条蛇被打完 → 通关 */
  _onSnakeDestroyed() {
    this.effects.push({
      x: this.game.screenW / 2, y: this.game.screenH / 2,
      r: 220, t: 0, dur: 0.8, color: '#ff5a6e'
    });
    this.stageCleared = true;
    this.clearTimer = FINAL_CLEAR_DELAY;
    this.game.audio.play('boom');
    showToast('🎉 怪蛇被摧毁！');
  }

  // ---------------- 水果合成 ----------------

  _handleMerge(a, b) {
    const g = this.game;
    if (a.level >= levels.length - 1) {
      this._destroy(a, levels[a.level].score);
      this._destroy(b, levels[b.level].score);
      showToast('合成终极水果！');
      return;
    }
    const newLevel = a.level + 1;
    const cfg = levels[newLevel];
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    this._destroy(a, 0);
    this._destroy(b, 0);
    const nb = this.world.add(new Body(x, y, cfg.radius, newLevel, physicsDefaults));
    nb.mergeLock = 0.12;
    this.score += cfg.score;
    g.audio.play('boom');
    this.effects.push({ x, y, r: cfg.radius, t: 0, dur: 0.35, color: cfg.color });
  }

  _destroy(body, scoreGain) {
    this.world.remove(body);
    if (scoreGain) this.score += scoreGain;
  }

  // ---------------- 卡牌定时效果 ----------------

  startTimedEffect({ dur = 1, interval = 0, tick = null, onEnd = null }) {
    this.timedEffects.push({ left: dur, interval, acc: interval, tick, onEnd });
  }

  _updateTimedEffects(dt) {
    if (!this.timedEffects.length) return;
    for (const e of this.timedEffects) {
      e.left -= dt;
      if (e.tick) {
        if (e.interval > 0) {
          e.acc += dt;
          while (e.acc >= e.interval) {
            e.acc -= e.interval;
            e.tick();
          }
        } else {
          e.tick();
        }
      }
      if (e.left <= 0 && e.onEnd) e.onEnd();
    }
    this.timedEffects = this.timedEffects.filter(e => e.left > 0);
  }

// ---------------- 复活（结算页回调） ----------------

revive() {
    // 蛇节已经死亡的不可复活，但可以让蛇头退回到原位 + 清卡牌队列
    this.snakeHeadS = snakeHeadStartS;
    this._updateSnakePositions();
    this.dead = false;
    this.killCount = 0;
    this.timedEffects = [];
    this.snakeFreezeLeft = 0;
    this.cardSystem.reset();
    if (!this.current && (this.spawnDelay === undefined || this.spawnDelay <= 0)) {
      this.spawnNew();
    }
    this.game.audio.startBgm();
    showToast('复活成功！蛇退回原位');
  }

  // ---------------- 更新 ----------------

  onUpdate(dt) {
    this.elapsed += dt;

    // 水果等级上限成长（同第二阶段节奏）
    this.fruitMaxLevel = Math.min(fruitMaxLevelCap, fruitMaxLevelStart + Math.floor(this.elapsed / fruitGrowEvery));

    if (this.levelUpFlash > 0) this.levelUpFlash = Math.max(0, this.levelUpFlash - dt);
    if (this.snakeWarnFlash > 0) this.snakeWarnFlash = Math.max(0, this.snakeWarnFlash - dt);

    if (this.cardSystem.active) return; // 选卡时暂停

    // 特效动画 & 卡牌定时效果
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter(e => e.t < e.dur);
    this._updateTimedEffects(dt);

    // 蛇推进（freeze_snake 期间 snakeFreezeLeft > 0 → 不推进）
    // 推进方向：snakeHeadS += speed × dt（蛇头向曲线顶部阈值线爬升）。
    if (this.snakeFreezeLeft <= 0 && !this.stageCleared) {
      this.snakeHeadS += this.snakeSpeedCur * dt;
      if (this.snakeHeadS > snakeTotalLen) this.snakeHeadS = snakeTotalLen;
      this._updateSnakePositions();
    } else {
      // 冻结期间也跑一次位置采样（视觉上保持蛇身不抖动）
      this._updateSnakePositions();
    }

    // 卡牌节点脉冲相位
    for (const n of this.snakeNodes) {
      if (!n.dead && n.isCard) n.pulseT += dt;
    }

    // 物理步进（水果）
    this.world.step(dt);

    // 水果 vs 蛇节碰撞（物理 step 后做，吃水果最新位置）
    if (!this.dead && !this.stageCleared) {
      for (const b of this.world.bodies) {
        if (b.dead) continue;
        this._checkSnakeHits(b);
      }
    }

    // 受击红闪衰减分支已不再需要（无 hp 字段，受击反馈也没意义）

    // 蛇节越线预警 + 判定（任一活节 y ≤ warnY → 失败）
    if (!this.dead && !this.stageCleared) {
      // 屏闪预警：仍以蛇头为指标（最早可能越线的节，给玩家最后时间反应）
      const head = this.snakeNodes[0];
      if (head && !head.dead) {
        const distToWarn = head.y - head.r - this.warnY;
        if (distToWarn <= snakeWarnDistance) {
          this.snakeWarnFlash = 0.3;
        }
      }
      // 失败判定：遍历所有活节，任一节越线即 Game Over
      // （蛇头只是会最先越线的节；其他节理论上也会跟上来）
      for (const n of this.snakeNodes) {
        if (n.dead) continue;
        if (n.y - n.r <= this.warnY) {
          this._onSnakeNodeCrossed(n);
          return;
        }
      }
    }

    // 通关判定（整条蛇打完）
    if (!this.stageCleared && !this.dead && this.snakeAliveCount === 0) {
      this._onSnakeDestroyed();
    }

    // 死亡判定分支：玩家无 hp 字段，失败条件在前面的"任意节越线"判定里处理

    // 悬停球跟随手指
    if (this.current) {
      const r = this.current.r;
      const target = clamp(this.touchX ?? this.current.x, r, this.game.screenW - r);
      this.current.x += (target - this.current.x) * Math.min(1, dt * 18);
      this.current.y = this.dropY;
    } else if (this.spawnDelay > 0) {
      this.spawnDelay -= dt;
      if (this.spawnDelay <= 0) this.spawnNew();
    }

    // 选卡队列
    this.cardSystem.update();

    // 通关横幅倒计时
    if (this.stageCleared && !this.dead && this.clearTimer > 0) {
      this.clearTimer -= dt;
      if (this.clearTimer <= 0) {
        this.clearTimer = 0;
        this._finishStage();
      }
    }
  }

  /** 阶段收尾：走线性关卡流程（有下一关切换过去；已是最终关 → 通关结算） */
  _finishStage() {
    const g = this.game;
    if (this.score > g.bestScore) {
      g.bestScore = this.score;
      g.saveBest();
    }
    const next = g.createNextStageState(this.stageId, this.score);
    if (next) {
      g.states.switchTo(next);
    } else {
      // 线性流程的最终阶段：直接进入结算（通关模式，不提供复活）
      g.audio.stopBgm();
      g.states.push(g.createResultState(this, { win: true }));
    }
  }

  /** 死亡 → 压入结算层（记录最佳分数） */
  _gotoResult() {
    const g = this.game;
    if (this.score > g.bestScore) {
      g.bestScore = this.score;
      g.saveBest();
    }
    g.audio.stopBgm();
    g.states.push(g.createResultState(this));
  }

  // ---------------- 渲染 ----------------

  onRender(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;

    applyPixelCtx(ctx);
    drawStageBg(ctx, W, H, this.floorY, THEME.snake);

    const warnFlash = this.snakeWarnFlash > 0 && Math.floor(Date.now() / 120) % 2 === 0;
    drawWarnLine(ctx, W, this.warnY, warnFlash);

    if (this.snakeWarnFlash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, this.snakeWarnFlash * 0.6);
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    for (const n of this.snakeNodes) {
      if (n.dead) continue;
      if (!n.next || n.next.dead) continue;
      const lineColor = n.isCard ? `hsl(${(n.pulseT * 18) % 360}, 85%, 55%)` : '#5a1228';
      drawSnakeConnection(ctx, n.x, n.y, n.next.x, n.next.y, n.r, lineColor);
    }

    for (const n of this.snakeNodes) {
      if (n.dead) continue;
      drawSnakeNode(ctx, n);
    }

    const head = this.snakeNodes[0];
    if (head && !head.dead) {
      ctx.save();
      applyPixelCtx(ctx);
      const t = Date.now() / 280;
      const r = head.r * (1 + (Math.sin(t) + 1) * 0.5);
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#ff7a4a';
      ctx.lineWidth = 3;
      const rr = Math.round(r * 2.4);
      ctx.strokeRect(Math.round(head.x - rr), Math.round(head.y - rr), rr * 2, rr * 2);
      ctx.restore();
    }

    for (const b of this.world.bodies) {
      if (!b.dead) drawBall(ctx, b.x, b.y, b.r, b.level);
    }

    if (this.current) {
      drawDropGuide(ctx, this.current.x, this.current.y, this.current.r, this.floorY, 'rgba(255,255,255,0.22)');
      drawBall(ctx, this.current.x, this.current.y, this.current.r, this.current.level);
    }

    for (const e of this.effects) drawPixelBurst(ctx, e);

    {
      const pct = Math.round((this.snakeAliveCount / snakeNodeCount) * 100);
      drawTopBar(
        ctx, g, W,
        this.snakeAliveCount / snakeNodeCount,
        '#8a40d0',
        `剩余尸核 ${this.snakeAliveCount}/${snakeNodeCount}  ${pct}%`,
        '#f3e7ff'
      );
    }

    this._renderPlayerLevelBadge(ctx);
    drawScoreChip(ctx, this.score);

    {
      const total = getCardTriggerCount('fruitVsSnake', this.game.playerLevel);
      const cur = Math.min(this.killCount, total);
      drawCardProgress(ctx, W, `砸节抽卡进度 ${cur}/${total}`, cur, total, false);
    }

    drawNextChip(ctx, W, this.nextLevel);

    if (this.stageCleared) {
      const secs = Math.ceil(this.clearTimer);
      const tip = g.hasNextStage(this.stageId)
        ? `下一阶段 将在 ${secs} 秒后开始`
        : `将在 ${secs} 秒后进入结算`;
      drawBanner(ctx, W, H, '恭喜通关！', tip, '#9c5fe8');
    }

    this.adBtn.render(ctx);
    this.settingsBtn.render(ctx);
    if (this.debugBtn) this.debugBtn.render(ctx);
    this.settings.render(ctx);
    this.cardSystem.render(ctx);
  }

  /**
   * 渲染 Lv.X 徽标（左上角，与右上角 ⚙ 对称；升级时弹一下 + 高亮）。
   * 与 fruitMergeState / fruitVsZombieState 的同名方法布局一致。
   */
  _renderPlayerLevelBadge(ctx) {
    drawLevelBadge(ctx, this.game, this.levelUpFlash || 0);
  }

  // ---------------- 触摸（同 fruitVsZombie 模式） ----------------

  onTouchStart(t) {
    if (this.settings.handleTouch('start', t)) return;
    if (this.cardSystem.handleTouch('start', t)) return;
    this.settingsBtn.handleTouch('start', t);
    this.adBtn.handleTouch('start', t);
    if (this.debugBtn) this.debugBtn.handleTouch('start', t);
  }

  onTouchMove(t) {
    if (this.settings.handleTouch('move', t)) return;
    if (this.cardSystem.handleTouch('move', t)) return;
    this.touchX = t.x;
  }

  onTouchEnd(t) {
    if (this.settings.handleTouch('end', t)) return;
    if (this.cardSystem.handleTouch('end', t)) return;
    if (this.settingsBtn.handleTouch('end', t)) return;
    if (this.adBtn.handleTouch('end', t)) return;
    if (this.debugBtn && this.debugBtn.handleTouch('end', t)) return;
    this.touchX = t.x;
    this._dropCurrent();
  }
}