/**
 * 排行榜 —— 接的是**真实对局分数**，以玩家昵称为主键
 * ------------------------------------------------------------------
 * 每次结算都会把「昵称 → 本局分数」写进榜单：同名只保留历史最好成绩，
 * 同时累计游玩局数与最后一次游玩时间。联机时房主会把全房间四个人的
 * 成绩一起下发，于是每台机器的榜单都会把队友的真实成绩合并进来。
 *
 * 关于存储位置：GameHub 只提供房间与消息转发，没有对外的键值存储接口，
 * 所以榜单落在本地（网页版即 localStorage，见 wx-shim 的 setStorageSync）。
 * 换句话说它是「本机 + 一起联过机的人」的真实成绩榜，不是全服榜。
 * 将来平台若开放存储接口，只要把 loadBoard / saveBoard 换成远端读写，
 * 其余调用方一行都不用改。
 */
import { sanitizeName } from './playerName.js';

const KEY = 'fvz_leaderboard_v1';
/** 榜单最多保留多少条（超出丢弃分数最低的） */
const MAX_ROWS = 200;

function readRaw() {
  try {
    const v = wx.getStorageSync(KEY);
    if (!v) return [];
    const arr = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeRaw(rows) {
  try {
    wx.setStorageSync(KEY, rows);
  } catch (e) {
    /* 存储不可用时榜单只在本次运行内有效 */
  }
}

function normalize(row) {
  const name = sanitizeName(row && row.name);
  if (!name) return null;
  const score = Math.max(0, Math.floor(Number(row.score) || 0));
  return {
    name,
    score,
    plays: Math.max(1, Math.floor(Number(row.plays) || 1)),
    at: Number(row.at) || Date.now()
  };
}

/** 读取整张榜（按分数降序） */
export function loadBoard() {
  return readRaw()
    .map(normalize)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.at - b.at);
}

function saveBoard(rows) {
  writeRaw(rows.slice(0, MAX_ROWS));
}

/**
 * 写入一批成绩（同名取最高分，局数累加）。
 * @param {Array<{name:string, score:number}>} entries
 * @returns {Array} 合并后的榜单
 */
export function submitScores(entries) {
  const board = loadBoard();
  const byName = new Map(board.map((r) => [r.name, r]));
  for (const raw of entries || []) {
    const row = normalize(raw);
    if (!row) continue;
    const old = byName.get(row.name);
    if (!old) {
      byName.set(row.name, row);
    } else {
      old.score = Math.max(old.score, row.score);
      old.plays += 1;
      old.at = Math.max(old.at, row.at);
    }
  }
  const next = Array.from(byName.values()).sort((a, b) => b.score - a.score || a.at - b.at);
  saveBoard(next);
  return next;
}

/** 写入单条成绩 */
export function submitScore(name, score) {
  return submitScores([{ name, score }]);
}

/**
 * 取榜单与「我」的名次。
 * @param {string} name 我的昵称（主键）
 * @param {number} [score] 本局分数；给了就先入榜再排名
 * @returns {{top: Array, myRank: number, total: number, myBest: number}}
 */
export function getRank(name, score) {
  const me = sanitizeName(name);
  const board = score == null ? loadBoard() : submitScore(me, score);
  const idx = board.findIndex((r) => r.name === me);
  return {
    top: board.slice(0, 10),
    myRank: idx >= 0 ? idx + 1 : 0,
    total: board.length,
    myBest: idx >= 0 ? board[idx].score : Math.max(0, Math.floor(score || 0))
  };
}

/** 清空榜单（调试用） */
export function clearBoard() {
  writeRaw([]);
}
