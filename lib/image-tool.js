/**
 * Инструмент `generate_image` (фаза 4 плагина): генерация изображений GPT Image
 * через подписку ChatGPT/Codex. Результат сохраняется в долговременное
 * хранилище вложений харнесса (`ctx.attachments.saveImage`) и отображается
 * штатной карточкой инструмента — клиентских доработок не требуется.
 * @module dsh-openai-codex-oauth/image-tool
 */
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { buildUserTextInput, collectOutputItems, requestCodexEvents, } from "./codex-api.js";
/** Модель генерации по умолчанию (есть в каталоге pi-ai 0.82.1). */
export const DEFAULT_IMAGE_MODEL = 'gpt-5.6-sol';
/** Допустимые размеры изображения. */
export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'];
/** Допустимые уровни качества. */
export const IMAGE_QUALITIES = ['low', 'medium', 'high'];
/** Допустимые режимы фона. */
export const IMAGE_BACKGROUNDS = ['auto', 'opaque'];
function isOneOf(values, value) {
    return typeof value === 'string' && values.includes(value);
}
/** Проверить аргументы вызова generate_image. Exported for unit tests. */
export function parseImageArgs(args) {
    if (args === null || typeof args !== 'object') {
        throw new Error('Аргументы generate_image должны быть объектом');
    }
    const record = args;
    if (typeof record.prompt !== 'string' || record.prompt.trim().length === 0) {
        throw new Error('prompt должен быть непустой строкой');
    }
    const size = record.size;
    if (size !== undefined && !isOneOf(IMAGE_SIZES, size)) {
        throw new Error(`size должен быть одним из: ${IMAGE_SIZES.join(', ')}`);
    }
    const quality = record.quality;
    if (quality !== undefined && !isOneOf(IMAGE_QUALITIES, quality)) {
        throw new Error(`quality должен быть одним из: ${IMAGE_QUALITIES.join(', ')}`);
    }
    const background = record.background;
    if (background !== undefined && !isOneOf(IMAGE_BACKGROUNDS, background)) {
        throw new Error(`background должен быть одним из: ${IMAGE_BACKGROUNDS.join(', ')}`);
    }
    return {
        prompt: record.prompt,
        ...(size !== undefined ? { size } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(background !== undefined ? { background } : {}),
    };
}
/** Тело запроса генерации изображения. Exported for unit tests. */
export function buildImageRequest(args, model = DEFAULT_IMAGE_MODEL) {
    return {
        model,
        input: buildUserTextInput(args.prompt),
        instructions: 'Generate the requested image and return the image result only.',
        tools: [{
                type: 'image_generation',
                action: 'generate',
                size: args.size ?? '1024x1024',
                quality: args.quality ?? 'medium',
                background: args.background ?? 'auto',
            }],
        tool_choice: { type: 'image_generation' },
        stream: true,
        store: false,
    };
}
/** Найти первый завершённый вызов генерации в событиях Responses. Exported for unit tests. */
export function collectImage(events) {
    for (const item of collectOutputItems(events)) {
        if (item === null || typeof item !== 'object')
            continue;
        const record = item;
        if (record.type !== 'image_generation_call')
            continue;
        if (typeof record.result !== 'string' || record.result.length === 0)
            continue;
        return {
            data: record.result,
            format: typeof record.output_format === 'string' && record.output_format.length > 0 ? record.output_format : 'png',
            revisedPrompt: typeof record.revised_prompt === 'string' && record.revised_prompt.length > 0 ? record.revised_prompt : undefined,
        };
    }
    return undefined;
}
/** Медиа-тип по формату из ответа бэкенда. Exported for unit tests. */
export function imageMediaTypeOf(format) {
    if (format === 'webp')
        return 'image/webp';
    if (format === 'jpeg' || format === 'jpg')
        return 'image/jpeg';
    return 'image/png';
}
function imageRefFromValue(value) {
    return {
        attachmentId: AttachmentId(value.attachmentId),
        mediaType: value.mediaType,
        bytes: value.bytes,
        width: value.width,
        height: value.height,
        ...(value.name === undefined ? {} : { name: value.name }),
    };
}
/** Собрать определение инструмента generate_image. */
export function defineCodexImageTool(deps) {
    return defineTool({
        name: 'generate_image',
        description: 'Generate an image with GPT Image through the signed-in ChatGPT/Codex subscription. Use when the user asks to create, draw, render, or generate an image.',
        parameters: {
            prompt: {
                type: 'string',
                required: true,
                description: 'A detailed image-generation prompt.',
            },
            size: {
                type: 'string',
                enum: IMAGE_SIZES,
                description: 'Output dimensions.',
            },
            quality: {
                type: 'string',
                enum: IMAGE_QUALITIES,
                description: 'Rendering quality.',
            },
            background: {
                type: 'string',
                enum: IMAGE_BACKGROUNDS,
                description: 'Background mode.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    attachmentId: { type: 'string', required: true },
                    mediaType: { type: 'string', required: true },
                    bytes: { type: 'integer', required: true },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                    name: { type: 'string' },
                    revisedPrompt: { type: 'string' },
                },
            },
            render: (_args, value) => [
                { type: 'image', attachment: imageRefFromValue(value) },
                {
                    type: 'text',
                    text: value.revisedPrompt === undefined
                        ? 'Изображение сгенерировано.'
                        : `Изображение сгенерировано. Уточнённый промпт: ${value.revisedPrompt}`,
                },
            ],
        },
        timeoutMs: 300_000,
        // Генерация не меняет состояния родительского агента: записи вложений
        // адресуются по содержимому и идемпотентны.
        isConcurrencySafe: () => true,
        presentCall: (args) => {
            // При стриминге и повторе лога аргументы бывают частичными:
            // отбрасываем презентацию вместо ошибки.
            try {
                return {
                    card: 'generic',
                    title: 'Генерация изображения',
                    kind: 'other',
                    rawInput: parseImageArgs(args).prompt,
                };
            }
            catch {
                return undefined;
            }
        },
        async execute(args, exec) {
            const input = parseImageArgs(args);
            const credential = await deps.resolveCredential(exec.signal, exec.agent === undefined ? undefined : String(exec.agent.id));
            const events = await requestCodexEvents({
                credential,
                body: buildImageRequest(input, deps.model),
                signal: exec.signal,
                endpoint: deps.endpoint,
                originator: deps.originator,
                ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
            });
            const image = collectImage(events);
            if (image === undefined) {
                throw new Error('Бэкенд OpenAI Codex не вернул результат генерации изображения');
            }
            const data = new Uint8Array(Buffer.from(image.data, 'base64'));
            const ref = await deps.saveImage({
                data,
                mediaType: imageMediaTypeOf(image.format),
                name: `gpt-image-${Date.now()}.${image.format}`,
            });
            return {
                attachmentId: ref.attachmentId,
                mediaType: ref.mediaType,
                bytes: ref.bytes,
                width: ref.width,
                height: ref.height,
                ...(ref.name === undefined ? {} : { name: ref.name }),
                ...(image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt }),
            };
        },
    });
}
//# sourceMappingURL=image-tool.js.map