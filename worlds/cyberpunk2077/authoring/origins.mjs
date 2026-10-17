// These people, businesses, assets, prices, and opening events are original additions.
export function authorOrigins(m) {
  const contactLife = {
    elena: ["熟悉的事直截了当，谈到姐姐留下的楼会停一下；不拿长辈身份压过具体意见。", "希望把每月跑维修的时间腾出来，去看住在别区的老朋友。"],
    marco: ["会拿店里遇到的小事打比方，先讲哪台机器停了、哪位客人要来，再谈账。", "想让洗衣店的夜班早一点结束，周末能陪女儿吃晚饭。"],
    inez: ["热情，记得邻居的名字，也愿听别人说一个方案哪里行不通。", "想把长期借别人厨房的邻里互助活动搬到稳定的地方。"],
    mina: ["简短而镇定，先问最需要她拍板的一件事；轻松时会笑自己的排期。", "想让团队靠一份可靠项目拿到下一季的稳定工作。"],
    pavel: ["讲故障时习惯画示意图，平时有点干冷的幽默，不把同事当审计对象。", "想交出一套别人也能维护的系统，摆脱每晚被临时叫回来的日子。"],
    ada: ["爽快，喜欢当面展示实物；能讨价还价，也知道什么时候停止推销。", "想把小批量生意做成能准时给仓库工人结账的长期客户。"],
    sora: ["听声音会闭眼，谈技术用具体听感；朋友紧张时会开一个轻巧的玩笑。", "想让这部片的街声听起来仍像真实街道，而不是一段广告。"],
    celia: ["脑中总带着场次表，说话利落但对新作品有耐心。", "想留住愿意看本地创作者作品的观众，让小放映场活下去。"],
    tomas: ["兴奋时话快，提到受访者会放慢；会承认自己第一次做项目的疏漏。", "想邀请受访者来看第一部作品，而不是让他们后悔答应拍摄。"],
    lin: ["语气温和，示范时说清手上的动作；不会用一串训诫替代诊断。", "希望凯能独立看店，自己才有时间走访长期出不了门的病人。"],
    bo: ["随身记着难找的型号，爱讲一件零件辗转了多少仓库。", "想建立一份靠谱的旧接口库存目录，少让客户白跑。"],
    ana: ["直说手上哪里不舒服，也会问今天还能不能赶上班；不是只会点头的患者。", "想保住这周的配送排班，攒钱换一双不漏水的骑行靴。"],
    raul: ["慢条斯理，喜欢让人摸摸管线再解释；对车有感情，对晚辈也有耐心。", "想把维修经验教给下一班人，自己偶尔能坐副驾驶看看风景。"],
    jo: ["想到新路线会兴奋，说话带一点挑战意味，算工时却很细。", "想跑一条能留出固定休息日的新线路。"],
    mei: ["记得司机的习惯，给建议时会说清哪个卸货口、哪个班组能帮忙。", "想让仓库的晚班按点下班，不再靠最后一刻催货过日子。"],
    lena: ["在伤者面前温柔，和搭档说话有多年磨出的默契；先回应眼前的人。", "希望今天有人照顾伤者，也有人记得给紧张的家属打个电话。"],
    idris: ["着急时说得碎，会主动去找毛巾和水，听到明确安排就去做。", "想把运动场重新变成邻居愿意放心带家人来的地方。"],
    mateo: ["说话低而稳，面对同事可以坦白自己正在等哪项信息。", "希望休假同事能平安回家，也不让需要接手的急救队扑空。"],
    grant: ["熟人面前会开旧玩笑，被问到难堪处会防御，仍能就实际问题谈下去。", "想让自己小队的装备撑过本月，也不愿彻底失去这个老朋友。"],
    rosa: ["消息灵通但不把听说当证据，提醒完风险还会问对方午饭吃了没。", "想让楼下店铺继续互相照应，晚上关门时不用提心吊胆。"],
    leo: ["好奇，问得细，得到一次真实示范比听漂亮话更有精神。", "想做出一件能署自己名字的维修成品，慢慢接独立的活。"],
    marta: ["会叫出每个班组成员的名字，语气实在，谈好条件后愿一起动手。", "想让大家把租下来的旧线变成能靠手艺吃饭的工坊。"],
    owen: ["问得具体，看到好工作也会直接认可，不把谨慎演成冷漠。", "想给客户找一家不用靠层层转包就能认真把活做完的供应商。"],
    nela: ["看机器时话少，发现问题就用手边的图纸说明，也乐于交换维修窍门。", "想凑齐自己的移动工具车，少靠借用别人的工位接活。"],
    vera: ["会把设备实际要装在哪里讲清楚，熟客面前有市集式的俏皮。", "想让几个等货的小店都能开门营业，保住彼此的信用。"],
    emil: ["说流程不摆官腔，能指出下一步该补哪一格，忙起来则明显不耐烦。", "希望这班结束前把积压的几张货单弄清楚。"],
    jun: ["谈技术会拿具体用途举例，愿为实用性能高兴，但不喜欢被当冤大头。", "想给一间小作坊换掉总是误报的控制器，让工人少停几次线。"],
    rin: ["对旋律很敏感，讲歌时有画面，争论之后仍会问同伴怎么想。", "想在台下有人跟唱时，唱的还是大家一起写出的那首歌。"],
    bex: ["节奏感强，常用敲桌沿表达兴奋或焦急；谈钱直接但不刻薄。", "想按时还设备分期，也想乐队别永远只在排练室里演。"],
    paulo: ["熟悉后台琐事，愿讲自己的场地难题，谈到好现场会突然热络。", "想把新乐队带进一个真正有观众的好时段，而不是只填排期空格。"],
    leila: ["会先听记者发现了什么，再逐处追问；认可时很明确，不只负责否定。", "想让一份小报也能做出街坊愿意留下来读完的报道。"],
    felix: ["工作细节说得流畅，被问私人身份会迟疑；得到尊重后会多讲一点。", "想让同行别再重复同样的事故，也希望家人的生活不被围观。"],
    amara: ["观察光线、声音和人的动作，能把抽象争论拉回现场一个细节。", "想拍到当事人认可的照片，不只是一张可传播的苦难画面。"],
    niko: ["乐于一起排查，偶尔自嘲旧设计；先问接口实际读到了什么。", "想把旧项目仍能帮助人的部分整理成别人也能理解的维护手册。"],
    mara: ["熟人间有克制的幽默，涉及过去会分清记得的、忘了的和不愿谈的。", "想让旧同事有权决定技术接下来怎么用，也给自己的生活留点空白。"],
    tessa: ["喜欢介绍零件的来路，讲价时不羞涩，看见合适的旧物会高兴。", "想把回收来的旧设备变成可靠货源，而不是一堆没人敢用的废料。"],
  };
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
    const [voice, life] = contactLife[id];
    m.person({ id, name, place, description, persona: `${description} ${contactView} ${life}`, voice,
      goal: purpose, value: purpose, ratings });
    m.get(id).agent.character.goals.push({ id: "life-beyond-work", description: life, priority: 0.35,
      progress: 0, target_ids: [], motivated_by_ids: ["priority"] });
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
  const workRecord = (r, suffix, name, readers, sources, purpose, owner = r.id) => {
    const audience = [...new Set([r.id, ...readers])];
    const personOwner = m.get(owner).agent ? owner : null;
    const id = asset(r, suffix, name, "data-file", "已有的本地工作记录文件；需要打开才能读取内容，可以在授权范围内续写。", personOwner);
    if (!personOwner) m.reference(id, "owner", owner, "本记录属于实际委托主体；岗位作者可据实填写，不能把机构资料当私人财产处置。", audience);
    m.fact(id, "entries", "空白：尚未记录本次工作的观察、操作或结果。", "本次工作记录的正文；只能由实际观察和已发生的操作形成。", audience);
    m.fact(id, "record-state", "blank", "空白、草稿或已复核依实际填写与复核改变；文档存在不代表工作完成。", audience);
    m.fact(id, "record-purpose", purpose, purpose, audience);
    m.reference(id, "authorized-writer", r.id, "本人可以据实填写，修改记录不改变原始材料或独立验收结果。", audience);
    for (const source of sources) m.reference(id, "record-subject", source, "这份记录对应的实物、原始文件或工作对象。", audience);
    for (const actor of audience) m.believe(actor, id, "work-record", `这是可供本次工作使用的${name}，现在尚未填写。${purpose}`);
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
  const utilityRoom=asset(heir,"utility-room","榆荫楼公共管线间","place","一楼会客室沿楼内走廊可到的检修间。共有人和受委托维修者可进入；狭窄走道有接水盘，不能在会客室隔空修管。",null,building);
  m.reference(utilityRoom,"property-part",building,"公共管线间随共同产权经营，不是可单独出售的私人储物室。");
  m.reference(heir.work,"interior-access",utilityRoom,"会客室门外走廊通往这间实际检修空间。",["heir","elena","marco","inez"]);
  const leakingPipe=shared(heir,"service-pipe","漏水的公共冷水管活接","equipment","公共冷水立管上的活接，底部接水盘可见持续水滴；检修需先靠近、确认水路和实际隔离。",["heir","elena","marco"],1);
  m.get(leakingPipe).placement=utilityRoom;
  m.fact(leakingPipe,"installed",true,"固定于楼内管线，不能当随身物品带走。");
  m.fact(leakingPipe,"leaking",true,"活接仍在滴水；必须实际处理漏点并复压检查才可认定止漏。",["heir","elena","marco","inez"]);
  m.fact(leakingPipe,"supply-isolated",false,"当前仍有供水；实际检修前须辨认阀门并隔离这段水路。",["heir","elena","marco"]);
  m.fact(leakingPipe,"pressure-tested",false,"尚未完成本次维修后的复压检查，暂时关水不代表修好。",["heir","elena","marco","inez"]);
  const installedSeal=m.entity("heir-pipe-seal","活接内部的现用密封垫","component",leakingPipe,"安装在活接内部的密封件，须隔离水路并打开检修位置才能检查表面。").id;
  m.reference(leakingPipe,"internal-component",installedSeal,"正常结构包含这枚密封件，知道结构不等于知道内部现状。",["heir","elena","marco"]);
  m.fact(installedSeal,"fault","活接内部的兼容密封垫老化，现有管体和隔离阀没有破裂。","需现场检查并在隔离水路后检查密封面才可确认，漏水照片本身不能证明故障原因。",["heir","elena","marco"]);
  m.fact(leakingPipe,"maintenance-permission","共有人已允许现场检查、隔离止漏及使用现有兼容密封垫做基础维护；改造管路和追加付费工程须另行协商。","这是既有的小额维护权限，不是工程已付款或已完成。",["heir","elena","marco"]);
  const plumbingTools=shared(heir,"plumbing-tools","榆荫楼管线检修工具","equipment","活动扳手、绝缘照明灯、接水盘和水压表，能支持这段冷水管的现场检查及基础维护。",["heir","elena","marco"]);
  m.get(plumbingTools).placement=utilityRoom;
  const seals=shared(heir,"seal-stock","榆荫楼兼容密封垫小盒","stock","两枚与该冷水管活接规格相容的常备密封垫，归共同维修物资；更换一枚须实际消耗一单位登记组件。",["heir","elena","marco"]);
  m.get(seals).placement=utilityRoom;
  for(const actor of ["heir","elena","marco","inez"]) m.believe(actor,leakingPipe,"known-leak","公共管线间里的冷水管活接正在滴水；可以去现场确认漏点，照片还不能告诉我们内部原因。");
  const buildingFund = shared(heir,"fund","榆荫楼维修账户","account","专项维修资金，双方知情后可支付实际工程。",["heir","elena"]); m.quantity(buildingFund,"eurodollar",12000);
  const quote = asset(heir,"repair-quote","800 欧元管道维修报价单","document","桌上的维修报价文件，列出拟议工程范围；不是已付款发票。", "marco");
  m.fact(quote,"quoted-amount",800,"拟议总价为 800 欧元，尚待核对工人、范围与验收。",["heir","marco","elena","inez"]);
  m.fact(quote,"paid",false,"无人付款或垫付，现不存在本单报销债务。",["heir","marco","elena","inez"]);
  for(const actor of ["heir","marco","elena","inez"]) m.believe(actor,quote,"unpaid-quote","800 欧元是尚未核验、未付款且未垫付的管道维修报价，不能说成已经欠下的报销款。");
  offer(heir,"lease-offer","五年包租要约",["elena"],"外部运营方提出为期五年、每月 7000 欧元的包租，要求完整使用闲置房及到期合法调整租约。尚未签字、无预付款；可要求现有租客保护条款。报价期限是五年，7000 是月租金额，不是租期。");
  m.fact("heir-lease-offer","term-years",5,"当前要约的租期为五年，变更须实际提出并协商。",["heir","elena"]);
  offer(heir,"repair-offer","修缮与社区空间合作",["inez","marco","elena"],"社区合作方愿以每月 4200 欧元收入及分期修缮换取工作室使用；先核验报价、分工与验收，再签约。首笔维修可单独处理。");
  m.commitment("heir","已经承诺就重大改造听取共同产权人和租户意见。",["elena","marco","inez"]);
  opening(heir,"埃琳娜带来两份方案，马尔科把漏水照片与 800 欧元维修报价放在桌上，伊内兹等着解释社区合作的条款。大家尚未签字。",7200,["核对报价并协商维修预付款","协商租客保护条款","走进闲置房评估其他用途"]);

  const lead = role("O02","lead","公司里仍有明天","艾登·沃克","corpo-plaza","Charter Hill 租用公寓","棱桥服务项目办公室",9000,
    {persuasion:4,craft:4,investigation:3},"原创承包商棱桥服务的项目负责人，有工作和采购权限。职位属于中型企业，不是荒坂或军用科技的高层。","处理演示系统缺陷，保住客户信任并发展团队。");
  m.get(lead.home).placement="charter-hill";
  contact(lead,"mina","米娜·沃斯","棱桥服务的项目主管。","确保演示可交付，接受有证据的范围调整。","主管与项目负责人，有互信但会检查支出。","希望她支持真实可行的计划。","欣赏能力，也须对客户和团队负责。",{persuasion:5});
  contact(lead,"pavel","帕维尔·陈","负责现场集成的资深技术员。","先复现授权缓存缺陷再上线。","合作完成过两次交付，技术判断互相尊重。","他的测试报告值得认真看。","愿意加班修复，但拒绝伪造验收。",{craft:6,netrunning:3});
  contact(lead,"ada","艾达·桑兹","设备供应商代表。","争取长期采购合同，以折扣换较稳定订单。","已有采购往来，没有私下回扣承诺。","可以谈价格，也要防止被长期条款套住。","认可客户专业，愿谈条件但不白送库存。",{persuasion:5});
  const company=m.entity("crownbridge-services","棱桥服务","organization","corpo-plaza","承接小规模设备集成的原创企业；项目资金与公司器材归企业，岗位负责人只在授权范围内使用。").id;
  for(const actor of ["lead","mina","pavel","ada"]) m.know(actor,company,"这次项目的采购与交付主体是棱桥服务，艾登代表公司办事，不是用公司钱买私人器材。");
  m.reference("lead","employer",company,"艾登受雇于公司并持有项目岗位授权，职位不等于拥有企业资产。");
  const terminal=asset(lead,"terminal","项目测试终端","terminal","仅连入棱桥内部测试网，不能直接控制客户正式系统。",null);
  m.reference(terminal,"authorized-user","lead","岗位授予测试访问权。",["lead","mina","pavel"]);
  const budget=shared(lead,"budget","棱桥项目采购账户","account","公司资金；艾登可在批准项目范围内采购，超过单笔 10000 欧元须米娜复核。",["lead","mina"]); m.quantity(budget,"eurodollar",48000);
  const report=asset(lead,"report","权限缓存测试报告","data-file","封装的测试记录，需要项目人员打开阅读。",null);
  for(const item of [terminal,budget,report]) m.reference(item,"owner",company,"棱桥服务的公司财产，艾登与同事只有岗位使用和保管权限。",["lead","mina","pavel"]);
  m.fact(report,"test-findings","撤销的临时用户仍能在隔离测试节点重连一次；未证实影响生产系统。","这是可重复的本地缺陷，不是全球后门。",["lead","pavel","mina"]);
  for (const id of ["lead","pavel","mina"]) m.believe(id,report,"tested-failure","撤销后的临时凭证在测试节点仍能重连一次；要复现和修复或缩小演示范围。");
  offer(lead,"demo","客户试点交付草案",["mina","pavel"],"明日上午演示；可商议隔离试点或延期。未验收不能记为已收入，项目预算不等于个人存款。");
  offer(lead,"supply","采购折扣提案",["ada","mina"],"首批六台控制器普通按单报价合计 6000 欧元；六个月采购框架下的折扣另行协商，不以签框架作为这笔普通采购的前提。尚未付款或移交，也可另找供应商。");
  m.reference("lead-supply","contracting-principal",company,"艾登在本次采购中代表公司；未签框架不影响另行达成普通按单交易。",["lead","mina","ada"]);
  const controllers=asset(lead,"controllers","艾达的首批控制器运输箱","stock","箱内最初有六台独立标签的测试网用控制器，现由艾达保管且未付款交接；运输箱归艾达，交付台数依真实库存变化。","ada");
  const receivedControllers=asset(lead,"received-stock","棱桥项目控制器收货柜","stock","公司办公室的空收货柜；本批控制器真实移交后在此存放，由艾登代公司登记保管，不进入他的私人财产。",null);
  m.reference(receivedControllers,"owner",company,"收货柜及公司实际采购入库的控制器归棱桥服务；艾登的数量登记表示保管。",["lead","mina","pavel","ada"]);
  m.reference(receivedControllers,"custodian","lead","艾登负责本项目的现场清点、保管与交付记录。",["lead","mina","pavel","ada"]);
  m.fact(receivedControllers,"received-for-project",false,"当前无控制器入库；只有实际付款与清点移交后才记录相应采购入库，不因申请付款而提前确认。",["lead","mina","pavel","ada"]);
  m.fact(controllers,"unit-price",1000,"本次按单采购为六台、每台 1000 欧元，共 6000；框架折扣需另行协商。",["lead","mina","ada"]);
  m.fact(controllers,"delivery-status","awaiting-payment-and-handover","现货可在核对本批实际到账后交付；付款、移交保管、确认归属和安装分别发生。",["lead","mina","pavel","ada"]);
  m.fact(controllers,"batch-labels","CB-01, CB-02, CB-03, CB-04, CB-05, CB-06","本批控制器的实物标签；不能复制标签增发第二批库存。",["lead","mina","pavel","ada"]);
  for(const actor of ["lead","mina","pavel","ada"]) {
    m.believe(actor,controllers,"procurement-batch","艾达带来六台控制器，每台 1000 欧元、按单采购合计 6000；真实到账后可以清点并移交，不用先签六个月框架。控制器到货本身不会修复权限缓存。");
    m.believe(actor,receivedControllers,"company-custody","公司控制器收货柜目前为空。付款后的实物可由艾达逐台交给艾登、登记到公司柜内；艾登是保管人，棱桥服务才是采购入库器材的所有者。");
  }
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
  const screeningAccount=shared(editor,"settlement","塞莉娅放映场的业务结算账户","account","场地营业资金，与塞莉娅的私人现金分开；供本次委托及已有场地业务使用。",["celia"]);m.quantity(screeningAccount,"eurodollar",4800);
  m.fact(screeningAccount,"commission-reserve",2400,"本次剪辑委托可支付的约定酬金；需完成授权版交付、塞莉娅核验并申请结算，尚未付款。",["editor","celia","sora","tomas"]);
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
  shared(fleet,"tools","车队共用检修工具车","equipment","压力表、检漏工具、绝缘手工具与空载测试接口；可检查和维护，不包含能凭空替换的冷却阀。",["fleet","raul","jo"]);
  const spareValve=asset(fleet,"valve-stock","车队备用冷却阀零件盒","stock","一只已按三号冷藏车接口核对的备用冷却阀，属于车队常备材料，由劳尔保管；安装会消耗这只现货。",null);
  m.reference(spareValve,"custodian","raul","劳尔保管车队的这件兼容备件，可按共同维修授权领用。",["fleet","raul","jo"]);
  m.fact("fleet-reefer","repair-scope","原冷却阀回位不稳，可检查确认后用真实兼容阀更换；须重新做制冷与保压检查才能决定可承运条件。","清洁与空载试验可以获得证据，不能从工具车里凭空拿出新阀。",["fleet","raul","jo"]);
  for(const actor of ["fleet","raul","jo"]) m.know(actor,spareValve,"劳尔保管的一只兼容备用阀在装卸坪，维修时可以实际领用并记账。");
  const freightAccount=shared(fleet,"client-settlement","仓库客户运费结算账户","account","客户交由仓库按货运约定结算的业务资金，由梅核验交付；不是梅的私人存款，也不是车队已收到的钱。",["mei"]);m.quantity(freightAccount,"eurodollar",8000);
  m.fact(freightAccount,"reserved-orders","普通货运单 5200 欧元；社区设备单 2800 欧元","两个独立委托的运费各自据实际交付、签收和履约结算；同一货物不能重复签收。",["fleet","mei","raul","jo"]);
  const cargo=asset(fleet,"cargo","已装箱的水处理设备","cargo","四个可逐件清点的标准箱，社区委托人所有，车队仅负责保管与交付。",null);
  m.quantity(cargo,"cargo-unit",4);
  const ordinaryCargo=asset(fleet,"regular-cargo","待运的六箱普通工业货","cargo","六箱有 R-01 至 R-06 标签的普通工业外壳，客户所有、车队保管；不需低温，与四箱水处理设备分开清点。",null);
  const warehouse=m.entity("fleet-destination","阿罗约货运交接仓","place","arroyo","有正常道路入口、可泊车的卸货区及分开的工业货与社区设备收货位；接受按约到达的货运，不允许从营地隔空签收。").id;
  m.reference(warehouse,"street-access","arroyo","车辆可通过城市道路抵达，仍须实际行车和付出燃料、时间。");
  m.person({id:"freight-receiver",name:"黛娜·阿卜杜拉",place:warehouse,description:"这班负责货运实物清点的仓库收货员。",persona:"熟悉不同客户的收货位，想在换班前把到货清点完整。",voice:"报箱号和实况，遇到少件先问司机，不把签名当成走过场。",goal:"按两份实际成立的货单核对到仓货物并给梅发送可核对的签收。",value:"让司机和下一班都能对得上货。",ratings:{investigation:4,craft:2}});
  m.relationship("fleet","freight-receiver","warehouse-contact","曾按正常流程共同完成仓库交接。","知道她会逐箱核对，抵仓可以找她办理。","认识米卡，但仍要看到实际货物与本次货单。");
  m.relationship("mei","freight-receiver","warehouse-colleagues","梅协调窗口，黛娜在仓库清点实际货物。","依据她实际发回的签收核验运费。","能向梅说明到货和异常，不替司机承担缺件。");
  for(const shipment of [cargo,ordinaryCargo]) {
    m.reference(shipment,"delivery-destination",warehouse,"两批分别在此仓交付，去往同一仓不意味着可以混淆批次。",["fleet","raul","jo","mei","freight-receiver"]);
    m.reference(shipment,"consignee","freight-receiver","受委托现场清点和签收的人，签收仍取决于实际到货。",["fleet","raul","jo","mei","freight-receiver"]);
    m.fact(shipment,"delivery-accepted",false,"本批尚未发运到仓或签收；装车、到门口及另一批签收不改变本批状态。",["fleet","raul","jo","mei","freight-receiver"]);
  }
  for(const actor of ["fleet","raul","jo","mei","freight-receiver"]) {
    m.know(actor,warehouse,"这两单的实际目的地是阿罗约货运交接仓，可沿公路到达，黛娜负责现场收货。");
    m.know(actor,cargo,"四箱社区水处理设备，独立于普通工业货的一批。");
    m.know(actor,ordinaryCargo,"六箱普通工业货，R-01至R-06，不要求低温运输。");
  }
  offer(fleet,"regular-order","长期客户普通货运单",["mei","jo","raul","freight-receiver"],"拟运现场R-01至R-06普通工业货六箱至阿罗约货运交接仓，黛娜实际清点签收后由梅向车队公账结算5200欧元；平板或厢式车可按实装容量调度，不需冷链。仍须商定窗口并确认接单，可改日或转包；尚未交付付款。");
  offer(fleet,"community-order","社区水处理设备委托",["mei","jo","raul","freight-receiver"],"四箱水处理设备拟用平板车运至阿罗约货运交接仓的社区设备收货位，由黛娜单独签收，梅据此向车队公账结算2800欧元；可拼货或分期交付，窗口和接单待协商，普通货物的签收不能代替本批。");
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
  const crate=asset(armorer,"crate","格兰特带来的待检装备箱","cargo","三件可维修的护具与部件，外侧还能看到原有流转编号；格兰特带来并保管它们，真实产权仍待核对。",null);
  m.reference(crate,"custodian","grant","仅明确当前保管与送检人，不据此认定内装器材的真实所有权。",["armorer","grant","leo","rosa"]);
  m.believe("grant",crate,"custody","这箱器材由我带来送检；对方仍会核对原始交接凭证，保管不能代替产权证据。");
  m.fact(crate,"provenance-mark","旧编号与社区保安队登记格式相符，但单凭格式尚不能认定盗窃。","利奥发现的线索可进一步核验。",["armorer","leo","grant"]);
  const securityCoop=m.entity("rancho-community-watch","科罗纳多社区守望队","organization","rancho-coronado","几条街居民出资维持的原创巡守队，有有限装备和出借登记，不代表六街帮或整个NCPD。").id;
  const registryOffice=m.entity("armorer-registry-office","社区守望队登记室","place","rancho-coronado","正常营业的装备登记与归还窗口，可从维修店沿街道步行抵达；查阅具体借出资料需说明相应编号与来意。").id;
  m.reference(registryOffice,"street-access","rancho-coronado","普通街区道路连接登记室，不会把电话询问当成实物归还。");
  m.person({id:"watch-registrar",name:"妮娅·门德斯",place:registryOffice,description:"保管社区守望队出借和归还记录的登记员。",persona:"认得几批常用护具的编号，不认识城里所有装备的来路。",voice:"先核编号再翻记录，会说明自己哪一段没有材料。",goal:"把实际借出器材收回或登记明确的延借，给送检人可核对的答复。",value:"公共装备应让下一班也有得用。",ratings:{investigation:4,craft:2}});
  const loanRecord=m.entity("armorer-loan-register","GC 系列护具原始借出登记","data-file",registryOffice,"登记室内的原始借出记录，公开窗口外无法直接看见内容。").id;
  m.fact(loanRecord,"registered-content","GC-14、GC-15、GC-16归社区守望队；为一次物资护送借给格兰特保管，尚未登记归还或出售。","能证明这三件的登记来路与当前权属，不把登记缺页或外观相似认定成所有盗窃事实。",["watch-registrar","armorer","leo","grant","rosa"]);
  m.fact(crate,"serial-labels","GC-14, GC-15, GC-16","这三件装备的实际流转编号，可与独立记录逐一比对。",["armorer","leo","grant","rosa","watch-registrar"]);
  m.reference(crate,"owner",securityCoop,"三件借出装备实际归社区守望队；此权属须经真实记录或有权人说明才能被送检方确认。",["watch-registrar"]);
  m.fact(crate,"returned-to-owner",false,"装备尚在维修店送检，未实际归还登记窗口。",["armorer","grant","watch-registrar"]);
  m.believe("watch-registrar",loanRecord,"loan-register","这份登记包含GC-14至GC-16的真实借出信息，我可按编号向有关送检人核对并接收实际归还。");
  m.reference("watch-registrar","affiliation",securityCoop,"登记员在本队的出借和归还权限内工作。");
  m.know("grant",securityCoop,"借给我这三件护具的社区守望队，没有把它们卖给我。");
  m.believe("grant",crate,"borrowed-custody","这三件护具是守望队借给我保管的物资，尚未归还；我希望先修好，但不能自行卖掉它们。");
  m.relationship("rosa","watch-registrar","neighborhood-register-contact","两人曾核对过邻里借用的公共器材。","可以带来具体编号询问她。","愿意查真实记录，不替罗莎的熟人作无证据保证。");
  for(const actor of ["armorer","grant","leo","rosa"]) m.know(actor,registryOffice,"罗莎知道社区守望队的登记窗口，可按编号去查询或安排实际归还。");
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
  const workshop=m.entity("restart-workshop","再启工坊合伙经营体","organization","arroyo","工人与技师共同经营的原创小工坊，承租生产线，材料和业务收入与各人私产分开。").id;
  const customer=m.entity("grille-equipment","格栅设备供货社","organization","arroyo","采购普通设备外壳的原创小客户，委托欧文核验本次试制；不属于原作巨企。").id;
  m.reference(wages,"owner",workshop,"工坊业务资金，用途继续受工资和共同维护授权约束。",["partner","marta","owen"]);
  m.reference("owen","client-mandate",customer,"客户授权欧文协商首批四件壳体、核验实物并办理不超过2400欧元的本批结算；不代表无限采购权。",["partner","marta","owen"]);
  const materials=asset(partner,"stock","工坊合法采购的壳体坯料","stock","三十六份可加工壳体坯料，存放于工坊原料架；每件试制壳体消耗一份坯料，与维修通用组件分账。",null);
  const products=asset(partner,"output","工坊试制壳体周转盘","stock","当前为空，用于放置本轮实际生产出的试制壳体；待检品不是已验收商品。",null);
  for(const container of [materials,products]) {
    m.reference(container,"owner",workshop,"工坊的材料及待交付产品，朱尔斯登记保管不表示个人所有。",["partner","marta","owen","nela"]);
    m.reference(container,"custodian","partner","朱尔斯负责登记与保管；库存属于工坊业务，不是可以私吞的现金或材料。",["partner","marta","owen","nela"]);
    m.reference(container,"authorized-user","marta","工长可核对现场库存与生产记录。",["partner","marta","owen","nela"]);
  }
  m.fact(line,"low-load-process","一份 industrial-blank 经实际低速成形加工成为一件 trial-housing；留在成品周转盘，待尺寸检查与客户验收。","这个工艺只生产普通试制壳体，不把消耗的原料重新登记成同一种通用组件。",["partner","marta","owen","nela"]);
  m.fact(products,"customer-accepted",false,"试制壳体初始为零；尺寸记录和客户实际验收才可能改变交付状态，不因产出即成为已收款成品。",["partner","marta","owen"]);
  const feedSensor=m.entity("partner-feed-sensor","送料段现用传感组件","component",line,"安装在旧线送料段内，需要停机检查其型号与实际反馈。").id;
  m.fact(feedSensor,"fault","原送料传感器在高速振动下反馈不稳，低负荷时仍可正常读数。","须实际停机检查和受控试验确认，单看高速曲线不等于已经更换或修复。",["partner","nela","marta","owen"]);
  const sensorStock=asset(partner,"sensor-stock","妮拉的 RT-7 适配传感组件","stock","一件可适配该旧线送料段的RT-7组件，妮拉带来用于核对和正式维修；它是承包商的现货，未赠与工坊。","nela");
  m.fact(sensorStock,"maintenance-quote","3800欧元的维护提案含这一件组件及实际更换、校准和受控复测；须先确认诊断与范围。","不是另藏的免费库存，也不能拿工业壳体坯料替代传感件。",["partner","marta","nela"]);
  for(const actor of ["partner","marta","owen","nela"]) m.know(actor,sensorStock,"妮拉带来一件真实RT-7组件，可核对后按维修合同使用，不属于工坊的壳体坯料。");
  for(const actor of ["partner","marta","owen","nela"]) m.believe(actor,line,"trial-material-flow","低速试制每件壳体消耗一份原料架上的工业坯料，实际产出一件单独登记的试制壳体，放进空的成品周转盘；这个结果不证明高速联锁通过或客户接受。");
  const customerStock=asset(partner,"customer-stock","欧文的客户收货周转箱","stock","工坊交接台旁的空箱，供欧文逐件验收并代表客户接收本批合格壳体；未经接受仍属工坊。",null);
  m.reference(customerStock,"owner",customer,"客户的周转箱与实际采购接收物，欧文仅代表客户保管。",["partner","marta","owen"]);
  const customerAccount=shared(partner,"customer-settlement","格栅设备首批采购结算账户","account","客户预留的本批业务资金，欧文只能在首批采购授权内、按实际交付验收申请付款。",["owen"]);m.quantity(customerAccount,"eurodollar",2400);
  m.reference(customerAccount,"owner",customer,"独立客户资金，不是欧文私人积蓄或工坊已收到的收入。",["partner","marta","owen"]);
  for(const actor of ["partner","marta","owen","nela"]) {
    m.know(actor,workshop,"再启工坊是实际经营与收款主体。");
    m.know(actor,customer,"格栅设备是本次试产的采购意向方，欧文按本批授权核验。");
    m.know(actor,customerStock,"欧文可代表客户在此接收实际验收通过的本批壳体，目前为空。");
  }
  offer(partner,"trial","小批量试产采购意向",["owen","marta"],"格栅设备拟采购首批四件普通壳体，报价每件600欧元、整批2400；尺寸和交期须双方确认，允许低负荷生产，不要求未验证的高速。欧文代表客户实际检验并接收后，从客户专户付至工坊工资及维护账户；可商议缩量或延期，初始未签、未验收、未付款。");
  offer(partner,"maintenance","联锁维修提案",["nela","marta"],"检查及更换传感组件初估 3800 欧元，需诊断确认；允许由本厂自修、延后或拆分范围。");
  opening(partner,"空的成品周转盘摆在工作台上，先前低负荷记录合格而高速曲线异常。玛尔塔拿来工资表，欧文等着讨论验收范围，妮拉提出先看联锁日志。",10800,["用一份坯料低速试制并记录成品","谈小批量交付","预算维修与工资的先后"]);

  const broker=role("O09","broker","狗镇的双边运输经纪","卢卡·萨迪克","dogtown","市场后街出租间","萨迪克租用仓位",13000,
    {persuasion:5,streetwise:5,investigation:4},"靠小规模贸易守约记录生活的经纪人，熟悉具体文员和商户；没有永久免检权，也不是汉森的私人代表。","查清货单型号差异，保护两边的交易信用。");
  contact(broker,"vera","维拉·萨迪克","市场设备商户。","拿到适配设备，同时保证自己顾客的权益。","有持续贸易记录；同姓不预设亲属。","要维护长期信任。","接受协商，不接受拿不兼容高价货强行抵数。",{persuasion:4,craft:3});
  contact(broker,"emil","埃米尔·科斯塔","关口货运文员，今日来核对货单。","按自己的职责核验批次和通行文件。","曾办过三次正常货运手续，不存在无限通融承诺。","能问流程，不能替他决定批准。","认可往来记录，仍需核对新批次。",{investigation:4});
  contact(broker,"jun","俊·梅尔卡多","城内设备采购商。","核对订单型号，并对多出的性能讨论差价。","既有买卖关系，不是无条件政治同盟。","可以交换信息，不能两边重复卖同一货。","愿为合用设备付钱，也有取消不符订单的权利。",{persuasion:4,craft:3});
  const van=shared(broker,"van","按日租赁的运输厢车","vehicle","租赁车辆，准许普通货运，不能转卖；燃油与检查照常发生。",["broker"]);m.quantity(van,"fuel",25);
  const permit=asset(broker,"permit","本批普通设备货运许可","document","仅对应本车、本批普通工业设备及当次核验，无永久免检或军用物资豁免。");
  m.fact(permit,"scope","本次四箱 A2 工业控制器，关口仍有权复核实际货物。","许可不能用于不同型号而不申报更新。");
  m.person({id:"broker-supplier",name:"奥斯卡·纳赛尔",place:broker.work,description:"这四箱控制器的独立供货商，赶来核对误装批次。",persona:"有真实的货物和这次发错型号的麻烦；宁可谈一次合理变更，也不愿靠一句升级了强压给买家。",voice:"能讲清供货和成本，遇到自己仓库的错会不情愿地承认。",goal:"核对本批A3与买方用途，合法成交收取相应货款，或按实际情况接回退货。",value:"做完交易还能继续靠信用拿到下一单。",ratings:{craft:4,persuasion:4},cash:2400});
  const buyer=m.entity("jun-workshop","晨线设备作坊","organization","arroyo","俊代表的原创小作坊，采购适配的控制器，不因型号更高就接受不兼容货物。").id;
  const batch=asset(broker,"batch","实际到仓的四箱 A3 控制器","cargo","包装标签为 A3，货单写 A2；B-01至B-04为本批四箱，由卢卡受托保管，所有权尚属奥斯卡，适配和成交仍待核。",null);m.quantity(batch,"control-cargo-unit",4);
  m.reference(batch,"consignor","broker-supplier","奥斯卡是这批现货的货主和原供货方，卢卡只代管并按确认条件经纪。",["broker","vera","jun","emil","broker-supplier"]);
  m.fact(batch,"title-status","奥斯卡持有本批货物所有权；卢卡仅受托保管。","实际成交、交付和付款可改变权属，不能因卢卡搬动或代管而变成其私产。",["broker","vera","jun","emil","broker-supplier"]);
  m.fact(batch,"consignment-authority","卢卡可以核对、安排检测、代表送交双方同意的变更或退运；未经奥斯卡与选定买方确认，不能擅卖或重复承诺同批货。","原提案四箱按批8000欧元，含卢卡400欧元经纪费、供货商7600欧元货款；型号变更后的价格与适配须重新明确。",["broker","vera","jun","emil","broker-supplier"]);
  m.fact(permit,"approval-status","valid-for-A2-only","当前许可仍只对应A2；埃米尔按职权核对实物与更新材料后才能办理本批A3许可，不自动放行。",["broker","jun","emil","broker-supplier"]);
  m.reference(permit,"authorized-writer","emil","本批文件的有权核验文员；卢卡提交差异记录不等于自己签发许可。",["broker","jun","emil","broker-supplier"]);
  const receiving=asset(broker,"received-stock","晨线作坊控制器收货位","stock","阿罗约货运交接仓内属于晨线作坊的空收货位；黛娜受托逐箱接收实际交付的本批控制器。",null,"fleet-destination");
  m.reference(receiving,"owner",buyer,"作坊自己的收货位与实际采购入库货物，仓库收货员只保管。",["broker","jun","freight-receiver"]);
  m.reference(batch,"delivery-destination","fleet-destination","本批拟向阿罗约货运交接仓交付，须先完成型号协商与实际许可更新。",["broker","jun","emil","broker-supplier","freight-receiver"]);
  m.reference(batch,"consignee","freight-receiver","黛娜可代表晨线作坊清点收货；她的签收不替代俊的适配接受与合同确认。",["broker","jun","freight-receiver"]);
  m.fact(batch,"delivery-accepted",false,"本批仍在狗镇仓位，尚未实际运抵收货位。",["broker","jun","freight-receiver"]);
  const purchaseFund=shared(broker,"customer-settlement","晨线作坊本批采购账户","account","晨线作坊的8000欧元采购资金，与俊的个人现金分开；只能支付实际同意并收到的这一批。",["jun"]);m.quantity(purchaseFund,"eurodollar",8000);
  m.reference(purchaseFund,"owner",buyer,"本批机构采购资金，不属于经纪人、仓管或俊的个人存款。",["broker","jun"]);
  m.relationship("broker","broker-supplier","consignment-client","卢卡替奥斯卡核对并经纪本批货物，仓储保管不转移产权。","希望把货单误差解决，按实际约定取得经纪费。","授权他协商，仍需要我确认价格与收款安排。");
  m.relationship("broker","freight-receiver","freight-receiving-contact","以前在阿罗约仓完成过普通交接。","知道她可以按客户授权签收，不能免掉检查站手续。","按本批授权和实物收货，不把以前认识当成这次已收到。");
  for(const actor of ["broker","vera","jun","emil","broker-supplier"]) {
    m.know(actor,buyer,"俊代表晨线设备作坊核对这批采购，资金和货物不属于经纪人个人。");
    m.know(actor,"broker-supplier","奥斯卡是四箱A3的真实供货方，可以协商变更或退回现货。");
    m.know(actor,"fleet-destination","选定买方的实际交付点在阿罗约货运交接仓，需要从狗镇实际运输过去。");
  }
  for(const actor of ["broker","jun","freight-receiver"]) m.know(actor,receiving,"晨线作坊的本批收货位现在为空，只有实际到货才能填入库存。");
  m.know("freight-receiver",batch,"拟接收的是B-01至B-04四箱控制器，独立于其他普通货与社区水处理设备。");
  offer(broker,"delivery","A2 设备交付订单待变更单",["vera","jun","emil","broker-supplier","freight-receiver"],"原拟四箱A2按批8000欧元，供货商7600、经纪费400；现货A3须由奥斯卡与选定买方重新确认型号适配、价格和归属。若俊代表晨线作坊接受，先更新本批许可、实际运至阿罗约仓由黛娜清点，俊核验后从专户分别付货款与经纪费。维拉可提出另购，但不能把同批货卖两遍；未签变更、未过关、未交付、未收款。");
  opening(broker,"维拉拆开一箱看见 A3 标签，俊指着写 A2 的货单询问适配问题。埃米尔说明需要先更新这一批的文件；厢车停在仓位旁。",7200,["核对型号与兼容性","协商改合同并更新许可","退运或寻找合适买家"]);

  const manager=role("O10","manager","乐队走红前的经纪人","达尼·沃斯","japantown","排练室上层小公寓","折光乐队排练室",4800,
    {performance:5,persuasion:5,streetwise:3},"原创乐队折光的经纪人，有小圈子信誉和真实演出机会，未与克里或 SAMURAI 建立虚构亲属关系。","同成员商议第一份大演出合同，兼顾收入与作品控制。");
  contact(manager,"rin","林恩·瓦尔德兹","折光乐队的主唱及词曲作者。","保留作品表达，不接受未经同意删歌。","伙伴与代理关系，歌曲版权属于作者。","想让作品被更多人听到。","相信经纪能力，但作品取舍要一起决定。",{performance:6});
  contact(manager,"bex","贝克斯·马利克","乐队鼓手，负责部分器材维护。","获得稳定收入并还清个人设备分期。","演出按约分成，个人债务不自动转移给乐队。","理解他需要实际收入。","愿谈商业合作，不愿永远只靠热情付房租。",{performance:5,craft:3});
  contact(manager,"paulo","保罗·里德","市中心回声间现场空间的场地经理。","获得可靠节目与清楚赞助安排。","以往在小场合作成功，愿提供较好时段。","有谈判基础，但不该保证成员尚未同意的事。","认可合作记录，也须向场地方说明条款。",{persuasion:5});
  const gear=shared(manager,"gear","折光乐队演出器材","equipment","音箱、电子鼓组及舞台接口共同使用；个人乐器版权和产权另计。",["manager","rin","bex"]);
  const fund=shared(manager,"fund","折光乐队共同账户","account","演出收入先记公账，按成员约定支付场租与分成，不能全算经纪人收入。",["manager","rin","bex"]);m.quantity(fund,"eurodollar",6800);
  const song=asset(manager,"song","未发行歌曲工作母带","data-file","存有可供排练和商议的作品；传播授权需作者明确同意。","rin",gear);
  m.believe("manager",song,"licensed-use","林恩允许我拿这份工作母带与场地讨论演出，不等于同意删歌或商业买断。");
  const venue=m.entity("manager-venue","回声间现场空间","place","downtown","原创营业场地，有道路入口、固定舞台、散座与可开闭的侧厅；保罗负责排期。当前有普通酒吧客人，没有已经成立的折光演出。").id;
  m.reference(venue,"street-access","downtown","从日本街排练室到此须实际出行，乐队成员和器材不能靠口头选方案瞬移。");
  m.reference(venue,"manager","paulo","保罗有场地排期和本批演出预算权限，不能替词曲作者授予作品版权。");
  const stage=m.entity("manager-stage","回声间固定舞台与扩声系统","equipment",venue,"有可接乐队器材的常规舞台接口、主扩声和舞台灯；需要实际搭台、音量检查及表演者到场。").id;
  const show=m.entity("manager-show","折光待议演出场次","event",venue,"回声间为折光保留的一次待商议机会，赞助扩厅和独立小场是同一场次的两种方案。").id;
  m.fact(show,"agreed-format","undecided","尚未选定并签署方案；可协商曲目、时长和开始时间，没有自动生效的演出。");
  m.fact(show,"performance-started",false,"成员尚未在此实际开始约定演出，排练室试播不是这场演出。");
  m.fact(show,"performance-completed",false,"只有在场地完成实际约定节目且核验履约后才成立，叫好、试音或签约都不是演出完成。");
  m.fact(show,"settled",false,"当前尚无演出费转账；结算应对应实际账户付款凭据。");
  m.person({id:"venue-listener",name:"露西亚·金",place:venue,description:"刚下班、在散座等朋友的本地乐迷。",persona:"常来听小乐队，喜欢现场里有自己的声音，也会在无聊时离开。",voice:"会说具体听到了哪句或哪段节奏，好听就直说，没听清也会问。",goal:"和朋友碰面，听听今晚有没有值得留下来的新音乐。",value:"晚上能花在真正喜欢的声音和人身上。",ratings:{performance:2,insight:3}});
  for(const actor of ["manager","rin","bex","paulo"]) {
    m.know(actor,venue,"保罗安排的回声间现场空间在市中心，须实际到场，两个演出方案共用同一待议场次。");
    m.know(actor,stage,"回声间有固定舞台和扩声系统，可以和乐队器材实际对接。");
    m.know(actor,show,"这场演出还没签约或完成；可以商定一份方案、节目和时间再实际准备演出。");
  }
  m.know("venue-listener",stage,"这里是会有现场音乐的舞台，目前还没人开始折光的约定节目。");
  m.know("venue-listener",show,"店里有折光的待定演出信息，还没有见到乐队开始表演。");
  offer(manager,"sponsored","赞助演出草案",["rin","bex","paulo"],"回声间同一场次的扩厅赞助方案报价9000欧元，要求替换一首歌并增加品牌露出；未接受，可谈只加露出或拒绝删歌。曲目、时长与开始时间须确认，现场完成后向乐队公账结算。");
  offer(manager,"independent","独立小场演出选项",["rin","bex","paulo"],"回声间关闭侧厅的小场方案报价3600欧元，无删歌条件；须协商曲目、时长、档期与器材并到场完成，保罗核验后付乐队公账。与扩厅赞助方案共用同一待议场次，不能同时算成两场演出。");
  const venueAccount=shared(manager,"venue-settlement","保罗场地的演出结算账户","account","场地方保留的演出业务资金，与保罗私人现金分开。由保罗核验实际履约后向乐队公账付款。",["paulo"]);m.quantity(venueAccount,"eurodollar",10000);
  m.fact(venueAccount,"alternative-fees","赞助方案 9000 欧元；独立小场方案 3600 欧元，同一档期只能选择一份实际成立的方案。","资金可支持任一方案，未签约、排练或仅口头讨论不等于演出完成或有权同时领取两份费用。",["manager","paulo","rin","bex"]);
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
  const accidentSite=m.entity("reporter-accident-site","阿罗约东侧事故检修区","place","arroyo","此次报道涉及的原创工厂外侧检修区；对外采访点与厂内受控设备分开，事故痕迹仍需按实际接近和取证条件查看。").id;
  m.reference(accidentSite,"street-access","arroyo","记者可沿道路到厂外联络与观察，进入受控设备区需取得现场许可。");
  m.person({id:"accident-witness",name:"梅芙·雷耶斯",place:accidentSite,description:"事故当时在厂外装卸点值班的叉车司机。",persona:"只看到了自己值班点附近的情况，愿意说明经历，不愿替整座厂作结论。",voice:"记得哪些声音听到了、哪些设备看不见，不确定的先后会直说。",goal:"下班前把自己实际见到的情况交代清楚，不让别人替她编完整事故故事。",value:"同事能安全工作，自己的话不被改成别的意思。",ratings:{driving:4,insight:3}});
  m.fact("accident-witness","limited-testimony","我在外侧装卸点看到走廊灯闪灭，随后听见室外蜂鸣器；我没有统一时钟，也看不到控制室，不知道内部警报先后。","这是一名证人的有限感知，不能自动校准到09:42或判断责任人。",["accident-witness"]);
  m.believe("accident-witness","accident-witness","own-observation","事故时我在外侧装卸点看到走廊灯闪灭，随后听见室外蜂鸣器。我没看时钟，也看不到控制室，不能保证和厂内警报是同一声。");
  m.relationship("amara","accident-witness","interview-lead","阿玛拉通过此前采访知道这位司机当时在外侧装卸点，尚未问完事故经历。","可以联系并征求采访同意，她不是全厂事故的全知见证人。","见过这位摄影记者，可以先听她们要问什么再决定说多少。");
  for(const actor of ["reporter","leila","felix","amara"]) m.know(actor,accidentSite,"这宗材料对应阿罗约东侧事故检修区，阿玛拉知道可先到厂外联络一位当班司机。");
  const draft=asset(reporter,"draft","事故调查待审核稿","data-file","编辑部已有的空稿件文件，可以根据核验后的材料撰写；正文和标题都尚未形成。",null);
  m.fact(draft,"body","空白：尚未撰写本次报道正文。","可据已核实材料和标明出处的说法写作，内部笔记不会自动变成公开稿。",["reporter","leila","amara"]);
  m.fact(draft,"editor-approved",false,"莱拉尚未对实际正文和公开范围作出批准。",["reporter","leila","amara"]);
  m.fact(draft,"source-release-cleared",false,"需逐项核对哪些素材可引用；这不授权公开费利克斯身份或未同意的原始材料。",["reporter","leila","felix","amara"]);
  m.reference(draft,"authorized-writer","reporter","记者负责据实撰稿，修改正文不改原始证据。",["reporter","leila","amara"]);
  const publication=asset(reporter,"publication-slot","街区镜报本次报道发布栏","terminal","编辑部现有的发布终端，可向读者发布已经批准的稿件；目前本篇尚未发布。",null);
  m.fact(publication,"published",false,"没有向读者公开这篇报道；写稿、批准或内部查看都不等于点击发布。");
  m.fact(publication,"published-copy","空白：本栏当前没有本篇公开内容。","只保存实际批准并发布的版本，原始证据和私人笔记不自动同步到公开端。");
  m.reference(publication,"authorized-publisher","leila","编辑可批准最终公开范围并实际操作发布；记者有署名和提出修改的权利，不替消息源作公开同意。",["reporter","leila","amara"]);
  m.reference(publication,"working-draft",draft,"本次待审核稿是可能发布的来源，初始还没有正文。",["reporter","leila","amara"]);
  for(const actor of ["reporter","leila","amara"]) {
    m.know(actor,draft,"可以将核验结果写成一篇实际稿件，再逐项确认公开范围。");
    m.know(actor,publication,"莱拉可以将实际获准的稿件发布到这一栏目，尚未公开本篇。");
  }
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
  m.fact(pump,"fault","备用供电板接点间歇失效，软件日志存在重启记录。","故障须通过已授权的接线诊断与接点检测才能观察；站在房间里或听说设备重启不足以确认原因。",["operator","niko"]);
  const oldBoards=asset(operator,"spares","泰莎的旧型供电板库存","stock","两块待检测供电板；需核对兼容与状态。","tessa");m.quantity(oldBoards,"components",2);
  const waterCoop=m.entity("northside-water-coop","北工区供水互助社","organization","northside","管理附近居民共用送水设备的原创互助组织，筹集有限维护资金，不是掌握全城供水的公司。").id;
  m.person({id:"pump-commissioner",name:"阿黛拉·贝纳",place:operator.work,description:"带控制柜来检修的供水互助社联络人。",persona:"记得哪些居民今晚需要用水，希望知道能修到什么程度，不愿花了大家的钱却只带回一句没问题。",voice:"直接说居民遇到的麻烦，听不懂术语就请对方解释，会认真核对写下来的结果。",goal:"接收能说明实际故障与后续选择的诊断记录，核验后按委托结算诊断费，再决定维修方案。",value:"让有限的公共维护钱确实帮助附近的人。",ratings:{persuasion:3,investigation:3}});
  m.reference("pump-commissioner","affiliation",waterCoop,"互助社委派的本次维护联络人，不拥有任意处分公共设备的权限。");
  m.reference(pump,"owner",waterCoop,"送检设备归互助社，埃利只是受委托检测，不得出售或私吞。",["operator","niko","mara","tessa","pump-commissioner"]);
  m.relationship("operator","pump-commissioner","diagnostic-client","她已送来设备和仅限诊断的书面范围，诊断报价仍待双方确认。","知道她代表供水互助社，可以把实际诊断与替代方案交给她判断。","知道埃利受过这代接口训练，仍须看到实际诊断记录再结算。");
  const waterFund=shared(operator,"community-fund","北工区公共水泵维护账户","account","互助社实际预留的1800欧元维护款，由阿黛拉按本次授权申请支付；不是任何人的私人现金。",["pump-commissioner"]);m.quantity(waterFund,"eurodollar",1800);
  m.reference(waterFund,"owner",waterCoop,"互助社维护资金，诊断费600，其余维修款须明确报价与核准。",["operator","pump-commissioner","niko"]);
  for(const actor of ["operator","niko","mara","tessa","pump-commissioner"]) {
    m.know(actor,waterCoop,"北工区供水互助社是送修设备和维护资金的主体。");
    m.know(actor,"pump-commissioner","阿黛拉是本次社区委托的联络人，可以接收实际报告并核准范围内支出。");
    m.know("pump-commissioner",actor,`本次在场的${m.get(actor).name}。`);
  }
  offer(operator,"repair","社区旧水泵诊断委托",["niko","mara","tessa","pump-commissioner"],"诊断费拟定600欧元，须双方确认范围、实际诊断并交付可读记录，由阿黛拉核验后从公共维护账户向埃利付款。修复另报价另批准，未修好也可以交付真实诊断；可以推荐替换、教别人维护或拒接，不预定成功。");
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

  // Blank, bounded work products keep professional outcomes writable with expansion disabled.
  workRecord(heir,"maintenance-log","榆荫楼维修工作簿",["elena","marco","inez"],[building,quote,leakingPipe,plumbingTools],"分开记下现场漏点、隔离与维修、密封垫用量、复压检查及真实预付款；关水或转账都不是修缮已完成。");
  workRecord(lead,"delivery-record","控制器清点与隔离验证记录",["mina","pavel","ada"],[controllers,receivedControllers,terminal,report],"记录本批付款凭据、控制器移交台数和隔离测试结果；采购归公司，艾登仅保管，到货不代替缓存缺陷修复。",company);
  workRecord(editor,"edit-log","放映工作版修订与授权记录",["sora","tomas","celia"],[footage,cut],"记录实际改动、回放结果与当事人明确给出的授权；原始素材保持独立，已剪辑不等于已发行。");
  workRecord(apprentice,"clinical-record","安娜接口维护记录",["lin","ana"],[hand,"apprentice-service"],"分开记录安娜的实际同意、接口诊断、已做维护、备件用量和复查；供应商不能自动读取病人的记录。");
  workRecord(fleet,"maintenance-log","车队检修与空载试验记录",["raul","jo","mei"],["fleet-reefer","fleet-tools"],"记录实际检查、材料和温度试验；可及部位清洁或一次空载结果不自动构成长途冷链验收。");
  workRecord(fleet,"delivery-log","车队分批交付与签收记录",["raul","jo","mei","freight-receiver"],[cargo,ordinaryCargo,warehouse],"分别记录两批装车、道路运输、到仓箱数及黛娜真实签收；梅依据真实签收办理对应运费，不能把四箱社区设备当作六箱普通货。");
  workRecord(medic,"care-log","现场急救处置明细",["lena","mateo"],["injured-subscriber","injured-neighbor",kit],"逐人记录本人同意、观察到的伤情、已完成的处置、每次实际医材消耗及复查；保持两名伤者分列，初步稳定不等于痊愈。");
  workRecord(armorer,"test-log","装备非破坏性检测记录",["grant","leo","rosa"],[crate,"armorer-bench"],"记录校准、实测读数和保留的流转编号；检测性能和核对原始所有权是不同结论。");
  workRecord(partner,"batch-log","低负荷试制批次记录",["marta","owen","nela"],[line,materials,products,customerStock],"逐批记录实际消耗的工业坯料、实际产出的试制壳体、尺寸与联锁反馈；原料与成品分别记账，客户验收与到账另核。",workshop);
  workRecord(broker,"discrepancy-log","本批控制器型号核对记录",["vera","jun","emil"],[batch,permit,"broker-delivery"],"记录逐箱核对结果、A2/A3差异、买家的实际答复和许可办理进展；文件更正草稿不代表已经批准过关。");
  workRecord(manager,"test-report","折光排练室试播记录",["rin","bex","paulo"],[gear,song],"记录实际试播的接口、音量和听到的问题，注明仅在排练室内部使用；不修改母带、不据此获得公开传播授权。");
  workRecord(manager,"show-log","折光现场演出与结算记录",["rin","bex","paulo"],[venue,stage,show],"记录商定的演出方案、曲目与时间、成员和器材实际到场、真实表演和反馈，以及保罗核验和公账到账；排练或普通客人在场不等于已履约。");
  workRecord(reporter,"notebook","事故调查内部核验笔记",["leila","amara"],[evidence,"reporter-recorder"],"记录实际读取的时间戳、证言差异、出处与尚待核查的问题；笔记不改原始证据，不把费利克斯身份公开，不把矛盾等同于定罪。");
  workRecord(operator,"diagnostic-log","L-4 接口诊断记录",["niko","mara","tessa","pump-commissioner"],[pump,implant,manual],"记录实际接线、读取到的日志和已检查的接点，区分诊断、报价、获准维修及复测；读到故障不代表修复，阿黛拉可据真实交付记录核验诊断费。");
}
