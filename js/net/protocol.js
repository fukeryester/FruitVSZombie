/**
 * 联机报文协议
 * ------------------------------------------------------------------
 * 所有报文都塞进服务端 `broadcast` / `send` 的 `data` 字段里原样转发，
 * 服务端不解析。字段名一律用一到两个字符，因为单包上限只有 8 KB，
 * 而世界快照里每多一个字符 × 上百个刚体就是几百字节。
 *
 * 报文一览（`t` = type）：
 *
 *   host → 全体
 *     M.SNAP     世界快照（每秒 SNAPSHOT_HZ 次，见 snapshot.js 的字段表）
 *     M.STAGE    切换阶段：{ id 阶段id, cs 继承分数, ar 场地描述, sc 各座位分数 }
 *     M.CARD_OPEN  开始选卡：{ ids 三张卡id, dl 截止时间戳(host时钟), ck 事件序号 }
 *     M.CARD_DONE  选卡结束：{ ck, ps [[seat, cardId, auto], ...] }
 *     M.RESULT   结算：{ win, rows [[seat, name, score], ...] }
 *     M.ROSTER   名册同步：{ rs [[seat, name], ...] }（host 汇总各人昵称）
 *
 *   guest → host
 *     M.INPUT    输入：{ x 投射口横坐标, d 本帧是否投放, q 序号 }
 *     M.CARD_PICK  选卡：{ ck, id 选中的卡id }
 *     M.HELLO    自报昵称：{ n 昵称 }
 *     M.REVIVE   请求全队复活（看完广告后发起）
 *     M.SCORE    结算时上报自己的最终分（host 汇总进排行榜）
 *
 *   任意 → 全体
 *     M.BYE      主动离开
 */

export const M = {
  HELLO: 'h',
  ROSTER: 'r',
  INPUT: 'i',
  SNAP: 's',
  STAGE: 'g',
  CARD_OPEN: 'co',
  CARD_PICK: 'cp',
  CARD_DONE: 'cd',
  RESULT: 'z',
  REVIVE: 'v',
  REVIVED: 'rd',
  SCORE: 'sc',
  BYE: 'b'
};

/**
 * 刚体类型位掩码（快照里每个刚体一个 k 字段）。
 * 普通水果 = 0，其余按位或。
 */
export const K = {
  ZOMBIE: 1,
  STATIC: 2,
  CORE: 4,
  ARTIFACT: 8,
  NOMERGE: 16
};

/** 从刚体读出类型位掩码 */
export function kindOf(b) {
  let k = 0;
  if (b.isZombie) k |= K.ZOMBIE;
  if (b.isStatic) k |= K.STATIC;
  if (b.isCore) k |= K.CORE;
  if (b.isArtifact) k |= K.ARTIFACT;
  if (b.noMerge) k |= K.NOMERGE;
  return k;
}

/** 把类型位掩码写回一个「渲染用的假刚体」 */
export function applyKind(target, k) {
  target.isZombie = !!(k & K.ZOMBIE);
  target.isStatic = !!(k & K.STATIC);
  target.isCore = !!(k & K.CORE);
  target.isArtifact = !!(k & K.ARTIFACT);
  target.noMerge = !!(k & K.NOMERGE);
  return target;
}
