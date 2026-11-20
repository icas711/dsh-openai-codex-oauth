/**
 * Провайдер веб-поиска на шине `ctx.web` (фаза 3 плагина): hosted-поиск
 * Codex через Responses-эндпоинт с принудительным инструментом `web_search`.
 * Провайдер регистрируется как один из кандидатов шины и не занимает выбор
 * безусловно — активация штатной настройкой `web.searchProvider`
 * (или переменной окружения `DSH_WEB_SEARCH_PROVIDER`).
 * @module dsh-openai-codex-oauth/web-search
 */
import { WebError } from '@deepseek-ai/dsh-web';
import { buildUserTextInput, codexEventsError, collectOutputItems, requestCodexEvents, } from "./codex-api.js";
/** Идентификатор провайдера на web-шине (совпадает с провайдером моделей). */
export const CODEX_SEARCH_PROVIDER_ID = 'openai-codex';
/**
 * Модель hosted-поиска по умолчанию. Есть в каталоге pi-ai 0.82.1 и
 * проверена сообществом против этого эндпоинта; меняется конфигом `searchModel`.
 */
export const DEFAULT_SEARCH_MODEL = 'gpt-5.6-sol';
/** Тело запроса с принуденным hosted-поиском. Exported for unit tests. */
export function buildWebSearchRequest(query, model = DEFAULT_SEARCH_MODEL) {
    return {
        model,
        instructions: "Search the public web for the user's query. Return a concise factual answer with citations to the sources you used.",
        input: buildUserTextInput(query),
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'web_search' },
        parallel_tool_calls: false,
        stream: true,
        store: false,
        text: { verbosity: 'low' },
    };
}
function citationOf(annotation) {
    if (annotation?.type !== 'url_citation')
        return undefined;
    const value = (annotation.url_citation ?? annotation);
    if (typeof value.url !== 'string' || value.url.length === 0)
        return undefined;
    return {
        url: value.url,
        ...(typeof value.title === 'string' && value.title.length > 0 ? { title: value.title } : {}),
        ...(typeof value.snippet === 'string' && value.snippet.length > 0 ? { snippet: value.snippet } : {}),
    };
}
function resultSource(value) {
    if (typeof value?.url !== 'string' || value.url.length === 0)
        return undefined;
    const publishedAt = value.published_at ?? value.publishedAt;
    return {
        url: value.url,
        ...(typeof value.title === 'string' && value.title.length > 0 ? { title: value.title } : {}),
        ...(typeof value.snippet === 'string' && value.snippet.length > 0 ? { snippet: value.snippet } : {}),
        ...(typeof publishedAt === 'string' ? { publishedAt } : {}),
    };
}
/**
 * Отобразить события Responses в словарь web-шины: текст ответа ассистента,
 * цитаты из аннотаций и результаты вызова web_search. Exported for unit tests.
 */
export function mapCodexSearchEvents(events) {
    const textParts = [];
    const sources = new Map();
    const addSource = (source) => {
        if (source !== undefined && !sources.has(source.url))
            sources.set(source.url, source);
    };
    for (const item of collectOutputItems(events)) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        if (record.type === 'web_search_call') {
            const action = record.action;
            const results = Array.isArray(record.results)
                ? record.results
                : Array.isArray(action?.results) ? action.results : [];
            for (const result of results)
                addSource(resultSource(result));
        }
        if (record.type !== 'message' || record.role !== 'assistant')
            continue;
        const content = Array.isArray(record.content) ? record.content : [];
        for (const block of content) {
            if (block === null || typeof block !== 'object')
                continue;
            const blockRecord = block;
            if ((blockRecord.type === 'output_text' || blockRecord.type === 'text')
                && typeof blockRecord.text === 'string'
                && blockRecord.text.length > 0) {
                textParts.push(blockRecord.text);
            }
            const annotations = Array.isArray(blockRecord.annotations) ? blockRecord.annotations : [];
            for (const annotation of annotations)
                addSource(citationOf(annotation));
        }
    }
    const content = textParts.join('\n\n').trim();
    if (content.length === 0) {
        const failure = codexEventsError(events);
        throw new Error(failure ?? 'Поиск OpenAI Codex не вернул ответ ассистента');
    }
    // Некоторые редакции бэкенда вставляют Markdown-цитаты без аннотаций.
    for (const match of content.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu)) {
        const url = match[2];
        if (url === undefined)
            continue;
        const title = match[1];
        addSource(title === undefined ? { url } : { url, title });
    }
    return { content, sources: [...sources.values()] };
}
/**
 * Провайдер `openai-codex` для web-шины. Учётные данные определяются по
 * области видимости: провайдер спрашивает у плагина авторизацию для
 * отслеживаемой активной сессии (см. README — ограничение многопользовательности).
 */
export class CodexSearchProvider {
    id = CODEX_SEARCH_PROVIDER_ID;
    #deps;
    constructor(deps) {
        this.#deps = deps;
    }
    available() {
        return this.#deps.hasCredential();
    }
    async search(request, signal) {
        try {
            if (!this.#deps.hasCredential()) {
                throw new WebError('Вход OpenAI Codex OAuth не настроен — выполните /codex-login, чтобы искать через подписку.', 'WEB_PROVIDER_CREDENTIAL_MISSING');
            }
            const credential = await this.#deps.resolveCredential(signal, undefined);
            const events = await requestCodexEvents({
                credential,
                body: buildWebSearchRequest(request.query, this.#deps.model),
                ...(signal === undefined ? {} : { signal }),
                endpoint: this.#deps.endpoint,
                originator: this.#deps.originator,
                ...(this.#deps.fetchImpl === undefined ? {} : { fetchImpl: this.#deps.fetchImpl }),
            });
            const mapped = mapCodexSearchEvents(events);
            return { ...mapped, truncated: false };
        }
        catch (error) {
            if (error instanceof WebError)
                throw error;
            if (signal?.aborted) {
                throw new WebError('Поиск OpenAI Codex прерван.', 'WEB_ABORTED', { cause: error });
            }
            throw new WebError(`Поиск OpenAI Codex не удался: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
    }
}
//# sourceMappingURL=web-search.js.map