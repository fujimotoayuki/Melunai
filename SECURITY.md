# Security Policy

Melunai is experimental local-first software. It can interact with local files, local LLM servers, and optional MCP servers.

## Supported Versions

Only the latest public alpha release is supported.

## Reporting A Vulnerability

Please do not open a public issue for sensitive security reports.

For now, use a private GitHub security advisory if available, or contact the project maintainer through the repository profile.

## Security Model

- Melunai does not require a cloud LLM by default.
- Ollama prompts are sent to the configured local Ollama endpoint.
- Local files and Corpus excerpts may be included in prompts when the user enables document/reference features.
- MCP servers may execute local commands or access external services depending on their configuration.
- Users should only connect MCP servers they trust.

## Known Alpha Limitations

- Windows builds are currently unsigned.
- Auto-update is not enabled.
- Corpus/document reference is experimental and may include irrelevant context.
- Weak local models can misunderstand instructions.

