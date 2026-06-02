/**
 * Embedding 客户端
 *
 * 调用 SiliconFlow Embedding API，将文本转换为向量
 * 支持并发控制、批量处理和智能速率限制
 *
 * 速率限制策略：
 * - 遇到 429 时，暂停所有批次请求
 * - 使用指数退避等待（初始 5s，每次加倍，最大 60s）
 * - 恢复后从并发=1 开始，逐步恢复到 maxConcurrency
 * - 连续成功 N 次后才提升并发数
 */

import { type EmbeddingConfig, getEmbeddingConfig } from '../config.js';
import { logger } from '../utils/logger.js';

/** Embedding 请求体 */
interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
}

/** 单个 Embedding 结果 */
interface EmbeddingData {
  object: 'embedding';
  index: number;
  embedding: number[];
}

/** Embedding 响应体 */
interface EmbeddingResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/** Embedding 错误响应 */
interface EmbeddingErrorResponse {
  error?: {
    message: string;
    type?: string;
    code?: string;
  };
}

/** Embedding 结果 */
export interface EmbeddingResult {
  text: string;
  embedding: number[];
  index: number;
}

/**
 * 进度追踪器
 * 定时输出进度，避免每个批次都打印日志
 */
class ProgressTracker {
  private completed = 0;
  private total: number;
  private totalTokens = 0;
  private startTime: number;
  private lastLogTime = 0;
  private readonly logIntervalMs = 2000; // 每 2 秒输出一次
  private onProgress?: (completed: number, total: number) => void;
  /** 是否跳过日志（单批次时跳过，避免与索引日志混淆） */
  private readonly skipLogs: boolean;
  /** 取消标记：为 true 后 recordBatch/logProgress 变为 no-op */
  private cancelled = false;

  constructor(total: number, onProgress?: (completed: number, total: number) => void) {
    this.total = total;
    this.startTime = Date.now();
    this.onProgress = onProgress;
    // 单批次（如查询 embedding）时跳过进度日志
    this.skipLogs = total <= 1;
  }

  /** 取消追踪，后续 recordBatch 和 logProgress 变为 no-op */
  cancel(): void {
    this.cancelled = true;
  }

  /** 记录一个批次完成 */
  recordBatch(tokens: number): void {
    if (this.cancelled) return;

    this.completed++;
    this.totalTokens += tokens;

    // 调用外部回调
    this.onProgress?.(this.completed, this.total);

    const now = Date.now();
    if (now - this.lastLogTime >= this.logIntervalMs) {
      this.logProgress();
      this.lastLogTime = now;
    }
  }

  /**
   * 扩展总批次数（用于 413 拆分重试时修正进度）
   */
  expandTotal(extraBatches: number): void {
    if (extraBatches <= 0) {
      return;
    }
    this.total += extraBatches;
  }

  /** 输出进度 */
  private logProgress(): void {
    if (this.skipLogs || this.cancelled) return;

    const elapsed = (Date.now() - this.startTime) / 1000;
    const percent = Math.round((this.completed / this.total) * 100);
    const rate = this.completed / elapsed;
    const eta = rate > 0 ? Math.round((this.total - this.completed) / rate) : 0;

    logger.info(
      {
        progress: `${this.completed}/${this.total}`,
        percent: `${percent}%`,
        tokens: this.totalTokens,
        elapsed: `${elapsed.toFixed(1)}s`,
        eta: `${eta}s`,
      },
      'Embedding 进度',
    );
  }

  /** 完成时输出最终统计 */
  complete(): void {
    if (this.skipLogs) return;

    const elapsed = (Date.now() - this.startTime) / 1000;
    logger.info(
      {
        batches: this.total,
        tokens: this.totalTokens,
        elapsed: `${elapsed.toFixed(1)}s`,
        avgTokensPerBatch: Math.round(this.totalTokens / this.total),
      },
      'Embedding 完成',
    );
  }
}

/**
 * 全局速率限制控制器
 *
 * 实现自适应并发控制，遇到 429 时协调所有请求暂停和恢复
 */
class RateLimitController {
  /** 是否处于暂停状态 */
  private isPaused = false;
  /** 暂停恢复的 Promise（所有请求等待此 Promise） */
  private pausePromise: Promise<void> | null = null;
  /** 当前有效并发数 */
  private currentConcurrency: number;
  /** 配置的最大并发数 */
  private maxConcurrency: number;
  /** 当前活跃请求数 */
  private activeRequests = 0;
  /** 连续成功次数（用于渐进恢复并发） */
  private consecutiveSuccesses = 0;
  /** 当前退避时间（毫秒） */
  private backoffMs = 10000;
  /** 恢复并发所需的连续成功次数：429 后慢恢复，避免快速回到高并发再次撞限流 */
  private readonly successesPerConcurrencyIncrease = 10;
  /** 降低退避时间所需的连续成功次数：需要较长稳定窗口才认为限流解除 */
  private readonly successesPerBackoffDecrease = 50;
  /** 最小退避时间 */
  private readonly minBackoffMs = 10000;
  /** 最大退避时间 */
  private readonly maxBackoffMs = 60000;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
    this.currentConcurrency = maxConcurrency;
  }

  /**
   * 获取执行槽位
   * 如果当前暂停或并发已满，则等待
   */
  async acquire(): Promise<void> {
    // 如果暂停中，等待恢复
    if (this.pausePromise) {
      await this.pausePromise;
    }

    // 等待并发槽位
    while (this.activeRequests >= this.currentConcurrency) {
      await sleep(50);
      // 再次检查是否暂停（可能在等待期间触发了 429）
      if (this.pausePromise) {
        await this.pausePromise;
      }
    }

    this.activeRequests++;
  }

  /**
   * 释放执行槽位（请求成功时调用）
   */
  releaseSuccess(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.consecutiveSuccesses++;

    // 渐进恢复并发数
    if (
      this.currentConcurrency < this.maxConcurrency &&
      this.consecutiveSuccesses >= this.successesPerConcurrencyIncrease
    ) {
      this.currentConcurrency++;
      this.consecutiveSuccesses = 0;
    }

    // 连续成功足够多次后，才逐步减少退避时间。
    // 429 通常说明 provider 侧吞吐已接近上限，过早降低 backoff 会导致反复抖动。
    if (
      this.consecutiveSuccesses > 0 &&
      this.consecutiveSuccesses % this.successesPerBackoffDecrease === 0
    ) {
      this.backoffMs = Math.max(this.minBackoffMs, this.backoffMs / 2);
    }
  }

  /**
   * 释放执行槽位（请求失败但非 429 时调用）
   */
  releaseFailure(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    // 普通失败不重置成功计数
  }

  /**
   * 释放执行槽位（429 重试前调用）
   * 释放槽位并重置成功计数
   */
  releaseForRetry(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.consecutiveSuccesses = 0;
  }

  /**
   * 触发 429 暂停
   * 所有请求将等待恢复
   */
  async triggerRateLimit(): Promise<void> {
    // 如果已经在暂停中，等待现有的暂停结束
    if (this.isPaused && this.pausePromise) {
      logger.debug('速率限制：等待现有暂停结束');
      await this.pausePromise;
      return;
    }

    this.isPaused = true;
    this.consecutiveSuccesses = 0;

    // 降低并发数
    const previousConcurrency = this.currentConcurrency;
    this.currentConcurrency = 1;

    logger.warn(
      {
        backoffMs: this.backoffMs,
        previousConcurrency,
        newConcurrency: this.currentConcurrency,
        activeRequests: this.activeRequests,
        successesPerConcurrencyIncrease: this.successesPerConcurrencyIncrease,
        successesPerBackoffDecrease: this.successesPerBackoffDecrease,
      },
      '速率限制：触发 429，暂停所有请求',
    );

    // 创建暂停 Promise
    let resumeResolve: () => void = () => {};
    this.pausePromise = new Promise<void>((resolve) => {
      resumeResolve = resolve;
    });

    // 等待退避时间
    await sleep(this.backoffMs);

    // 增加下次的退避时间（指数退避）
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);

    // 恢复
    this.isPaused = false;
    this.pausePromise = null;
    resumeResolve();

    logger.info({ waitMs: this.backoffMs }, '速率限制：恢复请求');
  }

  /**
   * 获取当前状态（用于调试）
   */
  getStatus(): {
    isPaused: boolean;
    currentConcurrency: number;
    maxConcurrency: number;
    activeRequests: number;
    backoffMs: number;
  } {
    return {
      isPaused: this.isPaused,
      currentConcurrency: this.currentConcurrency,
      maxConcurrency: this.maxConcurrency,
      activeRequests: this.activeRequests,
      backoffMs: this.backoffMs,
    };
  }
}

/** 全局速率限制控制器实例 */
let globalRateLimitController: RateLimitController | null = null;

/**
 * 获取或创建全局速率限制控制器
 */
function getRateLimitController(maxConcurrency: number): RateLimitController {
  if (!globalRateLimitController) {
    globalRateLimitController = new RateLimitController(maxConcurrency);
  }
  return globalRateLimitController;
}

/**
 * 重置全局速率限制控制器。
 *
 * 长驻进程中，新的索引/查询轮次如果需要以“干净状态”启动，
 * 必须显式清掉上一次任务残留的退避与并发窗口。
 */
export function resetRateLimitController(): void {
  globalRateLimitController = null;
}

/**
 * Embedding 客户端类
 */
export class EmbeddingClient {
  private config: EmbeddingConfig;
  private rateLimiter: RateLimitController;
  private readonly apiKeyPool: string[];
  private nextApiKeyIndex = 0;
  /** 坏 Key 冷却表: keyIndex → 解禁时间戳 (ms)，过期后自动恢复 */
  private badKeys = new Map<number, number>();
  /** 坏 Key 冷却时长 (5 分钟) */
  private readonly BAD_KEY_BAN_MS = 5 * 60 * 1000;

  constructor(config?: EmbeddingConfig) {
    this.config = config || getEmbeddingConfig();
    this.rateLimiter = getRateLimitController(this.config.maxConcurrency);
    this.apiKeyPool = this.buildApiKeyPool();
  }

  /**
   * 构建 API Key 池：优先使用 apiKeys，缺失时回退到 apiKey
   */
  private buildApiKeyPool(): string[] {
    const configuredKeys = Array.isArray(this.config.apiKeys)
      ? this.config.apiKeys.map((key) => key?.trim()).filter((key): key is string => Boolean(key))
      : [];

    if (configuredKeys.length > 0) {
      return configuredKeys;
    }

    return [this.config.apiKey];
  }

  /**
   * 获取下一个健康 Key 的索引（跳过冷却期内的坏 Key）
   *
   * 返回 -1 表示当前所有 Key 都在冷却期内，调用方应判定为不可恢复。
   */
  private getNextKeyIndex(): number {
    const now = Date.now();

    // 清理已过冷却期的坏 Key 标记
    for (const [idx, banUntil] of this.badKeys) {
      if (now >= banUntil) this.badKeys.delete(idx);
    }

    const start = this.nextApiKeyIndex;
    for (let i = 0; i < this.apiKeyPool.length; i++) {
      const idx = (start + i) % this.apiKeyPool.length;
      const banUntil = this.badKeys.get(idx);
      if (banUntil === undefined || now >= banUntil) {
        this.badKeys.delete(idx);
        this.nextApiKeyIndex = (idx + 1) % this.apiKeyPool.length;
        return idx;
      }
    }

    // 所有 Key 都在冷却期 → 由调用方决定是否重置或失败
    return -1;
  }

  /**
   * 标记 Key 为不可用（设置冷却期）
   */
  private markKeyBad(index: number): void {
    const banUntil = Date.now() + this.BAD_KEY_BAN_MS;
    this.badKeys.set(index, banUntil);
    logger.warn(
      { keyIndex: index, banUntil: new Date(banUntil).toISOString() },
      'API Key 已标记为不可用，5 分钟后重新尝试',
    );
  }

  /**
   * 获取单个文本的 Embedding
   */
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0].embedding;
  }

  /**
   * 批量获取 Embedding
   * @param texts 待处理的文本数组
   * @param batchSize 每批次发送的文本数量（默认 20）
   * @param onProgress 可选的进度回调 (completed, total) => void
   */
  async embedBatch(
    texts: string[],
    batchSize = 20,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return [];
    }

    // 将文本分批
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      batches.push(texts.slice(i, i + batchSize));
    }

    // 创建进度追踪器（传入外部回调）
    const progress = new ProgressTracker(batches.length, onProgress);
    const controller = new AbortController();

    try {
      // 使用速率限制控制器处理各批次
      const batchResults = await Promise.all(
        batches.map((batch, batchIndex) =>
          this.processWithRateLimit(batch, batchIndex * batchSize, progress, controller.signal),
        ),
      );

      // 输出完成统计
      progress.complete();

      // 扁平化结果
      return batchResults.flat();
    } catch (err) {
      controller.abort();
      progress.cancel();
      throw err;
    }
  }

  /**
   * 带速率限制、网络重试、Key 自动切换的批次处理
   */
  private async processWithRateLimit(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
    signal?: AbortSignal,
  ): Promise<EmbeddingResult[]> {
    const MAX_NETWORK_RETRIES = 3;
    const INITIAL_RETRY_DELAY_MS = 1000;

    let networkRetries = 0;
    let currentKeyIndex: number | null = null;
    let currentApiKey: string | null = null;
    const authTriedKeyIndexes = new Set<number>();

    while (true) {
      if (signal?.aborted) {
        throw new Error('Embedding 批处理已中止');
      }

      await this.rateLimiter.acquire();

      if (signal?.aborted) {
        this.rateLimiter.releaseFailure();
        throw new Error('Embedding 批处理已中止');
      }

      // 首次进入或 401 切 Key 后重新取 Key
      if (currentKeyIndex === null) {
        currentKeyIndex = this.getNextKeyIndex();
        if (currentKeyIndex < 0) {
          this.rateLimiter.releaseFailure();
          throw new Error('所有 Embedding API Key 均处于认证失败冷却期');
        }
        currentApiKey = this.apiKeyPool[currentKeyIndex];
      }

      if (currentApiKey === null) {
        this.rateLimiter.releaseFailure();
        throw new Error('未获取到可用 Embedding API Key');
      }

      try {
        const result = await this.processBatch(texts, startIndex, progress, signal, currentApiKey);
        this.rateLimiter.releaseSuccess();
        return result;
      } catch (err) {
        if (signal?.aborted) {
          this.rateLimiter.releaseFailure();
          throw new Error('Embedding 批处理已中止');
        }

        const error = err as { message?: string; code?: string };
        const errorMessage = error.message || '';
        const isRateLimited = errorMessage.includes('429') || errorMessage.includes('rate');
        const isNetworkError = this.isNetworkError(err);
        const isPayloadTooLarge = this.isPayloadTooLarge(err);
        const isAuthErr = this.isAuthError(err);

        if (isRateLimited) {
          this.rateLimiter.releaseForRetry();
          await this.rateLimiter.triggerRateLimit();
          networkRetries = 0;
        } else if (isNetworkError && networkRetries < MAX_NETWORK_RETRIES) {
          networkRetries++;
          const delayMs = INITIAL_RETRY_DELAY_MS * 2 ** (networkRetries - 1);
          logger.warn(
            {
              error: errorMessage,
              retry: networkRetries,
              maxRetries: MAX_NETWORK_RETRIES,
              delayMs,
            },
            '网络错误，准备重试',
          );
          this.rateLimiter.releaseForRetry();
          // 保留现有契约：网络重试会轮询到下一个 Key，而不是固定复用当前 Key。
          currentKeyIndex = null;
          currentApiKey = null;
          await sleep(delayMs);
        } else if (isAuthErr) {
          if (currentKeyIndex !== null) {
            authTriedKeyIndexes.add(currentKeyIndex);
            this.markKeyBad(currentKeyIndex);
          }

          if (this.apiKeyPool.length > 1 && authTriedKeyIndexes.size < this.apiKeyPool.length) {
            // 401/403：标记坏 Key，下次循环换 Key 重试；单批最多尝试每个 Key 一次
            logger.warn(
              { keyIndex: currentKeyIndex, error: errorMessage },
              'API Key 认证失败，切换到下一个 Key',
            );
            currentKeyIndex = null;
            currentApiKey = null;
            this.rateLimiter.releaseForRetry();
            networkRetries = 0;
          } else {
            this.rateLimiter.releaseFailure();
            throw err;
          }
        } else if (isPayloadTooLarge && texts.length > 1) {
          this.rateLimiter.releaseForRetry();

          const splitIndex = Math.ceil(texts.length / 2);
          const leftTexts = texts.slice(0, splitIndex);
          const rightTexts = texts.slice(splitIndex);

          // 一个批次拆分为两个批次，总数 +1
          progress.expandTotal(1);

          logger.warn(
            {
              error: errorMessage,
              batchSize: texts.length,
              leftBatchSize: leftTexts.length,
              rightBatchSize: rightTexts.length,
            },
            'Embedding 请求体过大，自动拆分批次重试',
          );

          const leftResults = await this.processWithRateLimit(
            leftTexts,
            startIndex,
            progress,
            signal,
          );
          const rightResults = await this.processWithRateLimit(
            rightTexts,
            startIndex + leftTexts.length,
            progress,
            signal,
          );
          return [...leftResults, ...rightResults];
        } else {
          this.rateLimiter.releaseFailure();

          if (isNetworkError) {
            logger.error({ error: errorMessage, retries: networkRetries }, '网络错误重试次数耗尽');
          }

          throw err;
        }
      }
    }
  }

  /**
   * 判断是否为网络错误
   *
   * 常见网络错误类型：
   * - terminated: 连接被中断（TLS 断开）
   * - ECONNRESET: 连接被远端重置
   * - ETIMEDOUT: 连接超时
   * - ENOTFOUND: DNS 解析失败
   * - fetch failed: 通用 fetch 失败
   * - socket hang up: 套接字意外关闭
   */
  private isNetworkError(err: unknown): boolean {
    const error = err as { message?: string; code?: string; name?: string };
    // AbortController 中止不是网络错误，不应重试
    if (error.name === 'AbortError') return false;

    const message = (error.message || '').toLowerCase();
    const code = error.code || '';

    const networkErrorPatterns = [
      'terminated',
      'econnreset',
      'etimedout',
      'enotfound',
      'econnrefused',
      'fetch failed',
      'socket hang up',
      'network',
      'aborted',
    ];

    // 检查错误消息
    for (const pattern of networkErrorPatterns) {
      if (message.includes(pattern)) {
        return true;
      }
    }

    // 检查错误代码
    const networkErrorCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE'];
    if (networkErrorCodes.includes(code)) {
      return true;
    }

    return false;
  }

  /**
   * 判断是否为请求体过大错误（HTTP 413）
   */
  private isPayloadTooLarge(err: unknown): boolean {
    const error = err as { message?: string; code?: string };
    const message = (error.message || '').toLowerCase();
    const code = (error.code || '').toString().toLowerCase();

    if (message.includes('413')) {
      return true;
    }

    const payloadTooLargePatterns = [
      'payload too large',
      'request entity too large',
      'content too large',
      'entity too large',
    ];

    for (const pattern of payloadTooLargePatterns) {
      if (message.includes(pattern)) {
        return true;
      }
    }

    return code === '413';
  }

  /**
   * 判断是否为认证错误 (401/403)
   */
  private isAuthError(err: unknown): boolean {
    const error = err as { message?: string; status?: number };
    const message = (error.message || '').toLowerCase();
    return (
      message.includes('401') ||
      message.includes('403') ||
      message.includes('unauthorized') ||
      message.includes('forbidden')
    );
  }

  /**
   * 处理单个批次（单次请求，不含重试逻辑）
   */
  private async processBatch(
    texts: string[],
    startIndex: number,
    progress: ProgressTracker,
    signal: AbortSignal | undefined,
    apiKey: string,
  ): Promise<EmbeddingResult[]> {
    const requestBody: EmbeddingRequest = {
      model: this.config.model,
      input: texts,
      encoding_format: 'float',
    };

    const response = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    const data = (await response.json()) as EmbeddingResponse & EmbeddingErrorResponse;

    if (!response.ok || data.error) {
      const errorMsg = data.error?.message || `HTTP ${response.status}`;
      throw new Error(`Embedding API 错误: ${errorMsg}`);
    }

    const results: EmbeddingResult[] = data.data.map((item) => ({
      text: texts[item.index],
      embedding: item.embedding,
      index: startIndex + item.index,
    }));

    // 记录批次完成（进度追踪器会定时输出）
    progress.recordBatch(data.usage?.total_tokens || 0);

    return results;
  }

  /**
   * 获取当前配置
   */
  getConfig(): EmbeddingConfig {
    return { ...this.config };
  }

  /**
   * 获取速率限制器状态（用于调试）
   */
  getRateLimiterStatus(): ReturnType<RateLimitController['getStatus']> {
    return this.rateLimiter.getStatus();
  }
}

/**
 * 创建默认的 Embedding 客户端实例
 */
let defaultClient: EmbeddingClient | null = null;

export function getEmbeddingClient(): EmbeddingClient {
  if (!defaultClient) {
    defaultClient = new EmbeddingClient();
  }
  return defaultClient;
}

/**
 * 重置默认 EmbeddingClient。
 *
 * 用于在配置热更新后强制重新读取最新的环境变量快照。
 */
export function resetEmbeddingClient(): void {
  defaultClient = null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
