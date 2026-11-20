/**
 * Провайдер веб-поиска на шине `ctx.web` (фаза 3 плагина): hosted-поиск
 * Codex через Responses-эндпоинт с принудительным инструментом `web_search`.
 * Провайдер регистрируется как один из кандидатов шины и не занимает выбор
 * безусловно — активация штатной настройкой `web.searchProvider`
 * (или переменной окружения `DSH_WEB_SEARCH_PROVIDER`).
 * @module dsh-openai-codex-oauth/web-search
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import { buildUserTextInput, type CodexCallCredential } from './codex-api.ts';
/** Идентификатор провайдера на web-шине (совпадает с провайдером моделей). */
export declare const CODEX_SEARCH_PROVIDER_ID = "openai-codex";
/**
 * Модель hosted-поиска по умолчанию. Есть в каталоге pi-ai 0.82.1 и
 * проверена сообществом против этого эндпоинта; меняется конфигом `searchModel`.
 */
export declare const DEFAULT_SEARCH_MODEL = "gpt-5.6-sol";
/** Зависимости провайдера от остального кода плагина. */
export interface CodexSearchDeps {
    /** Дешёвая синхронная проверка наличия учётных данных (без сети). */
    hasCredential(): boolean;
    /** Авторизация для запроса: свежий access-токен и идентификатор аккаунта. */
    resolveCredential(signal: AbortSignal | undefined, sessionId: string | undefined): Promise<CodexCallCredential>;
    /** Адрес Responses-эндпоинта из конфига плагина. */
    readonly endpoint: string;
    /** Значение заголовка originator из конфига плагина. */
    readonly originator: string;
    /** Модель hosted-поиска из конфига плагина. */
    readonly model: string;
    /** Точка внедрения fetch для тестов. */
    readonly fetchImpl?: typeof globalThis.fetch;
}
/** Тело запроса с принуденным hosted-поиском. Exported for unit tests. */
export declare function buildWebSearchRequest(query: string, model?: string): {
    model: string;
    instructions: string;
    input: ReturnType<typeof buildUserTextInput>;
    tools: Array<{
        type: 'web_search';
    }>;
    tool_choice: {
        type: 'web_search';
    };
    parallel_tool_calls: boolean;
    stream: boolean;
    store: boolean;
    text: {
        verbosity: 'low';
    };
};
/**
 * Отобразить события Responses в словарь web-шины: текст ответа ассистента,
 * цитаты из аннотаций и результаты вызова web_search. Exported for unit tests.
 */
export declare function mapCodexSearchEvents(events: readonly unknown[]): Omit<WebSearchResult, 'truncated'>;
/**
 * Провайдер `openai-codex` для web-шины. Учётные данные определяются по
 * области видимости: провайдер спрашивает у плагина авторизацию для
 * отслеживаемой активной сессии (см. README — ограничение многопользовательности).
 */
export declare class CodexSearchProvider implements WebSearchProvider {
    #private;
    readonly id = "openai-codex";
    constructor(deps: CodexSearchDeps);
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
//# sourceMappingURL=web-search.d.ts.map