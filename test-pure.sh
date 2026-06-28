#!/bin/bash
# Pure prefix cache test
cd "C:/Users/Admin/pi-cleancache-commandcode" || exit 1

MODEL="cleancache/deepseek/deepseek-v4-flash"
PROMPT="What is 2+2 Just answer the number"
RUNS=8

echo "============================================================"
echo "🧊 CleanCache — Pure Prefix Cache Test"
echo "============================================================"
echo "Model:  $MODEL"
echo "Prompt: $PROMPT"
echo "Runs:   $RUNS (1 warm-up + $((RUNS-1)) measured)"
echo ""

for i in $(seq 1 $RUNS); do
  printf "  [%d/%d] ... " "$i" "$RUNS"
  # Pipe through Node.js which handles OSC escape sequences correctly
  input=$(pi --mode json -e "./src/index.ts" --model "$MODEL" -p "$PROMPT" 2>&1 | node -e "
    let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const lines = d.split('\\n');
      for(const l of lines){
        const clean = l.replace(/\\u001b\\][0-9]+;.*?\\u0007/g,'');
        try {
          const evt = JSON.parse(clean);
          if(evt.type === 'message_end' && evt.message?.role === 'assistant') {
            const u = evt.message.usage;
            if(u && (u.input || u.cacheRead || u.output))
              console.log(u.input+','+u.cacheRead+','+u.cacheWrite+','+u.output);
            break;
          }
        } catch(e){}
      }
    })")
  if [ -z "$input" ] || [ "$input" = "" ]; then
    echo "❌ no usage"
    continue
  fi
  IFS=',' read -r inp cr cw out <<< "$input"
  if [ "$inp" = "0" ] && [ "$out" = "0" ]; then
    echo "❌ no usage"
    continue
  fi
  ch=$(node -e "console.log(($cr * 100 / ($inp + $cw)).toFixed(1))" 2>/dev/null || echo "0")
  printf "↑%s R%s CH%s%%\n" "$inp" "$cr" "$ch"
done

echo ""
echo "Done."
