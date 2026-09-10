/**
 * 大厅状态（LobbyState）
 * ------------------------------------------------------------------
 * 极简入口：开始游戏（排行榜入口并入结算页，大厅保持零决策成本）。
 * 设置弹窗：大厅中按"退出游戏"不响应（小游戏退出由微信接管）。
 */
import { BaseState } from '../core/stateMachine.js';
import { Button, SettingsModal, showToast } from '../ui/widgets.js';
import { makePayButton } from '../ui/payModal.js';
import { levels } from '../config/balls.js';
import { drawBall } from '../ui/ballRenderer.js';
import { applyPixelCtx, fillPixelText, palette } from '../ui/pixel.js';
import { drawStageBg } from '../ui/hud.js';
import { loadBoard } from '../core/leaderboard.js';
import { askPlayerName } from '../core/playerName.js';
import { MatchSession } from '../net/session.js';

export default class LobbyState extends BaseState {
  onEnter() {
    const g = this.game;
    const W = g.screenW;
    this.titleY = g.screenH * 0.3;
    const btnW = Math.min(420, W - 100);
    this.startBtn = new Button({
      x: (W - btnW) / 2,
      y: g.screenH * 0.52,
      w: btnW,
      h: 100,
      text: '单人游戏',
      bgColor: '#2e8b3a',
      fontSize: 40,
      onTap: () => g.states.switchTo(g.createPlayingState())
    });
    // 联机入口：不支持的环境（微信小游戏包）直接不显示，避免点了没反应
    this.netBtn = MatchSession.supported ? new Button({
      x: (W - btnW) / 2,
      y: g.screenH * 0.52 + 116,
      w: btnW,
      h: 92,
      text: '联机对战（最多 4 人）',
      bgColor: '#2f6fb0',
      fontSize: 34,
      onTap: () => g.states.switchTo(g.createRoomState())
    }) : null;
    const rowY = g.screenH * 0.52 + (this.netBtn ? 224 : 116);
    // 数据档案：统计 / 成就 / 排行榜。和「改名」并排放在开始按钮下面一行
    this.statsBtn = new Button({
      x: (W - btnW) / 2,
      y: rowY,
      w: btnW - 158,
      h: 68,
      text: '📊 数据档案',
      bgColor: '#3a5680',
      fontSize: 28,
      onTap: () => g.states.switchTo(g.createStatsState())
    });
    this.nameBtn = new Button({
      x: (W - btnW) / 2 + btnW - 150,
      y: rowY,
      w: 150,
      h: 68,
      text: '改名',
      bgColor: '#5a4a8a',
      fontSize: 28,
      onTap: () => this._rename()
    });
    this.board = loadBoard();
    this.settingsBtn = new Button({
      x: W - 110,
      y: 70,
      w: 80,
      h: 80,
      text: '⚙',
      bgColor: 'rgba(255,255,255,0.25)',
      fontSize: 40,
      onTap: () => this.settings.open()
    });
    this.settings = new SettingsModal(g, {
      // 大厅中：不响应退出（微信小游戏无法自退出）
      onExitGame: () => showToast('大厅中无法退出小游戏')
    });
    this.settings.setExitLabel('退出游戏');
    g.audio.startBgm('lobby');
    const payW = 168;
    const payH = 72;
    this.payBtn = makePayButton(g, W - payW - 24, g.screenH - payH - 36, payW, payH, 28);
    // 大厅里让装饰水果轻微浮动
    this.time = 0;
    this.deco = levels.slice(0, 6).map((lv, i) => ({
      lv,
      x: W * (0.12 + 0.15 * i),
      phase: Math.random() * Math.PI * 2
    }));
  }

  onExit() {
    this.game.audio.stopBgm();
  }

  async _rename() {
    const next = await askPlayerName(this.game.playerName);
    if (!next) {
      showToast('当前环境无法输入昵称');
      return;
    }
    this.game.setPlayerName(next);
    this.board = loadBoard();
    showToast(`昵称已改为 ${next}`);
  }

  onUpdate(dt) {
    this.time += dt;
  }

  onRender(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;
    applyPixelCtx(ctx);
    drawStageBg(ctx, W, H, H - 24, 'lobby');

    for (const d of this.deco) {
      const y = H * 0.78 + Math.sin(this.time * 1.2 + d.phase) * 14;
      const lvIndex = levels.indexOf(d.lv);
      drawBall(ctx, d.x, y, d.lv.radius * 0.55, lvIndex < 0 ? 0 : lvIndex);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.gold;
    fillPixelText(ctx, '水果大战僵尸', W / 2, this.titleY, 64);
    ctx.fillStyle = palette.white;
    fillPixelText(ctx, '两个相同的水果碰撞会合成更大的水果', W / 2, this.titleY + 70, 24);
    fillPixelText(ctx, '合成之后……僵尸就来了', W / 2, this.titleY + 110, 24);

    ctx.fillStyle = palette.gold;
    fillPixelText(ctx, `历史最高分：${g.bestScore}`, W / 2, g.screenH * 0.46, 32);

    const champion = this.board[0];
    ctx.fillStyle = 'rgba(255,247,232,0.7)';
    fillPixelText(
      ctx,
      champion ? `榜首：${champion.name}  ${champion.score}` : '排行榜还空着，去刷个第一',
      W / 2, g.screenH * 0.46 + 42, 24
    );

    this.startBtn.render(ctx);
    if (this.netBtn) this.netBtn.render(ctx);

    this.statsBtn.render(ctx);
    this.nameBtn.render(ctx);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,247,232,0.75)';
    const tally = g.progress.achievementTally();
    fillPixelText(
      ctx,
      tally.total
        ? `我：${g.playerName}　成就 ${tally.done}/${tally.total}`
        : `我：${g.playerName}`,
      W / 2, this.nameBtn.y + 96, 24
    );

    this.settingsBtn.render(ctx);
    this.payBtn.render(ctx);
    this.settings.render(ctx);
    g.payModal.render(ctx);
  }

  _buttons() {
    const list = [this.startBtn, this.settingsBtn, this.payBtn, this.nameBtn, this.statsBtn];
    if (this.netBtn) list.push(this.netBtn);
    return list;
  }

  onTouchStart(t) {
    if (this.settings.handleTouch('start', t)) return;
    if (this.game.payModal.handleTouch('start', t)) return;
    for (const b of this._buttons()) b.handleTouch('start', t);
  }
  onTouchMove(t) {
    if (this.settings.handleTouch('move', t)) return;
    if (this.game.payModal.handleTouch('move', t)) return;
  }
  onTouchEnd(t) {
    if (this.settings.handleTouch('end', t)) return;
    if (this.game.payModal.handleTouch('end', t)) return;
    for (const b of this._buttons()) {
      if (b.handleTouch('end', t)) return;
    }
  }
}
