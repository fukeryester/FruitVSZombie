/**
 * 广告 API 封装 —— 激励视频
 * ------------------------------------------------------------------
 * 接入说明：adUnitId 替换为真实广告位 ID 后即可直接上线。
 * 观看规则：进入广告时开始计时，退出时检查逗留时长。
 *   dwell >= minDwellMs(5000) → resolve({ ok: true })
 *   否则 → resolve({ ok: false, reason: 'too_short' })
 *
 * 未配置广告位时：随机打开一条宣传链接（浏览器新标签 / 微信 openUrl /
 * 复制到剪贴板），视为一次有效曝光。
 */
import { showToast } from '../ui/widgets.js';

export const AD_UNIT_ID = ''; // TODO: 填入激励视频 adUnitId

export const PROMO_URLS = [
  'https://space.bilibili.com/65694232?spm_id_from=333.1007.0.0',
  'https://www.bilibili.com/video/BV17UADzYEMF',
  'https://www.bilibili.com/video/BV1XbYYz7EA5',
  'https://www.bilibili.com/video/BV1yXtLzgEWQ',
  'https://www.bilibili.com/video/BV1rNRiYmEVa',
  'https://www.bilibili.com/video/BV1ShBYYLE46',
  'https://www.bilibili.com/video/BV1Dxu5zPEoF',
  'https://www.bilibili.com/video/BV1cMfMY2EiX',
  'https://www.bilibili.com/video/BV1LBaWz4Erj'
];

export function pickPromoUrl() {
  return PROMO_URLS[Math.floor(Math.random() * PROMO_URLS.length)];
}

/** 打开一条宣传链接；返回是否至少完成了打开或复制 */
export function openPromoPage() {
  const url = pickPromoUrl();
  try {
    if (typeof document !== 'undefined' && document.body) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return { ok: true, url };
    }
  } catch (e) { /* ignore */ }
  try {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      const w = window.open(url, '_blank');
      if (w) return { ok: true, url };
    }
  } catch (e) { /* ignore */ }
  try {
    if (typeof wx !== 'undefined' && typeof wx.openUrl === 'function') {
      wx.openUrl({ url });
      return { ok: true, url };
    }
  } catch (e) { /* ignore */ }
  try {
    if (typeof wx !== 'undefined' && wx.setClipboardData) {
      wx.setClipboardData({
        data: url,
        success: () => showToast('链接已复制，请到浏览器打开')
      });
      return { ok: true, url, copied: true };
    }
  } catch (e) { /* ignore */ }
  showToast('无法打开链接');
  return { ok: false, url };
}

export function watchRewardAd(minDwellMs = 5000) {
  return new Promise((resolve) => {
    if (!AD_UNIT_ID) {
      const r = openPromoPage();
      resolve({ ok: r.ok, reason: r.ok ? 'promo' : 'open_fail' });
      return;
    }

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
      finish(!!(res && res.isEnded) && dwell >= minDwellMs);
    });
    startTime = Date.now();
    ad.show().catch(() => {
      ad.load().then(() => ad.show()).catch(() => finish(false));
    });
  });
}
