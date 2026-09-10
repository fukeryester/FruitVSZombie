/**
 * 第一阶段局内状态（FruitMergeState / 水果合成）
 * ------------------------------------------------------------------
 * 核心循环：移动 → 释放 → 物理结算 → 同级合成 → 越线判定 → 下一轮。
 * 创新点：每完成 (base + (等级-1)*step) 次合成触发三选一选卡（队列化，逐次弹出）；
 *        每次触发抽卡会让 game.playerLevel +1，下一次阈值同步上抬。
 *          阈值可配置、可局内热更新（顶部进度条 UI 实时跟随）。
 * 阶段晋级：分数达到 stageScoreGoal 后弹出横幅提示，3 秒后切换到
 *          第二阶段 FruitVsZombieState（水果大战僵尸），携带当前分数。
 */
import { BaseState } from '../core/stateMachine.js';
import { PhysicsWorld, Body } from '../core/physics.js';
import { Button, SettingsModal, showToast, clearToasts } from '../ui/widgets.js';
import { makePayButton } from '../ui/payModal.js';
import { watchRewardAd } from '../core/adApi.js';
import { CardSystem } from '../cards/index.js';
import { levels, spawnPoolSize, physicsDefaults } from '../config/balls.js';
import { stageScoreGoal, stageTip } from '../config/stages.js';
import { isDebugBuild } from '../config/debug.js';
import { getCardTriggerCount } from '../config/level.js';
import { drawBall } from '../ui/ballRenderer.js';
import { applyPixelCtx, drawPixelBurst, palette } from '../ui/pixel.js';
import { drawStageBg, drawWarnLine, drawDropGuide, drawScoreChip, drawNextChip, drawLevelBadge, drawCardProgress, drawTopBar, drawBanner } from '../ui/hud.js';
import { drawRemoteLauncher, drawSelfLauncherRing, drawTeamPanel } from '../ui/netHud.js';
import { weightedLevelIndex, clamp, pickHalfExcludingMax } from '../core/utils.js';
import { StageSync } from '../net/stageSync.js';
import { recordMerge } from '../core/runStats.js';
import { teamGoalScale, MAX_PLAYERS } from '../config/net.js';

/**
 * 越线判定：球被判定为"弹道飞行"的速度阈值（px/s）。
 * 超过该速度说明球是被连锁合成顶飞的（会自行落回），不计入越线时长。
 */
const FLIGHT_SPEED = 1346;

/** 达标后延迟多少秒切换到第二阶段（横幅倒计时） */
export const PROMOTE_DELAY = 3;

export default class FruitMergeState extends BaseState {
  /** 线性关卡流程中的阶段 id（main.stageFlow 按此定位下一阶段） */
  get stageId() { return 'fruitMerge'; }

  onEnter() {
    // 防御性清 Toast：跨阶段时若上一阶段的 Toast 还挂着，未清理的"升级提示"
    // 会持续显示在屏幕上 → 进新阶段前清掉，保持画面独立干净
    clearToasts();
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;
    // 等级每阶段独立：从大厅或上一阶段进入时回到 Lv.1（分数共享，等级独立）
    g.resetPlayerLevel();
    this.score = 0;
    this.dead = false;

    // ---- 联机（单机时 sync.online 恒为 false，下面所有分支自动短路）----
    this.sync = new StageSync(this, this.stageId);
    this.mySeat = this.sync.mySeat;
    /** 每个座位的实时得分（单机只有 0 号位）；this.score 是全队合计 */
    this.seatScores = new Array(MAX_PLAYERS).fill(0);
    const pending = g.net && g.net.pendingStage;
    if (this.sync.isGuest && pending && pending.id === this.stageId) {
      this.seatScores = pending.seatScores.slice();
      g.net.pendingStage = null;
    }
    /** 阶段目标分：联机时按人数放大，保证人均投入与单机一致 */
    this.goal = Math.round(stageScoreGoal * teamGoalScale(this.sync.playerCount));

    // 场地：左右墙 + 地面，警戒线
    this.floorY = H - 20;
    this.warnY = 327; // 警戒线高度（750 设计基准，原 390 时代的 170 × 1.92）
    this.world = new PhysicsWorld(
      { left: 0, right: W, top: 0, bottom: this.floorY },
      (a, b) => this._handleMerge(a, b)
    );

    // 投放（注意：forcedQueue 必须先于 _randLevel 初始化，否则 _randLevel 读取 undefined.length 抛异常）
    this.dropY = 212;
    this.current = null;
    this.forcedQueue = []; // 卡片 buff：接下来 N 个强制等级
    this.nextLevel = this._randLevel();
    this.dropped = false;  // 本局是否已投放过（首个球投放后才开始越线计时）
    this.spawnNew();

    // 越线判定
    this.violationTimer = 0;
    this.VIOLATION_LIMIT = 1.2; // 连续停留在警戒线以上 1.2s 判负

    // 合成计数：阈值随 playerLevel 自动变苛（getCardTriggerCount 在 level.js）
    this.mergeCount = 0;
    // 等级升级闪动计时（> 0 时右上角 Lv. 徽标短暂高亮）
    this.levelUpFlash = 0;
    // 分数进度条的显示值（向真实分数缓动，让每次得分都有可见推进）
    this.scoreBarShown = 0;

    // 阶段晋级：分数达标 → 横幅倒计时 → 切换第二阶段
    this.promoted = false;
    this.promoteTimer = 0;

    // 特效：合成光环
    this.effects = [];

    // 定时效果（卡牌 buff 等）：{ left, interval, acc, tick, onEnd }
    this.timedEffects = [];

    // 卡牌系统：内聚选卡队列 / 工厂 / 浮层，本状态只调 API
    // ctx 门面：卡牌效果仅通过这些接口作用于局内，见 cardSystem.js 顶部注释
    this.cardSystem = new CardSystem(g, {
      getBodies: () => this.world.bodies.slice(),
      removeBody: (b) => this.world.remove(b),
      resizeBody: (b, r) => this.world.resize(b, r),
      // 卡牌得分归属选出这张卡的玩家（applyingSeat 由 CardSystem 在结算时设置）
      addScore: (n) => this._award(n, this.cardSystem.applyingSeat),
      addEffect: (e) => this._burst(e),
      toast: (text) => this._toast(text),
      playSound: (name) => g.audio.play(name),
      forceDrops: (levelIndex, count) => {
        for (let i = 0; i < count; i++) this.forcedQueue.push(levelIndex);
        this.nextLevel = this._randLevel(); // 立即刷新"下一个"预览
      },
      isFieldCalm: () => this.world.bodies.every(b => Math.abs(b.vy) < 420),
      // 定时效果：卡牌只需描述"多久、多久触发一次、每次做什么、结束时还原什么"
      //   { dur 秒, interval 秒（0=每帧）, tick 每次回调, onEnd 结束回调 }
      startTimedEffect: (opts) => this.startTimedEffect(opts),
      // 关闭/恢复球与球之间的碰撞（保留地面与墙壁）
      setBodyCollision: (on) => {
        this.world.noBodyCollide = !on;
        this.world.wakeAll(); // 两种情况都要唤醒：关闭碰撞要让休眠的球坠落
      },
      // 给场上所有球施加随机力（方向与大小随机）
      applyRandomForces: (minMag, maxMag) => {
        for (const b of this.world.bodies) {
          const a = Math.random() * Math.PI * 2;
          const m = minMag + Math.random() * (maxMag - minMag);
          b.vx += Math.cos(a) * m;
          b.vy += Math.sin(a) * m;
        }
        this.world.wakeAll();
      }
    }, null, this.sync);

    // UI
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
      // 局内退出：放弃本局回大厅
      onExitGame: () => {
        g.audio.stopBgm();
        g.states.switchTo(g.createLobbyState());
      }
    });
    this.settings.setExitLabel('退出本局（回大厅）');

    // 调试包体（开发者工具/体验版）专属：左下角"跳到下一阶段"按钮，
    // 正式包（envVersion === 'release'）不创建、不渲染、不响应触摸。
    this.debugBtn = this._makeDebugSkipButton();

    g.runStats.markStage(this.stageId);

    // 联机：接管报文；host 顺带通知全房间切到本阶段（附带继承分数）
    this.sync.onEnter();
    if (this.sync.isHost) this.sync.announceStage(0);

    g.audio.startBgm('merge');
  }

  /** 从结算层 pop 回来（看广告复活）：重新接管报文 */
  onResume() {
    this.sync.attach();
  }

  // ---------------- 联机同步钩子 ----------------

  /** 本阶段没有场地结构，guest 不需要额外描述 */
  buildArenaDesc() { return null; }
  applyArenaDesc() {}

  /** host 给某个投射口摇一个新水果等级 */
  rollLauncherLevel() { return this._randLevel(); }

  /** 阶段自有字段：guest 的 HUD 全靠它 */
  collectExtra() {
    return {
      vt: Math.round((this.violationTimer || 0) * 100) / 100,
      mc: this.mergeCount,
      lv: this.game.playerLevel,
      pr: this.promoted ? 1 : 0,
      pt: Math.round((this.promoteTimer || 0) * 10) / 10,
      dr: this.dropped ? 1 : 0,
      gl: this.goal
    };
  }

  applyExtra(x) {
    this.violationTimer = x.vt || 0;
    this.mergeCount = x.mc || 0;
    this.game.playerLevel = x.lv || 1;
    this.promoted = !!x.pr;
    this.promoteTimer = x.pt || 0;
    this.dropped = !!x.dr;
    if (x.gl) this.goal = x.gl;
  }

  /** 加分（联机时按投放者归属到座位） */
  _award(n, seat) {
    if (!n) return;
    const s = seat == null || seat < 0 ? this.mySeat : seat;
    this.score += n;
    this.seatScores[s] = (this.seatScores[s] || 0) + n;
  }

  /** 播一个爆点特效，联机时同步给其他人 */
  _burst(e) {
    this.effects.push(e);
    this.sync.pushBurst(e);
  }

  /** 弹一条提示，联机时同步给其他人 */
  _toast(text) {
    showToast(text);
    this.sync.pushToast(text);
  }

  /** guest 收到 host 同步过来的提示 */
  onNetToast(text) {
    showToast(text);
  }

  /** 调试跳段按钮：有下一阶段 → 直接晋级；已是最终关 → 直接进结算 */
  _makeDebugSkipButton() {
    if (!isDebugBuild()) return null;
    const g = this.game;
    return new Button({
      x: 30, y: g.screenH - 150, w: 220, h: 96,
      text: g.hasNextStage(this.stageId) ? '⏭ 下一阶段' : '⏭ 跳到结算',
      bgColor: 'rgba(90,60,170,0.78)', fontSize: 34,
      onTap: () => this._debugSkip()
    });
  }

  /** 调试用：跳过当前阶段（记录最佳分；无倒计时立即切换） */
  _debugSkip() {
    if (this.dead) return;
    const g = this.game;
    if (this.score > g.bestScore) {
      g.bestScore = this.score;
      g.saveBest();
    }
    this.promoted = true;
    this.promoteTimer = 0;
    const next = g.createNextStageState(this.stageId, this.score);
    if (next) g.states.switchTo(next);
    else this._gotoResult({ win: true }); // 配置上已是最终关：直接结算
  }

  onExit() {
    // 清 Toast：防止"升级 / 合成终极水果"等提示残留到下一阶段（或大厅）
    clearToasts();
    this.sync.onExit();
    this.game.audio.stopBgm();
  }

  // ---------------- 投放 ----------------

  _randLevel() {
    if (this.forcedQueue.length) return this.forcedQueue.shift();
    // 受控随机：场上存在最高等级的前 spawnPoolSize 级
    let maxOnField = 0;
    for (const b of this.world.bodies) maxOnField = Math.max(maxOnField, b.level);
    const pool = Math.min(spawnPoolSize, maxOnField + 2);
    return weightedLevelIndex(Math.max(2, pool));
  }

  spawnNew() {
    const lvl = this.nextLevel;
    this.nextLevel = this._randLevel();
    this.current = new Body(
      clamp(this.current ? this.current.x : this.game.screenW / 2, levels[lvl].radius, this.game.screenW - levels[lvl].radius),
      this.dropY,
      levels[lvl].radius,
      lvl,
      physicsDefaults
    );
    this.touchX = this.current.x;
  }

  _dropCurrent() {
    if (!this.current || this.cardSystem.active) return;
    if (this.sync.isGuest) {
      // guest 不生成刚体：把投放请求发给 host，本地先把球收起来（即时反馈），
      // 真正的水果会随下一帧快照出现。
      this.sync.guestSendInput(0, this.current.x, true);
      this.current = null;
      return;
    }
    this.spawnDrop(this.current.x, this.current.level, this.mySeat);
    this.current = null;
    // 延迟生成下一个，给物理一点结算时间
    this.spawnDelay = 0.35;
  }

  /**
   * 真正把水果放进世界（host / 单机）。
   * @param {number} x 投放横坐标
   * @param {number} level 水果等级
   * @param {number} seat 投放者座位（决定这颗水果之后打出的分算谁的）
   */
  spawnDrop(x, level, seat) {
    const r = levels[level].radius;
    const b = new Body(
      clamp(x, r, this.game.screenW - r),
      this.dropY, r, level, physicsDefaults
    );
    b.owner = seat;
    this.world.add(b);
    this.dropped = true;
    this.game.runStats.add(seat, 'drops', 1);
    return b;
  }

  // ---------------- 合成 ----------------

  _handleMerge(a, b) {
    const g = this.game;
    // 合成收益归属：谁投的水果参与了合成就算谁的（两颗都有主时取先手那颗）
    const owner = a.owner != null ? a.owner : b.owner;
    recordMerge(this.game, owner, Math.min(a.level + 1, levels.length - 1));
    if (a.level >= levels.length - 1) {
      // 终极球合成：直接消除并给分（两个大西瓜消失）
      this._destroy(a, levels[a.level].score, owner);
      this._destroy(b, levels[b.level].score, owner);
      this._toast('合成终极水果！');
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
    nb.owner = owner;
    this._award(cfg.score, owner);
    g.audio.play('boom');
    this._burst({ x, y, r: cfg.radius, t: 0, dur: 0.35, color: cfg.color });

    // 创新点：合成行为计数，阈值 = base + (等级-1)*step；
    //   每次触发抽卡 → 等级 +1 → 下一次阈值同步上抬。
    //   联机时计的是**全队**的合成次数，抽卡也是全队一起抽。
    this.mergeCount++;
    const need = getCardTriggerCount('fruitMerge', g.playerLevel);
    if (this.mergeCount >= need) {
      this.mergeCount = 0;
      g.playerLevel++;
      this.levelUpFlash = 0.9;
      this.cardSystem.trigger();
      this._toast(`Lv.${g.playerLevel}！`);
    }
  }

  _destroy(body, scoreGain, seat) {
    this.world.remove(body);
    if (scoreGain) this._award(scoreGain, seat == null ? body.owner : seat);
  }

  // ---------------- 卡牌 ----------------
  // 卡牌效果的具体实现见 js/cards/ 下的派生类，
  // 本状态只负责把局内能力以 ctx 门面的形式注入 CardSystem。

  /**
   * 注册一个定时效果（供卡牌通过 ctx.startTimedEffect 调用）
   * @param {Object} opts { dur 持续秒数, interval 触发间隔秒（0=每帧）, tick 触发回调, onEnd 结束回调 }
   */
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
    // 随机消除一半水果（场上最高等级的水果不参与），保留分数，重新开始
    const bodies = this.world.bodies.slice();
    if (bodies.length) {
      for (const v of pickHalfExcludingMax(bodies)) {
        this._burst({ x: v.x, y: v.y, r: v.r, t: 0, dur: 0.3, color: '#ffffff' });
        this.world.remove(v);
      }
    }
    this.violationTimer = 0;
    this.dead = false;
    // 复活后必须清空每个球的越线计时，否则残留的高位球会立刻再次判负
    for (const b of this.world.bodies) b.overLineTime = 0;
    this.mergeCount = 0; // 复活重新累积合成进度
    this.scoreBarShown = this.score; // 复活保留分数，进度条同步（不重播动画）
    this.timedEffects = []; // 清掉残留的卡牌定时效果
    this.world.noBodyCollide = false;
    this.cardSystem.reset();
    if (!this.current && (this.spawnDelay === undefined || this.spawnDelay <= 0)) {
      this.spawnNew();
    }
    this.game.audio.startBgm('merge');
    this._toast('复活成功！已消除一半水果');
  }

  // ---------------- 更新 ----------------

  onUpdate(dt) {
    // 进度条显示值缓动（放在暂停分支之前：选卡时也能播完动画）
    this.scoreBarShown += (this.score - this.scoreBarShown) * Math.min(1, dt * 6);
    if (this.levelUpFlash > 0) this.levelUpFlash = Math.max(0, this.levelUpFlash - dt);
    // 选卡投票的倒计时必须在暂停期间照常推进，否则 5 秒到点没人收口
    this.cardSystem.tick(dt);

    // guest：不跑物理，只做「插值渲染 + 本地投射口 + 上报输入」
    if (this.sync.isGuest) {
      this._guestUpdate(dt);
      return;
    }

    if (this.cardSystem.active) {
      // 暂停期间照常发快照，保证 guest 那边的世界与 HUD 不会漂
      this.sync.hostTick(dt);
      return;
    }

    // 合成特效动画
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter(e => e.t < e.dur);

    // 卡牌定时效果（穿透 / 随机力等）
    this._updateTimedEffects(dt);

    // 物理步进
    this.world.step(dt);

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

    // 其他玩家的投射口（冷却推进 + 落实他们的投放请求）
    this.sync.hostUpdateLaunchers(dt);

    // 选卡队列：由卡牌系统内部决定何时弹出下一张
    this.cardSystem.update();

    // 越线判定：改为"连续停留在警戒线以上"计时，不再依赖瞬时静止。
    // 旧逻辑要求 |vy| < 60，但深堆里的球会持续抖动（求解残留 + 滚动），
    // 只有被挤到屏幕顶部、被顶部约束把 vy 归零时才满足 → 表现就是
    // "水果必须穿过手机顶部才判负"。
    if (this.dropped && !this.dead) {
      let maxOver = 0;
      for (const b of this.world.bodies) {
        const above = b.y - b.r < this.warnY;
        if (above && Math.abs(b.vy) < FLIGHT_SPEED) {
          b.overLineTime = (b.overLineTime || 0) + dt; // 线上且非弹道飞行 → 累计
        } else if (!above) {
          b.overLineTime = 0;                          // 落回线下 → 清零
        } else {
          b.overLineTime = Math.max(0, (b.overLineTime || 0) - dt); // 被顶飞 → 快速衰减，避免误判
        }
        if ((b.overLineTime || 0) > maxOver) maxOver = b.overLineTime;
      }
      this.violationTimer = maxOver; // 供 UI 闪红警示
      if (maxOver >= this.VIOLATION_LIMIT) {
        this.dead = true;
        this._gotoResult();
      }
    }

    // ---- 阶段晋级：分数达标 → 横幅倒计时 → 切换第二阶段 ----
    // （倒计时期间照常游玩；期间死亡则按普通失败处理，不再晋级）
    if (!this.promoted && !this.dead && this.score >= this.goal) {
      this.promoted = true;
      this.promoteTimer = PROMOTE_DELAY;
      this.game.audio.play('boom');
      this._toast('成功晋级下一阶段！');
    }
    if (this.promoted && !this.dead && this.promoteTimer > 0) {
      this.promoteTimer -= dt;
      if (this.promoteTimer <= 0) {
        this.promoteTimer = 0;
        this._advanceStage();
        return;
      }
    }

    this.sync.hostTick(dt);
  }

  /**
   * guest 的每帧：世界完全由 host 下发，这里只做三件事 ——
   *   1. 把插值后的刚体写回 world（渲染代码照旧读 world.bodies）；
   *   2. 本地投射口跟手（不等 RTT，手感与单机一致）；
   *   3. 把投射口横坐标上报给 host。
   */
  _guestUpdate(dt) {
    for (const e of this.effects) e.t += dt;
    this.effects = this.effects.filter((e) => e.t < e.dur);
    this.sync.guestSync();
    this._guestLauncher(dt);
  }

  _guestLauncher(dt) {
    const W = this.game.screenW;
    const mine = this.sync.mine;
    this.nextLevel = mine.next | 0;
    if (!mine.ready) {
      this.current = null;
    } else {
      if (!this.current || this.current.level !== mine.level) {
        const r = levels[mine.level].radius;
        this.current = new Body(
          clamp(this.touchX ?? W / 2, r, W - r), this.dropY, r, mine.level, physicsDefaults
        );
      }
      const r = this.current.r;
      const target = clamp(this.touchX ?? this.current.x, r, W - r);
      this.current.x += (target - this.current.x) * Math.min(1, dt * 18);
      this.current.y = this.dropY;
    }
    this.sync.guestSendInput(dt, this.current ? this.current.x : (this.touchX ?? W / 2), false);
  }

  /** 晋级收尾：走线性关卡流程（有下一关切换过去，否则按通关进结算） */
  _advanceStage() {
    const g = this.game;
    if (this.score > g.bestScore) {
      g.bestScore = this.score;
      g.saveBest();
    }
    const next = g.createNextStageState(this.stageId, this.score);
    if (next) {
      // 各座位的累计分要带进下一阶段（下一阶段 onEnter 会取走）
      g.carrySeatScores = this.seatScores.slice();
      g.states.switchTo(next);
    } else {
      this._gotoResult({ win: true });
    }
  }

  /** 死亡/通关 → 压入结算层（记录最佳分数；host 同时把结果广播给全队） */
  _gotoResult(opts) {
    const g = this.game;
    if (this.score > g.bestScore) {
      g.bestScore = this.score;
      g.saveBest();
    }
    g.audio.stopBgm();
    const rows = this.sync.scoreRows(this.seatScores);
    if (this.sync.isHost) this.sync.announceResult(opts, rows);
    g.states.push(g.createResultState(this, { ...opts, rows }));
  }

  /** guest 收到 host 下发的结算结果 */
  onNetResult(data) {
    const g = this.game;
    this.dead = !data.w;
    g.audio.stopBgm();
    // 本局战绩只有 host 记过账，用它下发的表覆盖本地
    g.runStats.decode(data.rs);
    g.states.push(g.createResultState(this, { win: !!data.w, rows: data.rows || [] }));
  }

  // ---------------- 渲染 ----------------

  onRender(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;

    applyPixelCtx(ctx);
    drawStageBg(ctx, W, H, this.floorY, 'merge');

    const violationRatio = this.violationTimer / this.VIOLATION_LIMIT;
    const flash = violationRatio > 0 && Math.floor(Date.now() / 200) % 2 === 0;
    drawWarnLine(ctx, W, this.warnY, flash);
    if (violationRatio > 0) {
      ctx.save();
      ctx.globalAlpha = 0.12 + violationRatio * 0.18;
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(0, 0, W, this.warnY);
      ctx.restore();
    }

    for (const b of this.world.bodies) drawBall(ctx, b.x, b.y, b.r, b.level);

    if (this.current) {
      drawDropGuide(ctx, this.current.x, this.current.y, this.current.r, this.floorY, 'rgba(42,24,16,0.35)');
      drawBall(ctx, this.current.x, this.current.y, this.current.r, this.current.level);
      if (this.sync.online) {
        drawSelfLauncherRing(ctx, this.current.x, this.current.y, this.current.r, this.mySeat);
      }
    }

    for (const e of this.effects) drawPixelBurst(ctx, e);

    this._renderPlayerLevelBadge(ctx);

    {
      const goal = this.goal;
      const cur = Math.min(this.scoreBarShown ?? this.score, goal);
      drawTopBar(
        ctx, g, W,
        Math.min(1, cur / Math.max(1, goal)),
        '#f0a020',
        stageTip(this.score, goal),
        '#3a2010'
      );
    }

    drawScoreChip(ctx, this.score);

    {
      const total = getCardTriggerCount('fruitMerge', g.playerLevel);
      const cur = Math.min(this.mergeCount, total);
      drawCardProgress(ctx, W, `合成抽卡进度 ${cur}/${total}`, cur, total, true);
    }

    drawNextChip(ctx, W, this.nextLevel);
    this._renderNetHud(ctx, W);

    if (this.promoted) {
      const secs = Math.ceil(this.promoteTimer);
      drawBanner(ctx, W, H, '成功晋级！', `水果大战僵尸 将在 ${secs} 秒后开始`, palette.gold);
    }

    this.adBtn.render(ctx);
    this.payBtn.render(ctx);
    this.settingsBtn.render(ctx);
    if (this.debugBtn) this.debugBtn.render(ctx);
    this.settings.render(ctx);
    this.cardSystem.render(ctx);
    g.payModal.render(ctx);
  }

  /**
   * 联机 HUD：其他玩家的投射口 + 队伍计分板（单机什么都不画）。
   * 必须在分数圈 / 下一个 / 抽卡进度之后画 —— 那几块 HUD 是不透明的，
   * 先画投射口会被它们盖掉（投放线 dropY 正好穿过它们）。
   */
  _renderNetHud(ctx, W) {
    if (!this.sync.online) return;
    // 位置来自快照插值，所以远端投射口的移动是平滑的
    for (const L of this.sync.remoteViews()) {
      drawRemoteLauncher(ctx, L, this.dropY, this.floorY, this.sync.nameOf(L.seat), W);
    }
    drawTeamPanel(
      ctx, W,
      this.sync.scoreRows(this.seatScores),
      this.sync.statusText(),
      this.sync.warning
    );
  }

  _scoreBarFillWidth(bw) {
    const goal = this.goal;
    const cur = Math.min(this.scoreBarShown ?? this.score, goal);
    if (cur <= 0) return 0;
    return Math.min(bw, Math.max(6, bw * (cur / goal)));
  }

  _renderPlayerLevelBadge(ctx) {
    drawLevelBadge(ctx, this.game, this.levelUpFlash || 0);
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _drawBall(ctx, x, y, r, level) {
    drawBall(ctx, x, y, r, level);
  }

  // ---------------- 触摸 ----------------

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
    // UI 按钮优先
    if (this.settingsBtn.handleTouch('end', t)) return;
    if (this.adBtn.handleTouch('end', t)) return;
    if (this.payBtn.handleTouch('end', t)) return;
    if (this.debugBtn && this.debugBtn.handleTouch('end', t)) return;
    // UI 按钮优先，其余任意位置抬起即投放
    this.touchX = t.x;
    this._dropCurrent();
  }
}
