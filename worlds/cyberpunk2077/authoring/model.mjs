// Authoring helpers emit ordinary schema-v17 data, never runtime plugins.
export const profiles = { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek-long" };

export function createAuthoringModel() {
  const entities = new Map();
  const provenance = {};
  const origins = [];
  const timers = [];
  const entity = (id, name, kind, placement, description, source = "original") => {
    if (entities.has(id)) throw new Error(`Duplicate authored entity: ${id}`);
    const value = { id, kind, name, description, placement, facts: [], meters: [], quantities: [], ratings: [] };
    entities.set(id, value);
    provenance[id] = { source, placement: "author-staged-at-T0", mechanics: "original-calibration" };
    return value;
  };
  const get = id => {
    const value = entities.get(id);
    if (!value) throw new Error(`Unknown authored entity: ${id}`);
    return value;
  };
  const fact = (id, predicate, value, description, audience = "public") => {
    const subject = get(id);
    const access = Array.isArray(audience) ? { kind: "agents", agentIds: audience } : { kind: audience };
    const typed = typeof value === "object" ? value : { kind: typeof value === "string" ? "text" : typeof value, value };
    const detail = typeof value === "string" && description === value ? `${subject.name}的${predicate}记录。` : description;
    const result = { id: `${id}-${predicate}-${subject.facts.length + 1}`, predicate, value: typed, description: detail, access };
    subject.facts.push(result);
    return result;
  };
  const reference = (id, predicate, target, description, audience = "public") =>
    fact(id, predicate, { kind: "entity", entityId: target }, description, audience);
  const quantity = (id, definition_id, amount) => {
    const existing = get(id).quantities.find(entry => entry.definition_id === definition_id);
    if (existing) existing.amount = amount;
    else get(id).quantities.push({ definition_id, amount });
  };
  const know = (actor, target, description, status = "observed") => {
    const mind = get(actor).agent.belief;
    const targetEntity = get(target);
    const local = target === actor ? "self" : `known-${target}`;
    if (!mind.local_entities.some(entry => entry.id === local)) {
      mind.local_entities.push({ id: local, name: target === actor ? "我" : targetEntity.name, description, status });
      mind.bindings.push({ local_entity_id: local, canonical_entity_ids: [target] });
    }
    return local;
  };
  const believe = (actor, target, predicate, description, confidence = 0.95) => {
    const mind = get(actor).agent.belief;
    const subjectId = know(actor, target, description);
    const id = `memory-${mind.claims.length + 1}`;
    const evidenceId = `${id}-evidence`;
    mind.evidence.push({ id: evidenceId, kind: "observation", description, sourceId: "self", step: 0 });
    mind.claims.push({ id, subjectId, predicate, value: { kind: "text", value: description }, description,
      stance: "believed", confidence, evidenceIds: [evidenceId] });
    return subjectId;
  };
  const person = ({ id, name, place, description, persona, voice, goal, value, trait, cash = 1200, ratings = {}, source = "original", appearance }) => {
    const body = entity(id, name, "person", place, description, source);
    body.presentation = { label: appearance?.label ?? name, description: appearance?.description ?? description };
    body.meters = [{ id: `${id}-vitality`, definition_id: "vitality", current: 30 }, { id: `${id}-strain`, definition_id: "strain", current: 0 }];
    body.quantities = [{ definition_id: "eurodollar", amount: cash }, { definition_id: "medical-supply", amount: 1 }];
    body.ratings = Object.entries(ratings).map(([definition_id, number]) => ({ id: `${id}-${definition_id}`, definition_id, value: number }));
    body.agent = { id, model_profiles: profiles, character: {
      persona: { summary: persona, voice },
      traits: [{ id: "temperament", description: trait ?? persona, strength: 0.75 }],
      values: [{ id: "priority", description: value, strength: 0.85 }], emotions: [], attitudes: [],
      goals: [{ id: "current-purpose", description: goal, priority: 0.8, progress: 0, target_ids: [], motivated_by_ids: ["priority"] }], commitments: [],
    }, belief: { local_entities: [], evidence: [], claims: [], bindings: [] } };
    know(id, id, description);
    know(id, place, get(place).description);
    return body;
  };
  const relationship = (left, right, predicate, shared, leftView, rightView, source = "original") => {
    reference(left, predicate, right, shared, [left, right]);
    for (const [actor, target, view] of [[left, right, leftView], [right, left, rightView]]) {
      const subject_id = believe(actor, target, predicate, `${shared} ${view}`);
      get(actor).agent.character.attitudes.push({ id: `toward-${target}`, subject_id, description: view, intensity: 0.7 });
    }
    provenance[`${left}:${predicate}:${right}`] = { source, cognition: "individual-interpretation" };
  };
  const own = (owner, asset, description = "持有该物的所有权。") => {
    reference(asset, "owner", owner, description, [owner]);
    believe(owner, asset, "ownership", description);
  };
  const contract = (id, name, place, parties, terms, budget = 0) => {
    const document = entity(id, name, "contract", place, "供当事人阅读与协商的业务文件，内容不对路人自动公开。");
    fact(id, "terms", terms, terms, parties);
    fact(id, "status", "pending", "条款待当事人商议；未签约不产生付款或强制结果。", parties);
    fact(id, "signed", false, "相关当事人尚未共同签署；只有实际同意和签署才能改变。", parties);
    parties.forEach(actor => {
      reference(id, "party", actor, "该人是此文件的当事人。", parties);
      const local = believe(actor, id, "terms", terms);
      get(actor).agent.character.goals.push({ id: `consider-${id}`, description: `就${name}作出符合自身利益的决定；允许修改、拒绝或延期。`,
        priority: 0.65, progress: 0, target_ids: [local], motivated_by_ids: ["priority"] });
    });
    if (budget) quantity(id, "eurodollar", budget);
    return document;
  };
  const commitment = (actor, description, targets) => {
    const character = get(actor).agent.character;
    character.commitments.push({ id: `promise-${character.commitments.length + 1}`, description, priority: 0.75,
      subject_ids: targets.map(target => know(actor, target, get(target).name)) });
  };
  const stock = (holder, container, definition, amount) => {
    const old = get(container).quantities.find(q => q.definition_id === definition);
    if (old) get(container).quantities = get(container).quantities.filter(q => q !== old);
    const current = get(holder).quantities.find(q => q.definition_id === definition)?.amount ?? 0;
    quantity(holder, definition, current + amount);
    reference(holder, `storage-${definition}`, container, "该类登记物资的实际存放处；保管不改变产权，远离存放处不能隔空交货。", [holder]);
    believe(holder, container, "stored-resources", `我负责保管的 ${definition} 在这里，取用、交付和消耗须满足现场与授权条件。`);
  };
  return { entities, provenance, origins, timers, entity, get, fact, reference, quantity, person, know, believe, relationship, own, contract, commitment, stock };
}
