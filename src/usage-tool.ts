/**
 * Инструмент `codex_usage` (фаза 2 плагина): доступная модели сверка квот
 * подписки ChatGPT. По плану включается конфигом `usageTool` только после
 * проверки живого ответа бэкенда — по умолчанию выключен.
 * @module dsh-openai-codex-oauth/usage-tool
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CodexCallCredential } from './codex-api.ts'
import { fetchCodexUsage, usageText, type CodexUsage } from './usage.ts'

/** Зависимости инструмента от остального кода плагина. */
export interface CodexUsageToolDeps {
  /** Адрес эндпоинта квот из конфига плагина. */
  readonly usageUrl: string
  /** Авторизация для запроса; sessionId — сессия, от которой идёт вызов. */
  resolveCredential(signal: AbortSignal, sessionId: string | undefined): Promise<CodexCallCredential>
  /** Точка внедрения fetch для тестов. */
  readonly fetchImpl?: typeof globalThis.fetch
}

/** Каноническое значение инструмента (совпадает с output.schema). */
export interface CodexUsageValue {
  fetchedAt: number
  planType?: string
  primary?: { usedPercent: number; windowSeconds?: number; resetAt?: number }
  secondary?: { usedPercent: number; windowSeconds?: number; resetAt?: number }
  limitReached?: boolean
  resetCredits?: number
}

function usageValue(usage: CodexUsage): CodexUsageValue {
  return {
    fetchedAt: usage.fetchedAt,
    ...(usage.planType !== undefined ? { planType: usage.planType } : {}),
    ...(usage.primary !== undefined ? { primary: usage.primary } : {}),
    ...(usage.secondary !== undefined ? { secondary: usage.secondary } : {}),
    ...(usage.limitReached !== undefined ? { limitReached: usage.limitReached } : {}),
    ...(usage.resetCredits !== undefined ? { resetCredits: usage.resetCredits } : {}),
  }
}

const windowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    usedPercent: { type: 'number', required: true },
    windowSeconds: { type: 'number' },
    resetAt: { type: 'number' },
  },
} as const

/** Собрать определение инструмента codex_usage. */
export function defineCodexUsageTool(deps: CodexUsageToolDeps): ToolDefinition {
  return defineTool({
    name: 'codex_usage',
    description:
      'Check the signed-in ChatGPT/Codex subscription quota: plan, 5-hour and weekly usage windows, and reset times. Read-only.',
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
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: usageText(value) }],
    },
    // Чтение квоты не меняет состояния родительского агента.
    isConcurrencySafe: () => true,
    presentCall: () => ({
      card: 'generic',
      title: 'Квота OpenAI Codex',
      kind: 'read',
    }),
    async execute(_args: unknown, exec) {
      return usageValue(await fetchCodexUsage({
        credential: await deps.resolveCredential(exec.signal, exec.agent === undefined ? undefined : String(exec.agent.id)),
        usageUrl: deps.usageUrl,
        signal: exec.signal,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      }))
    },
  })
}
