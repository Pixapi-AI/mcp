# pixapi-mcp

Use Pixapi image and video generation tools from MCP clients.

- Website: [Pixapi](https://pixapi.ai)
- Remote MCP endpoint: `https://api.pixapi.ai/mcp`
- License: [MIT](./LICENSE)

## Quick start

Configure your project automatically (Node.js 22+):

```bash
npx -y pixapi-mcp init --client codex
```

Replace `codex` with your client, or use `--client all` for all five:

| Client | `--client` | Configuration file |
| --- | --- | --- |
| Claude Code | `claude-code` | `.mcp.json` |
| Cursor | `cursor` | `.cursor/mcp.json` |
| Codex | `codex` | `.codex/config.toml` |
| VS Code / GitHub Copilot | `vscode` | `.vscode/mcp.json` |
| Gemini CLI | `gemini-cli` | `.gemini/settings.json` |

Without `--client`, the default is Claude Code and Cursor (`--client both`).
Use `--project /path/to/project` to configure another project.

Reload your MCP client and connect to `pixapi`. Complete its browser sign-in
and authorization prompt the first time. The client saves the OAuth session
and refreshes it automatically; no API key or credential editing is required.
The client may ask you to sign in again if authorization is revoked or expires.
Each client manages its own native OAuth session.

`init` configures a direct remote HTTP connection by default. If your client
has an Add MCP Server interface, you can also enter the endpoint URL there
without installing this npm package or Node.js.

Codex requires a trusted project. In VS Code, use **MCP: List Servers** to
start `pixapi`; in Gemini CLI, use `/mcp` to inspect it. Complete any client
trust or sign-in prompt. `init` does not change client security policies.

## Generated configuration

Claude Code:

```json
{"mcpServers":{"pixapi":{"type":"http","url":"https://api.pixapi.ai/mcp"}}}
```

Cursor uses the same `mcpServers` entry with `url` and no `type` field.
VS Code uses `servers` with `type: "http"` and `url`.
Gemini CLI uses `mcpServers` with `httpUrl`.

Codex:

```toml
[mcp_servers.pixapi]
url = "https://api.pixapi.ai/mcp"
```

Running `init` updates the `pixapi` entry and preserves other servers and
settings. VS Code JSONC comments are preserved. Codex TOML settings are
preserved, but comments and formatting are not. All selected configurations
are parsed before writing; a filesystem failure during writes can still
leave some files updated. Correct the local issue and rerun `init`.

## Local stdio bridge

For clients that need stdio, configure the bridge explicitly:

```bash
npx -y pixapi-mcp init --client cursor --transport stdio
```

The generated entry runs `npx -y pixapi-mcp proxy` without credentials.
Registry installations of the npm package also start the bridge directly:
no separate `init` command or environment variable is required.

The bridge completes the local MCP handshake immediately. On the first tool
request it opens browser authorization, then forwards tools to Pixapi.
Subsequent connections reuse the saved session and refresh tokens automatically.
For clients with a short tool-discovery timeout, sign in once beforehand:

```bash
npx -y pixapi-mcp login
```

If a client times out during the initial browser sign-in, complete sign-in
and reconnect the client. No authorization URL, code, or token is printed
to MCP stdout or error output.

OAuth sessions are stored per endpoint in `~/.pixapi/oauth-<hash>.json`.
On macOS and Linux, the directory uses mode `0700` and files use `0600`.
Writes are atomic; concurrent bridge processes share an authorization lock.
PKCE verifiers and callback state are kept only in memory. The callback binds
to loopback on the same host as the bridge. For a headless or remote host,
prefer the client's native remote OAuth connection.

### Existing API key installations

Existing API key configurations remain compatible. For an explicit API key
installation, set `PIXAPI_API_KEY` when running `init`; it configures stdio and
saves the key privately in `~/.pixapi/mcp-credentials.json`. An explicit
`--transport remote` always selects native OAuth, even if that variable is set.
The proxy also accepts `PIXAPI_API_KEY` directly for unattended deployments.

The proxy gives an explicit environment key priority, then a saved OAuth
session, then a legacy key file. To migrate an existing bridge to OAuth, run
`pixapi-mcp login` and remove any `PIXAPI_API_KEY` override from its environment.
Keys and tokens never appear in generated project configurations.

## Available tools

This package forwards the live tool list from the remote Pixapi MCP endpoint.
After you connect, call `tools/list` or `pixapi_get_pricing_and_balance` for
the current catalog.

### `pixapi_get_pricing_and_balance`

Returns your current balance and live image/video model pricing. Each catalog
row includes a `type`:

- Images: `text_to_image`, `image_to_image`
- Videos: `text_to_video`, `image_to_video`

Rows marked `mcp_generate_supported=true` can be called through the matching
generate tool.

### `pixapi_generate_image`

Starts an asynchronous image task and returns a `task_id`. Use
`type=text_to_image` for a prompt-only request, or `type=image_to_image` with
the `image` field. The tool accepts the image models in the live catalog,
including Gemini, GPT Image, Flux, Seedream, Qwen, and Wan.

This call consumes account credits. It is not idempotent: repeating the same
call creates another task and may charge the account again.

### `pixapi_generate_video`

Starts an asynchronous video task and returns a `task_id`. Use
`type=text_to_video` for a prompt-only request, or `type=image_to_video` with
the `image` field. Pass `seconds` and `resolution` as required by the selected
model.

This call consumes account credits and is not idempotent.

### `pixapi_get_task`

Retrieves an image or video task owned by the authenticated account. Poll this
tool with the returned `task_id` until the status is `completed` or `failed`.
A completed task includes media URLs.

Recommended agent flow:

1. Call `pixapi_get_pricing_and_balance`.
2. Select a catalog row with `mcp_generate_supported=true` and check the
   balance.
3. Call `pixapi_generate_image` or `pixapi_generate_video` once and retain
   its `task_id`.
4. Poll `pixapi_get_task` every few seconds.
5. Return the result URL when the task is complete.

## CLI reference

```text
pixapi-mcp init [--client <name|all|both>] [--project <path>] [--transport <remote|stdio>]
pixapi-mcp login
pixapi-mcp proxy
pixapi-mcp --help
```

With no arguments, the package starts the stdio proxy.

## Troubleshooting

- **Tools do not appear:** reload the client, enable the `pixapi` server, and
  complete project trust and browser sign-in. For stdio, ensure Node.js 22+
  and `npx` are available on the host running the bridge.
- **Authorization denied or timed out:** retry sign-in from the native client,
  or run `pixapi-mcp login` for the bridge and complete browser authorization.
- **Callback port unavailable:** close another pending Pixapi login and retry.
- **Service unavailable:** check your connection and retry later. Internal
  HTTP responses and exception details are omitted from public errors.
- **Invalid legacy API key:** replace the key, or migrate to OAuth as above.

## Security and current limitations

- Do not commit or share files in `~/.pixapi/`.
- Revoke unused or exposed credentials in your Pixapi account.
- The stdio bridge forwards tools only. Resources, prompts, sampling, and
  elicitation are not exposed by this package.
- Image and video generation are asynchronous and not idempotent. The bridge
  retries HTTP authentication rejection once; it does not retry network
  failures or server errors that might have occurred after a tool executed.
- Account top-up is not exposed as an MCP tool; complete payment on Pixapi.

For service documentation, visit [Pixapi docs](https://pixapi.ai/docs).

## Official MCP Registry

This server is published to the [official MCP
Registry](https://registry.modelcontextprotocol.io) as
`io.github.Pixapi-AI/pixapi-mcp`, with both connection methods declared in
[`server.json`](https://github.com/Pixapi-AI/mcp/blob/master/server.json): the remote endpoint and the npm package. Both support OAuth without a required API key starting with version 0.1.4.

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Pixapi-AI/pixapi-mcp"
```

Set matching versions in `package.json`, `package-lock.json`, and `server.json`
before pushing the corresponding `v*` tag. The release workflow installs locked
dependencies, runs checks, and validates the Registry manifest before publishing.
Manual runs must also select that release tag. A rerun compares existing npm
package integrity and Registry metadata and only publishes missing steps;
conflicting contents require a new version. Registry authentication uses GitHub
OIDC, without a stored Registry token.
