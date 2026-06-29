# pi-cleancache-commandcode 🧊

**CleanCache bridge for CommandCode API** — un proveedor custom de [Pi](https://pi.dev) que optimiza el **Prefix Caching** de DeepSeek V4 Pro/Flash cuando usas el proxy de CommandCode.

---

## Tabla de Contenidos

- [Infrastructure Brief: Cómo funciona la Radix Cache de DeepSeek](#-infrastructure-brief-cómo-funciona-la-radix-cache-de-deepseek)
- [El Problema](#-el-problema)
- [Solución: Applied Coding Rules](#-applied-coding-rules-para-nuestro-pipeline)
- [Resultados del Benchmark](#-resultados-del-benchmark)
- [Benchmark Avanzado (multi-prompt)](#-benchmark-avanzado-multi-prompt)
- [Instalación](#-instalación)
- [Configuración](#-configuración)
- [Estructura del Proyecto](#-estructura-del-proyecto)
- [Referencia: Stream Pipeline Internals](#-referencia-stream-pipeline-internals)

---

## Infrastructure Brief: Cómo funciona la Radix Cache de DeepSeek

Estamos optimizando una extensión de provider custom (`pi-cleancache-commandcode`) para explotar el **prefix caching** de DeepSeek V4 Pro a través del proxy CommandCode (`/alpha/generate`). Para mantener un Cache Hit Rate (CH) óptimo, debemos adherirnos estrictamente a cómo DeepSeek gestiona memoria a nivel del motor de inferencia.

### 1. Estructura de Trie (Árbol de Prefijos)

DeepSeek **no** hashea el payload completo como un bloque monolítico. Usa una **Radix Cache** (un árbol de prefijos / trie) implementada a nivel del cluster de GPUs. Las claves del árbol son **secuencias de tokens**.

Si la request $A$ y la request $B$ comparten el **mismo prefijo de tokens byte-por-byte**, el motor salta completamente el cálculo de atención para ese prefijo, cobrando solo por los tokens del sufijo nuevo.

### 2. La Regla del Límite de 256 Tokens

La arquitectura **MLA (Multi-head Latent Attention)** de DeepSeek divide y cachea el árbol de prefijos en **bloques estrictos de 256 tokens**.

Si el historial cambia aunque sea un solo byte o espacio, o si un desplazamiento intermedio de tokens hace que el conteo total caiga fuera de un límite de alineación de 256 tokens, el motor de caché sufre un **miss completo** para todos los bloques posteriores en esa rama.

### 3. La Inmutabilidad del Pasado

Una vez que un mensaje es enviado y cacheadp, su **huella exacta de tokens** debe permanecer idéntica en todos los turnos multi-turno futuros. Si inyectamos padding dinámicamente a través de todos los mensajes pasados, sus longitudes mutan entre turnos, destruyendo los hashes Radix que construimos.

---

## El Problema

Cuando se usa el proxy CommandCode directamente (sin CleanCache), el prefix caching se degrada por tres razones:

| Problema | Impacto en CH |
|----------|:-------------:|
| 1. **Inyecciones dinámicas en el system prompt** — cada turno añade logs de arquitectura, fecha/hora, directorio de trabajo | Miss completo cada turno |
| 2. **Metadatos en tools[]** — campos extra (`eagerInputStreaming`, `inputSchema`) que cambian entre requests | Miss en el bloque de tools |
| 3. **Background tracking loops** — el modelo "Taste‑1" fuerza cache misses al mutar el payload | Miss sistémico ~70% |

### Comparativa

| Métrica | DeepSeek API directa | CommandCode proxy (crudo) | CommandCode + CleanCache |
|---------|:--------------------:|:-------------------------:|:------------------------:|
| Cache Hit Rate (CH) | 90–99% | ~30% | **~99%** ✅ |
| Overhead estructural | ~100–300 tokens | ~16 000 tokens | **~1.5k tokens** |
| Estabilidad entre turnos | Alta | Baja (misses frecuentes) | **Alta** ✅ |
| CH mínimo en medición | ~80% | ~0% | **~98%** ✅ |

---

## Applied Coding Rules para nuestro Pipeline

### Regla 1: Autonomous Padding (por mensaje, no global)

**Nunca** computes padding global basado en el payload total en runtime. En su lugar, aplica `alignMessageForCache()` para **cada bloque de mensaje individual** al momento de construirlo.

```typescript
// ✅ Correcto — cada mensaje se alinea a 256 tokens individualmente
content = alignMessageForCache(content)

// ❌ Incorrecto — el padding global muta cuando el historial crece
payload = payload + padTo256(countTokens(payload))
```

Esto asegura que cada bloque se fije en un límite limpio de 256 tokens que **nunca altera su firma de bytes** cuando se desplaza hacia abajo en el array del historial de conversación (`messagesToCC`).

### Regla 2: Padding Universal

No solo los mensajes `user` — **todos** los mensajes (`user`, `assistant`, `tool`) reciben `alignMessageForCache()` en su contenido de texto/reasoning. El padding es una función determinista del contenido solo, por lo que cada reconstrucción del mismo estado conversacional produce mensajes byte-idénticos.

### Regla 3: Strict Thinking Truncation (Radical)

Los tokens `thinking...` de DeepSeek son contextualmente inestables para el almacenamiento del árbol de prefijos a largo plazo. Para **todos** los objetos `assistant` pasados, eliminamos el contenido de thinking por completo antes de reconstruir el array del historial.

No importa si es el último assistant o no — todos los mensajes assistant **en el historial** son pasados del turno anterior. El assistant actual se está streameando y no está en el array en el momento de la siguiente request.

```typescript
// ✅ Correcto — strip thinking de TODOS los assistant
messages.map(msg => {
  if (msg.role !== 'assistant') return msg;
  return { ...msg, content: msg.content.filter(b => b.type !== 'thinking') };
});

// ❌ Incorrecto — dejar thinking en el último assistant
if (idx !== lastAssistantIdx) { /* ... */ }
```

### Regla 4: Frozen Prefix

El **prefijo completo inmutable** (system prompt + tools + config + headers) debe ser byte-idéntico en cada request:

- `STATIC_SYSTEM_PROMPT` — mismo string siempre
- `STATIC_CONFIG` — fecha congelada en `2026-01-01`, sin datos de entorno
- `freezeTools()` — ordenados alfabéticamente, sin campos efímeros
- `deterministicStringify()` — JSON con keys ordenadas para evitar reordenamiento del proxy

---

## Resultados del Benchmark

Benchmark automatizado vía `tests/benchmark-compare.ts`: 11 requests por provider (1 warm-up + 10 medidas), mismo prompt, con `pi --mode json`.

### CleanCache (CommandCode proxy) — estado actual

| Run | ↑ input | ↓ output | R cache | CH | Tiempo |
|:---:|:-------:|:--------:|:-------:|:--:|:------:|
| WARM | 1,569 | 69 | 1,536 | **97.9%** | 24.9s |
| #1 | 1,569 | 64 | 1,568 | **99.9%** | 17.9s |
| #2 | 1,569 | 73 | 1,568 | **99.9%** | 16.3s |
| #3 | 1,569 | 71 | 1,568 | **99.9%** | 14.8s |
| #4 | 1,569 | 71 | 1,568 | **99.9%** | 10.8s |
| #5 | 1,569 | 70 | 1,568 | **99.9%** | 9.4s |
| #6 | 1,569 | 67 | 1,568 | **99.9%** | 15.6s |
| #7 | 1,569 | 67 | 1,536 | **97.9%** | 16.9s |
| #8 | 1,569 | 71 | 1,568 | **99.9%** | 14.8s |
| #9 | 1,569 | 74 | 1,568 | **99.9%** | 9.7s |
| #10 | 1,569 | 71 | 1,568 | **99.9%** | 20.3s |

**Avg CH (measured): 99.7%** | **Warm-up: 97.9%** | **Δ: +1.8%**

### DeepSeek API Directa (sin proxy)

| Run | ↑ input | ↓ output | R cache | CH | Tiempo |
|:---:|:-------:|:--------:|:-------:|:--:|:------:|
| WARM | 128 | 68 | 1,792 | **1,400%** | 14.6s |
| #1–#10 | ~128 | ~70 | 1,792 | **1,400%** | ~14s |

> **Nota sobre CH > 100%:** DeepSeek cachea el system prompt completo. El `cacheRead` (1,792 tokens) incluye tokens que no se contabilizan como `input` (sistema + profiling). La fórmula `CH = cacheRead / (input + cacheWrite)` puede dar >100%. CleanCache añade un overhead estructural fijo (~1,441 tokens) que mantiene el CH en rangos normales.

### Análisis

| Métrica | Antes de v2 | Después (v3) | Mejora |
|---------|:-----------:|:------------:|:------:|
| Avg CH CleanCache | 68.6% | **99.7%** | **+31.1 pts** 🟢 |
| Misses (CH < 50%) | 3 de 10 | **0 de 10** | ✅ |
| CH mínimo | 0.0% | **97.9%** | Eliminado |
| CH máximo | 98.6% | **99.9%** | +1.3 pts |
| Desviación estándar | ~27% | **~0.8%** | 34× más estable |
| Input fijo (cachable) | variable | **1,569** | Sí ✅ |

El **overhead estructural del proxy** (~1.5k tokens) es el único factor limitante — es un coste fijo de usar `/alpha/generate`. Pero **ese overhead se cachea al 99.9%**, por lo que en la práctica el coste recurrente es mínimo.

---

## Benchmark Avanzado (multi-prompt)

Además del test simple, el proyecto incluye un **benchmark multi-prompt** con 10 escenarios variados (short, medium, long) que reporta medianas en vez de promedios.

### Uso

```bash
# Un solo provider
python benchmark/runner.py --provider cleancache --runs 3

# Comparación directa
python benchmark/runner.py --provider cleancache --provider deepseek --runs 3

# Salida JSON estructurada en benchmark/results/
```

### Resultados recientes (CleanCache, 8 prompts × 3 runs c/u)

| Categoría | Prompt | Median CH | Mediana latencia |
|-----------|--------|:---------:|:---------------:|
| **SHORT** | List files | **99.9%** | 13s |
| | What is 2+2? | **99.9%** | 6s |
| | Bash find command | **90.8%** | 11s |
| **MEDIUM** | LIS Python function | **99.0%** | 40s |
| | REST vs GraphQL | **98.8%** | 18s |
| | Refactor JS → async/await | **99.9%** | 42s |
| | SQLite vs PostgreSQL | **90.7%** | 11s |
| **LONG** | Express CRUD API | **89.7%** | 85s |
| | **Overall** | **~97%** | — |

> CleanCache mantiene CH > 89% incluso en prompts largos y complejos de generación de código.

---

## Instalación

### Prerrequisitos

- Pi `≥ 0.80.0`
- Node.js `≥ 18`
- Una API key de CommandCode

### Test rápido (efímero)

```bash
export COMMANDCODE_API_KEY=cc-tu-key-here
pi -e ./src/index.ts
```

Dentro de Pi:

```
/model cleancache/deepseek-v4-flash
```

### Instalación permanente

```bash
pi install ./pi-cleancache-commandcode
```

### Instalación local al proyecto (compartir con el equipo)

```bash
pi install -l ./pi-cleancache-commandcode
```

---

## Configuración

### Variables de entorno

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `COMMANDCODE_API_KEY` | — | **Requerida.** Tu API key de CommandCode |
| `COMMANDCODE_BASE_URL` | `https://api.commandcode.ai` | Endpoint base de la API |
| `DEEPSEEK_API_KEY` | — | Para benchmark comparativo directo |

⚠️ **Legacy:** `COMMAND_CODE_API_KEY`, `COMMAND_CODE_BASE_URL` también funcionan como fallback.

---

## Estructura del Proyecto

```
pi-cleancache-commandcode/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore
├── benchmark/                   # Benchmark multi-prompt avanzado
│   ├── scenarios.yaml           # 10 prompts (short, medium, long)
│   ├── runner.py                # Orquestador con medianas y reporte JSON
│   └── results/                 # Reportes generados (gitignored)
├── tests/
│   ├── benchmark-compare.ts     # Benchmark simple CH vs directo
│   └── ...                      # Tests heredados
└── src/
    ├── index.ts                 # Entry point del extension + provider guard
    ├── provider.ts              # Registro del provider y catálogo de modelos
    ├── stream.ts                # Stream wrapper cache‑optimizado (SSEProcessor)
    ├── message-converter.ts     # Pi → CommandCode format + padding 256
    ├── history-cleaner.ts       # Thinking truncation radical
    ├── sse-parser.ts            # SSE line parser
    ├── sse-types.ts             # Tipos de eventos SSE
    ├── auth.ts                  # OAuth / login flow para CommandCode
    └── utils.ts                 # Static prompt, frozen tools, cost, helpers
```

---

## Referencia: Stream Pipeline Internals

```
Pi Context
    │
    ▼
streamCommandCode()             [stream.ts]
    │
    ├─ cleanHistoryForCache()    [history-cleaner.ts]
    │   └─ Strip thinking blocks from ALL past assistant messages
    │
    ├─ messagesToCC()           [message-converter.ts]
    │   ├─ user     → alignMessageForCache() + sanitise()
    │   ├─ assistant → alignMessageForCache() por cada bloque text/reasoning
    │   └─ tool     → alignMessageForCache() en output
    │
    ├─ promptTo256Padding()     [utils.ts]
    │   └─ Pads system prompt a 256 tokens
    │
    ├─ freezeTools()            [utils.ts]
    │   └─ Alphabetical sort, no ephemeral fields
    │
    ├─ deterministicStringify() [utils.ts]
    │   └─ JSON con keys ordenadas
    │
    ├─ buildHeaders()           [utils.ts]
    │   ├─ x-taste-learning: false
    │   ├─ x-project-slug: cleancache-static
    │   └─ x-raw-payload: true
    │
    ▼
HTTP POST → /alpha/generate
    │
    ▼
SSEProcessor                    [stream.ts]
    │
    ├─ handleEvent()            Process each SSE event (text, thinking, tool, finish)
    ├─ emitStart() / emitDone() / emitError()
    └─ Emit Pi events: start, text_delta, thinking_delta, toolcall, done
```

---

## Licencia

MIT
