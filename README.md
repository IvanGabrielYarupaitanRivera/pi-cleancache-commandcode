# pi-cleancache-commandcode 🧊

**CleanCache bridge for CommandCode API** — un proveedor custom de [Pi](https://pi.dev) que optimiza el **Prefix Caching** de DeepSeek cuando usas el proxy de CommandCode.

## El Problema

| Métrica | DeepSeek API directa | CommandCode proxy (crudo) | CommandCode + CleanCache |
|---------|---------------------|--------------------------|--------------------------|
| Cache Hit Rate (CH) | 90–97 % | ~30 % | **~42–49 %** ✅ |
| Overhead por turno | ~100–300 tokens | ~16 000 tokens | **~1.5–2k tokens** ✅ |
| Coste acumulado (4 turnos) | ~$0.002 | ~$0.32 | **~$0.005** ✅ |

CommandCode destruye el prefix caching por tres razones:

1. **Inyecciones dinámicas en el system prompt** — cada turno añade logs de arquitectura o telemetría.
2. **Metadatos en tools[]** — campos extra que cambian entre requests.
3. **Background tracking loops** — el modelo "Taste‑1" fuerza cache misses.

## Solución

El extension registra un provider custom (`cleancache`) con una capa de streaming **cache‑optimizada** que:

1. ❄️ **Congela el system prompt** — el mismo string estático en cada request.
2. ❄️ **Congela las tool definitions** — ordenadas alfabéticamente, sin campos efímeros.
3. 🧹 **Limpia metadatos dinámicos** — ni session IDs, ni timestamps, ni architecture logs.

Cada request comparte un **prefijo byte‑idéntico** para la parte inmutable del payload. El historial de conversación, por su naturaleza acumulativa, inevitablemente cambia entre turnos, lo que limita el cache hit rate a ~50% en sesiones típicas.

## Resultados reales: CleanCache vs DeepSeek directo

Comparativa controlada con 4 prompts idénticos (`hola`, herramientas, modelo, versión):

### CleanCache (CommandCode proxy)

| Turno | ↑ input | ↓ output | R caché | CH | Coste acum. |
|-------|---------|----------|---------|------|-------------|
| 1 (hola) | 1,600 | 82 | 1,500 | 49.2% | $0.001 |
| 2 (herramientas) | 3,700 | 342 | 3,100 | 42.3% | $0.002 |
| 3 (modelo) | 6,500 | 454 | 5,100 | 42.3% | $0.003 |
| 4 (versión) | 9,800 | 640 | 7,800 | 45.0% | $0.005 |

### DeepSeek API directa (sin proxy)

| Turno | ↑ input | ↓ output | R caché | CH | Coste acum. |
|-------|---------|----------|---------|------|-------------|
| 1 (hola) | 115 | 106 | 1,800 | 94.0% | $0.000 |
| 2 (herramientas) | 295 | 372 | 3,600 | 90.9% | $0.000 |
| 3 (modelo) | 1,300 | 1,200 | 21,000 | 92.8% | $0.002 |
| 4 (versión) | 1,500 | 1,400 | 27,000 | 97.2% | $0.002 |

### Análisis

- **El proxy de CommandCode añade ~1.5-2k tokens de overhead estructural por turno** (JSON wrapper, metadatos, config) que DeepSeek directo no tiene.
- Este overhead es inevitable: no depende de CleanCache, sino de la arquitectura de `/alpha/generate`.
- A pesar del overhead, CleanCache consigue cachear ~80% de los tokens de entrada (R/↑).
- **El CH más bajo (~45% vs ~95%) no es culpa de CleanCache, sino del overhead del proxy** — la fórmula de Pi es `R/(↑+R)`, y el ↑ inflado por el proxy diluye el porcentaje.
- **Coste total: $0.005 vs $0.002** (2.5× más con proxy, pero sigue siendo insignificante para 4 turnos).

> ⚠️ **Conclusión:** CleanCache funciona — reduce el overhead del proxy de ~16k a ~1.5k tokens por turno. Pero el proxy siempre añadirá overhead que la API directa no tiene. Para máximo rendimiento de caché y mínimo coste, usa DeepSeek API directamente.

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
/model cleancache/deepseek-coder-v3
```

### Instalación permanente

```bash
pi install ./pi-cleancache-commandcode
```

### Instalación local al proyecto (compartir con el equipo)

```bash
pi install -l ./pi-cleancache-commandcode
```

## Configuración

### Variables de entorno

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `COMMANDCODE_API_KEY` | — | **Requerida.** Tu API key de CommandCode |
| `COMMANDCODE_BASE_URL` | `https://api.commandcode.ai/v1` | Endpoint de la API |
| `COMMANDCODE_MODEL` | `deepseek-coder-v3` | Modelo por defecto |

⚠️ **Legacy:** `COMMAND_CODE_API_KEY`, `COMMAND_CODE_BASE_URL` y `COMMAND_CODE_MODEL` también funcionan como fallback.

### Añadir modelos via `models.json`

```json
{
  "providers": {
    "commandcode": {
      "baseUrl": "https://api.commandcode.ai/v1",
      "apiKey": "$COMMANDCODE_API_KEY",
      "api": "cleancache-custom",
      "models": [
        {
          "id": "deepseek-coder-v3",
          "name": "DeepSeek Coder V3 (via CommandCode)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0.14, "output": 0.28, "cacheRead": 0.014, "cacheWrite": 0.14 },
          "contextWindow": 128000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

## Uso

```bash
pi
```

```
/model cleancache/deepseek-coder-v3
/cleancache
# → 🧊 CleanCache active: deepseek-coder-v3 @ https://api.commandcode.ai/v1
```

## Estructura del proyecto

```
pi-cleancache-commandcode/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts          # Entry point del extension
    ├── provider.ts       # Registro del provider y catálogo de modelos
    ├── stream.ts         # Stream wrapper cache‑optimizado
    ├── auth.ts           # OAuth / login flow para CommandCode
    └── utils.ts          # Static prompt, frozen tools, helpers
```

## Cómo funciona (detalle)

### 1. Static System Prompt

`STATIC_SYSTEM_PROMPT` en `utils.ts` reemplaza el system prompt dinámico de Pi. Cada request usa el **mismo string**. Si necesitas instrucciones custom, edítalo ahí — pero asegúrate de que sea **idéntico** para todos los requests de una sesión.

### 2. Frozen Tool Definitions

`freezeTools()`:
- Elimina campos efímeros (`eagerInputStreaming`, IDs internos)
- Ordena por `name` (orden alfabético estable)
- Devuelve `{ name, description, parameters }` siempre igual

### 3. Custom Stream Wrapper

`streamCommandCode()` en `stream.ts`:
1. Toma el `Context` de Pi y reemplaza `systemPrompt` por la versión estática
2. Congela el array `tools`
3. Construye el payload con headers estáticos y config congelada
4. Envía el request HTTP a `/alpha/generate` y parsea el stream SSE
5. Reenvía todos los eventos a Pi

### 4. Provider Payload Guard

`before_provider_request` en `index.ts` normaliza el payload **justo antes** de enviarlo, atrapando cualquier caso borde donde el serializador built-in se hubiese usado en vez de nuestro stream custom.

### 5. Limitaciones conocidas

- **Overhead estructural del proxy (~1.5-2k tokens/turno):** `/alpha/generate` envuelve cada request en un JSON con campos de configuración y metadatos que la API directa no necesita. CleanCache congela estos campos para que sean cacheables, pero no puede eliminarlos. Es un coste fijo por usar el proxy.
- **Prefix caching limitado por el historial:** el historial de conversación cambia inevitablemente entre turnos. La parte cacheable es el prefijo común (system prompt + tools + headers + config + historial hasta el punto de divergencia).
- **CH de Pi penaliza el overhead:** la fórmula `CH = R/(↑+R)` diluye el porcentaje cuando ↑ está inflado por el proxy. El ratio `R/↑` (~80%) es la métrica real de eficiencia de caché.
- **El padding de 256 tokens está desactivado en mensajes:** el tokenizador casero no coincide exactamente con el de DeepSeek. Solo se aplica padding al system prompt (que es estático y por tanto inofensivo).

## Comandos

| Comando | Descripción |
|---------|-------------|
| `/cleancache` | Muestra estado del provider CleanCache |
| `/commandcode` | Alias de `/cleancache` (comodidad) |

## Desarrollo

```bash
cd pi-cleancache-commandcode
npm install
npm run check    # type-check

# Test
COMMANDCODE_API_KEY=cc-test-... pi -e ./src/index.ts
```

## Licencia

MIT
