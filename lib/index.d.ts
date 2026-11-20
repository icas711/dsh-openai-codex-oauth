import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "openai-codex-oauth";
export declare const inject: string[];
export interface Config {
    /** Harness credential reference containing the complete pi-ai OAuth credential as JSON. */
    oauthCredentialRef?: string;
    /** Refresh an expiring credential this many milliseconds before its expiry time. */
    refreshBeforeMs?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map