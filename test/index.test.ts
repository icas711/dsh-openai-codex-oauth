import { describe, expect, it } from 'vitest'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import {
  answerValue,
  expiryDescription,
  parseOAuthCredential,
  requestedMethod,
  safeInteractionError,
  safeLoginError,
} from '../src/index.js'

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
