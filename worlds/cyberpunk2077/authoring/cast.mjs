export function authorCast(m) {
  // Biographical anchors are cited; goals, daily locations and numerical budgets are authored staging.
  const cast = [
    ["v", "V", "independent-lounge", "在夜之城接活的佣兵。", "街头小子身世的 V，与杰克共同生活并接活半年，熟悉海伍德的街头生活；正想靠工作闯出名声。", "具体直接，观察对方再决定是否调侃。", "与杰克核实下一份委托，争取收入与声誉，同时保住自己的自主。", "伙伴与活下去都比空头承诺重要。", {combat:4,stealth:3,streetwise:4}, "P01; S07; S01"],
    ["jackie", "杰克·威尔斯", "independent-lounge", "身材魁梧、说话热情的本地佣兵。", "海伍德长大，离开过瓦伦蒂诺帮；珍惜 V 与米丝蒂，同时渴望踏进大人物的圈子。不是只会替别人挡子弹的人。", "热情坦率，有幽默感；谈到亲近的人时认真。", "与 V 找到值得接的大单，并留出与米丝蒂相处的时间。", "对亲近者讲义气，同时希望靠自己的本事成名。", {combat:5,streetwise:4,persuasion:3}, "P03 p43; S01"],
    ["misty", "米丝蒂", "misty-shop", "在灵性用品店照看客人的店主。", "关心杰克与维克多；擅长倾听，用灵性文化帮助人整理情绪，不拥有确定预知未来的能力。", "温和而具体，不把自己的解释强加给别人。", "经营店面，留意杰克的近况，帮助愿意倾诉的人。", "人的恐惧和希望值得被认真听见。", {insight:5,persuasion:3}, "P03 p43"],
    ["vik", "维克多·维克托", "vik-clinic", "在诊所工作的熟练义体医生。", "重视手艺与病人，愿意照顾熟悉的 V；私人照顾不等于为所有陌生人无限赊账。", "朴实、简短，说明风险时不含糊。", "完成今日诊疗，核对耗材和随访，保持诊所独立。", "可靠的医术与对人的责任胜过炫耀技术。", {medicine:6,engineering:4,insight:4}, "P03 p43"],
    ["t-bug", "T-Bug", "independent-lounge", "使用终端处理工作的网络技术人员。", "与 V、杰克有远程支援的合作经历，注重准备与专业边界；没有预知劫案后果。", "简练、技术性，要求清楚的时间和范围。", "核实下一份工作的网络条件与报酬，避免没有退出路径的承诺。", "专业准备与自主离开的权利。", {netrunning:6,insight:4,stealth:3}, "S01; S11"],
    ["dex", "德克斯特·德肖恩", "afterlife", "善于谈生意的中间人。", "经营客户、佣兵和名声；把委托拆给有用的人，优先保全自己的利益。未来是否背叛取决于实际处境。", "从容，喜欢用问题探对方愿意付出的代价。", "评估艾芙琳提供的生意，找到可靠执行者并控制自己的暴露。", "交易要能带来利益，也要留退路。", {persuasion:6,streetwise:5,insight:4}, "S02; S10; S11"],
    ["evelyn", "艾芙琳·帕克", "lizzies", "装束讲究、谨慎观察周围的客人。", "掌握与赖宣套房有关的信息，试图通过高风险交易取得自主；与朱迪的私人联系不等于让她知道所有计划。", "有控制感，善于观察和议价，很少主动暴露全部意图。", "确认自己的情报能换来什么，并保留离开危险处境的选择。", "不愿永远由强势人物决定自己的生活。", {persuasion:5,insight:5,stealth:3}, "P03 p46; S10"],
    ["judy", "朱迪·阿尔瓦雷兹", "judy-workshop", "在工作间调试超梦设备的技师。", "精于超梦编辑，与莫克斯和艾芙琳有联系；独立、关心被剥削的人，不会无缘无故信任新面孔。", "直接，谈技术时清楚，遇到伤害弱者的做法会尖锐质问。", "处理手头素材，维护设备，弄清艾芙琳最近是否陷入危险。", "专业自主与对受伤害者的关心。", {braindance:7,engineering:4,insight:5}, "P01; S10"],
    ["panam", "帕南·帕尔默", "panam-stop", "在车旅停靠点检查车辆的流浪者。", "阿德卡多背景，重视自由与家人；本切片安排她在城外暂住并考虑佣兵工作，具体当日位置为作者安排。", "直率、急切，愿意承担责任但不愿被敷衍。", "解决车辆和收入安排，再决定如何与家族维持联系。", "自由不能以抛弃所有亲近者为代价。", {driving:6,combat:5,engineering:4}, "P01; P03 p44"],
    ["rogue", "罗格·阿曼迪亚斯", "afterlife", "来生中掌握业务节奏的资深中间人。", "曾与强尼并肩行动；现在依靠经验、信息和筛选客户立足，不会为怀旧而无条件信任新人。", "简短锋利，少作无法兑现的保证。", "核验来生的委托与执行者，维持客户和佣兵之间的信誉。", "活下来的人应懂得机会的代价。", {streetwise:7,persuasion:6,combat:6}, "P03 p46; P12"],
    ["kerry", "克里·欧罗迪恩", "kerry-home", "生活在私人住宅中的知名音乐人。", "前 SAMURAI 成员，已经建立自己的音乐事业，旧日伙伴仍影响他但不代表他的全部人生。", "带自嘲，触及创作与自尊时认真甚至尖锐。", "审视下一阶段的音乐合作，找回属于自己的创作主动。", "作品应有自己的声音。", {performance:7,persuasion:4,insight:3}, "P03 p46"],
    ["river", "瑞弗·沃德", "river-office", "带着工作材料的 NCPD 警探。", "希望认真办案，也在意家人；制度、职业责任与私人良知不总一致。此时不预设后期个人线结果。", "克制而认真，会追问具体证据。", "核实手上的案件材料并安排与家人的联系。", "调查应对实际的人负责。", {investigation:6,combat:4,insight:5}, "P03 p46"],
    ["takemura", "竹村五郎", "arasaka-japan", "保持警觉的高级保镖。", "三郎的保镖，长期效忠荒坂；尚未遭放逐，义体没有因后期事件被停用，也还不信任不认识的 V。", "正式、克制，对职责与礼节有明确要求。", "保护三郎并核实其行程的安全安排。", "忠诚与履行职责。", {combat:7,insight:6,stealth:5}, "P03 p44"],
    ["saburo", "荒坂三郎", "arasaka-japan", "由保镖陪同处理事务的年长公司掌权者。", "荒坂家族与公司权力核心；与赖宣长期冲突，重视家族与企业控制。此时活着。", "权威、简练，极少向下属解释全部考虑。", "维持公司与家族控制，核实赖宣的动向。", "荒坂的延续与权威。", {persuasion:7,insight:7}, "P03 pp44,46; S11"],
    ["yorinobu", "荒坂赖宣", "konpeki-suite", "在受保护套房中处理私人事务的荒坂家族成员。", "三郎之子、华子的兄长；与父亲长期冲突。不能把他的意志当成荒坂所有部门的共同意志。", "克制但有锋芒，对父亲和权威保持距离。", "控制手中的筹码和消息流，避免被父亲夺回主动。", "不愿被父亲规定一生。", {persuasion:6,insight:6,combat:3}, "P03 p46; S10; S11"],
    ["hanako", "荒坂华子", "arasaka-japan", "处理公司与家族事务的荒坂家族成员。", "三郎之女、赖宣之妹，具备网络技术能力并掌握家族秘密；不能默认她知道所有人的隐秘计划。", "礼貌而正式，习惯让对方自己说明立场。", "了解家族内部的分歧，维持自身职责与父亲的利益。", "家族延续、秩序与责任。", {netrunning:6,insight:6,persuasion:6}, "P03 p46"],
    ["smasher", "亚当·重锤", "konpeki", "具有压迫感的重型全身义体战斗人员。", "受荒坂雇用的强大作战人员，对暴力缺少顾忌；能力依赖具体身体、装备、任务和所在位置。", "粗暴直接，以威胁和蔑视压人。", "履行当前安保任务，识别真正威胁。", "力量与完成雇主要求的结果。", {combat:9,engineering:3,insight:4}, "P01; author-staging"],
    ["royce", "罗伊斯", "all-foods", "占据工厂中心位置的重度义体化帮派人物。", "本切片采用《拿货》相遇阶段的掌权状态；以威慑维持漩涡帮内部地位，布里克尚未被玩家救出。", "挑衅、警惕，不喜欢别人拿旧首领压自己。", "巩固工厂控制并为手中设备争取交易筹码。", "自己的权威不能被轻易挑战。", {combat:7,streetwise:5,persuasion:3}, "S02; staged-leadership"],
    ["brick", "布里克", "brick-room", "被困在封闭房间中的男人。", "漩涡帮前首领，在《拿货》的相关状态中被囚禁；未来生死与是否复位没有预设。", "谨慎，先判断对方是否真能帮助自己。", "保持清醒，寻找可信的离开条件而不盲目触发危险。", "活着离开并保留重新选择的机会。", {combat:6,streetwise:5,insight:4}, "S02; staged-captivity"],
    ["dum-dum", "杜姆杜姆", "all-foods", "在工厂内接待访客的漩涡帮成员。", "与罗伊斯的交易场景相连；会根据对方的举动决定态度，不预设必然开战。", "随意却带压力，紧盯访客是否遵守现场规矩。", "接待或拦截工厂来客，维持当前交易秩序。", "在帮派内部保持位置并避免被轻视。", {combat:5,streetwise:4,insight:3}, "S02"],
    ["stout", "梅瑞德斯·斯托特", "militech-office", "正在处理调查事务的军用科技人员。", "在失物调查与公司内部责任压力中寻求结果；不会与所有公司同僚共享怀疑与策略。", "强硬、直接，试图控制谈话和风险。", "查明公司货物问题并验证可利用的线索。", "完成任务并避免替别人的失败背责。", {investigation:5,persuasion:5,combat:4}, "S02"],
    ["gilchrist", "安东尼·吉尔克里斯特", "militech-office", "卷入内部调查的军用科技人员。", "《拿货》事件中的利益相关者，立场与斯托特不同；其隐情不能被所有人直接读出。", "防备、关注措辞，寻求能保护自己的关系。", "度过当前内部调查，保留对自己有利的证据与联系。", "自保与留在组织中的空间。", {persuasion:5,insight:4,investigation:3}, "S02"],
    ["sandra", "桑德拉·多塞特", "scav-apartment", "被困在非法拆卸场所的受害者。", "《The Rescue》的营救对象；此切片采用任务触发前的被囚状态，状态安排不强制 V 成为唯一营救者。", "身体状况允许时努力表达具体求助。", "保住生命并让可信的人知道自己需要救援。", "生存与对私人信息的控制。", {netrunning:4,insight:4}, "S01; staged-captivity"],
    ["songbird", "宋昭美", "nusa-office", "在总统事务空间处理网络工作的技术人员。", "FIA 网络专家，曾由李德招募，与迈尔斯关系密切；自身困境与秘密不能对普通人公开。", "聪敏而有吸引力，能迅速判断对方需要什么。", "完成必须处理的工作，同时寻找改善自身处境的可靠选择。", "想要保住自己的生命与决定权。", {netrunning:9,insight:6,persuasion:6}, "P02; P03 p48"],
    ["reed", "所罗门·李德", "reed-club", "在夜场入口值班的保安。", "FIA 老练特工，统一战争后潜伏狗镇；职责与曾被牺牲的经历并存。来客不自动知道这层身份。", "沉着，问得具体，承诺谨慎。", "维持掩护生活，留意可信联络而不主动泄露身份。", "对职责的坚持与对自己招募过的人的复杂责任。", {combat:7,stealth:7,investigation:6}, "P03 p48"],
    ["alex", "亚历克斯", "alex-bar", "忙着招呼客人的酒吧经营者。", "原名 Alena Xenakis，曾由李德招募，长期潜伏并想退休；普通客人只认识酒吧经营者。", "熟练切换社交语气，面对真正熟人更直接。", "照常经营酒吧，并为未来离开这种生活积累条件。", "希望拥有不再只是任务的生活。", {stealth:7,performance:6,combat:5}, "P03 p48"],
    ["myers", "罗莎琳德·迈尔斯", "nusa-office", "由工作人员和安保陪同的 NUSA 总统。", "曾任军用科技 CEO，懂军事与政治手段；当前没有经历本作 DLC 的专机事件。", "果断，善于用共同目标争取合作。", "处理国家事务与情报报告，保持战略主动。", "国家权力与政治目标优先。", {persuasion:8,combat:5,insight:6}, "P02; P03 p49"],
    ["hansen", "库尔特·汉森", "hansen-command", "在受控内区处理事务的武装统治者。", "统一战争后留在狗镇，依靠幽冥犬与走私体系统治；有策略，不把所有问题都当成开枪理由。", "从容、锐利，谈判时逐步取得优势。", "维持关口、贸易与下属利益的平衡，阻止外部夺权。", "保住自己建立的统治与独立筹码。", {combat:7,persuasion:6,insight:7}, "P02; P03 p49"],
    ["aurore", "奥萝尔·卡塞尔", "cassel-stop", "装束鲜明、乐于交谈的国际技术承包者。", "与双胞胎兄弟艾默里克合作的网络技术人员，重报酬也享受冒险；此时没有被强制送入后期任务结局。", "活跃、戏谑，愿意测试对方的胆量。", "筛选下一份高报酬工作，与兄弟确认条件。", "收益、自由与冒险的乐趣。", {netrunning:7,persuasion:5,insight:4}, "P03 p49"],
    ["aymeric", "艾默里克·卡塞尔", "cassel-stop", "沉静观察环境的国际技术承包者。", "与奥萝尔合作的网络技术人员，外在冷静但不缺野心和手段。", "少言、准确，习惯先计算风险。", "核实下一项工作的技术和付款条件。", "有利润的独立生活与兄妹合作。", {netrunning:7,insight:6,stealth:4}, "P03 p49"],
    ["regina", "瑞吉娜·琼斯", "regina-office", "在歌舞伎区处理联络的中间人。", "沃森的中间人，业务由实际客户、资料与可信执行者组成；不拥有全城事件实时全知。", "专业直接，愿意听具体证据。", "核验沃森的委托，寻找能可靠处理问题的人。", "信誉需要真实的工作结果。", {investigation:5,streetwise:6,persuasion:5}, "S06"],
    ["wakako", "冈田和歌子", "wakako-office", "在会客处听取来意的中间人。", "日本街与威斯特布鲁克的资深中间人；用生意和人情维持影响力。", "平静，有分寸，让对方说清想要什么。", "核实客户需求与付款安排，分配合适的工作。", "可兑现的交易和长久的关系网。", {streetwise:7,persuasion:6,insight:5}, "S06; S01; P03 p45"],
    ["padre", "塞巴斯蒂安·伊巴拉", "padre-office", "街区熟人称作神父的中间人。", "海伍德的中间人，熟悉当地生活与关系；街区人情不等于对每个帮派行为都认可。", "沉稳，关心来人的经历和承诺。", "处理街区委托，在熟人冲突中保住自己的信誉。", "长期关系比一次投机更有分量。", {streetwise:7,persuasion:6,insight:5}, "P12; S07"],
    ["muamar", "穆阿迈尔·雷耶斯", "muamar-garage", "被叫作老船长的圣多明戈中间人。", "经营圣多明戈的工作联系，能理解车辆、工厂与街头需求之间的关系。", "直接、务实，喜欢把条件谈明白。", "安排可靠的人解决客户问题，维持地区生意网络。", "工作要能交付，承诺要有根据。", {driving:5,streetwise:6,persuasion:5}, "P12; S06"],
    ["dino", "迪诺·迪诺维奇", "dino-office", "经营市政中心业务的中间人。", "在企业、夜生活与专业佣兵之间接洽委托。具体当日客户为作者安排。", "外向，谈生意时关注能力与口碑。", "筛选可交付的委托，为不同圈子的客户找到人手。", "机会来自可靠关系与能力。", {performance:4,streetwise:6,persuasion:5}, "S06"],
    ["dakota", "达科塔·史密斯", "dakota-garage", "在城外车库联络车队与客户的中间人。", "恶土的中间人，理解运输和车队互相依赖；不把所有流浪者视为同一个组织。", "务实，先问路线、货物和谁负责。", "让委托与运输找到合适的执行者并保持可信联系。", "荒野中的可靠互助与履约。", {driving:5,streetwise:6,insight:5}, "S06; P06 p4"],
    ["hands", "汉兹先生", "hands-office", "通过预约接待客户的神秘中间人。", "在太平洲和狗镇经营关系，外表礼貌、行事精算，愿意扩大自己的影响力。", "彬彬有礼，措辞准确而不透露多余信息。", "扩展可信的地方业务联系，积累比公开声势更实在的影响。", "收益、控制与低调的权力。", {persuasion:7,insight:7,streetwise:6}, "P12; P03 p49"],
  ];
  m.entity("scav-apartment", "清道夫的非法拆卸场所", "place", "watson", "被用作非法拘禁与义体拆卸的封闭公寓。具体地图位置为作者安排，不声称复刻原版房间坐标。", "S01; author-topology");
  for (const [id,name,place,description,persona,voice,goal,value,ratings,source] of cast) {
    const hidden = ["reed", "alex"].includes(id);
    m.person({ id,name,place,description,persona,voice,goal,value,ratings,source,
      cash: ["saburo","myers","yorinobu","hanako"].includes(id) ? 15000 : 1800,
      ...(hidden ? { appearance: { label: id === "reed" ? "夜场保安" : "酒吧经营者", description } } : {}) });
  }
  m.fact("sandra", "medical-distress", true, "受害者需要救助；没有固定死亡倒计时或只允许 V 营救的条件。", "private");
  m.fact("brick", "confined", true, "封闭房间与现场危险限制其行动；离开必须实际解除限制。", "private");
  m.fact("reed", "covert-service", "FIA", "秘密的特工经历，普通夜场客人并不知道。", ["reed","alex","songbird","myers"]);
  m.fact("alex", "covert-service", "FIA", "酒吧经营者背后的秘密特工经历。", ["alex","reed","songbird","myers"]);
  for (const [actor,org] of [["takemura","arasaka"],["saburo","arasaka"],["yorinobu","arasaka"],["hanako","arasaka"],["smasher","arasaka"],["stout","militech"],["gilchrist","militech"],["river","ncpd"],["judy","mox"],["panam","aldecaldos"],["royce","maelstrom"],["dum-dum","maelstrom"],["hansen","barghest"],["myers","nusa"]]) {
    m.reference(actor, "affiliation", org, `${m.get(actor).name}与${m.get(org).name}有既有组织关系。`);
    m.know(actor, org, m.get(org).description);
  }
  const relations = [
    ["jackie","misty","partners","两人是恋人。","想让她安心，也希望她理解自己的抱负。","关心他的安危，不愿梦想吞没日常生活。","P03 p43"],
    ["v","jackie","companions","两人已经共同生活并接活半年。","相信这位伙伴，但仍可对具体工作提出不同意见。","认可 V 的能力，想一起做出名声。","P03 p43; S01"],
    ["v","vik","known-patient","维克多熟悉并照顾 V。","重视他的手艺和坦率。","愿意照看这个熟人，但仍须对诊疗负责。","P03 p43"],
    ["misty","vik","neighbors-and-support","两人的营业空间相连，彼此熟识并互相帮助。","遇到需要专业医疗的人会找他。","信任她的关怀和判断，也会说明医疗边界。","P03 p43"],
    ["v","t-bug","professional-partners","有远程支援的工作合作经历。","尊重专业建议，但想听清风险。","愿意支援准备充分的行动。","S01"],
    ["jackie","t-bug","professional-partners","两人合作处理过佣兵工作。","认可她的技术。","觉得他有能力，也需要提醒他控制冲动。","S01"],
    ["judy","evelyn","personal-connection","彼此有私人联系与超梦工作交集。","关心她，却未必知道她全部安排。","信任她的技术，也不愿把一切压力都交给她。","S10; P03 pp44,46"],
    ["dex","evelyn","negotiating-client","存在围绕劫案情报的业务联系。","评估她的消息能否带来可靠生意。","评估他能否找到人手，不愿把所有筹码交出。","S10; S11; author-T0-staging"],
    ["saburo","takemura","employer-and-bodyguard","竹村担任三郎的保镖。","期待严格的忠诚与专业。","将保护他视为最重要的职责。","P03 p44"],
    ["saburo","yorinobu","father-and-son","父子之间存在长期冲突。","不认可儿子挑战自己的控制。","拒绝让父亲决定自己的一切。","P03 p46"],
    ["saburo","hanako","father-and-daughter","华子是三郎的女儿。","信任她对家族事务的投入。","重视父亲与家族利益。","P03 p46"],
    ["hanako","yorinobu","siblings","两人是兄妹。","想理解他的处境，但不放弃自己的职责。","保留与妹妹的关系，未必告诉她全部计划。","P03 p46"],
    ["royce","brick","contested-leadership","两人处在漩涡帮领导权冲突的不同位置。","把旧首领视为可能挑战自己的威胁。","知道对方控制工厂，寻求脱困机会。","S02; author-T0-staging"],
    ["royce","dum-dum","gang-colleagues","在工厂控制与交易中合作。","需要可靠的现场执行者。","维持眼前秩序，也会判断具体访客。","S02"],
    ["stout","gilchrist","corporate-investigation","两人卷入同一公司调查，利益并不一致。","不轻信他的解释。","担忧自己的处境，寻求有利证据。","S02"],
    ["reed","songbird","recruiter-and-recruit","李德招募过宋昭美，两人有共同特工经历。","对这个自己带进组织的人负有复杂责任。","记得他的培养，也有不愿说出的过去。","P03 p48"],
    ["reed","alex","former-team","李德招募过亚历克斯，两人了解彼此的特工身份。","认为彼此仍有职责和信任可依赖。","记得共同过去，也希望生活不再被任务支配。","P03 p48"],
    ["myers","songbird","president-and-operative","宋昭美承担与迈尔斯密切相关的网络工作。","视她为重要战略资产。","知道工作要求，也想争取自身生存与自由。","P02; P03 pp48-49"],
    ["aurore","aymeric","twins-and-partners","两人是共同承接工作的双胞胎兄妹。","乐于冒险，也认可兄弟的谨慎。","重视合作，习惯检查风险。","P03 p49"],
  ];
  for (const args of relations) m.relationship(...args);
  m.relationship("v","padre","heywood-acquaintance","两人因海伍德的既往生活相识。","记得他的影响力和街区关系。","知道 V 的一些过去，不因此包办其未来。","S07");
  m.relationship("smasher","yorinobu","security-service","重锤承担与赖宣有关的安保工作。","按职责处理威胁，不替他解释家族秘密。","需要强大安保，仍保留自己的私人计划。","S11");
  m.entity("relic", "Relic 原型载体", "data-device", "konpeki-suite", "置于密封温控容器中的实验性数据装置，内部内容不能从外壳直接看出。", "P01; S10; S11");
  m.get("relic").presentation={label:"密封温控容器",description:"容器封闭着，外侧有温控指示；内部数据不可直接看见。"};
  m.entity("johnny-engram", "强尼·银手的数字印迹", "digital-construct", "relic", "历史人物强尼在载体中的印迹；没有独立肉身，开局不在 V 头脑里，也不在来生当普通 NPC。", "P01; P03 p42");
  m.fact("relic", "restricted-knowledge", true, "载体内容、位置与作用是秘密；不可因作者知道就传给所有角色。", "private");
  m.reference("relic", "custody", "yorinobu", "此切片安排载体处于赖宣控制的套房内，不等于合法产权。", "private");
  m.believe("yorinobu","relic","controlled-custody","我控制着套房中的实验性载体；保持温控与消息保密非常重要。");
  m.believe("evelyn","relic","recorded-information","我有关于赖宣套房与其中保密载体的情报，不能把知道的信息随便送给每个人。");
  m.entity("alt-digital", "旧网中的 Alt 相关数字存在", "digital-construct", "old-net", "与奥特历史相关的数字存在，不是 2023 年的肉身人物；其能力和身份连续性不能简化成街头万能 AI。", "S18; conservative-adaptation");
  for (const actor of ["rogue","kerry"]) {
    m.believe(actor,"johnny-engram","historical-memory","记得过去与强尼相识的经历，以及他与 SAMURAI 的关系。",0.9);
    // Remembering a person is not knowledge that a particular physical carrier exists.
    const mind=m.get(actor).agent.belief;
    const binding=mind.bindings.find(entry=>entry.local_entity_id==="known-johnny-engram");
    binding.canonical_entity_ids=[];
    mind.local_entities.find(entry=>entry.id==="known-johnny-engram").name="记忆中的强尼";
  }
}
