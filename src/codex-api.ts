/**
 * Прямые запросы к бэкенду ChatGPT Codex (неофициальный API подписки).
 *
 * Общий клиент для вспомогательных вызовей плагина (веб-поиск, генерация
 * изображений, квоты): заголовки, разбор SSE-потока и извлечение идентификатора
 * аккаунта из access-токена. Модуль не знает про cordis и тестируется без сети
 * через внедрённый fetch.
 * @module dsh-openai-codex-oauth/codex-api
 */

import { randomUUID } from 'node:crypto'
import { arch, platform, release } from 'node:os'

/** Адрес Responses-эндпоинта бэкенда Codex по умолчанию. */
export const DEFAULT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** Claim внутри JWT, где Codex-бэкенд ищет идентификатор аккаунта ChatGPT. */
export const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/**
 * Идентификатор клиентского семейства. Совпадает с originator, который pi-ai
 * отправляет в запросах этого же харнесса; маскировки под официальный клиент
 * нет (см. README, «Ограничения»).
 */
export const DEFAULT_ORIGINATOR = 'pi'

/** Минимальные данные для авторизации одного прямого запроса к бэкенду. */
export interface CodexCallCredential {
  readonly access: string
  readonly accountId: string
}

/** Параметры одного прямого запроса к Responses-эндпоинту. */
export interface CodexEventsSpec {
  readonly credential: CodexCallCredential
  readonly body: unknown
  readonly signal?: AbortSignal
  readonly endpoint?: string
  readonly originator?: string
  readonly fetchImpl?: typeof globalThis.fetch
}

/** User-Agent в формате pi-ai — единый с запросами llm-pi-ai этого харнесса. */
export function codexUserAgent(): string {
  return `pi (${platform()} ${release()}; ${arch()})`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Список-only input, который требует шлюз ChatGPT Codex. Exported for unit tests. */
export function buildUserTextInput(text: string): Array<{
  role: 'user'
  content: Array<{ type: 'input_text'; text: string }>
}> {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Текст запроса к OpenAI Codex должен быть непустой строкой')
  }
  return [{ role: 'user', content: [{ type: 'input_text', text }] }]
}

/**
 * Идентификатор аккаунта ChatGPT из access-токена (JWT, claim
 * `https://api.openai.com/auth`.chatgpt_account_id). Exported for unit tests.
 */
export function accountIdOf(credential: { access: string }): string {
  const parts = credential.access.split('.')
  if (parts.length !== 3) {
    throw new Error('Access-токен OpenAI Codex не является JWT — выполните /codex-login')
  }
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    throw new Error('Не удалось разобрать access-токен OpenAI Codex — выполните /codex-login')
  }
  const claim = (payload as Record<string, unknown> | null)?.[JWT_CLAIM_PATH]
  const accountId = (claim as Record<string, unknown> | null | undefined)?.chatgpt_account_id
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('В access-токене OpenAI Codex нет идентификатора аккаунта ChatGPT — выполните /codex-login')
  }
  return accountId
}

/** Заголовки прямого запроса к бэкенду Codex. Exported for unit tests. */
export function buildCodexHeaders(
  credential: CodexCallCredential,
  originator: string = DEFAULT_ORIGINATOR,
  requestId: string = randomUUID(),
): Record<string, string> {
  if (credential.access.length === 0 || credential.accountId.length === 0) {
    throw new Error('Учётные данные OpenAI Codex неполны — выполните /codex-login')
  }
  return {
    authorization: `Bearer ${credential.access}`,
    'chatgpt-account-id': credential.accountId,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'openai-beta': 'responses=experimental',
    originator,
    'user-agent': codexUserAgent(),
    'x-client-request-id': requestId,
  }
}

/** Разобрать полный текст SSE-ответа в массив событий. Exported for unit tests. */
export function parseSseText(text: string): unknown[] {
  const normalized = text.replace(/\r\n?/gu, '\n')
  const events: unknown[] = []
  for (const block of normalized.split(/\n\n+/u)) {
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (data.length === 0 || data === '[DONE]') continue
    try {
      events.push(JSON.parse(data))
    } catch (error: unknown) {
      throw new Error(`Некорректное SSE-событие OpenAI Codex: ${errorText(error)}`, { cause: error })
    }
  }
  if (events.length === 0 && normalized.trim().startsWith('{')) {
    try {
      events.push(JSON.parse(normalized))
    } catch (error: unknown) {
      throw new Error(`Некорректный JSON-ответ OpenAI Codex: ${errorText(error)}`, { cause: error })
    }
  }
  return events
}

interface OutputItemLike {
  readonly type?: unknown
  readonly id?: unknown
}

function addOutputItem(keyed: Map<string, unknown>, anonymous: unknown[], item: unknown): void {
  if (item === null || typeof item !== 'object') return
  const candidate = item as OutputItemLike
  const key = typeof candidate.id === 'string'
    ? `${String(candidate.type ?? 'item')}:${candidate.id}`
    : undefined
  if (key === undefined) anonymous.push(item)
  else keyed.set(key, item)
}

/**
 * Собрать финальные output-элементы из событий Responses (и из событий
 * элементов, и из снимков ответа). Exported for unit tests.
 */
export function collectOutputItems(events: readonly unknown[]): unknown[] {
  const keyed = new Map<string, unknown>()
  const anonymous: unknown[] = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const record = event as Record<string, unknown>
    addOutputItem(keyed, anonymous, record.item)
    const response = record.response
    if (response !== null && typeof response === 'object' && Array.isArray((response as Record<string, unknown>).output)) {
      for (const item of (response as Record<string, unknown>).output as unknown[]) addOutputItem(keyed, anonymous, item)
    }
    if (Array.isArray(record.output)) {
      for (const item of record.output as unknown[]) addOutputItem(keyed, anonymous, item)
    }
  }
  return [...keyed.values(), ...anonymous]
}

/** Сообщение об ошибке из событий Responses, когда бэкенд вернул ошибку в потоке. */
export function codexEventsError(events: readonly unknown[]): string | undefined {
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const record = event as Record<string, unknown>
    if (record.type === 'error') {
      const error = record.error as Record<string, unknown> | null | undefined
      return firstString(error?.message, record.message, error?.code, record.code)
        ?? 'Запрос к OpenAI Codex завершился ошибкой'
    }
    if (record.type === 'response.failed') {
      const response = record.response as Record<string, unknown> | null | undefined
      const error = response?.error as Record<string, unknown> | null | undefined
      return firstString(error?.message, error?.code) ?? 'Ответ OpenAI Codex завершился ошибкой'
    }
  }
  return undefined
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Выполнить один потоковый запрос к Responses-эндпоинту бэкенда Codex. */
export async function requestCodexEvents(spec: CodexEventsSpec): Promise<unknown[]> {
  const fetchImpl = spec.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch недоступен в этом окружении')
  }
  const endpoint = spec.endpoint ?? DEFAULT_CODEX_RESPONSES_URL
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: buildCodexHeaders(spec.credential, spec.originator ?? DEFAULT_ORIGINATOR),
      body: JSON.stringify(spec.body),
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })
  } catch (error: unknown) {
    if (spec.signal?.aborted) throw new Error('Запрос к OpenAI Codex прерван', { cause: error })
    throw new Error(`Не удалось выполнить запрос к OpenAI Codex: ${errorText(error)}`, { cause: error })
  }
  let text: string
  try {
    text = await response.text()
  } catch (error: unknown) {
    if (spec.signal?.aborted) throw new Error('Запрос к OpenAI Codex прерван', { cause: error })
    throw new Error(`Не удалось прочитать ответ OpenAI Codex: ${errorText(error)}`, { cause: error })
  }
  if (!response.ok) {
    let detail = text.trim()
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string }
      detail = parsed.error?.message ?? parsed.message ?? detail
    } catch {
      // Сохраняем исходное тело ответа как есть.
    }
    throw new Error(
      `Запрос к OpenAI Codex не удался (HTTP ${response.status})${detail.length > 0 ? `: ${detail.slice(0, 500)}` : ''}`,
    )
  }
  const events = parseSseText(text)
  const failure = codexEventsError(events)
  if (failure !== undefined) throw new Error(failure)
  return events
}
