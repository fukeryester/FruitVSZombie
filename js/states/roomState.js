/**
 * 联机房间（RoomState）
 * ------------------------------------------------------------------
 * 开一局联机对战的全部前置操作都在这里：
 *   改名 → 建房 / 从列表加入 / 手输房间号 → 等人齐 → 房主开始。
 *
 * 房主 = 座位号最小的人（见 MatchSession.isOwner）。按下「开始游戏」后
 * 由他锁定为整局的 host 并切进第一阶段，其余人收到 STAGE 报文自动跟进
 * （见 stageSync.applyStageCommand）。
 */
import { BaseState } from '../core/stateMachine.js';
import { Button, showToast } from '../ui/widgets.js';
import { applyPixelCtx, fillPixelText, pixelPanel, palette } from '../ui/pixel.js';
import { drawStageBg } from '../ui/hud.js';
import { seatColor, MAX_PLAYERS } from '../config/net.js';
import { M } from '../net/protocol.js';
import { applyStageCommand } from '../net/stageSync.js';
import { askPlayerName, canPromptName } from '../core/playerName.js';

export default class RoomState extends BaseState {
  onEnter() {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;
    this.net = g.net;
    this.status = '未连接';
    this.busy = false;
    this.rooms = [];
    this.roomBtns = [];
    this.listAt = 0;

    const bw = Math.min(460, W - 100);
    const cx = (W - bw) / 2;

    this.nameBtn = new Button({
      x: W - 220, y: H * 0.16, w: 190, h: 66,
      text: '改名', bgColor: '#5a4a8a', fontSize: 30,
      onTap: () => this._rename()
    });
    this.createBtn = new Button({
      x: cx, y: H * 0.28, w: bw, h: 92,
      text: '创建房间', bgColor: '#2e8b3a', fontSize: 36,
      onTap: () => this._create()
    });
    this.joinBtn = new Button({
      x: cx, y: H * 0.28 + 108, w: bw, h: 92,
      text: '输入房间号加入', bgColor: '#2f6fb0', fontSize: 34,
      onTap: () => this._joinByCode()
    });
    this.refreshBtn = new Button({
      x: cx, y: H * 0.28 + 216, w: bw, h: 76,
      text: '刷新房间列表', bgColor: '#5a5a6a', fontSize: 30,
      onTap: () => this._refresh()
    });
    this.startBtn = new Button({
      x: cx, y: H * 0.68, w: bw, h: 100,
      text: '开始游戏', bgColor: '#2e8b3a', fontSize: 40,
      onTap: () => this._start()
    });
    this.leaveBtn = new Button({
      x: cx, y: H * 0.68 + 116, w: bw, h: 84,
      text: '离开房间', bgColor: '#8a4a4a', fontSize: 32,
      onTap: () => this._leave()
    });
    this.backBtn = new Button({
      x: cx, y: H * 0.86, w: bw, h: 84,
      text: '返回大厅', bgColor: '#6a5a7a', fontSize: 32,
      onTap: () => g.states.switchTo(g.createLobbyState())
    });

    if (!this.net) {
      this.status = '当前环境不支持联机（请在网页版书架里游玩）';
      return;
    }
    this.net.onRosterChange(() => { /* 名册变化时下一帧自然重绘 */ });
    this._detach = this.net.setHandler((data, from) => this._onMessage(data, from));
    this._connect();
    g.audio.startBgm('lobby');
  }

  onExit() {
    if (this._detach) {
      this._detach();
      this._detach = null;
    }
    if (this.net) this.net.onRosterChange(null);
    this.game.audio.stopBgm();
  }

  // ---------------- 网络动作 ----------------

  async _connect() {
    this.status = '正在连接房间服务…';
    const ok = await this.net.connect();
    if (!ok) {
      this.status = this.net.lastError || '连接失败';
      return;
    }
    this.status = '已连接，创建或加入一个房间';
    this._refresh();
  }

  async _refresh() {
    if (this.busy || !this.net) return;
    this.busy = true;
    this.rooms = await this.net.listRooms();
    this.listAt = Date.now();
    this.busy = false;
    this._layoutRoomList();
  }

  _layoutRoomList() {
    const g = this.game;
    const W = g.screenW;
    const bw = Math.min(460, W - 100);
    const cx = (W - bw) / 2;
    const y0 = g.screenH * 0.28 + 316;
    this.roomBtns = this.rooms.slice(0, 4).map((r, i) => {
      const btn = new Button({
        x: cx, y: y0 + i * 82, w: bw, h: 72,
        text: `房间 ${r.code}  ${r.member_count}/${r.max_players}`,
        bgColor: r.member_count >= r.max_players ? '#4a4a4a' : '#3f7f8f',
        fontSize: 28,
        onTap: () => this._joinCode(r.code)
      });
      return btn;
    });
  }

  async _create() {
    if (this.busy || !this.net) return;
    this.busy = true;
    this.status = '正在创建房间…';
    const code = await this.net.host();
    this.busy = false;
    if (code) {
      this.status = `房间已创建：${code}`;
      showToast(`房间号 ${code}，把它发给队友`);
    } else {
      this.status = this.net.lastError || '创建房间失败';
    }
  }

  async _joinByCode() {
    if (!canPromptName()) {
      showToast('当前环境无法输入，请从列表里点房间加入');
      return;
    }
    const code = await wx.promptText({
      title: '加入房间',
      tip: '输入队友发给你的 6 位房间号',
      value: '',
      maxLength: 6,
      placeholder: '例如 AB3K7Q'
    });
    if (code) this._joinCode(code);
  }

  async _joinCode(code) {
    if (this.busy || !this.net) return;
    this.busy = true;
    this.status = `正在加入 ${code} …`;
    const ok = await this.net.joinRoom(code);
    this.busy = false;
    this.status = ok ? `已加入房间 ${this.net.code}` : (this.net.lastError || '加入失败');
  }

  _leave() {
    if (!this.net) return;
    this.net.leave();
    this.status = '已离开房间';
    this._refresh();
  }

  async _rename() {
    const next = await askPlayerName(this.game.playerName);
    if (!next) return;
    this.game.setPlayerName(next);
    showToast(`昵称已改为 ${next}`);
  }

  _start() {
    if (!this.net || !this.net.isOwner) {
      showToast('只有房主可以开始');
      return;
    }
    this.net.beginMatchAsHost();
    const g = this.game;
    g.states.switchTo(g.createStageState('fruitMerge'));
  }

  _onMessage(data, from) {
    if (!data) return;
    // 房主已经开局：跟着切到第一阶段
    if (data.t === M.STAGE) applyStageCommand(this.game, data, from);
  }

  // ---------------- 渲染 ----------------

  onRender(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;
    applyPixelCtx(ctx);
    drawStageBg(ctx, W, H, H - 24, 'lobby');
    ctx.fillStyle = 'rgba(8,4,16,0.45)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.gold;
    fillPixelText(ctx, '联机对战', W / 2, H * 0.09, 56);
    ctx.fillStyle = 'rgba(255,247,232,0.75)';
    fillPixelText(ctx, `最多 ${MAX_PLAYERS} 人同场 · 卡牌效果全队共享`, W / 2, H * 0.09 + 52, 24);

    ctx.textAlign = 'left';
    ctx.fillStyle = palette.white;
    fillPixelText(ctx, `我：${g.playerName}`, 40, H * 0.16 + 33, 30);
    this.nameBtn.render(ctx);

    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,247,232,0.8)';
    fillPixelText(ctx, this.status, W / 2, H * 0.22, 24);

    if (this.net && this.net.joined) this._renderRoom(ctx);
    else this._renderBrowse(ctx);

    this.backBtn.render(ctx);
  }

  _renderBrowse(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;
    this.createBtn.render(ctx);
    this.joinBtn.render(ctx);
    this.refreshBtn.render(ctx);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,247,232,0.6)';
    const tip = this.rooms.length ? '点一个房间直接加入' : '暂无房间，先创建一个吧';
    fillPixelText(ctx, tip, W / 2, H * 0.28 + 300, 22);
    for (const b of this.roomBtns) b.render(ctx);
  }

  _renderRoom(ctx) {
    const g = this.game;
    const W = g.screenW;
    const H = g.screenH;
    const roster = this.net.roster;
    const panelW = Math.min(560, W - 80);
    const px = (W - panelW) / 2;
    const py = H * 0.27;
    const rowH = 74;
    pixelPanel(ctx, px, py, panelW, 78 + rowH * MAX_PLAYERS, { fill: '#241830', border: 5 });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = palette.gold;
    fillPixelText(ctx, `房间号 ${this.net.code}`, W / 2, py + 40, 40);

    for (let seat = 0; seat < MAX_PLAYERS; seat++) {
      const mem = roster.find((m) => m.seat === seat);
      const ry = py + 78 + seat * rowH;
      pixelPanel(ctx, px + 16, ry + 6, panelW - 32, rowH - 14, {
        fill: mem ? 'rgba(60,44,90,0.9)' : 'rgba(30,22,44,0.7)',
        border: 3
      });
      ctx.fillStyle = seatColor(seat);
      ctx.fillRect(px + 28, ry + 18, 10, rowH - 38);
      ctx.textAlign = 'left';
      if (mem) {
        const tags = [];
        if (mem.seat === this.net.ownerSeat) tags.push('房主');
        if (mem.seat === this.net.seat) tags.push('你');
        ctx.fillStyle = palette.white;
        fillPixelText(ctx, mem.name + (tags.length ? `（${tags.join('·')}）` : ''), px + 50, ry + rowH / 2, 28);
      } else {
        ctx.fillStyle = 'rgba(255,247,232,0.35)';
        fillPixelText(ctx, `${seat + 1} 号位 · 空`, px + 50, ry + rowH / 2, 26);
      }
    }

    if (this.net.isOwner) {
      this.startBtn.text = roster.length > 1 ? '开始游戏' : '单人开始（可等人齐）';
      this.startBtn.render(ctx);
    } else {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,247,232,0.7)';
      fillPixelText(ctx, '等待房主开始…', W / 2, this.startBtn.y + 50, 30);
    }
    this.leaveBtn.render(ctx);
  }

  // ---------------- 触摸 ----------------

  _buttons() {
    const list = [this.backBtn, this.nameBtn];
    if (this.net && this.net.joined) {
      if (this.net.isOwner) list.push(this.startBtn);
      list.push(this.leaveBtn);
    } else {
      list.push(this.createBtn, this.joinBtn, this.refreshBtn, ...this.roomBtns);
    }
    return list;
  }

  onTouchStart(t) {
    for (const b of this._buttons()) b.handleTouch('start', t);
  }

  onTouchEnd(t) {
    for (const b of this._buttons()) {
      if (b.handleTouch('end', t)) return;
    }
  }
}
