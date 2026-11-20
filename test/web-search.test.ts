import { describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  CODEX_SEARCH_PROVIDER_ID,
  DEFAULT_SEARCH_MODEL,
  CodexSearchProvider,
  buildWebSearchRequest,
  mapCodexSearchEvents,
} from '../src/web-search.js'
import type { CodexCallCredential } from '../src/codex-api.js'

function sse(events: unknown[]): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function provider(overrides: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  return new CodexSearchProvider(makeDeps(overrides))
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    hasCredential: () => true,
    resolveCredential: async (): Promise<CodexCallCredential> => ({ access: 'tok', accountId: 'acct' }),
    endpoint: 'https://example.invalid/responses',
    originator: 'pi',
    model: DEFAULT_SEARCH_MODEL,
    ...overrides,
  }
}

describe('buildWebSearchRequest', () => {
  it('forces the hosted web_search tool on the configured model', () => {
    const body = buildWebSearchRequest('что такое DSH', 'gpt-5.6-luna')
    expect(body.model).toBe('gpt-5.6-luna')
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.tool_choice).toEqual({ type: 'web_search' })
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'что такое DSH' }] }])
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    expect(body.parallel_tool_calls).toBe(false)
    expect(body.text).toEqual({ verbosity: 'low' })
  })

  it('defaults the model', () => {
    expect(buildWebSearchRequest('q').model).toBe(DEFAULT_SEARCH_MODEL)
  })
})

describe('mapCodexSearchEvents', () => {
  it('maps assistant text, url citations and web_search_call results', () => {
    const events = [
      {
        type: 'response.completed',
        response: {
          output: [
            {
              type: 'web_search_call',
              results: [{ url: 'https://a.example', title: 'A', snippet: 'sa', published_at: '2026-01-01T00:00:00Z' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'Ответ с источниками.',
                  annotations: [{ type: 'url_citation', url_citation: { url: 'https://b.example', title: 'B' } }],
                },
              ],
            },
          ],
        },
      },
    ]
    const mapped = mapCodexSearchEvents(events)
    expect(mapped.content).toBe('Ответ с источниками.')
    expect(mapped.sources).toEqual([
      { url: 'https://a.example', title: 'A', snippet: 'sa', publishedAt: '2026-01-01T00:00:00Z' },
      { url: 'https://b.example', title: 'B' },
    ])
  })

  it('deduplicates sources by URL and merges markdown fallback citations', () => {
    const events = [{
      item: {
        type: 'message',
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: 'См. [источник](https://a.example) и [ещё](https://a.example).' }],
      },
    }]
    const mapped = mapCodexSearchEvents(events)
    expect(mapped.sources).toEqual([{ url: 'https://a.example', title: 'источник' }])
  })

  it('throws a Russian error when no assistant answer came back', () => {
    expect(() => mapCodexSearchEvents([{ type: 'response.completed', response: { output: [] } }]))
      .toThrow('Поиск OpenAI Codex не вернул ответ ассистента')
    expect(() => mapCodexSearchEvents([{ type: 'error', error: { message: 'upstream' } }]))
      .toThrow('upstream')
  })
})

describe('CodexSearchProvider', () => {
  it('exposes the provider id and availability flag', () => {
    expect(provider().id).toBe(CODEX_SEARCH_PROVIDER_ID)
    expect(provider().available()).toBe(true)
    expect(provider({ hasCredential: () => false }).available()).toBe(false)
  })

  it('maps a successful backend search onto the web seam vocabulary', async () => {
    let captured: { url: string, body: unknown } | undefined
    const search = provider({
      resolveCredential: async () => ({ access: 'tok', accountId: 'acct' }),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input), body: JSON.parse(String(init?.body)) }
        return new Response(sse([{
          type: 'response.completed',
          response: {
            output: [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'нашёл', annotations: [{ type: 'url_citation', url_citation: { url: 'https://x.example' } }] }],
            }],
          },
        }]), { status: 200 })
      }) as typeof fetch,
    })
    const result = await search.search({ query: 'тест' })
    expect(result.content).toBe('нашёл')
    expect(result.sources).toEqual([{ url: 'https://x.example' }])
    expect(result.truncated).toBe(false)
    expect(captured?.url).toBe('https://example.invalid/responses')
    const body = captured?.body as { model: string, tools: unknown }
    expect(body.model).toBe(DEFAULT_SEARCH_MODEL)
    expect(body.tools).toEqual([{ type: 'web_search' }])
  })

  it('refuses to search without credentials via WebError', async () => {
    const search = provider({ hasCredential: () => false })
    await expect(search.search({ query: 'q' })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(WebError)
      expect((error as WebError).code).toBe('WEB_PROVIDER_CREDENTIAL_MISSING')
      expect((error as WebError).message).toBe('Вход OpenAI Codex OAuth не настроен — выполните /codex-login, чтобы искать через подписку.')
      return true
    })
  })

  it('wraps backend failures as WebError with a provider code', async () => {
    const search = provider({
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    })
    await expect(search.search({ query: 'q' })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(WebError)
      expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
      expect((error as WebError).message).toContain('HTTP 500')
      return true
    })
  })

  it('reports cancellation as WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const search = provider({
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal
        if (signal.aborted) throw new Error('aborted')
        return new Response('data: {"type":"response.completed"}\n\n', { status: 200 })
      }) as typeof fetch,
    })
    await expect(search.search({ query: 'q' }, controller.signal)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(WebError)
      expect((error as WebError).code).toBe('WEB_ABORTED')
      return true
    })
  })
})
