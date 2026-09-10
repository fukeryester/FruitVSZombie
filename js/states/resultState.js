/**
 * 结算状态（ResultState）—— 压在冻结的局内层之上
 * ------------------------------------------------------------------
 * 展示：本局得分、排行榜排位（以昵称为主键的真实成绩榜）、新纪录提示。
 * 联机时额外展示「本局四人各自得分」，并把这几个人的成绩一起写进榜单。
 * 按钮：退出回大厅 / 看广告复活（逗留 ≥5s 才能复活；否则短提示退回结算）。
 *
 * 复活在联机里是**全队复活**：只有主机能直接复活，客机点复活会向主机
 * 发一条请求，主机复活成功后广播 REVIVED，各客机再弹掉自己的结算层。
 */
import { BaseState } from '../core/stateMachine.js';
import { Button, showToast } from '../ui/widgets.js';
import { watchRewardAd, AD_UNIT_ID } from '../core/adApi.js';
import { makePayButton } from '../ui/payModal.js';
import { getRank, submitScores } from '../core/leaderboard.js';
import { applyPixelCtx, fillPixelText, pixelPanel, palette } from '../ui/pixel.js';
import { drawStageBg } from '../ui/hud.js';
import { seatColor } from '../config/net.js';

const AD_MIN_DWELL_MS = 5000;

export default class ResultState extends BaseState {
  /**
   * @param playing 压栈时仍存活的局内状态（复活时直接恢复）
   * @param opts    { win, rows } —— win 为通关结算（隐藏复活入口）；
   *                rows 是联机计分板 [{ seat, name, score, you, host }]
   */
  constructor(game, playing, opts) {
    super(game);
    this.playing = playing;
    this.win = !!(opts && opts.win);
    this.rows = (opts && opts.rows) || [];
  }

  onEnter() {
    const playing = this.playing;
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;

    // 计分板行是 host 算好后广播下来的，里面的 you 标记是**他**的视角；
    // 到了 guest 这边必须按自己的座位重算，否则「（我）」会标到房主头上。
    if (this.online && this.rows.length) {
      const mySeat = this.sync.mySeat;
      this.rows = this.rows.map((r) => ({ ...r, you: r.seat === mySeat }));
    }

    // ---- 成绩入榜：昵称是主键；联机时把全房间的成绩一起合并进来 ----
    const myName = g.playerName;
    const myScore = this.online ? this._myRowScore() : playing.score;
    if (this.rows.length) {
      submitScores(this.rows.map((r) => ({ name: r.name, score: r.score })));
    }
    this.rankInfo = getRank(myName, myScore);
    this.myScore = myScore;
    this.isNewBest = myScore >= g.bestScore && myScore > 0;

    // ---- 平台统计 / 成就 / 排行榜：一局只在这里出网一次 ----
    this.run = g.runStats.forSeat(this.online ? this.sync.mySeat : 0);
    // 联机冠军 = 计分板第一名（rows 已按分数降序），单机不算
    const champion = this.online && this.rows.length > 0 && this.rows[0].you;
    this.reported = g.progress.reportRun(this.run, {
      score: myScore,
      win: this.win,
      champion
    });

    const btnW = Math.min(420, W - 100);
    const y0 = H * 0.56;
    // 通关结算没有"复活"一说，只有失败才提供看广告复活 / 氪金
    this.reviveBtn = this.win ? null : new Button({
      x: (W - btnW) / 2,
      y: y0,
      w: btnW,
      h: 88,
      text: this.online ? '📺 看广告救全队' : '📺 看广告复活',
      bgColor: '#e8a20c',
      fontSize: 36,
      onTap: () => this._tryRevive()
    });
    this.payBtn = this.win ? null : makePayButton(g, (W - btnW) / 2, y0 + 100, btnW, 72, 32);
    this.exitBtn = new Button({
      x: (W - btnW) / 2,
      y: this.win ? y0 : y0 + 188,
      w: btnW,
      h: 88,
      text: this.win ? '🏠 回到大厅' : '退出回大厅',
      bgColor: '#8a6d9e',
      fontSize: 36,
      onTap: () => this._exit()
    });
    this.busy = false;
    this.waitingRevive = false;
    // 结算层压上来会触发局内层 onExit → 断开报文。但客机还得听「有人复活全队」
    // 和主机的快照，所以这里替局内层重新接上（attach 是幂等的）。
    if (this.online) this.sync.attach();
    g.audio.startBgm(this.win ? 'resultWin' : 'resultFail');
  }

  get sync() {
    return this.playing.sync || null;
  }

  get online() {
    return !!(this.sync && this.sync.online);
  }

  _myRowScore() {
    const seat = this.sync.mySeat;
    const row = this.rows.find((r) => r.seat === seat);
    return row ? row.score : this.playing.score;
  }

  onExit() {
    this.game.audio.stopBgm();
  }

  /**
   * 退出。联机时不断连接：把会话退回「房间」阶段并回到房间界面，
   * 四个人就能原地再来一局，不用重新建房 / 报房间号。
   */
  _exit() {
    const g = this.game;
    if (this.online) {
      this.sync.detach();
      g.net.endMatch();
      g.states.switchTo(g.createRoomState());
      return;
    }
    g.states.switchTo(g.createLobbyState());
  }

  async _tryRevive() {
    if (this.busy || this.waitingRevive) return;
    this.busy = true;
    const res = await watchRewardAd(AD_MIN_DWELL_MS);
    this.busy = false;
    if (!res.ok) {
      showToast(res.reason === 'open_fail' ? '无法打开页面，复活失败' : '观看广告未满 5 秒，无法复活');
      return;
    }
    // 联机：客机没有权限改世界，只能请主机复活全队，等 REVIVED 再回战场
    if (this.online && this.sync.isGuest) {
      this.waitingRevive = true;
      this.sync.requestRevive();
      showToast('已请求主机复活全队…');
      return;
    }
    const g = this.game;
    g.states.pop(); // 弹出结算层，重新激活局内层
    this.playing.revive();
  }

  onRender(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;

    applyPixelCtx(ctx);
    drawStageBg(ctx, W, H, null, this.win ? 'resultWin' : 'resultFail');
    ctx.fillStyle = 'rgba(8,4,16,0.32)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    pixelPanel(ctx, W / 2 - 300, H * 0.10, 600, H * 0.40, { fill: '#241830', border: 6 });

    ctx.fillStyle = this.win ? '#8ee66f' : '#ff8a9b';
    fillPixelText(ctx, this.win ? '恭喜通关' : '游戏结束', W / 2, H * 0.155, 48);

    ctx.fillStyle = palette.gold;
    fillPixelText(ctx, String(this.myScore), W / 2, H * 0.255, 72);
    ctx.fillStyle = 'rgba(255,247,232,0.75)';
    fillPixelText(ctx, this.online ? `${g.playerName} 本局得分` : '本局得分', W / 2, H * 0.255 + 58, 26);

    if (this.isNewBest) {
      ctx.fillStyle = '#5cb85c';
      fillPixelText(ctx, '* 新纪录 *', W / 2, H * 0.255 + 94, 28);
    }

    this._renderRunStats(ctx, W, H * 0.365);

    if (this.online && this.rows.length) this._renderTeam(ctx, W, H);
    else this._renderBoard(ctx, W, H);

    if (this.reviveBtn) this.reviveBtn.render(ctx);
    if (this.payBtn) this.payBtn.render(ctx);
    this.exitBtn.render(ctx);

    if (!this.win) {
      ctx.fillStyle = 'rgba(255,247,232,0.45)';
      ctx.textAlign = 'center';
      const tip = this.waitingRevive
        ? '已请求主机复活，等待主机确认…'
        : (AD_UNIT_ID ? '看广告逗留满 5 秒可复活并保留分数' : '打开页面即可复活并保留分数');
      fillPixelText(ctx, tip, W / 2, this.exitBtn.y + 110, 20);
    }
    g.payModal.render(ctx);
  }

  /**
   * 本局数据条：把这一局真正干了什么摊开给玩家看。
   * 联机时这些数字来自 host 广播的战绩表（只有 host 那边真的跑过物理）。
   */
  _renderRunStats(ctx, W, y) {
    const r = this.run;
    if (!r) return;
    const cells = [
      ['击杀', r.kills],
      ['合成', r.merges],
      ['投放', r.drops],
      ['卡牌', r.cards],
      ['波次', r.wave],
      ['生存', `${r.seconds}s`]
    ];
    const cols = 3;
    const cw = 190;
    const x0 = W / 2 - (cols * cw) / 2;
    cells.forEach(([label, value], i) => {
      const cx = x0 + (i % cols) * cw + cw / 2;
      const cy = y + Math.floor(i / cols) * 56;
      ctx.textAlign = 'center';
      ctx.fillStyle = palette.gold;
      fillPixelText(ctx, String(value), cx, cy, 30);
      ctx.fillStyle = 'rgba(255,247,232,0.55)';
      fillPixelText(ctx, label, cx, cy + 24, 19);
    });
  }

  /** 联机结算：本局四人各自得分（按分数降序，冠军带皇冠） */
  _renderTeam(ctx, W, H) {
    const y0 = H * 0.47;
    ctx.textAlign = 'center';
    ctx.fillStyle = palette.white;
    fillPixelText(ctx, '本局战绩', W / 2, y0, 28);
    ctx.textAlign = 'left';
    this.rows.slice(0, 4).forEach((r, i) => {
      const y = y0 + 40 + i * 34;
      ctx.fillStyle = seatColor(r.seat);
      fillPixelText(ctx, i === 0 ? '♛' : '•', W / 2 - 250, y, 24);
      ctx.fillStyle = r.you ? palette.gold : 'rgba(255,247,232,0.82)';
      fillPixelText(ctx, `${r.name}${r.you ? '（我）' : ''}`, W / 2 - 220, y, 24);
      ctx.textAlign = 'right';
      fillPixelText(ctx, String(r.score), W / 2 + 250, y, 24);
      ctx.textAlign = 'left';
    });
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,247,232,0.6)';
    fillPixelText(
      ctx,
      `排行榜：第 ${this.rankInfo.myRank} / ${this.rankInfo.total} 人`,
      W / 2, y0 + 40 + 4 * 34 + 6, 22
    );
  }

  /** 单机结算：榜单前三 */
  _renderBoard(ctx, W, H) {
    ctx.textAlign = 'center';
    ctx.fillStyle = palette.white;
    fillPixelText(
      ctx,
      `排行榜：第 ${this.rankInfo.myRank} 名 / ${this.rankInfo.total} 人`,
      W / 2, H * 0.51, 30
    );
    ctx.fillStyle = 'rgba(255,247,232,0.6)';
    this.rankInfo.top.slice(0, 3).forEach((item, i) => {
      fillPixelText(ctx, `${i + 1}. ${item.name}  ${item.score}`, W / 2, H * 0.51 + 44 + i * 36, 24);
    });
  }

  onTouchStart(t) {
    if (this.game.payModal.handleTouch('start', t)) return;
    if (this.reviveBtn) this.reviveBtn.handleTouch('start', t);
    if (this.payBtn) this.payBtn.handleTouch('start', t);
    this.exitBtn.handleTouch('start', t);
  }

  onTouchEnd(t) {
    if (this.game.payModal.handleTouch('end', t)) return;
    if (this.reviveBtn) this.reviveBtn.handleTouch('end', t);
    if (this.payBtn) this.payBtn.handleTouch('end', t);
    this.exitBtn.handleTouch('end', t);
  }
}
