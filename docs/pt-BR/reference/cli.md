---
title: Referência da CLI
---

# Referência da CLI

Esta página documenta as opções de linha de comando expostas pelo binário desktop do Koharu.

O Koharu usa o mesmo binário para:

- inicialização do desktop
- a API HTTP local

## Uso comum

```bash
# macOS / Linux
koharu [OPTIONS]

# Windows
koharu.exe [OPTIONS]
```

## Opções

| Opção | Significado |
| --- | --- |
| `-d`, `--download` | Faz o prefetch das bibliotecas de runtime e da stack padrão de visão e OCR, e então encerra |
| `--cpu` | Força o modo CPU mesmo quando uma GPU está disponível |
| `--debug` | Habilita saída de console orientada a debug |

## Notas de comportamento

Algumas flags afetam mais do que apenas a aparência inicial:

- com `--download`, o Koharu encerra após o prefetch de dependências e não permanece em execução
- com `--cpu`, tanto a stack de visão quanto o caminho do LLM local evitam aceleração por GPU

## Padrões comuns

Iniciar com inferência somente em CPU:

```bash
koharu --cpu
```

Baixar os pacotes de runtime antecipadamente:

```bash
koharu --download
```

Iniciar com logging explícito de debug:

```bash
koharu --debug
```
