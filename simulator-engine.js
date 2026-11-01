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
    'Only generic auto and active damage are simulated. Passives, buffs, shields, DOT, targeting exceptions, UAV and Dominator mechanics are not executed.',
    'Equal-time events resolve in stable queue order. The recorded server timing and RNG are not reproduced.',
    'Snapshot configuration and historic report schema versions do not establish current live-game equivalence.'
  ];
  var CAPABILITIES = Object.freeze({ skillTriggers: false, targeting: 'front-row-estimate', rng: 'seeded-model-not-server', technology: 'source-reviewed-effects-only', gear: 'recovered-curves-and-cumulative-promotions' });
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
    var coefficient = Number.isFinite(base) ? Math.max(0, (base + level * per) * ratio) : 0;
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
      targetCount: clamp(int(s.targetCount, 1), 1, 5), source: s.genericFallback ? 'generic estimated coefficient: no recovered skill metadata' : Number.isFinite(base) ? 'recovered coefficient; estimated combat application' : 'missing coefficient; ability not executed',
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
    return { heroId: Number(hero.id || cfg.heroId), name: hero.name || ('Hero ' + cfg.heroId), image: selectedMode && selectedMode.image || hero.image || '', type: troopType, role: role, form: modeName,
      level: level, effectiveLevel: level, unusedExp: xp.unusedExp, experience: xp, rankId: Number(rank.id || rankId), shardLevel: shard,
      stats: stats, baseStats: baseStats, skills: used, allSkills: skills, unsupportedSkills: unsupported, notes: notes, config: cfg,
      gear: gearInfo.slots, gearEffects: gearInfo.applied, unsupportedGearEffects: gearInfo.unsupported,
      technology: tech, unsupportedTechnology: tech.unsupported, teamTech: { research: tech.research, squadNo: clamp(int(teamTech && teamTech.squadNo, 1), 1, 4) }, capabilities: CAPABILITIES };
  }
  function seedNumber(value) { if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0; var s = String(value === undefined ? 12345 : value), h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rngFor(seed) { var a = seedNumber(seed); return function () { a = (a + 0x6D2B79F5) | 0; var t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function counterFactor(attacker, defender, model) { return ({ aircraft: 'tank', tank: 'missile', missile: 'aircraft' })[attacker] === defender ? 1 + model.typeCounterBonus : 1; }
  function simulate(input, data) {
    input = input || {}; data = data || {}; var model = modelOptions(input.model), rand = rngFor(input.seed), events = [], frames = [], queue = [], serial = 0;
    var attackerSide = input.attackerSide === 'right' ? 'right' : 'left';
    var roles = { left: attackerSide === 'left' ? 'attacker' : 'defender', right: attackerSide === 'right' ? 'attacker' : 'defender', attackerSide: attackerSide, defenderSide: attackerSide === 'left' ? 'right' : 'left' };
    var tech = input.tech || {}, teams = { left: [], right: [] }, initial = { left: [], right: [] }, errors = [], notes = MODEL_NOTES.slice(), unsupported = [];
    ['left', 'right'].forEach(function (side) {
      var deployedTypes = { tank: 0, missile: 0, aircraft: 0 };
      array(input[side]).slice(0, 5).forEach(function (c) { var h = c && heroById(c.heroId, data); if (h) { var t = typeName(h.type || h.unitType || h.army_type); deployedTypes[t] = (deployedTypes[t] || 0) + 1; } });
      for (var slot = 0; slot < 5; slot++) {
        var cfg = Array.isArray(input[side]) ? input[side][slot] : null, unit = null;
        try { unit = computeUnit(cfg ? Object.assign({}, cfg, { role: roles[side], deployedTypes: deployedTypes }) : cfg, tech[side] && typeof tech[side] === 'object' ? Object.assign({}, tech[side], { deployedArmyTypeCounts: deployedTypes }) : tech[side], data, model); } catch (e) { errors.push(side + ' slot ' + (slot + 1) + ': ' + e.message); }
        initial[side].push(unit);
        if (!unit) { teams[side].push(null); continue; }
        var combatant = Object.assign({}, unit, { side: side, slot: slot, hp: unit.stats.hp, damageDone: 0, damageTaken: 0, healingDone: 0, kills: 0 });
        teams[side].push(combatant); unsupported = unsupported.concat(unit.unsupportedSkills); notes = notes.concat(unit.notes);
        unit.skills.forEach(function (skill) { queue.push({ time: Math.max(0.1, skill.preCooldown), serial: serial++, side: side, slot: slot, skill: skill }); });
      }
    });
    function living(side) { return teams[side].filter(function (u) { return u && u.hp > 0; }); }
    function frame(time) { var f = { time: time, left: teams.left.map(function (u) { return u ? u.hp : 0; }), right: teams.right.map(function (u) { return u ? u.hp : 0; }) }; if (frames.length && frames[frames.length - 1].time === time) frames[frames.length - 1] = f; else frames.push(f); }
    function summaries(side) { var us = teams[side].map(function (u) { return u ? { heroId: u.heroId, name: u.name, slot: u.slot, type: u.type, role: u.role, form: u.form, hp: u.hp, maxHp: u.stats.hp, stats: u.stats, alive: u.hp > 0, damageDone: u.damageDone, damageTaken: u.damageTaken, healingDone: u.healingDone, kills: u.kills } : null; }); return { units: us, totalDamage: us.reduce(function (n, u) { return n + (u ? u.damageDone : 0); }, 0), totalHealing: 0, survivors: us.filter(function (u) { return u && u.alive; }).length }; }
    frame(0); var time = 0, processed = 0, reason = 'elimination';
    if (!living('left').length || !living('right').length) { errors.push('Both sides need at least one valid hero.'); reason = 'empty-team'; }
    else while (queue.length && living('left').length && living('right').length) {
      queue.sort(function (a, b) { return a.time - b.time || a.serial - b.serial; }); var action = queue.shift();
      if (action.time > model.maxDuration) { time = model.maxDuration; reason = 'time-limit'; break; }
      if (processed++ >= model.maxEvents) { reason = 'event-limit'; break; }
      time = action.time; var actor = teams[action.side][action.slot]; if (!actor || actor.hp <= 0) continue;
      var other = action.side === 'left' ? 'right' : 'left', skill = action.skill;
      var candidates = living(other), front = candidates.filter(function (u) { return u.slot < 2; });
      var ordered = front.concat(candidates.filter(function (u) { return u.slot >= 2; }));
      // Randomize only within the highest-priority row; front occupants always protect back occupants.
      if (front.length > 1 && rand() > 0.5) { var temp = ordered[0]; ordered[0] = ordered[1]; ordered[1] = temp; }
      ordered.slice(0, skill.targetCount).forEach(function (target) {
        if (target.hp <= 0) return;
        var crit = rand() < actor.stats.critChance;
        var raw = actor.stats.attack * actor.stats.attack / Math.max(1, actor.stats.attack + target.stats.defense * model.defenseK);
        raw *= skill.coefficient * model.damageScale * counterFactor(actor.type, target.type, model) * (crit ? actor.stats.critMultiplier : 1);
        var amount = Math.min(target.hp, Math.max(1, Math.round(finite(raw, 1))));
        target.hp = Math.max(0, target.hp - amount); target.damageTaken += amount; actor.damageDone += amount;
        var t = Math.round(time * 1000) / 1000;
        events.push({ time: t, type: skill.type === 'auto' ? 'attack' : 'skill', side: action.side, slot: actor.slot, targetSide: other, targetSlot: target.slot, amount: amount, rawAmount: Math.max(1, Math.round(raw)), crit: crit, skill: skill.name, skillId: skill.id, hp: target.hp, targetHp: target.hp, maxHp: target.stats.hp, damageType: skill.damageType });
        if (target.hp <= 0) { actor.kills += 1; events.push({ time: t, type: 'death', side: other, slot: target.slot, targetSide: other, targetSlot: target.slot, amount: 0, hp: 0, heroId: target.heroId }); }
      });
      frame(Math.round(time * 1000) / 1000);
      queue.push({ time: time + Math.max(0.25, skill.interval), serial: serial++, side: action.side, slot: action.slot, skill: skill });
    }
    if (reason !== 'empty-team' && !queue.length && living('left').length && living('right').length) reason = 'no-damaging-skills';
    var winner = reason === 'empty-team' ? 'draw' : !living('left').length && living('right').length ? 'right' : !living('right').length && living('left').length ? 'left' : 'draw';
    var duration = Math.round(time * 1000) / 1000; frame(duration);
    var left = summaries('left'), right = summaries('right');
    events.push({ time: duration, type: 'end', winner: winner, reason: reason, amount: 0 });
    return { winner: winner, duration: duration, reason: reason, events: events, frames: frames, timeline: frames, initial: initial, left: left, right: right,
      totalDamage: { left: left.totalDamage, right: right.totalDamage }, seed: input.seed === undefined ? 12345 : input.seed, model: model,
      roles: roles, capabilities: CAPABILITIES, notes: Array.from(new Set(notes)), modelNotes: MODEL_NOTES.slice(), unsupportedSkills: unsupported, caveats: MODEL_NOTES.slice(), errors: errors };
  }
  return { version: '0.2.0-estimated', DEFAULT_MODEL: DEFAULT_MODEL, defaultModel: DEFAULT_MODEL, MODEL_NOTES: MODEL_NOTES, capabilities: CAPABILITIES,
    computeUnit: computeUnit, resolveExperience: resolveExperience, simulate: simulate, equipmentSelection: equipmentSelection, technologyModifiers: technologyModifiers };
});
