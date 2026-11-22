# Промт 04 — интеграция openai-codex в список провайдеров «Модели» (форк DSH)

> Этот промт самодостаточен: выполняющая сессия не видит диалог, из которого он
> составлен. Все сигнатуры и фрагменты кода сверены по исходникам форка
> (база `0.1.0-rc.5`). Правки плагина dsh-openai-codex-oauth со своей стороны
> уже выполнены и опубликованы в его репозитории (v0.3.0-ru.1) — этот промт
> закрывает вторую, форк-часть интеграции.

## Контекст

Плагин `dsh-openai-codex-oauth` даёт моделям ChatGPT (провайдер `openai-codex`
каталога pi-ai) вход по OAuth-подписке. Сегодня он активирует провайдер
глобальным патчем `cordis.patch.yml` (`providers.openai-codex.apiKeyEnv:
OPENAI_CODEX_ACCESS_TOKEN`), поэтому:

- карточка «OpenAI Codex (подписка)» на странице «Настройки → Модели» приходит
  из ОБЩЕГО документа настроек — у неё нет кнопки «Удалить» (условие
  `removable` в `packages/client/ui-settings-models/src/client/store.ts`
  требует профиль в личной секции и его отсутствие в базовой);
- модели ChatGPT видны в выборщике моделей ВСЕМ и ВСЕГДА, даже без ключа.

Новая схема (согласована с пользователем): глобального маршрута нет; провайдер
становится обычной **личной карточкой** в списке «Модели», как `zai-coding-cn`:

- `/codex-login` плагина сам пишет личный профиль `llm-pi-ai →
  providers.openai-codex` (карточка появляется) + ключи в личный стор, в т.ч.
  по **конвенциональной ссылке** `OPENAI_CODEX_API_KEY`;
- `/codex-logout` и кнопка «Удалить» убирают карточку — модели исчезают из
  выборщика;
- добавить карточку можно и вручную: «Добавить провайдера» → OpenAI Codex;
- headless/CLI (без веб-личности) codex по умолчанию теряет — принято
  пользователем; админ может вернуть глобальный маршрут записью в общий
  документ настроек.

Что мешает сегодня (три гейта + один пропуск в каталоге выборщика):

1. `directoryEntries` (llm-pi-ai) объявляет каталогных провайдеров только с
   api-key-аутентификацией — `openai-codex` (OAuth-only) в directory не
   попадает, «Добавить провайдера» его не предложит.
2. `personalProfileOfOwner` (llm-pi-ai) строит личный профиль тоже только для
   api-key провайдеров — личный маршрут codex не резолвится.
3. `routeAuth` (llm-pi-ai/provider.ts) добавляет api-key-метод харнесса только
   профилю с `apiKeyEnv` (namesCredential). Личный профиль не несёт `apiKeyEnv`
   (правило R6: `stripApiKeyEnvKeys` в api-proxy вырезает его при личной
   записи, `personalFacts` — при резолве), поэтому pi-ai получил бы OAuth-only
   auth и отказал бы ключу харнесса («Provider is not configured»).
4. `personalCatalogGroups` (api-proxy) пропускает дормантного провайдера, чей
   личный профиль не перечисляет `models` — bare-профиль codex не создал бы
   группу моделей в выборщике.

Правило R6 сохраняется в силе: личные секции по-прежнему не называют
credential (`stripApiKeyEnvKeys` не трогаем), ключ владельца читается строго из
его личного стора по конвенциональной ссылке
`providerApiKeyRef('openai-codex')` = `OPENAI_CODEX_API_KEY`.

## Изменение 1 — `packages/llm/llm-pi-ai/src/catalog.ts`

После `catalogProviderTakesApiKey` (строка ~191) добавить:

```ts
/**
 * Каталожные OAuth-only маршруты, OAuth которых ведёт плагин харнесса,
 * хранящий access-токен как обычный ключ харнесса (dsh-openai-codex-oauth для
 * `openai-codex`): страница «Модели» предлагает их как обычных провайдеров,
 * личный профиль владельца активирует маршрут, а api-key-метод харнесса
 * едет рядом с родным OAuth, чтобы сохранённый токен аутентифицировал
 * запрос. Ключ читается по конвенциональной ссылке маршрута (R6: личный
 * профиль credential не называет).
 */
export const PLUGIN_OAUTH_CATALOG_ROUTES: ReadonlySet<string> = new Set(['openai-codex'])

/**
 * Whether a catalog route authenticates from a harness-stored credential —
 * a native api-key method or a plugin-managed OAuth route (see
 * {@link PLUGIN_OAUTH_CATALOG_ROUTES}). Such routes are offered on the Models
 * page and accept personal profiles.
 * @param provider - provider route key.
 */
export function catalogProviderTakesHarnessCredential(provider: string): boolean {
  return catalogProviderTakesApiKey(provider) || PLUGIN_OAUTH_CATALOG_ROUTES.has(provider)
}
```

## Изменение 2 — `packages/llm/llm-pi-ai/src/index.ts`, directory и личные профили

Импорт (строка 75) заменить:

```ts
import { catalogProviderIds, catalogProviderTakesHarnessCredential } from './catalog.ts'
```

В `directoryEntries` (строка ~184) условие объявления каталогных провайдеров:

```ts
// было
    if (catalogProviderTakesApiKey(provider)) declare(provider, provider)
// стало
    if (catalogProviderTakesHarnessCredential(provider)) declare(provider, provider)
```

Заодно обновить комментарий над циклом (сейчас он объясняет, что OAuth-only
провайдеры не предлагаются): дописать, что plugin-managed OAuth-маршруты
(`PLUGIN_OAUTH_CATALOG_ROUTES`) — намеренное исключение: их ключ хранит и
обновляет плагин, поэтому карточка осмысленна.

В `personalProfileOfOwner` (строка ~321):

```ts
// было
    if (!catalogProviderIds().includes(provider) || !catalogProviderTakesApiKey(provider)) return undefined
// стало
    if (!catalogProviderIds().includes(provider) || !catalogProviderTakesHarnessCredential(provider)) return undefined
```

JSDoc метода («Персональный профиль строится только для провайдеров каталога
с ключевой аутентификацией…») дополнить: …или plugin-managed OAuth-маршрутом
из `PLUGIN_OAUTH_CATALOG_ROUTES` — их access-токен хранится в сторе харнесса.

## Изменение 3 — `packages/llm/llm-pi-ai/src/provider.ts`, routeAuth

Импорт (строка 27):

```ts
import { catalogProvider, PLUGIN_OAUTH_CATALOG_ROUTES } from './catalog.ts'
```

`routeAuth` (строки ~126–134):

```ts
// было
function routeAuth(spec: ProviderSpec, catalog: Provider | undefined): Provider['auth'] {
  if (catalog === undefined) return { apiKey: harnessApiKeyAuth(spec.displayName) }
  if (catalog.auth.apiKey !== undefined || !spec.namesCredential) return catalog.auth
  return { ...catalog.auth, apiKey: harnessApiKeyAuth(spec.displayName) }
}

// стало
function routeAuth(spec: ProviderSpec, catalog: Provider | undefined): Provider['auth'] {
  if (catalog === undefined) return { apiKey: harnessApiKeyAuth(spec.displayName) }
  // A plugin-managed OAuth route (PLUGIN_OAUTH_CATALOG_ROUTES) adds the
  // harness api-key method even for a profile naming no credential: personal
  // profiles never carry apiKeyEnv (rule R6), and the owner's token — the
  // plugin stores it under the conventional ref — must authenticate.
  if (catalog.auth.apiKey !== undefined
    || (!spec.namesCredential && !PLUGIN_OAUTH_CATALOG_ROUTES.has(catalog.id))) {
    return catalog.auth
  }
  return { ...catalog.auth, apiKey: harnessApiKeyAuth(spec.displayName) }
}
```

JSDoc `routeAuth` дополнить абзацем про plugin-managed OAuth-исключение.

## Изменение 4 — `packages/host/apiproxy/src/api-proxy.ts`, personalCatalogGroups

Внутри `createApiProxy`, рядом с `personalCatalogGroups` (строка ~3496),
добавить помощник и расширить цикл:

```ts
  /**
   * Модели из листинга владельца для дормантного маршрута: мост
   * registerOwnerListing адаптера (llm-pi-ai регистрирует его для всех своих
   * directory-маршрутов) отвечает моделями каталога pi-ai, когда личный
   * профиль их не перечисляет. Любой отказ — undefined, группа остаётся
   * скрытой, как раньше.
   */
  async function ownerListedModels(login: string, provider: string): Promise<ModelCatalogModel[] | undefined> {
    try {
      const listed = await ctx.llm.listModelsForOwner(login, provider)
      return listed.map(model => ({
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
      }))
    } catch {
      return undefined
    }
  }
```

Цикл `personalCatalogGroups` (текущий текст — см. «было») меняется так:

```ts
// было
      const models = personalCatalogModels(profile)
      if (models === undefined || models.length === 0) continue
      const at = groupAt.get(entry.provider)

// стало
      const explicit = personalCatalogModels(profile)
      const at = groupAt.get(entry.provider)
      // Дормантный маршрут (без глобальной группы) с bare-профилем без строк
      // моделей: листинг владельца отвечает моделями каталога pi-ai — так
      // личная карточка openai-codex получает группу моделей ChatGPT без
      // глобального маршрута. Явный пустой список в профиле — намеренное
      // скрытие, fallback не применяется; у глобально зарегистрированного
      // провайдера поведение прежнее (профиль без models группу не меняет).
      const models = explicit === undefined && at === undefined
        ? await ownerListedModels(login, entry.provider)
        : explicit
      if (models === undefined || models.length === 0) continue
```

(порядок строк: `const at` поднимается выше использования; остальное в цикле
без изменений). JSDoc `personalCatalogGroups` дополнить фразой про fallback.

## Изменение 5 — деплой-заметка

Никаких правок клиента (`packages/client/ui-settings-models`) не нужно:
кнопка «Удалить» появится сама (профиль в личной секции, в базовой его нет),
«Добавить провайдера» возьмёт запись из directory после изменений 1–2.

## Тесты

### `packages/llm/llm-pi-ai/tests/` (новый файл `codex-personal-route.spec.ts`)

Ориентир по арранжировке — `personal-route.spec.ts` (userSettings/userCredentials
даблы, `ctx.plugin(llm-pi-ai …)`). Сценарии:

1. **Directory**: без настроенных профилей `ctx.llm.listConfigurableProviders()`
   содержит `openai-codex` с `settingsNs: 'llm-pi-ai'`, `settingsPath:
   ['providers', 'openai-codex']`, `declared` не true (каталожный член).
2. **Личный профиль**: в личной секции владельца посеян
   `llm-pi-ai.providers.openai-codex = {}` → `ctx.llm.listModelsForOwner(owner,
   'openai-codex')` возвращает модели каталога pi-ai (не пусто; содержит
   `gpt-5.6-sol`). Без профиля — отказ `NO_ADAPTER`.
3. **routeAuth**: `resolveProfiles({ 'openai-codex': {} })` (экспорт из
   `../src/config.ts`) → профиль `.piProvider.auth` содержит api-key-метод
   харнесса рядом с OAuth (проверить наличие ключа `apiKey` в объекте auth);
   для другого OAuth-only-незнакомца поведение не меняется (каталожных других
   нет — достаточно codex-кейса).
4. **Ключ владельца**: в userCredentials владельца посеян
   `OPENAI_CODEX_API_KEY` → прямой вызов резолва ключа/стрима не требуется:
   достаточно убедиться, что `resolveApiKeyForOwner`-путь не тронут (это
   регрессией не считается — существующие тесты персональных маршрутов
   остаются зелёными).

### `packages/host/apiproxy/tests/` (новый файл `codex-visibility.spec.ts`)

Ориентир — `api-proxy-personal-providers.spec.ts` (харнесс с webAuth,
MemoryUserSettings/MemoryUserCredentials, `asCaller`). Арранжировка:

- `ctx.llm.registerConfigurableProviders([{ provider: 'openai-codex',
  displayName: 'OpenAI Codex (подписка)', settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'openai-codex'] }])`;
- `ctx.llm.registerOwnerListing('llm-pi-ai', async () => [
  { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
])` — мост как у llm-pi-ai;
- живая сессия через `stubSession`-приём.

Сценарии (вызов `api.sessions.models` под `asCaller('bob', …)`):

1. без личного профиля группы `openai-codex` нет (при зарегистрированном
   другом провайдере — его группа есть);
2. личный профиль `{}` (без `models`) → группа `openai-codex` появилась с
   моделями из owner-listing (`gpt-5.6-sol`);
3. личный профиль с явным `models: []` → группы нет (намеренное скрытие);
4. personalRoute/«Удалить»: после `api.settings.mutate` c `unset
   ['providers','openai-codex']` группа снова исчезает.

## Команды проверки

```bash
cd <корень форка>
npx vitest run packages/llm/llm-pi-ai/tests/codex-personal-route.spec.ts
npx vitest run packages/host/apiproxy/tests/codex-visibility.spec.ts
npx vitest run packages/llm/llm-pi-ai packages/host/apiproxy   # соседние сьюты не regress
npm run typecheck                                               # сборка типов хоста
```

## Критерии приёмки

1. `listConfigurableProviders()` отдаёт `openai-codex` без глобального маршрута.
2. На странице «Настройки → Модели» у веб-пользователя после `/codex-login`
   (плагин v0.3.0-ru.1) появляется карточка с кнопкой «Удалить»; «Удалить»
   убирает карточку; «Добавить провайдера» предлагает OpenAI Codex.
3. Выборщик моделей чата показывает модели ChatGPT только при наличии личной
   карточки (профиля) — после «Удалить»/`/codex-logout` группа исчезает.
4. Ход к модели codex у владельца с карточкой и ключом проходит (pi-ai
   принимает токен из личного стора по конвенциональной ссылке).
5. Все существующие сьюты llm-pi-ai и apiproxy зелёные; R6 не ослаблен
   (`stripApiKeyEnvKeys` без изменений).

## Деплой (после мержа)

1. Пересобрать хост-артефакты (`npm run build:lib`), перезапустить контейнер.
2. Обновить плагин на сервере до v0.3.0-ru.1 (репозиторий icas711/
   dsh-openai-codex-oauth; глобальный патч llm-pi-ai из его cordis.patch.yml
   удалён).
3. Каждому пользователю codex выполнить `/codex-login` заново: плагин допишет
   `OPENAI_CODEX_API_KEY` в личный стор и создаст карточку (миграция со старых
   `OPENAI_CODEX_ACCESS_TOKEN`-only записей).
4. Проверить в GUI пункты 2–4 критериев.

## Шаблон отчёта

- Изменённые файлы + строки.
- Результаты прогонов тестов (команды выше, счётчики passed/failed).
- Скриншот/текст состояния страницы «Модели» до/после (если доступен GUI).
- Отступления от промта и почему.
