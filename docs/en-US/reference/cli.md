---
title: CLI Reference
---

# CLI Reference

This page documents the command-line options exposed by Koharu's desktop binary.

Koharu uses the same binary for:

- desktop startup
- the local HTTP API

## Common usage

```bash
# macOS / Linux
koharu [OPTIONS]

# Windows
koharu.exe [OPTIONS]
```

## Options

| Option | Meaning |
| --- | --- |
| `-d`, `--download` | Prefetch runtime libraries and the default vision and OCR stack, then exit |
| `--cpu` | Force CPU mode even when a GPU is available |
| `--debug` | Enable debug-oriented console output |

## Behavior notes

Some flags affect more than startup appearance:

- with `--download`, Koharu exits after dependency prefetch and does not stay running
- with `--cpu`, both the vision stack and local LLM path avoid GPU acceleration

## Common patterns

Start with CPU-only inference:

```bash
koharu --cpu
```

Download runtime packages ahead of time:

```bash
koharu --download
```

Start with explicit debug logging:

```bash
koharu --debug
```
