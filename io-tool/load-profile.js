(function(root){
    'use strict';
    const clamp=n=>Math.max(0,Math.min(1,n)),escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function summarizeLoadPhase(samples,level,max=4095,windowMs=null){
        if(!samples?.length)return null;
        // Settled level = samples whose acquisition started in the last third
        // of the window, so the transient (shown in the time scope) is excluded.
        // Older exports without start offsets fall back to the last third by count.
        const cutoff=Number.isFinite(windowMs)?windowMs*2/3:null,timed=cutoff===null?[]:samples.filter(s=>Number.isFinite(s.startedMs)&&s.startedMs>=cutoff);
        const tail=timed.length?timed:samples.slice(-Math.max(1,Math.ceil(samples.length/3))),raw=tail.map(s=>s.raw).filter(Number.isFinite),io=tail.map(s=>s.io).filter(v=>v===0||v===1);
        const average=list=>list.reduce((a,b)=>a+b,0)/list.length,highFraction=io.length?average(io):null,meanRaw=raw.length?average(raw):null;
        const value=meanRaw===null?highFraction:meanRaw/max;
        const digitalMatch=highFraction===null?null:level===1?highFraction>=.9:highFraction<=.1;
        const analogMatch=meanRaw===null?true:level===1?value>=.82:value<=.18;
        return{samples:samples.length,tailSamples:tail.length,settledBy:timed.length?'time':'count',meanRaw,minRaw:raw.length?Math.min(...raw):null,maxRaw:raw.length?Math.max(...raw):null,
            highFraction,value,level,matches:level===null||value===null?null:digitalMatch!==false&&analogMatch,
            from:tail[0].t,to:tail.at(-1).t};
    }
    function summarizeLoadRun(run,max=4095){
        const w=run.settleMs,phase=(samples,level)=>summarizeLoadPhase(samples,level,max,w);
        if(run.method==='idle'){
            // High-Z has no commanded level: the one measurement is compared with both rails.
            const low=phase(run.idle,0);
            return{method:'idle',strength:null,label:'Idle',low,high:phase(run.idle,1),returnLow:low,startedAt:run.startedAt,finishedAt:run.finishedAt,timingQuality:run.timingQuality};
        }
        return{method:run.method,strength:run.method==='drive'?run.driveStrength:null,label:run.method==='pull'?'Pulls':run.method==='drive'?`D${run.driveStrength}`:'Input',
            low:phase(run.low,0),high:phase(run.high,1),returnLow:phase(run.returnLow,0),startedAt:run.startedAt,finishedAt:run.finishedAt,timingQuality:run.timingQuality};
    }
    const isStage=s=>s.method==='idle'||s.method==='pull'||s.method==='drive'&&Number.isInteger(s.strength)&&s.strength>=0;
    const stageX=s=>s.method==='idle'?-2:s.method==='pull'?-1:s.strength;
    function loadProfileThresholds(profile){
        // Idle commands no level, so it is a reference point, not a "follows from" stage.
        const stages=(profile?.stages||[]).filter(s=>isStage(s)&&s.method!=='idle').sort((a,b)=>stageX(a)-stageX(b)),matches=(s,key)=>key==='low'?s.low?.matches===true&&s.returnLow?.matches===true:s.high?.matches===true;
        const threshold=key=>{let first=null,seen=false,nonMonotonic=false;for(const s of stages){const yes=matches(s,key);if(yes&&!seen){first=s.label;seen=true;}else if(seen&&!yes)nonMonotonic=true;}return{first,nonMonotonic};};
        return{low:threshold('low'),high:threshold('high')};
    }
    function loadProfileHTML(result){
        const profile=result?.loadProfile;if(!profile)return result?.loadProfileSkipped==='no-adc'?`<div class="load-profile"><h4>Lastprofil</h4><p>GPIO${escape(result.id)} hat keinen ADC-Kanal; das Lastprofil braucht eine Analogmessung und wurde übersprungen.</p></div>`:'';
        const stages=profile.stages.filter(isStage).sort((a,b)=>stageX(a)-stageX(b)),analog=result.measurement==='adc';
        if(!stages.some(s=>s.method!=='idle'))return '<div class="load-profile"><h4>Lastprofil</h4><p>Dieser Pin wurde nur beobachtet; keine Pull-/Treiberstufen verfügbar.</p></div>';
        const thresholds=loadProfileThresholds(profile),w=560,h=260,left=52,top=26,width=486,height=178,max=analog?(profile.rawMax||4095):1;
        const strengths=stages.map(stageX),minStrength=Math.min(...strengths),maxStrength=Math.max(...strengths);
        const x=s=>minStrength===maxStrength?left+width/2:left+(s-minStrength)/(maxStrength-minStrength)*width,y=value=>top+height*(1-clamp(value/max)),f=n=>n.toFixed(2);
        let svg=`<svg class="load-xy" viewBox="0 0 ${w} ${h}" role="img" aria-label="Lastprofil: Treiberstufe gegen ${analog?'ADC-Rohwert':'digitalen HIGH-Anteil'}, getrennt für HIGH und LOW"><title>GPIO${escape(result.id)}: HIGH und LOW je Pull-/Treiberstufe</title>`;
        for(let i=0;i<=4;i++){const value=max*i/4,py=y(value);svg+=`<path class="load-grid" d="M${left} ${f(py)}H${left+width}"/><text x="${left-8}" y="${f(py+3)}" text-anchor="end">${analog?Math.round(value):value.toFixed(i===0||i===4?0:2)}</text>`;}
        for(let i=0;i<stages.length;i++){const px=x(strengths[i]);svg+=`<path class="load-grid" d="M${f(px)} ${top}V${top+height}"/><text x="${f(px)}" y="${top+height+19}" text-anchor="middle">${escape(stages[i].label)}</text>`;}
        svg+=`<text x="${left}" y="13">${analog?'ADC raw':'HIGH-Anteil (digital)'}</text><text x="${left+width/2}" y="${h-9}" text-anchor="middle">Treiberstufe / relative Stärke</text>`;
        let returns=0;
        for(const [key,label,color,level]of [['high','HIGH','#68e8a5',1],['low','LOW','#67c9ff',0]]){
            let path='',connected=false,points='';
            for(let i=0;i<stages.length;i++){
                const stage=stages[i],v=stage[key],value=analog?v?.meanRaw:v?.highFraction;
                if(!Number.isFinite(value)){connected=false;continue;}
                const px=x(strengths[i]),py=y(value);path+=`${connected?'L':'M'}${f(px)} ${f(py)}`;connected=true;
                if(analog&&Number.isFinite(v.minRaw)&&Number.isFinite(v.maxRaw))points+=`<path d="M${f(px)} ${f(y(v.minRaw))}V${f(y(v.maxRaw))}M${f(px-3)} ${f(y(v.minRaw))}H${f(px+3)}M${f(px-3)} ${f(y(v.maxRaw))}H${f(px+3)}" stroke="${color}" opacity=".5"/>`;
                const title=`${stage.label} ${label}: ${analog?Math.round(value)+' raw':Math.round(value*100)+' % HIGH'}; ${v.tailSamples}/${v.samples} Samples am Fensterende${analog?'; ADC '+v.minRaw+' bis '+v.maxRaw:''}`;
                points+=`<circle data-stage="${escape(stage.label)}" data-level="${level}" cx="${f(px)}" cy="${f(py)}" r="3.5" fill="${color}"><title>${escape(title)}</title></circle>`;
                if(key==='low'){
                    const ret=stage.returnLow,rv=analog?ret?.meanRaw:ret?.highFraction;
                    if(Number.isFinite(rv)&&Math.abs(rv-value)>(analog?1:.01)){returns++;points+=`<path d="M${f(px)} ${f(py)}V${f(y(rv))}" stroke="${color}" stroke-dasharray="2 3" opacity=".6"/><circle cx="${f(px)}" cy="${f(y(rv))}" r="4.5" fill="#0b1218" stroke="${color}"><title>${escape(stage.label)} LOW Rückkehr: ${analog?Math.round(rv)+' raw':Math.round(rv*100)+' % HIGH'}</title></circle>`;}
                }
            }
            svg+=`<path d="${path}" stroke="${color}" stroke-width="2" fill="none"/>${points}`;
        }
        svg+='</svg>';
        if(stages.some(s=>s.timingQuality&&!s.timingQuality.passed))svg+='<p>Messung lückenhaft: Messabstände über 5 ms trotz drei Wiederholungen. Angezeigt wird der beste Versuch je Stufe.</p>';
        const thresholdText=(key,label)=>{const t=thresholds[key];return`${label}: ${t.nonMonotonic?'wechselnde Reaktion':t.first?`folgt ab ${t.first}`:'keine getestete Stufe folgt'}`;};
        const idle=stages.find(s=>s.method==='idle')?.low,idleText=idle?.value==null?'':`<br>Idle (High-Z): ${analog&&idle.meanRaw!==null?`${Math.round(idle.meanRaw)} raw · `:''}${(idle.value*100).toFixed(1)} %`;
        return `<div class="load-profile"><h4>Lastprofil · HIGH / LOW</h4><p class="load-profile-caption">${analog?'ADC-Mittelwert am Fensterende; Balken zeigen Min/Max':`GPIO${escape(result.id)} hat keinen ADC-Kanal: digitaler HIGH-Anteil am Fensterende`}</p><div class="load-legend"><span style="--load-color:#68e8a5">HIGH</span><span style="--load-color:#67c9ff">LOW</span>${returns?'<small>Ring: abweichende LOW-Rückkehr</small>':''}</div>${svg}<p class="load-thresholds">${escape(thresholdText('low','LOW'))}<br>${escape(thresholdText('high','HIGH'))}${idleText}</p><small>Idle = Eingang ohne Pull/Treiber (High-Z, ein Messwert gegen beide Pegel); Pulls = interne Pulls; D0–D${Math.max(0,...stages.filter(s=>s.method==='drive').map(s=>s.strength))} = GPIO-Treiberstufen, relative Skala ohne mA.</small></div>`;

    }
    const api={summarizeLoadPhase,summarizeLoadRun,loadProfileThresholds,loadProfileHTML};
    if(typeof module==='object'&&module.exports)module.exports=api;else Object.assign(root.ESPIO ||= {},api);
})(globalThis);
