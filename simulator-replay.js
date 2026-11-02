'use strict';
(function(root){
const SIDES=['left','right'], MAX_BYTES=20*1024*1024;
function finite(x,min=0,max=1e18){return typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;}
function validate(input){
 if(!input||input.schemaVersion!==1||input.source!=='recorded'||!Array.isArray(input.battles)||!input.battles.length||input.battles.length>100)throw Error('invalid');
 const value=input;
 for(const b of value.battles){
  if(!finite(b.durationMs,0,3600000)||!Array.isArray(b.units)||b.units.length>100||!Array.isArray(b.actions)||b.actions.length>100000)throw Error('invalid');
  const indices=new Set();
  for(const u of b.units){if(!Number.isInteger(u.index)||u.index<0||indices.has(u.index)||!finite(u.heroId||0)||!finite(u.damage||0))throw Error('invalid');indices.add(u.index);if(u.side!==undefined&&!SIDES.includes(u.side)&&u.side!=='support')throw Error('invalid');if(u.slot!==undefined&&u.slot!==null&&(!Number.isInteger(u.slot)||u.slot<0||u.slot>4))throw Error('invalid');}
  for(const a of b.actions){if(!finite(a.timeMs??a.time,0,3600000)||!Array.isArray(a.targets||[])||(a.targets||[]).length>100)throw Error('invalid');for(const t of a.targets||[])if(!Number.isInteger(t.index)||!finite(t.damage||0)||!finite(t.damageDouble||0))throw Error('invalid');}
 }
 return JSON.parse(JSON.stringify(value));
}
// The game's renderer consumes array order, stopping at the first action whose
// time is not strictly before the cursor. Never sort by id/order or deduplicate.
function visibleActions(b,ms){const out=[];for(const a of b.actions){if((a.timeMs??a.time)>=ms)break;out.push(a);}return out;}
function matchingRoster(b,sim){if(!sim)return false;for(const side of SIDES){const recorded=b.units.filter(u=>u.side===side&&u.unitType===1).sort((a,b)=>a.slot-b.slot);const modeled=(sim[side]?.units||[]).filter(Boolean).sort((a,b)=>a.slot-b.slot);if(!recorded.length||recorded.length!==modeled.length||recorded.some((u,i)=>u.heroId!==modeled[i].heroId||u.slot!==modeled[i].slot))return false;}return true;}
const core={validate,visibleActions,matchingRoster};
if(typeof module==='object'&&module.exports){module.exports=core;return;}
let language='en', replay=null, battleNo=0, simulation=null, snapshotMode=false,cursor=0,playing=false,raf=0,last=0,container,loading=false;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const t=k=>root.REPLAY_I18N?.[language]?.[k]||root.REPLAY_I18N?.en?.[k]||k;
const $=id=>document.getElementById('replay-'+id);
const n=v=>new Intl.NumberFormat(language.replace('_','-'),{maximumFractionDigits:2}).format(Number(v)||0);
function unitName(u){const h=root.BATTLE_DATA?.heroes.find(h=>Number(h.id)===Number(u.heroId));const name=root.BATTLE_DATA?.locales?.[language]?.[String(h?.nameKey)]||h?.name;return name?String(name).replace(/<[^>]*>/g,''):'#'+u.index;}
function identity(u){const label=unitName(u);return SIDES.includes(u.side)?(u.side==='left'?'A':'B')+' · '+(Number(u.slot)+1)+' · '+label:label==='#'+u.index?label:'#'+u.index+' · '+label;}
function stop(){playing=false;cancelAnimationFrame(raf);if($('play'))$('play').textContent=t('play');}
function status(key,error=false){$('status').textContent=t(key);$('status').classList.toggle('error',error);}
function render(){
 if(!container)return;
 const oldId=$('id')?.value||'',region=$('region')?.value||'aws';
 container.innerHTML=`<header><div><div class="eyebrow">LAST WIKI / REPLAY LAB</div><h2>${esc(t('title'))}</h2></div></header><p>${esc(t('intro'))}</p><div class="replay-controls"><label><span>${esc(t('battleId'))}</span><input id="replay-id" type="text" inputmode="numeric" maxlength="20" autocomplete="off" spellcheck="false"></label><label><span>${esc(t('region'))}</span><select id="replay-region"><option value="aws">AWS CDN</option><option value="ali">Ali CDN</option></select></label><button id="replay-fetch">${esc(t('fetch'))}</button><button id="replay-import">${esc(t('import'))}</button><input id="replay-file" type="file" accept="application/json,.json" hidden></div><p>${esc(t('privacy'))}</p><details><summary>${esc(t('helper'))}</summary><p>${esc(t('helperText'))}</p><code>python replay-helper.py</code></details><div id="replay-status" class="replay-status" role="status" aria-live="polite"></div><div id="replay-content"></div>`;
 $('id').value=oldId;$('region').value=region;$('fetch').disabled=loading;
 $('fetch').onclick=fetchReplay;$('import').onclick=()=>$('file').click();$('file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>MAX_BYTES)throw Error('invalid');accept(JSON.parse(await file.text()));}catch{status('invalid',true);}finally{e.target.value='';}};
 if(replay)renderBattle();
}
function accept(v){const checked=validate(v);stop();if(snapshotMode)simulation=null;snapshotMode=false;replay=checked;battleNo=0;cursor=0;status(checked.battles[0].actions.length?'loaded':'summaryOnly');renderBattle();}
function testSnapshot(){
 stop();const b=replay?.battles[battleNo],engine=root.BattleEngine;if(!b||b.durationMs<=0||!b.actions.length||typeof engine?.simulateRecordedSnapshot!=='function')return;
 try{const result=engine.simulateRecordedSnapshot({units:b.units,detail:{actions:b.actions},totalTime:b.durationMs},root.BATTLE_DATA,{maxDuration:Math.max(0.05,b.durationMs/1000)});if(!result||result.ok===false){status('invalidSnapshot',true);const errors=(result?.errors||[]).slice(0,8).map(x=>typeof x==='string'?x:String(x?.message||x?.reason||'')).filter(Boolean);if(errors.length)$('status').append(document.createTextNode(' '+errors.join(' · ')));return;}simulation=result;snapshotMode=true;cursor=0;status('snapshotNote');renderBattle();}catch{status('invalidSnapshot',true);}
}
async function fetchReplay(){
 const battleId=$('id').value.trim();if(!/^[1-9][0-9]{0,18}$/.test(battleId)||BigInt(battleId)>9223372036854775807n){status('invalidId',true);return;}
 loading=true;$('fetch').disabled=true;status('loading');const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),30000);
 try{const response=await fetch('http://127.0.0.1:8791/api/replay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({battleId,region:$('region').value}),credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});if(!response.ok){let error={};try{error=await response.json();}catch{}status(response.status===404||error.upstreamStatus===404?'notFound':response.status===400?'invalidId':'fetchError',true);return;}const text=await response.text();if(text.length>MAX_BYTES)throw Error('invalid');accept(JSON.parse(text));}catch(e){status(e.message==='invalid'?'invalid':'unavailable',true);}finally{clearTimeout(timeout);loading=false;$('fetch').disabled=false;}
}
function renderBattle(){
 const b=replay.battles[battleNo],matched=matchingRoster(b,simulation),units=b.units;
 const modelDuration=simulation?n(simulation.duration)+'s':'—';
 const selector=replay.battles.length>1?`<label class="replay-battle-label"><span>${esc(t('battle'))}</span><select id="replay-battle">${replay.battles.map((_,i)=>`<option value="${i}"${i===battleNo?' selected':''}>${i+1}</option>`).join('')}</select></label>`:'';
 const rows=units.map(u=>{const model=matched&&u.unitType===1?simulation[u.side]?.units.find(x=>x&&x.slot===u.slot):null;const h=root.BATTLE_DATA?.heroes.find(h=>Number(h.id)===Number(u.heroId)),image=h?.image||h?.modes?.base?.image;const difference=model&&Number.isFinite(u.damage)&&u.damage>0?(model.damageDone-u.damage)/u.damage*100:null;return `<tr><td><div class="replay-unit">${image?`<img src="${esc(image)}" alt="">`:''}${esc(identity(u))}</div></td><td>${u.damage===undefined?'—':n(u.damage)}</td><td>${model?n(model.damageDone):'—'}</td><td>${difference===null?'—':n(difference)+'%'}</td><td>${finite(u.hp)?n(u.hp):'—'}</td></tr>`;}).join('');
 $('content').innerHTML=selector+`<div class="replay-metrics"><div>${esc(t('recorded'))}<strong>${n(b.durationMs/1000)}s</strong></div><div>${esc(t('modeled'))}<strong>${modelDuration}</strong></div><div>${esc(t('actions'))}<strong>${n(b.actions.length)}</strong></div><div>${esc(t('outcome'))}<strong>${esc(b.winner??b.fightResult??'—')}</strong></div></div><p>${esc(t('outcomeNote'))}</p>${typeof root.BattleEngine?.simulateRecordedSnapshot==='function'?`<button id="replay-test-snapshot"${b.durationMs<=0||!b.actions.length?' disabled':''}>${esc(t('testSnapshot'))}</button>`:''}<p class="replay-summary-line">${esc(t(snapshotMode?'snapshotNote':simulation?(matched?'matched':'mismatch'):'noSimulation'))}</p><div class="replay-table-wrap"><table><thead><tr>${['unit','recordedDamage','modeledDamage','difference','endHp'].map(k=>`<th scope="col">${esc(t(k))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div><p>${esc(t('damageNote'))}</p><div class="replay-timeline"><button id="replay-play">${esc(t('play'))}</button><input id="replay-timeline" aria-label="${esc(t('timeline'))}" type="range" min="0" max="${b.durationMs+1}" step="1" value="${cursor}"><output id="replay-clock"></output></div><p>${esc(t('timelineNote'))}</p><details open><summary>${esc(t('actions'))} <span id="replay-count"></span></summary><ol id="replay-events" class="replay-events"></ol></details><details><summary>${esc(t('compareEvents'))}</summary><p>${esc(t('eventNote'))}</p><ol id="replay-model-events" class="replay-events"></ol></details><p class="replay-unknown">${Number(b.unknownFieldCount)>0?esc(t('unknownFields'))+' '+n(b.unknownFieldCount):''}</p>`;
 if($('test-snapshot'))$('test-snapshot').onclick=testSnapshot;
 if($('battle'))$('battle').onchange=e=>{stop();if(snapshotMode)simulation=null;snapshotMode=false;battleNo=Number(e.target.value);cursor=0;status(replay.battles[battleNo].actions.length?'loaded':'summaryOnly');renderBattle();};
 $('timeline').oninput=e=>{stop();cursor=Number(e.target.value);paint();};$('play').onclick=()=>{if(playing){stop();return;}if(cursor>b.durationMs)cursor=0;playing=true;last=0;$('play').textContent=t('pause');raf=requestAnimationFrame(tick);};paint();
}
function paint(){
 if(!replay)return;const b=replay.battles[battleNo],actions=visibleActions(b,cursor),lookup=new Map(b.units.map(u=>[u.index,u]));
 $('timeline').value=cursor;$('clock').textContent=n(cursor/1000)+'s';$('count').textContent=n(actions.length)+' / '+n(b.actions.length);
 $('events').innerHTML=actions.slice(-100).map(a=>{const actor=lookup.get(a.casterIndex??a.caster),targets=(a.targets||[]).map(x=>{const target=lookup.get(x.index);return (target?identity(target):'#'+x.index)+(x.damage||x.damageDouble?' · '+n(x.damageDouble||x.damage):'');}).join('; ');return `<li><time>${n((a.timeMs??a.time)/1000)}s</time>#${n(a.sequence)} · ${esc(actor?identity(actor):'#'+(a.casterIndex??a.caster??'?'))} → ${esc(targets||'—')} · ${esc(t('skill'))} ${esc(a.skillId??'—')} · ${esc(t('phase'))} ${esc(a.phase??'—')}</li>`;}).join('');
 const events=(simulation?.events||[]).filter(e=>e.time*1000<cursor&&['attack','skill'].includes(e.type));
 $('model-events').innerHTML=events.slice(-100).map(e=>`<li><time>${n(e.time)}s</time>${e.side==='left'?'A':'B'} · ${n(e.slot+1)} → ${e.targetSide==='left'?'A':'B'} · ${n(e.targetSlot+1)} · ${esc(t('skill'))} ${esc(e.skillId??'—')} · ${n(e.amount)}</li>`).join('');
}
function tick(now){if(!playing||!replay)return;const b=replay.battles[battleNo];cursor=Math.min(b.durationMs+1,cursor+(last?now-last:0));last=now;paint();if(cursor>b.durationMs){stop();return;}raf=requestAnimationFrame(tick);}
root.LastWikiReplay={...core,init(el,lang){container=el;container.classList.add('replay-panel','panel');language=lang||'en';render();},setLanguage(lang){stop();language=lang;render();},setSimulation(result){stop();snapshotMode=false;simulation=result;if(replay)renderBattle();},import:accept};
})(typeof window==='object'?window:globalThis);
