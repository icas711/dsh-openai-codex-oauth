import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_SIZES,
  buildImageRequest,
  collectImage,
  defineCodexImageTool,
  imageMediaTypeOf,
  parseImageArgs,
} from '../src/image-tool.js'

const VALID_REF = {
  attachmentId: 'att-1',
  mediaType: 'image/png' as const,
  bytes: 4,
  width: 16,
  height: 16,
  name: 'gpt-image-1.png',
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    model: DEFAULT_IMAGE_MODEL,
    endpoint: 'https://example.invalid/responses',
    originator: 'pi',
    resolveCredential: async () => ({ access: 'tok', accountId: 'acct' }),
    saveImage: async () => ({ ...VALID_REF }),
    ...overrides,
  }
}

describe('parseImageArgs', () => {
  it('accepts a bare prompt and applies documented defaults later', () => {
    expect(parseImageArgs({ prompt: 'котик' })).toEqual({ prompt: 'котик' })
  })

  it('keeps valid enum arguments', () => {
    expect(parseImageArgs({ prompt: 'p', size: '1536x1024', quality: 'high', background: 'opaque' }))
      .toEqual({ prompt: 'p', size: '1536x1024', quality: 'high', background: 'opaque' })
  })

  it('rejects an empty prompt, non-objects and bad enums in Russian', () => {
    expect(() => parseImageArgs({ prompt: '  ' })).toThrow('prompt должен быть непустой строкой')
    expect(() => parseImageArgs('nope' as unknown)).toThrow('Аргументы generate_image должны быть объектом')
    expect(() => parseImageArgs({ prompt: 'p', size: '512x512' })).toThrow(`size должен быть одним из: ${IMAGE_SIZES.join(', ')}`)
    expect(() => parseImageArgs({ prompt: 'p', quality: 'ultra' })).toThrow('quality должен быть одним из: low, medium, high')
    expect(() => parseImageArgs({ prompt: 'p', background: 'transparent' })).toThrow('background должен быть одним из: auto, opaque')
  })
})

describe('buildImageRequest', () => {
  it('forces the image_generation tool with defaults', () => {
    const body = buildImageRequest({ prompt: 'котик' })
    expect(body.model).toBe(DEFAULT_IMAGE_MODEL)
    expect(body.tools).toEqual([{
      type: 'image_generation',
      action: 'generate',
      size: '1024x1024',
      quality: 'medium',
      background: 'auto',
    }])
    expect(body.tool_choice).toEqual({ type: 'image_generation' })
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'котик' }] }])
  })

  it('forwards explicit size, quality and background', () => {
    const body = buildImageRequest({ prompt: 'p', size: '1024x1536', quality: 'low', background: 'opaque' })
    expect(body.tools[0]).toMatchObject({ size: '1024x1536', quality: 'low', background: 'opaque' })
  })
})

describe('collectImage', () => {
  it('reads the image call from an output_item.done event', () => {
    const result = collectImage([{
      type: 'response.output_item.done',
      item: { type: 'image_generation_call', result: 'aGVsbG8=', revised_prompt: 'a cat', output_format: 'png' },
    }])
    expect(result).toEqual({ data: 'aGVsbG8=', format: 'png', revisedPrompt: 'a cat' })
  })

  it('reads the image call from a response.completed snapshot', () => {
    const result = collectImage([{
      type: 'response.completed',
      response: { output: [{ type: 'image_generation_call', result: 'd29ybGQ=', output_format: 'webp' }] },
    }])
    expect(result).toEqual({ data: 'd29ybGQ=', format: 'webp', revisedPrompt: undefined })
  })

  it('defaults the format to png and skips calls without a result', () => {
    expect(collectImage([{ item: { type: 'image_generation_call', result: 'eA==' } }])).toEqual({ data: 'eA==', format: 'png', revisedPrompt: undefined })
    expect(collectImage([{ item: { type: 'image_generation_call', status: 'in_progress' } }])).toBeUndefined()
    expect(collectImage([{ type: 'response.completed', response: { output: [] } }])).toBeUndefined()
  })
})

describe('imageMediaTypeOf', () => {
  it('maps backend formats to attachment media types', () => {
    expect(imageMediaTypeOf('png')).toBe('image/png')
    expect(imageMediaTypeOf('webp')).toBe('image/webp')
    expect(imageMediaTypeOf('jpeg')).toBe('image/jpeg')
    expect(imageMediaTypeOf('jpg')).toBe('image/jpeg')
    expect(imageMediaTypeOf('anything')).toBe('image/png')
  })
})

describe('defineCodexImageTool', () => {
  it('declares the generate_image schema and presentation', () => {
    const tool = defineCodexImageTool(deps())
    expect(tool.name).toBe('generate_image')
    const parameters = tool.parameters as {
      type: string
      properties: Record<string, { type: string, enum?: string[] }>
      required: string[]
    }
    expect(parameters.type).toBe('object')
    expect(parameters.properties.prompt?.type).toBe('string')
    expect(parameters.required).toEqual(['prompt'])
    expect(parameters.properties.size?.enum).toEqual([...IMAGE_SIZES])
    expect(parameters.properties.quality?.enum).toEqual(['low', 'medium', 'high'])
    expect(tool.timeoutMs).toBe(300_000)
    expect(tool.isConcurrencySafe?.({ prompt: 'p' })).toBe(true)
    expect(tool.presentCall?.({ prompt: 'котик' })).toMatchObject({
      card: 'generic',
      title: 'Генерация изображения',
      kind: 'other',
      rawInput: 'котик',
    })
  })

  it('renders the saved attachment with a Russian confirmation', () => {
    const tool = defineCodexImageTool(deps())
    const output = tool.output
    const blocks = output.render({ prompt: 'p' } as never, { ...VALID_REF, revisedPrompt: 'уточнённый' } as never)
    expect(blocks).toEqual([
      {
        type: 'image',
        attachment: {
          attachmentId: 'att-1',
          mediaType: 'image/png',
          bytes: 4,
          width: 16,
          height: 16,
          name: 'gpt-image-1.png',
        },
      },
      { type: 'text', text: 'Изображение сгенерировано. Уточнённый промпт: уточнённый' },
    ])
  })

  it('executes through the Codex backend and saves the attachment', async () => {
    let saved: { mediaType: string, bytes: number } | undefined
    let requestBody: unknown
    const tool = defineCodexImageTool(deps({
      saveImage: async (input: { data: Uint8Array, mediaType: string }) => {
        saved = { mediaType: input.mediaType, bytes: input.data.byteLength }
        return { ...VALID_REF }
      },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body))
        return new Response(
          'data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"aGVsbG8=","output_format":"png"}}\n\ndata: [DONE]\n\n',
          { status: 200 },
        )
      }) as typeof fetch,
    }))
    const exec = { signal: new AbortController().signal } as never
    const value = await tool.execute({ prompt: 'котик' }, exec)
    expect(value).toMatchObject({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 4 })
    expect(saved).toEqual({ mediaType: 'image/png', bytes: 5 })
    expect((requestBody as { tools: Array<{ type: string }> }).tools[0]?.type).toBe('image_generation')
  })

  it('fails loud when the backend returns no image call', async () => {
    const tool = defineCodexImageTool(deps({
      fetchImpl: (async () => new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', { status: 200 })) as typeof fetch,
    }))
    const exec = { signal: new AbortController().signal } as never
    await expect(tool.execute({ prompt: 'p' }, exec))
      .rejects.toThrow('Бэкенд OpenAI Codex не вернул результат генерации изображения')
  })
})
