/**
 * Инструмент `generate_image` (фаза 4 плагина): генерация изображений GPT Image
 * через подписку ChatGPT/Codex. Результат сохраняется в долговременное
 * хранилище вложений харнесса (`ctx.attachments.saveImage`) и отображается
 * штатной карточкой инструмента — клиентских доработок не требуется.
 * @module dsh-openai-codex-oauth/image-tool
 */
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { buildUserTextInput, type CodexCallCredential } from './codex-api.ts';
/** Модель генерации по умолчанию (есть в каталоге pi-ai 0.82.1). */
export declare const DEFAULT_IMAGE_MODEL = "gpt-5.6-sol";
/** Допустимые размеры изображения. */
export declare const IMAGE_SIZES: readonly ["1024x1024", "1536x1024", "1024x1536"];
/** Допустимые уровни качества. */
export declare const IMAGE_QUALITIES: readonly ["low", "medium", "high"];
/** Допустимые режимы фона. */
export declare const IMAGE_BACKGROUNDS: readonly ["auto", "opaque"];
export type ImageSize = typeof IMAGE_SIZES[number];
export type ImageQuality = typeof IMAGE_QUALITIES[number];
export type ImageBackground = typeof IMAGE_BACKGROUNDS[number];
/** Проверенные аргументы инструмента. */
export interface CodexImageArgs {
    readonly prompt: string;
    readonly size?: ImageSize;
    readonly quality?: ImageQuality;
    readonly background?: ImageBackground;
}
/** Результат генерации из событий Responses. */
export interface CodexImageResult {
    readonly data: string;
    readonly format: string;
    readonly revisedPrompt: string | undefined;
}
/** Зависимости инструмента от остального кода плагина. */
export interface CodexImageDeps {
    /** Модель генерации из конфига плагина. */
    readonly model: string;
    /** Адрес Responses-эндпоинта из конфига плагина. */
    readonly endpoint: string;
    /** Значение заголовка originator из конфига плагина. */
    readonly originator: string;
    /** Авторизация для запроса; sessionId — сессия, от которой идёт вызов. */
    resolveCredential(signal: AbortSignal, sessionId: string | undefined): Promise<CodexCallCredential>;
    /** Сохранение изображения в хранилище вложений харнесса. */
    saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>;
    /** Точка внедрения fetch для тестов. */
    readonly fetchImpl?: typeof globalThis.fetch;
}
/** Проверить аргументы вызова generate_image. Exported for unit tests. */
export declare function parseImageArgs(args: unknown): CodexImageArgs;
/** Тело запроса генерации изображения. Exported for unit tests. */
export declare function buildImageRequest(args: CodexImageArgs, model?: string): {
    model: string;
    input: ReturnType<typeof buildUserTextInput>;
    instructions: string;
    tools: Array<{
        type: 'image_generation';
        action: 'generate';
        size: string;
        quality: string;
        background: string;
    }>;
    tool_choice: {
        type: 'image_generation';
    };
    stream: boolean;
    store: boolean;
};
/** Найти первый завершённый вызов генерации в событиях Responses. Exported for unit tests. */
export declare function collectImage(events: readonly unknown[]): CodexImageResult | undefined;
/** Медиа-тип по формату из ответа бэкенда. Exported for unit tests. */
export declare function imageMediaTypeOf(format: string): ImageMediaType;
/** Собрать определение инструмента generate_image. */
export declare function defineCodexImageTool(deps: CodexImageDeps): ToolDefinition;
//# sourceMappingURL=image-tool.d.ts.map