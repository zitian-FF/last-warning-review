'use strict';
(() => {
const D=window.BATTLE_DATA,E=window.BattleEngine,I=window.SIM_I18N;
const T=window.BATTLE_TECH_DATA||{research:[],locales:{}};
if(D)D.technology=T;
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
const locale=(key,fallback)=>D.locales?.[lang]?.[String(key)]||T.locales?.[lang]?.[String(key)]||fallback;
const strip=v=>String(v||'').replace(/<[^>]*>/g,'').replace(/\\n/g,'\n');
const name=h=>strip(locale(h?.nameKey,h?.name||''));
const num=(v,d=0)=>new Intl.NumberFormat(lang.replace('_','-'),{maximumFractionDigits:d}).format(Number(v)||0);
const compact=v=>new Intl.NumberFormat(lang.replace('_','-'),{notation:'compact',maximumFractionDigits:1}).format(Number(v)||0);
const heroes=[...D.heroes].sort((a,b)=>({UR:0,SSR:1,SR:2}[a.rarity]??3)-({UR:0,SSR:1,SR:2}[b.rarity]??3)||a.name.localeCompare(b.name));
const byId=new Map(heroes.map(h=>[Number(h.id),h]));
const gearSlots={weapon:1,armor:2,chip:3,radar:4};
const gearOptions=key=>(D.gear?.items||[]).filter(g=>Number(g.slot)===gearSlots[key]&&g.selectable!==false);
const gearById=id=>(D.gear?.items||[]).find(g=>Number(g.id)===Number(id));
const gearDefaultId=key=>gearOptions(key).find(g=>Number(g.id)===410000+gearSlots[key]*100)?.id||gearOptions(key).find(g=>g.quality===5)?.id||0;
function gearConfig(key,value){
 const legacy=typeof value==='number',id=legacy?gearDefaultId(key):Number(value?.itemId??gearDefaultId(key)),item=gearById(id);
 if(!item||Number(item.slot)!==gearSlots[key])return{itemId:0,level:0,promotion:0};
 const cap=item.maxLevel??Math.max(0,(item.perLevel||[]).length-1),maxPromotion=item.maxPromotion??25;
 let level=Math.round(Math.max(0,Math.min(cap,Number(legacy?value:value?.level??20)||0))),promotion=Math.round(Math.max(0,Math.min(maxPromotion,Number(value?.promotion)||0)));
 if(item.quality===6){level=cap;promotion=Math.max(item.minPromotion??25,promotion);}
 if(promotion>0)level=cap;
 if(item.promotionTarget&&promotion>=item.promotionTarget.stage)return gearConfig(key,{itemId:item.promotionTarget.itemId,level,promotion});
 return{itemId:Number(item.id),level,promotion};
}
function unit(id){return{heroId:id,form:'base',level:100,exp:0,shardLevel:3,skillLevel:20,skillLevels:{},gear:Object.fromEntries(Object.keys(gearSlots).map(k=>[k,gearConfig(k,20)])),weaponLevel:10,awakenLevel:1};}
const defaults={v:2,left:[50006,50007,50009,50010,50008].map(unit),right:[50013,50006,50016,50017,50018].map(id=>unit(byId.has(id)?id:heroes[0].id)),attackerSide:'left',tech:{left:{research:{},squadNo:1},right:{research:{},squadNo:1}},seed:42,model:{defenseK:1,maxDuration:60}};
let setup=clone(defaults),selected={side:'left',slot:0},result=null,playTime=0,playing=false,lastTick=0,raf=0,dragSource=null,toastTimer,researchSide='left';
function normalize(v){
 if(!v||!Array.isArray(v.left)||!Array.isArray(v.right)||v.left.length!==5||v.right.length!==5)throw Error('Invalid formations');
 const out=clone(defaults);
 for(const side of ['left','right']){
  const seen=new Set();out[side]=v[side].map(c=>{if(c===null)return null;if(!c||!byId.has(Number(c.heroId)))throw Error('Unknown hero');if(seen.has(Number(c.heroId)))throw Error('Duplicate hero');seen.add(Number(c.heroId));const x=unit(Number(c.heroId));x.form=c.form;x.gear={};x.skillLevels={};const bounds={level:[1,175],exp:[0,1e12],shardLevel:[0,5],skillLevel:[1,60],weaponLevel:[1,30],awakenLevel:[1,25]};for(const [key,[lo,hi]]of Object.entries(bounds)){const v=Number(c[key]??x[key]);if(!Number.isFinite(v))throw Error('Invalid progression');x[key]=Math.max(lo,Math.min(hi,v));}x.shardLevel=Math.round(x.shardLevel*5)/5;for(const key of Object.keys(gearSlots))x.gear[key]=gearConfig(key,c.gear?.[key]??20);for(const [key,value] of Object.entries(c.skillLevels||{}))if(['auto','active','passive','expertise','awakened'].includes(key)||/^\d{1,9}$/.test(key))x.skillLevels[key]=Math.max(1,Math.min(100,Number(value)||1));if(!['base','exclusive','awakened'].includes(x.form)||!byId.get(x.heroId).modes[x.form]?.available)x.form='base';return x;});
  const research=v.tech?.[side]?.research||{};
  out.tech[side]={research:{},squadNo:Math.max(1,Math.min(4,Math.round(Number(v.tech?.[side]?.squadNo)||1)))};
  for(const node of T.research||[]){const level=Math.max(0,Math.min(node.maxLevel,Math.round(Number(research[node.id])||0)));if(level)out.tech[side].research[node.id]=level;}
  if(typeof v.tech?.[side]==='number'&&v.tech[side]>0)out.tech[side].legacyGenericLevel=v.tech[side];
 }
 out.seed=Math.max(1,Math.min(4294967295,Math.trunc(Number(v.seed)||42)));
 out.attackerSide=v.attackerSide==='right'?'right':'left';
 out.model={defenseK:Math.max(0,Math.min(100,Number(v.model?.defenseK)??1)),maxDuration:Math.max(5,Math.min(180,Number(v.model?.maxDuration)||60))};if(!Number.isFinite(out.model.defenseK))out.model.defenseK=1;
 return out;
}
try{if(location.hash.startsWith('#setup='))setup=normalize(JSON.parse(decodeURIComponent(location.hash.slice(7))));else setup=normalize(getStore('lw-battle-autosave',defaults));}catch{setup=clone(defaults);}
const portrait=(h,c)=>h?.modes?.[c?.form||'base']?.image||h?.image||'';
function deployedTypes(side){const counts={tank:0,missile:0,aircraft:0};for(const c of setup[side]){if(!c)continue;const type=String(byId.get(c.heroId)?.type||'tank').toLowerCase();counts[type.includes('air')?'aircraft':type.includes('missile')?'missile':'tank']++;}return counts;}
function computed(c,side){if(!c)return null;try{return E.computeUnit({...c,role:setup.attackerSide===side?'attacker':'defender',deployedTypes:deployedTypes(side)},{...setup.tech[side],deployedArmyTypeCounts:deployedTypes(side)},D);}catch{return null;}}
function toast(key){$('toast').textContent=t(key);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2600);}
function stop(){playing=false;cancelAnimationFrame(raf);$('play').textContent=t('play');}
function invalidate(){stop();result=null;window.LastWikiReplay?.setSimulation(null);playTime=0;$('results').hidden=true;$('run-status').textContent=t('setupChanged');setStore('lw-battle-autosave',setup);renderBoards();}
function renderChrome(){
 document.documentElement.lang=lang.replace('_','-');document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.title=t('title')+' · Last Wiki';
 document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.dataset.i18n));
 $('language').innerHTML=Object.entries(langs).map(([k,n])=>`<option value="${k}"${k===lang?' selected':''}>${n}</option>`).join('');
 $('attacker-side').innerHTML=['left','right'].map(s=>`<option value="${s}"${setup.attackerSide===s?' selected':''}>${esc(t(s==='left'?'teamA':'teamB'))}</option>`).join('');$('attacker-side').setAttribute('aria-label',t('attacker'));
 $('seed').value=setup.seed;$('defense-k').value=setup.model.defenseK;$('max-duration').value=setup.model.maxDuration;
 $('model-notes').innerHTML=`<p>${esc(t('researchNote'))}</p><p>${esc(t('roleNote'))}</p>`;
 $('research-search').placeholder=t('searchResearch');$('research-search').setAttribute('aria-label',t('searchResearch'));$('research-category').setAttribute('aria-label',t('allCategories'));$('research-squad').setAttribute('aria-label',t('squad'));
}
function slotHtml(side,i){
 const c=setup[side][i],h=c&&byId.get(c.heroId),u=computed(c,side),active=selected.side===side&&selected.slot===i;
 if(!h)return`<button class="hero-slot empty${active?' selected':''}" data-slot="${i}" data-side="${side}" aria-label="${esc(t(side==='left'?'teamA':'teamB')+' '+t('position')+' '+(i+1)+' · '+t('empty'))}"><span class="slot-num">${i+1}</span><span class="empty-slot"><b>+</b>${esc(t('selectHero'))}</span></button>`;
 const formLabel=c.form==='base'?'':t(c.form);
 return`<button draggable="true" class="hero-slot ${h.rarity.toLowerCase()}${active?' selected':''}" data-slot="${i}" data-side="${side}" aria-label="${esc(t(side==='left'?'teamA':'teamB')+' '+t('position')+' '+(i+1)+' · '+name(h))}"><span class="slot-num">${i+1}</span>${formLabel?`<span class="slot-mode">${esc(formLabel)}</span>`:''}<img class="slot-art" src="${esc(portrait(h,c))}" alt="${esc(name(h))}" loading="lazy"><span class="slot-name">${esc(name(h))}</span><span class="slot-level">${esc(t('level'))} ${num(u?.effectiveLevel||c.level)} · ${num(c.shardLevel,1)} ★</span><span class="health-track"><span data-hp="${side}-${i}" style="width:100%"></span></span></button>`;
}
function renderBoards(){
 for(const side of ['left','right']){
  $('role-'+side).textContent=t(setup.attackerSide===side?'attacker':'defender');$('research-count-'+side).textContent=Object.keys(setup.tech[side].research).length;
  $('board-'+side).innerHTML=`<div class="board-row-label">${esc(t('front'))}</div><div class="slot-row">${[0,1].map(i=>slotHtml(side,i)).join('')}</div><div class="board-row-label">${esc(t('back'))}</div><div class="slot-row">${[2,3,4].map(i=>slotHtml(side,i)).join('')}</div>`;
  const units=setup[side].map(c=>computed(c,side)).filter(Boolean),hp=units.reduce((a,u)=>a+(u.stats?.hp||0),0),atk=units.reduce((a,u)=>a+(u.stats?.attack||0),0);
  $('totals-'+side).innerHTML=`<span>${esc(t('heroes')==='heroes'?t('hero'):t('heroes'))}<b>${units.length}/5</b></span><span>${esc(t('hp'))}<b>${compact(hp)}</b></span><span>${esc(t('attack'))}<b>${compact(atk)}</b></span>`;
 }
 if(result)paintHealth(playTime);
}
function field(key,value,min,max,step=1,wide=false,labelKey=key){return`<label${wide?' class="wide"':''}><span>${esc(t(labelKey))}</span><input data-field="${key}" type="number" min="${min}" max="${max}" step="${step}" value="${esc(value)}"></label>`;}
function promotionLabel(stage){return Math.floor(stage/5)+' ★'+(stage%5?' + '+stage%5+'/5':'');}
function nextBlueprints(item,stage){const row=item.promotionStages?.find(s=>Number(s.stage)===Number(stage));return(row?.costToNext||[]).filter(c=>(D.gear.blueprints||[]).some(b=>Number(b.id)===Number(c.id)));}
function gearEditor(c){return`<div class="equipment-area"><div class="section-line"><h3>${esc(t('gear'))}</h3><small>SR → SSR → UR → MR</small></div><p class="gear-hint">${esc(t('gearHint'))}</p>${Object.keys(gearSlots).map(key=>{
 const cfg=gearConfig(key,c.gear[key]),item=gearById(cfg.itemId),max=item?.maxLevel??40,stage=cfg.promotion||0,min=item?.minPromotion||0,cap=item?.maxPromotion||0;
 const opts=gearOptions(key).map(g=>`<option value="${g.id}"${cfg.itemId===Number(g.id)?' selected':''}>${esc((g.tierLabel||g.quality)+' · '+strip(locale(g.nameKey,g.name)))}</option>`).join('');
 const promotionOpts=Array.from({length:cap-min+1},(_,i)=>min+i).map(n=>{const costs=n?nextBlueprints(item,n-1):[];return`<option value="${n}"${n===stage?' selected':''}>${promotionLabel(n)}${costs.length?' · '+t('blueprints')+' ×'+costs.map(x=>x.amount).join('+'):''}${n===25?' · MR':''}</option>`;}).join('');
 const blueprints=item?nextBlueprints(item,stage):[];
 return`<section class="gear-card"><h3>${esc(t(key))}${item?.tierLabel?`<span class="gear-tier ${item.quality===6?'mr':''}">${esc(item.tierLabel)}</span>`:''}</h3><label><span class="sr-only">${esc(t(key)+' · '+t('quality'))}</span><select data-gear-item="${key}" aria-label="${esc(t(key)+' · '+t('quality'))}"><option value="0"${!cfg.itemId?' selected':''}>${esc(t('empty'))}</option>${opts}</select></label><div class="field-grid"><label><span>${esc(t('level'))}</span><input type="number" data-gear-level="${key}" aria-label="${esc(t(key)+' · '+t('level'))}" min="${item?.minLevel||0}" max="${max}" value="${cfg.level}"${!item||item.quality===6||stage>0?' disabled':''}></label><label><span>${esc(t('promotion'))}</span><select data-gear-promotion="${key}" aria-label="${esc(t(key)+' · '+t('promotion'))}"${!item||!cap||cfg.level<max||item.promotionTerminal?' disabled':''}>${promotionOpts||'<option value="0">0 ★</option>'}</select></label></div>${blueprints.length?`<div class="blueprint-cost"><span>${esc(t('nextUpgrade'))}</span>${blueprints.map(cost=>{const bp=D.gear.blueprints.find(b=>b.id===cost.id);return`<span>${bp?.image?`<img src="${esc(bp.image)}" alt="">`:''}${esc(locale(bp?.nameKey,bp?.name||t('blueprints')))} ×${num(cost.amount)}</span>`;}).join('')}</div>`:''}</section>`;
 }).join('')}<label style="display:block;margin-top:10px"><span>${esc(t('allGear'))}</span><input id="all-gear" type="range" min="0" max="40" value="${Math.round(Object.keys(gearSlots).reduce((a,k)=>a+gearConfig(k,c.gear[k]).level,0)/4)}"></label></div>`;}
const researchById=new Map((T.research||[]).map(r=>[String(r.id),r]));
function researchLevel(node){const level=setup.tech[researchSide].research[node.id]||0;return node.levels?.find(r=>Number(r.level)===Number(level))||{level:0,effects:[]};}
function researchEligible(node,effect){
 const cfg=setup.tech[researchSide],role=setup.attackerSide===researchSide?'attacker':'defender',counts=deployedTypes(researchSide);
 if(!effect.supported||node.squadNo&&node.squadNo!==cfg.squadNo||effect.squadNo&&effect.squadNo!==cfg.squadNo)return false;
 if(effect.side&&effect.side!=='both'&&effect.side!==role)return false;
 if(effect.multiplier?.kind==='deployedArmyTypeCount'&&!counts[({1:'tank',2:'missile',3:'aircraft'})[effect.multiplier.armyType]||effect.multiplier.armyType])return false;
 return!(effect.unitTypes||[]).length||effect.unitTypes.some(x=>counts[({1:'tank',2:'missile',3:'aircraft'})[x]||x]>0);
}
function researchEffects(node){const row=researchLevel(node),selected=Number(row.level)>0;return(row.effects||[]).map(effect=>{
 const supported=researchEligible(node,effect),description=T.effectMappings?.[effect.effectId],stat=['hp','attack','defense','critical'].includes(effect.stat)?t(effect.stat):locale(description?.nameKey,description?.name||node.descriptions?.[lang]||node.description||t('storedOnly'));
 const shown=effect.displayValue??effect.value??Number(effect.sourceValue),percent=effect.operation==='percent'||effect.displayOperation==='percent';
 let value=Number.isFinite(Number(shown))?(percent?num(shown*100,3)+'%':num(shown,3)):'—';
 if(effect.multiplier?.kind==='deployedArmyTypeCount'){const counts=deployedTypes(researchSide),count=counts[({1:'tank',2:'missile',3:'aircraft'})[effect.multiplier.armyType]||effect.multiplier.armyType]||0;value+=' ×'+count+' = '+num(Number(shown)*count*(percent?100:1),3)+(percent?'%':'');}
 const tags=[(effect.unitTypes||[]).map(x=>({1:'Tank',2:'Missile',3:'Aircraft'})[x]||x).join('/'),effect.side&&effect.side!=='both'?t(effect.side):'',node.squadNo?t('squad')+' '+node.squadNo:''].filter(Boolean).join(' · ');
 return`<span class="research-effect ${selected&&supported?'applied':''}">${esc(stat)} ${esc(value)}${tags?` <small>${esc(tags)}</small>`:''} <b>${esc(t(supported?'applied':'storedOnly'))}</b></span>`;
 }).join('')||`<span class="research-effect">—</span>`;}
function renderResearchList(){
 const q=$('research-search').value.trim().toLocaleLowerCase(),category=$('research-category').value,onlySelected=$('research-selected').checked;
 const rows=(T.research||[]).filter(node=>(category==='__all'||category==='__combat'&&node.supported||String(node.categoryId)===category)&&(!onlySelected||setup.tech[researchSide].research[node.id]>0)&&(!q||(node.names?.[lang]||node.name).toLocaleLowerCase().includes(q)||(node.descriptions?.[lang]||node.description||'').toLocaleLowerCase().includes(q)));
 $('research-list').innerHTML=rows.map(node=>`<article class="research-row" data-research-row="${node.id}"><div>${node.image?`<img src="${esc(node.image)}" alt="" loading="lazy">`:''}<div><strong>${esc(node.names?.[lang]||locale(node.nameKey,node.name))}</strong><small>${esc(node.categoryNames?.[lang]||node.category)} · ${esc(node.descriptions?.[lang]||node.description||'')}</small><div class="research-effects">${researchEffects(node)}</div></div></div><label><span>${esc(t('level'))}</span><input data-research-id="${node.id}" type="number" min="0" max="${node.maxLevel}" value="${setup.tech[researchSide].research[node.id]||0}" aria-label="${esc((node.names?.[lang]||node.name)+' · '+t('level'))}"><small>0–${node.maxLevel}</small></label></article>`).join('');
 renderResearchSummary();
}
function renderResearchSummary(){const chosen=Object.entries(setup.tech[researchSide].research).filter(([,level])=>level>0);let applied=0;for(const [id]of chosen){const node=researchById.get(id);if(node&&researchLevel(node).effects.some(effect=>researchEligible(node,effect)))applied++;}$('research-summary').textContent=t(researchSide==='left'?'teamA':'teamB')+' · '+t(setup.attackerSide===researchSide?'attacker':'defender')+' · '+chosen.length+' '+t('research')+' · '+applied+' '+t('applied')+' · '+(chosen.length-applied)+' '+t('storedOnly');}
function openResearch(side){researchSide=side;$('research-side').textContent=t(side==='left'?'teamA':'teamB')+' / '+t(setup.attackerSide===side?'attacker':'defender');$('research-category').innerHTML=`<option value="__combat">${esc(t('research')+' · '+t('stats'))}</option><option value="__all">${esc(t('allCategories'))}</option>`+(T.categories||[]).map(c=>`<option value="${c.id}">${esc(c.names?.[lang]||locale(c.nameKey,c.name))}</option>`).join('');$('research-search').value='';$('research-selected').checked=false;$('research-squad').value=setup.tech[side].squadNo;renderResearchList();$('research-dialog').showModal();}
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
 const equipment=gearEditor(c);
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
function run(){stop();try{setup=normalize(setup);result=E.simulate(clone(setup),D);if(!result||!Array.isArray(result.events)||result.reason==='empty-team')throw Error('Invalid result');renderResults();window.LastWikiReplay?.setSimulation(result);}catch(error){result=null;window.LastWikiReplay?.setSimulation(null);$('results').hidden=true;$('run-status').textContent=t('emptyTeams');toast('emptyTeams');}}
function tick(now){if(!playing||!result)return;const delta=lastTick?(now-lastTick)/1000:0;lastTick=now;const previous=playTime;playTime=Math.min(result.duration,playTime+delta*Number($('speed').value));paintHealth(playTime);for(const e of result.events.filter(e=>e.time>previous&&e.time<=playTime&&Number.isInteger(e.targetSlot))){const card=document.querySelector(`[data-side="${e.targetSide}"][data-slot="${e.targetSlot}"]`);if(card){card.classList.remove('hit');void card.offsetWidth;card.classList.add('hit');}}if(playTime>=result.duration){stop();return;}raf=requestAnimationFrame(tick);}
function download(name,value){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function renderAll(){renderChrome();renderBoards();renderInspector();window.LastWikiReplay?.setLanguage(lang);if(result)renderResults();}
document.addEventListener('click',e=>{
 const tech=e.target.closest('[data-tech-side]');if(tech){openResearch(tech.dataset.techSide);return;}
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
 if(el.id==='all-gear'){for(const k of Object.keys(gearSlots))c.gear[k]=gearConfig(k,{...c.gear[k],level:Number(el.value)});update();return;}
 if(el.dataset.gearItem){const k=el.dataset.gearItem;c.gear[k]=gearConfig(k,{itemId:Number(el.value),level:c.gear[k].level,promotion:0});update();return;}
 if(el.dataset.gearLevel){const k=el.dataset.gearLevel;c.gear[k]=gearConfig(k,{...c.gear[k],level:Number(el.value)});update();return;}
 if(el.dataset.gearPromotion){const k=el.dataset.gearPromotion;c.gear[k]=gearConfig(k,{...c.gear[k],promotion:Number(el.value)});update();return;}
 if(el.dataset.skill){c.skillLevels[el.dataset.skill]=Math.max(1,Math.min(Number(el.max)||60,Number(el.value)||1));update();return;}
 if(el.dataset.field){let v=Number(el.value);if(!Number.isFinite(v))v=Number(el.min)||0;v=Math.max(Number(el.min),Math.min(Number(el.max),v));if(el.dataset.field.startsWith('gear.'))c.gear[el.dataset.field.split('.')[1]]=v;else{c[el.dataset.field]=v;if(el.dataset.field==='skillLevel')c.skillLevels={};}update();}
});
document.addEventListener('dragstart',e=>{const el=e.target.closest('[data-slot]');if(el){dragSource={side:el.dataset.side,slot:Number(el.dataset.slot)};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(dragSource));}});
document.addEventListener('dragover',e=>{const el=e.target.closest('[data-slot]');if(el&&dragSource?.side===el.dataset.side){e.preventDefault();el.classList.add('drag-over');}});
document.addEventListener('dragleave',e=>e.target.closest('[data-slot]')?.classList.remove('drag-over'));
document.addEventListener('drop',e=>{const el=e.target.closest('[data-slot]');if(el&&dragSource){e.preventDefault();move(dragSource,{side:el.dataset.side,slot:Number(el.dataset.slot)});}dragSource=null;});
document.addEventListener('dragend',()=>{dragSource=null;document.querySelectorAll('.drag-over').forEach(e=>e.classList.remove('drag-over'));});
$('language').addEventListener('change',e=>{stop();lang=e.target.value;setStore('lw-language',lang);renderAll();});
$('attacker-side').addEventListener('change',e=>{setup.attackerSide=e.target.value;update();});
$('research-close').addEventListener('click',()=>$('research-dialog').close());
$('research-dialog').addEventListener('click',e=>{if(e.target===$('research-dialog'))$('research-dialog').close();});
$('research-search').addEventListener('input',renderResearchList);
$('research-category').addEventListener('change',renderResearchList);
$('research-selected').addEventListener('change',renderResearchList);
$('research-squad').addEventListener('change',e=>{setup.tech[researchSide].squadNo=Number(e.target.value);update();renderResearchList();});
$('research-clear').addEventListener('click',()=>{setup.tech[researchSide].research={};update();renderResearchList();});
$('research-list').addEventListener('change',e=>{const id=e.target.dataset.researchId,node=researchById.get(id);if(!node)return;const level=Math.max(0,Math.min(node.maxLevel,Math.round(Number(e.target.value)||0)));if(level)setup.tech[researchSide].research[id]=level;else delete setup.tech[researchSide].research[id];e.target.value=level;update();const row=e.target.closest('[data-research-row]');row.querySelector('.research-effects').innerHTML=researchEffects(node);renderResearchSummary();});
$('model-toggle').addEventListener('click',()=>{$('model-panel').hidden=!$('model-panel').hidden;});
for(const [id,key] of [['seed','seed'],['defense-k','defenseK'],['max-duration','maxDuration']])$(id).addEventListener('change',e=>{const v=Math.max(Number(e.target.min),Math.min(Number(e.target.max),Number(e.target.value)||Number(e.target.min)));if(key==='seed')setup.seed=v;else setup.model[key]=v;e.target.value=v;invalidate();});
$('remove-hero').addEventListener('click',()=>{setup[selected.side][selected.slot]=null;update();});
$('copy-team').addEventListener('click',()=>{setup.right=clone(setup.left);setup.tech.right=clone(setup.tech.left);update();});
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
window.LastWikiReplay?.init($('replay-lab'),lang);
renderAll();
})();
