#!/bin/bash
cd "C:/Users/Admin/pi-cleancache-commandcode"
export COMMANDCODE_API_KEY="user_3G4B8GKPZN35FaAQpbTHW9BtrAqKDZzvrZ97xkGxzJhwyAYP6DnEhwU1EoJdXWWo2PRaMGQSw2qfaYqpYFBMCmM2"

echo "=== 3 identical requests — checking input size consistency ==="
for i in 1 2 3; do
  input=$(pi --mode json -e "./src/index.ts" --model "cleancache/deepseek/deepseek-v4-flash" -p "test" 2>&1 | node -e "
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
            if(u) console.log((u.input||0)+','+(u.cacheRead||0)+','+(u.cacheWrite||0));
            break;
          }
        } catch(e){}
      }
    })")
  echo "  Request $i: input=$input"
done
