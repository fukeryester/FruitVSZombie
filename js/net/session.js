/**
 * 联机会话（MatchSession）—— 挂在 game.net 上的唯一联机入口
 * ------------------------------------------------------------------
 * 职责边界：
 *   · 连接 / 建房 / 加房 / 成员名册（谁在几号位、叫什么）；
 *   · 谁是 host —— 见下方「主机判定」；
 *   · 报文收发与分发：当前 state 用 setHandler() 接管 message 事件。
 * 不做任何玩法计算，玩法同步在 js/net/stageSync.js。
 *
 * 主机判定
 * ------------------------------------------------------------------
 * 文档建议用 `you.seat === 0` 或 `you.user_id === room.host_id`。后者在
 * 「同一个账号开两个窗口自测」时会让两边都认为自己是 host，所以这里：
 *   · 房间里：座位号最小的那个 client 是「房主」，只有他能点开始；
 *   · 开局后：由点开始的那个 client_id 固定当整局的 host（matchHostId），
 *     中途座位重排也不会换主机；host 掉线则整局中止回房间。
 */
import { MAX_PLAYERS } from '../config/net.js';
import { M } from './protocol.js';
import { RoomClient, isNetSupported, detectGameId } from './roomClient.js';

/** 会话阶段 */
export const PHASE = {
  OFFLINE: 'offline',   // 未联机（单机）
  ROOM: 'room',         // 在房间里等待开始
  MATCH: 'match'        // 对局进行中
};

export class MatchSession {
  constructor() {
    this.client = new RoomClient();
    this.phase = PHASE.OFFLINE;
    this.gameId = detectGameId();
    /** 本地玩家昵称（排行榜主键），由 Main 注入 */
    this.playerName = '';
    /** seat → { seat, clientId, userId, username, name } */
    this.members = new Map();
    /** 整局固定的主机 client_id（开局时确定） */
    this.matchHostId = '';
    /**
     * guest 侧的「待消费的切阶段命令」：STAGE 报文先落在这里，
     * 新 state 的 onEnter 会取走它（场地描述 + 各座位继承分）。
     */
    this.pendingStage = null;
    this.lastError = '';
    this._handler = null;
    this._bound = false;
    this._onRosterChange = null;
  }

  // ---------------- 基本状态 ----------------

  static get supported() {
    return isNetSupported();
  }

  get connected() {
    return this.client.connected;
  }

  get joined() {
    return this.client.joined;
  }

  get online() {
    return this.phase !== PHASE.OFFLINE && this.joined;
  }

  /** 是否正处于一局联机对局中（局内 state 用它判断要不要走同步逻辑） */
  get inMatch() {
    return this.phase === PHASE.MATCH && this.joined;
  }

  get you() {
    return this.client.you;
  }

  get seat() {
    return this.client.you ? this.client.you.seat : 0;
  }

  get clientId() {
    return this.client.you ? this.client.you.client_id : '';
  }

  get code() {
    return this.client.info ? this.client.info.code : '';
  }

  get playerCount() {
    return Math.max(1, this.members.size);
  }

  /** 座位号最小的成员是房主（唯一有权开始对局的人） */
  get ownerSeat() {
    let min = Infinity;
    for (const seat of this.members.keys()) min = Math.min(min, seat);
    return Number.isFinite(min) ? min : 0;
  }

  get isOwner() {
    return this.joined && this.seat === this.ownerSeat;
  }

  /** 本机是否是当前对局的主机（权威端） */
  get isHost() {
    if (this.phase === PHASE.MATCH) return this.matchHostId === this.clientId;
    return this.isOwner;
  }

  /** 主机所在座位（HUD 上给主机加个标记） */
  get hostSeat() {
    if (this.phase !== PHASE.MATCH) return this.ownerSeat;
    const seat = this.seatOfClient(this.matchHostId);
    return seat >= 0 ? seat : this.ownerSeat;
  }

  /** 按座位升序的成员数组 */
  get roster() {
    return Array.from(this.members.values()).sort((a, b) => a.seat - b.seat);
  }

  nameOf(seat) {
    const m = this.members.get(seat);
    return m ? m.name : `玩家${(seat | 0) + 1}`;
  }

  seatOfClient(clientId) {
    for (const m of this.members.values()) {
      if (m.clientId === clientId) return m.seat;
    }
    return -1;
  }

  // ---------------- 连接与房间 ----------------

  _bind() {
    if (this._bound) return;
    this._bound = true;
    const c = this.client;
    c.on('welcome', (m) => {
      this._syncRoster(m.room);
    });
    c.on('member_joined', (m) => {
      this._syncRoster(m.room);
      // 有新人进来就把自己的昵称再播一次，保证他能看到完整名册
      this.broadcast({ t: M.HELLO, n: this.playerName }, { critical: true });
    });
    c.on('member_left', (m) => {
      const goneId = m.member ? m.member.client_id : '';
      this._syncRoster(m.room);
      if (this.phase === PHASE.MATCH && goneId && goneId === this.matchHostId) {
        this.lastError = '房主已离开，本局中止';
        this.phase = PHASE.ROOM;
      }
      this._dispatch({ t: '_left', clientId: goneId, seat: m.member ? m.member.seat : -1 });
    });
    c.on('message', (m) => {
      if (!m || !m.data) return;
      this._dispatch(m.data, m.from);
    });
    c.on('left', () => {
      this.members.clear();
      this.phase = PHASE.OFFLINE;
      this._fireRoster();
    });
    c.on('close', () => {
      this.members.clear();
      this.phase = PHASE.OFFLINE;
      this.lastError = '与房间服务的连接已断开';
      this._fireRoster();
    });
    c.on('error', (m) => {
      this.lastError = (m && m.error) || '房间服务异常';
    });
  }

  _syncRoster(room) {
    if (!room || !Array.isArray(room.members)) return;
    const next = new Map();
    for (const mem of room.members) {
      const old = this.members.get(mem.seat);
      next.set(mem.seat, {
        seat: mem.seat,
        clientId: mem.client_id,
        userId: mem.user_id,
        username: mem.username,
        // 昵称优先用玩家自己填的（HELLO 报文带过来），没有就用站点用户名
        name: (old && old.clientId === mem.client_id && old.name) || mem.username || `玩家${mem.seat + 1}`
      });
    }
    // 自己的昵称以本地输入为准
    const me = next.get(this.seat);
    if (me && this.playerName) me.name = this.playerName;
    this.members = next;
    this._fireRoster();
  }

  onRosterChange(fn) {
    this._onRosterChange = fn;
  }

  _fireRoster() {
    if (this._onRosterChange) {
      try {
        this._onRosterChange(this.roster);
      } catch (e) {
        console.error('[net] roster', e);
      }
    }
  }

  /** 连接房间服务（幂等）。返回是否成功 */
  async connect() {
    this._bind();
    const ok = await this.client.connect();
    if (!ok) this.lastError = this.client.lastError || '无法连接房间服务';
    return ok;
  }

  /** 建房并加入。成功返回房间号 */
  async host() {
    if (!(await this.connect())) return '';
    if (!this.gameId) {
      this.lastError = '取不到游戏 id，请从书架里打开游戏';
      return '';
    }
    let room;
    try {
      room = await this.client.createRoom(this.gameId, MAX_PLAYERS);
    } catch (e) {
      this.lastError = (e && e.message) || '创建房间失败';
      return '';
    }
    return (await this.joinRoom(room.code)) ? room.code : '';
  }

  /** 加入指定房间号；等待 welcome 后返回 */
  async joinRoom(code) {
    if (!(await this.connect())) return false;
    const target = String(code || '').trim().toUpperCase();
    if (!target) {
      this.lastError = '请填写房间号';
      return false;
    }
    const ok = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        this.client.off('welcome', onWelcome);
        this.client.off('error', onError);
        clearTimeout(timer);
        resolve(v);
      };
      const onWelcome = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), 8000);
      this.client.on('welcome', onWelcome);
      this.client.on('error', onError);
      try {
        this.client.join(target);
      } catch (e) {
        this.lastError = (e && e.message) || '加入房间失败';
        finish(false);
      }
    });
    if (ok) {
      this.phase = PHASE.ROOM;
      this.broadcast({ t: M.HELLO, n: this.playerName }, { critical: true });
    } else if (!this.lastError) {
      this.lastError = '加入房间失败';
    }
    return ok;
  }

  /** 列房（给「加入房间」界面用） */
  async listRooms() {
    if (!this.gameId) return [];
    try {
      return await this.client.listRooms(this.gameId);
    } catch (e) {
      this.lastError = (e && e.message) || '拉取房间列表失败';
      return [];
    }
  }

  /** 退出房间回到单机 */
  leave() {
    this.client.leave();
    this.members.clear();
    this.phase = PHASE.OFFLINE;
    this.matchHostId = '';
    this._fireRoster();
  }

  /** 设置本地昵称并广播（房间里改名会同步给其他人） */
  setPlayerName(name) {
    this.playerName = name || '';
    const me = this.members.get(this.seat);
    if (me) me.name = this.playerName || me.username;
    if (this.joined) this.broadcast({ t: M.HELLO, n: this.playerName }, { critical: true });
    this._fireRoster();
  }

  // ---------------- 对局生命周期 ----------------

  /** 房主开局：锁定自己为整局 host 并进入 MATCH */
  beginMatchAsHost() {
    this.matchHostId = this.clientId;
    this.phase = PHASE.MATCH;
  }

  /** guest 收到开局报文：记录 host 并进入 MATCH */
  beginMatchAsGuest(hostClientId) {
    this.matchHostId = hostClientId || '';
    this.phase = PHASE.MATCH;
  }

  /** 对局结束回到房间（不断开连接，可以直接再来一局） */
  endMatch() {
    if (this.joined) this.phase = PHASE.ROOM;
    else this.phase = PHASE.OFFLINE;
    this.matchHostId = '';
  }

  // ---------------- 收发 ----------------

  /** 当前 state 接管报文；返回一个取消函数 */
  setHandler(fn) {
    const prev = this._handler;
    this._handler = fn;
    return () => {
      if (this._handler === fn) this._handler = prev;
    };
  }

  _dispatch(data, fromClientId) {
    // HELLO 是名册维护，会话层自己吃掉（同时也透传给 state，便于刷新 UI）
    if (data && data.t === M.HELLO) {
      const seat = this.seatOfClient(fromClientId);
      const mem = this.members.get(seat);
      if (mem) {
        mem.name = data.n || mem.username || `玩家${seat + 1}`;
        this._fireRoster();
      }
    }
    if (!this._handler) return;
    try {
      this._handler(data, fromClientId);
    } catch (e) {
      console.error('[net] handler', e);
    }
  }

  broadcast(msg, opts) {
    return this.client.send(msg, opts);
  }

  sendTo(clientId, msg, opts) {
    return this.client.send(msg, Object.assign({}, opts, { to: clientId }));
  }

  /** 发给当前对局的 host（guest 上报输入用） */
  sendToHost(msg, opts) {
    if (!this.matchHostId || this.matchHostId === this.clientId) return false;
    return this.sendTo(this.matchHostId, msg, opts);
  }

  /** 每帧驱动：把积压的关键报文冲出去 */
  update() {
    this.client.flush();
  }
}
