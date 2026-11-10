/**
 * / · 出图**按张计费**的入账口径（2026-11-09 决定 7：图片费补进成本面板）。
 *
 * 背景：出图按张收费，不经 token 计量 ⇒ 只记 LLM 用量会让成本面板少计（此前实测「$0.02 一轮」
 * 其实还另有约 ¥0.5 的图费）。这里把每张成功出图折算成一条 `costs` 行（tokens=0）：
 *  - 单价按**模型＋实际出图档位**取（千问按 1k/2k 两档，档位由图 PNG 的 IHDR 宽高判）；
 *  - 人民币→USD 走设置 `cost.cnyPerUsd`（缺省 7.2），与「成本显元」同一口径，可配；
 *  - 无模型定价 → 回落 `defaultCny` 并在 details 看得到（不静默当 0）。
 *
 * 纯函数（定价/尺寸解析/汇率折算）与 IO（写 costs 行）分开，便于单测。
 */

/** 千问出图价目（元/张；来源：阿里云百炼模型价格页 2026-11-09 抓取）。 */
export const IMAGE_PRICE_CNY: Record<string, { '1k': number; '2k': number }> = {
  'qwen-image-3.0-pro': { '1k': 0.25, '2k': 0.5 },
  'qwen-image-3.0': { '1k': 0.18, '2k': 0.18 },
  'qwen-image-2.1-pro': { '1k': 0.25, '2k': 0.25 },
  'qwen-image-2.1-turbo': { '1k': 0.1, '2k': 0.1 },
  // OpenAI DALL-E 3（官方 $0.04 / $0.08 按档，折算后约 0.29/0.58 元）
  'dall-e-3': { '1k': 0.29, '2k': 0.58 },
};

/** 缺省汇率（元/美元）；设置项 `cost.cnyPerUsd` 优先。 */
export const DEFAULT_CNY_PER_USD = 7.2;

/** 从 PNG 头解析宽高（IHDR 固定在第 16–24 字节）；非 PNG / 数据不足 → null。 */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 档位：**按模型各自的定价口径**判（同向复核-3 发现：一刀切面积口径会让 DALL-E 少记一半）。
 *  - 千问（qwen-image-*）：百炼按**输出像素面积**分档（>2,250,000 记 2K）；
 *  - DALL-E 3：OpenAI 按**尺寸档**定价（1792×1024／1024×1792 是 $0.08 档），与面积无关。
 * 判不出尺寸按 2k 保守记（宁可多记不少记）。
 */
export const TIER_2K_MIN_PIXELS = 2_250_000;

export function imageTierOf(
  size: { width: number; height: number } | null,
  model = 'qwen-image-3.0-pro',
): '1k' | '2k' {
  if (size == null) return '2k';
  if (model.startsWith('dall-e')) {
    // DALL-E 3：长边 >1024 即 $0.08 档（1024x1024 为 $0.04）。
    return Math.max(size.width, size.height) > 1024 ? '2k' : '1k';
  }
  return size.width * size.height > TIER_2K_MIN_PIXELS ? '2k' : '1k';
}

/** 单张图人民币价（元）。无该模型价目 → `fallbackCny`（缺省 0.5，且调用方应把它当「未知价」标出）。 */
export function imagePriceCny(
  model: string,
  size: { width: number; height: number } | null,
  fallbackCny = 0.5,
): { cny: number; tier: '1k' | '2k'; priced: boolean } {
  const tier = imageTierOf(size, model);
  const table = IMAGE_PRICE_CNY[model];
  if (table == null) return { cny: fallbackCny, tier, priced: false };
  return { cny: table[tier], tier, priced: true };
}

/** 人民币 → 美元（保留 6 位，避免成本面板出现 1e-7 级噪声）。rate 非法/≤0 → 缺省汇率。 */
export function cnyToUsd(cny: number, rate: number | null | undefined): number {
  const r = typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_CNY_PER_USD;
  return Math.round((cny / r) * 1e6) / 1e6;
}
