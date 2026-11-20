import { describe, expect, it } from 'vitest'
import { defineCodexUsageTool } from '../src/usage-tool.js'

const FULL_REPLY = JSON.stringify({
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: 1764000000 },
    limit_reached: false,
  },
})

describe('defineCodexUsageTool', () => {
  it('declares the codex_usage schema and presentation', () => {
    const tool = defineCodexUsageTool({
      usageUrl: 'https://example.invalid/usage',
      resolveCredential: async () => ({ access: 'tok', accountId: 'acct' }),
    })
    expect(tool.name).toBe('codex_usage')
    expect(tool.isConcurrencySafe?.({})).toBe(true)
    expect(tool.presentCall?.({})).toMatchObject({ card: 'generic', title: 'Квота OpenAI Codex', kind: 'read' })
    const schema = tool.parameters as { properties: Record<string, unknown> }
    expect(schema.properties).toEqual({})
  })

  it('executes against the usage endpoint and returns the canonical value', async () => {
    let captured: { url: string, headers: Record<string, string> } | undefined
    const tool = defineCodexUsageTool({
      usageUrl: 'https://example.invalid/usage',
      resolveCredential: async () => ({ access: 'tok', accountId: 'acct' }),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input), headers: init?.headers as Record<string, string> }
        return new Response(FULL_REPLY, { status: 200 })
      }) as typeof fetch,
    })
    const exec = { signal: new AbortController().signal } as never
    const value = await tool.execute({}, exec) as {
      fetchedAt: number
      planType?: string
      primary?: { usedPercent: number }
      limitReached?: boolean
    }
    expect(captured?.url).toBe('https://example.invalid/usage')
    expect(captured?.headers.authorization).toBe('Bearer tok')
    expect(value.planType).toBe('pro')
    expect(value.primary?.usedPercent).toBe(7)
    expect(value.limitReached).toBe(false)
    expect(typeof value.fetchedAt).toBe('number')
  })

  it('renders the usage summary in Russian', () => {
    const tool = defineCodexUsageTool({
      usageUrl: 'https://example.invalid/usage',
      resolveCredential: async () => ({ access: 'tok', accountId: 'acct' }),
    })
    const blocks = tool.output.render({} as never, {
      fetchedAt: 1000,
      planType: 'pro',
      primary: { usedPercent: 7, windowSeconds: 18000, resetAt: 1764000000 },
    } as never)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text).toContain('План подписки ChatGPT: pro.')
    expect((blocks[0] as { text: string }).text).toContain('5-часовое окно: использовано 7%')
  })
})
