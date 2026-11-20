import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { LlmError } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
export const name = 'openai-codex-oauth';
export const inject = ['commands', 'credentials', 'userQuestions'];
const PROVIDER = 'openai-codex';
const DEFAULT_OAUTH_CREDENTIAL_REF = 'OPENAI_CODEX_OAUTH_CREDENTIAL';
const DEFAULT_ACCESS_TOKEN_REF = 'OPENAI_CODEX_ACCESS_TOKEN';
const DEFAULT_REFRESH_BEFORE_MS = 5 * 60 * 1000;
const WAIT_FOR_CALLBACK_LABEL = 'Жду автоматического возврата из браузера';
export const Config = z.object({
    oauthCredentialRef: z.string().role('credential-ref').default(DEFAULT_OAUTH_CREDENTIAL_REF),
    refreshBeforeMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_REFRESH_BEFORE_MS),
});
/** Read an optional service without declaring it in the ambient Context. */
function serviceOf(ctx, key) {
    return ctx.get(key);
}
/** Exported for unit tests. */
export async function resolveOwnerDiag(views, sessionId) {
    const diag = {
        sessionId,
        registryServicePresent: views.credentialScopes !== undefined,
        persistenceServicePresent: views.sessionPersistence !== undefined,
        registryHit: false,
        inspectOk: false,
        inspectError: undefined,
        owner: undefined,
    };
    if (sessionId === undefined)
        return diag;
    const registered = views.credentialScopes?.ownerOf(sessionId);
    if (registered !== undefined) {
        diag.registryHit = true;
        diag.owner = registered;
        return diag;
    }
    const persistence = views.sessionPersistence;
    if (persistence === undefined)
        return diag;
    try {
        const { meta } = await persistence.inspect(sessionId);
        diag.inspectOk = true;
        diag.owner = typeof meta.owner === 'string' && meta.owner.length > 0 ? meta.owner : undefined;
    }
    catch (error) {
        diag.inspectError = error instanceof Error ? error.message : String(error);
    }
    return diag;
}
/** Exported for unit tests. */
export async function resolveOwnerFrom(views, sessionId) {
    return (await resolveOwnerDiag(views, sessionId)).owner;
}
function resolveOwner(ctx, sessionId) {
    return resolveOwnerFrom({
        credentialScopes: serviceOf(ctx, 'credentialScopes'),
        sessionPersistence: serviceOf(ctx, 'sessionPersistence'),
    }, sessionId);
}
function resolveOwnerDiagOf(ctx, sessionId) {
    return resolveOwnerDiag({
        credentialScopes: serviceOf(ctx, 'credentialScopes'),
        sessionPersistence: serviceOf(ctx, 'sessionPersistence'),
    }, sessionId);
}
/** Exported for unit tests. */
export function scopeLabel(owner) {
    return owner === undefined ? 'общее хранилище харнесса' : `личное хранилище (${owner})`;
}
/** Exported for unit tests. */
export function personalStoreView(personal, owner) {
    return {
        scopeLabel: scopeLabel(owner),
        resolve: ref => personal.resolve(ref, owner),
        describe: ref => personal.describe(ref, owner),
        set: (ref, value) => personal.set(ref, value, owner),
        unset: ref => personal.unset(ref, owner),
    };
}
function deploymentStore(ctx) {
    const credentials = ctx.credentials;
    return {
        scopeLabel: scopeLabel(undefined),
        resolve: ref => credentials.resolve(ref),
        describe: ref => credentials.describe(ref),
        set: (ref, value) => credentials.set(ref, value),
        unset: ref => credentials.unset(ref),
    };
}
function storeFor(ctx, owner) {
    if (owner !== undefined) {
        const personal = serviceOf(ctx, 'userCredentials');
        // A session with an owner but without the per-user plane is practically
        // impossible (both mount in the same web bundle); the deployment store is
        // the loud, conservative fallback.
        if (personal !== undefined)
            return personalStoreView(personal, owner);
    }
    return deploymentStore(ctx);
}
function oauthAuth() {
    const oauth = openaiCodexProvider().auth.oauth;
    if (oauth === undefined) {
        throw new Error('Провайдер openai-codex не предоставляет OAuth в установленной версии pi-ai');
    }
    return oauth;
}
/** Exported for unit tests. */
export function parseOAuthCredential(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('Хранимые учётные данные OpenAI OAuth — не корректный JSON');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Хранимые учётные данные OpenAI OAuth имеют неверную структуру');
    }
    const candidate = value;
    if (candidate.type !== 'oauth'
        || typeof candidate.access !== 'string' || candidate.access.length === 0
        || typeof candidate.refresh !== 'string' || candidate.refresh.length === 0
        || typeof candidate.expires !== 'number' || !Number.isFinite(candidate.expires)) {
        throw new Error('В учётных данных OpenAI OAuth отсутствуют обязательные поля');
    }
    return value;
}
/** Exported for unit tests. */
export function answerValue(answer, id) {
    const item = answer.answers.find(entry => entry.id === id);
    const custom = item?.custom?.trim();
    if (custom !== undefined && custom.length > 0)
        return custom;
    const selected = item?.selected[0];
    if (selected !== undefined && selected.length > 0)
        return selected;
    throw new Error('Для продолжения входа OAuth нужен ответ на вопрос');
}
function combinedSignal(first, second) {
    return second === undefined ? first : AbortSignal.any([first, second]);
}
function promptDetail(prompt, authorizationUrl) {
    const parts = [];
    if (authorizationUrl !== undefined) {
        parts.push(`[Открыть страницу входа OpenAI](${authorizationUrl})`);
        parts.push('После входа это окно закроется автоматически. Если браузер не вернулся сам, скопируйте полный адрес из адресной строки и вставьте его в поле ниже.');
    }
    return parts.length === 0 ? undefined : parts.join('\n\n');
}
function localizedSelectOption(option) {
    if (option.id === 'browser') {
        return { label: 'Через браузер', description: 'Пройдите авторизацию OpenAI в браузере на этой машине.' };
    }
    if (option.id === 'device_code') {
        return { label: 'Код устройства', description: 'Для удалённых серверов и окружений без графики.' };
    }
    return {
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
    };
}
function promptQuestion(prompt) {
    if (prompt.type === 'select')
        return 'Выберите способ входа OpenAI';
    if (prompt.type === 'manual_code')
        return 'Завершите вход OpenAI в браузере';
    return prompt.message;
}
function waitForCallback(signal) {
    if (signal.aborted)
        return Promise.reject(new Error('браузерный колбэк завершён'));
    return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('браузерный колбэк завершён')); }, { once: true });
    });
}
async function answerAuthPrompt(ctx, invocation, prompt, forcedMethod, authorizationUrl) {
    if (prompt.type === 'select' && forcedMethod !== undefined)
        return forcedMethod;
    const id = `codex-oauth-${prompt.type}`;
    const options = prompt.type === 'select'
        ? prompt.options.map(localizedSelectOption)
        : prompt.type === 'manual_code'
            ? [{
                    label: WAIT_FOR_CALLBACK_LABEL,
                    description: 'Окно закроется автоматически после успешного OAuth-колбэка.',
                }]
            : undefined;
    const detail = promptDetail(prompt, authorizationUrl);
    const signal = combinedSignal(invocation.signal, prompt.signal);
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
    });
    const value = answerValue(answer, id);
    if (prompt.type === 'manual_code' && value === WAIT_FOR_CALLBACK_LABEL) {
        return waitForCallback(signal);
    }
    if (prompt.type !== 'select')
        return value;
    const selected = prompt.options.find(option => localizedSelectOption(option).label === value);
    if (selected !== undefined)
        return selected.id;
    const custom = prompt.options.find(option => option.id === value);
    if (custom !== undefined)
        return custom.id;
    throw new Error('Способ входа OAuth не распознан');
}
function beginDeviceNotice(ctx, invocation, event) {
    const controller = new AbortController();
    const signal = AbortSignal.any([invocation.signal, controller.signal]);
    const expiry = event.expiresInSeconds === undefined
        ? ''
        : `\n\nКод действителен ${event.expiresInSeconds} с.`;
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
    }).then(() => undefined, (error) => {
        if (!signal.aborted) {
            ctx.logger.warn(`openai-codex-oauth: device-code notice failed: ${safeInteractionError(error)}`);
        }
    });
    return { controller, settled };
}
/** Exported for unit tests. */
export function safeInteractionError(error) {
    if (!(error instanceof Error))
        return 'неизвестная ошибка взаимодействия';
    if (/cancel|abort/iu.test(error.message))
        return 'вход отменён';
    if (/no user-questions provider/iu.test(error.message))
        return 'текущая поверхность харнесса не может показать вопросы входа';
    return 'не удалось выполнить интерактивный вход';
}
/** Exported for unit tests. */
export function safeLoginError(error) {
    if (!(error instanceof Error))
        return 'Не удалось выполнить вход OpenAI OAuth.';
    const message = error.message;
    if (/cancel|abort/iu.test(message))
        return 'Вход OpenAI OAuth отменён.';
    if (/device code login is not enabled/iu.test(message))
        return 'OpenAI не включил вход по коду устройства — используйте вход через браузер.';
    const status = /status\s+(\d{3})/iu.exec(message)?.[1];
    if (status !== undefined)
        return `Запрос OpenAI OAuth не удался, HTTP-статус ${status}.`;
    if (/state mismatch/iu.test(message))
        return 'Параметр state в колбэке OpenAI OAuth не совпадает — повторите вход.';
    if (/Missing authorization code/iu.test(message))
        return 'В колбэке OpenAI OAuth нет кода авторизации — повторите вход.';
    if (/credential/iu.test(message))
        return 'Операция с хранилищем учётных данных харнесса не удалась — проверьте, что источник доступен для записи.';
    return 'Не удалось выполнить вход OpenAI OAuth — запустите /codex-login ещё раз.';
}
/** Exported for unit tests. */
export function requestedMethod(rawInput) {
    const value = rawInput.trim().toLowerCase();
    if (value.length === 0)
        return undefined;
    if (value === 'browser')
        return 'browser';
    if (value === 'device' || value === 'device-code' || value === 'device_code')
        return 'device_code';
    throw new Error('Использование: /codex-login [browser|device]');
}
/** Exported for unit tests. */
export function expiryDescription(credential) {
    const remainingMinutes = Math.max(0, Math.ceil((credential.expires - Date.now()) / 60_000));
    return `${new Date(credential.expires).toISOString()} (примерно через ${remainingMinutes} мин)`;
}
/** Exported for unit tests. */
export function loginSuccessText(credential, owner) {
    return `Вход OpenAI Codex OAuth выполнен. Access-токен истекает: ${expiryDescription(credential)}. Хранилище: ${scopeLabel(owner)}.`;
}
/** Exported for unit tests. */
export function statusSuccessText(credential, owner) {
    return `OpenAI Codex OAuth: выполнен вход. Access-токен истекает: ${expiryDescription(credential)}. Хранилище: ${scopeLabel(owner)}.`;
}
/** Exported for unit tests. */
export function logoutSuccessText(owner) {
    return `Учётные данные OpenAI Codex OAuth удалены. Хранилище: ${scopeLabel(owner)}.`;
}
async function assertWritable(store, ref) {
    const info = await store.describe(ref);
    if (!info.writable) {
        throw new Error(`Ссылка на учётные данные ${ref} поступает из источника «только чтение» (${info.source ?? 'неизвестно'})`);
    }
}
function createExclusiveRunner() {
    let tail = Promise.resolve();
    return async (operation) => {
        const run = tail.then(operation, operation);
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}
function resolveConfig(config) {
    return {
        oauthCredentialRef: credentialRef(config.oauthCredentialRef ?? DEFAULT_OAUTH_CREDENTIAL_REF),
        accessTokenRef: credentialRef(DEFAULT_ACCESS_TOKEN_REF),
        refreshBeforeMs: config.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS,
    };
}
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    const oauth = oauthAuth();
    const exclusive = createExclusiveRunner();
    let loginInProgress = false;
    const persist = async (store, credential) => {
        await store.set(resolved.oauthCredentialRef, JSON.stringify(credential));
        await store.set(resolved.accessTokenRef, credential.access);
    };
    const ensureAccessToken = (owner, signal, diag) => exclusive(async () => {
        if (signal.aborted) {
            throw new LlmError('Запрос к OpenAI Codex прерван до завершения аутентификации.', 'ABORTED');
        }
        ctx.logger.info(`openai-codex-oauth: ensureAccessToken diag ${JSON.stringify(diag)}`);
        const store = storeFor(ctx, owner);
        const stored = await store.resolve(resolved.oauthCredentialRef);
        if (stored === undefined) {
            // An externally managed access token (launch environment on the
            // deployment side, a hand-stored token on the web Models page for a
            // personal scope) is trusted as-is: its source layer is not the
            // plugin-writable file store.
            const access = await store.resolve(resolved.accessTokenRef);
            if (access !== undefined && access.value.length > 0 && access.source !== 'file')
                return;
            throw new LlmError('Вход OpenAI Codex OAuth не настроен. Выполните /codex-login и повторите запрос.', 'AUTH');
        }
        let credential;
        try {
            credential = parseOAuthCredential(stored.value);
        }
        catch (error) {
            throw new LlmError('Хранимые учётные данные OpenAI Codex OAuth недействительны. Выполните /codex-login заново.', 'AUTH', { cause: error });
        }
        if (credential.expires > Date.now() + resolved.refreshBeforeMs) {
            const access = await store.resolve(resolved.accessTokenRef);
            if (access === undefined || access.value !== credential.access) {
                await store.set(resolved.accessTokenRef, credential.access);
            }
            return;
        }
        let refreshed;
        try {
            refreshed = await oauth.refresh(credential, signal);
        }
        catch {
            throw new LlmError('Не удалось обновить учётные данные OpenAI Codex OAuth. Выполните /codex-login заново.', 'AUTH');
        }
        await persist(store, refreshed);
    });
    const login = async (invocation) => {
        if (loginInProgress)
            return { kind: 'error', text: 'Вход OpenAI OAuth уже выполняется.' };
        loginInProgress = true;
        const notices = [];
        let authorizationUrl;
        try {
            const method = requestedMethod(invocation.rawInput);
            const owner = await resolveOwner(ctx, String(invocation.agent.id));
            const store = storeFor(ctx, owner);
            await assertWritable(store, resolved.oauthCredentialRef);
            await assertWritable(store, resolved.accessTokenRef);
            const interaction = {
                signal: invocation.signal,
                prompt: prompt => answerAuthPrompt(ctx, invocation, prompt, method, authorizationUrl),
                notify: event => {
                    if (event.type === 'auth_url')
                        authorizationUrl = event.url;
                    if (event.type === 'device_code')
                        notices.push(beginDeviceNotice(ctx, invocation, event));
                    if (event.type === 'info' || event.type === 'progress') {
                        ctx.logger.info(`openai-codex-oauth: ${event.message}`);
                    }
                },
            };
            const credential = await oauth.login(interaction);
            await exclusive(() => persist(store, credential));
            return { kind: 'success', text: loginSuccessText(credential, owner) };
        }
        catch (error) {
            return { kind: 'error', text: safeLoginError(error) };
        }
        finally {
            loginInProgress = false;
            for (const notice of notices)
                notice.controller.abort('Вход OAuth завершён');
            await Promise.allSettled(notices.map(notice => notice.settled));
        }
    };
    const logout = async (invocation) => {
        if (invocation.rawInput.trim().length > 0)
            return { kind: 'error', text: 'Использование: /codex-logout' };
        try {
            const owner = await resolveOwner(ctx, String(invocation.agent.id));
            const store = storeFor(ctx, owner);
            await exclusive(async () => {
                await store.unset(resolved.oauthCredentialRef);
                await store.unset(resolved.accessTokenRef);
            });
            return { kind: 'success', text: logoutSuccessText(owner) };
        }
        catch (error) {
            return { kind: 'error', text: safeLoginError(error) };
        }
    };
    const status = async (invocation) => {
        if (invocation.rawInput.trim().length > 0)
            return { kind: 'error', text: 'Использование: /codex-status' };
        const owner = await resolveOwner(ctx, String(invocation.agent.id));
        const store = storeFor(ctx, owner);
        const stored = await store.resolve(resolved.oauthCredentialRef);
        if (stored !== undefined) {
            try {
                const credential = parseOAuthCredential(stored.value);
                return { kind: 'success', text: statusSuccessText(credential, owner) };
            }
            catch {
                return { kind: 'error', text: 'Учётные данные OpenAI Codex OAuth повреждены — запустите /codex-login ещё раз.' };
            }
        }
        const access = await store.resolve(resolved.accessTokenRef);
        if (access !== undefined && access.value.length > 0) {
            return {
                kind: 'success',
                text: `OpenAI Codex: access-токен задан. Хранилище: ${scopeLabel(owner)}.`,
            };
        }
        return { kind: 'success', text: 'OpenAI Codex: вход не настроен. Запустите /codex-login.' };
    };
    ctx.commands.register({
        name: 'codex-login',
        description: 'Войти в OpenAI Codex через подписку ChatGPT Plus/Pro',
        input: { hint: '[browser|device]' },
        handler: login,
    });
    ctx.commands.register({
        name: 'codex-logout',
        description: 'Удалить учётные данные OpenAI Codex OAuth',
        handler: logout,
    });
    ctx.commands.register({
        name: 'codex-status',
        description: 'Показать состояние OpenAI Codex OAuth',
        handler: status,
    });
    ctx.on('agent/request', async ({ agent, signal }, next) => {
        const request = await next();
        if (request.provider === PROVIDER) {
            const sessionId = agent === undefined ? undefined : String(agent.id);
            const diag = await resolveOwnerDiagOf(ctx, sessionId);
            ctx.logger.info(`openai-codex-oauth: agent/request provider=${request.provider} model=${request.model} agentId=${sessionId ?? 'none'} diag=${JSON.stringify(diag)}`);
            await ensureAccessToken(diag.owner, signal, diag);
        }
        if (signal.aborted) {
            throw new LlmError('Запрос к OpenAI Codex прерван до завершения аутентификации.', 'ABORTED');
        }
        return request;
    });
}
//# sourceMappingURL=index.js.map