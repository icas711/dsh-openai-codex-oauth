import type { Context } from '@deepseek-ai/cordis';
import { type CredentialInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import type { OAuthCredential } from '@earendil-works/pi-ai';
export declare const name = "openai-codex-oauth";
export declare const inject: string[];
export interface Config {
    /** Harness credential reference containing the complete pi-ai OAuth credential as JSON. */
    oauthCredentialRef?: string;
    /** Refresh an expiring credential this many milliseconds before its expiry time. */
    refreshBeforeMs?: number;
    /** Responses endpoint of the ChatGPT Codex backend used by search and image generation. */
    responsesUrl?: string;
    /** `wham/usage` endpoint serving subscription quotas. */
    usageUrl?: string;
    /** Quota cache lifetime for /codex-usage. */
    usageCacheMs?: number;
    /** Register the read-only codex_usage tool for the model. Off until the live response is confirmed stable. */
    usageTool?: boolean;
    /** Register the openai-codex web-search provider on ctx.web. */
    searchEnabled?: boolean;
    /** Model used for hosted web search. */
    searchModel?: string;
    /** Register the generate_image tool (requires tools + attachments services). */
    imageEnabled?: boolean;
    /** Model used for image generation. */
    imageModel?: string;
    /** Value of the originator header on direct Codex backend calls. */
    originator?: string;
}
export declare const Config: z<Config>;
/**
 * Session → owner registry of the web composition. Optional everywhere:
 * without the web bundle the plugin degrades to the deployment-wide store.
 */
interface OwnerRegistryView {
    ownerOf(sessionId: string): string | undefined;
}
/** Durable session metadata view; the persistence header names the owner. */
interface SessionPersistenceView {
    inspect(sessionId: string): Promise<{
        meta: {
            owner?: unknown;
        };
    }>;
}
/** Per-user credential store of the web composition (owner on every call). */
export interface PersonalCredentialsView {
    resolve(ref: CredentialRef, owner: string): Promise<ResolvedCredential | undefined>;
    describe(ref: CredentialRef, owner: string): Promise<CredentialInfo>;
    set(ref: CredentialRef, value: string, owner: string): Promise<void>;
    unset(ref: CredentialRef, owner: string): Promise<void>;
}
/**
 * Личные секции настроек веб-композиции (шов userSettings): карточки
 * провайдеров на странице «Модели» — секция llm-pi-ai, поле providers.<route>.
 * Face синхронный, реализация может быть асинхронной — вызовы идут через await.
 */
export interface PersonalSettingsView {
    sectionOf(ns: string, owner: string): Promise<object | undefined> | object | undefined;
    writeSection(ns: string, owner: string, section: object): Promise<void> | void;
}
/** Credential operations against one scope: the owner's store or the deployment store. */
export interface CredentialStore {
    readonly scopeLabel: string;
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
    describe(ref: CredentialRef): Promise<CredentialInfo>;
    set(ref: CredentialRef, value: string): Promise<void>;
    unset(ref: CredentialRef): Promise<void>;
}
export interface OwnerResolveDiag {
    sessionId: string | undefined;
    registryServicePresent: boolean;
    persistenceServicePresent: boolean;
    registryHit: boolean;
    inspectOk: boolean;
    inspectError: string | undefined;
    owner: string | undefined;
}
/** Exported for unit tests. */
export declare function resolveOwnerDiag(views: {
    credentialScopes?: OwnerRegistryView | undefined;
    sessionPersistence?: SessionPersistenceView | undefined;
}, sessionId: string | undefined): Promise<OwnerResolveDiag>;
/** Exported for unit tests. */
export declare function resolveOwnerFrom(views: {
    credentialScopes?: OwnerRegistryView | undefined;
    sessionPersistence?: SessionPersistenceView | undefined;
}, sessionId: string | undefined): Promise<string | undefined>;
/** Exported for unit tests. */
export declare function scopeLabel(owner: string | undefined): string;
/**
 * Секция llm-pi-ai с личным профилем маршрута openai-codex (карточка на
 * странице «Модели» и группа моделей в выборщике чата — без глобального
 * маршрута). Существующий профиль не перезаписывается: ручные настройки
 * (список моделей) переживают повторный вход. Профиль пуст — модели и
 * endpoint берёт каталог pi-ai, ключ — конвенциональная ссылка из стора.
 * Exported for unit tests.
 */
export declare function withCodexProviderProfile(section: object | undefined): object;
/**
 * Секция llm-pi-ai без личного профиля маршрута openai-codex; undefined, если
 * профиля и не было. Другие поля секции и другие провайдеры не трогаются.
 * Exported for unit tests.
 */
export declare function withoutCodexProviderProfile(section: object | undefined): object | undefined;
/** Exported for unit tests. */
export declare function personalStoreView(personal: PersonalCredentialsView, owner: string): CredentialStore;
/** Exported for unit tests. */
export declare function parseOAuthCredential(raw: string): OAuthCredential;
/** Exported for unit tests. */
export declare function answerValue(answer: Awaited<ReturnType<Context['userQuestions']['ask']>>, id: string): string;
/** Exported for unit tests. */
export declare function safeInteractionError(error: unknown): string;
/** Exported for unit tests. */
export declare function safeLoginError(error: unknown): string;
/** Exported for unit tests. */
export declare function requestedMethod(rawInput: string): string | undefined;
/** Exported for unit tests. */
export declare function expiryDescription(credential: OAuthCredential): string;
/** Exported for unit tests. */
export declare function loginSuccessText(credential: OAuthCredential, owner: string | undefined): string;
/** Exported for unit tests. */
export declare function statusSuccessText(credential: OAuthCredential, owner: string | undefined): string;
/** Exported for unit tests. */
export declare function logoutSuccessText(owner: string | undefined): string;
/** Exported for unit tests. */
export declare function usageCommandHint(rawInput: string): 'cache' | 'refresh' | 'error';
export declare function apply(ctx: Context, config: Config): void;
export {};
//# sourceMappingURL=index.d.ts.map