/**
 * 调试包体判定
 * ------------------------------------------------------------------
 * 微信小游戏的包体环境通过 wx.getAccountInfoSync().miniProgram.envVersion 区分：
 *   'develop'（开发者工具）/ 'trial'（体验版）→ 调试包体
 *   'release'（正式版）                       → 正式包体
 *
 * 无头测试 / 老基础库拿不到该 API 时按调试包处理（宁可多显示，不挡测试）。
 * 测试可通过 forceDebugBuild(true/false) 强制指定，传 null 恢复自动判定。
 */
let forced = null;

/** 强制指定调试包判定结果（仅供测试；null = 恢复自动判定） */
export function forceDebugBuild(v) {
  forced = v === null || v === undefined ? null : !!v;
}

/** 当前是否为调试包体（开发者工具 / 体验版） */
export function isDebugBuild() {
  if (forced !== null) return forced;
  try {
    const info = typeof wx !== 'undefined' && wx.getAccountInfoSync
      ? wx.getAccountInfoSync()
      : null;
    const env = info && info.miniProgram && info.miniProgram.envVersion;
    return env !== 'release';
  } catch (e) {
    return true;
  }
}
