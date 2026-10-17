import AdmZip from "adm-zip";
import { stringify } from "yaml";
import { entityDocumentSchema } from "../../src/script/contract";
import { parseWorldTemplate, type NormalizedWorldTemplate } from "../../src/script/world-loader";

/** A synthetic population fixture; its added residents never count as canonical coverage. */
export function makeFanrenScaleWorld(source: NormalizedWorldTemplate, population: 150 | 700) {
  const template = structuredClone(source);
  const baseAgents = template.entities.filter(entity => entity.agent).length;
  const added = population - baseAgents;
  const city = template.entities.find(entity => entity.id === "tianyuan-city");
  if (added < 11 || !city) {
    throw new Error("scale fixture requires the reviewed opening sample and room for synthetic residents");
  }
  const residentId = (index: number) => `scale-resident-${String(index + 1).padStart(4, "0")}`;
  const courtyardId = (index: number) => `scale-court-${Math.floor(index / 10)}`;
  template.manifest.id = `fanren-scale-${population}`;
  template.manifest.name = `凡人局部样本：${population} 人自治规模试验`;
  template.manifest.description += " 此包额外加入明确标为原创的规模试验居民，不计入原著人物覆盖或完整两界制作。";
  template.manifest.narrative.expansion = false;
  for (let index = 0; index < Math.ceil(added / 10); index++) {
    template.entities.push(entityDocumentSchema.parse({ id: `scale-court-${index}`, kind: "place", name: `商旅歇脚院${index + 1}`,
      description: `${city.name}外围一处原创商旅歇脚院，院落相互分开。`, placement: "tianyuan-city",
      facts: [], meters: [], quantities: [], ratings: [] }));
  }
  for (let index = 0; index < added; index++) {
    const id = residentId(index), partner = residentId((index + 1) % added), kin = residentId((index + 10) % added);
    const name = `周边商旅${String(index + 1).padStart(3, "0")}`;
    template.entities.push(entityDocumentSchema.parse({ id, kind: "person", name,
      description: "从事低阶灵材交易的本土人族商旅，独立保管自己的财物。", placement: courtyardId(index),
      facts: [
        { id: `${id}-partner`, predicate: "trade-partner", value: { kind: "entity", entityId: partner },
          description: "有日常商旅合作，财产并不共有。", access: { kind: "private" } },
        { id: `${id}-kin`, predicate: "family-of", value: { kind: "entity", entityId: kin },
          description: "有亲属往来，仍各自拥有财物。", access: { kind: "private" } },
      ], meters: [], quantities: [{ definition_id: "low-stone", amount: 10 + index % 17 }], ratings: [],
      agent: { id, model_profiles: template.manifest.model_profiles,
        character: { persona: { summary: "谨慎的灵材商旅，记得自己认识的人和各自财物边界。", voice: "说清所见，不替别人决定。" },
          goals: [{ id: "inventory-once", description: "在此歇脚时完成一次自己的随身灵石清点；完成后休息等候，不重复清点，也不处置旁人的财物。", priority: 0.5, progress: 0 }] },
        belief: {
          local_entities: [
            { id: "self", name, description: "自己独立保管随身灵石。", status: "observed" },
            { id: "location", name: "歇脚院", description: "现在所在的院落。", status: "observed" },
            { id: "partner", name: `合作商旅${(index + 1) % added + 1}`, description: "日常合作伙伴，物资各自所有。", status: "observed" },
            { id: "kin", name: `亲属${(index + 10) % added + 1}`, description: "住在另一处院落的亲属，没有共享随身财物。", status: "observed" },
          ],
          evidence: [{ id: "prior-acquaintance", kind: "observation", description: "以前的家庭与商旅往来。", sourceId: null, step: 0 }],
          claims: [
            { id: "trade-partner", subjectId: "self", predicate: "trade-partner", value: { kind: "local_entity", localEntityId: "partner" },
              description: "与这位商旅有合作。", confidence: 1, stance: "believed", evidenceIds: ["prior-acquaintance"] },
            { id: "kinship", subjectId: "self", predicate: "family-of", value: { kind: "local_entity", localEntityId: "kin" },
              description: "与这位亲属有家庭往来。", confidence: 1, stance: "believed", evidenceIds: ["prior-acquaintance"] },
          ],
          bindings: [
            { local_entity_id: "self", canonical_entity_ids: [id] },
            { local_entity_id: "location", canonical_entity_ids: [courtyardId(index)] },
            { local_entity_id: "partner", canonical_entity_ids: [partner] },
            { local_entity_id: "kin", canonical_entity_ids: [kin] },
          ],
        },
      },
    }));
  }
  return { template: parseWorldTemplate(template), population, baseAgents, syntheticAgents: added, relationFacts: added * 2 };
}

export function archiveScaleWorld(template: NormalizedWorldTemplate): Buffer {
  if (template.assets.length) throw new Error("scale fixture expects the asset-free opening sample");
  const zip = new AdmZip();
  const files: Array<[string, unknown]> = [["script.yaml", template.manifest], ["laws.yaml", template.laws],
    ["mechanics.yaml", template.mechanics], ["participation.yaml", template.participation],
    ...template.entities.map(entity => [`entities/${entity.id}.yaml`, entity] as [string, unknown])];
  for (const [file, data] of files) zip.addFile(file, Buffer.from(stringify(data)));
  return zip.toBuffer();
}
