/**
 * Инструмент `codex_usage` (фаза 2 плагина): доступная модели сверка квот
 * подписки ChatGPT. По плану включается конфигом `usageTool` только после
 * проверки живого ответа бэкенда — по умолчанию выключен.
 * @module dsh-openai-codex-oauth/usage-tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fetchCodexUsage, usageText } from "./usage.js";
function usageValue(usage) {
    return {
        fetchedAt: usage.fetchedAt,
        ...(usage.planType !== undefined ? { planType: usage.planType } : {}),
        ...(usage.primary !== undefined ? { primary: usage.primary } : {}),
        ...(usage.secondary !== undefined ? { secondary: usage.secondary } : {}),
        ...(usage.limitReached !== undefined ? { limitReached: usage.limitReached } : {}),
        ...(usage.resetCredits !== undefined ? { resetCredits: usage.resetCredits } : {}),
    };
}
const windowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        usedPercent: { type: 'number', required: true },
        windowSeconds: { type: 'number' },
        resetAt: { type: 'number' },
    },
};
/** Собрать определение инструмента codex_usage. */
export function defineCodexUsageTool(deps) {
    return defineTool({
        name: 'codex_usage',
        description: 'Check the signed-in ChatGPT/Codex subscription quota: plan, 5-hour and weekly usage windows, and reset times. Read-only.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    planType: { type: 'string' },
                    primary: windowSchema,
                    secondary: windowSchema,
                    limitReached: { type: 'boolean' },
                    resetCredits: { type: 'number' },
                    fetchedAt: { type: 'number', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: usageText(value) }],
        },
        // Чтение квоты не меняет состояния родительского агента.
        isConcurrencySafe: () => true,
        presentCall: () => ({
            card: 'generic',
            title: 'Квота OpenAI Codex',
            kind: 'read',
        }),
        async execute(_args, exec) {
            return usageValue(await fetchCodexUsage({
                credential: await deps.resolveCredential(exec.signal, exec.agent === undefined ? undefined : String(exec.agent.id)),
                usageUrl: deps.usageUrl,
                signal: exec.signal,
                ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
            }));
        },
    });
}
//# sourceMappingURL=usage-tool.js.map