/**
 * Провайдер веб-поиска на шине `ctx.web` (фаза 3 плагина): hosted-поиск
 * Codex через Responses-эндпоинт с принудительным инструментом `web_search`.
 * Провайдер регистрируется как один из кандидатов шины и не занимает выбор
 * безусловно — активация штатной настройкой `web.searchProvider`
 * (или переменной окружения `DSH_WEB_SEARCH_PROVIDER`).
 * @module dsh-openai-codex-oauth/web-search
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import {
  buildUserTextInput,
  codexEventsError,
  collectOutputItems,
  requestCodexEvents,
  type CodexCallCredential,
} from './codex-api.ts'

/** Идентификатор провайдера на web-шине (совпадает с провайдером моделей). */
export const CODEX_SEARCH_PROVIDER_ID = 'openai-codex'

/**
 * Модель hosted-поиска по умолчанию. Есть в каталоге pi-ai 0.82.1 и
 * проверена сообществом против этого эндпоинта; меняется конфигом `searchModel`.
 */
export const DEFAULT_SEARCH_MODEL = 'gpt-5.6-sol'

/** Зависимости провайдера от остального кода плагина. */
export interface CodexSearchDeps {
  /** Дешёвая синхронная проверка наличия учётных данных (без сети). */
  hasCredential(): boolean
  /** Авторизация для запроса: свежий access-токен и идентификатор аккаунта. */
  resolveCredential(signal: AbortSignal | undefined, sessionId: string | undefined): Promise<CodexCallCredential>
  /** Адрес Responses-эндпоинта из конфига плагина. */
  readonly endpoint: string
  /** Значение заголовка originator из конфига плагина. */
  readonly originator: string
  /** Модель hosted-поиска из конфига плагина. */
  readonly model: string
  /** Точка внедрения fetch для тестов. */
  readonly fetchImpl?: typeof globalThis.fetch
}

/** Тело запроса с принуденным hosted-поиском. Exported for unit tests. */
export function buildWebSearchRequest(query: string, model: string = DEFAULT_SEARCH_MODEL): {
  model: string
  instructions: string
  input: ReturnType<typeof buildUserTextInput>
  tools: Array<{ type: 'web_search' }>
  tool_choice: { type: 'web_search' }
  parallel_tool_calls: boolean
  stream: boolean
  store: boolean
  text: { verbosity: 'low' }
} {
  return {
    model,
    instructions:
      "Search the public web for the user's query. Return a concise factual answer with citations to the sources you used.",
    input: buildUserTextInput(query),
    tools: [{ type: 'web_search' }],
    tool_choice: { type: 'web_search' },
    parallel_tool_calls: false,
    stream: true,
    store: false,
    text: { verbosity: 'low' },
  }
}

interface AnnotationLike {
  readonly type?: unknown
  readonly url_citation?: unknown
  readonly url?: unknown
  readonly title?: unknown
  readonly snippet?: unknown
}

function citationOf(annotation: AnnotationLike): WebSearchSource | undefined {
  if (annotation?.type !== 'url_citation') return undefined
  const value = (annotation.url_citation ?? annotation) as AnnotationLike
  if (typeof value.url !== 'string' || value.url.length === 0) return undefined
  return {
    url: value.url,
    ...(typeof value.title === 'string' && value.title.length > 0 ? { title: value.title } : {}),
    ...(typeof value.snippet === 'string' && value.snippet.length > 0 ? { snippet: value.snippet } : {}),
  }
}

interface SearchResultLike {
  readonly url?: unknown
  readonly title?: unknown
  readonly snippet?: unknown
  readonly published_at?: unknown
  readonly publishedAt?: unknown
}

function resultSource(value: SearchResultLike): WebSearchSource | undefined {
  if (typeof value?.url !== 'string' || value.url.length === 0) return undefined
  const publishedAt = value.published_at ?? value.publishedAt
  return {
    url: value.url,
    ...(typeof value.title === 'string' && value.title.length > 0 ? { title: value.title } : {}),
    ...(typeof value.snippet === 'string' && value.snippet.length > 0 ? { snippet: value.snippet } : {}),
    ...(typeof publishedAt === 'string' ? { publishedAt } : {}),
  }
}

/**
 * Отобразить события Responses в словарь web-шины: текст ответа ассистента,
 * цитаты из аннотаций и результаты вызова web_search. Exported for unit tests.
 */
export function mapCodexSearchEvents(events: readonly unknown[]): Omit<WebSearchResult, 'truncated'> {
  const textParts: string[] = []
  const sources = new Map<string, WebSearchSource>()
  const addSource = (source: WebSearchSource | undefined): void => {
    if (source !== undefined && !sources.has(source.url)) sources.set(source.url, source)
  }
  for (const item of collectOutputItems(events)) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type === 'web_search_call') {
      const action = record.action as Record<string, unknown> | null | undefined
      const results = Array.isArray(record.results)
        ? record.results as unknown[]
        : Array.isArray(action?.results) ? action.results as unknown[] : []
      for (const result of results) addSource(resultSource(result as SearchResultLike))
    }
    if (record.type !== 'message' || record.role !== 'assistant') continue
    const content = Array.isArray(record.content) ? record.content as unknown[] : []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const blockRecord = block as Record<string, unknown>
      if (
        (blockRecord.type === 'output_text' || blockRecord.type === 'text')
        && typeof blockRecord.text === 'string'
        && blockRecord.text.length > 0
      ) {
        textParts.push(blockRecord.text)
      }
      const annotations = Array.isArray(blockRecord.annotations) ? blockRecord.annotations as unknown[] : []
      for (const annotation of annotations) addSource(citationOf(annotation as AnnotationLike))
    }
  }
  const content = textParts.join('\n\n').trim()
  if (content.length === 0) {
    const failure = codexEventsError(events)
    throw new Error(failure ?? 'Поиск OpenAI Codex не вернул ответ ассистента')
  }
  // Некоторые редакции бэкенда вставляют Markdown-цитаты без аннотаций.
  for (const match of content.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu)) {
    const url = match[2]
    if (url === undefined) continue
    const title = match[1]
    addSource(title === undefined ? { url } : { url, title })
  }
  return { content, sources: [...sources.values()] }
}

/**
 * Провайдер `openai-codex` для web-шины. Учётные данные определяются по
 * области видимости: провайдер спрашивает у плагина авторизацию для
 * отслеживаемой активной сессии (см. README — ограничение многопользовательности).
 */
export class CodexSearchProvider implements WebSearchProvider {
  readonly id = CODEX_SEARCH_PROVIDER_ID

  readonly #deps: CodexSearchDeps

  constructor(deps: CodexSearchDeps) {
    this.#deps = deps
  }

  available(): boolean {
    return this.#deps.hasCredential()
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    try {
      if (!this.#deps.hasCredential()) {
        throw new WebError(
          'Вход OpenAI Codex OAuth не настроен — выполните /codex-login, чтобы искать через подписку.',
          'WEB_PROVIDER_CREDENTIAL_MISSING',
        )
      }
      const credential = await this.#deps.resolveCredential(signal, undefined)
      const events = await requestCodexEvents({
        credential,
        body: buildWebSearchRequest(request.query, this.#deps.model),
        ...(signal === undefined ? {} : { signal }),
        endpoint: this.#deps.endpoint,
        originator: this.#deps.originator,
        ...(this.#deps.fetchImpl === undefined ? {} : { fetchImpl: this.#deps.fetchImpl }),
      })
      const mapped = mapCodexSearchEvents(events)
      return { ...mapped, truncated: false }
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      if (signal?.aborted) {
        throw new WebError('Поиск OpenAI Codex прерван.', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(
        `Поиск OpenAI Codex не удался: ${error instanceof Error ? error.message : String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
}
