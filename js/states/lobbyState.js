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
      text: '开始游戏',
      bgColor: '#2e8b3a',
      fontSize: 40,
      onTap: () => g.states.switchTo(g.createPlayingState())
    });
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

    this.startBtn.render(ctx);
    this.settingsBtn.render(ctx);
    this.payBtn.render(ctx);
    this.settings.render(ctx);
    g.payModal.render(ctx);
  }

  onTouchStart(t) {
    if (this.settings.handleTouch('start', t)) return;
    if (this.game.payModal.handleTouch('start', t)) return;
    this.startBtn.handleTouch('start', t);
    this.settingsBtn.handleTouch('start', t);
    this.payBtn.handleTouch('start', t);
  }
  onTouchMove(t) {
    if (this.settings.handleTouch('move', t)) return;
    if (this.game.payModal.handleTouch('move', t)) return;
  }
  onTouchEnd(t) {
    if (this.settings.handleTouch('end', t)) return;
    if (this.game.payModal.handleTouch('end', t)) return;
    this.startBtn.handleTouch('end', t);
    this.settingsBtn.handleTouch('end', t);
    this.payBtn.handleTouch('end', t);
  }
}
