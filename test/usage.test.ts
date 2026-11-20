import { describe, expect, it } from 'vitest'
import {
  DEFAULT_USAGE_URL,
  USAGE_CACHE_MS,
  USAGE_REQUEST_TIMEOUT_MS,
  fetchCodexUsage,
  normalizeUsage,
  resetDescription,
  usageErrorText,
  usageText,
  windowLabel,
} from '../src/usage.js'
import type { CodexCallCredential } from '../src/codex-api.js'

const FULL_REPLY = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 42.5, limit_window_seconds: 18000, reset_at: 1764000000 },
    secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1764600000 },
    limit_reached: false,
  },
  rate_limit_reset_credits: { available_count: 3 },
}

function credential(): CodexCallCredential {
  return { access: 'tok', accountId: 'acct' }
}

describe('normalizeUsage', () => {
  it('maps the full snake_case reply', () => {
    const usage = normalizeUsage(FULL_REPLY, 1000)
    expect(usage).toEqual({
      planType: 'plus',
      primary: { usedPercent: 42.5, windowSeconds: 18000, resetAt: 1764000000 },
      secondary: { usedPercent: 12, windowSeconds: 604800, resetAt: 1764600000 },
      limitReached: false,
      resetCredits: 3,
      fetchedAt: 1000,
    })
  })

  it('accepts back-compat primary/secondary and camelCase field names', () => {
    const usage = normalizeUsage({
      rate_limit: {
        primary: { usedPercent: 10, windowDurationSecs: 18000, resetsAt: 1764000000 },
        secondary_window: { used_percent: 20 },
      },
    }, 5)
    expect(usage.primary).toEqual({ usedPercent: 10, windowSeconds: 18000, resetAt: 1764000000 })
    expect(usage.secondary).toEqual({ usedPercent: 20 })
    expect(usage.planType).toBeUndefined()
  })

  it('clamps used percent into 0..100 and drops non-finite values', () => {
    const usage = normalizeUsage({ rate_limit: { primary_window: { used_percent: 250 } } }, 1)
    expect(usage.primary?.usedPercent).toBe(100)
    const weird = normalizeUsage({ rate_limit: { primary_window: { used_percent: 'n/a' } } }, 1)
    expect(weird.primary).toBeUndefined()
  })

  it('tolerates non-object replies without inventing values', () => {
    for (const value of [undefined, null, 42, 'text']) {
      const usage = normalizeUsage(value, 7)
      expect(usage.fetchedAt).toBe(7)
      expect(usage.planType).toBeUndefined()
      expect(usage.primary).toBeUndefined()
      expect(usage.limitReached).toBeUndefined()
      expect(usage.resetCredits).toBeUndefined()
    }
  })
})

describe('windowLabel', () => {
  it('names the two known subscription windows', () => {
    expect(windowLabel(18000)).toBe('5-часовое окно')
    expect(windowLabel(604800)).toBe('недельное окно')
  })

  it('describes unknown durations generically', () => {
    expect(windowLabel(172800)).toBe('Окно 2 дн.')
    expect(windowLabel(7200)).toBe('Окно 2 ч')
    expect(windowLabel(90)).toBe('Окно 90 с')
    expect(windowLabel(undefined)).toBe('Текущее окно')
  })
})

describe('resetDescription', () => {
  it('renders relative minutes and the absolute timestamp', () => {
    const now = 1764000000_000 - 5 * 60_000
    expect(resetDescription(1764000000, now))
      .toBe(`сброс через 5 мин (${new Date(1764000000_000).toISOString()})`)
  })

  it('never reports a negative wait', () => {
    expect(resetDescription(1, 1764000000_000)).toMatch(/сброс через 0 мин /u)
  })
})

describe('usageText', () => {
  it('renders plan, windows, credits and the limit flag', () => {
    const text = usageText(normalizeUsage(FULL_REPLY, 1000))
    expect(text).toContain('План подписки ChatGPT: plus.')
    expect(text).toMatch(/5-часовое окно: использовано 42\.5%, сброс через \d+ мин \(/u)
    expect(text).toMatch(/недельное окно: использовано 12%, сброс через \d+ мин \(/u)
    expect(text).toContain('Доступные сброс-кредиты: 3.')
    expect(text).not.toContain('Лимит подписки достигнут.')
  })

  it('states honestly when the backend omitted plan_type', () => {
    expect(usageText(normalizeUsage({}, 1))).toContain('План подписки ChatGPT: бэкенд не вернул plan_type.')
  })

  it('renders the reached limit', () => {
    const text = usageText(normalizeUsage({ rate_limit: { limit_reached: true } }, 1))
    expect(text).toContain('Лимит подписки достигнут.')
  })
})

describe('usageErrorText', () => {
  it('maps aborts, HTTP statuses and keeps other messages loud', () => {
    expect(usageErrorText(new Error('Запрос квоты OpenAI Codex прерван'))).toBe('Запрос квоты OpenAI Codex прерван.')
    expect(usageErrorText(new Error('Запрос квоты OpenAI Codex не удался (HTTP 429)')))
      .toBe('Не удалось получить квоту OpenAI Codex (HTTP 429). Повторите позже или выполните /codex-login заново.')
    expect(usageErrorText(new Error('Ответ квоты OpenAI Codex не является JSON (HTTP 502)')))
      .toBe('Не удалось получить квоту OpenAI Codex (HTTP 502). Повторите позже или выполните /codex-login заново.')
    expect(usageErrorText(new Error('custom failure'))).toBe('custom failure')
    expect(usageErrorText('not an error')).toBe('Не удалось получить квоту OpenAI Codex.')
  })
})

describe('fetchCodexUsage', () => {
  it('sends bearer headers to the configured URL and normalizes the reply', async () => {
    let captured: { url: string, init: RequestInit } | undefined
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return new Response(JSON.stringify(FULL_REPLY), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const usage = await fetchCodexUsage({ credential: credential(), usageUrl: 'https://example.invalid/usage', fetchImpl })
    expect(captured?.url).toBe('https://example.invalid/usage')
    const headers = captured?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers['chatgpt-account-id']).toBe('acct')
    expect(headers.accept).toBe('application/json')
    expect(usage.planType).toBe('plus')
  })

  it('defaults to the production usage endpoint', async () => {
    let url: string | undefined
    const fetchImpl = (async (input: string | URL | Request) => {
      url = String(input)
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    await fetchCodexUsage({ credential: credential(), fetchImpl })
    expect(url).toBe(DEFAULT_USAGE_URL)
  })

  it('fails loud on a non-2xx reply', async () => {
    const fetchImpl = (async () => new Response('denied', { status: 401 })) as typeof fetch
    await expect(fetchCodexUsage({ credential: credential(), fetchImpl }))
      .rejects.toThrow('Запрос квоты OpenAI Codex не удался (HTTP 401)')
  })

  it('fails loud on a non-JSON body', async () => {
    const fetchImpl = (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch
    await expect(fetchCodexUsage({ credential: credential(), fetchImpl }))
      .rejects.toThrow('Ответ квоты OpenAI Codex не является JSON (HTTP 200)')
  })

  it('maps network failures to a Russian message', async () => {
    const fetchImpl = (async () => { throw new Error('dns') }) as typeof fetch
    await expect(fetchCodexUsage({ credential: credential(), fetchImpl }))
      .rejects.toThrow('Не удалось выполнить запрос квоты OpenAI Codex: dns')
  })
})

describe('constants', () => {
  it('keeps the documented cooldown and timeout defaults', () => {
    expect(USAGE_CACHE_MS).toBe(30_000)
    expect(USAGE_REQUEST_TIMEOUT_MS).toBe(8_000)
    expect(DEFAULT_USAGE_URL).toBe('https://chatgpt.com/backend-api/wham/usage')
  })
})
