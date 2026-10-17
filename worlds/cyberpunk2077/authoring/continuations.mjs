// Original supporting people, resources, and documents for authored opening contracts.
export function authorContinuations(m) {
  const role = id => m.origins.find(entry => entry.id === id);
  const asset = (origin, id, name, kind, place, description, readers = []) => {
    m.entity(id, name, kind, place, description);
    role(origin).assets.push(id);
    for (const actor of new Set([origin, ...readers])) m.know(actor, id, description);
    return id;
  };
  const place = (origin, id, name, district, description, readers = []) => {
    asset(origin, id, name, "place", district, description, readers);
    m.reference(id, "street-access", district, "可沿所在街区的普通道路到达营业入口；前往和返回都需要实际行程。");
    return id;
  };
  const supportingContact = (origin, person, history, playerView, contactView) => {
    m.person(person);
    m.relationship(origin, person.id, "established-business-contact", history, playerView, contactView);
    (role(origin).supportingContacts ??= []).push(person.id);
    m.know(origin, person.place, `可以到${m.get(person.place).name}找${person.name}，不是隔空向其发出指令。`);
  };
  const allowReaders = (id, readers) => {
    for (const fact of m.get(id).facts) if (fact.access.kind === "agents") {
      fact.access.agentIds = [...new Set([...fact.access.agentIds, ...readers])];
    }
  };
  const addParty = (id, actor) => {
    const document = m.get(id);
    const parties = document.facts.filter(fact => fact.predicate === "party").map(fact => fact.value.entityId);
    if (parties.includes(actor)) return;
    parties.push(actor);
    allowReaders(id, [actor]);
    m.reference(id, "party", actor, "这名代表参与本次待议合同；列为当事人不等于已经签约。", parties);
    const terms = document.facts.find(fact => fact.predicate === "terms").value.value;
    const local = m.believe(actor, id, "terms", terms);
    m.get(actor).agent.character.goals.push({ id: `consider-${id}`, description: `就${document.name}提出自己的条件，待双方实际确认后再履行。`,
      priority: 0.65, progress: 0, target_ids: [local], motivated_by_ids: ["priority"] });
  };

  // O01: counterparties remain at their own workplaces, with only the first period funded.
  const leaseOffice = place("heir", "heir-lease-office", "嘉衡物业格伦办事处", "glen", "一家原创小型物业运营商的营业办公室。萨娜在这里接待预约，桌边有办理本次首月租金的支付终端。", ["elena"]);
  m.entity("heir-lease-company", "嘉衡物业运营", "organization", leaseOffice, "提出榆荫楼五年包租的原创经营主体；代表只能谈本次合同，不拥有楼的产权。");
  supportingContact("heir", { id: "heir-lease-agent", name: "萨娜·贝克", place: leaseOffice,
    description: "嘉衡物业负责这份包租要约的业务代表，今天在格伦办事处办公。",
    persona: "熟悉小楼经营，想给公司找到能长期维护的项目。她希望下班后赶上弟弟的街区球赛，愿意把分歧谈具体。",
    voice: "先解释计划如何使用房间，再听租户的顾虑；说到难办的条款会摊开纸张逐项改。",
    goal: "与两位产权人谈妥可执行的包租条件；不靠已经不存在的空房或赶走现有租客完成指标。",
    value: "兑现公司能承担的经营条件，保留双方改变或拒绝提案的余地。", ratings: { persuasion: 5, investigation: 3 } },
  "萨娜此前与诺亚和埃琳娜一起看过楼，提出书面方案，双方尚未签约。", "知道她在格伦的办公室，可以带着修改意见去谈。", "愿意认真听共有人与租客的条件，不能单方接管整楼。");
  m.relationship("elena", "heir-lease-agent", "property-negotiation", "双方参加过同一次看楼，嘉衡的提案还在商议。", "可以提出自己对维护和养老收入的要求。", "需要两位共有人都明确同意。");
  m.reference("heir-lease-agent", "represents", "heir-lease-company", "可以代表嘉衡商议本次包租，并在合同条件实际满足后申请本账户的首月付款。", ["heir", "elena", "heir-lease-agent"]);
  m.know("heir", "heir-lease-company", "五年包租要约的实际提案方是嘉衡物业运营。");
  m.know("elena", "heir-lease-company", "嘉衡物业由萨娜代表洽谈，未取得房屋使用或处分权。");
  m.know("heir-lease-agent", "heir-lease-company", "我只代表嘉衡处理这份已提出的包租方案。");

  const communityOffice = place("heir", "heir-community-office", "榆荫邻里合作社小办公室", "glen", "邻里合作社在格伦租用的既有办公室，准备社区空间合作并保管自己的业务资料；它还没有取得榆荫楼工作室使用权。", ["inez", "elena"]);
  m.entity("heir-community-coop", "榆荫邻里合作社", "organization", communityOffice, "提出每月4200欧元及分期修缮方案的原创合作社，首期资金来自已有成员出资，不是Inez的个人现金。");
  for (const actor of ["heir", "elena", "inez", "marco"]) m.know(actor, "heir-community-coop", "社区空间提案来自榆荫邻里合作社，伊内兹是本次受托代表。");
  m.reference("inez", "represents", "heir-community-coop", "合作社允许伊内兹谈本次空间合作、签署获双方确认的范围，并按实际交接申请首月付款；追加改造与持续支出需另议。", ["heir", "elena", "inez", "marco"]);
  m.believe("inez", "heir-community-coop", "negotiation-mandate", "我受托谈这一次空间合作，合作社办公室的账户已留首月4200欧元；未签约、未交接就不能付款，后续筹款也不是保证收入。");

  const rentAccount = asset("heir", "heir-rent-account", "榆荫楼共同经营收款账户", "account", "heir-work", "两位共有人接收实际租金的共同账户，初始没有本次提案收入；收款不改变各半产权。", ["elena"]);
  m.quantity(rentAccount, "eurodollar", 0);
  m.fact(rentAccount, "ownership-shares", "heir=50%; elena=50%", "收款按共同经营处理，任何分配都需两位共有人明确确认。", ["heir", "elena"]);
  for (const actor of ["heir", "elena"]) m.reference(rentAccount, "authorized-user", actor, "共同查看和协商使用；不能单方把全部营业收入据为己有。", ["heir", "elena"]);
  for (const [id, name, location, owner, delegate, amount, contract] of [
    ["heir-lease-settlement", "嘉衡本次首月租金账户", leaseOffice, "heir-lease-company", "heir-lease-agent", 7000, "heir-lease-offer"],
    ["heir-community-settlement", "邻里合作社首月空间款账户", communityOffice, "heir-community-coop", "inez", 4200, "heir-repair-offer"],
  ]) {
    asset("heir", id, name, "account", location, "已有的首月业务资金与代表私人现金分开；真实签约并完成约定空间交接后，代表才能在此终端申请本期付款。", ["elena", delegate]);
    m.quantity(id, "eurodollar", amount);
    m.reference(id, "owner", owner, "这笔余额属于提案主体，提出方案尚未把它转给房屋共有人。", ["heir", "elena", delegate]);
    m.reference(id, "authorized-user", delegate, "代表仅按本次已履行合同申请支付实际首月款。", ["heir", "elena", delegate]);
    m.reference(contract, "contracting-principal", owner, "这份现有提案的实际经营主体。", ["heir", "elena", delegate]);
    m.reference(contract, "settlement-account", id, "首月款已有真实余额；以后各期需届时实际筹得资金并履约，不能由定时器造钱。", ["heir", "elena", delegate]);
    m.reference(contract, "receiving-account", rentAccount, "本次实际租金进入两位共有人共同经营账户。", ["heir", "elena", delegate]);
    m.fact(contract, "premises-handed-over", false, "约定空间尚未交接；签约与交接是不同的实际行动。", ["heir", "elena", delegate]);
    m.fact(contract, "first-period-paid", false, "没有支付本提案的首月款，不能把资金准备当成到账。", ["heir", "elena", delegate]);
    m.fact(contract, "first-period-amount", amount, "当前提案第一月拟付金额，真实变更须当事人明确商议。", ["heir", "elena", delegate]);
    m.believe(delegate, id, "first-period-reserve", `本次已留${amount}欧元首月款，只有真实签约、交接并确认尚未支付后才能申请转入榆荫楼共同经营账户。`);
  }
  addParty("heir-lease-offer", "heir-lease-agent");
  m.reference("heir-repair-offer", "authorized-representative", "inez", "伊内兹代表合作社商议此提案，不代表两位产权人提前同意。", ["heir", "elena", "inez", "marco"]);
  m.reference("heir-lease-offer", "exclusive-alternative", "heir-repair-offer", "两方案争用同一间闲置工作室；同一使用期不能交给两方。改为兼容方案须重新明确空间、期限和费用。", ["heir", "elena", "heir-lease-agent", "inez"]);
  m.reference("heir-repair-offer", "exclusive-alternative", "heir-lease-offer", "社区方案尚未取得工作室，不与同一空间的包租交接重复履行。", ["heir", "elena", "inez", "marco"]);
  m.fact("heir-vacant", "contractual-occupant", "尚无本轮合同入住方", "闲置工作室尚未交给嘉衡或合作社；改变用途、钥匙保管和期限都要有实际约定。", ["heir", "elena", "inez", "heir-lease-agent"]);

  const plumberOffice = place("heir", "heir-plumber-work", "莫兰管线维修间", "glen", "莉迪亚的独立维修间，门口有营业时段和可现场确认的预约本；可以前来核对800欧元报价，再商议上门时间。", ["marco", "elena"]);
  supportingContact("heir", { id: "heir-plumber", name: "莉迪亚·莫兰", place: plumberOffice,
    description: "给榆荫楼开出管线维修报价的独立水管工，目前在自己的维修间接待客户。",
    persona: "靠小楼维修维持自己的店，喜欢一次把漏点处理妥当，晚上还要去接母亲回家。尚未到本次漏点前拆检。",
    voice: "拿尺寸和实际水声解释问题，报价说得清楚；愿让住户旁观一段简单维护。",
    goal: "核对现场与范围，谈妥费用后完成真正止漏的维修，并留出复压检查时间。",
    value: "以实际完成的手艺收钱，不把暂时关水当成修好了。", ratings: { craft: 6, investigation: 3 } },
  "马尔科向诺亚介绍过莉迪亚的店，桌上的800欧元文件是她的初步报价，双方未下单。", "可以到维修间确认报价，也可以按已有权限自己处理基础维护。", "先核对管线和工作范围；不把对方收到报价当成已经雇用我。");
  m.relationship("marco", "heir-plumber", "local-trades-contact", "马尔科曾请莉迪亚处理过洗衣店的小修，本次只转交了报价，没有替诺亚垫款。", "愿带邻居去找她核对范围。", "认识这位店主，但本次资金与施工仍须重新谈妥。");
  m.reference("heir-repair-quote", "contractor", "heir-plumber", "800欧元报价由莉迪亚提出；马尔科转交文件不使他成为施工费债权人。", ["heir", "elena", "marco", "heir-plumber"]);
  allowReaders("heir-repair-quote", ["heir-plumber"]);
  const plumbingTerms = "莉迪亚拟以800欧元核对漏点、隔离这段水路、在适配时使用楼内一枚常备密封垫完成基础更换并复压；范围须现场确认。两位共有人与施工方尚未签约，未付款、未施工。可协商有明确金额的预付款与验收尾款；马尔科代办须另有明确委托，自修不自动欠莉迪亚800欧元。";
  m.contract("heir-plumbing-order", "榆荫楼基础止漏待议施工单", "heir-work", ["heir", "elena", "marco", "heir-plumber"], plumbingTerms);
  role("heir").contracts.push("heir-plumbing-order");
  m.reference("heir-plumbing-order", "worksite", "heir-utility-room", "施工发生在真实公共管线间，不在报价桌上隔空完成。", ["heir", "elena", "marco", "heir-plumber"]);
  m.reference("heir-plumbing-order", "payee", "heir-plumber", "实际施工价款的收款人；报价本身不产生付款。", ["heir", "elena", "marco", "heir-plumber"]);
  m.fact("heir-plumbing-order", "work-accepted", false, "尚未进行本次维修后的复压验收。", ["heir", "elena", "marco", "heir-plumber"]);
  m.fact("heir-plumbing-order", "paid-amount", 0, "本次施工没有实际到账，不把报价、签字或关水计为支付。", ["heir", "elena", "marco", "heir-plumber"]);
  for (const id of ["heir-utility-room", "heir-service-pipe", "heir-pipe-seal", "heir-plumbing-tools", "heir-seal-stock"]) allowReaders(id, ["heir-plumber"]);
  for (const id of ["heir-service-pipe", "heir-plumbing-tools", "heir-seal-stock"]) {
    m.reference(id, "conditional-contractor", "heir-plumber", "到场并取得本次明确施工委托后，可以在约定范围使用工位、工具和材料；未签约不自动开始拆修。", ["heir", "elena", "marco", "heir-plumber"]);
  }
  m.know("heir-plumber", "heir-utility-room", "报价所指的楼内公共管线间，要实际前往检查。");
  m.know("heir-plumber", "heir-service-pipe", "照片中的冷水管活接正在滴水；还没有到场检查内部原因。");
  m.reference("heir-maintenance-log", "record-subject", "heir-plumbing-order", "单独记录实际委托、付款和验收，不把初步报价写成欠款。", ["heir", "elena", "marco", "inez"]);

  // O02: a client can inspect a delivered test package without granting production access.
  const clientOffice = place("lead", "lead-client-office", "澄线设施管理试点室", "charter-hill", "原创客户澄线设施管理的普通办公室及隔离演示工位。维奥拉在这里负责试点验收，可以当面商议演示范围与时间。", ["mina", "pavel"]);
  m.entity("lead-client-company", "澄线设施管理", "organization", clientOffice, "承接普通楼宇设备维护的原创小企业，是棱桥这次试点草案的客户；隔离演示不赋予对正式客户系统的访问权。");
  supportingContact("lead", { id: "lead-client-representative", name: "维奥拉·格林", place: clientOffice,
    description: "澄线的试点验收联系人，在自家试点室办公，负责判断演示是否适合现场团队使用。",
    persona: "从维修班组转到项目协调，知道一份坏演示会给夜班留下什么工作。希望给同事找一套可维护的工具，也愿意认可坦诚的阶段结果。",
    voice: "会问拿到系统的值班人第一步怎么做；看见可重复的演示会露出兴趣，遇到问题先问能缩到什么范围。",
    goal: "与棱桥谈明试点边界，亲自看实际演示后决定接受限定试点、要求修正或延期。",
    value: "让班组得到能实际使用且明确说明限制的系统。", ratings: { craft: 4, investigation: 5, persuasion: 4 } },
  "艾登与维奥拉见面讨论过这次楼宇设备试点，客户尚未验收。", "知道她在宪章山的试点室，可以带着实际版本去谈。", "愿听艾登解释技术取舍，不会把采购收据当成交付验收。");
  m.relationship("mina", "lead-client-representative", "pilot-business-contact", "米娜与维奥拉共同确认过拟议演示日，仍可商议范围和延期。", "希望客户能看到团队的真实进展。", "需要明确哪个范围今天可以承担。");
  m.reference("lead-client-representative", "represents", "lead-client-company", "可代表澄线检验本次隔离试点；正式上线权限和商业采购另行约定。", ["lead", "mina", "pavel", "lead-client-representative"]);
  for (const actor of ["lead", "mina", "pavel", "lead-client-representative"]) m.know(actor, "lead-client-company", "这次试点草案的客户是澄线设施管理，由维奥拉负责核对范围与实际演示。");
  addParty("lead-demo", "lead-client-representative");
  m.reference("lead-demo", "client", "lead-client-company", "本次试点有具体客户，不是由项目人员替不存在的客户宣布验收。", ["lead", "mina", "pavel", "lead-client-representative"]);
  m.reference("lead-demo", "delivery-place", clientOffice, "可携带实际演示版本到试点室，在隔离环境展示；不允许通过此约定访问正式生产网。", ["lead", "mina", "pavel", "lead-client-representative"]);
  m.reference("lead-demo", "acceptance-representative", "lead-client-representative", "客户代表实际查看约定范围和结果后才作接受、修正或延期决定。", ["lead", "mina", "pavel", "lead-client-representative"]);
  m.fact("lead-demo", "client-accepted", false, "客户未看本次成果，尚未验收。", ["lead", "mina", "pavel", "lead-client-representative"]);
  m.fact("lead-demo", "acceptance-scope", "待商议的隔离试点：说明演示范围，重现临时用户撤销与重连结果，列出尚未修复的限制；只接受实际展示且客户明确认可的范围。", "范围可以缩小或延期；预定演示不是正式上线授权。", ["lead", "mina", "pavel", "lead-client-representative"]);
  const demoPackage = asset("lead", "lead-demo-package", "待编制的试点演示包", "data-file", "lead-work", "已有的空白演示包文件，用于整理实际版本、操作步骤和已知限制；当前没有交付内容。", ["mina", "pavel"]);
  m.reference(demoPackage, "owner", "crownbridge-services", "演示资料属于棱桥，负责人只能在本次客户约定内交付。", ["lead", "mina", "pavel"]);
  for (const actor of ["lead", "pavel"]) m.reference(demoPackage, "authorized-writer", actor, "可据实际测试编制，不得删除真实限制来冒充已修复。", ["lead", "mina", "pavel", "lead-client-representative"]);
  m.fact(demoPackage, "entries", "空白：尚未编制本次版本、操作步骤和限制说明。", "演示包正文依据实际测试和商议形成。", ["lead", "mina", "pavel", "lead-client-representative"]);
  m.fact(demoPackage, "record-state", "blank", "尚未填写、交付或复核。", ["lead", "mina", "pavel", "lead-client-representative"]);
  m.fact(demoPackage, "delivered", false, "客户尚未收到本次演示成果。", ["lead", "mina", "pavel", "lead-client-representative"]);
  m.reference(demoPackage, "record-subject", "lead-terminal", "演示应来自实际隔离测试，不来自采购付款或口头承诺。", ["lead", "mina", "pavel"]);
  m.reference("lead-delivery-record", "record-subject", demoPackage, "采购交接和试点交付分别记录，不能以到货代替软件修复。", ["lead", "mina", "pavel", "ada"]);

  // O03: prior interview permissions are narrow; the current edit is still uncleared.
  const releases = asset("editor", "editor-release-file", "本次街头纪录片的受访授权夹", "data-file", "editor-work", "托马斯随素材交来的既有受访授权副本，需要打开核对具体范围；文件存在不代表当前剪辑已获最终放映确认。", ["tomas", "sora", "celia"]);
  m.reference(releases, "custodian", "tomas", "托马斯负责保存这组本次项目的授权来源，保管副本不取得受访者身体、声音或身份的无限使用权。", ["editor", "tomas", "sora", "celia"]);
  const signedRelease = m.entity("editor-signed-release", "授权夹内的签署副本正文", "data-file", releases, "授权夹内的原始签署副本，需实际打开相应记录；知道夹子的名称不等于读过正文。").id;
  m.reference(releases, "contained-record", signedRelease, "授权夹里存有本次项目的签署副本，需打开具体记录核对。", ["editor", "tomas", "sora", "celia"]);
  m.fact(signedRelease, "recorded-scope", "本片现有受访素材已取得为这一次周末现场放映制作剪辑的有限许可；第17段另附去除住址及可还原住址的线索这一条件。许可不含互联网发布、广告、转售素材或另一次放映；未包含的用途须另行取得同意。", "这是此前录制时留下的有限授权范围，不是当前工作版已经合格的结论。", ["editor", "tomas", "sora", "celia"]);
  m.fact(signedRelease, "review-procedure", "托马斯核对授权范围与去址剪辑，塞莉娅确认仅用于约定的这一场；两人查看实际回放后分别明确认可，才能把工作版记为可供本场放映。", "不由一个剪辑完成动作自动产生两人的最终认可。", ["editor", "tomas", "sora", "celia"]);
  m.fact(releases, "current-cut-reviewed", false, "尚未对当前含地址线索的工作版完成最终授权核验。", ["editor", "tomas", "sora", "celia"]);
  m.reference(releases, "record-subject", "editor-footage", "授权对象限于当前实际交来的纪录片素材。", ["editor", "tomas", "sora", "celia"]);
  m.reference("editor-cut", "authorization-source", releases, "工作版需符合这份有限授权；原始素材不因删改公开版而被抹除。", ["editor", "tomas", "sora", "celia"]);
  m.reference("editor-edit-log", "record-subject", releases, "记录实际核对的条款及最后认可，不能仅写“已授权”跳过回放与当事人判断。", ["editor", "tomas", "sora", "celia"]);
  m.believe("tomas", releases, "held-releases", "我带来了本片此前的有限受访授权，已经明确提出第17段必须去住址；还要核对实际剪辑，不是我交出文件就能直接放映。");

  // O04: one supplier-owned spare exists at a reachable depot, not inside the clinic stock.
  const depot = place("apprentice", "apprentice-parts-depot", "诺瓦克歌舞伎零件小库", "kabuki", "博租用的独立零件库，门锁由他保管；现有一枚封装的H-17接口备件。需随博实际到库或等他实际取货，诊所里不会直接出现第二件。", ["bo", "lin"]);
  m.reference(depot, "custodian", "bo", "博管理自己的小库；知道地址不等于可以私自进入或取货。", ["bo", "lin", "apprentice"]);
  const supplierSpare = asset("apprentice", "apprentice-supplier-spare", "博的H-17兼容接口备件", "component", depot, "一枚独立编号BR-H17-01的封装备件，位于博的小库。它与诊所中林医生的那一枚库存是不同实物。", ["bo", "lin"]);
  m.own("bo", supplierSpare);
  m.fact(supplierSpare, "serial-number", "BR-H17-01", "唯一实物编号；不能用复制记录获得第二枚。", ["bo", "lin", "apprentice"]);
  m.fact(supplierSpare, "interface-model", "H-17", "与诊所现有维护型号对应，安装前仍需检查实物状态与患者适配。", ["bo", "lin", "apprentice", "ana"]);
  m.fact(supplierSpare, "asking-price", 420, "本枚备件当前报价420欧元；可谈条件，报价不是已经付款。", ["bo", "lin", "apprentice"]);
  m.fact(supplierSpare, "available-for-sale", true, "当前仍属于博，未取货、未售出、未安装。", ["bo", "lin", "apprentice"]);
  m.fact(supplierSpare, "installed", false, "封装件尚未安装；实际更换须取得患者同意并使用同一枚实物。", ["bo", "lin", "apprentice", "ana"]);
  for (const id of ["apprentice-spare", "apprentice-patient-interface"]) m.fact(id, "interface-model", "H-17", "型号是可以通过编号核对的外部信息，不直接揭示患者内部状况。", ["apprentice", "lin", "ana"]);
  m.believe("bo", supplierSpare, "finite-stock", "我在歌舞伎小库只有这一枚BR-H17-01待售备件；带来的目录不是实物，取货和交接要实际发生。");
  m.contract("apprentice-parts-offer", "H-17备件取货待议单", "apprentice-work", ["apprentice", "lin", "bo"], "博的小库有一枚BR-H17-01，报价420欧元；需确认付款人、实际取货与当面验件后交付。诊所里林医生的旧库存仍独立存在，不能把两枚混记或重复出售。患者的检修、费用同意和病历不由这张零件报价代替。");
  role("apprentice").contracts.push("apprentice-parts-offer");
  m.reference("apprentice-parts-offer", "offered-item", supplierSpare, "交易对象是一枚现有实物，不是无限订货权限。", ["apprentice", "lin", "bo"]);
  m.reference("apprentice-parts-offer", "collection-place", depot, "付款或等待一句话不会把库内备件移到诊所。", ["apprentice", "lin", "bo"]);
  m.fact("apprentice-parts-offer", "paid", false, "本单尚未付款。", ["apprentice", "lin", "bo"]);
  const cart = asset("apprentice", "apprentice-delivery-cart", "诊所可借用的轻型折叠推车", "equipment", "apprentice-work", "林医生的一辆普通轻型折叠推车，轮子完好，适合短程搬运；能否帮助安娜配送要根据她的实际状态试用，不会替代手部检修。", ["lin", "ana"]);
  m.own("lin", cart);
  m.fact(cart, "loan-approved", false, "还没有同意本次外借，须与林医生谈妥使用者、归还时间和实际用途。", ["apprentice", "lin", "ana"]);
  m.fact(cart, "checked-out", false, "推车仍在诊所，不能只在对话里称借到便移走。", ["apprentice", "lin", "ana"]);
  for (const actor of ["apprentice", "lin", "ana"]) m.believe(actor, cart, "possible-loan", "诊所有这辆实际推车，能向林医生商议短程外借；安娜是否适合使用仍要听她的症状和意愿。");

  // O06: limited local credential checking supplies evidence, never a dispatched rescue result.
  const credential = asset("medic", "medic-service-card", "伊娃随身的个人服务凭证", "document", "injured-subscriber", "伊娃随身保存的个人凭证，需要先得到她出示与核对的同意；不能隔着衣物或只凭她的身份标签读取。", ["injured-subscriber"]);
  m.own("injured-subscriber", credential);
  const credentialPayload = m.entity("medic-credential-payload", "凭证内部的编码记录", "data-file", credential, "凭证中的受限编码记录，需要在本人出示并同意后实际读取；外壳本身不会公开有效期和校验结果。").id;
  m.reference(credential, "encoded-record", credentialPayload, "出示后可使用工作核验器读取这一具体记录，不是访问所有患者资料。", ["injured-subscriber", "medic", "mateo"]);
  m.fact(credentialPayload, "credential-content", "编号TT-NC-EVA-17，登记人伊娃·洛；凭证处于当前有效期，本人可请求按合同评估服务。它不载有派出车辆、当前医疗必要性、免费项目或响应时间的批准。", "凭证内容须实际出示和读取；有效成员身份不等于所有医疗请求已获调度批准。", ["injured-subscriber", "medic", "mateo"]);
  m.fact(credentialPayload, "signature-valid", true, "这份既有凭证能通过马特奥当前工作核验器的发行方签名校验；必须实际查验才形成当场结论。", ["mateo"]);
  m.fact(credential, "verification-state", "unchecked", "尚未完成本次现场核对。", ["injured-subscriber", "medic", "mateo"]);
  m.fact(credential, "verification-result", "未核验", "当场结果只记录实际凭证、身份与有效期核对，不生成诊断或调度结论。", ["injured-subscriber", "medic", "mateo"]);
  m.reference(credentialPayload, "registered-holder", "injured-subscriber", "凭证绑定伊娃本人，不能借给另一伤者变成对方合同。", ["injured-subscriber", "medic", "mateo"]);
  m.fact("injured-subscriber", "credential-check-consent", false, "伊娃尚未为本次现场凭证核对明确表示同意；她能自行决定出示。", ["injured-subscriber", "medic", "mateo"]);
  const reader = asset("medic", "medic-credential-reader", "马特奥的工作凭证核验器", "equipment", "mateo", "主管随身的有限业务工具，能读取当事人出示的凭证并核对签名与有效期；没有患者全库、远程治疗或派出机队的权限。", ["mateo", "lena"]);
  m.reference(reader, "owner", "trauma-team", "工作设备属于公司，马特奥只是本班授权使用人。", ["mateo", "medic", "lena"]);
  m.reference(reader, "authorized-user", "mateo", "只允许本人同意后的本次凭证核对，不因为持有核验器获得完整调度或医疗权限。", ["mateo", "medic", "lena"]);
  m.fact(reader, "verification-scope", "将本人实际出示的凭证、登记姓名和当前有效期与本机发行方签名校验核对；记录是否支持本人的合同资格。其他服务条件仍按具体评估办理。", "有限的常规业务功能，不是能查任何人身份的万能终端。", ["mateo", "medic", "lena"]);
  m.believe("mateo", reader, "work-tool", "我带着公司的凭证核验器。得到本人同意、看见实际凭证后才能核对资格；核验合格也没有替调度决定车辆或响应时间。");
  m.believe("injured-subscriber", credential, "held-credential", "我的个人凭证在身上，可以先听对方解释再决定是否拿出来；他们还没有完成今天现场的核对。");
  m.reference("medic-care-log", "record-subject", credential, "逐人记录实际同意和核验结果，不把伊娃的合同复制给另一名伤者。", ["medic", "lena", "mateo"]);
  m.reference("medic-care-log", "record-subject", reader, "核验步骤和实际救护处置分开记录。", ["medic", "lena", "mateo"]);
}
