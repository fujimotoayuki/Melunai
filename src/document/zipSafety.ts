/**
 * ZIP-bomb 対策ヘルパー。pptx/docx/xlsx はすべて zip コンテナのため、
 * 入力サイズが小さくても展開後に GB 級に膨らむ攻撃が成立する。
 *
 * 設計方針:
 *   - JSZip.loadAsync で展開した後、各エントリの uncompressed size を合計する。
 *   - 展開後合計サイズが maxUncompressedBytes を超えたらエラー扱い。
 *   - 圧縮比（uncompressed / compressed）が極端な場合（200倍超）も拒否。
 *
 * これは pptx/xlsx/docx 各 extractor から呼ばれることを想定。
 */

import type JSZip from "jszip";

export interface ZipSafetyLimits {
  /** 展開後の合計バイト数の上限（デフォルト 200MB） */
  maxUncompressedBytes: number;
  /** 圧縮比の上限（uncompressed / compressed）。デフォルト 200 倍 */
  maxCompressionRatio: number;
  /** 含めるエントリ数の上限（デフォルト 5000） */
  maxEntries: number;
}

export const DEFAULT_ZIP_SAFETY_LIMITS: ZipSafetyLimits = {
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxEntries: 5_000,
};

export class ZipSafetyError extends Error {
  constructor(
    message: string,
    readonly kind: "too_many_entries" | "uncompressed_too_large" | "ratio_too_high",
  ) {
    super(message);
    this.name = "ZipSafetyError";
  }
}

/**
 * JSZip でロード済みの zip オブジェクトを検査し、zip-bomb の疑いがあれば
 * `ZipSafetyError` を投げる。
 */
export function assertZipIsSafe(
  zip: JSZip,
  compressedSizeBytes: number,
  limits: Partial<ZipSafetyLimits> = {},
): void {
  const l: ZipSafetyLimits = { ...DEFAULT_ZIP_SAFETY_LIMITS, ...limits };
  let totalUncompressed = 0;
  let entryCount = 0;
  for (const entry of Object.values(zip.files)) {
    entryCount += 1;
    if (entryCount > l.maxEntries) {
      throw new ZipSafetyError(
        `Zip contains too many entries (>${l.maxEntries}).`,
        "too_many_entries",
      );
    }
    // JSZip の内部表現から uncompressed size を取り出す
    const internal = (entry as { _data?: { uncompressedSize?: number } })._data;
    const uncompressed = internal?.uncompressedSize ?? 0;
    totalUncompressed += uncompressed;
    if (totalUncompressed > l.maxUncompressedBytes) {
      throw new ZipSafetyError(
        `Zip uncompressed size exceeds limit (${l.maxUncompressedBytes} bytes).`,
        "uncompressed_too_large",
      );
    }
  }
  // 圧縮比チェック（compressedSize が 0 のとき除算事故にならないようガード）
  if (compressedSizeBytes > 0) {
    const ratio = totalUncompressed / compressedSizeBytes;
    if (ratio > l.maxCompressionRatio) {
      throw new ZipSafetyError(
        `Zip compression ratio is suspiciously high (${ratio.toFixed(1)}x).`,
        "ratio_too_high",
      );
    }
  }
}
