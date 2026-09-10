/**
 * 三选一选卡浮层
 * ------------------------------------------------------------------
 * 纯展示组件，由 CardSystem 持有。触发队列 / 工厂 / 应用效果等逻辑
 * 全部在 js/cards/cardSystem.js 中，本组件只负责一次三选一的
 * 展示与选择回调：
 *   open(cardList, onPick, opts) → render / handleTouch → onPick(card)
 *
 * 联机时（opts.online）多两件事：
 *   · 顶部倒计时条 —— 到点没选的人由房主随机代选；
 *   · 底部一排玩家状态 —— 谁已经选好了、自己选的是哪张；
 *     自己选完后浮层不关闭（要等全员），转为「等待其他玩家」的锁定态。
 */
import { Button } from './widgets.js';
import { applyPixelCtx, fillPixelText, pixelPanel, pixelBar, palette, pxFont } from './pixel.js';
import { seatColor } from '../config/net.js';

/** 按像素宽度逐字断行（中文没有空格，只能逐字量） */
function wrapText(ctx, text, maxW, size) {
  pxFont(ctx, size);
  const lines = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (line && ctx.measureText(line + ch).width > maxW) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class CardOverlay {
  constructor(game) {
    this.game = game;
    this.visible = false;
    this.cards = [];
    this.onPick = null;
    this.W = game.screenW;
    this.H = game.screenH;
    this.btns = [];
    // 联机投票态
    this.online = false;
    this.deadline = 0;
    this.totalMs = 0;
    this.seats = [];
    this.picked = new Set(); // 已经选好的座位号
    this.locked = false;     // 自己已经投过票，等其他人
    this.myPickCard = null;  // 自己选中的那张（用于高亮）
  }

  /**
   * @param {Array} cardList 三张候选卡实例
   * @param {Function} onPick 选中回调
   * @param {object} [opts] { deadline 截止时间戳(ms，0=不限时), seats [{seat,name,mine}], online }
   */
  open(cardList, onPick, opts = {}) {
    this.cards = cardList;
    this.onPick = onPick;
    this.visible = true;
    this.online = !!opts.online;
    this.deadline = opts.deadline || 0;
    this.totalMs = this.deadline ? Math.max(1, this.deadline - Date.now()) : 0;
    this.seats = opts.seats || [];
    this.picked = new Set();
    this.locked = false;
    this.myPickCard = null;
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
    this.locked = false;
    this.picked = new Set();
    this.myPickCard = null;
  }

  /** 标记某个座位已经选好（谁选了哪张要等最终结果，这里只做进度展示） */
  markPicked(seat) {
    this.picked.add(seat);
  }

  /**
   * 联机：本机已投票，浮层转为「等其他玩家」的锁定态（高亮自己那张、其余压暗）。
   * 由 CardSystem 在记录选择时调用 —— 锁定状态跟着"选择已生效"这件事走，
   * 而不是跟着"手指抬起"这件事走。
   */
  lockMyPick(card) {
    this.locked = true;
    this.myPickCard = card;
  }

  /** 剩余秒数（不限时返回 0） */
  remainSeconds() {
    if (!this.deadline) return 0;
    return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
  }

  handleTouch(type, touch) {
    if (!this.visible) return false;
    if (type === 'end' && !this.locked) {
      for (const btn of this.btns) {
        if (!btn.contains(touch.x, touch.y)) continue;
        const card = btn._card;
        const cb = this.onPick;
        // 单机点完就关；联机保持打开，锁定态由 CardSystem 在记录选择时置上
        if (!this.online) this.close();
        if (cb) cb(card);
        return true;
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

    // 卡面从 H/2-170 开始（高 340 居中），标题区必须全部排在它上面，
    // 否则会被后画的卡片盖掉 —— 倒计时条一度就是这么"消失"的。
    ctx.fillStyle = palette.gold;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fillPixelText(ctx, '选择一张卡片', W / 2, H / 2 - 272, 40);
    ctx.fillStyle = palette.white;
    fillPixelText(
      ctx,
      this.online ? '全员暂停中 · 所有人的卡都会生效' : '游戏已暂停',
      W / 2, H / 2 - 228, 24
    );

    if (this.online && this.deadline) this._renderTimer(ctx);

    for (const btn of this.btns) {
      const c = btn._card;
      const isMine = this.locked && this.myPickCard === c;
      ctx.save();
      if (this.locked && !isMine) ctx.globalAlpha = 0.38;
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
      // 描述断行：卡面固定 340 高，正文只有 btn.y+236 ~ btn.y+330 这一段可用。
      // 「大丰收」那种长文案按固定行高往下堆会掉到卡片外面，所以行数多了就
      // 自动换小一号字 + 收窄行高。
      ctx.fillStyle = '#4a4038';
      const lineW = btn.w - 30;
      let size = 22;
      let lines = wrapText(ctx, c.desc, lineW, size);
      if (lines.length > 3) {
        size = 20;
        lines = wrapText(ctx, c.desc, lineW, size);
      }
      const lh = lines.length > 3 ? 26 : 32;
      const top = btn.y + 246;
      const room = btn.y + 330 - top;
      let ly = top + Math.max(0, (room - (lines.length - 1) * lh)) / 2;
      for (const ln of lines) {
        fillPixelText(ctx, ln, icx, ly, size);
        ly += lh;
      }
      ctx.restore();
    }

    if (this.online) this._renderSeats(ctx);
    ctx.restore();
  }

  _renderTimer(ctx) {
    const { W, H } = this;
    const bw = Math.min(520, W - 120);
    const bx = (W - bw) / 2;
    const bh = 30;
    const by = H / 2 - 200;   // 卡面上沿是 H/2-170，留 12px 间隙
    const left = Math.max(0, this.deadline - Date.now());
    const ratio = this.totalMs > 0 ? left / this.totalMs : 0;
    const secs = this.remainSeconds();
    pixelBar(ctx, bx, by, bw, bh, ratio, secs <= 2 ? palette.danger : palette.gold, 'rgba(20,16,28,0.6)');
    ctx.fillStyle = palette.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fillPixelText(
      ctx,
      this.locked ? `等待其他玩家… ${secs}s` : `${secs} 秒后自动随机选牌`,
      W / 2, by + bh / 2, 22
    );
  }

  _renderSeats(ctx) {
    const { W, H } = this;
    const rows = this.seats;
    if (!rows.length) return;
    const cellW = Math.min(170, (W - 60) / Math.max(1, rows.length));
    const totalW = cellW * rows.length;
    const x0 = (W - totalW) / 2;
    const y = H / 2 + 210;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const done = this.picked.has(r.seat);
      const x = x0 + i * cellW;
      pixelPanel(ctx, x + 4, y, cellW - 8, 62, {
        fill: done ? '#1e3a1e' : '#241830',
        border: 3
      });
      ctx.fillStyle = seatColor(r.seat);
      fillPixelText(ctx, this._short(r.name) + (r.mine ? '(你)' : ''), x + cellW / 2, y + 20, 20);
      ctx.fillStyle = done ? palette.ok : 'rgba(255,247,232,0.55)';
      fillPixelText(ctx, done ? '已选好' : '选择中…', x + cellW / 2, y + 44, 20);
    }
  }

  _short(name) {
    const s = String(name || '');
    return s.length > 6 ? s.slice(0, 6) + '…' : s;
  }
}
