/**
 * GameHub 房间服务的进程内模拟
 * ------------------------------------------------------------------
 * 只实现联机代码真正用到的那部分语义，用于 node 侧的多端联调自检：
 *   · createRoom / listRooms / join / leave
 *   · welcome / member_joined / member_left / message 事件
 *   · 定向发送（to）与广播
 *   · 8KB 单包上限与每秒 20 条的频率限制（超限回 error，跟线上一致）
 *
 * 每个 MockClient 长得跟真 SDK 一个样，所以 RoomClient 可以直接吃它
 * （见 roomClient.js 的 __setSdkFactory 注入点）。
 */
const MAX_BYTES = 8192;
const RATE_PER_SEC = 20;

let seq = 0;
const rooms = new Map();

function code() {
  return 'R' + String(++seq).padStart(5, '0');
}

export function reset() {
  rooms.clear();
  seq = 0;
}

export function createRoom(gameId, maxPlayers) {
  const room = {
    code: code(),
    game_id: gameId,
    max_players: maxPlayers,
    host_id: '',
    members: [],
    clients: new Map()
  };
  rooms.set(room.code, room);
  return { code: room.code, game_id: gameId, max_players: maxPlayers, player_count: 0 };
}

export function listRooms(gameId) {
  return Array.from(rooms.values())
    .filter((r) => r.game_id === gameId)
    .map((r) => ({
      code: r.code,
      game_id: r.game_id,
      max_players: r.max_players,
      player_count: r.members.length
    }));
}

function snapshot(room) {
  return {
    code: room.code,
    host_id: room.host_id,
    max_players: room.max_players,
    members: room.members.map((m) => ({ ...m }))
  };
}

function fanout(room, from, payload, to) {
  for (const [cid, client] of room.clients) {
    if (cid === from) continue;
    if (to && cid !== to) continue;
    client._recv({ op: 'message', from, data: payload });
  }
}

/** 下一个 MockClient 的 user_id（默认每个客户端一个账号，模拟四个人） */
let nextUser = 0;

export class MockClient {
  constructor(userId = 'u' + (++nextUser)) {
    this.clientId = 'c' + Math.random().toString(36).slice(2, 10);
    this.userId = userId;
    /** RoomClient 用 ws.readyState 判连接状态，这里给个恒为 OPEN 的假 socket */
    this.ws = { readyState: 1 };
    this._room = null;   // 所在房间（服务端侧数据）
    this.room = null;    // SDK 语义里的房间快照
    this.you = null;
    this._listeners = new Map();
    this._sent = [];
    this.stats = { sent: 0, bytes: 0, maxBytes: 0, errors: 0 };
  }

  on(name, fn) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set());
    this._listeners.get(name).add(fn);
  }

  off(name, fn) {
    const set = this._listeners.get(name);
    if (set) set.delete(fn);
  }

  _emit(name, payload) {
    const set = this._listeners.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) fn(payload);
  }

  _recv(msg) {
    this._emit(msg.op, msg);
  }

  async connect() {
    return this;
  }

  createRoom(gameId, maxPlayers) {
    return Promise.resolve(createRoom(gameId, maxPlayers));
  }

  listRooms(gameId) {
    return Promise.resolve(listRooms(gameId));
  }

  join(roomCode) {
    const room = rooms.get(String(roomCode).toUpperCase());
    if (!room) {
      this._emit('error', { op: 'error', error: '房间不存在' });
      return;
    }
    if (room.members.length >= room.max_players) {
      this._emit('error', { op: 'error', error: '房间已满' });
      return;
    }
    const used = new Set(room.members.map((m) => m.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    const me = {
      seat,
      client_id: this.clientId,
      user_id: this.userId,
      username: 'user' + this.userId
    };
    room.members.push(me);
    room.members.sort((a, b) => a.seat - b.seat);
    room.clients.set(this.clientId, this);
    if (!room.host_id) room.host_id = this.userId;
    this._room = room;
    this.you = me;
    this.room = snapshot(room);

    this._recv({ op: 'welcome', you: me, room: snapshot(room) });
    for (const [cid, c] of room.clients) {
      if (cid === this.clientId) continue;
      c.room = snapshot(room);
      c._recv({ op: 'member_joined', member: me, room: snapshot(room) });
    }
  }

  leave() {
    const room = this._room;
    if (!room) return;
    room.clients.delete(this.clientId);
    const me = room.members.find((m) => m.client_id === this.clientId);
    room.members = room.members.filter((m) => m.client_id !== this.clientId);
    this._room = null;
    this.you = null;
    this.room = null;
    this._recv({ op: 'left' });
    for (const c of room.clients.values()) {
      c.room = snapshot(room);
      c._recv({ op: 'member_left', member: me, room: snapshot(room) });
    }
  }

  close() {
    this.leave();
    this.ws = { readyState: 3 };
    this._emit('close', { code: 1000 });
  }

  /** SDK 语义：广播给房间里其他所有人 */
  broadcast(data) {
    this._push(data, null);
  }

  /** SDK 语义：单播给某个 client_id */
  send(clientId, data) {
    this._push(data, clientId);
  }

  _push(data, to) {
    if (!this._room) return false;
    const text = JSON.stringify(data);
    this.stats.sent++;
    this.stats.bytes += text.length;
    this.stats.maxBytes = Math.max(this.stats.maxBytes, text.length);
    if (text.length > MAX_BYTES) {
      this.stats.errors++;
      this._emit('error', { op: 'error', error: '消息过大' });
      return false;
    }
    const now = Date.now();
    this._sent = this._sent.filter((t) => now - t < 1000);
    if (this._sent.length >= RATE_PER_SEC) {
      this.stats.errors++;
      this._emit('error', { op: 'error', error: '发送过于频繁' });
      return false;
    }
    this._sent.push(now);
    fanout(this._room, this.clientId, data, to);
    return true;
  }

  ping() {}
}
