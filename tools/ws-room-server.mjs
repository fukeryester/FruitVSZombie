/**
 * GameHub 房间服务的本地最小实现（REST + WebSocket）
 * ------------------------------------------------------------------
 * 只为浏览器端自检存在：让**真正的 /static/gamehub-room.js SDK**
 * 有一个能连的服务端，从而把「SDK → RoomClient → MatchSession → StageSync」
 * 这条生产链路在真实浏览器里跑通一次。
 *
 * 实现的协议面（与线上文档一致）：
 *   REST  POST /api/v1/rooms           建房 → { room: { code, ... } }
 *         GET  /api/v1/rooms?game_id=  列房 → { rooms: [...] }
 *   WS    /ws/rooms
 *         上行 {op:'join'|'leave'|'broadcast'|'send'|'ping'}
 *         下行 {op:'welcome'|'member_joined'|'member_left'|'message'|'left'|'pong'|'error'}
 *
 * WebSocket 帧只处理文本帧与 close/ping，够用即止（不做分片、不做压缩扩展）。
 */
import crypto from 'crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** 编码一个文本帧（服务端发出的帧不掩码） */
function encodeText(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x81; // FIN + text
  return Buffer.concat([head, payload]);
}

/**
 * 从缓冲区里尽量多地解出完整帧。
 * @returns {{frames: Array<{opcode:number, data:Buffer}>, rest: Buffer}}
 */
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    frames.push({ opcode, data });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 6 位大写房间号，与线上一致（例如 8AMWXF） */
function roomCode() {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

/** 字段名与线上 /api/v1/rooms 的返回严格对齐 */
function snapshot(room) {
  return {
    code: room.code,
    game_id: room.gameId,
    host_id: room.hostId,
    max_players: room.maxPlayers,
    member_count: room.members.length,
    members: room.members.map((m) => ({ ...m }))
  };
}

/**
 * 把房间服务挂到一个已有的 http.Server 上。
 * @param {import('http').Server} server
 * @returns {{rooms: Map, handleRest: Function}} handleRest 交给请求回调里先行处理
 */
export function attachRoomService(server) {
  /** client_id → { socket, userId, room } */
  const clients = new Map();
  let userSeq = 0;

  function send(client, obj) {
    try {
      client.socket.write(encodeText(JSON.stringify(obj)));
    } catch (e) { /* 断了就算了 */ }
  }

  function leaveRoom(client, notify = true) {
    const room = client.room;
    if (!room) return;
    const me = room.members.find((m) => m.client_id === client.id);
    room.members = room.members.filter((m) => m.client_id !== client.id);
    room.clients.delete(client.id);
    client.room = null;
    if (notify) send(client, { op: 'left' });
    for (const other of room.clients.values()) {
      send(other, { op: 'member_left', member: me, room: snapshot(room) });
    }
    if (!room.members.length) rooms.delete(room.code);
  }

  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/ws/rooms')) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const client = {
      id: 'c' + crypto.randomBytes(5).toString('hex'),
      userId: ++userSeq,
      socket,
      room: null
    };
    clients.set(client.id, client);

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) { // close
          leaveRoom(client, false);
          clients.delete(client.id);
          socket.end();
          return;
        }
        if (f.opcode !== 0x1) continue;
        let msg;
        try {
          msg = JSON.parse(f.data.toString('utf8'));
        } catch (e) {
          continue;
        }
        handleOp(client, msg);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      leaveRoom(client, false);
      clients.delete(client.id);
    });
  });

  function handleOp(client, msg) {
    switch (msg.op) {
      case 'ping':
        send(client, { op: 'pong' });
        break;

      case 'join': {
        const room = rooms.get(String(msg.room || '').toUpperCase());
        if (!room) return send(client, { op: 'error', error: '房间不存在' });
        if (room.members.length >= room.maxPlayers) {
          return send(client, { op: 'error', error: '房间已满' });
        }
        const used = new Set(room.members.map((m) => m.seat));
        let seat = 0;
        while (used.has(seat)) seat++;
        const me = {
          seat,
          client_id: client.id,
          user_id: client.userId,
          username: 'player' + client.userId
        };
        room.members.push(me);
        room.members.sort((a, b) => a.seat - b.seat);
        room.clients.set(client.id, client);
        client.room = room;
        if (!room.hostId) room.hostId = client.userId;
        send(client, { op: 'welcome', you: me, room: snapshot(room) });
        for (const [id, other] of room.clients) {
          if (id === client.id) continue;
          send(other, { op: 'member_joined', member: me, room: snapshot(room) });
        }
        break;
      }

      case 'leave':
        leaveRoom(client);
        break;

      case 'broadcast': {
        const room = client.room;
        if (!room) return;
        for (const [id, other] of room.clients) {
          if (id === client.id) continue;
          send(other, { op: 'message', from: client.id, data: msg.data });
        }
        break;
      }

      case 'send': {
        const room = client.room;
        if (!room) return;
        const target = room.clients.get(msg.to);
        if (target) send(target, { op: 'message', from: client.id, data: msg.data });
        break;
      }

      default:
        send(client, { op: 'error', error: '未知指令 ' + msg.op });
    }
  }

  /**
   * REST 部分。请求回调里先调它；返回 true 表示已处理。
   */
  function handleRest(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/v1/rooms') return false;
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(body || '{}');
        } catch (e) { /* 空体也接受 */ }
        const room = {
          code: roomCode(),
          gameId: payload.game_id || '',
          maxPlayers: Math.min(8, Math.max(2, payload.max_players || 4)),
          hostId: '',
          members: [],
          clients: new Map()
        };
        rooms.set(room.code, room);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, room: snapshot(room) }));
      });
      return true;
    }
    if (req.method === 'GET') {
      const gameId = url.searchParams.get('game_id') || '';
      const list = [...rooms.values()]
        .filter((r) => !gameId || r.gameId === gameId)
        .map(snapshot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: list }));
      return true;
    }
    return false;
  }

  return { rooms, handleRest };
}
