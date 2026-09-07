/**
 * 排行榜 —— 本地模拟"全服排行"
 * ------------------------------------------------------------------
 * 真实接入：把 fetchLeaderboard 换成 wx.request 到你的服务端即可，
 * 结构保持 { nickname, score } 不变。
 */

const FAKE_NAMES = [
  '西瓜骑士', '葡萄不酸', '合成大师', '一颗桃子', '楼下老王',
  '菠萝吹雪', '橘子汽水', '半夜吃瓜', '椰子灰', '樱桃小丸子',
  '猕猴桃不掉毛', '番茄炒蛋', '柠檬精本精', '瓜田里的猹', '佛系玩家'
];

/** 生成一份围绕玩家分数的模拟榜单 */
function fetchLeaderboard(playerScore) {
  const list = [];
  for (let i = 0; i < 30; i++) {
    const base = Math.max(50, playerScore * (0.3 + Math.random() * 2.4));
    list.push({
      nickname: FAKE_NAMES[i % FAKE_NAMES.length] + (i >= FAKE_NAMES.length ? '·' + i : ''),
      score: Math.floor(base / 5) * 5
    });
  }
  list.push({ nickname: '我', score: playerScore, isSelf: true });
  list.sort((a, b) => b.score - a.score);
  return list;
}

/** 获取玩家排名与榜单（返回前 10 + 我的排名） */
export function getRank(playerScore) {
  const list = fetchLeaderboard(playerScore);
  const myIndex = list.findIndex(item => item.isSelf);
  return {
    top: list.slice(0, 10),
    myRank: myIndex + 1,
    total: list.length
  };
}
