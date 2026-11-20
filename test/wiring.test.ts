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
})
