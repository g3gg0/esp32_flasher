(function(root){
    'use strict';const $=id=>document.getElementById(id),hex=n=>'0x'+n.toString(16).toUpperCase();
    root.ESPIO.createFlashPanel=function(ctx){
        let host=null,cancel=null;const panel=document.createElement('div');panel.id='flash-panel';panel.className='sd-panel';panel.hidden=true;
        panel.innerHTML='<div class="sd-heading"><h3>FLASH · SPI-NOR</h3><span id="flash-state" class="chip-badge">NICHT ERKANNT</span></div><p id="flash-info" class="sd-note">Flash erkennen, um Größe und verfügbare Bereiche zu bestimmen. Der Stub selbst läuft vollständig im RAM.</p><div class="sd-actions"><button id="flash-probe">Flash erkennen / Status</button></div><div class="bus-config"><label>Startadresse (Byte)<input id="flash-address" value="0x0"></label><label>Länge (Byte)<input id="flash-length" value="0x1000"></label></div><div class="sd-actions"><button id="flash-download">Bereich herunterladen</button><button id="flash-check">CRC32 / Leerprüfung</button><button id="flash-erase">Bereich löschen</button><button id="flash-erase-all">Gesamten Flash löschen</button></div><p class="sd-note">Lesen/Prüfen: 4-Byte-Grenzen. Löschen: 4096-Byte-Sektoren. Löschen entfernt vorhandene Daten im angezeigten Bereich.</p><div class="bus-config"><label>Binärdatei<input id="flash-file" type="file" accept=".bin,.img,application/octet-stream"></label><label><input id="flash-auto-erase" type="checkbox" checked>Sektoren löschen, Randbytes erhalten</label><label><input id="flash-auto-verify" type="checkbox" checked>Nach Schreiben rücklesen und prüfen</label></div><p id="flash-file-info" class="sd-note">Datei auswählen; geschrieben wird ab der Startadresse oben.</p><div class="sd-actions"><button id="flash-write">Datei schreiben</button><button id="flash-verify">Mit Datei vergleichen</button><button id="flash-cancel" hidden>Abbrechen</button></div><pre id="flash-result" class="bus-log" role="status"></pre>';
        $('i2c-panel').after(panel);
        const live=()=>host?.controller===ctx.controller()&&host.info;
        function update(){
            const blocked=ctx.blocked()||!ctx.controller()?.transport.supports?.('FLASH')||ctx.controller()?.fault;
            $('flash-probe').disabled=blocked;
            for(const action of ['download','check','erase','erase-all'])$('flash-'+action).disabled=blocked||!live();
            if(live()&&host.info.capacity<host.info.size){$('flash-erase-all').disabled=true;$('flash-erase-all').title='Gesamtlöschung erst mit Unterstützung der vollständigen Chipgröße verfügbar.';}
            else $('flash-erase-all').title='';
            for(const action of ['write','verify'])$('flash-'+action).disabled=blocked||!live()||!$('flash-file').files.length;
            for(const field of ['address','length','file','auto-erase','auto-verify'])$('flash-'+field).disabled=blocked;
            $('flash-cancel').hidden=!cancel;$('flash-cancel').disabled=!cancel||cancel.signal.aborted;
            const file=$('flash-file').files[0];$('flash-file-info').textContent=file?`${file.name} · ${file.size.toLocaleString('de-DE')} Bytes ab ${$('flash-address').value}. Beim Löschen vor dem Schreiben bleiben Randbytes erhalten.`:'Datei auswählen; geschrieben wird ab der Startadresse oben.';
        }
        function number(id){const s=$(id).value.trim();if(!/^(0x[0-9a-f]+|\d+)$/i.test(s))throw new Error('Adresse/Länge als Dezimalzahl oder 0x-Hex eingeben.');return Number(s);}
        async function action(task){
            if(ctx.blocked())return;
            let picker,fileWriter;const output=[],file=$('flash-file').files[0];let address,length;
            try{
                address=task==='probe'?0:number('flash-address');length=task==='probe'?0:number('flash-length');
                if(task==='erase-all'){address=0;length=host.info.capacity;}
                if(task!=='probe')host.range(address,['write','verify'].includes(task)?file.size:length,['write','verify'].includes(task)?1:task.startsWith('erase')?4096:4);
                if(task.startsWith('erase')&&!window.confirm(`${hex(address)} bis ${hex(address+length-1)} (${length.toLocaleString('de-DE')} Bytes) dauerhaft löschen?`))return;
                if(task==='download'&&window.showSaveFilePicker)picker=window.showSaveFilePicker({suggestedName:`flash-${ctx.chip().id}-${hex(address)}.bin`,types:[{description:'Flash-Abbild',accept:{'application/octet-stream':['.bin']}}]});
            }catch(e){$('flash-result').textContent=e.message;return;}
            cancel=new AbortController();const signal=cancel.signal;ctx.setOperation(true);$('flash-result').textContent='Flash-Vorgang läuft …';
            const progress=(done,total)=>{$('flash-result').textContent=`${task}: ${done.toLocaleString('de-DE')} / ${total.toLocaleString('de-DE')} Bytes · ${(done/total*100).toFixed(1)} %`;};
            try{
                if(task==='probe'){
                    $('flash-state').textContent='NICHT ERKANNT';$('flash-info').textContent='Flash wird erkannt …';
                    host=new root.ESPIO.FlashHost(ctx.controller());const info=await host.probe({onStage:(step,name)=>{$('flash-result').textContent=`Flash-Erkennung ${step}: ${name}`;ctx.log('FLASH:',`Erkennung ${step}: ${name}`);}});$('flash-state').textContent=`${(info.size/1048576).toLocaleString('de-DE')} MiB`;
                    $('flash-info').textContent=`JEDEC ${hex(info.id)} · Status ${hex(info.status)} · ${info.size.toLocaleString('de-DE')} Bytes · ${info.sector} Byte/Sektor · ${info.page} Byte/Seite${info.capacity<info.size?' · aktueller Treiber: erste 16 MiB':''}`;
                    $('flash-result').textContent='Flash erkannt. Lesen, Schreiben, Löschen und Prüfen verfügbar.';
                }else if(task==='download'){
                    if(picker)fileWriter=await(await picker).createWritable();
                    const sink=fileWriter||{write:async bytes=>output.push(bytes)};
                    await host.download(address,length,sink,{signal,onProgress:progress});
                    if(fileWriter){await fileWriter.close();fileWriter=null;}else{const url=URL.createObjectURL(new Blob(output,{type:'application/octet-stream'})),a=document.createElement('a');a.href=url;a.download=`flash-${ctx.chip().id}-${hex(address)}.bin`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
                    $('flash-result').textContent=`Download fertig · ${length.toLocaleString('de-DE')} Bytes.`;
                }else if(task==='check'){
                    const result=await host.check(address,length,{signal,onProgress:progress});
                    $('flash-result').textContent=(result.first===null?'Leer (alle Bytes FF)':`Nicht leer · erstes Byte bei ${hex(result.first)}`)+'\n'+result.chunks.map(c=>`${hex(c.address)} · ${c.length} Bytes · CRC32 ${hex(c.crc)}`).join('\n');
                }else if(task.startsWith('erase')){await host.erase(address,length,{signal,onProgress:progress});$('flash-result').textContent=`Gelöscht · ${length.toLocaleString('de-DE')} Bytes.`;}
                else if(task==='write'){await host.program(address,file,{erase:$('flash-auto-erase').checked,verify:$('flash-auto-verify').checked,signal,onProgress:progress});$('flash-result').textContent=`Geschrieben · ${file.size.toLocaleString('de-DE')} Bytes${$('flash-auto-verify').checked?' · Rücklesevergleich OK':''}.`;}
                else{await host.verify(address,file,{signal,onProgress:progress});$('flash-result').textContent=`Vergleich OK · ${file.size.toLocaleString('de-DE')} Bytes.`;}
            }catch(e){if(fileWriter)try{await fileWriter.abort();}catch{}$('flash-result').textContent=e.message+(['write','erase','erase-all'].includes(task)?' Bereits abgeschlossene Schreib-/Löschschritte bleiben wirksam.':'');ctx.log('FLASH:',e.message);}
            finally{cancel=null;ctx.setOperation(false);update();}
        }
        for(const task of ['probe','download','check','erase','erase-all','write','verify'])$('flash-'+task).addEventListener('click',()=>action(task));
        for(const field of ['file','address','length'])$('flash-'+field).addEventListener('change',update);
        $('flash-cancel').addEventListener('click',()=>{cancel?.abort();update();});
        return{render(selected){panel.hidden=selected!=='flash';update();},update,reset(){host=null;$('flash-state').textContent='NICHT ERKANNT';$('flash-info').textContent='Flash erkennen, um Größe und verfügbare Bereiche zu bestimmen.';$('flash-result').textContent='';}};
    };
})(globalThis);
