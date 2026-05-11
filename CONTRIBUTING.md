# Contributing

Thank you for your interest in Melunai.

Melunai is currently an alpha project. The most useful contributions are:

- Reproducible bug reports
- UI/UX feedback
- Local LLM performance reports
- Tests for weak-model behavior
- Security reviews of local file and MCP boundaries

## Development Setup

```bash
npm install
npm run electron:dev
```

Before submitting changes, run:

```bash
npm run test:unit
npm run build
npm run electron:build
```

## Principles

- Prefer local-first behavior.
- Do not assume access to strong cloud models.
- Keep weak local LLMs in mind.
- Do not add network calls without a clear user-facing reason.
- Treat file access and MCP integrations as security-sensitive.

