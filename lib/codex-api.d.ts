/**
 * Прямые запросы к бэкенду ChatGPT Codex (неофициальный API подписки).
 *
 * Общий клиент для вспомогательных вызовей плагина (веб-поиск, генерация
 * изображений, квоты): заголовки, разбор SSE-потока и извлечение идентификатора
 * аккаунта из access-токена. Модуль не знает про cordis и тестируется без сети
 * через внедрённый fetch.
 * @module dsh-openai-codex-oauth/codex-api
 */
/** Адрес Responses-эндпоинта бэкенда Codex по умолчанию. */
export declare const DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
/** Claim внутри JWT, где Codex-бэкенд ищет идентификатор аккаунта ChatGPT. */
export declare const JWT_CLAIM_PATH = "https://api.openai.com/auth";
/**
 * Идентификатор клиентского семейства. Совпадает с originator, который pi-ai
 * отправляет в запросах этого же харнесса; маскировки под официальный клиент
 * нет (см. README, «Ограничения»).
 */
export declare const DEFAULT_ORIGINATOR = "pi";
/** Минимальные данные для авторизации одного прямого запроса к бэкенду. */
export interface CodexCallCredential {
    readonly access: string;
    readonly accountId: string;
}
/** Параметры одного прямого запроса к Responses-эндпоинту. */
export interface CodexEventsSpec {
    readonly credential: CodexCallCredential;
    readonly body: unknown;
    readonly signal?: AbortSignal;
    readonly endpoint?: string;
    readonly originator?: string;
    readonly fetchImpl?: typeof globalThis.fetch;
}
/** User-Agent в формате pi-ai — единый с запросами llm-pi-ai этого харнесса. */
export declare function codexUserAgent(): string;
/** Список-only input, который требует шлюз ChatGPT Codex. Exported for unit tests. */
export declare function buildUserTextInput(text: string): Array<{
    role: 'user';
    content: Array<{
        type: 'input_text';
        text: string;
    }>;
}>;
/**
 * Идентификатор аккаунта ChatGPT из access-токена (JWT, claim
 * `https://api.openai.com/auth`.chatgpt_account_id). Exported for unit tests.
 */
export declare function accountIdOf(credential: {
    access: string;
}): string;
/** Заголовки прямого запроса к бэкенду Codex. Exported for unit tests. */
export declare function buildCodexHeaders(credential: CodexCallCredential, originator?: string, requestId?: string): Record<string, string>;
/** Разобрать полный текст SSE-ответа в массив событий. Exported for unit tests. */
export declare function parseSseText(text: string): unknown[];
/**
 * Собрать финальные output-элементы из событий Responses (и из событий
 * элементов, и из снимков ответа). Exported for unit tests.
 */
export declare function collectOutputItems(events: readonly unknown[]): unknown[];
/** Сообщение об ошибке из событий Responses, когда бэкенд вернул ошибку в потоке. */
export declare function codexEventsError(events: readonly unknown[]): string | undefined;
/** Выполнить один потоковый запрос к Responses-эндпоинту бэкенда Codex. */
export declare function requestCodexEvents(spec: CodexEventsSpec): Promise<unknown[]>;
//# sourceMappingURL=codex-api.d.ts.map