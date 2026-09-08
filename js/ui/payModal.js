/**
 * 氪金弹窗：展示支付宝 / 微信个人收款码。
 * ------------------------------------------------------------------
 * 个人收款码没有支付成功回调，本弹窗只负责展示，不到账发奖。
 */
import { Button } from './widgets.js';
import { applyPixelCtx, fillPixelText, pixelPanel, palette } from './pixel.js';
import { paySprite } from './assets.js';

export class PayModal {
  constructor(game) {
    this.game = game;
    this.visible = false;
    this.W = game.screenW;
    this.H = game.screenH;
    const boxW = Math.min(700, this.W - 40);
    const boxH = Math.min(920, this.H - 80);
    this.box = {
      x: (this.W - boxW) / 2,
      y: (this.H - boxH) / 2,
      w: boxW,
      h: boxH
    };
    this.closeBtn = new Button({
      x: 0, y: 0, w: 200, h: 72,
      text: '关闭', bgColor: '#8a8a8a', fontSize: 28
    });
    this._layout();
  }

  _layout() {
    const { x, y, w, h } = this.box;
    this.closeBtn.x = x + (w - 200) / 2;
    this.closeBtn.y = y + h - 92;
    const pad = 28;
    const top = y + 100;
    const bottom = this.closeBtn.y - 24;
    const gap = 16;
    const imgH = Math.max(180, bottom - top);
    const imgW = (w - pad * 2 - gap) / 2;
    this.alipayRect = { x: x + pad, y: top, w: imgW, h: imgH };
    this.wechatRect = { x: x + pad + imgW + gap, y: top, w: imgW, h: imgH };
  }

  open() { this.visible = true; }
  close() { this.visible = false; }

  handleTouch(type, touch) {
    if (!this.visible) return false;
    if (type === 'end' && this.closeBtn.contains(touch.x, touch.y)) {
      this.close();
      return true;
    }
    if (type === 'start') this.closeBtn.handleTouch('start', touch);
    return true;
  }

  render(ctx) {
    if (!this.visible) return;
    const { x, y, w, h } = this.box;
    ctx.save();
    applyPixelCtx(ctx);
    ctx.fillStyle = 'rgba(10,6,18,0.78)';
    ctx.fillRect(0, 0, this.W, this.H);
    pixelPanel(ctx, x, y, w, h, { fill: '#f4ead2', border: 6, highlight: true });

    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fillPixelText(ctx, '氪金支持', x + w / 2, y + 40, 36);
    ctx.fillStyle = 'rgba(26,16,32,0.55)';
    fillPixelText(ctx, '扫码支持作者（个人收款码无法自动到账）', x + w / 2, y + 72, 18);

    this._drawPayImage(ctx, paySprite('alipay'), this.alipayRect, '支付宝');
    this._drawPayImage(ctx, paySprite('wechat'), this.wechatRect, '微信');

    this.closeBtn.render(ctx);
    ctx.restore();
  }

  _drawPayImage(ctx, img, rect, label) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 3;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    if (img && img.width) {
      ctx.imageSmoothingEnabled = true;
      const ir = img.width / img.height;
      const br = rect.w / rect.h;
      let dw, dh, dx, dy;
      if (ir > br) {
        dw = rect.w - 8;
        dh = dw / ir;
        dx = rect.x + 4;
        dy = rect.y + (rect.h - dh) / 2;
      } else {
        dh = rect.h - 8;
        dw = dh * ir;
        dx = rect.x + (rect.w - dw) / 2;
        dy = rect.y + 4;
      }
      ctx.drawImage(img, dx, dy, dw, dh);
    } else {
      ctx.fillStyle = palette.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      fillPixelText(ctx, label, rect.x + rect.w / 2, rect.y + rect.h / 2, 24);
    }
    ctx.restore();
  }
}

/** 局内 / 大厅 / 结算共用的氪金按钮 */
export function makePayButton(game, x, y, w, h, fontSize = 32) {
  return new Button({
    x, y, w, h,
    text: '氪金',
    bgColor: '#c9a227',
    textColor: '#1a1020',
    fontSize,
    onTap: () => game.payModal.open()
  });
}
