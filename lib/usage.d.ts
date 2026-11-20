/**
 * Квоты подписки ChatGPT (фаза 2 плагина): запрос `wham/usage`, нормализация
 * ответа и русское представление для команды `/codex-usage` и инструмента
 * `codex_usage`. Значения не выдумываются: в текст попадают только поля,
 * которые реально вернул бэкенд.
 * @module dsh-openai-codex-oauth/usage
 */
import { type CodexCallCredential } from './codex-api.ts';
/** Адрес эндпоинта квот по умолчанию. */
export declare const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** Срок кэша квот по умолчанию (см. план: повтор по кулдауну). */
export declare const USAGE_CACHE_MS = 30000;
/** Бюджет одного запроса квот. */
export declare const USAGE_REQUEST_TIMEOUT_MS = 8000;
/** Одно окно ограничений подписки (5 часов или неделя). */
export interface CodexUsageWindow {
    readonly usedPercent: number;
    readonly windowSeconds?: number;
    readonly resetAt?: number;
}
/** Нормализованный ответ `wham/usage`. */
export interface CodexUsage {
    readonly planType?: string;
    readonly primary?: CodexUsageWindow;
    readonly secondary?: CodexUsageWindow;
    readonly limitReached?: boolean;
    readonly resetCredits?: number;
    readonly fetchedAt: number;
}
/** Параметры запроса квот. */
export interface CodexUsageSpec {
    readonly credential: CodexCallCredential;
    readonly usageUrl?: string;
    readonly signal?: AbortSignal;
    readonly fetchImpl?: typeof globalThis.fetch;
}
/**
 * Привести ответ `wham/usage` к стабильным полям отображения. Выносит только
 * фактические поля бэкенда; альтернативные имена полей (camelCase и обратно
 * совместимые варианты) сводятся к одному виду. Exported for unit tests.
 */
export declare function normalizeUsage(value: unknown, fetchedAt?: number): CodexUsage;
/** Человекочитаемое название окна ограничений. Exported for unit tests. */
export declare function windowLabel(seconds: number | undefined): string;
/** Описание времени сброса окна: относительное и абсолютное. Exported for unit tests. */
export declare function resetDescription(resetAt: number, now?: number): string;
/** Русское представление квоты для пользователя и карточки инструмента. Exported for unit tests. */
export declare function usageText(usage: CodexUsage): string;
/** Текст ошибки запроса квот. Exported for unit tests. */
export declare function usageErrorText(error: unknown): string;
/**
 * Запросить квоту подписки. Ошибки — громкие: любой не-2xx ответ или
 * не-JSON тело становится ошибкой с HTTP-статусом, без выдуманных значений.
 */
export declare function fetchCodexUsage(spec: CodexUsageSpec): Promise<CodexUsage>;
//# sourceMappingURL=usage.d.ts.map