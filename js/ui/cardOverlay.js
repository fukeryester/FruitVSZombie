/**
 * 三选一选卡浮层
 * ------------------------------------------------------------------
 * 纯展示组件，由 CardSystem 持有。触发队列 / 工厂 / 应用效果等逻辑
 * 全部在 js/cards/cardSystem.js 中，本组件只负责"一次三选一"的
 * 展示与选择回调：
 *   open(cardList, onPick) → render / handleTouch → onPick(card)
 */
import { Button } from './widgets.js';
import { applyPixelCtx, fillPixelText, pixelPanel, palette } from './pixel.js';

export class CardOverlay {
  constructor(game) {
    this.game = game;
    this.visible = false;
    this.cards = [];
    this.onPick = null;
    this.W = game.screenW;
    this.H = game.screenH;
    this.btns = [];
  }

  open(cardList, onPick) {
    this.cards = cardList;
    this.onPick = onPick;
    this.visible = true;
    this.btns = cardList.map((c, i) => {
      const cardW = Math.min(230, (this.W - 90) / 3 - 10);
      const cardH = 340;
      const gap = 18;
      const totalW = cardW * 3 + gap * 2;
      const x = (this.W - totalW) / 2 + i * (cardW + gap);
      const y = (this.H - cardH) / 2;
      const btn = new Button({
        x, y, w: cardW, h: cardH,
        text: '', bgColor: '#f4ead2', radius: 0, fontSize: 26
      });
      btn._card = c;
      return btn;
    });
  }

  close() {
    this.visible = false;
    this.onPick = null;
  }

  handleTouch(type, touch) {
    if (!this.visible) return false;
    if (type === 'end') {
      for (const btn of this.btns) {
        if (btn.contains(touch.x, touch.y)) {
          const card = btn._card;
          const cb = this.onPick;
          this.close();
          if (cb) cb(card);
          return true;
        }
      }
    }
    return true; // 选卡期间拦截所有点击
  }

  render(ctx) {
    if (!this.visible) return;
    const { W, H } = this;
    ctx.save();
    applyPixelCtx(ctx);
    ctx.fillStyle = 'rgba(12,6,20,0.82)';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = palette.gold;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fillPixelText(ctx, '选择一张卡片', W / 2, H / 2 - 240, 40);
    ctx.fillStyle = palette.white;
    fillPixelText(ctx, '游戏已暂停', W / 2, H / 2 - 190, 24);

    for (const btn of this.btns) {
      const c = btn._card;
      ctx.save();
      pixelPanel(ctx, btn.x, btn.y, btn.w, btn.h, { fill: '#f4ead2', border: 5, highlight: true });
      ctx.fillStyle = c.color;
      ctx.fillRect(btn.x + 8, btn.y + 8, btn.w - 16, 6);

      const icx = btn.x + btn.w / 2;
      const icy = btn.y + 108;
      ctx.fillStyle = palette.ink;
      ctx.fillRect(icx - 56, icy - 56, 112, 112);
      ctx.fillStyle = c.color;
      ctx.fillRect(icx - 52, icy - 52, 104, 104);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fillPixelText(ctx, c.icon, icx, icy + 4, 48);

      ctx.fillStyle = palette.ink;
      fillPixelText(ctx, c.name, icx, btn.y + 210, 30);
      ctx.fillStyle = '#4a4038';
      ctx.font = 'bold 22px sans-serif';
      const desc = c.desc;
      const lineW = btn.w - 30;
      let line = '';
      let ly = btn.y + 250;
      for (const ch of desc) {
        if (ctx.measureText(line + ch).width > lineW) {
          fillPixelText(ctx, line, icx, ly, 22);
          line = ch;
          ly += 32;
        } else {
          line += ch;
        }
      }
      if (line) fillPixelText(ctx, line, icx, ly, 22);
      ctx.restore();
    }
    ctx.restore();
  }
}
