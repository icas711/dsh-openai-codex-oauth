import { describe, expect, it } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  answerValue,
  expiryDescription,
  loginSuccessText,
  logoutSuccessText,
  parseOAuthCredential,
  personalStoreView,
  requestedMethod,
  resolveOwnerFrom,
  safeInteractionError,
  safeLoginError,
  scopeLabel,
  statusSuccessText,
  usageCommandHint,
} from '../src/index.js'
import type { PersonalCredentialsView } from '../src/index.js'

type AskAnswer = Parameters<typeof answerValue>[0]

function askAnswer(answers: unknown): AskAnswer {
  return { answers } as AskAnswer
}

function credential(expires: number): OAuthCredential {
  return { type: 'oauth', access: 'a', refresh: 'r', expires }
}

describe('parseOAuthCredential', () => {
  it('returns a valid credential with the same fields', () => {
    const result = parseOAuthCredential(JSON.stringify(credential(1)))
    expect(result.type).toBe('oauth')
    expect(result.access).toBe('a')
    expect(result.refresh).toBe('r')
    expect(result.expires).toBe(1)
  })

  it('throws on non-JSON input', () => {
    expect(() => parseOAuthCredential('not json'))
      .toThrow('Хранимые учётные данные OpenAI OAuth — не корректный JSON')
  })

  it('throws on JSON array, null and primitives', () => {
    for (const raw of ['[]', 'null', '42', '"text"']) {
      expect(() => parseOAuthCredential(raw))
        .toThrow('Хранимые учётные данные OpenAI OAuth имеют неверную структуру')
    }
  })

  it('throws when required fields are missing', () => {
    expect(() => parseOAuthCredential(JSON.stringify({ type: 'oauth', access: 'a', expires: 1 })))
      .toThrow('В учётных данных OpenAI OAuth отсутствуют обязательные поля')
  })
})

describe('requestedMethod', () => {
  it('keeps the browser method', () => {
    expect(requestedMethod('browser')).toBe('browser')
    expect(requestedMethod('Browser')).toBe('browser')
  })

  it('normalizes device spellings', () => {
    expect(requestedMethod('device')).toBe('device_code')
    expect(requestedMethod('device-code')).toBe('device_code')
    expect(requestedMethod('device_code')).toBe('device_code')
  })

  it('returns undefined for empty input', () => {
    expect(requestedMethod('')).toBeUndefined()
    expect(requestedMethod('  ')).toBeUndefined()
  })

  it('throws on unknown input', () => {
    expect(() => requestedMethod('nonsense'))
      .toThrow('Использование: /codex-login [browser|device]')
  })
})

describe('expiryDescription', () => {
  it('describes expiry roughly in minutes', () => {
    const result = expiryDescription(credential(Date.now() + 30 * 60_000))
    expect(result).toMatch(/примерно через 30 мин/)
  })
})

describe('safeInteractionError', () => {
  it('falls back for non-Error values', () => {
    expect(safeInteractionError('a string')).toBe('неизвестная ошибка взаимодействия')
    expect(safeInteractionError(null)).toBe('неизвестная ошибка взаимодействия')
  })

  it('detects cancellation', () => {
    expect(safeInteractionError(new Error('operation cancelled'))).toBe('вход отменён')
  })

  it('detects a missing user-questions provider', () => {
    expect(safeInteractionError(new Error('no user-questions provider')))
      .toContain('не может показать вопросы входа')
  })

  it('falls back for other errors', () => {
    expect(safeInteractionError(new Error('anything else')))
      .toBe('не удалось выполнить интерактивный вход')
  })
})

describe('safeLoginError', () => {
  it('detects disabled device-code login', () => {
    expect(safeLoginError(new Error('device code login is not enabled for this server')))
      .toBe('OpenAI не включил вход по коду устройства — используйте вход через браузер.')
  })

  it('detects HTTP status failures', () => {
    expect(safeLoginError(new Error('request failed with status 403')))
      .toContain('HTTP-статус 403')
  })

  it('detects a state mismatch', () => {
    expect(safeLoginError(new Error('state mismatch')))
      .toBe('Параметр state в колбэке OpenAI OAuth не совпадает — повторите вход.')
  })

  it('detects a missing authorization code', () => {
    expect(safeLoginError(new Error('Missing authorization code')))
      .toBe('В колбэке OpenAI OAuth нет кода авторизации — повторите вход.')
  })

  it('falls back for non-Error values', () => {
    expect(safeLoginError('a string')).toBe('Не удалось выполнить вход OpenAI OAuth.')
  })
})

describe('answerValue', () => {
  it('returns the first selected option', () => {
    expect(answerValue(askAnswer([{ id: 'q', selected: ['Код устройства'] }]), 'q'))
      .toBe('Код устройства')
  })

  it('prefers custom text over an empty selection', () => {
    expect(answerValue(askAnswer([{ id: 'q', selected: [], custom: '  вставленный URL  ' }]), 'q'))
      .toBe('вставленный URL')
  })

  it('throws when the question was not answered', () => {
    expect(() => answerValue(askAnswer([]), 'q'))
      .toThrow('Для продолжения входа OAuth нужен ответ на вопрос')
  })
})

function fakePersonal(): PersonalCredentialsView & {
  calls: { op: string; ref: string; owner: string; value?: string }[]
} {
  const calls: { op: string; ref: string; owner: string; value?: string }[] = []
  const values = new Map<string, string>()
  return {
    calls,
    async resolve(ref, owner) {
      calls.push({ op: 'resolve', ref, owner })
      const value = values.get(ref)
      return value === undefined ? undefined : { value, source: 'user' }
    },
    async describe(ref, owner) {
      calls.push({ op: 'describe', ref, owner })
      return values.has(ref)
        ? { configured: true, source: 'user', writable: true }
        : { configured: false, writable: true }
    },
    async set(ref, value, owner) {
      calls.push({ op: 'set', ref, owner, value })
      values.set(ref, value)
    },
    async unset(ref, owner) {
      calls.push({ op: 'unset', ref, owner })
      values.delete(ref)
    },
  }
}

describe('resolveOwnerFrom', () => {
  it('returns the registry owner first', async () => {
    const owner = await resolveOwnerFrom({
      credentialScopes: { ownerOf: id => (id === 's1' ? 'exo2' : undefined) },
      sessionPersistence: { inspect: async () => ({ meta: { owner: 'other' } }) },
    }, 's1')
    expect(owner).toBe('exo2')
  })

  it('falls back to the persistence header', async () => {
    const owner = await resolveOwnerFrom({
      sessionPersistence: { inspect: async (id: string) => ({ meta: { owner: id === 's2' ? 'exo' : '' } }) },
    }, 's2')
    expect(owner).toBe('exo')
  })

  it('returns undefined without services, without a session, or on a read failure', async () => {
    expect(await resolveOwnerFrom({}, 's3')).toBeUndefined()
    expect(await resolveOwnerFrom({ credentialScopes: { ownerOf: () => undefined } }, undefined)).toBeUndefined()
    expect(await resolveOwnerFrom({
      sessionPersistence: { inspect: async () => { throw new Error('no such session') } },
    }, 's4')).toBeUndefined()
    expect(await resolveOwnerFrom({
      sessionPersistence: { inspect: async () => ({ meta: {} }) },
    }, 's5')).toBeUndefined()
  })
})

describe('scopeLabel', () => {
  it('names the personal store by owner', () => {
    expect(scopeLabel('exo2')).toBe('личное хранилище (exo2)')
  })

  it('names the deployment store without an owner', () => {
    expect(scopeLabel(undefined)).toBe('общее хранилище харнесса')
  })
})

describe('personalStoreView', () => {
  it('binds the owner on every operation', async () => {
    const personal = fakePersonal()
    const store = personalStoreView(personal, 'exo2')
    expect(store.scopeLabel).toBe('личное хранилище (exo2)')
    await store.set('REF_A' as never, 'value-a')
    await store.set('REF_B' as never, 'value-b')
    const resolved = await store.resolve('REF_A' as never)
    expect(resolved).toEqual({ value: 'value-a', source: 'user' })
    await store.unset('REF_A' as never)
    expect(await store.resolve('REF_A' as never)).toBeUndefined()
    for (const call of personal.calls) {
      expect(call.owner).toBe('exo2')
    }
  })
})

describe('owner-scoped result texts', () => {
  const cred = credential(Date.now() + 30 * 60_000)

  it('login names the scope', () => {
    expect(loginSuccessText(cred, 'exo2'))
      .toContain('Вход OpenAI Codex OAuth выполнен. Access-токен истекает:')
    expect(loginSuccessText(cred, 'exo2')).toContain('Хранилище: личное хранилище (exo2).')
    expect(loginSuccessText(cred, undefined)).toContain('Хранилище: общее хранилище харнесса.')
  })

  it('status names the scope', () => {
    expect(statusSuccessText(cred, 'exo2'))
      .toContain('OpenAI Codex OAuth: выполнен вход.')
    expect(statusSuccessText(cred, undefined)).toContain('Хранилище: общее хранилище харнесса.')
  })

  it('logout names the scope', () => {
    expect(logoutSuccessText('exo2')).toBe(
      'Учётные данные OpenAI Codex OAuth удалены. Хранилище: личное хранилище (exo2).',
    )
    expect(logoutSuccessText(undefined)).toBe(
      'Учётные данные OpenAI Codex OAuth удалены. Хранилище: общее хранилище харнесса.',
    )
  })
})

describe('usageCommandHint', () => {
  it('reads the refresh argument case-insensitively', () => {
    expect(usageCommandHint('')).toBe('cache')
    expect(usageCommandHint('   ')).toBe('cache')
    expect(usageCommandHint('refresh')).toBe('refresh')
    expect(usageCommandHint(' Refresh ')).toBe('refresh')
    expect(usageCommandHint('anything else')).toBe('error')
  })
})
