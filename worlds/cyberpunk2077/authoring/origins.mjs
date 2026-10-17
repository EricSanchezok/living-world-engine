// These people, businesses, assets, prices, and opening events are original additions.
export function authorOrigins(m) {
  const role = (code, id, title, name, district, homeName, workName, cash, ratings, persona, purpose) => {
    const home = `${id}-home`, work = `${id}-work`;
    m.entity(home, homeName, "place", district, "有床铺、洗漱设施和可锁储物柜的长期住所。访客需要住户允许。");
    m.entity(work, workName, "place", district, "可通过街区道路到达的实际营业或工作场所；营业空间与私人住所分开。");
    m.person({ id, name: `${code} ${name}｜${title}`, place: work, description: `${name}是一名成年人，在${workName}处理自己的生活和事业。`,
      persona, voice: "按照自己的经历自然说话，能提问、拒绝或提出新的生活方向。", goal: purpose,
      value: "珍视自主决定生活的权利，同时认真对待已有的人际关系。", cash, ratings });
    m.fact(id, "playable-role", code, `${title}；玩家可接管这个已经在世界中生活的唯一人物。`);
    m.reference(home, "resident", id, "这位住户拥有稳定居住权，不等于拥有整栋楼。", [id]);
    m.believe(id, home, "residence", `我的住所是${homeName}，可以返回休息、接待客人或保管自己的物品。`);
    m.reference(home, "street-access", district, "住所与所在街区之间有正常出入口。");
    m.reference(work, "street-access", district, "工作场所通过街区道路与城市相连。");
    const entry = { code, id, title, home, work, cash, contacts: [], assets: [], contracts: [], opening: "", options: [] };
    m.origins.push(entry);
    return entry;
  };
  const contact = (r, id, name, description, purpose, relation, playerView, contactView, ratings = {}, place = r.work) => {
    m.person({ id, name, place, description, persona: `${description} ${contactView}`, voice: "交谈具体，解释自己的条件，有自己的判断。",
      goal: purpose, value: purpose, ratings });
    m.relationship(r.id, id, "established-contact", relation, playerView, contactView);
    r.contacts.push(id);
    return id;
  };
  const asset = (r, suffix, name, kind, description, owner = r.id, place = r.work) => {
    const id = `${r.id}-${suffix}`;
    m.entity(id, name, kind, place, description);
    if (owner) m.own(owner, id);
    m.believe(r.id, id, "familiar-equipment", description);
    r.assets.push(id);
    return id;
  };
  const shared = (r, suffix, name, kind, description, holders, capacity) => {
    const id = asset(r, suffix, name, kind, description, null);
    for (const actor of holders) {
      m.reference(id, "authorized-user", actor, "依约使用；不能据此出售或独占共同资产。", holders);
      m.believe(actor, id, "shared-use", `${description} 我有约定使用权，没有单独处分全部资产的权限。`);
    }
    if (capacity) m.get(id).shared_activity_resources = [{ definition_id: "workstation", capacity }];
    return id;
  };
  const offer = (r, suffix, name, people, terms, budget = 0) => {
    const id = `${r.id}-${suffix}`;
    m.contract(id, name, r.work, [r.id, ...people], terms, budget);
    r.contracts.push(id);
    return id;
  };
  const opening = (r, text, seconds, options) => {
    r.opening = text; r.options = options;
    m.fact(r.work, "current-scene", text, text);
    for (const actor of [r.id, ...r.contacts]) m.believe(actor, r.work, "opening-context", text);
    m.timers.push({ id: `${r.id}-appointment`, description: `${r.title}：约定时间到，请当事人根据实际进展再协商。`,
      due_at_seconds: seconds, wake_agent_ids: r.contacts, law_id: "appointments" });
  };

  const heir = role("O01", "heir", "继承了半栋楼的人", "诺亚·鲁伊斯", "glen", "榆荫楼顶层自住公寓", "榆荫楼一楼会客室", 18000,
    { persuasion: 4, insight: 3, streetwise: 3 }, "继承了榆荫楼的一半产权，与姨母共同经营。懂租户和账本，不因持有房产就擅长战斗。", "让旧楼带来可持续的生活，决定如何利用闲置空间。");
  contact(heir,"elena","埃琳娜·鲁伊斯","另一半产权的持有人，也是诺亚的姨母。","希望降低管理负担，倾向长期出租或出售。","双方各有榆荫楼 50% 产权，重大处分须共同同意。","尊重她的经验，但不愿仓促卖掉未来。","关心晚辈，也有自己的养老和资金安排。",{persuasion:4});
  contact(heir,"marco","马尔科·维达尔","楼内洗衣店店主，熟悉维修商与邻里。","续租并修好漏水管道，不希望租金突然翻倍。","已共同核对漏水问题；800 欧元只是待核报价，马尔科尚未垫付，诺亚没有因此欠下报销款。","他常帮忙，费用仍须有清楚凭据。","愿意协调工人，先谈妥付款方式再决定是否代付。",{craft:3});
  contact(heir,"inez","伊内兹·赵","长期租客，组织邻居的互助活动。","用空房建立社区诊疗合作点。","已经一起讨论过用闲置空间换取修缮支持。","相信她懂邻里需要，仍要审视预算。","认可新房东愿意听取意见，但不会无条件支持涨租。",{medicine:2,persuasion:3});
  const building = shared(heir,"building","榆荫楼产权及经营标的","property","包含六间出租公寓、洗衣店和一间闲置工作室的旧楼；资产不是随身物品。",["heir","elena"]);
  m.fact(building,"ownership-shares","heir=50%; elena=50%","现有产权份额，出售整楼或长期改变公共用途须双方同意。",["heir","elena"]);
  m.get(heir.home).placement = building; m.get(heir.work).placement = building; m.get(building).placement = "glen";
  const vacant = asset(heir,"vacant","榆荫楼闲置工作室","place","可改作办公室、诊疗合作点或排练间，现为空置。",null,building);
  m.reference(vacant,"property-part",building,"房间属于共同产权标的，租用和改造需按约协商。");
  const buildingFund = shared(heir,"fund","榆荫楼维修账户","account","专项维修资金，双方知情后可支付实际工程。",["heir","elena"]); m.quantity(buildingFund,"eurodollar",12000);
  const quote = asset(heir,"repair-quote","800 欧元管道维修报价单","document","桌上的维修报价文件，列出拟议工程范围；不是已付款发票。", "marco");
  m.fact(quote,"quoted-amount",800,"拟议总价为 800 欧元，尚待核对工人、范围与验收。",["heir","marco","elena","inez"]);
  m.fact(quote,"paid",false,"无人付款或垫付，现不存在本单报销债务。",["heir","marco","elena","inez"]);
  for(const actor of ["heir","marco","elena","inez"]) m.believe(actor,quote,"unpaid-quote","800 欧元是尚未核验、未付款且未垫付的管道维修报价，不能说成已经欠下的报销款。");
  offer(heir,"lease-offer","五年包租要约",["elena"],"外部运营方提出为期五年、每月 7000 欧元的包租，要求完整使用闲置房及到期合法调整租约。尚未签字、无预付款；可要求现有租客保护条款。报价期限是五年，7000 是月租金额，不是租期。");
  m.fact("heir-lease-offer","term-years",5,"当前要约的租期为五年，变更须实际提出并协商。",["heir","elena"]);
  offer(heir,"repair-offer","修缮与社区空间合作",["inez","marco","elena"],"社区合作方愿以每月 4200 欧元收入及分期修缮换取工作室使用；先核验报价、分工与验收，再签约。首笔维修可单独处理。");
  m.commitment("heir","已经承诺就重大改造听取共同产权人和租户意见。",["elena","marco","inez"]);
  opening(heir,"埃琳娜带来两份方案，马尔科把漏水照片与 800 欧元维修报价放在桌上，伊内兹等着解释社区合作的条款。大家尚未签字。",7200,["核对维修报价并报销","协商租客保护条款","走进闲置房评估其他用途"]);

  const lead = role("O02","lead","公司里仍有明天","艾登·沃克","corpo-plaza","Charter Hill 租用公寓","棱桥服务项目办公室",9000,
    {persuasion:4,craft:4,investigation:3},"原创承包商棱桥服务的项目负责人，有工作和采购权限。职位属于中型企业，不是荒坂或军用科技的高层。","处理演示系统缺陷，保住客户信任并发展团队。");
  m.get(lead.home).placement="charter-hill";
  contact(lead,"mina","米娜·沃斯","棱桥服务的项目主管。","确保演示可交付，接受有证据的范围调整。","主管与项目负责人，有互信但会检查支出。","希望她支持真实可行的计划。","欣赏能力，也须对客户和团队负责。",{persuasion:5});
  contact(lead,"pavel","帕维尔·陈","负责现场集成的资深技术员。","先复现授权缓存缺陷再上线。","合作完成过两次交付，技术判断互相尊重。","他的测试报告值得认真看。","愿意加班修复，但拒绝伪造验收。",{craft:6,netrunning:3});
  contact(lead,"ada","艾达·桑兹","设备供应商代表。","争取长期采购合同，以折扣换较稳定订单。","已有采购往来，没有私下回扣承诺。","可以谈价格，也要防止被长期条款套住。","认可客户专业，愿谈条件但不白送库存。",{persuasion:5});
  const terminal=asset(lead,"terminal","项目测试终端","terminal","仅连入棱桥内部测试网，不能直接控制客户正式系统。",null);
  m.reference(terminal,"authorized-user","lead","岗位授予测试访问权。",["lead","mina","pavel"]);
  const budget=shared(lead,"budget","棱桥项目采购账户","account","公司资金；艾登可在批准项目范围内采购，超过单笔 10000 欧元须米娜复核。",["lead","mina"]); m.quantity(budget,"eurodollar",48000);
  const report=asset(lead,"report","权限缓存测试报告","data-file","封装的测试记录，需要项目人员打开阅读。",null);
  m.fact(report,"test-findings","撤销的临时用户仍能在隔离测试节点重连一次；未证实影响生产系统。","这是可重复的本地缺陷，不是全球后门。",["lead","pavel","mina"]);
  for (const id of ["lead","pavel","mina"]) m.believe(id,report,"tested-failure","撤销后的临时凭证在测试节点仍能重连一次；要复现和修复或缩小演示范围。");
  offer(lead,"demo","客户试点交付草案",["mina","pavel"],"明日上午演示；可商议隔离试点或延期。未验收不能记为已收入，项目预算不等于个人存款。");
  offer(lead,"supply","采购折扣提案",["ada","mina"],"首批控制器报价 6000 欧元，折扣以六个月采购框架为前提；可拒绝框架按单采购或另找供应商。");
  opening(lead,"帕维尔在隔离终端重现权限缓存缺陷。米娜想知道演示还能保留多少内容；艾达带着两种采购条款等待答复。",14400,["请技术员复现并拟修复方案","谈隔离试点","比较采购与自修成本"]);

  const editor=role("O03","editor","午夜台剪辑师","罗文·余","kabuki","工作室楼上租房","午夜台超梦剪辑室",6500,
    {craft:5,investigation:4,performance:3},"擅长修复旧代超梦录制器音轨的独立剪辑师，认识自己的客户，不会从空白记录里凭空读出秘密。","完成作品并让授权与创作价值都经得起检查。");
  contact(editor,"sora","索拉·马利克","长期合作的声音工程师。","修复受损音轨并保留作品的声音层次。","按项目分成，彼此知晓设备限制。","愿意听他的技术判断。","不会把不确定的修复猜测说成真实记录。",{craft:5,performance:4});
  contact(editor,"celia","塞莉娅·莫拉","独立放映场地负责人。","按时举办放映且不引发授权争议。","过去四次合作正常结款。","希望保住长期客户。","重视可靠交付，也可以协商放映替代版。",{persuasion:4});
  contact(editor,"tomas","托马斯·魏","纪录片学生及此次项目的发起人。","保护受访者并完成第一部作品。","委托罗文剪辑，已交素材保管权而未转让全部版权。","想帮助他做出可靠的第一部作品。","在意受访者承诺，愿意重访补拍。",{investigation:3,performance:3});
  const deck=shared(editor,"deck","双轨超梦编辑台","equipment","可查看授权录制素材、标记损坏区间并重剪，不能查看未记录的过去。",["editor","sora"],1);
  m.own("editor",deck);
  const footage=asset(editor,"footage","街头纪录片原始素材盘","data-file","封存的超梦素材盘，须在编辑台载入并核对素材授权。",null);
  m.reference(footage,"copyright-holder","tomas","保管不等于取得发行全部内容的权限。",["editor","sora","tomas"]);
  m.fact(footage,"consent-limit","第 17 段含受访者明确要求删去的住址线索","该段真实存在；删除公开版本不应改写原始证据。",["editor","tomas","sora"]);
  offer(editor,"screening","周末放映与剪辑委托",["celia","tomas","sora"],"放映酬金 2400 欧元，成片须经授权确认；可剪去争议段落、改放片段或延期，不强制发表。");
  opening(editor,"编辑台停在第 17 段，托马斯带来受访者要求删除地址线索的消息。索拉认为可以重剪，塞莉娅需要知道今晚是否能拿到可放映版。",10800,["复核授权并标记争议片段","制作替代剪辑","与场地方协商延期"]);

  const apprentice=role("O04","apprentice","义体诊所的第二把钥匙","凯·陈","little-china","诊所值班室","雷耶斯独立义体诊所",4200,
    {medicine:4,craft:5,insight:3},"在原创医生林·雷耶斯门下做维修与临床辅助；会旧款手部接口检修，复杂植入与神经手术仍需导师。","修好常客的工作接口，逐渐扩大能独立承担的诊所业务。");
  contact(apprentice,"lin","林·雷耶斯医生","诊所负责人，今天稍后要外出会诊。","让凯在熟练范围内独立处理业务并留下记录。","长期师徒与雇佣关系；昂贵库存属于医生。","希望证明自己，也愿请教超出能力的手术。","认可凯的维护能力，不把复杂手术责任随便下放。",{medicine:7,craft:6});
  contact(apprentice,"bo","博·诺瓦克","有冷门零件渠道的供应商。","将仅有的兼容接口以清楚条件交货。","过去按真实零件编号采购，没有无限赊账。","愿意为准确适配付钱。","可以找货，但库存和运输都要成本。",{craft:4,streetwise:3});
  contact(apprentice,"ana","安娜·克鲁兹","依赖旧手部接口工作的配送员。","修好设备以便接班，也想保住有限积蓄。","长期复查常客，知道凯的熟练范围。","想帮她找到可靠而负担得起的方案。","信任维修经验，但要求先说明费用和功能限制。",{driving:4});
  shared(apprentice,"bench","诊所维护台","equipment","可做诊断、消毒和已培训的接口维护；不能自行替代复杂神经手术。",["apprentice","lin"],1);
  asset(apprentice,"tools","私人维护工具盒","equipment","绝缘探针、扭力工具和诊断线，适合基础维护。", "apprentice","apprentice");
  const spare=asset(apprentice,"spare","兼容手部接口备件","component","库存中仅有的一件旧款接口备件。", "lin");
  m.reference(spare,"clinical-use","apprentice","导师允许在有患者同意及维修记录的适应范围内使用。",["lin","apprentice"]);
  const hand=asset(apprentice,"patient-interface","安娜正在使用的损坏接口","cyberware","安装在安娜手部，时断时续；不能像背包物品一样直接取走。","ana","ana");
  m.fact(hand,"installed",true,"拆装须取得患者同意并完成医疗操作。");
  offer(apprentice,"service","安娜的接口维护单",["ana","lin","bo"],"先诊断和报价；可使用库存维修、向供应商订货或转诊。患者同意前不得扣费或拆除植入物。");
  opening(apprentice,"安娜把工作路线单放在台边，手指的接口接触不稳。林医生正准备外出，博说明仓库最快送货时间；现有兼容备件只有一个。",3600,["检查接口并取得维修同意","联系供应商核对编号","安排转诊或借用配送工具"]);

  const fleet=role("O05","fleet","有三辆卡车的车队接班人","米卡·梅萨","badlands","梅萨车队营地住房","梅萨车队装卸坪",8500,
    {driving:6,craft:4,persuasion:3},"原创流浪者小车队的经营接班人，掌握调度权而非单独拥有所有车辆；不是阿德卡多全族首领。","安排能维持团队收入的线路，并让三辆车都安全回营。");
  contact(fleet,"raul","劳尔·梅萨","姨父兼资深维修工，持有车队份额。","先修冷藏车冷却阀，再承担长途单。","共同持有和维护车队，重要出售须共同签字。","尊重他经验，也想开拓客户。","支持晚辈经营，但拒绝不顾维护拉车上路。",{craft:6,driving:4});
  contact(fleet,"jo","乔·瓦尔加","车队司机兼合伙人。","开拓新客户并确保分红公平。","长期搭档，拥有车辆使用和分成权。","愿意一起尝试新路线。","愿出力，要求明确工时和回款分配。",{driving:6});
  contact(fleet,"mei","梅·托雷斯","城内仓库的交接经理。","按预约接收货物，不让仓库无限等待。","已多次正常交货，信用有范围而非免检。","她能协调装卸窗口，仍须守约。","信任过去履约，但会核对货物和时间。",{persuasion:4,investigation:3});
  for(const [suffix,name,desc] of [["flatbed","一号平板卡车","状态良好，适运大型设备；货台容量八个标准货箱。"],["boxtruck","二号厢式卡车","普通货运车辆，货厢容量六个标准货箱。"],["reefer","三号冷藏卡车","冷却阀待修，修复前不能保证低温货物；容量四箱。"]]) {
    const truck=shared(fleet,suffix,name,"vehicle",desc,["fleet","raul","jo"]);
    m.fact(truck,"ownership-shares","fleet=40%; raul=35%; jo=25%","车辆共有，米卡有正常业务调度权，出售或抵押须三方同意。",["fleet","raul","jo"]);
    m.quantity(truck,"fuel",40);
    m.get(truck).shared_activity_resources=[{definition_id:"vehicle-driver",capacity:1}];
  }
  const reserve=shared(fleet,"reserve","车队共同储备账户","account","支付燃料、维修及约定分红，不能作为私人无条件提款。",["fleet","raul","jo"]);m.quantity(reserve,"eurodollar",16000);
  const cargo=asset(fleet,"cargo","已装箱的水处理设备","cargo","四个可逐件清点的标准箱，社区委托人所有，车队仅负责保管与交付。",null);
  m.quantity(cargo,"cargo-unit",4);
  offer(fleet,"regular-order","长期客户普通货运单",["mei","jo","raul"],"拟运普通工业货六箱，需平板车与厢式车配合，报酬 5200 欧元；仍可调整装车日或委托其他承运人。");
  offer(fleet,"community-order","社区水处理设备委托",["mei","jo","raul"],"四箱水处理设备拟用平板车运输，报酬 2800 欧元，需与普通订单协调同一车辆；可拼货或分期交付，未发运不算完成。");
  opening(fleet,"两份订单摊在三辆卡车之间的折叠桌上。劳尔指出冷藏车阀门待修，乔提出拼货，梅来确认下一次仓库接货窗口。",7200,["检查三车并安排维修","同客户协商拼货与日期","联系其他车队转包"]);

  const medic=role("O06","medic","创伤小组的休假救护员","萨姆·奥尔特加","wellsprings","运动场旁公寓","贝尔社区运动场",11000,
    {medicine:6,insight:5,combat:2},"创伤小组的普通救护员工，正在休假；有专业急救经验，但不掌握公司 AV、患者全库或跨岗位指挥权。","处理眼前社区事故，同时守住专业能力与职责边界。");
  contact(medic,"lena","莉娜·朴","同班搭档，休假时来参加社区活动。","帮助稳定伤者并提供准确交接。","曾共同完成救护任务，知道彼此操作习惯。","相信搭档的判断。","可以合作施救，不承诺调用公司机队。",{medicine:6});
  contact(medic,"idris","伊德里斯·贝尔","邻居兼运动场经营者。","先照顾伤者并找出器材为何脱落。","邻里熟人，萨姆常在这里活动。","愿意帮忙，也会问清事故情况。","愿承担合理费用，需要救护员具体指导。",{persuasion:3});
  contact(medic,"mateo","马特奥·席尔瓦","值班主管，前来参加社区活动的交接会。","核对服务资格并安排符合条件的正式响应。","工作上的直接主管关系。","可询问流程，不能直接命令他派所有资源。","关心同事与服务责任，必须确认信息。",{medicine:5,insight:5});
  m.reference("medic","employer","trauma-team","普通雇佣关系，当前休假。");
  const kit=asset(medic,"kit","私人急救包","equipment","个人购买的基础急救用品，无公司军械或无限药品。","medic","medic");m.quantity(kit,"medical-supply",8);
  for(const [id,name,covered] of [["injured-subscriber","伊娃·洛","待核验的个人服务凭证"],["injured-neighbor","丹·鲁伊斯","本人表示没有相应服务合同"]]) {
    m.person({id,name,place:medic.work,description:"社区活动中被掉落支架擦伤的成年人，清醒且能说话。",persona:"希望得到帮助、听懂方案并决定自己的治疗。",voice:"按实际感受描述症状。",goal:"接受适当帮助并通知家人。",value:"身体安全和自主同意。",cash:600,ratings:{insight:2}});
    m.get(id).meters[0].current=22;
    m.fact(id,"service-evidence",covered,covered,[id,"medic","mateo"]);
    m.believe("medic",id,"observed-injury","眼前擦伤者清醒，可以询问症状与同意；服务资格需由凭证核对。");
  }
  offer(medic,"handover","社区事故救护记录",["lena","idris","mateo"],"记录已观察伤情、本人同意和支出。正式公司服务须核实合同与调度条件；普通现场急救、联系其他机构和邻里互助另行决定。");
  opening(medic,"场边支架落下后，两位清醒的伤者坐在长椅上。莉娜正在安抚，伊德里斯关掉电源，马特奥请求先核对一人的服务凭证。私人急救包就在萨姆身边。",1800,["取得同意后检查两人伤情","分工提供基础急救","核对凭证并协调其他救助"]);

  const armorer=role("O07","armorer","退下来的军械管理员","阿什·奥尔蒂斯","rancho-coronado","维修店后屋","奥尔蒂斯装备维修店",5200,
    {craft:6,combat:4,streetwise:4},"曾替六街帮一个原创小队维护装备，已经按双方协议退出。熟悉维修标记，不愿被旧关系决定全部人生。","经营维修业务并教会学徒独立谋生。");
  contact(armorer,"grant","格兰特·黑尔","六街帮某小队的旧队友。","把带来的装备恢复可用，避免公开丢面子。","退出协议允许阿什经营普通维修，不得强迫重新参战；双方仍可自愿接单。","愿听旧友来意，但有权拒绝。","尊重技术，仍希望朋友照顾报价。",{combat:4,streetwise:4});
  contact(armorer,"rosa","罗莎·金","楼下杂货店店主兼转介客户的邻居。","维持安全生意，避免争议赃物招来麻烦。","彼此转介客户，不收保护费。","她对客户来路的提醒有价值。","支持维修店独立经营，不愿卷入暴力冲突。",{persuasion:4});
  contact(armorer,"leo","利奥·奥尔蒂斯","已成年的维修学徒。","学会技能并查清可疑器材的原始归属。","雇佣与师徒关系，不是仅因同姓确定的亲属。","愿意教他，也应听他的发现。","尊重师傅，但不会把担心都藏起来。",{craft:3,investigation:3});
  m.reference("grant","affiliation","sixth-street","这名原创小队成员属于六街帮。");
  shared(armorer,"bench","私人维修台","equipment","有拆检工具与测量装置，需要实际零件和时间完成翻修。",["armorer","leo"],1);
  asset(armorer,"pistol","私人保养过的动能手枪","weapon","普通动能手枪，弹药有限，不具备传奇装备特效。","armorer","armorer");m.quantity("armorer","ammunition",24);
  const crate=asset(armorer,"crate","格兰特带来的待检装备箱","cargo","三件可维修的护具与部件，外侧还能看到原有流转编号。","grant");
  m.fact(crate,"provenance-mark","旧编号与社区保安队登记格式相符，但单凭格式尚不能认定盗窃。","利奥发现的线索可进一步核验。",["armorer","leo","grant"]);
  m.commitment("grant","退出协议仍有效，阿什拒绝此单不构成重新加入小队。",["armorer"]);
  offer(armorer,"repair","待检器材翻修报价",["grant","leo"],"建议先核验编号与所有权，再报价；可以只出检测报告、退货、协商归还或正常维修。");
  opening(armorer,"格兰特把装备箱放上维修台，提出朋友价。利奥指给师傅看尚未磨掉的流转编号，罗莎询问是否需要联系社区保安队查账。",5400,["核对标记与登记","明确退出协议再谈价","拒接并帮忙查找真正物主"]);

  const partner=role("O08","partner","停工厂的技术合伙人","朱尔斯·钱","arroyo","厂区旁合租公寓","再启工坊生产线",7200,
    {craft:6,netrunning:3,persuasion:3},"与工人合伙承租停运生产线的技术负责人，懂旧控制系统；设备租赁权和个人产权有清楚区别。","在安全范围内恢复生产，让团队有可持续收入。");
  contact(partner,"marta","玛尔塔·钱","代表工人利益的工长。","按时发工资且不把伤害风险转给工人。","共同管理工坊，股份和职责分列；同姓不代表亲属。","相信她懂现场情况。","支持技术改良，要求真实试验和工资保障。",{craft:5,persuasion:4});
  contact(partner,"owen","欧文·布莱克","客户聘用的交付审计员。","核验试产条件，不接受假验收。","项目业务关系，可以接受合理由证据支持的交付调整。","需要他说明真正验收标准。","对能力有初步认可，仍须记录检验。",{investigation:6});
  contact(partner,"nela","妮拉·奥尔蒂斯","独立维修承包商。","按合同修复传感与联锁，取得合理报酬。","已有图纸交流，还没有免费维修约定。","专业互补，可谈分期付款。","愿合作，不能无限垫工时和材料。",{craft:6});
  const line=shared(partner,"line","承租的旧工业生产线","equipment","租期十二个月，能生产普通壳体与连接件；租赁方保留所有权，合伙人有约定使用权。",["partner","marta"],1);
  m.fact(line,"test-result","低负荷试产合格；提高送料速度时传感器反馈不稳定，需检查而不能绕过联锁。","可通过诊断、降速或更换组件处理的现实缺陷。",["partner","marta","owen","nela"]);
  const wages=shared(partner,"wages","工坊工资及维护账户","account","优先用于合同工资与已议定维护；大额用途需合伙人协商。",["partner","marta"]);m.quantity(wages,"eurodollar",24000);
  const materials=asset(partner,"stock","工坊合法采购的材料","stock","可加工的普通工业材料，完成产品会消耗库存。",null);m.quantity(materials,"components",36);
  offer(partner,"trial","小批量试产采购意向",["owen","marta"],"客户提出验收后按批付款，可协商降低首批产量；意向不等于订单已经付清，也不能直接增加现金。");
  offer(partner,"maintenance","联锁维修提案",["nela","marta"],"检查及更换传感组件初估 3800 欧元，需诊断确认；允许由本厂自修、延后或拆分范围。");
  opening(partner,"第一批壳体摆在工作台上，低负荷记录合格而高速曲线异常。玛尔塔拿来工资表，欧文等着讨论验收范围，妮拉提出先看联锁日志。",10800,["复查日志并低速复测","谈小批量交付","预算维修与工资的先后"]);

  const broker=role("O09","broker","狗镇的双边运输经纪","卢卡·萨迪克","dogtown","市场后街出租间","萨迪克租用仓位",13000,
    {persuasion:5,streetwise:5,investigation:4},"靠小规模贸易守约记录生活的经纪人，熟悉具体文员和商户；没有永久免检权，也不是汉森的私人代表。","查清货单型号差异，保护两边的交易信用。");
  contact(broker,"vera","维拉·萨迪克","市场设备商户。","拿到适配设备，同时保证自己顾客的权益。","有持续贸易记录；同姓不预设亲属。","要维护长期信任。","接受协商，不接受拿不兼容高价货强行抵数。",{persuasion:4,craft:3});
  contact(broker,"emil","埃米尔·科斯塔","关口货运文员，今日来核对货单。","按自己的职责核验批次和通行文件。","曾办过三次正常货运手续，不存在无限通融承诺。","能问流程，不能替他决定批准。","认可往来记录，仍需核对新批次。",{investigation:4});
  contact(broker,"jun","俊·梅尔卡多","城内设备采购商。","核对订单型号，并对多出的性能讨论差价。","既有买卖关系，不是无条件政治同盟。","可以交换信息，不能两边重复卖同一货。","愿为合用设备付钱，也有取消不符订单的权利。",{persuasion:4,craft:3});
  const van=shared(broker,"van","按日租赁的运输厢车","vehicle","租赁车辆，准许普通货运，不能转卖；燃油与检查照常发生。",["broker"]);m.quantity(van,"fuel",25);
  const permit=asset(broker,"permit","本批普通设备货运许可","document","仅对应本车、本批普通工业设备及当次核验，无永久免检或军用物资豁免。");
  m.fact(permit,"scope","本次四箱 A2 工业控制器，关口仍有权复核实际货物。","许可不能用于不同型号而不申报更新。");
  const batch=asset(broker,"batch","实际到仓的四箱 A3 控制器","cargo","包装标签为 A3，货单写 A2；升级型号是否适配需询问买家。",null);m.quantity(batch,"cargo-unit",4);
  offer(broker,"delivery","A2 设备交付订单待变更单",["vera","jun","emil"],"货单标 A2，实际为 A3；未验收和过关。可退运、变更型号、安排检测或重新撮合，货物不能同时交给两名买家。");
  opening(broker,"维拉拆开一箱看见 A3 标签，俊指着写 A2 的货单询问适配问题。埃米尔说明需要先更新这一批的文件；厢车停在仓位旁。",7200,["核对型号与兼容性","协商改合同并更新许可","退运或寻找合适买家"]);

  const manager=role("O10","manager","乐队走红前的经纪人","达尼·沃斯","japantown","排练室上层小公寓","折光乐队排练室",4800,
    {performance:5,persuasion:5,streetwise:3},"原创乐队折光的经纪人，有小圈子信誉和真实演出机会，未与克里或 SAMURAI 建立虚构亲属关系。","同成员商议第一份大演出合同，兼顾收入与作品控制。");
  contact(manager,"rin","林恩·瓦尔德兹","折光乐队的主唱及词曲作者。","保留作品表达，不接受未经同意删歌。","伙伴与代理关系，歌曲版权属于作者。","想让作品被更多人听到。","相信经纪能力，但作品取舍要一起决定。",{performance:6});
  contact(manager,"bex","贝克斯·马利克","乐队鼓手，负责部分器材维护。","获得稳定收入并还清个人设备分期。","演出按约分成，个人债务不自动转移给乐队。","理解他需要实际收入。","愿谈商业合作，不愿永远只靠热情付房租。",{performance:5,craft:3});
  contact(manager,"paulo","保罗·里德","市中心场地经理，与所罗门·李德无亲属关系。","获得可靠节目与清楚赞助安排。","以往在小场合作成功，愿提供较好时段。","有谈判基础，但不该保证成员尚未同意的事。","认可合作记录，也须向场地方说明条款。",{persuasion:5});
  const gear=shared(manager,"gear","折光乐队演出器材","equipment","音箱、电子鼓组及舞台接口共同使用；个人乐器版权和产权另计。",["manager","rin","bex"]);
  const fund=shared(manager,"fund","折光乐队共同账户","account","演出收入先记公账，按成员约定支付场租与分成，不能全算经纪人收入。",["manager","rin","bex"]);m.quantity(fund,"eurodollar",6800);
  const song=asset(manager,"song","未发行歌曲工作母带","data-file","存有可供排练和商议的作品；传播授权需作者明确同意。","rin",gear);
  m.believe("manager",song,"licensed-use","林恩允许我拿这份工作母带与场地讨论演出，不等于同意删歌或商业买断。");
  offer(manager,"sponsored","赞助演出草案",["rin","bex","paulo"],"报价 9000 欧元，要求替换一首歌并增加品牌露出；未接受，可谈只加露出或拒绝删歌。");
  offer(manager,"independent","独立小场演出选项",["rin","bex","paulo"],"报价 3600 欧元，无删歌条件，场地较小；须商议档期和器材，不能与同一时段另一演出同时完成。");
  opening(manager,"排练暂停，保罗带来大场赞助条件。林恩圈出删歌条款，贝克斯计算器材与房租，小场演出仍留着可协商的日期。",14400,["询问成员底线并修改合同","组织独立演出","用两种预算比较现金流"]);

  const reporter=role("O11","reporter","有署名权的调查记者","伦·桑托斯","downtown","编辑部附近出租公寓","街区镜报编辑部",6000,
    {investigation:6,insight:5,persuasion:4},"原创地方媒体街区镜报的调查记者，有编辑支持和署名权；不是能读取全城私人系统的全知叙事者。","核对一宗工厂事故材料，决定如何负责任地发表。");
  contact(reporter,"leila","莱拉·桑托斯","编辑部负责调查稿的编辑。","发表能被核对的事实，必要时允许延期。","同事关系，姓氏相同不构成已知亲属。","想争取报道资源。","看重记者判断，仍要求把证据和猜测区分。",{investigation:6,persuasion:4});
  contact(reporter,"felix","费利克斯·吴","提供维修记录的工人消息源。","纠正事故说法，同时避免身份被无谓公开。","有保密约定的消息源关系。","需要保护他，也不能只信单方口述。","愿提供记录，要求先协商能公开的范围。",{craft:4,investigation:3});
  contact(reporter,"amara","阿玛拉·科尔","摄影记者与长期采访搭档。","补全现场证据并取得合适的采访同意。","联合署名合作，费用按项目列支。","她能发现被忽略的现场细节。","认可调查价值，也会反对无证据地指名定罪。",{investigation:5,performance:3});
  asset(reporter,"recorder","个人采访记录设备","equipment","可录制同意范围内的新采访，存储内容有实际来源。","reporter","reporter");
  const evidence=asset(reporter,"evidence","事故调查材料封存盘","data-file","记录包包含日志副本与两份相互有差异的证言，需逐份检查。",null);
  m.fact(evidence,"verified-content","检修日志显示 09:42 断电，证言甲称先听到警报，证言乙称警报在断电后；日志不能单独确定谁应负责。","原始材料的具体内容，不能把冲突证言自动合成为确定阴谋。",["reporter","leila","felix","amara"]);
  const expenses=shared(reporter,"expenses","报道采访经费","account","仅用于交通、材料核验与采访成本，不购买强制证词。",["reporter","leila"]);m.quantity(expenses,"eurodollar",5000);
  offer(reporter,"publication","事故调查稿编辑约定",["leila","felix","amara"],"事实核验后决定公开范围；可以先发确认部分、延后、寻求另一证人或不发表。消息源姓名须遵守约定。");
  m.commitment("reporter","未经费利克斯同意，不将他的身份与未公开原始材料对外发布。",["felix",evidence]);
  opening(reporter,"莱拉在编辑桌上标出两段矛盾证言。费利克斯带来一份维修日志副本，阿玛拉建议回现场核实；截稿将近，仍可以修改报道范围。",10800,["对照日志与两份证言","补访独立证人","先发表已确认部分或延期"]);

  const operator=role("O12","operator","退役试验义体操作员","埃利·索尔","northside","旧工业区独立公寓","索尔接口维护间",8000,
    {craft:6,netrunning:4,insight:4},"已结束试验项目的成年操作员，按协议保留了一套旧工业有线接口；兼容少数设备，不连接黑墙、不控制任意人脑。","诊断社区旧水泵系统，决定是否把旧技术做成长期工作。");
  contact(operator,"niko","尼科·陈博士","旧项目工程师，能够维护这一代接口。","维持设备可靠性并弄清本次故障。","共同参加过正式试验；项目结束后保持维修联系。","相信技术经验，仍要核对测试边界。","愿帮忙，无法凭空提供已停产的全部零件。",{craft:7,medicine:4});
  contact(operator,"mara","玛拉·索尔","前项目同事，掌握一部分试验日志。","让保留设备的权利受到尊重，避免再承担无边界试验。","共同试验经历；同姓不预设亲属。","可以互相校对记忆与记录。","希望伙伴先说清条件再接新工作。",{investigation:4,netrunning:4});
  contact(operator,"tessa","泰莎·瓦尔加","寻找旧工业零件的回收商。","按真实兼容型号供货，收取合理价款。","有正常零件交易记录，无万能库存。","可查型号并比较替代方案。","愿提供手头两块板，但需要付款或等价交换。",{craft:4,streetwise:4});
  const implant=asset(operator,"interface","已安装的旧型工业有线接口","cyberware","安装在左前臂，需物理接线、正确工业协议与目标权限；不能远程接管任意系统。","operator","operator");
  m.fact(implant,"installed",true,"有完整保留设备协议；摘除需医疗操作，不是随意挪动背包物品。");
  const manual=asset(operator,"manual","旧接口手册与保留协议","document","记载 L-4 工业协议、维护步骤与设备归属，未记载所有厂商系统。");
  m.believe("operator",manual,"training","我受过 L-4 有线诊断训练，可以在目标授权后读取兼容控制器日志，写入参数须进一步核验。");
  const pump=asset(operator,"pump","社区送修的旧水泵控制柜","equipment","使用 L-4 有线协议，冷启动时状态不稳；属于社区，当前仅授权诊断，不授权出售。",null);
  m.fact(pump,"diagnostic-permission","operator may inspect; no disposal or unrestricted writes","社区交来的书面委托只允许检测与报价。",["operator","niko","mara","tessa"]);
  m.fact(pump,"fault","备用供电板接点间歇失效，软件日志存在重启记录。","这是预先存在的故障；诊断揭示它，不根据玩家猜测临时改写。","private");
  const oldBoards=asset(operator,"spares","泰莎的旧型供电板库存","stock","两块待检测供电板；需核对兼容与状态。","tessa");m.quantity(oldBoards,"components",2);
  offer(operator,"repair","社区旧水泵诊断委托",["niko","mara","tessa"],"诊断费拟定 600 欧元，修复另报价；可以有偿维修、教别人维护、推荐替换或拒接，无预定成功结果。");
  opening(operator,"送修的水泵控制柜又闪了一次复位灯。尼科拿出接线图，玛拉翻找旧日志，泰莎带着两块待检测的供电板等待报价。",7200,["按授权用接口读取日志","检测备板与电源接点","商议修复、培训或替换方案"]);

  // First-scene work changes existing state, without requiring free scene creation.
  const mutableStates = [
    ["lead-terminal","revocation-effective",false,"测试节点尚不能可靠撤销缓存凭证；完成修复并验证后才成立。",["lead","mina","pavel"]],
    ["apprentice-patient-interface","operational",false,"安娜的手部接口当前接触不稳，实际检修通过后才能恢复可靠使用。",["apprentice","ana","lin"]],
    ["fleet-reefer","cold-chain-ready",false,"冷却阀待修，尚不能承担需要低温保证的货物。",["fleet","raul","jo"]],
    ["partner-line","safe-full-rate",false,"高速送料的联锁与传感反馈尚未通过验证，低负荷试产记录不等于全速合格。",["partner","marta","owen","nela"]],
    ["broker-batch","buyer-acceptance",false,"买家尚未接受 A3 型号代替 A2；需真实协商与检验。",["broker","vera","jun","emil"]],
    ["armorer-crate","provenance-checked",false,"维修方尚未独立核对现有所有权与历史流转；疑问不等于已证实盗窃。",["armorer","grant","leo"]],
    ["reporter-evidence","timeline-crosschecked",false,"冲突证言尚未完成独立交叉核验，不能直接当成已经确定的事故责任链。",["reporter","leila","amara","felix"]],
    ["operator-pump","operational",false,"水泵控制柜存在间歇供电故障，查到日志不等于已修复；修复后须实际测试。",["operator","niko","mara","tessa"]],
  ];
  for(const args of mutableStates) m.fact(...args);
  const cut=asset(editor,"cut","待审核的放映剪辑版","data-file","与原始素材分开的工作剪辑，可以修改公开版本并保留原始资料。", "editor");
  m.reference(cut,"derived-from","editor-footage","由已保管素材制作的工作版，原始素材不会随剪辑自动改变。",["editor","sora","tomas"]);
  m.fact(cut,"contains-address-clue",true,"当前工作版仍包含第 17 段地址线索；重剪可以去除，但不得声称原始录制从未存在。",["editor","sora","tomas"]);
  m.fact(cut,"cleared-for-screening",false,"目前尚未得到最终放映授权，须真实核对授权范围。",["editor","sora","tomas","celia"]);
  for(const actor of ["sora","tomas","celia"]) m.know(actor,cut,"这是供本次放映审阅的工作剪辑，尚未获得最终放映授权。");
}
