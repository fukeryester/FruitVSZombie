/**
 * 结算状态（ResultState）—— 压在冻结的局内层之上
 * ------------------------------------------------------------------
 * 展示：本局得分、全服排行榜排位、新纪录提示。
 * 按钮：退出回大厅 / 看广告复活（逗留 ≥5s 才能复活；否则短提示退回结算）。
 */
import { BaseState } from '../core/stateMachine.js';
import { Button, showToast } from '../ui/widgets.js';
import { watchRewardAd, AD_UNIT_ID } from '../core/adApi.js';
import { makePayButton } from '../ui/payModal.js';
import { getRank } from '../core/leaderboard.js';
import { applyPixelCtx, fillPixelText, pixelPanel, palette } from '../ui/pixel.js';
import { drawStageBg } from '../ui/hud.js';

const AD_MIN_DWELL_MS = 5000;

export default class ResultState extends BaseState {
  /**
   * @param playing 压栈时仍存活的局内状态（复活时直接恢复）
   * @param opts    { win: true } 通关结算 —— 标题换"恭喜通关"，隐藏复活入口
   */
  constructor(game, playing, opts) {
    super(game);
    this.playing = playing;
    this.win = !!(opts && opts.win);
  }

  onEnter() {
    const playing = this.playing;
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;
    this.rankInfo = getRank(playing.score);
    this.isNewBest = playing.score >= g.bestScore && playing.score > 0;

    const btnW = Math.min(420, W - 100);
    const y0 = H * 0.56;
    // 通关结算没有"复活"一说，只有失败才提供看广告复活 / 氪金
    this.reviveBtn = this.win ? null : new Button({
      x: (W - btnW) / 2,
      y: y0,
      w: btnW,
      h: 88,
      text: '📺 看广告复活',
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
      onTap: () => g.states.switchTo(g.createLobbyState())
    });
    this.busy = false;
    g.audio.startBgm(this.win ? 'resultWin' : 'resultFail');
  }

  onExit() {
    this.game.audio.stopBgm();
  }

  async _tryRevive() {
    if (this.busy) return;
    this.busy = true;
    const res = await watchRewardAd(AD_MIN_DWELL_MS);
    this.busy = false;
    if (res.ok) {
      // 复活：继承分数，随机消除一半水果，回到局内
      const g = this.game;
      g.states.pop(); // 弹出结算层，重新激活 PlayingState
      this.playing.revive();
    } else if (res.reason === 'open_fail') {
      showToast('无法打开页面，复活失败');
    } else {
      showToast('观看广告未满 5 秒，无法复活');
    }
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

    pixelPanel(ctx, W / 2 - 300, H * 0.12, 600, H * 0.38, { fill: '#241830', border: 6 });

    ctx.fillStyle = this.win ? '#8ee66f' : '#ff8a9b';
    fillPixelText(ctx, this.win ? '恭喜通关' : '游戏结束', W / 2, H * 0.18, 48);

    ctx.fillStyle = palette.gold;
    fillPixelText(ctx, String(this.playing.score), W / 2, H * 0.32, 84);
    ctx.fillStyle = 'rgba(255,247,232,0.75)';
    fillPixelText(ctx, '本局得分', W / 2, H * 0.32 + 70, 26);

    if (this.isNewBest) {
      ctx.fillStyle = '#5cb85c';
      fillPixelText(ctx, '* 新纪录 *', W / 2, H * 0.32 + 112, 30);
    }

    ctx.fillStyle = palette.white;
    fillPixelText(
      ctx,
      `全服排名：第 ${this.rankInfo.myRank} 名 / ${this.rankInfo.total} 人`,
      W / 2, H * 0.47, 30
    );
    ctx.fillStyle = 'rgba(255,247,232,0.6)';
    this.rankInfo.top.slice(0, 3).forEach((item, i) => {
      fillPixelText(ctx, `${i + 1}. ${item.nickname}  ${item.score}`, W / 2, H * 0.47 + 44 + i * 36, 24);
    });

    if (this.reviveBtn) this.reviveBtn.render(ctx);
    if (this.payBtn) this.payBtn.render(ctx);
    this.exitBtn.render(ctx);

    if (!this.win) {
      ctx.fillStyle = 'rgba(255,247,232,0.45)';
      fillPixelText(
        ctx,
        AD_UNIT_ID ? '看广告逗留满 5 秒可复活并保留分数' : '打开页面即可复活并保留分数',
        W / 2, this.exitBtn.y + 110, 20
      );
    }
    g.payModal.render(ctx);
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
