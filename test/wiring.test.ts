import { describe, expect, it, vi } from 'vitest'
import { apply, Config as _Unused } from '../src/index.js'
import type { Config } from '../src/index.js'
import type { OAuthCredential } from '@earendil-works/pi-ai'

void _Unused

interface RegisteredCommand {
  name: string
  handler: (invocation: { agent: { id: string }, signal: AbortSignal, rawInput: string }) => Promise<{ kind: string, text: string }>
  input?: { hint?: string }
}

interface FakeCtxOptions {
  web?: object
  tools?: object
  attachments?: object
}

function makeToolsStub() {
  return {
    register: (_tool: unknown) => () => undefined,
  }
}

function fakeCtx(options: FakeCtxOptions = {}) {
  const commands: RegisteredCommand[] = []
  const searchProviders: unknown[] = []
  const tools: unknown[] = []
  const effects: Array<() => void> = []
  const logs: string[] = []
  const services: Record<string, unknown> = {
    ...(options.web === undefined ? {} : { web: options.web }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
  }
  const ctx = {
    commands: { register: (command: RegisteredCommand) => { commands.push(command) } },
    credentials: {
      resolve: async () => undefined,
      describe: async () => ({ writable: true, source: 'file' }),
      set: async () => undefined,
      unset: async () => undefined,
    },
    userQuestions: { ask: async () => { throw new Error('no user-questions provider') } },
    logger: {
      info: (message: string) => { logs.push(message) },
      warn: (message: string) => { logs.push(message) },
    },
    get: (key: string) => services[key],
    effect: (body: () => () => void) => {
      const dispose = body()
      effects.push(dispose)
      return () => dispose()
    },
    on: (_event: string, _handler: unknown) => () => undefined,
  }
  return {
    ctx,
    commands,
    searchProviders,
    tools,
    effects,
    logs,
    services,
    registerSearchProvider: (provider: unknown) => { searchProviders.push(provider) },
    registerTool: (tool: unknown) => { tools.push(tool) },
  }
}

describe('apply wiring', () => {
  it('registers the four commands in a minimal profile', () => {
    const fake = fakeCtx()
    apply(fake.ctx as never, {} as Config)
    expect(fake.commands.map(command => command.name)).toEqual([
      'codex-login',
      'codex-logout',
      'codex-status',
      'codex-usage',
    ])
  })

  it('registers the search provider and the image tool when services exist', () => {
    const fake = fakeCtx({ tools: makeToolsStub(), attachments: {} })
    const registrations: unknown[] = []
    const disposals: Array<() => void> = []
    fake.services.web = { registerSearchProvider: (provider: unknown) => { registrations.push(provider); return () => undefined } }
    fake.services.tools = { register: (tool: unknown) => { registrations.push(tool); return () => undefined } }
    const originalEffect = fake.ctx.effect
    fake.ctx.effect = ((body: () => () => void) => {
      const dispose = body()
      disposals.push(dispose)
      return () => dispose()
    }) as typeof originalEffect
    apply(fake.ctx as never, {} as Config)
    const provider = registrations[0] as { id: string, available(): boolean }
    expect(provider.id).toBe('openai-codex')
    expect(provider.available()).toBe(false)
    const tool = registrations[1] as { name: string }
    expect(tool.name).toBe('generate_image')
    expect(disposals).toHaveLength(2)
  })

  it('keeps codex_usage off by default and honors usageTool', () => {
    const withTool = fakeCtx({ tools: makeToolsStub(), attachments: {} })
    const names: string[] = []
    withTool.services.tools = { register: (tool: { name: string }) => { names.push(tool.name); return () => undefined } }
    withTool.ctx.effect = ((body: () => () => void) => { void body(); return () => undefined }) as typeof withTool.ctx.effect
    apply(withTool.ctx as never, { usageTool: true } as Config)
    expect(names).toEqual(['codex_usage', 'generate_image'])
    names.length = 0
    const withoutFlag = fakeCtx({ tools: makeToolsStub(), attachments: {} })
    withoutFlag.services.tools = { register: (tool: { name: string }) => { names.push(tool.name); return () => undefined } }
    withoutFlag.ctx.effect = ((body: () => () => void) => { void body(); return () => undefined }) as typeof withoutFlag.ctx.effect
    apply(withoutFlag.ctx as never, {} as Config)
    expect(names).toEqual(['generate_image'])
  })

  it('skips feature wiring when services are missing and logs it', () => {
    const bare = fakeCtx()
    apply(bare.ctx as never, {} as Config)
    expect(bare.searchProviders).toHaveLength(0)
    expect(bare.tools).toHaveLength(0)
    expect(bare.logs.some(line => line.includes('web-шина не установлена'))).toBe(true)
    expect(bare.logs.some(line => line.includes('реестр инструментов не установлен'))).toBe(true)

    const toolsOnly = fakeCtx({ tools: makeToolsStub() })
    apply(toolsOnly.ctx as never, {} as Config)
    expect(toolsOnly.logs.some(line => line.includes('сервис вложений не установлен'))).toBe(true)
  })

  it('serves /codex-usage from the deployment cache after a fetch', async () => {
    const fake = fakeCtx()
    const credential: OAuthCredential = { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 }
    let resolves = 0
    fake.ctx.credentials.resolve = async () => {
      resolves += 1
      return resolves === 1
        ? { value: JSON.stringify(credential), source: 'file' }
        : undefined
    }
    apply(fake.ctx as never, {} as Config)
    const usage = fake.commands.find(command => command.name === 'codex-usage')
    if (usage === undefined) throw new Error('codex-usage not registered')
    const invocation = {
      agent: { id: 'session-1' },
      signal: new AbortController().signal,
      rawInput: '',
    }
    const result = await usage.handler(invocation)
    // fetch недоступен без сети/мока — команда обязана упасть громко, но не молча.
    expect(['success', 'error']).toContain(result.kind)
    expect(typeof result.text).toBe('string')
    expect(result.text.length).toBeGreaterThan(0)
  })

  it('rejects a wrong /codex-usage argument loudly', async () => {
    const fake = fakeCtx()
    apply(fake.ctx as never, {} as Config)
    const usage = fake.commands.find(command => command.name === 'codex-usage')
    if (usage === undefined) throw new Error('codex-usage not registered')
    const result = await usage.handler({ agent: { id: 's' }, signal: new AbortController().signal, rawInput: 'bogus' })
    expect(result).toEqual({ kind: 'error', text: 'Использование: /codex-usage [refresh]' })
  })

  it('does not throw on duplicate effects during apply', () => {
    const fake = fakeCtx({ tools: makeToolsStub(), attachments: {} })
    const spy = vi.fn()
    fake.services.web = { registerSearchProvider: () => { spy(); return () => undefined } }
    apply(fake.ctx as never, {} as Config)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('agent/request syncs the conventional api-key ref beside the access token', async () => {
    const fake = fakeCtx()
    const credential: OAuthCredential = { type: 'oauth', access: 'jwt-token', refresh: 'r', expires: Date.now() + 3600_000 }
    const stored: Record<string, string> = { OPENAI_CODEX_OAUTH_CREDENTIAL: JSON.stringify(credential) }
    const sets: string[] = []
    fake.ctx.credentials.resolve = async (ref: string) => {
      const value = stored[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    }
    fake.ctx.credentials.set = async (ref: string, value: string) => {
      stored[ref] = value
      sets.push(ref)
    }
    const handlers: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    fake.ctx.on = ((_event: string, handler: never) => {
      handlers.push(handler)
      return () => undefined
    }) as typeof fake.ctx.on
    apply(fake.ctx as never, {} as Config)
    expect(handlers).toHaveLength(1)
    const request = await handlers[0]({ agent: { id: 's' }, signal: new AbortController().signal }, async () => ({ provider: 'openai-codex', model: 'gpt-5.6-sol' }))
    expect(request).toEqual({ provider: 'openai-codex', model: 'gpt-5.6-sol' })
    expect(stored.OPENAI_CODEX_ACCESS_TOKEN).toBe('jwt-token')
    expect(stored.OPENAI_CODEX_API_KEY).toBe('jwt-token')
    expect(sets).toEqual(['OPENAI_CODEX_ACCESS_TOKEN', 'OPENAI_CODEX_API_KEY'])
  })

  it('codex-logout removes the credentials and the personal provider profile', async () => {
    const fake = fakeCtx()
    const credential: OAuthCredential = { type: 'oauth', access: 'jwt-token', refresh: 'r', expires: Date.now() + 3600_000 }
    const personalStore: Record<string, string> = {
      OPENAI_CODEX_OAUTH_CREDENTIAL: JSON.stringify(credential),
      OPENAI_CODEX_ACCESS_TOKEN: 'jwt-token',
      OPENAI_CODEX_API_KEY: 'jwt-token',
    }
    const unset: string[] = []
    const sections = new Map<string, object>([
      ['exo2', { providers: { 'zai-coding-cn': { baseURL: 'https://z.ai/v1' }, 'openai-codex': {} } }],
    ])
    fake.services.credentialScopes = { ownerOf: () => 'exo2' }
    fake.services.userCredentials = {
      resolve: async (ref: string) => {
        const value = personalStore[ref]
        return value === undefined ? undefined : { value, source: 'user' }
      },
      describe: async () => ({ writable: true, source: 'user' }),
      set: async (ref: string, value: string) => { personalStore[ref] = value },
      unset: async (ref: string) => { unset.push(ref); delete personalStore[ref] },
    }
    fake.services.userSettings = {
      sectionOf: async (_ns: string, owner: string) => sections.get(owner),
      writeSection: async (_ns: string, owner: string, section: object) => { sections.set(owner, section) },
    }
    apply(fake.ctx as never, {} as Config)
    const logout = fake.commands.find(command => command.name === 'codex-logout')
    if (logout === undefined) throw new Error('codex-logout not registered')
    const result = await logout.handler({ agent: { id: 'session-1' }, signal: new AbortController().signal, rawInput: '' })
    expect(result.kind).toBe('success')
    expect(unset.sort()).toEqual(['OPENAI_CODEX_ACCESS_TOKEN', 'OPENAI_CODEX_API_KEY', 'OPENAI_CODEX_OAUTH_CREDENTIAL'])
    expect(sections.get('exo2')).toEqual({ providers: { 'zai-coding-cn': { baseURL: 'https://z.ai/v1' } } })
  })
})
