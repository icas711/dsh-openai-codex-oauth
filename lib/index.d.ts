import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { OAuthCredential } from '@earendil-works/pi-ai';
export declare const name = "openai-codex-oauth";
export declare const inject: string[];
export interface Config {
    /** Harness credential reference containing the complete pi-ai OAuth credential as JSON. */
    oauthCredentialRef?: string;
    /** Refresh an expiring credential this many milliseconds before its expiry time. */
    refreshBeforeMs?: number;
}
export declare const Config: z<Config>;
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
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map