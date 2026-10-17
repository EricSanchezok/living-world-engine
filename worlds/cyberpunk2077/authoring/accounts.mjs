// Ordinary payment software is modeled as a bounded service Agent, not an autonomous rogue AI.
export function authorAccounts(m) {
  const accounts=[
    ["heir-fund",["heir","elena"],["marco","inez"],"维修费用须有诺亚与埃琳娜的共同批准，核对报价后支付。任何一人都无权私提全部余额。"],
    ["lead-budget",["lead","mina"],["ada","pavel"],"艾登有单笔不超过 10000 欧元的既定项目采购权，超过此额须米娜确认。对艾达的首批控制器采购在项目范围内；仍须本人发出明确付款申请。"],
    ["fleet-reserve",["fleet","raul","jo"],["mei","parts-merchant"],"米卡可以支付已核对的日常燃油与维修费用，大额资产出售或分红须三位共有人同意。"],
    ["partner-wages",["partner","marta"],["nela"],"优先发放已确认的工资；维护与其他用途须朱尔斯与玛尔塔共同同意，不允许私吞工资资金。"],
    ["manager-fund",["manager","rin","bex"],["paulo"],"按三名成员确认的演出预算支付场租和器材，不单凭经纪人要求交出全款。"],
    ["reporter-expenses",["reporter","leila"],["amara","taxi-driver"],"伦可以支付单笔不超过 1200 欧元的实际交通、材料核验或采访开支；其他用途须莱拉批准，不购买假证词。"],
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
