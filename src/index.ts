import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type { AuthEvent, AuthInteraction, AuthPrompt, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-questions'

export const name = 'openai-codex-oauth'
export const inject = ['commands', 'credentials', 'userQuestions']

const PROVIDER = 'openai-codex'
const DEFAULT_OAUTH_CREDENTIAL_REF = 'OPENAI_CODEX_OAUTH_CREDENTIAL'
const DEFAULT_ACCESS_TOKEN_REF = 'OPENAI_CODEX_ACCESS_TOKEN'
const DEFAULT_REFRESH_BEFORE_MS = 5 * 60 * 1000
const WAIT_FOR_CALLBACK_LABEL = 'Жду автоматического возврата из браузера'

export interface Config {
  /** Harness credential reference containing the complete pi-ai OAuth credential as JSON. */
  oauthCredentialRef?: string
  /** Refresh an expiring credential this many milliseconds before its expiry time. */
  refreshBeforeMs?: number
}

export const Config: z<Config> = z.object({
  oauthCredentialRef: z.string().role('credential-ref').default(DEFAULT_OAUTH_CREDENTIAL_REF),
  refreshBeforeMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REFRESH_BEFORE_MS),
})

interface ResolvedConfig {
  oauthCredentialRef: CredentialRef
  accessTokenRef: CredentialRef
  refreshBeforeMs: number
}

interface DeviceNotice {
  controller: AbortController
  settled: Promise<void>
}

function oauthAuth(): OAuthAuth {
  const oauth = openaiCodexProvider().auth.oauth
  if (oauth === undefined) {
    throw new Error('Провайдер openai-codex не предоставляет OAuth в установленной версии pi-ai')
  }
  return oauth
}

/** Exported for unit tests. */
export function parseOAuthCredential(raw: string): OAuthCredential {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Хранимые учётные данные OpenAI OAuth — не корректный JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Хранимые учётные данные OpenAI OAuth имеют неверную структуру')
  }
  const candidate = value as Partial<OAuthCredential>
  if (candidate.type !== 'oauth'
    || typeof candidate.access !== 'string' || candidate.access.length === 0
    || typeof candidate.refresh !== 'string' || candidate.refresh.length === 0
    || typeof candidate.expires !== 'number' || !Number.isFinite(candidate.expires)) {
    throw new Error('В учётных данных OpenAI OAuth отсутствуют обязательные поля')
  }
  return value as OAuthCredential
}

/** Exported for unit tests. */
export function answerValue(answer: Awaited<ReturnType<Context['userQuestions']['ask']>>, id: string): string {
  const item = answer.answers.find(entry => entry.id === id)
  const custom = item?.custom?.trim()
  if (custom !== undefined && custom.length > 0) return custom
  const selected = item?.selected[0]
  if (selected !== undefined && selected.length > 0) return selected
  throw new Error('Для продолжения входа OAuth нужен ответ на вопрос')
}

function combinedSignal(first: AbortSignal, second: AbortSignal | undefined): AbortSignal {
  return second === undefined ? first : AbortSignal.any([first, second])
}

function promptDetail(prompt: AuthPrompt, authorizationUrl: string | undefined): string | undefined {
  const parts: string[] = []
  if (authorizationUrl !== undefined) {
    parts.push(`[Открыть страницу входа OpenAI](${authorizationUrl})`)
    parts.push('После входа это окно закроется автоматически. Если браузер не вернулся сам, скопируйте полный адрес из адресной строки и вставьте его в поле ниже.')
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function localizedSelectOption(option: { id: string; label: string; description?: string }): {
  label: string
  description?: string
} {
  if (option.id === 'browser') {
    return { label: 'Через браузер', description: 'Пройдите авторизацию OpenAI в браузере на этой машине.' }
  }
  if (option.id === 'device_code') {
    return { label: 'Код устройства', description: 'Для удалённых серверов и окружений без графики.' }
  }
  return {
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }
}

function promptQuestion(prompt: AuthPrompt): string {
  if (prompt.type === 'select') return 'Выберите способ входа OpenAI'
  if (prompt.type === 'manual_code') return 'Завершите вход OpenAI в браузере'
  return prompt.message
}

function waitForCallback(signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error('браузерный колбэк завершён'))
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('браузерный колбэк завершён')) }, { once: true })
  })
}

async function answerAuthPrompt(
  ctx: Context,
  invocation: CommandInvocation,
  prompt: AuthPrompt,
  forcedMethod: string | undefined,
  authorizationUrl: string | undefined,
): Promise<string> {
  if (prompt.type === 'select' && forcedMethod !== undefined) return forcedMethod

  const id = `codex-oauth-${prompt.type}`
  const options = prompt.type === 'select'
    ? prompt.options.map(localizedSelectOption)
    : prompt.type === 'manual_code'
      ? [{
          label: WAIT_FOR_CALLBACK_LABEL,
          description: 'Окно закроется автоматически после успешного OAuth-колбэка.',
        }]
      : undefined
  const detail = promptDetail(prompt, authorizationUrl)
  const signal = combinedSignal(invocation.signal, prompt.signal)
  const answer = await ctx.userQuestions.ask({
    agent: invocation.agent,
    signal,
    questions: [{
      id,
      header: 'Вход OpenAI',
      question: promptQuestion(prompt),
      ...detail === undefined ? {} : { detail },
      ...options === undefined ? {} : { options },
    }],
  })
  const value = answerValue(answer, id)
  if (prompt.type === 'manual_code' && value === WAIT_FOR_CALLBACK_LABEL) {
    return waitForCallback(signal)
  }
  if (prompt.type !== 'select') return value
  const selected = prompt.options.find(option => localizedSelectOption(option).label === value)
  if (selected !== undefined) return selected.id
  const custom = prompt.options.find(option => option.id === value)
  if (custom !== undefined) return custom.id
  throw new Error('Способ входа OAuth не распознан')
}

function beginDeviceNotice(ctx: Context, invocation: CommandInvocation, event: Extract<AuthEvent, { type: 'device_code' }>): DeviceNotice {
  const controller = new AbortController()
  const signal = AbortSignal.any([invocation.signal, controller.signal])
  const expiry = event.expiresInSeconds === undefined
    ? ''
    : `\n\nКод действителен ${event.expiresInSeconds} с.`
  const settled = ctx.userQuestions.ask({
    agent: invocation.agent,
    signal,
    questions: [{
      id: 'codex-device-code',
      header: 'Вход по коду устройства',
      question: 'Введите код на странице OpenAI и дождитесь завершения входа.',
      detail: `[Открыть страницу входа по коду устройства](${event.verificationUri})\n\nКод устройства:\`${event.userCode}\`${expiry}`,
      options: [{ label: 'Код введён', description: 'Харнесс продолжит опрашивать статус входа.' }],
    }],
  }).then(() => undefined, (error: unknown) => {
    if (!signal.aborted) {
      ctx.logger.warn(`openai-codex-oauth: device-code notice failed: ${safeInteractionError(error)}`)
    }
  })
  return { controller, settled }
}

/** Exported for unit tests. */
export function safeInteractionError(error: unknown): string {
  if (!(error instanceof Error)) return 'неизвестная ошибка взаимодействия'
  if (/cancel|abort/iu.test(error.message)) return 'вход отменён'
  if (/no user-questions provider/iu.test(error.message)) return 'текущая поверхность харнесса не может показать вопросы входа'
  return 'не удалось выполнить интерактивный вход'
}

/** Exported for unit tests. */
export function safeLoginError(error: unknown): string {
  if (!(error instanceof Error)) return 'Не удалось выполнить вход OpenAI OAuth.'
  const message = error.message
  if (/cancel|abort/iu.test(message)) return 'Вход OpenAI OAuth отменён.'
  if (/device code login is not enabled/iu.test(message)) return 'OpenAI не включил вход по коду устройства — используйте вход через браузер.'
  const status = /status\s+(\d{3})/iu.exec(message)?.[1]
  if (status !== undefined) return `Запрос OpenAI OAuth не удался, HTTP-статус ${status}.`
  if (/state mismatch/iu.test(message)) return 'Параметр state в колбэке OpenAI OAuth не совпадает — повторите вход.'
  if (/Missing authorization code/iu.test(message)) return 'В колбэке OpenAI OAuth нет кода авторизации — повторите вход.'
  if (/credential/iu.test(message)) return 'Операция с хранилищем учётных данных харнесса не удалась — проверьте, что источник доступен для записи.'
  return 'Не удалось выполнить вход OpenAI OAuth — запустите /codex-login ещё раз.'
}

/** Exported for unit tests. */
export function requestedMethod(rawInput: string): string | undefined {
  const value = rawInput.trim().toLowerCase()
  if (value.length === 0) return undefined
  if (value === 'browser') return 'browser'
  if (value === 'device' || value === 'device-code' || value === 'device_code') return 'device_code'
  throw new Error('Использование: /codex-login [browser|device]')
}

/** Exported for unit tests. */
export function expiryDescription(credential: OAuthCredential): string {
  const remainingMinutes = Math.max(0, Math.ceil((credential.expires - Date.now()) / 60_000))
  return `${new Date(credential.expires).toISOString()} (примерно через ${remainingMinutes} мин)`
}

async function assertWritable(ctx: Context, ref: CredentialRef): Promise<void> {
  const info = await ctx.credentials.describe(ref)
  if (!info.writable) {
    throw new Error(`Ссылка на учётные данные ${ref} поступает из источника «только чтение» (${info.source ?? 'неизвестно'})`)
  }
}

function createExclusiveRunner(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve()
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = tail.then(operation, operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    oauthCredentialRef: credentialRef(config.oauthCredentialRef ?? DEFAULT_OAUTH_CREDENTIAL_REF),
    accessTokenRef: credentialRef(DEFAULT_ACCESS_TOKEN_REF),
    refreshBeforeMs: config.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS,
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const oauth = oauthAuth()
  const exclusive = createExclusiveRunner()
  let loginInProgress = false

  const persist = async (credential: OAuthCredential): Promise<void> => {
    await ctx.credentials.set(resolved.oauthCredentialRef, JSON.stringify(credential))
    await ctx.credentials.set(resolved.accessTokenRef, credential.access)
  }

  const ensureAccessToken = (signal: AbortSignal): Promise<void> => exclusive(async () => {
    if (signal.aborted) {
      throw new LlmError('Запрос к OpenAI Codex прерван до завершения аутентификации.', 'ABORTED')
    }
    const access = await ctx.credentials.resolve(resolved.accessTokenRef)
    if (access !== undefined && access.value.length > 0 && access.source !== 'file') return

    const stored = await ctx.credentials.resolve(resolved.oauthCredentialRef)
    if (stored === undefined) {
      if (access !== undefined && access.value.length > 0) return
      throw new LlmError(
        'Вход OpenAI Codex OAuth не настроен. Выполните /codex-login и повторите запрос.',
        'AUTH',
      )
    }

    let credential: OAuthCredential
    try {
      credential = parseOAuthCredential(stored.value)
    } catch (error: unknown) {
      throw new LlmError(
        'Хранимые учётные данные OpenAI Codex OAuth недействительны. Выполните /codex-login заново.',
        'AUTH',
        { cause: error },
      )
    }

    if (credential.expires > Date.now() + resolved.refreshBeforeMs) {
      if (access === undefined || access.value !== credential.access) {
        await ctx.credentials.set(resolved.accessTokenRef, credential.access)
      }
      return
    }

    let refreshed: OAuthCredential
    try {
      refreshed = await oauth.refresh(credential, signal)
    } catch {
      throw new LlmError(
        'Не удалось обновить учётные данные OpenAI Codex OAuth. Выполните /codex-login заново.',
        'AUTH',
      )
    }
    await persist(refreshed)
  })

  const login = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (loginInProgress) return { kind: 'error', text: 'Вход OpenAI OAuth уже выполняется.' }
    loginInProgress = true
    const notices: DeviceNotice[] = []
    let authorizationUrl: string | undefined
    try {
      const method = requestedMethod(invocation.rawInput)
      await assertWritable(ctx, resolved.oauthCredentialRef)
      await assertWritable(ctx, resolved.accessTokenRef)
      const interaction: AuthInteraction = {
        signal: invocation.signal,
        prompt: prompt => answerAuthPrompt(ctx, invocation, prompt, method, authorizationUrl),
        notify: event => {
          if (event.type === 'auth_url') authorizationUrl = event.url
          if (event.type === 'device_code') notices.push(beginDeviceNotice(ctx, invocation, event))
          if (event.type === 'info' || event.type === 'progress') {
            ctx.logger.info(`openai-codex-oauth: ${event.message}`)
          }
        },
      }
      const credential = await oauth.login(interaction)
      await exclusive(() => persist(credential))
      return {
        kind: 'success',
        text: `Вход OpenAI Codex OAuth выполнен. Access-токен истекает: ${expiryDescription(credential)}.`,
      }
    } catch (error: unknown) {
      return { kind: 'error', text: safeLoginError(error) }
    } finally {
      loginInProgress = false
      for (const notice of notices) notice.controller.abort('Вход OAuth завершён')
      await Promise.allSettled(notices.map(notice => notice.settled))
    }
  }

  const logout = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: 'Использование: /codex-logout' }
    try {
      await exclusive(async () => {
        await ctx.credentials.unset(resolved.oauthCredentialRef)
        await ctx.credentials.unset(resolved.accessTokenRef)
      })
      return { kind: 'success', text: 'Учётные данные OpenAI Codex OAuth удалены.' }
    } catch (error: unknown) {
      return { kind: 'error', text: safeLoginError(error) }
    }
  }

  const status = async (invocation: CommandInvocation): Promise<CommandResult> => {
    if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: 'Использование: /codex-status' }
    const stored = await ctx.credentials.resolve(resolved.oauthCredentialRef)
    if (stored !== undefined) {
      try {
        const credential = parseOAuthCredential(stored.value)
        return {
          kind: 'success',
          text: `OpenAI Codex OAuth: выполнен вход. Access-токен истекает: ${expiryDescription(credential)}. Источник учётных данных: ${stored.source}.`,
        }
      } catch {
        return { kind: 'error', text: 'Учётные данные OpenAI Codex OAuth повреждены — запустите /codex-login ещё раз.' }
      }
    }
    const access = await ctx.credentials.resolve(resolved.accessTokenRef)
    if (access !== undefined && access.value.length > 0) {
      return { kind: 'success', text: `OpenAI Codex: access-токен задан. Источник учётных данных: ${access.source}.` }
    }
    return { kind: 'success', text: 'OpenAI Codex: вход не настроен. Запустите /codex-login.' }
  }

  ctx.commands.register({
    name: 'codex-login',
    description: 'Войти в OpenAI Codex через подписку ChatGPT Plus/Pro',
    input: { hint: '[browser|device]' },
    handler: login,
  })
  ctx.commands.register({
    name: 'codex-logout',
    description: 'Удалить учётные данные OpenAI Codex OAuth',
    handler: logout,
  })
  ctx.commands.register({
    name: 'codex-status',
    description: 'Показать состояние OpenAI Codex OAuth',
    handler: status,
  })

  ctx.on('agent/request', async ({ signal }, next) => {
    const request = await next()
    if (request.provider === PROVIDER) await ensureAccessToken(signal)
    if (signal.aborted) {
      throw new LlmError('Запрос к OpenAI Codex прерван до завершения аутентификации.', 'ABORTED')
    }
    return request
  })
}
