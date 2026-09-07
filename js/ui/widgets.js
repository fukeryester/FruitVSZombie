/**
 * UI 基础组件：按钮 / Toast / 通用设置弹窗
 * ------------------------------------------------------------------
 * 纯 Canvas 绘制 + 命中检测，与状态机解耦。像素风切角按钮。
 */
import { applyPixelCtx, fillPixelText, pixelPanel, palette, PIXEL } from './pixel.js';

export class Button {
  /**
   * @param {Object} opts {x, y, w, h, text, bgColor, textColor, fontSize, radius, onTap}
   * x/y 为左上角坐标
   */
  constructor(opts) {
    this.x = opts.x;
    this.y = opts.y;
    this.w = opts.w;
    this.h = opts.h;
    this.text = opts.text;
    this.bgColor = opts.bgColor || '#4a90d9';
    this.textColor = opts.textColor || '#ffffff';
    this.fontSize = opts.fontSize || 32;
    this.radius = opts.radius ?? 0;
    this.onTap = opts.onTap || (() => {});
    this.visible = true;
    this.pressed = false;
  }

  contains(px, py) {
    return this.visible &&
      px >= this.x && px <= this.x + this.w &&
      py >= this.y && py <= this.y + this.h;
  }

  handleTouch(type, touch) {
    if (!this.visible) return false;
    const inside = this.contains(touch.x, touch.y);
    if (type === 'start' && inside) {
      this.pressed = true;
    } else if (type === 'end') {
      const wasPressed = this.pressed;
      this.pressed = false;
      if (wasPressed && inside) {
        this.onTap();
        return true;
      }
    }
    return inside;
  }

  render(ctx) {
    if (!this.visible) return;
    const { x, y, w, h } = this;
    ctx.save();
    applyPixelCtx(ctx);
    const fill = this.pressed ? this._darken(this.bgColor) : this.bgColor;
    pixelPanel(ctx, x, y, w, h, { fill, border: PIXEL, highlight: !this.pressed });
    ctx.fillStyle = this.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fillPixelText(ctx, this.text, x + w / 2, y + h / 2 + 2, this.fontSize);
    ctx.restore();
  }

  _darken(hex) {
    try {
      const n = parseInt(hex.slice(1), 16);
      const r = Math.floor(((n >> 16) & 255) * 0.82);
      const g = Math.floor(((n >> 8) & 255) * 0.82);
      const b = Math.floor((n & 255) * 0.82);
      return `rgb(${r},${g},${b})`;
    } catch (e) {
      return hex;
    }
  }
}

/** Toast：短提示，队列显示 */
const toastQueue = [];
let toastTimer = 0;

export function showToast(text, duration = 1.6) {
  toastQueue.push({ text, duration });
}

/** 清空所有待显示的 Toast —— 跨阶段切换时调用，防止上一阶段残留 */
export function clearToasts() {
  toastQueue.length = 0;
  toastTimer = 0;
}

export function updateToasts(dt) {
  if (toastTimer > 0) {
    toastTimer -= dt;
  } else if (toastQueue.length) {
    toastQueue[0].life = toastQueue[0].duration;
    toastTimer = toastQueue[0].duration + 0.15;
  }
}

export function renderToasts(ctx, screenW, screenH) {
  if (!toastQueue.length) return;
  const t = toastQueue[0];
  if (t.life === undefined) return;
  t.life -= 1 / 60;
  if (t.life <= 0) { toastQueue.shift(); return; }
  const alpha = Math.min(1, t.life / 0.4);
  ctx.save();
  ctx.globalAlpha = alpha;
  applyPixelCtx(ctx);
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(t.text).width + 60;
  const x = (screenW - w) / 2;
  const y = screenH * 0.42;
  pixelPanel(ctx, x, y, w, 84, { fill: '#1a1020', border: 4 });
  ctx.fillStyle = palette.white;
  fillPixelText(ctx, t.text, screenW / 2, y + 42, 28);
  ctx.restore();
}

/**
 * 通用设置弹窗：音效开关 + 退出按钮
 * 退出按钮语义：
 *   - 局内：退出本局，回到大厅
 *   - 大厅：直接不响应（小游戏由微信管理退出），按钮文案提示
 */
export class SettingsModal {
  constructor(game, { onExitGame }) {
    this.game = game;
    this.visible = false;
    this.W = game.screenW;
    this.H = game.screenH;
    const boxW = Math.min(560, this.W - 80);
    const boxH = 400;
    this.box = {
      x: (this.W - boxW) / 2,
      y: (this.H - boxH) / 2,
      w: boxW,
      h: boxH
    };
    this.onExitGame = onExitGame || (() => {});

    // 音效开关
    this.soundBtn = new Button({
      x: 0, y: 0, w: boxW - 120, h: 88,
      text: '', bgColor: '#5cb85c', fontSize: 30
    });
    // 退出按钮
    this.exitBtn = new Button({
      x: 0, y: 0, w: boxW - 120, h: 88,
      text: '', bgColor: '#d9534f', fontSize: 30
    });
    // 关闭
    this.closeBtn = new Button({
      x: 0, y: 0, w: 120, h: 72,
      text: '关闭', bgColor: '#8a8a8a', fontSize: 26
    });
    this._layout();
  }

  _layout() {
    const { x, y, w, h } = this.box;
    const pad = 60;
    this.soundBtn.x = x + pad;
    this.soundBtn.y = y + 120;
    this.soundBtn.w = w - pad * 2;
    this.exitBtn.x = x + pad;
    this.exitBtn.y = y + 230;
    this.exitBtn.w = w - pad * 2;
    this.closeBtn.x = x + (w - 120) / 2;
    this.closeBtn.y = y + h - 100;
  }

  setExitLabel(text) {
    this.exitBtn.text = text;
  }

  open() { this.visible = true; }
  close() { this.visible = false; }

  /** 返回 true 表示事件已消费（拦截穿透） */
  handleTouch(type, touch) {
    if (!this.visible) return false;
    const consume = (fn) => { fn(); return true; };
    if (type === 'end') {
      if (this.closeBtn.contains(touch.x, touch.y)) {
        return consume(() => this.close());
      }
      if (this.soundBtn.contains(touch.x, touch.y)) {
        return consume(() => {
          const v = !this.game.audio.enabled;
          this.game.audio.setEnabled(v);
        });
      }
      if (this.exitBtn.contains(touch.x, touch.y)) {
        return consume(() => {
          this.close();
          this.onExitGame();
        });
      }
    }
    return true; // 弹窗打开时拦截所有点击
  }

  render(ctx) {
    if (!this.visible) return;
    const { x, y, w, h } = this.box;
    ctx.save();
    applyPixelCtx(ctx);
    ctx.fillStyle = 'rgba(10,6,18,0.72)';
    ctx.fillRect(0, 0, this.W, this.H);
    pixelPanel(ctx, x, y, w, h, { fill: '#f4ead2', border: 6, highlight: true });

    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fillPixelText(ctx, '设置', x + w / 2, y + 70, 40);

    this.soundBtn.text = `音效：${this.game.audio.enabled ? '开' : '关'}`;
    this.soundBtn.bgColor = this.game.audio.enabled ? '#5cb85c' : '#b0b0b0';
    this.soundBtn.render(ctx);
    this.exitBtn.render(ctx);
    this.closeBtn.render(ctx);
    ctx.restore();
  }
}
