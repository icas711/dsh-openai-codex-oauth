import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CODEX_RESPONSES_URL,
  DEFAULT_ORIGINATOR,
  JWT_CLAIM_PATH,
  accountIdOf,
  buildCodexHeaders,
  buildUserTextInput,
  codexEventsError,
  collectOutputItems,
  parseSseText,
  requestCodexEvents,
} from '../src/codex-api.js'
import type { CodexCallCredential } from '../src/codex-api.js'

function jwt(payload: unknown): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `header.${encode(payload)}.signature`
}

function codexCredential(access: string, accountId = 'acct-1'): CodexCallCredential {
  return { access, accountId }
}

describe('buildUserTextInput', () => {
  it('wraps non-empty text into the list-only input shape', () => {
    expect(buildUserTextInput('привет')).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'привет' }] },
    ])
  })

  it('rejects empty and non-string input', () => {
    expect(() => buildUserTextInput('')).toThrow('Текст запроса к OpenAI Codex должен быть непустой строкой')
    expect(() => buildUserTextInput(undefined as unknown as string)).toThrow('Текст запроса к OpenAI Codex должен быть непустой строкой')
  })
})

describe('accountIdOf', () => {
  it('reads chatgpt_account_id from the auth claim', () => {
    const token = jwt({ [JWT_CLAIM_PATH]: { chatgpt_account_id: 'acct-77' } })
    expect(accountIdOf({ access: token })).toBe('acct-77')
  })

  it('rejects a non-JWT token with the login hint', () => {
    expect(() => accountIdOf({ access: 'sk-proj-not-a-jwt' }))
      .toThrow('Access-токен OpenAI Codex не является JWT — выполните /codex-login')
  })

  it('rejects unparsable payload with the login hint', () => {
    expect(() => accountIdOf({ access: 'a.%%%.c' }))
      .toThrow('Не удалось разобрать access-токен OpenAI Codex — выполните /codex-login')
  })

  it('rejects a JWT without the account claim', () => {
    expect(() => accountIdOf({ access: jwt({ sub: 'user' }) }))
      .toThrow('В access-токене OpenAI Codex нет идентификатора аккаунта ChatGPT — выполните /codex-login')
  })
})

describe('buildCodexHeaders', () => {
  it('renders the full direct-call header set', () => {
    const headers = buildCodexHeaders(codexCredential('tok', 'acct'), 'pi', 'req-1')
    expect(headers).toMatchObject({
      authorization: 'Bearer tok',
      'chatgpt-account-id': 'acct',
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'openai-beta': 'responses=experimental',
      originator: 'pi',
      'x-client-request-id': 'req-1',
    })
    expect(headers['user-agent']).toMatch(/^pi \(/u)
  })

  it('defaults originator and generates a request id', () => {
    const headers = buildCodexHeaders(codexCredential('tok', 'acct'))
    expect(headers.originator).toBe(DEFAULT_ORIGINATOR)
    expect(headers['x-client-request-id'].length).toBeGreaterThan(0)
  })

  it('rejects an incomplete credential', () => {
    expect(() => buildCodexHeaders(codexCredential('', '')))
      .toThrow('Учётные данные OpenAI Codex неполны — выполните /codex-login')
  })
})

describe('parseSseText', () => {
  it('parses data events and skips [DONE]', () => {
    const events = parseSseText('data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: [DONE]\n\n')
    expect(events).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('joins multi-line data payloads and tolerates CRLF', () => {
    const events = parseSseText('data: {"type":\r\ndata: "a"}\r\n\r\n')
    expect(events).toEqual([{ type: 'a' }])
  })

  it('falls back to a plain JSON body', () => {
    expect(parseSseText('{"type":"plain"}')).toEqual([{ type: 'plain' }])
  })

  it('throws a Russian error on invalid JSON payloads', () => {
    expect(() => parseSseText('data: {oops}\n\n'))
      .toThrow(/Некорректное SSE-событие OpenAI Codex/u)
  })
})

describe('collectOutputItems', () => {
  it('collects item events, response snapshots and anonymous items', () => {
    const events = [
      { type: 'response.output_item.done', item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
      { type: 'response.completed', response: { output: [{ type: 'web_search_call', id: 'w1', results: [] }] } },
      { output: [{ type: 'reasoning' }] },
    ]
    const items = collectOutputItems(events)
    expect(items).toHaveLength(3)
    expect(items.map(item => (item as { type: string }).type)).toEqual(['message', 'web_search_call', 'reasoning'])
  })

  it('deduplicates items by type and id across events', () => {
    const item = { type: 'message', id: 'm1', content: [] }
    const events = [
      { item },
      { response: { output: [item] } },
    ]
    expect(collectOutputItems(events)).toEqual([item])
  })
})

describe('codexEventsError', () => {
  it('extracts the backend error message', () => {
    expect(codexEventsError([{ type: 'error', error: { message: 'quota exhausted' } }])).toBe('quota exhausted')
  })

  it('extracts response.failed details', () => {
    expect(codexEventsError([{ type: 'response.failed', response: { error: { code: 'rate_limited' } } }])).toBe('rate_limited')
  })

  it('falls back to Russian defaults', () => {
    expect(codexEventsError([{ type: 'error' }])).toBe('Запрос к OpenAI Codex завершился ошибкой')
    expect(codexEventsError([{ type: 'response.failed', response: {} }])).toBe('Ответ OpenAI Codex завершился ошибкой')
    expect(codexEventsError([{ type: 'ok' }])).toBeUndefined()
  })
})

describe('requestCodexEvents', () => {
  it('posts the body with direct-call headers and parses events', async () => {
    let captured: { url: string, init: RequestInit } | undefined
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return new Response('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n', { status: 200 })
    }) as typeof fetch
    const events = await requestCodexEvents({
      credential: codexCredential('tok', 'acct'),
      body: { model: 'gpt-5.6-sol' },
      fetchImpl,
    })
    expect(events).toEqual([{ type: 'response.completed' }])
    expect(captured?.url).toBe(DEFAULT_CODEX_RESPONSES_URL)
    expect(captured?.init.method).toBe('POST')
    const headers = captured?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers['chatgpt-account-id']).toBe('acct')
  })

  it('reports a non-2xx status with the backend detail', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'no subscription' } }), { status: 403 })) as typeof fetch
    await expect(requestCodexEvents({ credential: codexCredential('tok', 'acct'), body: {}, fetchImpl }))
      .rejects.toThrow('Запрос к OpenAI Codex не удался (HTTP 403): no subscription')
  })

  it('reports network failures with a Russian message', async () => {
    const fetchImpl = (async () => { throw new Error('boom') }) as typeof fetch
    await expect(requestCodexEvents({ credential: codexCredential('tok', 'acct'), body: {}, fetchImpl }))
      .rejects.toThrow('Не удалось выполнить запрос к OpenAI Codex: boom')
  })

  it('surfaces in-stream backend errors', async () => {
    const fetchImpl = (async () => new Response('data: {"type":"error","error":{"message":"limit"}}\n\n', { status: 200 })) as typeof fetch
    await expect(requestCodexEvents({ credential: codexCredential('tok', 'acct'), body: {}, fetchImpl }))
      .rejects.toThrow('limit')
  })
})
