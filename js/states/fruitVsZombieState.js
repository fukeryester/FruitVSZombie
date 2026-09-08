/**
 * 第二阶段局内状态（FruitVsZombieState / 水果大战僵尸 · 双线战场）
 * ------------------------------------------------------------------
 * 玩法（仿"向僵尸开炮"双线结构）：
 *   - 警戒线以下的场地被一堵垂直于警戒线的中隔墙分为左右两半：
 *       · 右半区：僵尸源源不断地从底部刷出并向上爬（更频繁、更大批量，
 *         单兵更弱更慢 —— 肉鸽割草感），还有概率刷出 x*y 方阵僵尸；
 *         僵尸越过警戒线扣玩家血量，血量归零失败。
 *       · 左半区：被墙体划分成 3x3 神器格。平行于警戒线的 12 段横墙
 *         （墙1~墙12）带血量（自上而下 4 行递增），网格下方的墙13（整宽）
 *         与最底部的尸核舱之间关着尸核（血红色静态球，coreMaxHp 血，不上浮）。
 *   - 玩家从上方投放水果：水果伤害 = 半径 × fruitWallDamageMul（越大越痛）。
 *       · 水果砸水平血墙 → 墙掉血 + 水果被摧毁；墙血量归零即消失；
 *       · 水果撞**竖直墙**（竖隔板/中隔墙）→ **没有任何水果走自毁**：
 *         等级 ≥ wallSplitMinLevel（樱桃及以上）分裂成若干颗葡萄
 *         继续往下挖（葡萄直径 84 < 格子净宽 126，可落进格子）；
 *         等级 < wallSplitMinLevel（葡萄本身）只"受到碰撞"被弹开，
 *         留在场上继续参与合成或被僵尸啃；
 *       · 水果碰神器 → 直接获得神器上耦合的卡牌增益，神器与水果都消失；
 *       · 水果砸尸核 → 尸核掉血，并按"伤害 / 每个小僵尸血量"孵化小僵尸
 *         （从砸中点爬出，给玩家施压），水果被摧毁；
 *       · 水果砸僵尸 → 双方互扣半径（与旧版一致）；
 *       · 水果掉到底部不再销毁，允许在地面堆积（可当"地雷"）。
 *   - 胜利条件：摧毁尸核（顶部进度条显示尸核血量与百分比）；
 *     失败条件：玩家血量归零（接复活）。
 *
 * 与第一阶段的差异全部收在本状态内：
 *   · 物理引擎通过 onContact 暴露"球↔球接触"、onWallContact 暴露"球↔墙接触"；
 *   · 僵尸用 Body.isZombie + climbAccel 实现，尸核/神器用 Body.isStatic
 *     （无限质量、不积分、不参与合成）实现，墙用 PhysicsWorld.walls 实现。
 */
import { BaseState } from '../core/stateMachine.js';
import { PhysicsWorld, Body } from '../core/physics.js';
import { Button, SettingsModal, showToast, clearToasts } from '../ui/widgets.js';
import { makePayButton } from '../ui/payModal.js';
import { watchRewardAd } from '../core/adApi.js';
import { CardSystem } from '../cards/index.js';
import { levels, physicsDefaults } from '../config/balls.js';
import { zombieCardPool } from '../config/cards.js';
import { getCardTriggerCount } from '../config/level.js';
import { drawBall, drawZombie, drawZombieCore, drawArtifact } from '../ui/ballRenderer.js';
import { applyPixelCtx, drawPixelBurst, fillPixelText, fillBrick, palette, pixelBar } from '../ui/pixel.js';
import { drawStageBg, drawWarnLine, drawDropGuide, drawScoreChip, drawNextChip, drawLevelBadge, drawCardProgress, drawTopBar, drawBanner } from '../ui/hud.js';
import { clamp, pickHalf } from '../core/utils.js';
import {
  playerMaxHP,
  zombieDamageBase,
  zombieScoreMul,
  zombieSpawnIntervalStart,
  zombieSpawnIntervalMin,
  zombieSpawnIntervalDecay,
  zombieMaxLevelStart,
  zombieMaxLevelCap,
  zombieMaxLevelGrowEvery,
  zombieBiasEvery,
  zombieWaveStart,
  zombieWaveMax,
  zombieWaveGrowEvery,
  phalanxChance,
  phalanxMaxCols,
  phalanxMaxRows,
  phalanxLevelMax,
  arenaLeftRatio,
  wallThickness,
  wallHpRanges,
  wall13Hp,
  wallSplitMinLevel,
  wallSplitChildLevel,
  wallSplitCountOffset,
  wallSplitJitter,
  wallSplitLift,
  wallSplitStackGap,
  coreMaxHp,
  coreRadius,
  fruitWallDamageMul,
  coreZombieHp,
  coreZombieRadius,
  zombieRadiusMul,
  fruitMaxLevelStart,
  fruitMaxLevelCap,
  fruitGrowEvery,
  fruitBiasEvery,
  timedWeightedLevelIndex,
  fruitBounceSpeed,
  zombieKnockSpeed,
  zombieMaxClimbSpeed,
  survivorJitter,
  minSurviveRadius,
  splitRadiusFactor,
  maxShotSlots,
  freezeClimbMul,
  effectiveClimbAccel
} from '../config/zombies.js';
import { FINAL_CLEAR_DELAY } from '../config/stages.js';
import { isDebugBuild } from '../config/debug.js';

/** 首个僵尸的出怪延迟（给玩家一点准备时间） */
const FIRST_SPAWN_DELAY = 2;
/** 神器格顶部与警戒线的间距 */
const GRID_TOP_GAP = 90;
/** 墙13 与网格底边（墙10-12）的间距 */
const WALL13_GAP = 24;
/** 神器球半径 */
const ARTIFACT_RADIUS = 30;

export default class FruitVsZombieState extends BaseState {
  /** 线性关卡流程中的阶段 id（main.stageFlow 按此定位下一阶段） */
  get stageId() { return 'fruitVsZombie'; }

  /**
   * @param {object} game
   * @param {number} carryScore 从第一阶段继承的分数（计入总分/最佳分）
   */
  constructor(game, carryScore = 0) {
    super(game);
    this.carryScore = carryScore;
  }

  onEnter() {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;

    // 等级每阶段独立：从 fruitMerge 晋级进来时回到 Lv.1（与分数共享不同）
    g.resetPlayerLevel();
    // 分数：继承第一阶段作为基数（跨阶段共享累计总分）
    this.baseScore = this.carryScore;
    this.score = this.carryScore;
    this.dead = false;

    // 场地（与第一阶段同一套几何）
    this.floorY = H - 20;
    this.warnY = 327;
    this.world = new PhysicsWorld(
      { left: 0, right: W, top: 0, bottom: this.floorY },
      (a, b) => this._handleMerge(a, b),
      (a, b) => this._handleContact(a, b),
      (b, w) => this._handleWallContact(b, w)
    );

    // 双线战场：中隔墙 + 3x3 神器格血墙 + 墙13 + 尸核
    // 左半区占比由 arenaLeftRatio 决定：必须保证单列净宽容得下等级1 水果，
    // 否则大水果分裂出的小水果同样会被竖隔板卡住销毁（见 zombies.js 注释）。
    this.dividerX = W * arenaLeftRatio;
    this.artifacts = [];
    this.core = null;
    this._buildArena();
    this.coreHpShown = this.core.maxHp; // 顶部尸核血条缓动显示值

    // 投放
    this.dropY = 212;
    this.current = null;
    this.fruitMaxLevel = fruitMaxLevelStart; // 必须先于 _randFruitLevel 初始化
    this.elapsed = 0;
    this.nextLevel = this._randFruitLevel();
    this.dropped = false;
    this.spawnNew();

    // 玩家血量与受击反馈
    this.hp = playerMaxHP;
    this.damageFlash = 0;

    // 僵尸出怪
    this.spawnTimer = FIRST_SPAWN_DELAY;

    // 抽卡进度（击杀计数，阈值随 game.playerLevel 变苛）
    this.killCount = 0;
    this.levelUpFlash = 0;   // 升级闪动计时（> 0 时 Lv. 徽标弹一下）

    // 卡牌增益
    this.shotSlots = 1;      // 多重射击：每次投放的并排水果数
    this.splitCharges = 0;   // 分裂水果：剩余分裂次数
    this.zombieClimbMul = 1; // 冰冻时刻：僵尸爬升净加速度乘数

    // 通关标记：摧毁尸核 → 停止出怪 + 横幅倒计时，
    // 倒计时结束走线性流程（有下一关则切换，无下一关直接进结算）。
    this.stageCleared = false;
    this.clearTimer = 0;

    // 特效与定时效果
    this.effects = [];
    this.timedEffects = [];

    // 卡牌系统：第二阶段专属卡池
    this.cardSystem = new CardSystem(g, {
      getBodies: () => this.world.bodies.slice(),
      removeBody: (b) => this.world.remove(b),
      resizeBody: (b, r) => this.world.resize(b, r),
      addScore: (n) => { this.score += n; },
      addEffect: (e) => this.effects.push(e),
      toast: showToast,
      playSound: (name) => g.audio.play(name),
      // 选卡弹出条件：只看水果是否稳定（僵尸永远在动，不能挡住选卡）
      isFieldCalm: () => this.world.bodies.every(b => b.isZombie || b.isStatic || Math.abs(b.vy) < 420),
      startTimedEffect: (opts) => this.startTimedEffect(opts),
      // ---- 僵尸阶段专属能力 ----
      addSplitCharges: (n) => { this.splitCharges += n; },
      addShotSlot: () => { this.shotSlots = Math.min(maxShotSlots, this.shotSlots + 1); },
      freezeZombies: (dur) => {
        this.zombieClimbMul = freezeClimbMul;
        this.startTimedEffect({ dur, onEnd: () => { this.zombieClimbMul = 1; } });
      }
    }, zombieCardPool);

    // UI（与第一阶段同款）
    this.settingsBtn = new Button({
      x: W - 110, y: 50, w: 80, h: 80,
      text: '⚙', bgColor: 'rgba(255,255,255,0.25)', fontSize: 40,
      onTap: () => this.settings.open()
    });
    this.adBtn = new Button({
      x: 38, y: 250, w: 365, h: 108,
      text: '📺 看广告', bgColor: 'rgba(255,255,255,0.18)', fontSize: 48,
      onTap: () => { watchRewardAd(0).then((r) => { if (r.ok) showToast('感谢支持'); }); }
    });
    this.payBtn = makePayButton(g, 38, 370, 280, 72, 30);
    this.settings = new SettingsModal(g, {
      onExitGame: () => {
        g.audio.stopBgm();
        g.states.switchTo(g.createLobbyState());
      }
    });
    this.settings.setExitLabel('退出本局（回大厅）');

    // 调试包体（开发者工具/体验版）专属：左下角"跳到结算"按钮
    // （若流程里给本阶段配了后续阶段，则显示"下一阶段"直接晋级）
    this.debugBtn = this._makeDebugSkipButton();

    g.audio.startBgm('zombie');
  }

  // ---------------- 双线战场搭建 ----------------

  /**
   * 搭建左半区 3x3 神器格 + 血墙 + 墙13 + 尸核舱 + 中隔墙。
   * 布局（自上而下）：警戒线 →（间隙）→ 墙1-3 → 神器行1 → 墙4-6 → 神器行2
   *   → 墙7-9 → 神器行3 → 墙10-12 →（间隙）→ 墙13 → 尸核舱（尸核）→ 地面。
   * 血墙：12 段横墙（4 行 × 3 段，血量按行取 wallHpRanges）+ 墙13（整宽 wall13Hp）。
   * 无血墙（不可摧毁）：格子间的 6 段竖隔板 + 左右半区之间的中隔墙。
   */
  _buildArena() {
    const T = wallThickness;
    const dividerX = this.dividerX;
    const colW = dividerX / 3;
    const gridTop = this.warnY + GRID_TOP_GAP;
    // 尸核舱：贴地面，高度容纳尸核 + 少量活动空间
    const chamberH = coreRadius * 2 + 80;
    const wall13Y = this.floorY - chamberH;
    const gridBottom = wall13Y - WALL13_GAP;
    const rowH = (gridBottom - gridTop) / 3;
    this.gridTop = gridTop;
    this.gridRowH = rowH;
    this.gridColW = colW;

    // ---- 血墙：4 行 × 3 段（墙1~墙12，血量按行随机） ----
    for (let i = 0; i < 4; i++) {
      const [lo, hi] = wallHpRanges[i];
      const y = gridTop + i * rowH - T / 2;
      for (let c = 0; c < 3; c++) {
        const hp = Math.round(lo + Math.random() * (hi - lo));
        this.world.addWall({
          id: i * 3 + c + 1,
          x: c * colW, y, w: colW, h: T,
          hp, maxHp: hp, destructible: true
        });
      }
    }

    // ---- 墙13：网格正下方整宽血墙（尸核舱顶盖） ----
    this.world.addWall({
      id: 13,
      x: 0, y: wall13Y, w: dividerX, h: T,
      hp: wall13Hp, maxHp: wall13Hp, destructible: true
    });

    // ---- 格子竖隔板（无血量、不可摧毁）：3 行 × 2 段 ----
    for (let i = 0; i < 3; i++) {
      const segY = gridTop + i * rowH + T / 2;
      for (let j = 1; j <= 2; j++) {
        this.world.addWall({
          x: j * colW - T / 2, y: segY, w: T, h: rowH - T,
          destructible: false
        });
      }
    }

    // ---- 中隔墙（无血量、不可摧毁）：警戒线 → 地面，分隔左右半区 ----
    this.world.addWall({
      x: dividerX - T / 2, y: this.warnY, w: T, h: this.floorY - this.warnY,
      destructible: false
    });

    // ---- 神器：9 格各一件，耦合僵尸阶段卡池中的随机卡牌 ----
    for (let i = 0; i < 3; i++) {
      for (let c = 0; c < 3; c++) {
        const cardId = zombieCardPool[Math.floor(Math.random() * zombieCardPool.length)];
        const probe = CardSystem.createCard(cardId);
        const a = new Body(
          c * colW + colW / 2,
          gridTop + i * rowH + rowH / 2,
          ARTIFACT_RADIUS, 0, physicsDefaults
        );
        a.isStatic = true;
        a.isArtifact = true;
        a.cardId = cardId;
        a.icon = probe ? probe.icon : '❓';
        a.cardName = probe ? probe.name : '未知';
        this.world.add(a);
        this.artifacts.push(a);
      }
    }

    // ---- 尸核：血红色静态球，不会向上移动 ----
    const core = new Body(dividerX / 2, this.floorY - coreRadius - 8, coreRadius, 0, physicsDefaults);
    core.isStatic = true;
    core.isCore = true;
    core.hp = coreMaxHp;
    core.maxHp = coreMaxHp;
    this.world.add(core);
    this.core = core;
  }

  /** 调试跳段按钮：有下一阶段 → 直接晋级；已是最终关 → 直接进结算 */
  _makeDebugSkipButton() {
    if (!isDebugBuild()) return null;
    const g = this.game;
    return new Button({
      x: 30, y: g.screenH - 150, w: 220, h: 96,
      text: g.hasNextStage(this.stageId) ? '⏭ 下一阶段' : '⏭ 跳到结算',
      bgColor: 'rgba(40,70,30,0.78)', fontSize: 34,
      onTap: () => this._debugSkip()
    });
  }

  /** 调试用：跳过当前阶段（立即结算/晋级，无倒计时） */
  _debugSkip() {
    if (this.dead) return;
    this.stageCleared = true;
    this.clearTimer = 0;
    this._finishStage();
  }

  onExit() {
    // 清 Toast：防止"升级 / 砸墙"等提示残留到下一阶段（或大厅）
    clearToasts();
    this.game.audio.stopBgm();
  }

  // ---------------- 投放 ----------------

  /** 水果等级：初始 0~3，上限与高等级概率都随时间提升（fruitBiasEvery 控制高级概率增速） */
  _randFruitLevel() {
    return timedWeightedLevelIndex(this.fruitMaxLevel, this.elapsed, fruitBiasEvery);
  }

  spawnNew() {
    const lvl = this.nextLevel;
    this.nextLevel = this._randFruitLevel();
    this.current = new Body(
      clamp(this.current ? this.current.x : this.game.screenW / 2, levels[lvl].radius, this.game.screenW - levels[lvl].radius),
      this.dropY,
      levels[lvl].radius,
      lvl,
      physicsDefaults
    );
    this.touchX = this.current.x;
  }

  /**
   * 投放：多重射击时并排发射 shotSlots 颗同等级水果
   * （间隔 > 2r 保证初始不重叠；mergeLock 防止下落途中贴住互合）
   */
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

  // ---------------- 僵尸 ----------------

  /** 出怪间隔：随时间线性缩短（下限保护） */
  _spawnInterval() {
    return Math.max(
      zombieSpawnIntervalMin,
      zombieSpawnIntervalStart - this.elapsed * zombieSpawnIntervalDecay
    );
  }

  /** 僵尸等级上限随时间成长，且高等级权重随时间增大 */
  _zombieMaxLevel() {
    return Math.min(zombieMaxLevelCap, zombieMaxLevelStart + Math.floor(this.elapsed / zombieMaxLevelGrowEvery));
  }

  /** 当前每波出怪数量：随时间 zombieWaveStart → zombieWaveMax 递增（PVZ 式压力曲线） */
  _spawnWaveCount() {
    return Math.min(zombieWaveMax, zombieWaveStart + Math.floor(this.elapsed / zombieWaveGrowEvery));
  }

  /** 右半区可用的生成 x 范围（中隔墙右侧 → 屏幕右边） */
  _spawnXRange(r) {
    const xMin = this.dividerX + wallThickness / 2 + r;
    const xMax = this.game.screenW - r;
    return xMax > xMin ? [xMin, xMax] : null;
  }

  /** 普通出怪：右半区底部随机位置刷一只（等级随时间偏弱成长） */
  _spawnZombie() {
    const lvl = timedWeightedLevelIndex(this._zombieMaxLevel(), this.elapsed, zombieBiasEvery);
    const r = levels[lvl].radius * zombieRadiusMul;
    const range = this._spawnXRange(r);
    const x = range ? range[0] + Math.random() * (range[1] - range[0]) : (this.dividerX + this.game.screenW) / 2;
    this._addZombie(x, this.floorY - r, r, lvl);
  }

  /**
   * 方阵僵尸：以 x*y 矩阵形式整队出现（仅低等级）。
   * 出场摆位是方阵，后续移动/碰撞逻辑与普通僵尸完全一致（各跑各的）。
   */
  _spawnPhalanx() {
    let cols = 2 + Math.floor(Math.random() * (phalanxMaxCols - 1)); // 2..maxCols
    const rows = 2 + Math.floor(Math.random() * (phalanxMaxRows - 1)); // 2..maxRows
    const lvlMax = Math.min(phalanxLevelMax, this._zombieMaxLevel());
    const lvl = Math.floor(Math.random() * (lvlMax + 1));
    const r = levels[lvl].radius * zombieRadiusMul;
    const spacing = r * 2 + 8;
    const range = this._spawnXRange(r);
    // 出怪区摆不下这么多列就自动减列，避免方阵溢出到右边界外挤成一坨
    if (range) {
      const avail = range[1] - range[0];
      while (cols > 1 && (cols - 1) * spacing > avail) cols--;
    }
    const spanX = (cols - 1) * spacing;
    const x0 = range
      ? range[0] + Math.random() * Math.max(1, range[1] - range[0] - spanX)
      : (this.dividerX + this.game.screenW) / 2 - spanX / 2;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        this._addZombie(x0 + i * spacing, this.floorY - r - j * spacing, r, lvl);
      }
    }
    showToast(`⚠ 方阵僵尸来袭（${cols}×${rows}）！`);
  }

  _addZombie(x, y, r, lvl) {
    const z = new Body(x, y, r, lvl, physicsDefaults);
    z.isZombie = true;
    z.climbAccel = effectiveClimbAccel(this.zombieClimbMul);
    this.world.add(z);
    return z;
  }

  /** 消灭僵尸：得分 + 特效 + 击杀计数（驱动抽卡） */
  _destroyZombie(z, scoreGain) {
    this.effects.push({ x: z.x, y: z.y, r: z.r, t: 0, dur: 0.35, color: '#5d8a35' });
    this.world.remove(z);
    if (scoreGain) this.score += scoreGain;
    this.game.audio.play('boom');
    this.killCount++;
    const need = getCardTriggerCount('fruitVsZombie', this.game.playerLevel);
    if (this.killCount >= need) {
      this.killCount = 0;
      this.game.playerLevel++;
      this.levelUpFlash = 0.9;
      this.cardSystem.trigger();
      showToast(`Lv.${this.game.playerLevel}！`);
    }
  }

  _destroyFruit(b) {
    this.effects.push({ x: b.x, y: b.y, r: b.r, t: 0, dur: 0.3, color: '#ffffff' });
    this.world.remove(b);
  }

  // ---------------- 撞墙 / 撞静态体结算 ----------------

  /**
   * 球 ↔ 墙 接触（物理引擎 onWallContact 回调）
   * ------------------------------------------------------------------
   * 僵尸撞墙：仅物理阻挡，不掉血不结算。
   * 水果撞**竖直墙**（竖隔板 / 中隔墙，h > w）—— **没有任何水果走自毁**：
   *   · 等级 ≥ wallSplitMinLevel → 分裂成若干颗葡萄（见 _splitFruitOnWall）；
   *   · 等级 < wallSplitMinLevel（最低级葡萄） → 只"受到碰撞"被弹开，留在场上。
   * 水果撞**水平墙**（血墙 / 墙13）：掉血 + 水果自毁（不变）。
   */
  _handleWallContact(b, wall) {
    if (b.dead || wall.dead) return;
    if (b.isZombie || b.isStatic) return;
    if (wall.h > wall.w) {
      // 竖直墙：分裂或弹开，都不销毁水果
      if (b.level >= wallSplitMinLevel) this._splitFruitOnWall(b, wall);
      else this._bounceFruitOnWall(b, wall);
      return;
    }
    const dmg = Math.round(b.r * fruitWallDamageMul);
    if (wall.destructible) {
      wall.hp -= dmg;
      this.effects.push({ x: b.x, y: b.y, r: b.r, t: 0, dur: 0.3, color: '#c9a227' });
      if (wall.hp <= 0) {
        wall.hp = 0;
        this.world.removeWall(wall);
        this.game.audio.play('boom');
        showToast(wall.id ? `墙${wall.id} 被摧毁！` : '墙被摧毁！');
      }
    }
    this._destroyFruit(b);
  }

  /** 最低级水果（葡萄）撞竖直墙：只弹开，保留在场上不掉血不自毁 */
  _bounceFruitOnWall(b, wall) {
    // 物理引擎已经把球推出墙体并反弹了速度，这里只补一个轻量火花特效。
    this.effects.push({ x: b.x, y: b.y, r: b.r * 0.6, t: 0, dur: 0.18, color: '#cfd8dc' });
  }

  /**
   * 水果撞竖直墙 → 分裂成【等级+offset】颗葡萄（无自毁）。
   * ------------------------------------------------------------------
   * 后期水果半径远大于格子净宽，撞到竖隔板/中隔墙就被销毁 —— 既浪费弹药，
   * 又永远打不到下层的横墙。分裂后产物（葡萄，直径 84）能顺利落进格子
   * （净宽 126，留 21px 余量），继续砸横墙 / 吃神器 / 砸尸核。
   *
   * 摆位：竖直墙都立在格子边界上，所以取墙心 ± 半列宽正好是左右相邻两格
   *       的正中心（中隔墙右侧则是开阔的出怪区）—— 小水果一出生就落在
   *       格子中间，既不会贴着隔板，也能顺着格子继续往下砸横墙。
   *       同侧多只时纵向错位（wallSplitStackGap × 葡萄半径 ≥ 88px）保证
   *       下落途中互不接触。
   * 产物：level = wallSplitChildLevel（葡萄）、noMerge = true（不允许再次
   *       合成）。葡萄撞竖直墙本来就只会被弹开，所以不需要额外的免死期。
   */
  _splitFruitOnWall(fruit, wall) {
    const childLvl = wallSplitChildLevel;
    const cr = levels[childLvl].radius;
    const count = Math.max(1, fruit.level + wallSplitCountOffset);
    const wallCx = wall.x + wall.w / 2;
    const offX = this.dividerX / 6;           // 半列宽 → 相邻格子的中心
    const gapY = cr * wallSplitStackGap;
    const px = fruit.x;
    const py = fruit.y;
    this.effects.push({ x: px, y: py, r: fruit.r, t: 0, dur: 0.35, color: '#ffd54f' });

    // 同侧的小水果共用同一条竖直线（无水平初速度）：格子净宽只够放下一颗，
    // 若各自随机偏移 / 初速，空中就会互相挤压并被推向隔板 → 反复撞死。
    const jx = (Math.random() * 2 - 1) * wallSplitJitter;
    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? -1 : 1;      // 左右交替
      const rank = Math.floor(i / 2);         // 同侧第几只 → 纵向错位
      const child = new Body(
        clamp(wallCx + side * offX + jx, cr, this.game.screenW - cr),
        py - rank * gapY,
        cr, childLvl, physicsDefaults
      );
      child.noMerge = true;                   // 分裂产物不允许再次合成
      child.mergeLock = 0.2;
      child.vy = -wallSplitLift;              // 小幅上抛，视觉上"炸开"
      this.world.add(child);
    }

    this.world.remove(fruit);
    this.game.audio.play('boom');
  }

  /**
   * 水果 ↔ 静态体（尸核 / 神器）接触结算。
   * 僵尸碰到静态体不结算（尸核舱里的小僵尸与尸核共存）。
   */
  _handleStaticTouch(fruit, stat) {
    if (fruit.dead) return;
    // ---- 神器：获得耦合卡牌的增益，神器与水果都消失 ----
    if (stat.isArtifact) {
      const card = this.cardSystem.grantCard(stat.cardId);
      this.effects.push({ x: stat.x, y: stat.y, r: stat.r, t: 0, dur: 0.45, color: '#f5c542' });
      this.world.remove(stat);
      this.artifacts = this.artifacts.filter(a => a !== stat);
      this._destroyFruit(fruit);
      showToast(`拾取神器：${card ? card.name : stat.cardName}！`);
      return;
    }
    // ---- 尸核：掉血 + 按伤害孵化小僵尸 + 水果被摧毁 ----
    if (stat.isCore) {
      const dmg = Math.round(fruit.r * fruitWallDamageMul);
      stat.hp -= dmg;
      this.effects.push({ x: fruit.x, y: fruit.y, r: fruit.r, t: 0, dur: 0.35, color: '#ff2d55' });
      this._spawnCoreZombies(dmg, fruit.x, fruit.y);
      this._destroyFruit(fruit);
      this.game.audio.play('boom');
      if (stat.hp <= 0 && !this.stageCleared) {
        stat.hp = 0;
        this._onCoreDestroyed();
      }
    }
  }

  /**
   * 尸核被水果砸中时孵化小僵尸：数量 = 本次伤害 / 每个小僵尸血量。
   * 从砸中点爬出（出生即带爬升力，给挖掘玩家施加反噬压力）。
   */
  _spawnCoreZombies(dmg, x, y) {
    const count = Math.max(1, Math.round(dmg / coreZombieHp));
    for (let i = 0; i < count; i++) {
      const zb = new Body(
        x + (Math.random() * 2 - 1) * 40,
        y + (Math.random() * 2 - 1) * 40,
        coreZombieRadius, 0, physicsDefaults
      );
      zb.isZombie = true;
      zb.climbAccel = effectiveClimbAccel(this.zombieClimbMul);
      this.world.add(zb);
    }
  }

  /** 尸核被摧毁 → 通关：停止出怪 + 横幅倒计时 → 线性流程收尾 */
  _onCoreDestroyed() {
    this.effects.push({ x: this.core.x, y: this.core.y, r: this.core.r * 1.6, t: 0, dur: 0.6, color: '#ff2d55' });
    this.world.remove(this.core);
    this.stageCleared = true;
    this.clearTimer = FINAL_CLEAR_DELAY;
    this.game.audio.play('boom');
    showToast('🎉 尸核被摧毁！');
  }

  // ---------------- 水果 ↔ 僵尸 碰撞结算 ----------------

  /**
   * 水果 ↔ 僵尸 的碰撞结算（物理引擎 onContact 回调）
   * ------------------------------------------------------------------
   * 静态体（尸核/神器）参与的对子优先路由到 _handleStaticTouch。
   * 其余规则：双方互扣对方的半径 —— 半径小的一方"归零"消亡：
   *   水果 ≥ 僵尸：僵尸消灭；水果扣除僵尸半径后存活（过小也一并消失），
   *               并被向上弹起 + 随机左右扰动（反向作用力）。
   *   水果 < 僵尸：水果消失；僵尸扣除水果半径后存活（过小也消灭），
   *               并被向下砸回 + 随机左右扰动。
   * 幸存的水果若还有分裂充能 → 在碰撞点分裂出低一级 4/5 大小的水果，
   * 其反作用力与母体"垂直相同、水平相反、大小相等"。
   */
  _handleContact(a, b) {
    // 静态体（尸核/神器）优先：水果撞上去走专属结算
    const stat = a.isStatic ? a : (b.isStatic ? b : null);
    if (stat) {
      const other = stat === a ? b : a;
      if (other.isStatic || other.isZombie || other.dead || stat.dead) return;
      this._handleStaticTouch(other, stat);
      return;
    }
    if (a.isZombie === b.isZombie) return; // 同类接触不结算
    const fruit = a.isZombie ? b : a;
    const zombie = a.isZombie ? a : b;
    if (fruit.dead || zombie.dead) return;

    const fr = fruit.r;
    const zr = zombie.r;
    const cx = (fruit.x + zombie.x) / 2;
    const cy = (fruit.y + zombie.y) / 2;

    if (fr >= zr) {
      // ---- 僵尸被砸死 ----
      this._destroyZombie(zombie, levels[zombie.level].score * zombieScoreMul);
      // 幸存水果：向上弹起 + 随机左右扰动
      const jx = (Math.random() * 2 - 1) * survivorJitter;
      fruit.vy = -fruitBounceSpeed;
      fruit.vx = jx;
      fruit.sleeping = false;
      // 水果半径相应减小
      const newR = fr - zr;
      if (newR < minSurviveRadius) {
        this._destroyFruit(fruit);
        return;
      }
      this.world.resize(fruit, newR);
      // ---- 分裂水果 ----
      if (this.splitCharges > 0 && fruit.level > 0) {
        this.splitCharges--;
        const childLvl = fruit.level - 1;
        const cr = levels[childLvl].radius * splitRadiusFactor;
        const child = new Body(cx, cy, cr, childLvl, physicsDefaults);
        child.mergeLock = 0.15;
        child.vy = fruit.vy;  // 垂直方向相同
        child.vx = -fruit.vx; // 水平方向相反、大小相等
        this.world.add(child);
      }
    } else {
      // ---- 水果被啃掉 ----
      this._destroyFruit(fruit);
      // 幸存僵尸：向下砸回 + 随机左右扰动
      zombie.vy += zombieKnockSpeed;
      zombie.vx += (Math.random() * 2 - 1) * survivorJitter;
      zombie.sleeping = false;
      const newR = zr - fr;
      if (newR < minSurviveRadius) {
        this._destroyZombie(zombie, levels[zombie.level].score * zombieScoreMul);
      } else {
        this.world.resize(zombie, newR);
      }
    }
  }

  // ---------------- 水果合成（弹药升级通道） ----------------

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
    // 回满血 + 随机驱散一半僵尸，保留分数继续战斗
    // （只统计未死亡的僵尸体——remove 只打标记，数组在下次 step 才清理）
    const zombies = this.world.bodies.filter(b => b.isZombie && !b.dead);
    for (const z of pickHalf(zombies)) {
      this.effects.push({ x: z.x, y: z.y, r: z.r, t: 0, dur: 0.3, color: '#ffffff' });
      this.world.remove(z);
    }
    this.hp = playerMaxHP;
    this.damageFlash = 0;
    this.dead = false;
    this.killCount = 0;
    this.coreHpShown = this.core.hp;
    this.timedEffects = [];
    this.zombieClimbMul = 1;
    this.spawnTimer = Math.max(this.spawnTimer, FIRST_SPAWN_DELAY);
    this.cardSystem.reset();
    if (!this.current && (this.spawnDelay === undefined || this.spawnDelay <= 0)) {
      this.spawnNew();
    }
    this.game.audio.startBgm('zombie');
    showToast('复活成功！血量回满，僵尸被驱散一半');
  }

  // ---------------- 更新 ----------------

  onUpdate(dt) {
    this.elapsed += dt;

    // 水果（弹药）等级上限成长
    this.fruitMaxLevel = Math.min(fruitMaxLevelCap, fruitMaxLevelStart + Math.floor(this.elapsed / fruitGrowEvery));

    // 尸核血条显示值缓动
    this.coreHpShown += (this.core.hp - this.coreHpShown) * Math.min(1, dt * 6);
    if (this.levelUpFlash > 0) this.levelUpFlash = Math.max(0, this.levelUpFlash - dt);

    if (this.cardSystem.active) return; // 选卡时暂停

    // 特效动画 & 卡牌定时效果
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter(e => e.t < e.dur);
    this._updateTimedEffects(dt);

    // 僵尸爬升力（支持冰冻卡实时调整，含新刷出的僵尸）+ 爬升终端速度封顶
    const climb = effectiveClimbAccel(this.zombieClimbMul);
    for (const b of this.world.bodies) {
      if (!b.isZombie) continue;
      b.climbAccel = climb;
      if (b.vy < -zombieMaxClimbSpeed) b.vy = -zombieMaxClimbSpeed;
    }

    // 物理步进（水果触底不再销毁，允许在地面堆积当"地雷"）
    this.world.step(dt);

    // 受击红闪衰减
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt);

    // 出怪（通关后停止）：普通波次（数量随时间增长）+ 概率方阵
    if (!this.stageCleared) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        if (Math.random() < phalanxChance) {
          this._spawnPhalanx();
        } else {
          const wave = this._spawnWaveCount();
          for (let i = 0; i < wave; i++) this._spawnZombie();
        }
        this.spawnTimer = this._spawnInterval();
      }
    }

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

    // 僵尸越线 → 扣血（等级越高扣越多），越线僵尸直接消散
    if (!this.dead) {
      for (const b of this.world.bodies) {
        if (!b.isZombie || b.dead) continue;
        if (b.y - b.r < this.warnY) {
          const dmg = b.level + zombieDamageBase;
          this.effects.push({ x: b.x, y: b.y, r: b.r, t: 0, dur: 0.35, color: '#ff3b30' });
          this.world.remove(b);
          this.hp -= dmg;
          this.damageFlash = 0.6;
          showToast(`僵尸越线！-${dmg} 血`);
          if (this.hp <= 0) {
            this.hp = 0;
            this.dead = true;
            this._gotoResult();
            return;
          }
        }
      }
    }

    // 通关横幅倒计时（尸核摧毁后触发，见 _onCoreDestroyed）
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
  _gotoResult(opts) {
    const g = this.game;
    if (this.score > g.bestScore) {
      g.bestScore = this.score;
      g.saveBest();
    }
    g.audio.stopBgm();
    g.states.push(g.createResultState(this, opts));
  }

  // ---------------- 渲染 ----------------

  onRender(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;

    applyPixelCtx(ctx);
    drawStageBg(ctx, W, H, this.floorY, 'zombie');

    const flash = this.damageFlash > 0 && Math.floor(Date.now() / 150) % 2 === 0;
    drawWarnLine(ctx, W, this.warnY, flash);
    if (this.damageFlash > 0) {
      ctx.save();
      ctx.globalAlpha = this.damageFlash * 0.3;
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    for (const w of this.world.walls) {
      if (w.destructible) {
        const frac = w.maxHp > 0 ? w.hp / w.maxHp : 0;
        const c1 = frac > 0.5 ? '#6b4a3a' : (frac > 0.25 ? '#5a3c30' : '#3e2a22');
        const c2 = frac > 0.5 ? '#8d6e63' : (frac > 0.25 ? '#7a5c50' : '#65483d');
        fillBrick(ctx, w.x, w.y, w.w, w.h, c1, c2);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        fillPixelText(ctx, String(Math.ceil(w.hp)), w.x + w.w / 2, w.y + w.h / 2 + 1, 20);
      } else {
        fillBrick(ctx, w.x, w.y, w.w, w.h, '#2e2e38', '#4a4a55');
      }
    }

    for (const a of this.artifacts) {
      if (!a.dead) drawArtifact(ctx, a.x, a.y, a.r, a.icon);
    }

    if (this.core && !this.core.dead) {
      drawZombieCore(ctx, this.core.x, this.core.y, this.core.r);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fillPixelText(ctx, String(Math.ceil(this.core.hp)), this.core.x, this.core.y + 1, 28);
    }

    for (const b of this.world.bodies) {
      if (b.isStatic) continue;
      if (b.isZombie) drawZombie(ctx, b.x, b.y, b.r, b.level);
      else drawBall(ctx, b.x, b.y, b.r, b.level);
    }

    if (this.current) {
      drawDropGuide(ctx, this.current.x, this.current.y, this.current.r, this.floorY, 'rgba(180,255,140,0.35)');
      drawBall(ctx, this.current.x, this.current.y, this.current.r, this.current.level);
    }

    for (const e of this.effects) drawPixelBurst(ctx, e);

    {
      const max = this.core ? this.core.maxHp : 1;
      const cur = Math.max(0, Math.ceil(this.core ? this.core.hp : 0));
      const pct = Math.round((cur / max) * 100);
      const shown = clamp(this.coreHpShown ?? max, 0, max);
      const pos = drawTopBar(
        ctx, g, W,
        shown / Math.max(1, max),
        '#d03040',
        `尸核 ${cur}/${max} (${pct}%)`,
        '#3d0a12'
      );
      const hy = pos.by + pos.bh + 12;
      const hh = 40;
      pixelBar(ctx, pos.bx, hy, pos.bw, hh, this.hp / playerMaxHP, palette.hp, 'rgba(20,16,28,0.55)');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#4a0f0f';
      fillPixelText(ctx, `血量 ${this.hp}/${playerMaxHP}`, pos.bx + pos.bw / 2, hy + hh / 2, 24);
    }

    this._renderPlayerLevelBadge(ctx);
    drawScoreChip(ctx, this.score);

    {
      const total = getCardTriggerCount('fruitVsZombie', this.game.playerLevel);
      const cur = Math.min(this.killCount, total);
      drawCardProgress(ctx, W, `击杀抽卡进度 ${cur}/${total}`, cur, total, true);
    }

    drawNextChip(ctx, W, this.nextLevel);

    if (this.stageCleared) {
      const secs = Math.ceil(this.clearTimer);
      const tip = g.hasNextStage(this.stageId)
        ? `下一阶段 将在 ${secs} 秒后开始`
        : `将在 ${secs} 秒后进入结算`;
      drawBanner(ctx, W, H, '恭喜通关！', tip, '#8ee66f');
    }

    this.adBtn.render(ctx);
    this.payBtn.render(ctx);
    this.settingsBtn.render(ctx);
    if (this.debugBtn) this.debugBtn.render(ctx);
    this.settings.render(ctx);
    this.cardSystem.render(ctx);
    g.payModal.render(ctx);
  }

  /** 尸核血条填充宽度（纯计算，便于测试） */
  _coreBarFillWidth(bw) {
    const max = this.core ? this.core.maxHp : 1;
    const cur = clamp(this.coreHpShown ?? max, 0, max);
    if (cur <= 0) return 0;
    return Math.min(bw, Math.max(6, bw * (cur / max)));
  }

  /**
   * 渲染 Lv.X 徽标（左上角，与右上角 ⚙ 对称；升级时弹一下 + 高亮）。
   * 与 fruitMergeState 的同名方法布局一致，跨阶段共享视觉。
   */
  _renderPlayerLevelBadge(ctx) {
    drawLevelBadge(ctx, this.game, this.levelUpFlash || 0);
  }

  // ---------------- 触摸 ----------------
  // （与第一阶段同款：设置弹窗 / 卡牌面板优先，UI 按钮次之，
  //   其余任意位置抬起即投放水果 —— _dropCurrent 支持多重射击并排发射）

  onTouchStart(t) {
    if (this.settings.handleTouch('start', t)) return;
    if (this.game.payModal.handleTouch('start', t)) return;
    if (this.cardSystem.handleTouch('start', t)) return;
    this.settingsBtn.handleTouch('start', t);
    this.adBtn.handleTouch('start', t);
    this.payBtn.handleTouch('start', t);
    if (this.debugBtn) this.debugBtn.handleTouch('start', t);
  }

  onTouchMove(t) {
    if (this.settings.handleTouch('move', t)) return;
    if (this.game.payModal.handleTouch('move', t)) return;
    if (this.cardSystem.handleTouch('move', t)) return;
    this.touchX = t.x;
  }

  onTouchEnd(t) {
    if (this.settings.handleTouch('end', t)) return;
    if (this.game.payModal.handleTouch('end', t)) return;
    if (this.cardSystem.handleTouch('end', t)) return;
    // UI 按钮优先，其余任意位置抬起即投放
    if (this.settingsBtn.handleTouch('end', t)) return;
    if (this.adBtn.handleTouch('end', t)) return;
    if (this.payBtn.handleTouch('end', t)) return;
    if (this.debugBtn && this.debugBtn.handleTouch('end', t)) return;
    this.touchX = t.x;
    this._dropCurrent();
  }
}
