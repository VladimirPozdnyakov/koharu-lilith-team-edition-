---
title: CLI 参考
---

# CLI 参考

本页介绍 Koharu 桌面二进制暴露的命令行参数。

Koharu 使用同一个二进制来支持：

- 桌面启动
- 本地 HTTP API

## 常见用法

```bash
# macOS / Linux
koharu [OPTIONS]

# Windows
koharu.exe [OPTIONS]
```

## 参数

| 参数 | 含义 |
| --- | --- |
| `-d`, `--download` | 预取运行时库与默认视觉 / OCR 栈，然后退出 |
| `--cpu` | 即使检测到 GPU，也强制使用 CPU |
| `--debug` | 输出面向调试的控制台日志 |

## 行为说明

有些参数影响的不只是启动外观：

- 使用 `--download` 时，预取完依赖后即退出，不会继续常驻
- 使用 `--cpu` 时，视觉栈和本地 LLM 都不会使用 GPU 加速

## 常见模式

使用纯 CPU 推理：

```bash
koharu --cpu
```

提前下载运行时包：

```bash
koharu --download
```

显式启用调试日志：

```bash
koharu --debug
```
