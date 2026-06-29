# pi-cleancache-commandcode 🧊

**CleanCache bridge for CommandCode API** — un proveedor custom de [Pi](https://pi.dev) que optimiza el **Prefix Caching** de DeepSeek V4 Pro/Flash cuando usas el proxy de CommandCode.

---

## Tabla de Contenidos

- [Infrastructure Brief: Cómo funciona la Radix Cache de DeepSeek](#-infrastructure-brief-cómo-funciona-la-radix-cache-de-deepseek)
- [El Problema](#-el-problema)
- [Solución: Applied Coding Rules](#-applied-coding-rules-para-nuestro-pipeline)
- [Resultados del Benchmark](#-resultados-del-benchmark)
- [Instalación](#-instalación)
- [Configuración](#-configuración)
- [Estructura del Proyecto](#-estructura-del-proyecto)
- [Referencia: Stream Pipeline Internals](#-referencia-stream-pipeline-internals)

---

## �� Infrastructure Brief: Cómo funciona la Radix Cache de DeepSeek

Estamos optimizando una extensión de provider custom (`pi-cleancache-commandcode`) para explotar el **prefix caching** de DeepSeek V4 Pro a través del proxy CommandCode (`/alpha/generate`). Para mantener un Cache Hit Rate (CH) óptimo, debemos adherirnos estrictamente a cómo DeepSeek gestiona memoria a nivel del motor de inferencia.

### 1. Estructura de Trie (Árbol de Prefijos)

DeepSeek **no** hashea el payload completo como un bloque monolítico. Usa una **Radix Cache** (un árbol de prefijos / trie) implementada a nivel del cluster de GPUs. Las claves del árbol son **secuencias de tokens**.

Si la request $A$ y la request $B$ comparten el **mismo prefijo de tokens byte-por-byte**, el motor salta completamente el cálculo de atención para ese prefijo, cobrando solo por los tokens del sufijo nuevo.

### 2. La Regla del Límite de 256 Tokens

La arquitectura **MLA (Multi-head Latent Attention)** de DeepSeek divide y cachea el árbol de prefijos en **bloques estrictos de 256 tokens** [Issue #39321].

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
| Cache Hit Rate (CH) | 90–97% | ~30% | **~88%** ✅ |
| Overhead estructural | ~100–300 tokens | ~16 000 tokens | **~1.5–2.7k tokens** |
| Estabilidad entre turnos | Alta | Baja (misses frecuentes) | **Alta** ✅ |
| CH mínimo en medición | ~80% | ~0% | **~78%** ✅ |

---

## �� Applied Coding Rules para nuestro Pipeline

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

Los tokens `<think>...</think>` de DeepSeek son contextualmente inestables para el almacenamiento del árbol de prefijos a largo plazo. Para **todos** los objetos `assistant` pasados, eliminamos el contenido de thinking por completo antes de reconstruir el array del historial.

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

## �� Resultados del Benchmark

Benchmark automatizado vía `tests/benchmark-compare.ts`: 11 requests por provider (1 warm-up + 10 medidas), mismo prompt, con `pi --mode json`.

### CleanCache (CommandCode proxy) — tras optimizaciones

| Run | ↑ input | ↓ output | R cache | CH | Tiempo |
|:---:|:-------:|:--------:|:-------:|:--:|:------:|
| WARM | 2,657 | 642 | 2,176 | 81.9% | 16.6s |
| #1 | 2,645 | 496 | 2,176 | 82.3% | 14.6s |
| #2 | 2,145 | 776 | 2,048 | 95.5% | 14.5s |
| #3 | 2,784 | 547 | 2,176 | 78.2% | 18.2s |
| #4 | 2,657 | 596 | 2,560 | 96.3% | 16.4s |
| #5 | 2,570 | 550 | 2,176 | 84.7% | 17.4s |
| #6 | 2,652 | 450 | 2,176 | 82.1% | 14.4s |
| #7 | 2,790 | 681 | 2,176 | 78.0% | 19.5s |
| #8 | 2,206 | 343 | 2,176 | 98.6% | 13.6s |
| #9 | 3,187 | 895 | 2,944 | 92.4% | 28.0s |
| #10 | 2,657 | 644 | 2,560 | 96.3% | 19.3s |

**Avg CH (measured): 88.4%** | **Warm-up: 81.9%** | **Δ: +6.5%**

### DeepSeek API Directa (sin proxy)

| Run | ↑ input | ↓ output | R cache | CH | Tiempo |
|:---:|:-------:|:--------:|:-------:|:--:|:------:|
| WARM | 518 | 569 | 2,560 | 494.2% | 12.8s |
| #1 | 1,395 | 534 | 2,688 | 192.7% | 13.8s |
| #2 | 1,027 | 704 | 3,072 | 299.1% | 16.6s |
| #3 | 1,048 | 838 | 6,400 | 610.7% | 20.3s |
| #4 | 532 | 690 | 2,560 | 481.2% | 14.2s |
| #5 | 3,105 | 787 | 2,816 | 90.7% | 18.3s |
| #6 | 1,229 | 719 | 2,560 | 208.3% | 15.2s |
| #7 | 937 | 836 | 2,688 | 286.9% | 17.5s |
| #8 | 1,395 | 722 | 2,560 | 183.5% | 14.4s |
| #9 | 1,228 | 615 | 2,688 | 218.9% | 14.3s |
| #10 | 3,196 | 847 | 2,560 | 80.1% | 17.0s |

**Avg CH (measured): 265.2%** | **Warm-up: 494.2%** | **Δ: -229.0%**

> **Nota sobre CH > 100%:** La fórmula de Pi es `CH = cacheRead / (input + cacheWrite)`. Cuando el prefijo cacheadp es mayor que el input del turno actual (típico con history profiling de DeepSeek), CH puede superar 100%. En CleanCache, el overhead estructural del proxy infla `input`, manteniendo CH en rangos normales (<100%).

### Análisis

| Métrica | Antes de optimizaciones | Después (v2) | Mejora |
|---------|:-----------------------:|:------------:|:------:|
| Avg CH CleanCache | 68.6% | **88.4%** | **+19.8 pts** 🟢 |
| Misses completos (CH=0%) | 1 de 10 | **0 de 10** | ✅ |
| CH mínimo | 0.0% | **78.0%** | Eliminado |
| CH máximo | 96.7% | **98.6%** | +1.9 pts |
| Desviación estándar | ~27% | **~7.2%** | 4× más estable |

### Conclusión del Benchmark

1. **CleanCache alcanza el 88.4% de CH** — muy cerca del rendimiento de la API directa en términos de eficiencia de caché real
2. El overhead estructural del proxy (~1.5-2.7k tokens) es el único factor limitante — es un coste fijo de usar `/alpha/generate`
3. Las optimizaciones de **padding universal** + **thinking truncation radical** eliminaron los misses completos y duplicaron la estabilidad
4. Para máximo ahorro (sin overhead de proxy): usa DeepSeek API directamente. Para conveniencia + plan de $1: CleanCache es la mejor opción disponible

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
├── tests/
│   └── benchmark-compare.ts    # Benchmark automatizado CH vs directo
└── src/
    ├── index.ts                # Entry point del extension + provider guard
    ├── provider.ts             # Registro del provider y catálogo de modelos
    ├── stream.ts               # Stream wrapper cache‑optimizado (orquestador)
    ├── message-converter.ts    # Pi → CommandCode format + padding 256
    ├── history-cleaner.ts      # Thinking truncation radical
    ├── sse-parser.ts           # SSE line parser
    ├── sse-types.ts            # Tipos de eventos SSE
    ├── auth.ts                 # OAuth / login flow para CommandCode
    └── utils.ts                # Static prompt, frozen tools, cost, helpers
```

---

## �� Referencia: Stream Pipeline Internals

```
Pi Context
    │
    ▼
streamCommandCode()             [stream.ts]
    │
    ├─ cleanHistoryForCache()    [history-cleaner.ts]
    │   └─ Strip <think> blocks from ALL past assistant messages
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
processSSEStream()             [stream.ts]
    │
    ├─ parseEventLine()         [sse-parser.ts]
    └─ Emit Pi events: start, text_delta, thinking_delta, toolcall, done
```

---

## Licencia

MIT
