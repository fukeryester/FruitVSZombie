/**
 * 玩家昵称 —— 排行榜的**主键**
 * ------------------------------------------------------------------
 * 排行榜不按设备、不按站点账号，而是按玩家自己填的这个名字聚合：
 * 同一个名字在任何一局里刷出的最好成绩会合并成一条记录。
 * 联机时它同时也是房间里展示给队友的名牌。
 *
 * 输入方式由平台适配层提供：网页版 wx-shim 里实现了 `wx.promptText`
 * （一个盖在画布上的 HTML 输入框）；微信小游戏包里没有这个能力，
 * 直接回退到随机名，不影响单机游玩。
 */
import { storage } from './utils.js';

const MAX_LEN = 12;
const ADJ = ['爽脆', '多汁', '暴走', '无敌', '甜甜', '硬核', '冷酷', '闪电', '爆炸', '快乐'];
const NOUN = ['西瓜', '菠萝', '柠檬', '椰子', '番茄', '猕猴桃', '樱桃', '橘子', '桃子', '葡萄'];

/** 去掉首尾空白与换行，并截断到 MAX_LEN */
export function sanitizeName(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\r\n\t]/g, ' ').trim();
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
}

/** 随机生成一个昵称（没填名字时的兜底） */
export function randomName() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return `${a}${n}${Math.floor(Math.random() * 90 + 10)}`;
}

/** 读取已保存的昵称；没有就生成一个并落盘 */
export function loadPlayerName() {
  const saved = sanitizeName(storage.getName());
  if (saved) return saved;
  const generated = randomName();
  storage.setName(generated);
  return generated;
}

export function savePlayerName(name) {
  const clean = sanitizeName(name) || randomName();
  storage.setName(clean);
  return clean;
}

/** 当前平台是否支持弹出输入框 */
export function canPromptName() {
  return typeof wx !== 'undefined' && typeof wx.promptText === 'function';
}

/**
 * 弹出输入框让玩家改名。
 * @param {string} current 当前昵称（作为输入框默认值）
 * @returns {Promise<string|null>} 取消返回 null
 */
export async function askPlayerName(current) {
  if (!canPromptName()) return null;
  try {
    const raw = await wx.promptText({
      title: '你的游戏名',
      tip: '排行榜按这个名字记录成绩，联机时队友也看这个',
      value: current || '',
      maxLength: MAX_LEN,
      placeholder: '起个响亮的名字'
    });
    if (raw == null) return null;
    return savePlayerName(raw);
  } catch (e) {
    return null;
  }
}
