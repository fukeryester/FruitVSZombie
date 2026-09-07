/**
 * 广告 API 封装 —— 激励视频
 * ------------------------------------------------------------------
 * 接入说明：adUnitId 替换为真实广告位 ID 后即可直接上线。
 * 观看规则：进入广告时开始计时，退出时检查逗留时长。
 *   dwell >= minDwellMs(5000) → resolve({ ok: true })
 *   否则 → resolve({ ok: false, reason: 'too_short' })
 *
 * 无真实广告位（开发阶段）时走 mock 分支：弹原生确认框模拟观看。
 */
export const AD_UNIT_ID = ''; // TODO: 填入激励视频 adUnitId

export function watchRewardAd(minDwellMs = 5000) {
  return new Promise((resolve) => {
    if (!AD_UNIT_ID) {
      // ---- mock：开发期模拟 ----
      wx.showModal({
        title: '模拟激励视频',
        content: `（未配置广告位）点击"看完"模拟逗留超 ${Math.round(minDwellMs / 1000)} 秒，点击"提前退出"模拟失败`,
        confirmText: '看完',
        cancelText: '提前退出',
        success: (res) => resolve({ ok: !!res.confirm })
      });
      return;
    }

    // ---- 真实广告 ----
    let startTime = 0;
    let finished = false;
    const ad = wx.createRewardedVideoAd({ adUnitId: AD_UNIT_ID });
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      try { ad.destroy(); } catch (e) {}
      resolve({ ok });
    };
    ad.onError(() => finish(false));
    ad.onLoad(() => {});
    ad.onClose((res) => {
      const dwell = Date.now() - startTime;
      // res.isEnded: 用户是否完整看完；同时校验逗留时长
      finish(!!(res && res.isEnded) && dwell >= minDwellMs);
    });
    startTime = Date.now();
    ad.show().catch(() => {
      // 首次 show 失败时重试一次
      ad.load().then(() => ad.show()).catch(() => finish(false));
    });
  });
}
