// Ordinary payment software is modeled as a bounded service Agent, not an autonomous rogue AI.
export function authorAccounts(m) {
  const accounts=[
    ["heir-fund",["heir","elena"],["marco","inez","heir-plumber"],"维修费用须有诺亚与埃琳娜的共同批准，核对报价后支付。800欧元报价的实际施工收款人是莉迪亚·莫兰；给马尔科的代办预付款须另有双方明确委托，不是默认欠款。任何一人都无权私提全部余额。"],
    ["lead-budget",["lead","mina"],["ada","pavel"],"艾登有单笔不超过 10000 欧元的既定项目采购权，超过此额须米娜确认。对艾达的首批控制器采购在项目范围内；仍须本人发出明确付款申请。"],
    ["fleet-reserve",["fleet","raul","jo"],["mei","parts-merchant"],"米卡可以支付已核对的日常燃油与维修费用，大额资产出售或分红须三位共有人同意。"],
    ["partner-wages",["partner","marta"],["nela"],"优先发放已确认的工资；维护与其他用途须朱尔斯与玛尔塔共同同意，不允许私吞工资资金。"],
    ["manager-fund",["manager","rin","bex"],["paulo"],"按三名成员确认的演出预算支付场租和器材，不单凭经纪人要求交出全款。"],
    ["reporter-expenses",["reporter","leila"],["amara","taxi-driver"],"伦可以支付单笔不超过 1200 欧元的实际交通、材料核验或采访开支；其他用途须莱拉批准，不购买假证词。"],
    ["editor-settlement",["celia"],["editor","sora"],"这是放映场经营资金，不是塞莉娅的私人现金。经本次委托所需授权和成片交付核验后，塞莉娅可明确申请向罗文支付 2400 欧元剪辑委托酬金；索拉的分成须有实际另行约定，不能将同一笔酬金重复付两次。未完成交付或仅有修改计划时不支付。"],
    ["fleet-client-settlement",["mei"],["fleet-reserve"],"这是仓库客户的运费结算资金。梅须按实际货单分别核验交付和签收后，明确申请向梅萨车队共同储备账户支付普通货运单 5200 欧元或社区设备单 2800 欧元。接受报价、装车或开车不等于完成交付；不付到司机私人账户，不为同一次签收重复支付。"],
    ["manager-venue-settlement",["paulo"],["manager-fund"],"这是场地演出业务资金。保罗可在实际签约及完成约定演出后，向折光乐队共同账户申请支付选定方案的酬金：赞助演出 9000 欧元，独立小场 3600 欧元。同一档期只结算真实成立的一项方案；排练、母带试播和口头意向不构成演出完成，不付款给经纪人私人账户。"],
    ["partner-customer-settlement",["owen"],["partner-wages"],"这是格栅设备的首批采购款，与欧文私人现金分开。双方确认报价和规格、欧文实际检验并接收相应壳体后，欧文可申请向工坊工资及维护账户支付本批货款；原提案四件2400欧元，单件600。变更件数与金额须真实协商，本账户单批最多2400；未签意向、只生产出样件或口头说合格不能直接付款。"],
    ["operator-community-fund",["pump-commissioner"],["operator","niko","tessa"],"这是北工区供水互助社的1800欧元维护款。阿黛拉在双方确认600欧元诊断委托、埃利实际诊断并交付记录、自己核验后可明确申请向埃利支付600。其余最多1200仅用于另行明确报价、核准和实际办理的维修或备件，不因发现故障自动结算，不把相同诊断重复付款。"],
    ["broker-customer-settlement",["jun"],["broker-supplier","broker"],"这是晨线作坊本批8000欧元采购款。型号、适配、价格和归属变更须供货商与俊实际确认，许可更新、实际交付及验收后，俊可按最终约定申请向奥斯卡支付货款、向卢卡支付经纪费。原提案7600货款与400经纪费合计8000；不能把同一批卖给两方，不能支付未经同意的A3，分别核对已有付款避免重复结算。"],
    ["heir-rent-account",["heir","elena"],["heir","elena"],"这是榆荫楼共同经营收入账户，收入归两位共有人并按实际到账登记。任何转出或分配须两人明确同意及具体用途金额，不自动把月租当私人收入，也不重复分红。"],
    ["heir-lease-settlement",["heir-lease-agent"],["heir-rent-account"],"嘉衡物业已备首月款7000欧元。只有其代表与两位产权人真实签署五年包租要约、按约实际交付空间、确认首月未付后，代表现场请求向榆荫楼共同经营账户支付7000。与社区合作方案对同一工作室同时段互斥，不提前支付、不重复支付，不自动产生后续月租。"],
    ["heir-community-settlement",["inez"],["heir-rent-account"],"榆荫邻里合作社已备首月款4200欧元，伊内兹有本次提案及支付代表权。须与两位产权人真实签署修缮与社区空间合作、完成约定工作室交接、确认本期未付后，现场申请支付4200到共同经营账户。不能与包租方案重复交付同一空间时段，追加修缮另谈，不自动每月造钱。"],
  ];
  for(const [id,authorized,payees,permission] of accounts) {
    const e=m.get(id);
    e.agent={id,model_profiles:m.get(authorized[0]).agent.model_profiles,character:{
      persona:{summary:`这是${e.name}的语音支付办理软件，现场听取授权人直接说出的申请，通过屏幕和语音给出结果。不是人类、通用 AI 或黑墙实体。${permission}`,voice:"终端显示并读出简短的核验、余额和结果，不拟人闲聊。"},
      traits:[{id:"bounded-service",description:"只处理实际收到的账户业务，不主动投资、赠款、消费或改变授权。",strength:1}],
      values:[{id:"account-mandate",description:permission,strength:1}],emotions:[],attitudes:[],
      goals:[{id:"await-request",description:"等待授权人的明确业务申请；核验后按申请实际转账一次，拒绝超权或重复付款。",priority:0.5,progress:0,target_ids:[],motivated_by_ids:["account-mandate"]}],commitments:[],
    },belief:{local_entities:[],evidence:[],claims:[],bindings:[]}};
    m.know(id,id,`我是${e.name}的支付办理终端，只管理自己账下的真实余额。`);
    m.know(id,e.placement,"终端安装在此营业空间，可在现场提交申请。");
    m.fact(id,"automated-service",true,"普通有范围的支付程序，没有身体行动、战斗、随意联网或机构最高权限。");
    m.fact(id,"interface-mode","voice-request","本终端通过现场对话受理业务：对它直接说出收款人、用途和金额。外部测试终端或未送出的输入草稿不算已收到申请。");
    m.fact(id,"spending-mandate",permission,permission,[id,...authorized]);
    for(const actor of [...authorized,...payees]) {
      m.know(id,actor,`${m.get(actor).name}是已登记的${authorized.includes(actor)?"授权人":"业务收款人"}。`);
      m.know(actor,id,`${e.name}的现场语音支付终端。对它直接说出收款人、金额及用途，即可申请办理；权限取决于账户约定。`);
      if(authorized.includes(actor)) m.believe(actor,id,"voice-service",`这个账户的现场业务由语音终端受理。我可以直接对它说出具体金额、收款人和用途；操作别的设备或只写下草稿不等于已经通知它。`);
    }
    m.believe(id,id,"authorization-rules",permission);
    m.provenance[id].service="original-bounded-payment-program";
  }
}
