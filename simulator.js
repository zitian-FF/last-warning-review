'use strict';
(() => {
const D=window.BATTLE_DATA,E=window.BattleEngine,I=window.SIM_I18N;
if(!D||!E||!I){document.getElementById('run-status').textContent='Simulator files could not load. Reload this page.';return;}
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const langs={en:'English',zh_CN:'简体中文',zh_TW:'繁體中文',ja:'日本語',ko:'한국어',de:'Deutsch',fr:'Français',es:'Español',pt:'Português',ru:'Русский',ar:'العربية',it:'Italiano',id:'Bahasa Indonesia',tr:'Türkçe',th:'ไทย',vi:'Tiếng Việt',pl:'Polski'};
const clone=v=>JSON.parse(JSON.stringify(v));
const heldAuxiliarySkills=new Set(D.meta.heldAuxiliarySkillIds||[5009600,5009700,5017600]);
const displaySkill=s=>s?.raw?.displayEligible!==false&&!heldAuxiliarySkills.has(Number(s?.groupId||s?.skillId||s?.id));
const getStore=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const setStore=(key,v)=>{try{localStorage.setItem(key,JSON.stringify(v));}catch{}};
let lang=new URLSearchParams(location.search).get('lang')||getStore('lw-language','en');if(!langs[lang])lang='en';
const t=k=>I[lang]?.[k]||I.en[k]||k;
const locale=(key,fallback)=>D.locales?.[lang]?.[String(key)]||fallback;
const strip=v=>String(v||'').replace(/<[^>]*>/g,'').replace(/\\n/g,'\n');
const name=h=>strip(locale(h?.nameKey,h?.name||''));
const num=(v,d=0)=>new Intl.NumberFormat(lang.replace('_','-'),{maximumFractionDigits:d}).format(Number(v)||0);
const compact=v=>new Intl.NumberFormat(lang.replace('_','-'),{notation:'compact',maximumFractionDigits:1}).format(Number(v)||0);
const heroes=[...D.heroes].sort((a,b)=>({UR:0,SSR:1,SR:2}[a.rarity]??3)-({UR:0,SSR:1,SR:2}[b.rarity]??3)||a.name.localeCompare(b.name));
const byId=new Map(heroes.map(h=>[Number(h.id),h]));
function unit(id){return{heroId:id,form:'base',level:100,exp:0,shardLevel:3,skillLevel:20,skillLevels:{},gear:{weapon:20,armor:20,chip:20,radar:20},weaponLevel:10,awakenLevel:1};}
const defaults={v:1,left:[50006,50007,50009,50010,50008].map(unit),right:[50013,50006,50016,50017,50018].map(id=>unit(byId.has(id)?id:heroes[0].id)),tech:{left:0,right:0},seed:42,model:{defenseK:1,maxDuration:60}};
let setup=clone(defaults),selected={side:'left',slot:0},result=null,playTime=0,playing=false,lastTick=0,raf=0,dragSource=null,toastTimer;
function normalize(v){
 if(!v||!Array.isArray(v.left)||!Array.isArray(v.right)||v.left.length!==5||v.right.length!==5)throw Error('Invalid formations');
 const out=clone(defaults);
 for(const side of ['left','right']){
  const seen=new Set();out[side]=v[side].map(c=>{if(c===null)return null;if(!c||!byId.has(Number(c.heroId)))throw Error('Unknown hero');if(seen.has(Number(c.heroId)))throw Error('Duplicate hero');seen.add(Number(c.heroId));const x=unit(Number(c.heroId));x.form=c.form;x.gear={};x.skillLevels={};const bounds={level:[1,175],exp:[0,1e12],shardLevel:[0,5],skillLevel:[1,60],weaponLevel:[1,30],awakenLevel:[1,25]};for(const [key,[lo,hi]]of Object.entries(bounds)){const v=Number(c[key]??x[key]);if(!Number.isFinite(v))throw Error('Invalid progression');x[key]=Math.max(lo,Math.min(hi,v));}x.shardLevel=Math.round(x.shardLevel*5)/5;for(const key of ['weapon','armor','chip','radar'])x.gear[key]=Math.min(40,Math.max(0,Number(c.gear?.[key]??20)||0));for(const [key,value] of Object.entries(c.skillLevels||{}))if(['auto','active','passive','expertise','awakened'].includes(key)||/^\d{1,9}$/.test(key))x.skillLevels[key]=Math.max(1,Math.min(100,Number(value)||1));if(!['base','exclusive','awakened'].includes(x.form)||!byId.get(x.heroId).modes[x.form]?.available)x.form='base';return x;});
  out.tech[side]=Math.min(100,Math.max(0,Number(v.tech?.[side])||0));
 }
 out.seed=Math.max(1,Math.min(4294967295,Math.trunc(Number(v.seed)||42)));
 out.model={defenseK:Math.max(0,Math.min(100,Number(v.model?.defenseK)??1)),maxDuration:Math.max(5,Math.min(180,Number(v.model?.maxDuration)||60))};if(!Number.isFinite(out.model.defenseK))out.model.defenseK=1;
 return out;
}
try{if(location.hash.startsWith('#setup='))setup=normalize(JSON.parse(decodeURIComponent(location.hash.slice(7))));else setup=normalize(getStore('lw-battle-autosave',defaults));}catch{setup=clone(defaults);}
const portrait=(h,c)=>h?.modes?.[c?.form||'base']?.image||h?.image||'';
function computed(c,side){if(!c)return null;try{return E.computeUnit(c,setup.tech[side],D);}catch{return null;}}
function toast(key){$('toast').textContent=t(key);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2600);}
function stop(){playing=false;cancelAnimationFrame(raf);$('play').textContent=t('play');}
function invalidate(){stop();result=null;playTime=0;$('results').hidden=true;$('run-status').textContent=t('setupChanged');setStore('lw-battle-autosave',setup);renderBoards();}
function renderChrome(){
 document.documentElement.lang=lang.replace('_','-');document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.title=t('title')+' · Last Wiki';
 document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.dataset.i18n));
 $('language').innerHTML=Object.entries(langs).map(([k,n])=>`<option value="${k}"${k===lang?' selected':''}>${n}</option>`).join('');
 $('tech-left').value=setup.tech.left;$('tech-right').value=setup.tech.right;$('seed').value=setup.seed;$('defense-k').value=setup.model.defenseK;$('max-duration').value=setup.model.maxDuration;
 $('model-notes').innerHTML=`<p>${esc(t('techHint'))}</p>`;
}
function slotHtml(side,i){
 const c=setup[side][i],h=c&&byId.get(c.heroId),u=computed(c,side),active=selected.side===side&&selected.slot===i;
 if(!h)return`<button class="hero-slot empty${active?' selected':''}" data-slot="${i}" data-side="${side}" aria-label="${esc(t(side==='left'?'teamA':'teamB')+' '+t('position')+' '+(i+1)+' · '+t('empty'))}"><span class="slot-num">${i+1}</span><span class="empty-slot"><b>+</b>${esc(t('selectHero'))}</span></button>`;
 const formLabel=c.form==='base'?'':t(c.form);
 return`<button draggable="true" class="hero-slot ${h.rarity.toLowerCase()}${active?' selected':''}" data-slot="${i}" data-side="${side}" aria-label="${esc(t(side==='left'?'teamA':'teamB')+' '+t('position')+' '+(i+1)+' · '+name(h))}"><span class="slot-num">${i+1}</span>${formLabel?`<span class="slot-mode">${esc(formLabel)}</span>`:''}<img class="slot-art" src="${esc(portrait(h,c))}" alt="${esc(name(h))}" loading="lazy"><span class="slot-name">${esc(name(h))}</span><span class="slot-level">${esc(t('level'))} ${num(u?.effectiveLevel||c.level)} · ${num(c.shardLevel,1)} ★</span><span class="health-track"><span data-hp="${side}-${i}" style="width:100%"></span></span></button>`;
}
function renderBoards(){
 for(const side of ['left','right']){
  $('board-'+side).innerHTML=`<div class="board-row-label">${esc(t('front'))}</div><div class="slot-row">${[0,1].map(i=>slotHtml(side,i)).join('')}</div><div class="board-row-label">${esc(t('back'))}</div><div class="slot-row">${[2,3,4].map(i=>slotHtml(side,i)).join('')}</div>`;
  const units=setup[side].map(c=>computed(c,side)).filter(Boolean),hp=units.reduce((a,u)=>a+(u.stats?.hp||0),0),atk=units.reduce((a,u)=>a+(u.stats?.attack||0),0);
  $('totals-'+side).innerHTML=`<span>${esc(t('heroes')==='heroes'?t('hero'):t('heroes'))}<b>${units.length}/5</b></span><span>${esc(t('hp'))}<b>${compact(hp)}</b></span><span>${esc(t('attack'))}<b>${compact(atk)}</b></span>`;
 }
 if(result)paintHealth(playTime);
}
function field(key,value,min,max,step=1,wide=false,labelKey=key){return`<label${wide?' class="wide"':''}><span>${esc(t(labelKey))}</span><input data-field="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(value)}"></label>`;}
function renderInspector(){
 const {side,slot}=selected,c=setup[side][slot],h=c&&byId.get(c.heroId),u=computed(c,side);
 $('selected-position').textContent=t(side==='left'?'teamA':'teamB')+' / '+t(slot<2?'front':'back')+' '+(slot+1);
 $('inspector-title').textContent=h?name(h):t('selectHero');$('remove-hero').disabled=!c;
 const used=new Set(setup[side].filter((x,i)=>x&&i!==slot).map(x=>x.heroId));
 const picker=`<div class="picker-area"><label><span>${esc(t('hero'))}</span><input class="hero-picker-search" id="hero-search" type="search" placeholder="${esc(t('searchHero'))}" aria-label="${esc(t('searchHero'))}"><select id="hero-picker" aria-label="${esc(t('selectHero'))}"><option value="">${esc(t('empty'))}</option>${heroes.map(x=>`<option value="${x.id}"${h?.id===x.id?' selected':''}${used.has(x.id)?' disabled':''}>${esc(x.rarity+' · '+name(x)+(x.form==='Base'?'':' · '+x.form))}</option>`).join('')}</select></label>${h?`<div class="portrait-summary"><img src="${esc(portrait(h,c))}" alt="${esc(name(h))}"><div><span class="rarity">${esc(h.rarity)} · ${esc(h.type)}</span><strong>${esc(name(h))}</strong><small>${esc(t('level'))} ${num(u?.effectiveLevel||c.level)} · ${num(c.shardLevel,1)} ★</small></div></div><div class="form-options" role="group" aria-label="${esc(t('form'))}">${['base','exclusive','awakened'].map(f=>`<button data-form="${f}" class="${c.form===f?'active':''}" aria-pressed="${c.form===f}"${h.modes[f]?.available?'':' disabled'}>${esc(t(f))}</button>`).join('')}</div><div class="computed">${['hp','attack','defense'].map(k=>`<div><span>${esc(t(k))}</span><b>${compact(u?.stats?.[k])}</b></div>`).join('')}</div><a class="open-hero" href="index.html#article?record=hero-${h.id}&lang=${encodeURIComponent(lang)}">${esc(t('openHero'))} ↗</a>`:''}</div>`;
 if(!h){$('inspector-body').innerHTML=picker;return;}
 const maxLevel=Math.max(1,...D.templates.filter(x=>Number(x.type)===Number(h.templateId)).map(x=>Number(x.level)));
 const rankOptions=Array.from({length:26},(_,i)=>{const val=i/5,stars=Math.floor(val),part=i%5;return`<option value="${val}"${Math.abs(c.shardLevel-val)<.001?' selected':''}>${stars} ★${part?' + '+part+'/5':''}</option>`;}).join('');
 const moveOptions=Array.from({length:5},(_,i)=>`<option value="${i}"${i===slot?' selected':''}>${i+1} · ${esc(t(i<2?'front':'back'))}</option>`).join('');
 const globalSkillMax=Math.max(1,...(u?.allSkills||[]).map(s=>s.maxLevel||1));
 const progression=`<div class="progress-area"><div class="section-line"><h3>${esc(t('level'))} & ${esc(t('shards'))}</h3><small>${esc(t('computed'))}</small></div><div class="field-grid">${field('level',c.level,1,maxLevel)}${field('exp',c.exp,0,1000000000000)}<label class="wide"><span>${esc(t('shards'))}</span><select data-field="shardLevel">${rankOptions}</select></label>${field('skillLevel',Math.min(c.skillLevel,globalSkillMax),1,globalSkillMax,1,true)}${c.form!=='base'?field('weaponLevel',c.weaponLevel,1,30):''}${c.form==='awakened'?field('awakenLevel',c.awakenLevel,1,25):''}<label class="wide"><span>${esc(t('moveTo'))}</span><select id="move-position">${moveOptions}</select></label></div><small class="exp-help">${esc(t('expHint'))}${(u?.effectiveLevel||c.level)>c.level?' · '+esc(t('levelAfterExp'))+': '+num(u.effectiveLevel):''}</small></div>`;
 const equipment=`<div class="equipment-area"><div class="section-line"><h3>${esc(t('gear'))}</h3><small>0–40</small></div><div class="field-grid">${['weapon','armor','chip','radar'].map(k=>field('gear.'+k,c.gear[k],0,40,1,false,k)).join('')}</div><label style="display:block;margin-top:10px"><span>${esc(t('allGear'))}</span><input id="all-gear" type="range" min="0" max="40" value="${Math.round(Object.values(c.gear).reduce((a,b)=>a+b,0)/4)}"></label></div>`;
 const skillList=(u?.allSkills||u?.skills||h.skills||[]).filter(displaySkill);
 const skills=`<div class="skills-area"><div class="section-line"><h3>${esc(t('skills'))}</h3><small>${esc(t('perSkill'))}</small></div>${skillList.map(s=>`<label class="skill-item"><div><strong>${esc(strip(locale(s.nameKey,s.name||t(s.raw?.type||s.type))))}</strong><small>${s.locked?'🔒 ':''}${esc(t(s.raw?.type||s.type))} · ≤ ${s.maxLevel||60}</small></div><input type="number" data-skill="${esc(s.groupId||s.id||s.type)}" aria-label="${esc(strip(locale(s.nameKey,s.name||t(s.type)))+' '+t('skillLevel'))}" min="1" max="${s.maxLevel||60}" ${s.locked?'disabled':''} value="${s.level??Math.min(s.maxLevel||60,c.skillLevel)}"></label>`).join('')}<details><summary>${esc(t('model'))}</summary><p>${esc(t('estimateNote'))}</p>${(u?.unsupportedSkills||[]).filter(displaySkill).length?`<p>${esc(t('unsupported'))}: ${esc((u.unsupportedSkills||[]).filter(displaySkill).map(x=>typeof x==='string'?x:x.name||x.type).join(', '))}</p>`:''}</details></div>`;
 $('inspector-body').innerHTML=picker+progression+equipment+skills;
}
function update(){invalidate();renderInspector();}
function move(from,to){if(from.side!==to.side){toast('invalidFile');return;}[setup[from.side][from.slot],setup[to.side][to.slot]]=[setup[to.side][to.slot],setup[from.side][from.slot]];selected=to;update();}
function frameAt(time){if(!result)return null;let frame=result.frames?.[0];for(const f of result.frames||[]){if(f.time>time)break;frame=f;}return frame;}
function paintHealth(time){const f=frameAt(time);if(!f)return;for(const side of ['left','right'])for(let i=0;i<5;i++){const max=result.initial[side][i]?.stats?.hp||1,hp=Number(f[side]?.[i]??0),bar=document.querySelector(`[data-hp="${side}-${i}"]`),card=bar?.closest('.hero-slot');if(bar)bar.style.width=(100*Math.max(0,Math.min(1,hp/max)))+'%';if(card)card.classList.toggle('dead',hp<=0);}$('clock').textContent=num(time,2)+'s';$('timeline').value=time;}
function eventText(e){const source=result?.initial?.[e.side]?.[e.slot],target=result?.initial?.[e.targetSide]?.[e.targetSlot];const sourceName=source?name(byId.get(source.heroId)):t('result'),targetName=target?name(byId.get(target.heroId)):'';return [sourceName,e.skill||e.type,targetName?('→ '+targetName):'',e.amount?num(e.amount):'',e.crit?(' · '+t('critical')):''].filter(Boolean).join(' ');}
function renderResults(){
 if(!result)return;$('results').hidden=false;
 $('result-title').textContent=result.winner==='draw'?t('draw'):t('winner')+' · '+t(result.winner==='left'?'teamA':'teamB');$('result-duration').textContent=num(result.duration,2)+' '+t('seconds');
 $('result-summary').innerHTML=['left','right'].map(side=>`<div class="result-side ${side}"><strong>${esc(t(side==='left'?'teamA':'teamB'))}</strong><span>${esc(t('damage'))}<b>${num(result[side]?.totalDamage||result.totalDamage?.[side]||0)}</b></span><small>${esc(t('remaining'))}: ${num(result[side]?.survivors||0)}/5</small></div>`).join('');
 $('timeline').max=result.duration||1;$('timeline').value=0;$('clock').textContent='0.00s';
 const maxDamage=Math.max(1,...['left','right'].flatMap(s=>(result[s]?.units||[]).filter(Boolean).map(u=>u.damageDone||u.damage||u.totalDamage||0)));
 $('damage-bars').innerHTML=['left','right'].map(side=>`<div>${(result[side]?.units||[]).map((u,i)=>{if(!u)return'';const c=setup[side][i],h=c&&byId.get(c.heroId),value=u.damageDone||u.damage||u.totalDamage||0;return`<div class="damage-row"><img src="${esc(portrait(h,c))}" alt=""><div><div class="damage-label"><span>${esc(name(h))}</span><b>${compact(value)}</b></div><div class="bar"><span style="width:${100*value/maxDamage}%"></span></div></div></div>`;}).join('')}</div>`).join('');
 $('event-log').innerHTML=(result.events||[]).slice(0,1500).map(e=>`<li><time>${num(e.time,2)}s</time><span>${esc(eventText(e))}</span></li>`).join('');
 const notes=[...new Set([...(result.notes||[]),...(result.unsupportedSkills||[]).filter(displaySkill).map(x=>typeof x==='string'?x:[name(byId.get(x.heroId)),x.name,t('unsupported')].filter(Boolean).join(' · '))])];
 $('result-notes').innerHTML=`<p>${esc(t('estimateNote'))}</p>${notes.length?`<details><summary>${esc(t('unsupported'))} (${notes.length})</summary><ul>${notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></details>`:''}`;
 playTime=0;paintHealth(0);$('run-status').textContent=t('result');
}
function run(){stop();try{setup=normalize(setup);result=E.simulate(clone(setup),D);if(!result||!Array.isArray(result.events)||result.reason==='empty-team')throw Error('Invalid result');renderResults();}catch(error){result=null;$('results').hidden=true;$('run-status').textContent=t('emptyTeams');toast('emptyTeams');}}
function tick(now){if(!playing||!result)return;const delta=lastTick?(now-lastTick)/1000:0;lastTick=now;const previous=playTime;playTime=Math.min(result.duration,playTime+delta*Number($('speed').value));paintHealth(playTime);for(const e of result.events.filter(e=>e.time>previous&&e.time<=playTime&&Number.isInteger(e.targetSlot))){const card=document.querySelector(`[data-side="${e.targetSide}"][data-slot="${e.targetSlot}"]`);if(card){card.classList.remove('hit');void card.offsetWidth;card.classList.add('hit');}}if(playTime>=result.duration){stop();return;}raf=requestAnimationFrame(tick);}
function download(name,value){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function renderAll(){renderChrome();renderBoards();renderInspector();if(result)renderResults();}
document.addEventListener('click',e=>{
 const slot=e.target.closest('[data-slot]');if(slot){selected={side:slot.dataset.side,slot:Number(slot.dataset.slot)};renderBoards();renderInspector();return;}
 const form=e.target.closest('[data-form]');if(form&&!form.disabled){setup[selected.side][selected.slot].form=form.dataset.form;update();return;}
 const clear=e.target.closest('[data-clear]');if(clear){setup[clear.dataset.clear]=Array(5).fill(null);update();}
});
$('inspector-body').addEventListener('input',e=>{if(e.target.id==='hero-search'){const q=e.target.value.toLocaleLowerCase();for(const o of $('hero-picker').options)o.hidden=!!o.value&&!o.text.toLocaleLowerCase().includes(q);}});
$('inspector-body').addEventListener('change',e=>{
 const el=e.target,{side,slot}=selected;
 if(el.id==='hero-picker'){setup[side][slot]=el.value?unit(Number(el.value)):null;update();return;}
 if(el.id==='move-position'){move(selected,{side,slot:Number(el.value)});return;}
 const c=setup[side][slot];if(!c)return;
 if(el.id==='all-gear'){for(const k of ['weapon','armor','chip','radar'])c.gear[k]=Number(el.value);update();return;}
 if(el.dataset.skill){c.skillLevels[el.dataset.skill]=Math.max(1,Math.min(Number(el.max)||60,Number(el.value)||1));update();return;}
 if(el.dataset.field){let v=Number(el.value);if(!Number.isFinite(v))v=Number(el.min)||0;v=Math.max(Number(el.min),Math.min(Number(el.max),v));if(el.dataset.field.startsWith('gear.'))c.gear[el.dataset.field.split('.')[1]]=v;else{c[el.dataset.field]=v;if(el.dataset.field==='skillLevel')c.skillLevels={};}update();}
});
document.addEventListener('dragstart',e=>{const el=e.target.closest('[data-slot]');if(el){dragSource={side:el.dataset.side,slot:Number(el.dataset.slot)};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(dragSource));}});
document.addEventListener('dragover',e=>{const el=e.target.closest('[data-slot]');if(el&&dragSource?.side===el.dataset.side){e.preventDefault();el.classList.add('drag-over');}});
document.addEventListener('dragleave',e=>e.target.closest('[data-slot]')?.classList.remove('drag-over'));
document.addEventListener('drop',e=>{const el=e.target.closest('[data-slot]');if(el&&dragSource){e.preventDefault();move(dragSource,{side:el.dataset.side,slot:Number(el.dataset.slot)});}dragSource=null;});
document.addEventListener('dragend',()=>{dragSource=null;document.querySelectorAll('.drag-over').forEach(e=>e.classList.remove('drag-over'));});
$('language').addEventListener('change',e=>{stop();lang=e.target.value;setStore('lw-language',lang);renderAll();});
for(const side of ['left','right'])$('tech-'+side).addEventListener('change',e=>{setup.tech[side]=Math.max(0,Math.min(100,Number(e.target.value)||0));e.target.value=setup.tech[side];update();});
$('model-toggle').addEventListener('click',()=>{$('model-panel').hidden=!$('model-panel').hidden;});
for(const [id,key] of [['seed','seed'],['defense-k','defenseK'],['max-duration','maxDuration']])$(id).addEventListener('change',e=>{const v=Math.max(Number(e.target.min),Math.min(Number(e.target.max),Number(e.target.value)||Number(e.target.min)));if(key==='seed')setup.seed=v;else setup.model[key]=v;e.target.value=v;invalidate();});
$('remove-hero').addEventListener('click',()=>{setup[selected.side][selected.slot]=null;update();});
$('copy-team').addEventListener('click',()=>{setup.right=clone(setup.left);setup.tech.right=setup.tech.left;$('tech-right').value=setup.tech.right;update();});
$('swap-teams').addEventListener('click',()=>{[setup.left,setup.right]=[setup.right,setup.left];[setup.tech.left,setup.tech.right]=[setup.tech.right,setup.tech.left];update();renderChrome();});
$('run').addEventListener('click',run);
$('play').addEventListener('click',()=>{if(!result)return;if(playing){stop();return;}if(playTime>=result.duration)playTime=0;playing=true;lastTick=0;$('play').textContent=t('pause');raf=requestAnimationFrame(tick);});
$('reset').addEventListener('click',()=>{stop();playTime=0;paintHealth(0);});
$('timeline').addEventListener('input',e=>{stop();playTime=Number(e.target.value);paintHealth(playTime);});
$('save').addEventListener('click',()=>{setStore('lw-battle-preset',setup);toast('saved');});
$('load').addEventListener('click',()=>{try{setup=normalize(getStore('lw-battle-preset',defaults));invalidate();renderAll();toast('saved');}catch{toast('invalidFile');}});
$('export').addEventListener('click',()=>download('last-wiki-formation.json',setup));
$('import').addEventListener('click',()=>$('import-file').click());
$('import-file').addEventListener('change',async e=>{const f=e.target.files[0];try{if(!f||f.size>200000)throw Error();const parsed=normalize(JSON.parse(await f.text()));setup=parsed;invalidate();renderAll();toast('saved');}catch{toast('invalidFile');}e.target.value='';});
$('share').addEventListener('click',async()=>{const url=new URL(location.href);url.searchParams.set('lang',lang);url.hash='setup='+encodeURIComponent(JSON.stringify(setup));history.replaceState(null,'',url);try{await navigator.clipboard.writeText(url.href);toast('copied');}catch{toast('share');}});
$('download-log').addEventListener('click',()=>{if(result)download('last-wiki-estimated-battle.json',{status:'Estimated model, not official game output',setup,result});});
renderAll();
})();
