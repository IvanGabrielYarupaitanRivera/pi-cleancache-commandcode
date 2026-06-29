# pi-cleancache-commandcode 🧊

**CleanCache bridge for CommandCode API** — un proveedor custom de [Pi](https://pi.dev) que optimiza el **Prefix Caching** de DeepSeek cuando usas el proxy de CommandCode.

## El Problema

| Métrica | DeepSeek API directa | CommandCode proxy (crudo) | CommandCode + CleanCache |
|---------|---------------------|--------------------------|--------------------------|
| Cache Hit Rate | 87–99 % | ~30 % | **~50 % (pico ~84 % en sesiones largas)** ✅ |
| Input tokens (query simple) | ~174 | ~16 000 | **~3 000–5 000** ✅ |
| Coste por iteración | ~$0.001 | ~$0.08 | **~$0.02–0.07** ✅ |

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

## Resultados reales

> ⚠️ El prefix caching tiene un límite fundamental: solo cachea desde el byte 0 hasta el primer byte diferente. En una conversación de múltiples turnos, el historial crece y cambia, así que **el 87-99% de la API directa no es alcanzable a través de un proxy**.

| Métrica | Resultado típico | Mejor caso (sesión larga) |
|---------|-----------------|--------------------------|
| Cache Hit Rate | ~48–50% | ~84% |
| Tokens salvados por turno | — | 125k de 148k |
| Coste por turno (148k tokens) | ~$0.074 | — |

La mejora sobre el proxy crudo (~30% → ~50%) es real pero modesta. Para máximo rendimiento de caché, usa DeepSeek API directamente.

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

- **Prefix caching limitado por el historial**: el historial de conversación cambia inevitablemente entre turnos. La parte cacheable es solo el prefijo común (system prompt + tools + headers + config), no los mensajes acumulados.
- **El proxy de CommandCode no es transparente**: `/alpha/generate` puede añadir metadatos variables fuera de nuestro control.
- **El padding de 256 tokens se desactivó por defecto**: el tokenizador casero no coincide exactamente con el de DeepSeek y el padding se filtraba a las respuestas visibles.

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
