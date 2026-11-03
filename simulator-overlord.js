(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BattleOverlord = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Exact recovered Gorilla active family. Buff values deliberately follow
  // compiled rows, including variants whose localised caption disagrees.
  var SOURCE = Object.freeze({ skillTable: '90903df2cca5b823d5f3a8aaf7af3f2f57cc815584c83a1a56d60566d43fcc8d', buffTable: '012b8f7f2d08b2ba3288a295e5f941d5d6897dbfd52f113bc5732918dd98a04f', effectTable: 'c2487e2515f77a786dad118f87f1550753372caf5be9583f6b6d1e71c8efd2ea' });
  var rows = [
    [800020, 10000, -.02, -.02, .06],
    [800021, 15000, -.02, -.02, .06],
    [800022, 15000, -.02, -.03, .06],
    [800023, 15000, -.02, -.04, .06],
    [800024, 20000, -.02, -.04, .06],
    [800025, 20000, -.04, -.04, .12],
    [800026, 25000, -.04, -.04, .12]
  ];
  var POLICIES = Object.freeze({
    targeting: 'Estimated formation-slot front/back priority, stable slot order and living modeled support fallback; source-family selectors10/9 only, not a recovered distance/tie enum.',
    delivery: 'Estimated grant at own modeled cast. Recorded travel/delivery delay is not replayed or fitted.',
    stacking: 'Exact buff-ID independent additive_type2 stacks, max3, add_buff_max_level0: suppress new at capacity; no refresh or conserved critical transfer.',
    precision: 'Each configured grant uses observed float32(base + float32(perLevel * level)); additive runtime property composition remains a model.',
    excluded: 'No Furious Hunt critical-count solver, armor reduction bucket, crit-triggered damage amplification or Skybreaker rules are inferred from this family.'
  });
  function floatValue(base, perLevel, level) { return Math.fround(Math.fround(base) + Math.fround(Math.fround(perLevel) * level)); }
  function profile(heroId, input, suppliedLevel) {
    var sourceBuffs = arguments.length > 3 ? arguments[3] : null;
    if (suppliedLevel && typeof suppliedLevel === 'object') { sourceBuffs = suppliedLevel; suppliedLevel = undefined; }
    var raw = input && (input.raw || input), id = raw && raw.id;
    if (Number(heroId) !== 1000000 || !Number.isInteger(id) || id < 800020 || id > 800026 || !raw || raw.groupId !== 800020 || raw.type !== 'active' || raw.descriptionKey !== 'skill_desc_800020' || raw.intervalMs !== 10000 || raw.preCdMs !== 0) return null;
    var level = suppliedLevel === undefined ? input.level : suppliedLevel;
    if (!Number.isSafeInteger(level) || level < 1 || level > 1000) return null;
    if (!Array.isArray(raw.effects) || raw.effects.length !== 1 || !Array.isArray(raw.effectIds) || raw.effectIds.length !== 1 || raw.effectIds[0] !== id * 10) return null;
    var effect = raw.effects[0], expectedIds = [id, id + 10, id + 20];
    if (!effect || effect.id !== id * 10 || effect.pvp_actionType !== 2 || effect.pvp_bullet !== 0 || JSON.stringify(effect.target_type) !== '[0,0,3]' || String(effect.pvp_pos_condition) !== '10|9|1' || String(effect.pvp_pos_num) !== '3|2|1' || String(effect.pvp_troop_condition) !== '0|0|0' || String(effect.pvp_other_condition) !== '0|0|0' || effect.pvp_cast_count !== 1 || effect.pvp_buff_ID !== expectedIds.join('|') || effect.damage_delay !== 0 || effect.horizontal_speed !== 30 || effect.pvp_buff_condition != null || effect.pvp_buff_level != null || effect.pvp_buff_level_special != null) return null;
    var row = rows[id - 800020];
    // A caller may supply the shipped source catalogue for an additional
    // signature check. Otherwise the exact hashed manifest above is used.
    if (sourceBuffs) {
      for (var i = 0; i < 3; i++) {
        var buff = sourceBuffs[String(expectedIds[i])], property = i === 1 ? 50154 : 50011, perLevel = i === 2 ? .002 : -.001;
        if (!buff || buff.id !== expectedIds[i] || buff.type !== 1 || buff.sub_type !== 0 || buff.para !== [property,row[i + 2],perLevel].join(';') || JSON.stringify(buff.buff_time) !== JSON.stringify([row[1],0]) || buff.additive_type !== 2 || buff.max_level !== 3 || buff.add_buff_max_level !== 0 || buff.add_buff_order !== 0 || buff.group !== 800020 + i * 10) return null;
      }
    }
    return { kind: 'gorilla-critical-active', skillId: id, groupId: 800020, level: level, preCooldown: 0, interval: 10, effectId: effect.id, source: SOURCE, policies: POLICIES,
      branches: [
        { buffId: id, effectId: 50011, value: floatValue(row[2], -.001, level), base: row[2], perLevel: -.001, duration: row[1] / 1000, maxStacks: 3, recipientPolicy: 'enemy-back-priority', count: 3 },
        { buffId: id + 10, effectId: 50154, value: floatValue(row[3], -.001, level), base: row[3], perLevel: -.001, duration: row[1] / 1000, maxStacks: 3, recipientPolicy: 'enemy-front-priority', count: 2 },
        { buffId: id + 20, effectId: 50011, value: floatValue(row[4], .002, level), base: row[4], perLevel: .002, duration: row[1] / 1000, maxStacks: 3, recipientPolicy: 'self', count: 1 }
      ] };
  }
  function living(units) { return (Array.isArray(units) ? units : []).filter(function (u) { return u && Number.isFinite(u.hp) && u.hp > 0; }); }
  function isHero(u) { return u.entityKind === 'hero' || u.unitType === 1 || u.entityKind === undefined && u.unitType === undefined && Number.isInteger(u.slot) && u.slot >= 0 && u.slot <= 4; }
  function isSupport(u) { return u.entityKind === 'dominator' || u.unitType === 4; }
  function slot(u) { return Number.isInteger(u.slot) ? u.slot : Number.isInteger(u.sourceIndex) && u.sourceIndex >= 1 && u.sourceIndex <= 10 ? (u.sourceIndex - 1) % 5 : 99; }
  function order(units) { return units.slice().sort(function (a,b) { return slot(a) - slot(b) || (a.sourceIndex || 0) - (b.sourceIndex || 0); }); }
  function plan(rule, actor, enemies, at) {
    if (!rule || rule.kind !== 'gorilla-critical-active' || !actor || actor.heroId !== 1000000 || !(actor.hp > 0) || !Number.isFinite(at) || at < 0) return [];
    var alive = living(enemies).filter(function (u) { return (isHero(u) || isSupport(u)) && !(actor.side && u.side && actor.side === u.side); }), front = order(alive.filter(function (u) { return isHero(u) && slot(u) < 2; })), back = order(alive.filter(function (u) { return isHero(u) && slot(u) >= 2 && slot(u) <= 4; })), support = order(alive.filter(isSupport));
    var grants = [];
    rule.branches.forEach(function (branch) {
      var targets = branch.recipientPolicy === 'self' ? [actor] : branch.recipientPolicy === 'enemy-front-priority' ? front.concat(support, back).slice(0,branch.count) : back.concat(front, support).slice(0,branch.count);
      targets.forEach(function (target) { grants.push({ target: target, source: actor, skillId: rule.skillId, skillLevel: rule.level, sourceEffectId: rule.effectId, buffId: branch.buffId, effectId: branch.effectId, value: branch.value, maxStacks: branch.maxStacks, appliedAt: at, expiresAt: at + branch.duration, recipientPolicy: branch.recipientPolicy, deliveryPolicy: POLICIES.delivery }); });
    });
    return grants;
  }
  function createState() { return { stacks: [], nextId: 1 }; }
  function expire(state, at) {
    if (!state || !Array.isArray(state.stacks) || !Number.isFinite(at)) return [];
    var removed = state.stacks.filter(function (stack) { return stack.expiresAt <= at; });
    state.stacks = state.stacks.filter(function (stack) { return stack.expiresAt > at; });
    return removed;
  }
  function add(state, grant, at) {
    if (!state || !Array.isArray(state.stacks) || !grant || !Number.isFinite(at) || !Number.isFinite(grant.value) || grant.appliedAt !== at || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= at || grant.maxStacks !== 3 || [50011,50154].indexOf(grant.effectId) < 0) return { applied: false, reason: 'invalid-bounded-grant' };
    var row = rows[grant.skillId - 800020], offset = grant.buffId - grant.skillId, branchIndex = offset === 0 ? 0 : offset === 10 ? 1 : offset === 20 ? 2 : -1;
    if (!row || row[0] !== grant.skillId || branchIndex < 0 || !Number.isSafeInteger(grant.skillLevel) || grant.skillLevel < 1 || grant.skillLevel > 1000 || grant.sourceEffectId !== grant.skillId * 10 || grant.effectId !== (branchIndex === 1 ? 50154 : 50011) || grant.value !== floatValue(row[branchIndex + 2], branchIndex === 2 ? .002 : -.001, grant.skillLevel) || Math.abs(grant.expiresAt - at - row[1] / 1000) > 1e-9) return { applied: false, reason: 'invalid-bounded-grant' };
    expire(state,at);
    if (state.stacks.filter(function (stack) { return stack.buffId === grant.buffId; }).length >= grant.maxStacks) return { applied: false, reason: 'source-cap-new-grant-suppressed' };
    var stack = { id: state.nextId++, sourceIndex: grant.source && grant.source.sourceIndex, skillId: grant.skillId, buffId: grant.buffId, effectId: grant.effectId, value: grant.value, appliedAt: at, expiresAt: grant.expiresAt };
    state.stacks.push(stack);
    return { applied: true, stack: stack };
  }
  function deltaAt(state, effectId, at) {
    expire(state,at);
    return state && Array.isArray(state.stacks) ? state.stacks.reduce(function (sum, stack) { return sum + (stack.effectId === effectId ? stack.value : 0); },0) : 0;
  }
  // Optional target-key adapter permits one engine-owned state. Keys should
  // include side and identity epoch; numeric source slots can be reused.
  function targetState(state, key) {
    if (!state || (typeof key !== 'string' && typeof key !== 'number')) return null;
    if (!state.targets) state.targets = {};
    var safeKey = '$' + String(key);
    if (!state.targets[safeKey]) state.targets[safeKey] = createState();
    return state.targets[safeKey];
  }
  function addGrant(state, key, grant, at) {
    if (arguments.length === 3) return add(state,key,grant);
    return add(targetState(state,key),grant,at);
  }
  function getDelta(state, key, effectId, at) {
    if (arguments.length === 3) return deltaAt(state,key,effectId);
    return deltaAt(targetState(state,key),effectId,at);
  }
  return { version: '0.1.0-estimated', profile: profile, plan: plan, createState: createState, add: add, addGrant: addGrant, expire: expire, deltaAt: deltaAt, getDelta: getDelta, floatValue: floatValue, policies: POLICIES, source: SOURCE };
});
