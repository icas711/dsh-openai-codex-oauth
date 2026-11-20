/**
 * Квоты подписки ChatGPT (фаза 2 плагина): запрос `wham/usage`, нормализация
 * ответа и русское представление для команды `/codex-usage` и инструмента
 * `codex_usage`. Значения не выдумываются: в текст попадают только поля,
 * которые реально вернул бэкенд.
 * @module dsh-openai-codex-oauth/usage
 */

import { codexUserAgent, type CodexCallCredential } from './codex-api.ts'

/** Адрес эндпоинта квот по умолчанию. */
export const DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** Срок кэша квот по умолчанию (см. план: повтор по кулдауну). */
export const USAGE_CACHE_MS = 30_000

/** Бюджет одного запроса квот. */
export const USAGE_REQUEST_TIMEOUT_MS = 8_000

/** Одно окно ограничений подписки (5 часов или неделя). */
export interface CodexUsageWindow {
  readonly usedPercent: number
  readonly windowSeconds?: number
  readonly resetAt?: number
}

/** Нормализованный ответ `wham/usage`. */
export interface CodexUsage {
  readonly planType?: string
  readonly primary?: CodexUsageWindow
  readonly secondary?: CodexUsageWindow
  readonly limitReached?: boolean
  readonly resetCredits?: number
  readonly fetchedAt: number
}

/** Параметры запроса квот. */
export interface CodexUsageSpec {
  readonly credential: CodexCallCredential
  readonly usageUrl?: string
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof globalThis.fetch
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function windowOf(value: unknown): CodexUsageWindow | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const usedPercent = finiteNumber(record.used_percent ?? record.usedPercent)
  if (usedPercent === undefined) return undefined
  const windowSeconds = finiteNumber(record.limit_window_seconds ?? record.windowDurationSecs)
  const resetAt = finiteNumber(record.reset_at ?? record.resetsAt)
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

/**
 * Привести ответ `wham/usage` к стабильным полям отображения. Выносит только
 * фактические поля бэкенда; альтернативные имена полей (camelCase и обратно
 * совместимые варианты) сводятся к одному виду. Exported for unit tests.
 */
export function normalizeUsage(value: unknown, fetchedAt: number = Date.now()): CodexUsage {
  const root = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const limits = root.rate_limit !== null && typeof root.rate_limit === 'object'
    ? root.rate_limit as Record<string, unknown>
    : {}
  const credits = root.rate_limit_reset_credits !== null && typeof root.rate_limit_reset_credits === 'object'
    ? root.rate_limit_reset_credits as Record<string, unknown>
    : undefined
  const planType = typeof root.plan_type === 'string' && root.plan_type.length > 0 ? root.plan_type : undefined
  const primary = windowOf(limits.primary_window ?? limits.primary)
  const secondary = windowOf(limits.secondary_window ?? limits.secondary)
  const limitReached = typeof limits.limit_reached === 'boolean' ? limits.limit_reached : undefined
  const resetCredits = finiteNumber(credits?.available_count)
  return {
    ...(planType !== undefined ? { planType } : {}),
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
    ...(limitReached !== undefined ? { limitReached } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
    fetchedAt,
  }
}

/** Человекочитаемое название окна ограничений. Exported for unit tests. */
export function windowLabel(seconds: number | undefined): string {
  if (seconds === 18000) return '5-часовое окно'
  if (seconds === 604800) return 'недельное окно'
  if (seconds === undefined) return 'Текущее окно'
  if (seconds % 86_400 === 0) return `Окно ${seconds / 86_400} дн.`
  if (seconds % 3_600 === 0) return `Окно ${seconds / 3_600} ч`
  return `Окно ${seconds} с`
}

/** Описание времени сброса окна: относительное и абсолютное. Exported for unit tests. */
export function resetDescription(resetAt: number, now: number = Date.now()): string {
  const remainingMinutes = Math.max(0, Math.ceil((resetAt * 1000 - now) / 60_000))
  const absolute = new Date(resetAt * 1000).toISOString()
  return `сброс через ${remainingMinutes} мин (${absolute})`
}

function windowLine(label: string, window: CodexUsageWindow): string {
  const reset = window.resetAt === undefined ? '' : `, ${resetDescription(window.resetAt)}`
  return `${label}: использовано ${window.usedPercent}%${reset}.`
}

/** Русское представление квоты для пользователя и карточки инструмента. Exported for unit tests. */
export function usageText(usage: CodexUsage): string {
  const lines: string[] = []
  lines.push(usage.planType !== undefined
    ? `План подписки ChatGPT: ${usage.planType}.`
    : 'План подписки ChatGPT: бэкенд не вернул plan_type.')
  if (usage.primary !== undefined) lines.push(windowLine(windowLabel(usage.primary.windowSeconds), usage.primary))
  if (usage.secondary !== undefined) lines.push(windowLine(windowLabel(usage.secondary.windowSeconds), usage.secondary))
  if (usage.limitReached === true) lines.push('Лимит подписки достигнут.')
  if (usage.resetCredits !== undefined) lines.push(`Доступные сброс-кредиты: ${usage.resetCredits}.`)
  return lines.join('\n')
}

/** Текст ошибки запроса квот. Exported for unit tests. */
export function usageErrorText(error: unknown): string {
  if (!(error instanceof Error)) return 'Не удалось получить квоту OpenAI Codex.'
  if (/прерван/iu.test(error.message)) return 'Запрос квоты OpenAI Codex прерван.'
  const status = /HTTP (\d{3})/u.exec(error.message)?.[1]
  if (status !== undefined) {
    return `Не удалось получить квоту OpenAI Codex (HTTP ${status}). Повторите позже или выполните /codex-login заново.`
  }
  return `${error.message}`
}

/**
 * Запросить квоту подписки. Ошибки — громкие: любой не-2xx ответ или
 * не-JSON тело становится ошибкой с HTTP-статусом, без выдуманных значений.
 */
export async function fetchCodexUsage(spec: CodexUsageSpec): Promise<CodexUsage> {
  const fetchImpl = spec.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch недоступен в этом окружении')
  }
  const timeout = AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS)
  const signal = spec.signal === undefined ? timeout : AbortSignal.any([spec.signal, timeout])
  let response: Response
  try {
    response = await fetchImpl(spec.usageUrl ?? DEFAULT_USAGE_URL, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${spec.credential.access}`,
        'chatgpt-account-id': spec.credential.accountId,
        'user-agent': codexUserAgent(),
      },
      signal,
    })
  } catch (error: unknown) {
    if (spec.signal?.aborted) throw new Error('Запрос квоты OpenAI Codex прерван', { cause: error })
    throw new Error(`Не удалось выполнить запрос квоты OpenAI Codex: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!response.ok) {
    throw new Error(`Запрос квоты OpenAI Codex не удался (HTTP ${response.status})`)
  }
  let value: unknown
  try {
    value = await response.json()
  } catch (error: unknown) {
    throw new Error(`Ответ квоты OpenAI Codex не является JSON (HTTP ${response.status})`, { cause: error })
  }
  return normalizeUsage(value)
}
