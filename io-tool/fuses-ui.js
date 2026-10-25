(function(root){
    'use strict';const $=id=>document.getElementById(id);
    root.ESPIO.createFusesPanel=function(ctx){
        let snapshot=null,cancel=null;const panel=document.createElement('div');panel.id='fuses-panel';panel.className='sd-panel';panel.hidden=true;
        panel.innerHTML='<div class="sd-heading"><h3>Fuses · Chip &amp; ROM</h3><span id="fuses-state" class="chip-badge">NICHT GELESEN</span></div><p class="sd-note">Ausschließlich lesend. Der Chip liefert Feldnamen, Typen und Werte. Angezeigt werden Identität, ROM-/Revisionsdaten und die wichtigsten öffentlichen eFuses; keine Schlüsselwerte.</p><div class="sd-actions"><button id="fuses-read">Fuses / Chip-Infos lesen</button><button id="fuses-export" disabled>JSON herunterladen</button><button id="fuses-cancel" hidden>Abbrechen</button></div><p id="fuses-progress" class="sd-note" role="status"></p><label class="fuses-filter">Felder filtern<input id="fuses-filter" type="search" placeholder="MAC, UNIQUE_ID, SECURE_BOOT, ROM …"></label><div id="fuses-records"></div>';
        $('i2c-panel').after(panel);
        function update(){const blocked=ctx.blocked()||!ctx.controller()?.transport.supports?.('FUSES')||ctx.controller()?.fault;$('fuses-read').disabled=blocked;$('fuses-export').disabled=!snapshot||!!cancel;$('fuses-cancel').hidden=!cancel;$('fuses-cancel').disabled=!cancel||cancel.signal.aborted;}
        function draw(){
            $('fuses-records').replaceChildren();if(!snapshot)return;
            const filter=$('fuses-filter').value.toLowerCase(),groups=new Map();
            for(const row of snapshot.records){if(filter&&!`${row.name} ${row.display}`.toLowerCase().includes(filter))continue;const group=row.name.includes('.')?row.name.split('.')[0]:'FUSES';if(!groups.has(group))groups.set(group,[]);groups.get(group).push(row);}
            for(const [group,rows]of groups){
                const title=document.createElement('h4');title.textContent=group;$('fuses-records').append(title);
                const wrap=document.createElement('div');wrap.className='fuses-table-wrap';const table=document.createElement('table'),head=document.createElement('thead'),tr=document.createElement('tr');
                for(const text of ['Feld','Wert','Bits','Rohdaten (Bytes)']){const th=document.createElement('th');th.textContent=text;tr.append(th);}head.append(tr);table.append(head);const body=document.createElement('tbody');
                for(const row of rows){const tr=document.createElement('tr');tr.dataset.fuse=row.name;for(const text of [row.name,row.display,row.bits||'—',row.type===root.ESPIO.rpcProtocol.fuseTypes.TEXT?'—':row.raw]){const td=document.createElement('td');td.textContent=text;tr.append(td);}body.append(tr);}table.append(body);wrap.append(table);$('fuses-records').append(wrap);
            }
        }
        $('fuses-read').addEventListener('click',async()=>{
            if(ctx.blocked())return;cancel=new AbortController();ctx.setOperation(true);$('fuses-progress').textContent='Fuses werden gelesen …';
            try{const host=new root.ESPIO.FusesHost(ctx.controller()),records=await host.read({signal:cancel.signal,onProgress:(n,total)=>{$('fuses-progress').textContent=`${n} / ${total} Felder`;}});snapshot={time:new Date().toISOString(),records};draw();$('fuses-state').textContent=`${records.length} FELDER`;$('fuses-progress').textContent=`Gelesen · ${new Date().toLocaleTimeString(globalThis.ESPIO?.i18n?.locale)} · ${records.length} vom Chip gelieferte Felder.`;}
            catch(e){$('fuses-progress').textContent=e.message;ctx.log('FUSES:',e.message);}finally{cancel=null;ctx.setOperation(false);update();}
        });
        $('fuses-filter').addEventListener('input',draw);$('fuses-cancel').addEventListener('click',()=>{cancel?.abort();update();});
        $('fuses-export').addEventListener('click',()=>{if(!snapshot)return;const data={time:snapshot.time,records:snapshot.records.map(({name,type,bits,raw,display})=>({name,type,bits,raw,display}))};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`fuses-${ctx.chip().id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);});
        return{update,render(selected){panel.hidden=selected!=='fuses';update();},reset(){snapshot=null;$('fuses-state').textContent='NICHT GELESEN';$('fuses-progress').textContent='';draw();update();}};
    };
})(globalThis);
