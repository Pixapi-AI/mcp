# pixapi-mcp

Use Pixapi image and video generation tools from any Model Context Protocol
(MCP) client.

- Website: [https://pixapi.ai](https://pixapi.ai)
- Documentation: [https://pixapi.ai/docs](https://pixapi.ai/docs)
- Remote MCP endpoint: `https://api.pixapi.ai/mcp`

Pixapi currently provides tools for checking model pricing and account
balance, starting asynchronous image or video tasks, and retrieving results.

## Choose the right connection method

### Remote MCP with OAuth — recommended

If your client supports remote MCP servers and OAuth, add this URL directly:

```text
https://api.pixapi.ai/mcp
```

Your client opens Pixapi in a browser so you can sign in and authorize it.
You do not need this npm package, Node.js, or an API key for that connection
method.

### Local stdio bridge

Use this npm package when your MCP client only supports local stdio servers.
The bridge reads a Pixapi API key from a private file and forwards MCP tool
requests to the remote Pixapi MCP endpoint.

Requirements:

- Node.js 22 or newer
- A Pixapi account
- A Pixapi API key created at
  [https://pixapi.ai/settings/apikeys](https://pixapi.ai/settings/apikeys)

## Quick start

### 1. Create an API key

Sign in to Pixapi, open
[API Keys](https://pixapi.ai/settings/apikeys), create a key, and copy it.
Treat the key like a password.

### 2. Configure your MCP client

Run the command from the project in which you want to enable Pixapi.

macOS or Linux:

```bash
PIXAPI_API_KEY='sk_your_key' npx -y pixapi-mcp init
```

Windows PowerShell:

```powershell
$env:PIXAPI_API_KEY = 'sk_your_key'
npx -y pixapi-mcp init
Remove-Item Env:PIXAPI_API_KEY
```

`init` supports the following project configurations:

| Client | `--client` | Configuration file |
| --- | --- | --- |
| Claude Code | `claude-code` | `.mcp.json` |
| Cursor | `cursor` | `.cursor/mcp.json` |
| Codex | `codex` | `.codex/config.toml` |
| VS Code / GitHub Copilot | `vscode` | `.vscode/mcp.json` |
| Gemini CLI | `gemini-cli` | `.gemini/settings.json` |

Without `--client`, `init` configures Claude Code and Cursor, preserving the
original default. `--client both` explicitly selects that same pair.

Configure only one client:

```bash
PIXAPI_API_KEY='sk_your_key' npx -y pixapi-mcp init --client claude-code
PIXAPI_API_KEY='sk_your_key' npx -y pixapi-mcp init --client cursor
PIXAPI_API_KEY='sk_your_key' npx -y pixapi-mcp init --client codex
PIXAPI_API_KEY='sk_your_key' npx -y pixapi-mcp init --client vscode
PIXAPI_API_KEY='sk_your_key' npx -y pixapi-mcp init --client gemini-cli
```

Configure all five clients:

```bash
PIXAPI_API_KEY='sk_your_key' npx -y pixapi-mcp init --client all
```

Configure another project directory:

```bash
PIXAPI_API_KEY='sk_your_key' npx -y pixapi-mcp init \
  --project /path/to/project
```

Restart or reload your MCP client after configuration. The client starts the
bridge with:

```bash
npx -y pixapi-mcp proxy
```

You normally do not need to run `proxy` yourself.

Codex loads project configuration only for trusted projects. Open the project
in Codex, complete its project trust flow, and restart the relevant session.
In VS Code, open the project and use **MCP: List Servers** to find and start
`pixapi`, completing any server trust prompt. In Gemini CLI, open the project
and use `/mcp` to inspect the server. Client policies can disable project MCP
servers; `init` does not change trust, approval, or administrator policies.

For remote development, run `init` on the same host and OS account that runs
the stdio server so it can read the private credential file.

## Generated configuration

Claude Code and Cursor use the following credential-free entry:

```json
{
  "mcpServers": {
    "pixapi": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "pixapi-mcp", "proxy"]
    }
  }
}
```

Codex uses TOML:

```toml
[mcp_servers.pixapi]
command = "npx"
args = ["-y", "pixapi-mcp", "proxy"]
```

VS Code uses `servers` instead of `mcpServers`. Gemini CLI uses `mcpServers`
with `command` and `args`, without the `type` field. All five launch the same
tools-only proxy.

The API key is stored separately at:

```text
~/.pixapi/mcp-credentials.json
```

On macOS and Linux, the directory is set to mode `0700` and the credential
file to mode `0600`. The key is sent only to the HTTPS Pixapi MCP endpoint in
an Authorization header. It is not written to any generated client configuration.

Running `init` again replaces the stored Pixapi credential and updates only
the `pixapi` MCP server entry. Other MCP servers and top-level fields in the
configuration files are preserved.
VS Code JSONC comments are preserved. Codex TOML is parsed and serialized:
existing settings are preserved, but comments and formatting are not.

`init` validates the key and reads all selected configurations before updating
them. The shared credential is replaced only after all configuration writes
succeed. If a configuration fails to update, your existing credential is kept.
If saving the credential itself fails, correct the reported local issue and
rerun `init`; some project configuration files may already have been updated.

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
pixapi-mcp init [options]
pixapi-mcp proxy
pixapi-mcp --help
```

`init` options:

```text
--project <path>            Project to configure (default: current directory)
--client <claude-code|cursor|codex|vscode|gemini-cli|all|both>
--help                      Show command help
```

For this release, set `PIXAPI_API_KEY` when running `init`.

## Troubleshooting

### `PIXAPI_API_KEY is required`

Create a key at
[https://pixapi.ai/settings/apikeys](https://pixapi.ai/settings/apikeys) and
set it only for the `init` command as shown above.

### `Invalid Pixapi API key`

Verify that you copied the complete key and that it starts with `sk_`. Create
a replacement key if the original is no longer available.

### `A required local file is missing`

The bridge has not been initialized for this user account. Run `init` before
starting or reloading the MCP client.

### `Pixapi is temporarily unavailable`

Check your network connection and try starting the bridge again later.
Raw HTTP error responses are omitted from terminal output.

### The tools do not appear

Restart the MCP client after running `init`. Confirm that Node.js 22 or newer
and `npx` are available in the environment used by the client:

```bash
node --version
npx --version
npx -y pixapi-mcp --help
```

Also confirm that the project contains the configuration file for your client
listed above, and that the client has enabled the `pixapi` server.

### Authentication fails after setup

The stored key may have been revoked. Create a new key, run `init` again, and
restart the MCP client.

## Security and current limitations

- Do not commit or share `~/.pixapi/mcp-credentials.json`.
- Revoke unused or exposed keys in your Pixapi account.
- The stdio bridge currently forwards MCP tools only. Resources, prompts,
  sampling, and elicitation are not exposed by this package.
- Image and video generation are asynchronous and currently not idempotent.
- Account top-up is not exposed as an MCP tool. If credits are insufficient,
  complete payment on Pixapi and retry.
- This package is licensed under the [MIT License](./LICENSE).

For API behavior, models, pricing, and service documentation, visit
[https://pixapi.ai/docs](https://pixapi.ai/docs).
