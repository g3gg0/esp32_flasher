(function(root){
    'use strict';
    const $=id=>document.getElementById(id);
    // Generic RMT transmitter. LED protocols such as WS2812/SK6812 live in extensions/ws2812.js.
    root.ESPIO.createRMTPanel=function(ctx){
        let host=null,actionId=0;const drafts=new Map();
        const draft=()=>{const k=ctx.chip().id+':'+ctx.board().id;if(!drafts.has(k))drafts.set(k,{pin:'',port:0,resolution:20000000,idle:0});return drafts.get(k);};
        const live=()=>host?.ready&&host.controller===ctx.controller();
        const panel=document.createElement('div');panel.id='rmt-panel';panel.className='sd-panel';panel.hidden=true;
        panel.innerHTML='<div class="sd-heading"><h3>RMT · Sequenz senden</h3><span id="rmt-state" class="chip-badge">NICHT AKTIV</span></div><p id="rmt-note" class="sd-note"></p><div class="bus-config"><label>Ausgang<select id="rmt-pin"></select></label><label>TX-Kanal<select id="rmt-port"></select></label><label>Auflösung Hz<input id="rmt-resolution" type="number" value="20000000" min="100000" max="80000000"></label><label>Ruhepegel<select id="rmt-idle"><option value="0">LOW</option><option value="1">HIGH</option></select></label></div><div class="sd-actions"><button id="rmt-apply">Aktivieren</button><button id="rmt-release" hidden>Freigeben</button></div><div class="bus-config"><label>Endpause µs<input id="rmt-pause" type="number" min="0" max="1000000" value="80"></label></div><label class="rmt-sequence-field">Symbole<textarea id="rmt-sequence" rows="3" spellcheck="false" placeholder="[[1,350,0,900],[1,700,0,550]] · [Pegel, Nanosekunden, Pegel, Nanosekunden]"></textarea></label><p class="sd-note">Sequenzen entstehen in JavaScript. Upload zuerst, danach kontinuierliche Ausgabe mit lokalem Nachfüllen. Bis 4096 Byte codiert: 1024 beliebige Symbole oder 32768 Symbole aus zwei Typen. Eigene Symbole: [Pegel, ns, Pegel, ns]; lange Streams mindestens 1 µs je Symbol. LED-Protokolle (WS2812, SK6812) bietet die Extension „WS2812 / SK6812“, die den hier aktivierten RMT-Ausgang nutzt.</p><div class="sd-actions"><button id="rmt-send">Sequenz senden</button></div><pre id="rmt-result" class="bus-log" role="status"></pre>';
        $('i2c-panel').after(panel);
        function supported(){return !!ctx.controller()?.transport.supports?.('RMT');}
        function update(){
            const ready=live(),blocked=ctx.blocked()||!supported()||ctx.controller()?.fault;
            $('rmt-state').textContent=ready?`AKTIV · ${host.actualHz} Hz`:'NICHT AKTIV';
            $('rmt-note').textContent=['esp32c2','esp32c61','esp8266'].includes(ctx.chip().id)?'Dieser Chip besitzt kein RMT.':supported()?'Hardware-RMT · gemeinsamer Streaming-Treiber.':'Beschleunigten Stub mit RMT-Unterstützung laden.';
            for(const key of ['pin','port','resolution','idle'])$('rmt-'+key).disabled=blocked||ready;
            $('rmt-apply').disabled=blocked||ready||draft().pin==='';$('rmt-release').hidden=!ready;$('rmt-release').disabled=blocked;
            for(const key of ['send','pause','sequence'])$('rmt-'+key).disabled=blocked||!ready;
        }
        function render(selected){
            panel.hidden=selected!=='rmt';const d=draft();
            $('rmt-pin').replaceChildren(new Option('Bitte wählen …',''));for(const id of ctx.pins().slice().sort((a,b)=>a-b))$('rmt-pin').add(ctx.gpioOption(id));
            const count=['esp32'].includes(ctx.chip().id)?8:['esp32s2','esp32s3','esp32p4'].includes(ctx.chip().id)?4:2;
            $('rmt-port').replaceChildren();for(let i=0;i<count;i++)$('rmt-port').add(new Option(`TX ${i}`,i));if(d.port>=count)d.port=0;
            for(const key of ['pin','port','resolution','idle'])$('rmt-'+key).value=String(d[key]);update();
        }
        for(const key of ['pin','port','resolution','idle'])$('rmt-'+key).addEventListener('change',()=>{draft()[key]=$('rmt-'+key).value===''?'':Number($('rmt-'+key).value);update();});
        async function action(task){
            if(ctx.blocked()||!supported())return;const token=++actionId;ctx.setOperation(true);
            try{
                if(task==='release'){await host?.close();host=null;$('rmt-result').textContent='Freigegeben.';}
                else if(task==='apply'){host=new root.ESPIO.RMTHost(ctx.controller());await host.open(draft());$('rmt-result').textContent=`Bereit · ${host.actualHz} Hz`;}
                else{
                    const pulses=JSON.parse($('rmt-sequence').value);if(!Array.isArray(pulses))throw new Error('Symbol-Liste eingeben.');
                    const sequence=Uint32Array.from(pulses,p=>{if(!Array.isArray(p)||p.length!==4)throw new Error('[Pegel, ns, Pegel, ns] erwartet.');return root.ESPIO.rmtSymbol(p[0],Math.round(p[1]*host.actualHz/1e9),p[2],Math.round(p[3]*host.actualHz/1e9));});
                    $('rmt-result').textContent='Sequenz hochladen und senden …';const r=await host.send(sequence,{idleUs:Number($('rmt-pause').value)});
                    $('rmt-result').textContent=`Gesendet · ${r.values[0]} Symbole · ${r.values[1]} Nachfüllungen · ${r.values[2]} µs`;
                }
            }catch(e){if(token===actionId){$('rmt-result').textContent=e.message;ctx.log('RMT:',e.message);}}finally{if(token===actionId){ctx.setOperation(false);update();}}
        }
        for(const task of ['apply','release','send'])$('rmt-'+task).addEventListener('click',()=>action(task));
        return{render,update,host:()=>live()?host:null,reset(){++actionId;host=null;},role(id){return live()&&host.config.pin===id?'RMT TX':'';}};
    };
})(globalThis);
