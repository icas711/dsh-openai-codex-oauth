# dsh-openai-codex-oauth

[简体中文](README.zh-CN.md)

ChatGPT subscription OAuth for the `openai-codex` provider in DeepSeek Harness.

This package adds interactive login, credential persistence, token refresh, login status, and logout commands. DeepSeek Harness remains the agent runtime. The package uses the OAuth implementation exposed by `@earendil-works/pi-ai` and the model adapter supplied by `@deepseek-ai/dsh-llm-pi-ai`.

## How it works

```text
DeepSeek Harness
  ├─ dsh-openai-codex-oauth
  │    └─ @earendil-works/pi-ai OAuth implementation
  │         └─ OpenAI browser or device-code authorization
  └─ @deepseek-ai/dsh-llm-pi-ai
       └─ openai-codex model requests
```

`@earendil-works/pi-ai` runs as a JavaScript library inside Harness. The Pi coding-agent application and its agent loop do not participate in this integration.

The browser flow uses OAuth 2.0 Authorization Code with PKCE and a local callback at `http://localhost:1455/auth/callback`. A successful callback may display a Pi-branded local success page because that HTML is provided by the library.

## Requirements

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `22.19.0` or newer
- pnpm
- An OpenAI account with Codex subscription access
- Local TCP port `1455` available during browser login

## Build

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
```

The last command creates `dsh-openai-codex-oauth-0.1.1.tgz`.

## Install into DeepSeek Harness

With a globally available `dsh` command:

```sh
dsh plugin --profile web add ./dsh-openai-codex-oauth-0.1.1.tgz
dsh web
```

With the published Harness package through `npx`:

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add ./dsh-openai-codex-oauth-0.1.1.tgz
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

The bundled Cordis patch loads `@deepseek-ai/dsh-llm-pi-ai`, configures its `openai-codex` provider to read `OPENAI_CODEX_ACCESS_TOKEN`, and loads this plugin.

## Sign in

Open the Harness Web interface and submit:

```text
/codex-login
```

Select browser login in the prompt. The command also accepts an explicit method:

```text
/codex-login browser
/codex-login device
```

After authorization, select an `openai-codex` model from the model picker.

## Commands

| Command | Description |
| --- | --- |
| `/codex-login [browser\|device]` | Start OAuth authorization and store the credential. |
| `/codex-status` | Show credential state, source, and access-token expiry. |
| `/codex-logout` | Clear the stored OAuth credential and access token. |

## Configuration

The generated Harness plugin entry accepts:

```yaml
- id: openai-codex-oauth
  name: dsh-openai-codex-oauth
  config:
    oauthCredentialRef: OPENAI_CODEX_OAUTH_CREDENTIAL
    refreshBeforeMs: 300000
```

`refreshBeforeMs` is measured in milliseconds. The default value refreshes the access token five minutes before expiry.

The plugin stores the complete OAuth credential under `OPENAI_CODEX_OAUTH_CREDENTIAL` and the current access token under `OPENAI_CODEX_ACCESS_TOKEN`. With the default local credential source, Harness commonly writes these values to `~/.dsh/.credentials.yaml` with permissions scoped to the local user.

## Troubleshooting

### Port 3080 is already in use

Harness Web already has a listener on port `3080`. Check the owning process:

```sh
lsof -nP -iTCP:3080 -sTCP:LISTEN
```

Open the existing Harness page or stop that process before starting another Web instance.

### Browser login cannot start

Check port `1455`:

```sh
lsof -nP -iTCP:1455 -sTCP:LISTEN
```

Release the port and run `/codex-login browser` again. The device-code method is useful on remote hosts when the OpenAI account supports that flow.

### Login succeeds and model requests fail

Run `/codex-status`, confirm that the selected model uses provider `openai-codex`, and restart the Harness profile after installation changes.

## Security and service terms

OAuth access and refresh tokens grant access to the associated OpenAI account. Keep the Harness credential file private, keep the account under one user's control, and use the integration within the account's usage allowance. OpenAI service terms and plan-specific rules govern subscription access.

The Codex backend and its request format may change. A future OpenAI or `pi-ai` release can require a compatibility update.

## Project status

This is an independent community integration for DeepSeek Harness. OpenAI, DeepSeek, and Pi retain their respective names and trademarks.

## License

[MIT](LICENSE)

