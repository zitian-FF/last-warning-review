(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BattleEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var DEFAULT_MODEL = Object.freeze({
    defenseK: 1.8, damageScale: 0.55, critMultiplier: 1.75, baseCritChance: 0.12,
    typeCounterBonus: 0.2,
    autoInterval: 1.5, activeInterval: 8, activeFirst: 4, genericAutoCoefficient: 1,
    genericActiveCoefficient: 2.4, maxDuration: 90, maxEvents: 12000
  });
  var MODEL_NOTES = [
    'Estimated comparison model, not the official Last War battle formula.',
    'Recovered client template/rank parameters and selected equipment curves provide stat inputs. Only source-reviewed technology effects are applied; final combat composition remains a model.',
    'Damage = attack² / (attack + defense × defenseK) × selected skill coefficient × damageScale × critical and type factors. This equation is a modeling assumption.',
    'Assumed type cycle: aircraft → tank → missile → aircraft. The configured bonus is estimated.',
    'Critical chance uses an assumed base plus recovered gear/research chance effects, capped at an estimated 85%; critical multiplier remains a model parameter. Other unreviewed percentage effects are not guessed.',
    'Only generic auto and active damage are simulated, with source-gated Bullet eligibility, target counts, Tesla fixed timing, DVA haste and Kimberly source-base rockets where exact unlocked metadata matches. Most passives, buffs, shields, DOT, targeting exceptions, UAV and Dominator mechanics remain omitted.',
    'Equal-time events resolve in stable queue order. The recorded server timing and RNG are not reproduced.',
    'Snapshot configuration and historic report schema versions do not establish current live-game equivalence.'
  ];
  var CAPABILITIES = Object.freeze({ skillTriggers: false, limitedSourceMechanics: 'source-gated Bullet eligibility/counts, exactTesla timing, exactDVA haste and Kimberly16base rockets only; no general trigger/buff solver', targeting: 'front-row-estimate; sourceKimberly burst uses modeled random living hero', rng: 'seeded-model-not-server', technology: 'source-reviewed-effects-only', gear: 'recovered-curves-and-cumulative-promotions' });
  function finite(value, fallback) { var n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
  function int(value, fallback) { return Math.round(finite(value, fallback)); }
  function array(value) { return Array.isArray(value) ? value : value && Array.isArray(value.rows) ? value.rows : value ? Object.keys(value).map(function (k) { return value[k]; }) : []; }
  function heroById(id, data) {
    var heroes = data && data.heroes;
    if (!heroes) return null;
    if (!Array.isArray(heroes) && heroes[id]) return heroes[id];
    return array(heroes).find(function (h) { return Number(h.id || h.heroId) === Number(id); }) || null;
  }
  function modelOptions(input) {
    var m = Object.assign({}, DEFAULT_MODEL);
    Object.keys(m).forEach(function (k) { if (input && input[k] !== undefined) m[k] = finite(input[k], m[k]); });
    m.defenseK = clamp(m.defenseK, 0, 100); m.damageScale = clamp(m.damageScale, 0.001, 100);
    m.critMultiplier = clamp(m.critMultiplier, 1, 10); m.baseCritChance = clamp(m.baseCritChance, 0, 1);
    m.typeCounterBonus = clamp(m.typeCounterBonus, 0, 2); m.maxDuration = clamp(m.maxDuration, 0.05, 600);
    m.maxEvents = clamp(int(m.maxEvents, 12000), 1, 100000);
    return m;
  }
  function maximumLevel(data, templateId) {
    var vals = array(data && data.templates).filter(function (x) { return Number(x.type || x.templateId) === Number(templateId); }).map(function (x) { return Number(x.level); }).filter(Number.isFinite);
    return vals.length ? Math.max.apply(null, vals) : 175;
  }
  function resolveExperience(level, exp, data, cap) {
    var max = cap || Math.max.apply(null, [175].concat(array(data && data.levels).map(function (r) { return finite(r.level || r.id, 1); })));
    var current = clamp(int(level, 1), 1, max), remaining = Math.max(0, finite(exp, 0)), gained = 0;
    var rows = array(data && data.levels), lookup = {};
    rows.forEach(function (r) { lookup[Number(r.level || r.id)] = finite(r.next_exp !== undefined ? r.next_exp : r.nextExp, 0); });
    while (current < max && gained <= max) {
      var cost = lookup[current];
      if (!(cost > 0) || remaining < cost) break;
      remaining -= cost; current += 1; gained += 1;
    }
    return { level: current, effectiveLevel: current, unusedExp: remaining, levelsGained: gained, nextExp: lookup[current] || 0, capped: current >= max };
  }
  function typeName(type) {
    var text = String(type === undefined ? 'tank' : type).toLowerCase();
    if (text === '1' || /tank/.test(text)) return 'tank';
    if (text === '2' || /missile/.test(text)) return 'missile';
    if (text === '3' || /air|heli/.test(text)) return 'aircraft';
    return text;
  }
  function rowAtLevel(rows, level) {
    var sorted = array(rows).filter(function (r) { return Number.isFinite(Number(r.lv !== undefined ? r.lv : r.level)); }).sort(function (a, b) { return Number(a.lv !== undefined ? a.lv : a.level) - Number(b.lv !== undefined ? b.lv : b.level); });
    var chosen = null;
    sorted.forEach(function (r) { if (Number(r.lv !== undefined ? r.lv : r.level) <= level) chosen = r; });
    return chosen || sorted[0] || null;
  }
  function modeAvailable(mode) { return !!mode && mode !== false && mode.available !== false && mode.supported !== false; }
  function technologyModifiers(input, data, unitType, role, context) {
    var result = { flat: { hp: 0, attack: 0, defense: 0, critChance: 0, critMultiplier: 0 }, percent: { hp: 0, attack: 0, defense: 0 }, research: {}, applied: [], skipped: [], unsupported: [], notes: [] };
    if (typeof input === 'number') { result.notes.push('Legacy numeric technology level was ignored: choose individual research; no invented research levels or generic stat boost were imported.'); return result; }
    var selected = input && input.research || {}, tech = data.technology || {}, records = array(tech.research);
    var squadNo = clamp(int(input && input.squadNo, 1), 1, 4), rawCounts = input && input.deployedArmyTypeCounts || context && context.deployedTypes, counts = {};
    if (rawCounts) Object.keys(rawCounts).forEach(function (k) { counts[typeName(k)] = clamp(int(rawCounts[k], 0), 0, 5); });
    Object.keys(selected).sort().forEach(function (id) {
      var research = records.find(function (r) { return String(r.id) === String(id); });
      if (!research) { result.unsupported.push({ researchId: id, reason: 'Research definition unavailable' }); return; }
      var requested = selected[id] && typeof selected[id] === 'object' ? selected[id].level : selected[id];
      var lv = clamp(int(requested, 0), 0, int(research.maxLevel, 0)); result.research[id] = lv;
      if (lv === 0) return;
      if (research.squadNo && Number(research.squadNo) !== squadNo) { result.skipped.push({ researchId: id, level: lv, reason: 'Research belongs to Squad ' + research.squadNo + '; selected Squad ' + squadNo }); return; }
      var row = array(research.levels).find(function (r) { return Number(r.level) === lv; });
      if (!row) { result.unsupported.push({ researchId: id, level: lv, reason: 'Exact research level row unavailable; no interpolation used' }); return; }
      array(row.effects).forEach(function (e) {
        var mapping = tech.effectMappings && tech.effectMappings[e.effectId] || {}, effect = Object.assign({}, mapping, e);
        var record = { researchId: research.id, level: lv, effectId: e.effectId, value: finite(effect.value, 0), stat: effect.stat, operation: effect.operation };
        if (effect.supported !== true || !effect.stat || ['flat', 'percent'].indexOf(effect.operation) < 0) { record.reason = effect.reason || 'Effect operation not source-reviewed'; result.unsupported.push(record); return; }
        var types = array(effect.unitTypes).map(typeName), effectSide = effect.side || 'both';
        if (effect.squadNo && Number(effect.squadNo) !== squadNo) { record.reason = 'Effect belongs to a different squad research tree'; result.skipped.push(record); return; }
        if (types.length && types.indexOf(unitType) < 0) { record.reason = 'Troop-type condition does not match'; result.skipped.push(record); return; }
        if (effectSide !== 'both' && effectSide !== role) { record.reason = 'Attacker/defender condition does not match'; result.skipped.push(record); return; }
        if (effect.multiplier) {
          var multiplierType = typeName(effect.multiplier.armyType);
          if (effect.multiplier.kind !== 'deployedArmyTypeCount' || !rawCounts) { record.reason = 'Requires reviewed deployed troop-type counts'; result.unsupported.push(record); return; }
          record.sourceValue = record.value; record.deployedTypeCount = counts[multiplierType] || 0; record.value *= record.deployedTypeCount;
        }
        var stat = effect.stat === 'crit' ? 'critChance' : effect.stat;
        if (!Object.prototype.hasOwnProperty.call(result[effect.operation], stat)) { record.reason = 'Unsupported stat/operation combination'; result.unsupported.push(record); return; }
        result[effect.operation][stat] += record.value; result.applied.push(record);
      });
    });
    return result;
  }
  function equipmentSelection(input, data) {
    var items = array(data.gear && data.gear.items), names = ['weapon', 'armor', 'chip', 'radar'];
    var result = { slots: {}, hp: 0, attack: 0, defense: 0, critChance: 0, applied: [], unsupported: [], notes: [] };
    names.forEach(function (name, index) {
      var raw = input && input[name], legacy = typeof raw === 'number' || typeof raw === 'string', cfg = raw && typeof raw === 'object' ? raw : { level: raw };
      if (cfg.itemId !== undefined && Number(cfg.itemId) === 0) { result.slots[name] = { itemId: 0, level: 0, promotion: 0, quality: 0, name: 'Empty' }; return; }
      var eligible = items.filter(function (item) { return Number(item.slot) === index + 1; });
      var item = cfg.itemId !== undefined ? eligible.find(function (x) { return Number(x.id) === Number(cfg.itemId); }) : eligible.find(function (x) { return Number(x.quality) === 5; }) || eligible[0];
      if (!item) { result.slots[name] = { itemId: cfg.itemId === undefined ? null : finite(cfg.itemId, 0), level: 0, promotion: 0 }; result.unsupported.push({ slot: name, reason: 'Equipment definition unavailable; no estimated increments applied' }); return; }
      var maxLevel = Math.max.apply(null, [0].concat(array(item.perLevel).map(function (r) { return finite(r.level, 0); })));
      var level = clamp(int(cfg.level, 0), int(item.minLevel, 0), maxLevel), minPromotion = int(item.minPromotion, 0), maxPromotion = int(item.maxPromotion, 0);
      var promotion = clamp(int(cfg.promotion !== undefined ? cfg.promotion : cfg.stage, minPromotion), minPromotion, maxPromotion);
      var promotionRequiresLevel = finite(item.promotionRequiresLevel, maxLevel);
      if (promotion > 0 && level < promotionRequiresLevel) {
        if (minPromotion > 0) { level = promotionRequiresLevel; result.notes.push(name + ': recovered minimum promotion requires base level ' + promotionRequiresLevel + '; level normalized.'); }
        else { promotion = 0; result.notes.push(name + ': blueprint promotion requires base level ' + promotionRequiresLevel + '; premature promotion was not applied.'); }
      }
      var target = item.promotionTarget || item.targetPromotion;
      if (target && promotion >= finite(target.stage !== undefined ? target.stage : target.promotion, Infinity)) {
        var upgraded = eligible.find(function (x) { return Number(x.id) === Number(target.itemId); });
        if (upgraded) { item = upgraded; promotion = clamp(promotion, int(item.minPromotion, 0), int(item.maxPromotion, promotion)); }
      }
      var base = array(item.perLevel).find(function (r) { return Number(r.level) === level; });
      var stages = array(item.promotionStages || item.promotions), stage = stages.find(function (r) { return Number(r.stage !== undefined ? r.stage : r.promotion !== undefined ? r.promotion : r.level) === promotion; });
      result.slots[name] = { itemId: Number(item.id), level: level, promotion: promotion, quality: item.quality, name: item.name || name };
      if (legacy) result.notes.push('Legacy ' + name + ' level imported using the default M5 item and promotion 0; no blueprint or MR progress was inferred.');
      if (int(cfg.level, 0) !== level) result.notes.push(name + ' level clamped to recovered equipment curve ' + maxLevel + '; promotions are separate from base level.');
      [base, stage].forEach(function (row, rowIndex) {
        if (!row) return;
        ['hp', 'attack', 'defense'].forEach(function (stat) { result[stat] += finite(row[stat], 0); });
        var effects = row.effects || row.attributes || {};
        var critChance = finite(effects[50011], 0); result.critChance += critChance;
        result.applied.push({ slot: name, itemId: item.id, source: rowIndex ? 'cumulative-promotion-row-once' : 'base-level-row', level: rowIndex ? promotion : level, hp: finite(row.hp, 0), attack: finite(row.attack, 0), defense: finite(row.defense, 0), critChance: critChance });
        Object.keys(effects).forEach(function (id) { if ([50005, 50008, 50010, 50011].indexOf(Number(id)) < 0) result.unsupported.push({ slot: name, itemId: item.id, effectId: Number(id), value: effects[id], reason: 'Additional equipment effect retained, not applied without its reviewed replacement/operation mapping' }); });
      });
      if (!base) result.unsupported.push({ slot: name, itemId: item.id, level: level, reason: 'Exact base-level row missing; no interpolation used' });
      if (promotion > 0 && !stage) result.unsupported.push({ slot: name, itemId: item.id, promotion: promotion, reason: 'Exact promotion row missing; no fabricated promotion/MR increment' });
    });
    return result;
  }
  function rankRequired(skill) { var v = skill.needRank !== undefined ? skill.needRank : skill.need_rank; return finite(typeof v === 'string' ? v.split(/[;,]/)[0] : v, 1); }
  function selectSkillVariant(skill, rankId) {
    var all = array(skill.variants).sort(function (a, b) { return rankRequired(a) - rankRequired(b) || finite(a.star, 0) - finite(b.star, 0); });
    var variants = all.filter(function (v) { return rankRequired(v) <= rankId; });
    return Object.assign({}, skill, variants.length ? variants[variants.length - 1] : all[0] || {});
  }
  function skillProfile(raw, index, config, rankId, model, levelBonus, effectiveHeroLevel) {
    var s = selectSkillVariant(raw, rankId), text = String(s.type || s.kind || '').toLowerCase();
    var auto = /auto|normal|basic/.test(text) || s.isNormalAttack === true || Number(s.is_normal_attack) === 1;
    var passive = /passive|expert|buff|support/.test(text);
    // Client SkillInfo.GetAddMaxLevel excludes Talent and HeroAwaken categories.
    var bonusEligible = !/expertise|talent|awaken/.test(text);
    var maxLv = Math.max(1, int(s.maxLevel, 40) + (bonusEligible ? Math.max(0, int(levelBonus, 0)) : 0));
    var keyed = config.skillLevels || {}, override = keyed[s.id] !== undefined ? keyed[s.id] : keyed[s.groupId] !== undefined ? keyed[s.groupId] : keyed[s.type] !== undefined ? keyed[s.type] : keyed[text];
    var level = clamp(int(override !== undefined ? override : config.skillLevel, 20), 1, maxLv);
    var unlockLevel = Math.max(1, finite(raw._unlockLevel, 1)), unlockRank = Math.max(rankRequired(s), finite(raw._unlockRank, 1));
    var locked = finite(effectiveHeroLevel, finite(config.level, 1)) < unlockLevel || rankId < unlockRank;
    var base = finite(s.base !== undefined ? s.base : s.damageBase, NaN);
    var per = finite(s.perLevel !== undefined ? s.perLevel : s.damagePerLevel, 0);
    var ratio = finite(s.damageRatio !== undefined ? s.damageRatio : s.damage_ratio, 1);
    // A known zero-damage support ability remains zero. Generic profiles are added only
    // when the hero has no recovered skill metadata at all.
    var damageSource = recordedDamageSource(s);
    var coefficient = Number.isFinite(base) && damageSource.directBulletSupported ? Math.max(0, (base + level * per) * ratio) : 0;
    var interval = finite(s.intervalMs !== undefined ? s.intervalMs : s.attackIntervalMs, NaN) / 1000;
    if (!Number.isFinite(interval)) interval = finite(s.interval, auto ? model.autoInterval : model.activeInterval);
    var pre = finite(s.preCdMs !== undefined ? s.preCdMs : s.pre_cd, NaN) / 1000;
    return {
      id: s.id || s.skillId || s.groupId || ('generic-' + index), groupId: s.groupId || s.id || s.skillId || null,
      name: s.name || (auto ? 'Auto attack' : 'Active skill'), nameKey: s.nameKey || '', descriptionKey: s.descriptionKey || '',
      type: passive ? 'passive' : auto ? 'auto' : index === 0 && !text ? 'auto' : 'active',
      level: level, maxLevel: maxLv, locked: locked, unlockLevel: unlockLevel, unlockRank: unlockRank,
      coefficient: clamp(coefficient, 0, 100), damageType: s.damageType || 'physical',
      interval: clamp(interval, auto ? 0.25 : 2, auto ? 10 : 60),
      preCooldown: Number.isFinite(pre) && pre >= 0 ? pre : auto ? 0.5 : model.activeFirst,
      targetCount: damageSource.targetCountEvidence ? damageSource.targetCount : clamp(int(s.targetCount, 1), 1, 5), sourceDirectDamage: damageSource, fixedImpactDelayMs: recordedFixedImpactDelay(s), sourceBurst: sourceKimberlyBurst(s), source: s.genericFallback ? 'generic estimated coefficient: no recovered skill metadata' : Number.isFinite(base) ? 'recovered coefficient; estimated combat application' : 'missing coefficient; ability not executed',
      raw: s
    };
  }
  function computeUnit(config, teamTech, data, modelInput) {
    if (!config || config.heroId === null || config.heroId === undefined || config.heroId === '') return null;
    data = data || {}; var model = modelOptions(modelInput), cfg = Object.assign({}, config), hero = heroById(cfg.heroId, data);
    if (!hero) throw new Error('Unknown hero definition: ' + String(cfg.heroId));
    var notes = [], modeName = ['base', 'exclusive', 'awakened'].indexOf(cfg.form) >= 0 ? cfg.form : 'base';
    var modes = hero.modes || {}, selectedMode = modes[modeName];
    if (modeName !== 'base' && !modeAvailable(selectedMode)) { notes.push('Requested form unavailable in this snapshot; using base form without a form bonus.'); modeName = 'base'; selectedMode = modes.base; }
    var formHero = selectedMode && selectedMode.heroId ? heroById(selectedMode.heroId, data) : null;
    var sourceHero = formHero || hero, templateId = sourceHero.templateId || sourceHero.template_id || 1;
    var cap = maximumLevel(data, templateId), xp = resolveExperience(cfg.level, cfg.exp, data, cap);
    var level = xp.level, shard = clamp(finite(cfg.shardLevel, 3), 0, 5), rankId = 1 + Math.round(shard * 5);
    var templates = array(data.templates).filter(function (r) { return Number(r.type || r.templateId) === Number(templateId); });
    var template = templates.find(function (r) { return Number(r.level) === level; });
    if (!template) {
      template = rowAtLevel(templates, level);
      if (!template) { template = { base_hp: 1080 + 135 * (level - 1), base_patk: 25.72 + 3.215 * (level - 1), base_pdef: 5.15 + 0.643 * (level - 1) }; notes.push('Missing template row: explicit generic stat fallback used.'); }
      else notes.push('Missing exact level row: nearest lower recovered template used.');
    }
    var ranks = array(data.ranks), rank = ranks.find(function (r) { return Number(r.id) === rankId; }) || ranks[0] || { attr_add: {}, attr_ratio: 1 };
    var coeff = sourceHero.baseCoefficients || hero.baseCoefficients || {}, add = rank.attr_add || rank.add || {};
    function stat(field, short, effect) {
      var c = finite(coeff[short], finite(sourceHero[field], 10000)); if (c > 10) c /= 10000;
      return Math.max(1, (finite(template[field], 1) + finite(add[effect], finite(add[short], 0))) * finite(rank.attr_ratio !== undefined ? rank.attr_ratio : rank.ratio, 1) * c);
    }
    var baseStats = { hp: stat('base_hp', 'hp', 50006), attack: stat('base_patk', 'attack', 50007), defense: stat('base_pdef', 'defense', 50009) };
    var stats = Object.assign({}, baseStats), formParams = null, skillLevelBonus = 0;
    var weaponLevel = clamp(int(cfg.weaponLevel, 10), 1, 100), awakenLevel = clamp(int(cfg.awakenLevel, 1), 0, 25);
    if (modeName === 'exclusive' || modeName === 'awakened') {
      var ew = modes.exclusive || {};
      var weaponRows = ew.levels || ew.rows || ew.progression || ew.milestones;
      formParams = rowAtLevel(weaponRows, weaponLevel);
      var attrs = formParams && (formParams.attr || formParams.attributes || formParams.statBonuses) || ew.attr || ew.statBonuses;
      if (attrs) {
        stats.hp += finite(attrs[51000], finite(attrs.hp, 0)); stats.attack += finite(attrs[51050], finite(attrs.attack, 0)); stats.defense += finite(attrs[51100], finite(attrs.defense, 0));
        skillLevelBonus = Math.max(0, int(attrs[90027], 0));
        notes.push('Exclusive-weapon parameters are added as flat stats in this estimated model; full in-game composition and effects are not reproduced.');
      } else notes.push('Exclusive form bindings available; unresolved weapon stat effects are not granted a guessed bonus.');
      if (modeName === 'awakened') {
        var aw = modes.awakened || {}, awRow = rowAtLevel(aw.levels || aw.rows || aw.progression, awakenLevel);
        var awAttr = awRow && (awRow.attr_add || awRow.attr || awRow.statBonuses) || aw.attr_add || aw.statBonuses;
        if (awAttr) { stats.hp += finite(awAttr[51000], finite(awAttr.hp, 0)); stats.attack += finite(awAttr[51050], finite(awAttr.attack, 0)); stats.defense += finite(awAttr[51100], finite(awAttr.defense, 0)); }
        notes.push('Awakening uses available flat parameters only; awakening trigger, energy and passive mechanics are omitted.');
      }
    }
    var role = cfg.role === 'defender' ? 'defender' : 'attacker', troopType = typeName(hero.type || hero.unitType || hero.army_type);
    var gearInfo = equipmentSelection(cfg.gear || {}, data), tech = technologyModifiers(teamTech, data, troopType, role, { deployedTypes: cfg.deployedTypes });
    ['hp', 'attack', 'defense'].forEach(function (stat) { stats[stat] = (stats[stat] + gearInfo[stat] + tech.flat[stat]) * (1 + tech.percent[stat]); });
    notes = notes.concat(gearInfo.notes, tech.notes);
    notes.push('Recovered equipment and research quantities are applied with the stated flat/percent model composition; the complete official stat evaluator is not reproduced.');
    if (gearInfo.unsupported.length) notes.push('Some additional equipment effects are retained but unapplied; see unsupportedGearEffects.');
    if (tech.unsupported.length) notes.push('Some selected research effects are unsupported and were not applied; see unsupportedTechnology.');
    ['hp', 'attack', 'defense'].forEach(function (k) { stats[k] = Math.max(1, Math.round(finite(stats[k], 1))); });
    stats.critChance = clamp(finite(hero.critChance, model.baseCritChance) + gearInfo.critChance + tech.flat.critChance, 0, 0.85);
    stats.critMultiplier = Math.max(1, model.critMultiplier + tech.flat.critMultiplier);
    var unlockLevels = sourceHero.skillUnlockLevels || hero.skillUnlockLevels || [], unlockRanks = sourceHero.skillUnlockRanks || hero.skillUnlockRanks || [];
    var rawSkills = array(sourceHero.skills || hero.skills || []).map(function (s, i) { return Object.assign({}, s, { _unlockLevel: finite(unlockLevels[i], 1), _unlockRank: finite(unlockRanks[i], 1) }); });
    if (modeName !== 'base') {
      var exclusive = modes.exclusive || {}, pool = array(exclusive.skills), milestones = array(exclusive.milestones).filter(function (m) { return finite(m.level || m.lv, 0) <= weaponLevel; });
      if (pool.length && !milestones.length) rawSkills = pool.slice();
      milestones.forEach(function (milestone) {
        Object.keys(milestone.skillChange || {}).forEach(function (oldGroup) {
          var newGroup = Number(milestone.skillChange[oldGroup]), replacement = pool.find(function (s) { return Number(s.groupId || s.id) === newGroup; });
          var at = rawSkills.findIndex(function (s) { return Number(s.groupId || s.id) === Number(oldGroup); });
          if (replacement && at >= 0) rawSkills[at] = Object.assign({}, replacement, { _unlockLevel: rawSkills[at]._unlockLevel, _unlockRank: rawSkills[at]._unlockRank });
        });
        var additions = milestone.skillAdd || {};
        var addGroups = Array.isArray(additions) ? additions.map(function (g) { return typeof g === 'object' ? Number(g.groupId || g.id) : Number(g); }) : Object.keys(additions).map(Number);
        addGroups.forEach(function (groupId) {
          var extra = pool.find(function (s) { return Number(s.groupId || s.id) === groupId; });
          if (extra && !rawSkills.some(function (s) { return s.id === extra.id; })) rawSkills.push(extra);
        });
      });
      if (modeName === 'awakened') {
        var awakeningRow = rowAtLevel(selectedMode.levels || selectedMode.rows || selectedMode.progression, awakenLevel);
        var unlockedGroups = awakeningRow ? array(awakeningRow.skill_list || awakeningRow.skillList).map(Number) : [];
        rawSkills = rawSkills.concat(array(selectedMode.skills).filter(function (s) { return unlockedGroups.indexOf(Number(s.groupId || s.id)) >= 0; }));
      }
    }
    var skills = array(rawSkills).map(function (s, i) { return skillProfile(s, i, cfg, rankId, model, skillLevelBonus, level); });
    if (!rawSkills.length) {
      skills = [skillProfile({ type: 'auto', name: 'Generic auto attack', base: model.genericAutoCoefficient, maxLevel: 60, intervalMs: 1500, genericFallback: true }, 0, cfg, rankId, model),
        skillProfile({ type: 'active', name: 'Generic active damage', base: model.genericActiveCoefficient, maxLevel: 60, intervalMs: 8000, genericFallback: true }, 1, cfg, rankId, model)];
      notes.push('No recovered skill metadata: explicitly generic auto/active damage profiles used.');
    }
    var autos = skills.filter(function (s) { return s.type === 'auto' && s.coefficient > 0 && !s.locked; }), activeSkills = skills.filter(function (s) { return s.type === 'active' && s.coefficient > 0 && !s.locked; });
    var used = [autos[0], activeSkills[0]].filter(Boolean), unsupported = skills.filter(function (s) { return used.indexOf(s) < 0; }).map(function (s) { return { heroId: hero.id, skillId: s.id, groupId: s.groupId, name: s.name, level: s.level, reason: s.locked ? 'Locked: requires hero level ' + s.unlockLevel + ' and rank ' + s.unlockRank : s.coefficient <= 0 ? 'Non-damaging ability: heal/shield/buff mechanics not simulated; no damage is invented' : s.type === 'passive' ? 'Passive/buff mechanics omitted' : 'Only one auto and one active damage profile are executed' }; });
    cfg.form = modeName; cfg.level = level; cfg.exp = Math.max(0, finite(cfg.exp, 0)); cfg.shardLevel = shard;
    cfg.skillLevel = Math.max(1, int(cfg.skillLevel, 20)); cfg.weaponLevel = weaponLevel; cfg.awakenLevel = awakenLevel;
    cfg.gear = gearInfo.slots; cfg.role = role;
    if (cfg.skillLevels) { cfg.skillLevels = Object.assign({}, cfg.skillLevels); Object.keys(cfg.skillLevels).forEach(function (k) { cfg.skillLevels[k] = clamp(int(cfg.skillLevels[k], 1), 1, 100); }); }
    var sourceHaste = recordedDvaHaste(hero, skills.filter(function (skill) { return !skill.locked; }), data, {});
    if (sourceHaste) {
      notes.push('Exact unlocked DVA weapon skills grant source five-stack haste for5s; other buffs and trigger effects remain unsupported.');
      unsupported.forEach(function (skill) { if (skill.skillId === 501775) skill.reason = 'Source-bound opening haste applied; opening damage and other triggered mechanics remain unsupported.'; });
    }
    if (used.some(function (skill) { return skill.sourceBurst; })) notes.push('Kimberly weapon burst emits16source-base rockets100ms apart; first200ms offset and random targeting are modeled. Energy-stack extras, splash and moving travel remain unsupported.');
    return { heroId: Number(hero.id || cfg.heroId), name: hero.name || ('Hero ' + cfg.heroId), image: selectedMode && selectedMode.image || hero.image || '', type: troopType, role: role, form: modeName,
      level: level, effectiveLevel: level, unusedExp: xp.unusedExp, experience: xp, rankId: Number(rank.id || rankId), shardLevel: shard,
      stats: stats, baseStats: baseStats, skills: used, allSkills: skills, unsupportedSkills: unsupported, notes: notes, config: cfg,
      recordedHaste: sourceHaste,
      gear: gearInfo.slots, gearEffects: gearInfo.applied, unsupportedGearEffects: gearInfo.unsupported,
      technology: tech, unsupportedTechnology: tech.unsupported, teamTech: { research: tech.research, squadNo: clamp(int(teamTech && teamTech.squadNo, 1), 1, 4) }, capabilities: CAPABILITIES };
  }
  function seedNumber(value) { if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0; var s = String(value === undefined ? 12345 : value), h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rngFor(seed) { var a = seedNumber(seed); return function () { a = (a + 0x6D2B79F5) | 0; var t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function counterFactor(attacker, defender, model) { return ({ aircraft: 'tank', tank: 'missile', missile: 'aircraft' })[attacker] === defender ? 1 + model.typeCounterBonus : 1; }
  function runSimulation(input, data, prepared) {
    input = input || {}; data = data || {}; var model = modelOptions(input.model), rand = rngFor(input.seed), events = [], frames = [], queue = [], serial = 0;
    var attackerSide = input.attackerSide === 'right' ? 'right' : 'left';
    var roles = { left: attackerSide === 'left' ? 'attacker' : 'defender', right: attackerSide === 'right' ? 'attacker' : 'defender', attackerSide: attackerSide, defenderSide: attackerSide === 'left' ? 'right' : 'left' };
    var tech = input.tech || {}, teams = { left: [], right: [] }, initial = { left: [], right: [] }, errors = [], notes = MODEL_NOTES.slice(), unsupported = [];
    ['left', 'right'].forEach(function (side) {
      var deployedTypes = { tank: 0, missile: 0, aircraft: 0 };
      array(input[side]).slice(0, 5).forEach(function (c) { var h = c && heroById(c.heroId, data); if (h) { var t = typeName(h.type || h.unitType || h.army_type); deployedTypes[t] = (deployedTypes[t] || 0) + 1; } });
      for (var slot = 0; slot < 5; slot++) {
        var cfg = Array.isArray(input[side]) ? input[side][slot] : null, unit = null;
        try { unit = prepared ? prepared[side][slot] : computeUnit(cfg ? Object.assign({}, cfg, { role: roles[side], deployedTypes: deployedTypes }) : cfg, tech[side] && typeof tech[side] === 'object' ? Object.assign({}, tech[side], { deployedArmyTypeCounts: deployedTypes }) : tech[side], data, model); } catch (e) { errors.push(side + ' slot ' + (slot + 1) + ': ' + e.message); }
        initial[side].push(unit);
        if (!unit) { teams[side].push(null); continue; }
        var combatant = Object.assign({}, unit, { side: side, slot: slot, hp: prepared ? unit.initialHp : unit.stats.hp, damageDone: 0, damageTaken: 0, healingDone: 0, kills: 0 });
        if (unit.recordedHaste) {
          combatant.recordedHaste = Object.assign({}, unit.recordedHaste, { windows: unit.recordedHaste.windows.map(function (window) { return Object.assign({}, window); }) });
          if (combatant.recordedHaste.windows.length) events.push({ time: 0, type: 'buff', side: side, slot: slot, skillId: 501775, buffId: 501742, amount: 0, attackSpeedRate: combatant.recordedHaste.rate, expiresAt: 5, source: 'exact recorded EW opening skill and source grant metadata' });
        }
        teams[side].push(combatant); unsupported = unsupported.concat(unit.unsupportedSkills); notes = notes.concat(unit.notes);
        unit.skills.forEach(function (skill) { queue.push({ time: Math.max(0.1, skill.preCooldown), serial: serial++, side: side, slot: slot, skill: skill }); });
      }
    });
    function living(side) { return teams[side].filter(function (u) { return u && u.hp > 0; }); }
    function nextInterval(actor, skill, castTime) {
      if (!actor.recordedHaste || skill.id !== 501755 || skill.type !== 'auto') return Math.max(0.25, skill.interval);
      var haste = actor.recordedHaste, rate = haste.initialRate + (haste.windows.some(function (window) { return window.start <= castTime && castTime < window.end; }) ? haste.rate : 0);
      // Skill.RestartCD recomputes normal attack interval at the preceding cast.
      // Expiry does not rewrite an already queued future start.
      return Math.max(0.001, skill.interval / (1 + Math.max(-0.5, rate)));
    }
    function frame(time) { var f = { time: time, left: teams.left.map(function (u) { return u ? u.hp : 0; }), right: teams.right.map(function (u) { return u ? u.hp : 0; }) }; if (frames.length && frames[frames.length - 1].time === time) frames[frames.length - 1] = f; else frames.push(f); }
    function summaries(side) { var us = teams[side].map(function (u) { return u ? { heroId: u.heroId, name: u.name, slot: u.slot, type: u.type, role: u.role, form: u.form, hp: u.hp, maxHp: u.stats.hp, stats: u.stats, alive: u.hp > 0, damageDone: u.damageDone, damageTaken: u.damageTaken, healingDone: u.healingDone, kills: u.kills } : null; }); return { units: us, totalDamage: us.reduce(function (n, u) { return n + (u ? u.damageDone : 0); }, 0), totalHealing: 0, survivors: us.filter(function (u) { return u && u.alive; }).length }; }
    frame(0); var time = 0, processed = 0, reason = 'elimination';
    if (!living('left').length || !living('right').length) { errors.push('Both sides need at least one valid hero.'); reason = 'empty-team'; }
    else while (queue.length && living('left').length && living('right').length) {
      queue.sort(function (a, b) { return a.time - b.time || a.serial - b.serial; }); var action = queue.shift();
      if (action.time > model.maxDuration) { queue.unshift(action); time = model.maxDuration; reason = 'time-limit'; break; }
      if (processed++ >= model.maxEvents) { queue.unshift(action); reason = 'event-limit'; break; }
      time = action.time; var actor = teams[action.side][action.slot], fixedImpact = action.kind === 'fixed-impact', burstEmission = action.kind === 'burst-emission';
      if (!actor || actor.hp <= 0) {
        if (fixedImpact) events.push({ time: Math.round(time * 1000) / 1000, type: 'impact-cancelled', side: action.side, slot: action.slot, skillId: action.skill.id, amount: 0, reason: 'caster-dead-model-assumption', targetSide: action.side === 'left' ? 'right' : 'left', targetSlots: action.targetSlots.slice(), castTime: action.castTime });
        if (burstEmission) events.push({ time: Math.round(time * 1000) / 1000, type: 'emission-cancelled', side: action.side, slot: action.slot, skillId: action.skill.id, amount: 0, reason: 'caster-dead-model-policy; future emission omitted', burstShotIndex: action.shotIndex + 1, castTime: action.castTime });
        continue;
      }
      var other = action.side === 'left' ? 'right' : 'left', skill = action.skill;
      if (!fixedImpact && !burstEmission && skill.sourceBurst) {
        var burst = skill.sourceBurst, burstCastTime = Math.round(time * 1000) / 1000;
        events.push({ time: burstCastTime, type: 'cast', side: action.side, slot: actor.slot, skillId: skill.id, skill: skill.name, amount: 0, targetSide: other, burstCount: burst.count, firstEmissionTime: Math.round((time + burst.firstOffsetMs / 1000) * 1000) / 1000, firstOffsetBasis: burst.firstOffsetBasis });
        for (var shot = 0; shot < burst.count; shot++) queue.push({ kind: 'burst-emission', time: time + (burst.firstOffsetMs + shot * burst.intervalMs) / 1000, serial: serial++, side: action.side, slot: action.slot, skill: skill, castTime: burstCastTime, shotIndex: shot });
        queue.push({ time: time + nextInterval(actor, skill, time), serial: serial++, side: action.side, slot: action.slot, skill: skill });
        frame(burstCastTime); continue;
      }
      if (!fixedImpact && actor.recordedHaste && skill.id === actor.recordedHaste.activeGrantSkillId) {
        actor.recordedHaste.windows.push({ start: time, end: time + actor.recordedHaste.duration });
        events.push({ time: Math.round(time * 1000) / 1000, type: 'buff', side: action.side, slot: actor.slot, skillId: skill.id, buffId: 501742, amount: 0, attackSpeedRate: actor.recordedHaste.rate, expiresAt: Math.round((time + actor.recordedHaste.duration) * 1000) / 1000, source: 'modeled exact active cast; source five-stack grant, no observed outcome timing input' });
      }
      var candidates = living(other), front = candidates.filter(function (u) { return u.slot < 2; });
      var ordered = fixedImpact ? action.targetSlots.map(function (slot) { return teams[other][slot]; }).filter(Boolean) : burstEmission ? (candidates.length ? [candidates[Math.floor(rand() * candidates.length)]] : []) : front.concat(candidates.filter(function (u) { return u.slot >= 2; }));
      // Randomize only within the highest-priority row; front occupants always protect back occupants.
      if (!fixedImpact && !burstEmission && front.length > 1 && rand() > 0.5) { var temp = ordered[0]; ordered[0] = ordered[1]; ordered[1] = temp; }
      // Only the strict exact source Tesla skill/effect metadata enables this
      // delay. Ordinary profiles also pass source form/rank/unlock selection.
      if (!fixedImpact && skill.fixedImpactDelayMs === 200) {
        var castTime = Math.round(time * 1000) / 1000, targetSlots = ordered.slice(0, skill.targetCount).map(function (u) { return u.slot; });
        events.push({ time: castTime, type: 'cast', side: action.side, slot: actor.slot, skillId: skill.id, skill: skill.name, amount: 0, targetSide: other, targetSlots: targetSlots.slice(), impactTime: Math.round((time + 0.2) * 1000) / 1000, impactDelayMs: 200 });
        queue.push({ kind: 'fixed-impact', time: time + 0.2, serial: serial++, side: action.side, slot: action.slot, skill: skill, castTime: castTime, targetSlots: targetSlots });
        queue.push({ time: time + nextInterval(actor, skill, time), serial: serial++, side: action.side, slot: action.slot, skill: skill });
        frame(castTime);
        continue;
      }
      ordered.slice(0, skill.targetCount).forEach(function (target) {
        if (target.hp <= 0) {
          if (fixedImpact) events.push({ time: Math.round(time * 1000) / 1000, type: 'impact-cancelled', side: action.side, slot: actor.slot, targetSide: other, targetSlot: target.slot, skillId: skill.id, amount: 0, reason: 'original-target-dead-no-retarget-model', castTime: action.castTime });
          return;
        }
        var crit = rand() < actor.stats.critChance;
        var raw = actor.stats.attack * actor.stats.attack / Math.max(1, actor.stats.attack + target.stats.defense * model.defenseK);
        var critFactor = crit ? actor.stats.critMultiplier - (prepared ? target.stats.critDamageResistance || 0 : 0) : 1;
        raw *= skill.coefficient * model.damageScale * counterFactor(actor.type, target.type, model) * critFactor;
        var amount = Math.min(target.hp, Math.max(1, Math.round(finite(raw, 1))));
        target.hp = Math.max(0, target.hp - amount); target.damageTaken += amount; actor.damageDone += amount;
        var t = Math.round(time * 1000) / 1000;
        if (burstEmission) events.push({ time: t, type: 'emission', side: action.side, slot: actor.slot, skillId: skill.id, amount: 0, targetSide: other, targetSlot: target.slot, castTime: action.castTime, burstShotIndex: action.shotIndex + 1, movingTravelPolicy: 'not modeled; estimated damage at emission' });
        events.push({ time: t, type: skill.type === 'auto' ? 'attack' : 'skill', side: action.side, slot: actor.slot, targetSide: other, targetSlot: target.slot, amount: amount, rawAmount: Math.max(1, Math.round(raw)), crit: crit, skill: skill.name, skillId: skill.id, hp: target.hp, targetHp: target.hp, maxHp: target.stats.hp, damageType: skill.damageType });
        if (fixedImpact) Object.assign(events[events.length - 1], { castTime: action.castTime, impactDelayMs: 200, sourceEffectId: 5016450 });
        if (burstEmission) Object.assign(events[events.length - 1], { castTime: action.castTime, emissionTime: t, burstShotIndex: action.shotIndex + 1, burstBaseCount: skill.sourceBurst.count, sourceBulletId: 500935, sourceDamageComponentIndex: 2, movingTravelPolicy: 'not modeled; estimated damage at emission' });
        if (prepared && crit) Object.assign(events[events.length - 1], { initialCriticalMultiplierCandidate: critFactor, targetInitialCritDamageResistance: target.stats.critDamageResistance || 0, criticalRuleBasis: 'observational initial hero50012−target50154 candidate; dynamic buffs and server caps unresolved' });
        if (target.hp <= 0) { actor.kills += 1; events.push({ time: t, type: 'death', side: other, slot: target.slot, targetSide: other, targetSlot: target.slot, amount: 0, hp: 0, heroId: target.heroId }); }
      });
      frame(Math.round(time * 1000) / 1000);
      if (!fixedImpact && !burstEmission) queue.push({ time: time + nextInterval(actor, skill, time), serial: serial++, side: action.side, slot: action.slot, skill: skill });
    }
    if (reason !== 'empty-team' && !queue.length && living('left').length && living('right').length) reason = 'no-damaging-skills';
    var winner = reason === 'empty-team' ? 'draw' : !living('left').length && living('right').length ? 'right' : !living('right').length && living('left').length ? 'left' : 'draw';
    var duration = Math.round(time * 1000) / 1000; frame(duration);
    var left = summaries('left'), right = summaries('right');
    events.push({ time: duration, type: 'end', winner: winner, reason: reason, amount: 0 });
    return { winner: winner, duration: duration, reason: reason, events: events, frames: frames, timeline: frames, initial: initial, left: left, right: right,
      totalDamage: { left: left.totalDamage, right: right.totalDamage }, seed: input.seed === undefined ? 12345 : input.seed, model: model,
      roles: roles, capabilities: CAPABILITIES, notes: Array.from(new Set(notes)), modelNotes: MODEL_NOTES.slice(), unsupportedSkills: unsupported, caveats: MODEL_NOTES.slice(), errors: errors,
      pendingImpactsAtEnd: queue.filter(function (a) { return a.kind === 'fixed-impact'; }).map(function (a) { return { side: a.side, slot: a.slot, skillId: a.skill.id, castTime: a.castTime, scheduledImpactTime: Math.round(a.time * 1000) / 1000, targetSlots: a.targetSlots.slice(), status: 'not executed before simulation termination' }; }),
      pendingEmissionsAtEnd: queue.filter(function (a) { return a.kind === 'burst-emission'; }).map(function (a) { return { side: a.side, slot: a.slot, skillId: a.skill.id, castTime: a.castTime, scheduledEmissionTime: Math.round(a.time * 1000) / 1000, burstShotIndex: a.shotIndex + 1, status: 'not emitted before simulation termination' }; }) };
  }
  // Public setup simulation never accepts effective-stat overrides or prepared units.
  function simulate(input, data) { return runSimulation(input, data, null); }

  var RECORDED_EFFECT_MAPPING = Object.freeze({
    50014: 'HealPoint_Result: max-HP diagnostic only when integer report HP agrees',
    50015: 'PhysicalAttack_Result: model attack input', 50016: 'Hero_ATK_Result: diagnostic constituent, NOT magic attack',
    50017: 'PhysicalDefense_Result: model defense input', 50018: 'Hero_DEF_Result: diagnostic constituent, NOT magic defense',
    50011: 'CriticalRate_Result', 50012: 'CriticalDamage_Result', 50154: 'Initial critical damage resistance: observational subtraction candidate, not recovered server formula', 75750: 'AllCdReduceRate: recorded active cooldown rate'
  });
  var RECORDED_INPUT_EVIDENCE = Object.freeze({
    sourceScript: 'Global/EnumType.luac', sourceSHA256: '035d2c3c4537d216e13b0a4d45a25cff178cef511f96890ec0fb5a1b50a4260a', prototype: 'root', pcBase: 0,
    assignments: { 50011: { name: 'CriticalRate_Result', pc: 35575 }, 50012: { name: 'CriticalDamage_Result', pc: 35578 },
      50014: { name: 'HealPoint_Result', pc: 35584 }, 50015: { name: 'PhysicalAttack_Result', pc: 35587 }, 50016: { name: 'Hero_ATK_Result', pc: 35590 },
      50017: { name: 'PhysicalDefense_Result', pc: 35593 }, 50018: { name: 'Hero_DEF_Result', pc: 35596 } },
    cooldownConsumer: { sourceScript: 'Scene/LWBattle/PVP/SkillPVP.luac', sourceSHA256: '078639c79f1d8b4652ff1a5ead9d157d17c94f2bd9a7c0f3115950e6e068dc70',
      initialCooldown: { prototype: 'root.0', pcs: [44, 70] }, repeatedCooldown: { prototype: 'root.11', pcs: [10, 37] },
      sourceOperation: 'raw milliseconds / (1 + max(rate, -0.5)); AllCdReduceRate for non-normal attacks',
      quantization: 'Floor to milliseconds matches observed active starts/gaps in R2 and R3; not claimed as a universal official rounding rule.' },
    scope: 'Literal source names; no source-backed independent magic channel mapping. Float HP restoration additionally requires report integer agreement.'
  });
  function recordedModelNote(note) {
    if (note.indexOf('Recovered client template/rank parameters') === 0) return 'Recorded initial HP, attack, defense and critical properties are used directly; no template, gear, technology or form stat reconstruction is performed.';
    if (note.indexOf('Critical chance uses an assumed base') === 0) return 'Recorded critical chance and critical multiplier are retained directly without the normal setup85% chance cap; initial50154 resistance uses an observational subtraction candidate, with later critical buff changes unmodeled.';
    if (note.indexOf('Only generic auto and active damage') === 0) return 'Only exact recorded auto/active damage profiles are executed with source-gated Bullet eligibility/counts, Tesla fixed timing, DVA haste and Kimberly source-base rockets. Most passives, shields, DOT, healing, support and triggered/awakening mechanics remain omitted.';
    return note;
  }
  function sourceSkillCatalog(hero) {
    var found = {};
    function visit(skill) {
      if (!skill || typeof skill !== 'object') return;
      if (Number.isInteger(Number(skill.id))) found[Number(skill.id)] = skill;
      array(skill.variants).forEach(visit);
    }
    array(hero.skills).forEach(visit);
    array(hero.recordedSkills).forEach(visit);
    Object.keys(hero.modes || {}).forEach(function (mode) { array(hero.modes[mode] && hero.modes[mode].skills).forEach(visit); });
    return found;
  }
  function recordedHeroById(id, data) {
    var playable = heroById(id, data);
    if (playable) return playable;
    return array(data.recordedCombatants).find(function (hero) { return Number(hero.id) === Number(id) && hero.diagnosticOnly === true && hero.playable === false && hero.sourceHeroType === 2; }) || null;
  }
  function recordedFixedImpactDelay(raw) {
    // Narrow evidence gate: exact Tesla skill/effect, a source Bullet action,
    // fixed nonmoving200ms lifetime. Other positive delays may be buffs or
    // projectile travel and are deliberately not generalized.
    if (Number(raw.id) !== 501645) return 0;
    var direct = array(raw.effects).find(function (effect) { return Number(effect.id) === 5016450 && effect.pvp_actionType === 1 && effect.damage_delay === 200 && effect.horizontal_speed === 0; });
    return direct ? 200 : 0;
  }
  function recordedDamageSource(raw) {
    var effects = array(raw.effects), reviewed = Array.isArray(raw.effectIds) || effects.some(function (effect) { return Number.isInteger(effect.pvp_actionType); });
    var direct = effects.filter(function (effect) { return effect.pvp_actionType === 1 && Number.isInteger(effect.pvp_bullet) && effect.pvp_bullet > 0; });
    var count = 1, countEvidence = null;
    if (direct.length === 1) {
      var effect = direct[0], scalar = String(effect.pvp_pos_num === null || effect.pvp_pos_num === undefined ? '' : effect.pvp_pos_num);
      if (/^[1-5]$/.test(scalar) && array(effect.target_type).length === 1 && effect.target_type[0] === 0 && /^(4|10|14)$/.test(String(effect.pvp_pos_condition)) && !effect.pvp_pos_num_buff && String(effect.pvp_troop_condition) === '0' && String(effect.pvp_other_condition) === '0' && effect.pvp_cast_count === 1 && !effect.pvp_cast_interval && !effect.pvp_cast_first_interval) {
        count = Number(scalar); countEvidence = { effectId: effect.id, count: count, positionCondition: effect.pvp_pos_condition, sourceField: 'pvp_pos_num', selectionPolicy: 'source count only; exact positional/random target selection remains estimated front-row priority' };
      }
    }
    return { reviewed: reviewed, directBulletSupported: !reviewed || direct.length > 0, directEffectIds: direct.map(function (effect) { return effect.id; }), targetCount: count, targetCountEvidence: countEvidence };
  }
  function sourceKimberlyBurst(raw) {
    if (!Number.isInteger(raw.id) || raw.id < 500950 || raw.id > 500955 || raw.descriptionKey !== 'hero_equip_skill_desc_500950' || !Array.isArray(raw.damageComponents) || raw.damageComponents.length < 2) return null;
    var component = raw.damageComponents[1];
    if (!component || component.base !== 0.614 || component.perLevel !== 0.023 || raw.damageRatio !== 2.2 || raw.base !== component.base || raw.perLevel !== component.perLevel || Math.abs(component.base * raw.damageRatio - 1.3508) > 1e-12 || Math.abs(component.perLevel * raw.damageRatio - 0.0506) > 1e-12) return null;
    var effects = array(raw.effects), effect = effects.length === 1 ? effects[0] : null;
    if (!effect || effect.id !== raw.id * 10 || effect.pvp_actionType !== 1 || effect.pvp_bullet !== 500935 || effect.pvp_cast_count !== 16 || String(effect.pvp_cast_interval) !== '100' || effect.pvp_cast_first_interval !== null || effect.pvp_cast_count_buff !== '500940|1' || String(effect.pvp_pos_condition) !== '4' || String(effect.pvp_pos_num) !== '1' || array(effect.target_type).length !== 1 || effect.target_type[0] !== 0) return null;
    return { count: 16, intervalMs: 100, firstOffsetMs: 200, firstOffsetBasis: 'empirical observed first-emission offset; source fallback not recovered', damageComponentIndex: 2, bulletId: 500935,
      sourceCoefficient: 'per rocket:2.2×(component2.base+skillLevel×component2.perLevel); independently agrees with localized description parameters',
      targetPolicy: 'modeled uniform living enemy hero per emission; source says one random enemy, RNG weights/support eligibility unknown',
      limitations: 'Only16source-base rockets; energy-stack extra count, nearby splash, moving projectile travel, interruption details and other modifiers remain unsupported.' };
  }
  function recordedDvaHaste(hero, profiles, data, effects) {
    if (Number(hero.id) !== 50017 || !profiles.some(function (profile) { return profile.id === 501755 && profile.type === 'auto'; })) return null;
    var buff = data.recordedBuffs && data.recordedBuffs[501742];
    if (!buff || buff.id !== 501742 || buff.diagnosticOnly !== true || buff.type !== 1 || buff.para !== '75650;0.2;0' || buff.additive_type !== 2 || buff.max_level !== 5 || !Array.isArray(buff.buff_time) || buff.buff_time[0] !== 5000 || buff.buff_time[1] !== 0) return null;
    function grant(skillId) {
      var profile = profiles.find(function (candidate) { return candidate.id === skillId; });
      return profile && array(profile.raw.effects).some(function (effect) { return effect.id === skillId * 10 && effect.pvp_actionType === 1 && String(effect.pvp_buff_condition) === '4' && String(effect.pvp_buff_ID) === '501742' && String(effect.pvp_buff_level) === '5' && !effect.pvp_buff_level_special; });
    }
    var opening = grant(501775), active = grant(501765);
    if (!opening && !active) return null;
    var initialRate = effects[75650] === undefined ? 0 : effects[75650];
    return { buffId: 501742, propertyId: 75650, duration: 5, rate: 5 * 0.2, initialRate: initialRate, activeGrantSkillId: active ? 501765 : null, windows: opening ? [{ start: 0, end: 5 }] : [],
      source: 'exactDVA501755 with source-bound501775 opening and/or501765 active five-stack501742 grant; no inferred weapon level or awakening requirement',
      limitations: 'Five-stack windows only; general buff stacking, service-specific caps, dispel/interruption, other attack-speed sources and same-time priority remain unsupported.' };
  }
  function recordedSkillProfile(raw, info, activeCooldownRate) {
    var type = String(raw.type || '').toLowerCase(), auto = /auto|normal|basic/.test(type), passive = /passive|expertise|talent|buff|support/.test(type);
    var coefficientAvailable = typeof raw.base === 'number' && Number.isFinite(raw.base) && typeof raw.perLevel === 'number' && Number.isFinite(raw.perLevel) && typeof raw.damageRatio === 'number' && Number.isFinite(raw.damageRatio);
    var damageSource = recordedDamageSource(raw);
    var coefficient = coefficientAvailable && damageSource.directBulletSupported ? (raw.base + info.skillLv * raw.perLevel) * raw.damageRatio : 0;
    var delays = array(raw.effects).filter(function (e) { return typeof e.damage_delay === 'number' && Number.isFinite(e.damage_delay) && e.damage_delay > 0; }).map(function (e) {
      return { effectId: e.id, damageDelayMs: e.damage_delay, horizontalSpeed: typeof e.horizontal_speed === 'number' ? e.horizontal_speed : null };
    });
    var cooldown = null, intervalMs = typeof raw.intervalMs === 'number' && Number.isFinite(raw.intervalMs) ? raw.intervalMs : 0;
    var preCdMs = typeof raw.preCdMs === 'number' && Number.isFinite(raw.preCdMs) ? raw.preCdMs : 0;
    if (type === 'active') {
      var rate = Math.max(-0.5, activeCooldownRate === undefined ? 0 : activeCooldownRate);
      cooldown = { effectId: 75750, recordedRate: activeCooldownRate === undefined ? 0 : activeCooldownRate, clampedRate: rate,
        rawPreCdMs: preCdMs, rawIntervalMs: intervalMs, sourceDividedPreCdMs: preCdMs / (1 + rate), sourceDividedIntervalMs: intervalMs / (1 + rate),
        preCdMs: Math.floor(preCdMs / (1 + rate)), intervalMs: Math.floor(intervalMs / (1 + rate)),
        quantizationBasis: 'recorded whole-millisecond agreement; source division itself is unrounded' };
      preCdMs = cooldown.preCdMs; intervalMs = cooldown.intervalMs;
    }
    return {
      id: info.skillId, groupId: raw.groupId || info.skillId, name: raw.name || ('Skill ' + info.skillId), nameKey: raw.nameKey || '', descriptionKey: raw.descriptionKey || '',
      type: passive ? 'passive' : auto ? 'auto' : type === 'active' ? 'active' : type,
      level: info.skillLv, maxLevel: Math.max(raw.maxLevel || 1, info.skillLv), snapshotMaxLevel: raw.maxLevel || null,
      recordedLevelAboveSnapshotCap: info.skillLv > (raw.maxLevel || 1), locked: false,
      coefficient: coefficient, coefficientAvailable: coefficientAvailable, damageType: raw.damageType || 'physical',
      interval: intervalMs / 1000, preCooldown: preCdMs / 1000, recordedCooldownAdjustment: cooldown,
      targetCount: damageSource.targetCount, sourceDirectDamage: damageSource, source: 'exact recorded skill ID and level; recovered snapshot coefficient; estimated application',
      sourceDamageDelays: delays, fixedImpactDelayMs: recordedFixedImpactDelay(raw), sourceBurst: sourceKimberlyBurst(raw),
      modelImpactPolicy: recordedFixedImpactDelay(raw) ? 'source-fixed Tesla200ms; cast target locked; caster-death cancellation and impact-time rolls are explicit model assumptions' : 'immediate scheduled attack; other recovered delays not executed', raw: raw
    };
  }
  /**
   * Explicit diagnostic projection of decoded report inputs. This is not replay and
   * does not accept observed damage as predicted damage. Normal setup stats are not
   * reconstructed: no equipment, research, support unit or passive is fabricated.
   */
  function simulateRecordedSnapshot(battle, data, modelInput) {
    data = data || {}; modelInput = modelInput || {};
    var errors = [], warnings = [], omitted = [], bindings = [], supportedDelays = [], appliedDelays = [], cooldowns = [], targetCounts = [], nonDamageSource = [], prepared = { left: [null, null, null, null, null], right: [null, null, null, null, null] };
    var observations = [], seenSlots = {}, modeled = 0, inactive = [], dvaHaste = [], sourceBursts = [], explicitRole = modelInput.attackerSide === 'left' || modelInput.attackerSide === 'right';
    var diagnostics = {
      mode: 'recorded-effective-hero-snapshot', inputReconstruction: 'not performed; explicit report values used',
      effectiveMapping: RECORDED_EFFECT_MAPPING, mappingEvidence: RECORDED_INPUT_EVIDENCE, damageModelRecalibrated: false,
      separateMagicChannels: false, omittedUnits: omitted, sourceUnits: bindings,
      warnings: warnings, omittedImpactDelays: supportedDelays, appliedImpactDelays: appliedDelays, fullBattleMechanicsSupported: false,
      fixedImpactTiming: { scope: 'exactTesla501645/effect5016450 only', delayMs: 200, targetPolicy: 'lock modeled target at cast; omit if dead at impact; no retarget', casterDeathPolicy: 'cancel pending impact: unverified modeling assumption', damageStatePolicy: 'estimated damage and critical RNG evaluated at impact using modeled stats; cast-versus-impact snapshot semantics unresolved', evidence: { source: 'SkillEffectPvp.luac', sha256: '0787190520d851dfc323425eb8a02c943be1c48025761404fbf02544bc45ed90', functions: ['ForceLifeTime root.16 PCs1–8', 'GetForceLifeTime root.17 PCs3–10'], observations: '157Tesla impacts across16recordings match200ms; one original target dies before expected impact with no matched outcome; no Tesla caster-death interval observed' } },
      recordedActiveCooldownAdjustments: cooldowns,
      inactiveZeroHpUnits: inactive,
      sourceBoundTargetCounts: targetCounts, excludedNonBulletDamageProfiles: nonDamageSource,
      sourceBoundDvaHaste: dvaHaste,
      sourceBoundBaseBursts: sourceBursts,
      initialCriticalResistance: { effectId: 50154, rule: 'initial caster50012−target50154 for critical hero hits', basis: 'observational candidate supported by controlled same-state pairs; not an extracted server formula', domain: 'strictly positive opposing live-hero factors only; no guessed floor or cap', dynamicCriticalBuffsApplied: false },
      limitations: ['Hero-only projection: UAV, Dominator, pets and other support units omitted.', 'Buffs, DOT, shields, healing, penetration, critical resistance and triggered/awakening mechanics remain unsupported.',
        'Reported effective values describe initial inputs, not every later buff state.', 'Exact skill IDs/levels are joined to a historical snapshot; schema version does not prove matching gameplay configuration.',
        'One auto and one active damage profile per hero are modeled; no generic skills or reconstructed gear/research are inserted.', 'Only exactTesla501645/effect5016450 separates cast and impact by source-fixed200ms. Other fixed or moving delays remain omitted.',
        'Tesla targets are locked at model cast; dead targets are not replaced. Cancel-on-caster-death and impact-time stat/RNG evaluation are explicit modeling assumptions, not proven server rules.',
        'Critical hero hits use initial caster50012−target50154 as an observational positive-domain candidate; dynamic critical buffs, caps and nonpositive-domain rules remain unresolved.']
    };
    function fail(path, message) { errors.push({ path: path, message: message }); }
    function number(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER; }
    if (!battle || typeof battle !== 'object' || !Array.isArray(battle.units)) {
      fail('units', 'Expected a decoded battle with a units array.'); return { ok: false, errors: errors, diagnostics: diagnostics };
    }
    battle.units.forEach(function (rawUnit, ui) {
      var path = 'units[' + ui + ']';
      if (!rawUnit || typeof rawUnit !== 'object') { fail(path, 'Unit must be an object.'); return; }
      if (rawUnit.unitType !== 1) { omitted.push({ index: number(rawUnit.index) ? rawUnit.index : null, unitType: number(rawUnit.unitType) ? rawUnit.unitType : null, reason: 'Support/non-hero mechanics are not synthesized.' }); return; }
      if (!Number.isInteger(rawUnit.index) || rawUnit.index < 1 || rawUnit.index > 10) { fail(path + '.index', 'Hero index must be an integer in 1..10.'); return; }
      if (seenSlots[rawUnit.index]) { fail(path + '.index', 'Duplicate hero index.'); return; } seenSlots[rawUnit.index] = true;
      var hero = Number.isInteger(rawUnit.heroId) ? recordedHeroById(rawUnit.heroId, data) : null;
      if (!hero) { fail(path + '.heroId', 'Exact hero definition is unavailable; generic fallback is prohibited.'); return; }
      // Proto3 may contain a known hero slot with explicit zero max/start/endHP,
      // no effective properties and no activity statistics. Keep this as an
      // inactive structural record, never inventing live combat stats/attacks.
      var zeroStats = rawUnit.stat === undefined || rawUnit.stat && typeof rawUnit.stat === 'object' && Object.keys(rawUnit.stat).every(function (key) { var value = rawUnit.stat[key]; return typeof value === 'number' && value === 0 || Array.isArray(value) && value.length === 0; });
      var zeroProfile = rawUnit.maxHp === 0 && rawUnit.hpBeforeStart === 0 && (rawUnit.hp === undefined || rawUnit.hp === 0) && Array.isArray(rawUnit.effects) && rawUnit.effects.length === 0 && zeroStats && (rawUnit.damage === undefined || rawUnit.damage === 0);
      if (zeroProfile) {
        var emptyCatalog = sourceSkillCatalog(hero), infos = rawUnit.skillInfos;
        if (!Number.isInteger(rawUnit.heroLevel) || rawUnit.heroLevel < 1 || !Array.isArray(infos) || !infos.every(function (info) { return info && Number.isSafeInteger(info.skillId) && Number.isSafeInteger(info.skillLv) && info.skillLv > 0 && info.skillLv <= 1000 && emptyCatalog[info.skillId]; })) { fail(path, 'Inactive zero-HP slot still requires an exact known hero and valid source-bound skill metadata.'); return; }
        var suppliedActions = Array.isArray(battle.actions) ? battle.actions : battle.detail && Array.isArray(battle.detail.actions) ? battle.detail.actions : [];
        if (suppliedActions.some(function (action) { return action.casterIndex === rawUnit.index || array(action.targets).some(function (target) { return target.index === rawUnit.index; }); })) { fail(path, 'Inactive zero-HP record has observed action activity; unsupported input.'); return; }
        var zeroSide = rawUnit.index <= 5 ? 'left' : 'right', zeroSlot = (rawUnit.index - 1) % 5;
        prepared[zeroSide][zeroSlot] = { heroId: rawUnit.heroId, name: hero.name || ('Hero ' + rawUnit.heroId), image: hero.image || '', type: typeName(hero.type), role: 'unknown', form: 'recorded', level: rawUnit.heroLevel, initialHp: 0, inactive: true, statsKnown: false,
          stats: { hp: 0, attack: null, defense: null, critChance: null, critMultiplier: null }, skills: [], allSkills: [], unsupportedSkills: [], notes: ['Inactive explicit zero-HP record: unknown combat stats remain null; no skills queued.'], config: { heroId: rawUnit.heroId, level: rawUnit.heroLevel, form: 'recorded' } };
        inactive.push({ index: rawUnit.index, heroId: rawUnit.heroId, basis: 'explicit zero maxHp/startHp, zero endingHp, empty effective properties and zero/empty activity stats; no live stats inferred' });
        bindings.push({ index: rawUnit.index, heroId: rawUnit.heroId, inactive: true, skillIds: infos.map(function (info) { return info.skillId; }), requiredEffects: null, hpSource: 'explicit proto3 zero HP', maxHp: 0, startingHp: 0 });
        observations.push({ side: zeroSide, slot: zeroSlot, index: rawUnit.index, heroId: rawUnit.heroId, startingHp: 0, endingHp: 0, endingHpFieldPresent: rawUnit.hp !== undefined, damage: 0, injured: 0, critDamage: 0, critNum: 0, inactive: true });
        return;
      }
      if (!Number.isInteger(rawUnit.heroLevel) || rawUnit.heroLevel < 1) fail(path + '.heroLevel', 'Recorded hero level must be a positive integer.');
      if (!number(rawUnit.maxHp) || rawUnit.maxHp <= 0) fail(path + '.maxHp', 'Positive numeric report maxHp is required.');
      if (!number(rawUnit.hpBeforeStart) || rawUnit.hpBeforeStart < 0 || rawUnit.hpBeforeStart > rawUnit.maxHp) fail(path + '.hpBeforeStart', 'Numeric starting HP must lie in [0,maxHp].');
      if (rawUnit.hp !== undefined && (!number(rawUnit.hp) || rawUnit.hp < 0 || rawUnit.hp > rawUnit.maxHp + 1)) fail(path + '.hp', 'Ending HP must be a finite nonnegative report value.');
      var effects = {}, duplicateEffects = {}, validEffects = Array.isArray(rawUnit.effects);
      if (!validEffects) fail(path + '.effects', 'Recorded effective effects array is required.');
      (validEffects ? rawUnit.effects : []).forEach(function (e, ei) {
        if (!e || !Number.isInteger(e.effectId)) { fail(path + '.effects[' + ei + ']', 'Effect requires an exact numeric definition ID.'); return; }
        var value = e.value === undefined ? 0 : e.value; // explicit proto3 zero default
        if (!number(value)) { fail(path + '.effects[' + ei + '].value', 'Effect value must be a finite number, not a numeric string.'); return; }
        if (Object.prototype.hasOwnProperty.call(effects, e.effectId)) duplicateEffects[e.effectId] = true;
        effects[e.effectId] = value;
      });
      Object.keys(duplicateEffects).forEach(function (id) { fail(path + '.effects', 'Duplicate effective effect ID ' + id + '.'); });
      [50015, 50017, 50011, 50012].forEach(function (id) { if (!Object.prototype.hasOwnProperty.call(effects, id)) fail(path + '.effects', 'Missing required effective property ' + id + '.'); });
      if (effects[50015] !== undefined && effects[50015] <= 0) fail(path + '.effects.50015', 'Positive reported attack is required.');
      if (effects[50017] !== undefined && effects[50017] < 0) fail(path + '.effects.50017', 'Reported defense cannot be negative.');
      if (effects[50011] !== undefined && (effects[50011] < 0 || effects[50011] > 1)) fail(path + '.effects.50011', 'Recorded critical chance outside [0,1]; no cap is inferred.');
      if (effects[50012] !== undefined && effects[50012] <= 0) fail(path + '.effects.50012', 'Positive recorded critical multiplier is required.');
      var maxHp = rawUnit.maxHp, startingHp = rawUnit.hpBeforeStart, hpSource = 'report.maxHp / report.hpBeforeStart';
      if (Object.prototype.hasOwnProperty.call(effects, 50014)) {
        if (effects[50014] <= 0) fail(path + '.effects.50014', 'HP diagnostic must be positive.');
        else if (number(maxHp) && Math.trunc(effects[50014]) === Math.trunc(maxHp)) {
          maxHp = effects[50014];
          if (rawUnit.hpBeforeStart === rawUnit.maxHp) { startingHp = maxHp; hpSource = 'float effect50014: full-start integer truncation agrees'; }
          else hpSource = 'float max effect50014; wounded report.hpBeforeStart retained without guessed fraction';
        } else warnings.push({ index: rawUnit.index, reason: 'Effect50014 disagrees with integer report maxHp; report HP retained, no float replacement.' });
      }
      var catalog = sourceSkillCatalog(hero), profiles = [], skillIds = {}, infoList = rawUnit.skillInfos;
      if (!Array.isArray(infoList) || !infoList.length) fail(path + '.skillInfos', 'Exact recorded skill metadata is required; no generic attacks inserted.');
      (Array.isArray(infoList) ? infoList : []).forEach(function (info, si) {
        var spath = path + '.skillInfos[' + si + ']';
        if (!info || !Number.isSafeInteger(info.skillId) || !Number.isSafeInteger(info.skillLv) || info.skillLv < 1 || info.skillLv > 1000) { fail(spath, 'Skill ID and positive skill level must be safe integers; diagnostic level safety limit is1000, not a gameplay cap.'); return; }
        if (skillIds[info.skillId]) { fail(spath, 'Duplicate recorded skill ID.'); return; } skillIds[info.skillId] = true;
        var source = catalog[info.skillId];
        if (!source) { fail(spath + '.skillId', 'Exact recovered skill ID unavailable: ' + info.skillId + '; no group/variant substitution.'); return; }
        var damageCandidate = /^(auto|active|normal|basic)$/.test(String(source.type || '').toLowerCase());
        if (damageCandidate && (!number(source.base) || !number(source.perLevel) || !number(source.damageRatio) || source.base < 0 || source.perLevel < 0 || source.damageRatio < 0)) {
          fail(spath, 'Damage-profile coefficient metadata is incomplete or invalid.'); return;
        }
        var profile = recordedSkillProfile(source, info, effects[75750]);
        if (profile.sourceDirectDamage.reviewed && !profile.sourceDirectDamage.directBulletSupported) nonDamageSource.push({ index: rawUnit.index, skillId: info.skillId, reason: 'Recovered PvP effects have no positive Bullet action; positive coefficient alone is not executed as direct damage.' });
        if (!number(profile.coefficient) || profile.coefficient < 0) { fail(spath, 'Coefficient arithmetic is not finite.'); return; }
        if (damageCandidate && profile.coefficient > 0 && (!number(source.intervalMs) || source.intervalMs <= 0 || !number(source.preCdMs) || source.preCdMs < 0)) {
          fail(spath, 'Positive damage-profile scheduling metadata is incomplete or invalid.'); return;
        }
        if (damageCandidate && profile.coefficient > 0 && profile.interval <= 0) { fail(spath, 'Recorded rate produces a nonpositive quantized interval; unsupported diagnostic input.'); return; }
        if (!damageCandidate && !profile.coefficientAvailable) warnings.push({ index: rawUnit.index, skillId: info.skillId, reason: 'Unexecuted passive/triggered metadata has no complete damage coefficient; retained as unsupported, not synthesized.' });
        profiles.push(profile);
        if (profile.recordedLevelAboveSnapshotCap) warnings.push({ index: rawUnit.index, skillId: info.skillId, reason: 'Recorded level exceeds snapshot row cap; recorded level retained, eligibility/config equivalence unproven.' });
      });
      var autos = profiles.filter(function (p) { return p.type === 'auto' && p.coefficient > 0; }), actives = profiles.filter(function (p) { return p.type === 'active' && p.coefficient > 0; });
      if (!autos.length) fail(path + '.skillInfos', 'No exact supported positive auto-attack profile; no generic auto inserted.');
      var used = [autos[0], actives[0]].filter(Boolean), unsupported = profiles.filter(function (p) { return used.indexOf(p) < 0; }).map(function (p) {
        return { heroId: rawUnit.heroId, skillId: p.id, groupId: p.groupId, name: p.name, level: p.level, reason: p.sourceDirectDamage.reviewed && !p.sourceDirectDamage.directBulletSupported ? 'Source PvP effects contain no positive Bullet action; buff-only metadata is not executed as direct damage.' : p.coefficient <= 0 ? 'Non-damaging recorded ability is not replaced by invented damage.' : 'Recorded passive/triggered/extra ability mechanics remain unsupported.' };
      });
      used.forEach(function (p) {
        p.sourceDamageDelays.forEach(function (delay) { (p.fixedImpactDelayMs && delay.effectId === 5016450 ? appliedDelays : supportedDelays).push(Object.assign({ index: rawUnit.index, skillId: p.id }, delay)); });
        if (p.recordedCooldownAdjustment) cooldowns.push(Object.assign({ index: rawUnit.index, skillId: p.id }, p.recordedCooldownAdjustment));
        if (p.sourceDirectDamage.targetCountEvidence) targetCounts.push(Object.assign({ index: rawUnit.index, skillId: p.id }, p.sourceDirectDamage.targetCountEvidence));
        if (p.sourceBurst) sourceBursts.push(Object.assign({ index: rawUnit.index, skillId: p.id }, p.sourceBurst));
      });
      var side = rawUnit.index <= 5 ? 'left' : 'right', slot = (rawUnit.index - 1) % 5;
      var haste = recordedDvaHaste(hero, profiles, data, effects);
      if (haste) dvaHaste.push({ index: rawUnit.index, autoSkillId: 501755, openingGrant: haste.windows.length > 0, activeGrantSkillId: haste.activeGrantSkillId, buffId: 501742, rate: haste.rate, durationMs: 5000, initialRate: haste.initialRate, source: haste.source, limitations: haste.limitations });
      if (haste) unsupported.forEach(function (skill) { if (skill.skillId === 501775) skill.reason = 'Source-bound opening haste applied; opening damage and other triggered mechanics remain unsupported.'; });
      var role = explicitRole ? modelInput.attackerSide === side ? 'attacker' : 'defender' : 'unknown';
      var binding = { index: rawUnit.index, heroId: rawUnit.heroId, sourceClassification: hero.diagnosticOnly && hero.playable === false ? 'source-bound diagnostic NPC, not playable roster' : 'playable hero definition', skillIds: profiles.map(function (p) { return p.id; }),
        requiredEffects: { 50015: effects[50015], 50017: effects[50017], 50011: effects[50011], 50012: effects[50012] },
        hpSource: hpSource, maxHp: number(maxHp) ? maxHp : null, startingHp: number(startingHp) ? startingHp : null,
        constituentsOnly: { Hero_ATK_Result_50016: effects[50016] === undefined ? null : effects[50016], Hero_DEF_Result_50018: effects[50018] === undefined ? null : effects[50018] } };
      bindings.push(binding); modeled += 1;
      prepared[side][slot] = { heroId: rawUnit.heroId, name: hero.name || ('Hero ' + rawUnit.heroId), image: hero.image || '', type: typeName(hero.type || hero.unitType), role: role, form: 'recorded',
        level: rawUnit.heroLevel, effectiveLevel: rawUnit.heroLevel, unusedExp: 0, rankId: Number.isInteger(rawUnit.rankLv) ? rawUnit.rankLv : null,
        stats: { hp: maxHp, attack: effects[50015], defense: effects[50017], critChance: effects[50011], critMultiplier: effects[50012], critDamageResistance: effects[50154] === undefined ? 0 : effects[50154] }, initialHp: startingHp,
        recordedHaste: haste,
        skills: used, allSkills: profiles, unsupportedSkills: unsupported,
        notes: ['Explicit recorded effective stats, exact skill IDs and recorded levels; no setup stats, gear, technology or form bonuses were synthesized.'],
        config: { heroId: rawUnit.heroId, recorded: true }, sourceBinding: binding,
        capabilities: Object.assign({}, CAPABILITIES, { inputMode: 'recorded-effective-snapshot', gear: 'not reconstructed', technology: 'not reconstructed', criticalInputs: 'recorded without setup cap' }) };
      var stat = rawUnit.stat || {};
      ['damage', 'injured', 'critDamage', 'critNum'].forEach(function (key) { if (stat[key] !== undefined && !number(stat[key])) fail(path + '.stat.' + key, 'Observed statistic must be a finite bounded number when present.'); });
      observations.push({ side: side, slot: slot, index: rawUnit.index, heroId: rawUnit.heroId, startingHp: startingHp, endingHp: rawUnit.hp === undefined ? 0 : rawUnit.hp,
        endingHpFieldPresent: rawUnit.hp !== undefined, damage: number(stat.damage) ? stat.damage : 0, injured: number(stat.injured) ? stat.injured : 0,
        critDamage: number(stat.critDamage) ? stat.critDamage : 0, critNum: number(stat.critNum) ? stat.critNum : 0 });
    });
    diagnostics.modeledHeroCount = modeled;
    if (!prepared.left.some(Boolean) || !prepared.right.some(Boolean)) fail('units', 'At least one validated hero on each view side is required.');
    var sourceHash = battle.sourceSHA256 || battle.sourceDecodedSHA256 || battle.decodedSHA256 || battle.sourceBinding && (battle.sourceBinding.sourceSHA256 || battle.sourceBinding.sha256);
    diagnostics.sourceBinding = { decodedSHA256: typeof sourceHash === 'string' && /^[a-f0-9]{64}$/i.test(sourceHash) ? sourceHash : null,
      reportVersion: Number.isInteger(battle.version) ? battle.version : null, configurationMatchProven: false, unitOrder: 'report indices1..5 and6..10 are view sides, not inferred attacker/defender' };
    var criticalFactors = [];
    ['left','right'].forEach(function (side) { var other = side === 'left' ? 'right' : 'left'; prepared[side].filter(function (unit) { return unit && unit.initialHp > 0; }).forEach(function (actor) { prepared[other].filter(function (unit) { return unit && unit.initialHp > 0; }).forEach(function (target) {
      var factor = actor.stats.critMultiplier - (target.stats.critDamageResistance || 0);
      if (!(factor > 0) || !number(factor)) fail('criticalDomain', 'Initial opposing hero critical factor must be positive; no server floor/cap is guessed outside the observational domain.');
      else criticalFactors.push(factor);
    }); }); });
    diagnostics.initialCriticalResistance.potentialOpposingPairs = criticalFactors.length;
    diagnostics.initialCriticalResistance.minimumPositiveFactor = criticalFactors.length ? Math.min.apply(null,criticalFactors) : null;
    diagnostics.initialCriticalResistance.maximumPositiveFactor = criticalFactors.length ? Math.max.apply(null,criticalFactors) : null;
    if (errors.length) return { ok: false, errors: errors, diagnostics: diagnostics };
    var result = runSimulation({ seed: modelInput.seed, attackerSide: modelInput.attackerSide, model: modelInput }, data, prepared);
    var survivingLeft = observations.filter(function (u) { return u.side === 'left' && u.endingHp > 0; }).length;
    var survivingRight = observations.filter(function (u) { return u.side === 'right' && u.endingHp > 0; }).length;
    result.ok = true; result.diagnostics = diagnostics;
    result.recordedObservation = { units: observations, duration: number(battle.totalTime) ? battle.totalTime / 1000 : null,
      inferredOutcome: survivingLeft && !survivingRight ? 'left' : survivingRight && !survivingLeft ? 'right' : 'unresolved', outcomeBasis: 'hero survivors only; raw winner enum unresolved',
      rawWinnerValue: number(battle.fightResult) ? battle.fightResult : null };
    if (!explicitRole) result.roles = { left: 'unknown', right: 'unknown', attackerSide: null, defenderSide: null };
    result.modelNotes = MODEL_NOTES.map(recordedModelNote); result.caveats = result.modelNotes.slice();
    result.modelNotes.push('Recorded active cooldowns use source division by1+max(effect75750,-0.5); millisecond flooring matches these observations and is an explicit quantization assumption.');
    if (appliedDelays.length) result.modelNotes.push('ExactTesla501645 impacts use source-fixed200ms after model cast; original targets stay locked. Caster-death cancellation and impact-time RNG/stat evaluation remain unverified model assumptions.');
    if (dvaHaste.length) result.modelNotes.push('ExactDVA501755 uses source501742 five-stack haste windows from recorded501775 opening and modeled501765 active casts. Initial pre-CD stays unchanged; each later gap uses source interval/(1+rate). Other buff stacking, interruption and dispel mechanics remain omitted.');
    if (sourceBursts.length) result.modelNotes.push('Kimberly exact weapon active500950–500955 emits16source-base rockets100ms apart with verified per-rocket component2 coefficient. First200ms offset is empirical; extra energy-stack rockets, splash and moving travel are unmodeled.');
    result.caveats = result.modelNotes.slice();
    result.notes = Array.from(new Set(result.notes.map(recordedModelNote).concat(diagnostics.limitations)));
    if (cooldowns.length) result.notes.push('Recorded active cooldown rates are applied with the source lower bound-0.5 and observed whole-millisecond quantization; ordinary setup timing is unchanged.');
    result.capabilities = Object.assign({}, CAPABILITIES, { inputMode: 'recorded-effective-snapshot', gear: 'not reconstructed', technology: 'not reconstructed', criticalInputs: 'recorded without setup cap; initial50154 subtraction is observational and positive-domain only', fixedImpactTiming: 'source-fixedTesla501645/5016450:200ms only; cancellation policy unverified', targetCount: 'single source Bullet effect with scalar1..5 enemy count and no dynamic/repeated modifiers; exact target selection still estimated', directDamageEligibility: 'positive coefficient plus source Bullet action required when reviewed effect metadata is available', attackSpeedBuffs: 'exactDVA501755/source501742 five-stack opening and active haste windows only; general buff solver unavailable', burstMechanics: 'Kimberly500950–500955:16source-base rockets/100ms; empirical200msfirstoffset; no energy-stack count, splash or moving travel' });
    return result;
  }
  return { version: '0.3.5-estimated', DEFAULT_MODEL: DEFAULT_MODEL, defaultModel: DEFAULT_MODEL, MODEL_NOTES: MODEL_NOTES, capabilities: CAPABILITIES,
    computeUnit: computeUnit, resolveExperience: resolveExperience, simulate: simulate, simulateRecordedSnapshot: simulateRecordedSnapshot,
    recordedEffectMapping: RECORDED_EFFECT_MAPPING, recordedInputEvidence: RECORDED_INPUT_EVIDENCE,
    equipmentSelection: equipmentSelection, technologyModifiers: technologyModifiers };
});
