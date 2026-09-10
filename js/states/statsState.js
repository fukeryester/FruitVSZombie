/**
 * 数据档案（StatsState）—— 大厅里的「统计 / 成就 / 排行榜」全屏面板
 * ------------------------------------------------------------------
 * 三个页签，数据全部来自 GameHub 进度系统（js/net/progress.js）：
 *   · 统计：我在这款游戏里的所有非隐藏统计
 *   · 成就：目录 + 我的解锁状态 + 进度型成就的完成进度条
 *   · 排行榜：五个榜，点榜名切换，显示前 10 名并高亮我自己
 *
 * 未登录 / 微信包 / 无头环境里 progress 是空转的，这时面板只提示一句
 * 「在小游戏站登录后才有数据」，不报错也不留空白页。
 *
 * 列表比屏幕长，所以自己实现了一个拖拽滚动（触摸移动超过阈值才算滚动，
 * 否则算点击，避免点榜名时被误判成拖动）。
 */
import { BaseState } from '../core/stateMachine.js';
import { Button } from '../ui/widgets.js';
import { applyPixelCtx, fillPixelText, pixelPanel, pixelBar, palette, pxFont } from '../ui/pixel.js';
import { drawStageBg } from '../ui/hud.js';

const TABS = [
  { id: 'stats', label: '统计' },
  { id: 'achievements', label: '成就' },
  { id: 'boards', label: '排行榜' }
];

/** 拖动超过这么多设计单位才算滚动而不是点击 */
const DRAG_SLOP = 12;

export default class StatsState extends BaseState {
  onEnter() {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;

    this.tab = 'stats';
    this.scroll = 0;
    this.contentH = 0;
    this.drag = null;
    this.boardId = '';

    // 面板几何：顶部标题 + 页签，底部返回按钮，中间是可滚动列表
    this.padX = 40;
    this.listTop = Math.round(H * 0.24);
    this.listBottom = H - 170;

    const tabW = Math.floor((W - this.padX * 2) / TABS.length);
    this.tabBtns = TABS.map((t, i) => new Button({
      x: this.padX + i * tabW,
      y: Math.round(H * 0.17),
      w: tabW - 8,
      h: 68,
      text: t.label,
      bgColor: '#3a2c4e',
      fontSize: 30,
      onTap: () => this._switchTab(t.id)
    }));

    const btnW = Math.min(420, W - 100);
    this.backBtn = new Button({
      x: (W - btnW) / 2,
      y: H - 130,
      w: btnW,
      h: 88,
      text: '返回大厅',
      bgColor: '#8a6d9e',
      fontSize: 36,
      onTap: () => g.states.switchTo(g.createLobbyState())
    });

    // 榜切换按钮在 onRender 里按当前目录动态排布，这里先占个空数组
    this.boardBtns = [];
    g.audio.startBgm('lobby');
  }

  onExit() {
    this.game.audio.stopBgm();
  }

  get progress() {
    return this.game.progress;
  }

  _switchTab(id) {
    this.tab = id;
    this.scroll = 0;
  }

  /** 页签高亮：当前页用金色底 */
  _renderTabs(ctx) {
    this.tabBtns.forEach((b, i) => {
      b.bgColor = TABS[i].id === this.tab ? '#8a6a2a' : '#3a2c4e';
      b.render(ctx);
    });
  }

  onUpdate() {
    // 排行榜是异步拉的，切到该页签时触发一次请求（board() 内部有缓存去重）
    if (this.tab === 'boards') {
      const boards = this.progress.defs.leaderboards || [];
      if (!this.boardId && boards.length) this.boardId = boards[0].id;
      if (this.boardId) this.progress.board(this.boardId, 10);
    }
  }

  onRender(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;
    applyPixelCtx(ctx);
    drawStageBg(ctx, W, H, null, 'lobby');
    ctx.fillStyle = 'rgba(8,4,16,0.45)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.gold;
    fillPixelText(ctx, '数据档案', W / 2, H * 0.09, 52);

    const tally = this.progress.achievementTally();
    ctx.fillStyle = 'rgba(255,247,232,0.72)';
    fillPixelText(
      ctx,
      this.progress.loggedIn
        ? `${g.playerName} · 成就 ${tally.done}/${tally.total} · 游玩 ${this._playtime()}`
        : '在小游戏站登录后，这里会记录你的统计与成就',
      W / 2, H * 0.09 + 46, 24
    );

    this._renderTabs(ctx);

    // 列表区：先画底板，再用 clip 把超出的行裁掉
    const listH = this.listBottom - this.listTop;
    pixelPanel(ctx, this.padX - 8, this.listTop - 8, W - (this.padX - 8) * 2, listH + 16, {
      fill: '#241830', border: 5
    });

    ctx.save();
    ctx.beginPath();
    ctx.rect(this.padX - 4, this.listTop, W - (this.padX - 4) * 2, listH);
    ctx.clip();
    const y0 = this.listTop - this.scroll;
    if (!this.progress.ready) {
      this._empty(ctx, W, '正在读取…');
    } else if (this.tab === 'stats') {
      this.contentH = this._renderStats(ctx, W, y0);
    } else if (this.tab === 'achievements') {
      this.contentH = this._renderAchievements(ctx, W, y0);
    } else {
      this.contentH = this._renderBoards(ctx, W, y0);
    }
    ctx.restore();

    this._renderScrollbar(ctx, W, listH);
    this.backBtn.render(ctx);
  }

  _playtime() {
    const s = this.progress.playtimeSeconds | 0;
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
    return `${(s / 3600).toFixed(1)} 小时`;
  }

  _empty(ctx, W, text) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,247,232,0.55)';
    fillPixelText(ctx, text, W / 2, this.listTop + 60, 26);
    this.contentH = 0;
  }

  // ---------------- 统计 ----------------

  _renderStats(ctx, W, y0) {
    const rows = this.progress.statRows();
    if (!rows.length) {
      this._empty(ctx, W, this.progress.loggedIn ? '还没有数据，先打一局' : '未登录，无法读取统计');
      return 0;
    }
    const step = 46;
    const left = this.padX + 14;
    const right = W - this.padX - 14;
    rows.forEach((r, i) => {
      const y = y0 + 26 + i * step;
      if (y < this.listTop - step || y > this.listBottom + step) return; // 视口外不画
      // 斑马纹，长列表里更好对齐
      if (i % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        ctx.fillRect(this.padX, y - step / 2 + 2, W - this.padX * 2, step - 4);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,247,232,0.88)';
      fillPixelText(ctx, r.name, left, y, 26);
      ctx.textAlign = 'right';
      ctx.fillStyle = palette.gold;
      fillPixelText(ctx, this._fmt(r.value), right, y, 28);
    });
    ctx.textAlign = 'left';
    return rows.length * step + 52;
  }

  /** 大数字加千分位，读起来省力 */
  _fmt(n) {
    const v = Math.round(n || 0);
    return v >= 1000 ? v.toLocaleString('en-US') : String(v);
  }

  // ---------------- 成就 ----------------

  _renderAchievements(ctx, W, y0) {
    const rows = this.progress.achievementRows();
    if (!rows.length) {
      this._empty(ctx, W, this.progress.loggedIn ? '成就目录是空的' : '未登录，无法读取成就');
      return 0;
    }
    // 已解锁的排前面，剩下按进度从高到低——快拿到的更值得被看见
    const sorted = [...rows].sort((a, b) => {
      if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
      return b.progress - a.progress;
    });
    const step = 92;
    const left = this.padX + 14;
    const right = W - this.padX - 14;
    sorted.forEach((r, i) => {
      const y = y0 + 30 + i * step;
      if (y < this.listTop - step || y > this.listBottom + step) return;
      const locked = !r.unlocked;
      ctx.textAlign = 'left';
      ctx.fillStyle = locked ? 'rgba(255,247,232,0.5)' : palette.gold;
      fillPixelText(ctx, `${r.unlocked ? '★' : '☆'} ${r.name}`, left, y, 28);
      ctx.fillStyle = locked ? 'rgba(255,247,232,0.4)' : 'rgba(255,247,232,0.72)';
      fillPixelText(ctx, r.description || '', left, y + 30, 21);
      // 进度型成就画一条进度条 + 当前值/阈值
      if (r.bindStat && r.unlockAt > 0) {
        const cur = Math.min(this.progress.get(r.bindStat), r.unlockAt);
        pixelBar(ctx, left, y + 52, right - left, 14, r.progress,
          r.unlocked ? palette.ok : '#e8a20c');
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(255,247,232,0.6)';
        fillPixelText(ctx, `${this._fmt(cur)} / ${this._fmt(r.unlockAt)}`, right, y + 30, 21);
      } else {
        ctx.textAlign = 'right';
        ctx.fillStyle = r.unlocked ? palette.ok : 'rgba(255,247,232,0.45)';
        fillPixelText(ctx, r.unlocked ? '已解锁' : '未解锁', right, y + 30, 21);
      }
      // 全球完成率：让玩家知道自己拿的是不是稀有货
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,247,232,0.45)';
      fillPixelText(ctx, `全球 ${r.percent.toFixed(1)}%`, right, y, 20);
    });
    ctx.textAlign = 'left';
    return sorted.length * step + 56;
  }

  // ---------------- 排行榜 ----------------

  _renderBoards(ctx, W, y0) {
    const boards = this.progress.defs.leaderboards || [];
    if (!boards.length) {
      this._empty(ctx, W, this.progress.loggedIn ? '还没有排行榜' : '未登录，无法读取排行榜');
      return 0;
    }
    const left = this.padX + 14;
    const right = W - this.padX - 14;

    // 榜切换：两列平铺，当前榜金色
    const colW = Math.floor((right - left) / 2);
    this.boardBtns = boards.map((b, i) => ({
      id: b.id,
      x: left + (i % 2) * colW,
      y: y0 + 18 + Math.floor(i / 2) * 52,
      w: colW - 8,
      h: 44,
      name: b.name || b.id
    }));
    for (const b of this.boardBtns) {
      const on = b.id === this.boardId;
      pixelPanel(ctx, b.x, b.y, b.w, b.h, { fill: on ? '#8a6a2a' : '#3a2c4e', border: 3 });
      ctx.textAlign = 'center';
      ctx.fillStyle = on ? palette.white : 'rgba(255,247,232,0.7)';
      fillPixelText(ctx, b.name, b.x + b.w / 2, b.y + b.h / 2, 22);
    }

    const rowsTop = y0 + 18 + Math.ceil(boards.length / 2) * 52 + 22;
    const data = this.progress.board(this.boardId, 10);
    const cur = boards.find((b) => b.id === this.boardId);

    ctx.textAlign = 'center';
    ctx.fillStyle = palette.white;
    fillPixelText(ctx, cur ? cur.name : '', W / 2, rowsTop, 28);

    // 接口返回 { id, name, sort, keep, display, top: [...], me: {score,rank} | null }
    const top = (data && data.top) || [];
    if (!top.length) {
      ctx.fillStyle = 'rgba(255,247,232,0.55)';
      fillPixelText(ctx, data ? '这个榜还没人上榜' : '读取中…', W / 2, rowsTop + 46, 24);
      return rowsTop - y0 + 90;
    }

    const myRank = data.me && data.me.rank;
    const step = 44;
    top.slice(0, 10).forEach((e, i) => {
      const y = rowsTop + 44 + i * step;
      // 接口没给「这行是不是我」，只能按名次比对（每榜每人一行，名次唯一）
      const mine = myRank != null && e.rank === myRank;
      if (mine) {
        ctx.fillStyle = 'rgba(255,210,74,0.16)';
        ctx.fillRect(this.padX, y - step / 2 + 2, W - this.padX * 2, step - 4);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = i === 0 ? palette.gold : 'rgba(255,247,232,0.75)';
      fillPixelText(ctx, `${e.rank || i + 1}`, left, y, 24);
      ctx.fillStyle = mine ? palette.gold : 'rgba(255,247,232,0.88)';
      fillPixelText(ctx, this._short(ctx, e.nickname || '匿名', 260), left + 56, y, 24);
      ctx.textAlign = 'right';
      ctx.fillStyle = palette.gold;
      fillPixelText(ctx, this._boardValue(e.score, cur), right, y, 26);
    });

    // 我不在前 10 时，末尾单独补一行「我：第 N 名」
    const outside = myRank != null && myRank > top.length;
    if (outside) {
      const y = rowsTop + 44 + top.slice(0, 10).length * step + 12;
      ctx.textAlign = 'left';
      ctx.fillStyle = palette.gold;
      fillPixelText(ctx, `… 我：第 ${myRank} 名`, left, y, 24);
      ctx.textAlign = 'right';
      fillPixelText(ctx, this._boardValue(data.me.score, cur), right, y, 26);
    }

    ctx.textAlign = 'left';
    const shown = Math.min(10, top.length);
    return rowsTop - y0 + 44 + shown * step + (outside ? 60 : 30);
  }

  /** 榜的显示单位：秒 / 毫秒的榜换成时长 */
  _boardValue(score, def) {
    const v = Math.round(score || 0);
    const unit = def && def.display;
    if (unit === 'seconds') return this._dur(v);
    if (unit === 'ms') return this._dur(Math.round(v / 1000));
    return this._fmt(v);
  }

  _dur(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
  }

  /** 名字太长就截断加省略号，防止压到分数上 */
  _short(ctx, text, maxW) {
    pxFont(ctx, 24);
    let str = String(text);
    if (ctx.measureText(str).width <= maxW) return str;
    while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
    return str + '…';
  }

  // ---------------- 滚动 ----------------

  get _maxScroll() {
    return Math.max(0, this.contentH - (this.listBottom - this.listTop));
  }

  _renderScrollbar(ctx, W, listH) {
    const max = this._maxScroll;
    if (max <= 0) return;
    const trackX = W - this.padX + 2;
    const barH = Math.max(40, listH * (listH / this.contentH));
    const t = this.scroll / max;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(trackX, this.listTop, 8, listH);
    ctx.fillStyle = 'rgba(255,210,74,0.65)';
    ctx.fillRect(trackX, this.listTop + (listH - barH) * t, 8, barH);
  }

  _clampScroll() {
    this.scroll = Math.max(0, Math.min(this._maxScroll, this.scroll));
  }

  _inList(t) {
    return t.y >= this.listTop && t.y <= this.listBottom;
  }

  onTouchStart(t) {
    for (const b of this.tabBtns) b.handleTouch('start', t);
    this.backBtn.handleTouch('start', t);
    if (this._inList(t)) {
      this.drag = { y: t.y, from: this.scroll, moved: 0 };
    }
  }

  onTouchMove(t) {
    if (!this.drag) return;
    const dy = this.drag.y - t.y;
    this.drag.moved = Math.max(this.drag.moved, Math.abs(dy));
    this.scroll = this.drag.from + dy;
    this._clampScroll();
  }

  onTouchEnd(t) {
    for (const b of this.tabBtns) {
      if (b.handleTouch('end', t)) {
        this.drag = null;
        return;
      }
    }
    if (this.backBtn.handleTouch('end', t)) {
      this.drag = null;
      return;
    }
    // 没拖动过才算点击 —— 否则滚完列表会顺手切了榜
    const tapped = this.drag && this.drag.moved < DRAG_SLOP;
    this.drag = null;
    if (!tapped || this.tab !== 'boards') return;
    for (const b of this.boardBtns) {
      if (t.x >= b.x && t.x <= b.x + b.w && t.y >= b.y && t.y <= b.y + b.h) {
        this.boardId = b.id;
        return;
      }
    }
  }
}
