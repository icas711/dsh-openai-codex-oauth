/**
 * Инструмент `codex_usage` (фаза 2 плагина): доступная модели сверка квот
 * подписки ChatGPT. По плану включается конфигом `usageTool` только после
 * проверки живого ответа бэкенда — по умолчанию выключен.
 * @module dsh-openai-codex-oauth/usage-tool
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { CodexCallCredential } from './codex-api.ts';
/** Зависимости инструмента от остального кода плагина. */
export interface CodexUsageToolDeps {
    /** Адрес эндпоинта квот из конфига плагина. */
    readonly usageUrl: string;
    /** Авторизация для запроса; sessionId — сессия, от которой идёт вызов. */
    resolveCredential(signal: AbortSignal, sessionId: string | undefined): Promise<CodexCallCredential>;
    /** Точка внедрения fetch для тестов. */
    readonly fetchImpl?: typeof globalThis.fetch;
}
/** Каноническое значение инструмента (совпадает с output.schema). */
export interface CodexUsageValue {
    fetchedAt: number;
    planType?: string;
    primary?: {
        usedPercent: number;
        windowSeconds?: number;
        resetAt?: number;
    };
    secondary?: {
        usedPercent: number;
        windowSeconds?: number;
        resetAt?: number;
    };
    limitReached?: boolean;
    resetCredits?: number;
}
/** Собрать определение инструмента codex_usage. */
export declare function defineCodexUsageTool(deps: CodexUsageToolDeps): ToolDefinition;
//# sourceMappingURL=usage-tool.d.ts.map