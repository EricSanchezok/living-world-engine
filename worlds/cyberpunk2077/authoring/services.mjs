// Named supporting actors are original residents, not replacements for canon leaders.
export function authorServices(m) {
  const residents = [
    ["food-vendor","米拉·宋","kabuki-market","经营熟食与补给的小摊主。","卖出有真实库存的食品并按时进货。",{persuasion:3},"editor","老客户会买夜班食品。"],
    ["parts-merchant","奥马尔·里德","kabuki-market","出售通用工业零件的独立商人。","核对零件编号，靠可靠供货做长期生意。",{craft:4},"bo","两人会互相询问缺货型号。"],
    ["taxi-driver","娜迪亚·沃克","downtown","拥有一辆营运车的独立司机。","接到合适行程并覆盖燃料与维修成本。",{driving:5},"reporter","送过记者采访，按里程和等待时间议价。"],
    ["housing-agent","阿梅莉·郑","glen","管理几套普通租房的代理人。","匹配住户与空房，取得约定服务费。",{persuasion:4},"elena","交换过街区租赁行情，没有处分彼此房屋的授权。"],
    ["clinic-supplier","索菲·贝尔","wellsprings","经营正规基础医材的供应商。","按采购凭据供应耗材，保证库存可追溯。",{medicine:3},"lena","有普通医材采购往来。"],
    ["public-clerk","莫·迪亚兹","river-office","处理报案登记的普通警务文员。","如实登记材料、分流案件，不许诺自动结案。",{investigation:3},"river","工作同事，文员负责流程而不代替侦查。"],
    ["gig-client","赛拉·森","muamar-garage","需要工业检测帮助的小企业客户。","请可靠技师核对仓库设备故障，再按合同付款。",{persuasion:3},"muamar","初次委托正在核验，尚无成交保证。"],
    ["mox-worker","薇·马丁","lizzies","莫克斯的场内工作人员。","维持客人秩序，保护同事并按排班完成工作。",{streetwise:4,combat:3},"judy","知道工作间预约流程，不知道朱迪朋友的一切秘密。"],
    ["voodoo-runner","艾蒂安·杜瓦","pacifica-coast","巫毒帮外围网络维护人员。","修好本地联络设备，避免外人套取网络位置。",{netrunning:5,insight:3},"parts-merchant","曾用公开身份采购通用配件，没有交换内部网络图。"],
    ["tyger-collector","石田莲","japantown","虎爪帮一处夜场的收账人员。","按自己负责的生意追讨款项，避免惹来高额损失。",{combat:4,persuasion:3},"wakako","知道中间人的名望，有有限业务往来而非指挥她的权力。"],
    ["animal-guard","泰丝·芬奇","pacifica-coast","动物帮背景的雇佣保安。","履行眼前场地安保合同，拿到报酬。",{combat:6},"broker","曾就仓位短期安保谈过报价，尚未签约。"],
    ["netwatch-analyst","阿里·纳维德","downtown","网络监察的普通地区技术分析员。","核对局部异常流量，区分证据与推测。",{netrunning:6,investigation:4},"river","有正式工作联络渠道，只交换有授权的材料。"],
    ["scav-lookout","罗曼·克罗尔","scav-apartment","参与非法拆卸团伙的看守。","隐瞒犯罪现场与被囚者，避免执法和同行威胁。",{combat:3,streetwise:3},"parts-merchant","曾兜售来源不明零件，被要求出示合法来源而未成交。"],
    ["wraith-scout","拉克·莫罗","badlands","Wraiths 小股团伙的侦察者。","寻找可以牟利的运输目标，同时避开强于自己的队伍。",{driving:5,combat:4,stealth:4},"animal-guard","有过一次保安转介，没有互相听命关系。"],
  ];
  for(const [id,name,place,description,goal,ratings] of residents) m.person({id,name,place,description,persona:description,voice:"根据现场信息与个人利益具体交谈。",goal,value:goal,ratings,cash:2400});
  for(const [id,,,,,,other,history] of residents) m.relationship(id,other,"local-acquaintance",history,"希望往来有明确边界。","只对已有经历作判断，不自动信任对方所有要求。");
  for(const [actor,organization] of [["mox-worker","mox"],["voodoo-runner","voodoo-boys"],["tyger-collector","tyger-claws"],["animal-guard","animals"],["netwatch-analyst","netwatch"],["scav-lookout","scavengers"],["wraith-scout","wraiths"],["public-clerk","ncpd"],["emil","barghest"]]) {
    m.reference(actor,"affiliation",organization,"具体成员的组织背景，不代表其能命令全部组织。",actor==="scav-lookout" ? "private" : "public");
    m.believe(actor,organization,"affiliation","我与这个组织有工作或成员关系，只拥有具体职责的权限。");
  }
  const exchanges=[
    ["food-vendor","food-stock","摊位日用补给","stock","可购买的食品与饮水，价格须与摊主商议。","provisions",60],
    ["parts-merchant","parts-stock","商户通用配件","stock","可按型号交易的普通零件，不保证满足所有特殊设备。","components",40],
    ["clinic-supplier","medical-stock","供应商基础医材","stock","适合基础处理的库存，需要真实购买或取得使用同意。","medical-supply",45],
    ["taxi-driver","taxi","娜迪亚的营运车","vehicle","普通道路车辆，司机可提供有偿行程，乘客不会获得车辆产权。","fuel",35],
  ];
  for(const [owner,id,name,kind,description,quantity,amount] of exchanges) {
    m.entity(id,name,kind,m.get(owner).placement,description);m.own(owner,id);m.stock(owner,id,quantity,amount);
  }
  m.fact("food-stock","asking-price",25,"一份日用补给当前报价 25 欧元，可谈批量与交换条件。");
  m.fact("parts-stock","asking-price",120,"一单位通用组件当前报价 120 欧元，特殊型号另询。");
  m.fact("medical-stock","asking-price",90,"一份基础医材当前报价 90 欧元。");
  m.quantity("gig-client","eurodollar",5400);
  m.contract("inspection-gig","仓库设备检测邀约","muamar-garage",["gig-client","muamar"],"客户从实际持有资金中预备 3000 欧元待协商，只先邀请诊断，详细设备与范围须现场核实。可以介绍合适技师，未验收不可视为成交收入。");
  for (const [left,right,history] of [
    ["lin","vik","两位医生有过普通同行交流，可以转介超出自身范围的病例。"],
    ["raul","dakota","曾通过达科塔核实城外货运机会，无永久优先权。"],
    ["celia","mox-worker","在小型放映安排中交换过场地消息。"],
    ["leila","regina","有职业上的消息核验联系，彼此不公开消息源。"],
    ["paulo","dino","谈过演出场地需求，没有包下所有城区业务。"],
    ["vera","hands","通过汉兹的业务渠道提交过小宗贸易需求，未成为私人亲信。"],
    ["nela","muamar","技师向中间人登记过普通检修能力。"],
    ["mei","jun","仓库经理与买家有正常交货往来。"],
    ["marta","felix","两名工人曾比较旧设备维护记录，尚不掌握彼此全部工作。"],
  ]) m.relationship(left,right,"professional-channel",history,"愿继续有边界的职业合作。","可核实需求再决定，不提供无条件服务。");

  const kit=(owner,suffix,name,kind,description,placement=owner)=>{
    const id=`${owner}-${suffix}`;m.entity(id,name,kind,placement,description);m.own(owner,id);return id;
  };
  for(const owner of ["v","jackie","panam","river","reed","alex","takemura","royce","dum-dum","grant","scav-lookout","wraith-scout"]) {
    kit(owner,"sidearm","常备动能武器","weapon","可用但弹药有限的常备动能武器，需要实际瞄准、射界与弹药。");m.quantity(owner,"ammunition",30);
  }
  for(const owner of ["t-bug","judy","vik","aurore","aymeric","voodoo-runner","netwatch-analyst"]) kit(owner,"worktools","专业工作设备","equipment","与使用者职业对应的工具和接口，功能需要实际权限、材料和接触路径。");
  const smasherBody=kit("smasher","body","重锤的全身作战义体","cyberware","重型装甲与作战义体，能承受普通人难以承受的伤害；不免疫所有武器，也不能隔城攻击。");
  m.fact(smasherBody,"installed",true,"身体的一部分；拆卸必须满足真实伤损或专业程序。");
  m.fact(smasherBody,"armor","heavy","轻型武器效果须依据装甲和命中部位裁定，不能只比较所有人的生命上限。");
  kit("smasher","weapon","义体配套重型武器","weapon","供作战义体使用的重型武器；有弹药、射界和现场风险。",smasherBody);m.quantity("smasher","ammunition",120);
  const trap=kit("royce","detention-lock","布里克囚室的拘禁装置","equipment","门禁与现场危险限制离开，解除须检查线路和实际控制点。","brick-room");
  m.reference(trap,"confines","brick","现场的真实拘禁约束，不会只凭口头声称自由而消失。","private");
  m.commitment("scav-lookout","监视被囚者并防止其向外求援；实际行动仍受现场能力限制。",["sandra","scav-apartment"]);
  for(const [holder,container,definition,amount] of [
    ["heir","heir-seal-stock","components",2],
    ["medic","medic-kit","medical-supply",8],
    ["partner","partner-stock","industrial-blank",36],
    ["partner","partner-output","trial-housing",0],
    ["owen","partner-customer-stock","trial-housing",0],
    ["nela","partner-sensor-stock","interlock-sensor",1],
    ["ada","lead-controllers","control-unit",6],
    ["lead","lead-received-stock","control-unit",0],
    ["tessa","operator-spares","components",2],
    ["fleet","fleet-cargo","cargo-unit",4],
    ["fleet","fleet-regular-cargo","industrial-freight-unit",6],
    ["freight-receiver","fleet-destination","cargo-unit",0],
    ["freight-receiver","fleet-destination","industrial-freight-unit",0],
    ["raul","fleet-valve-stock","cooling-valve",1],
    ["grant","armorer-crate","watch-gear-unit",3],
    ["watch-registrar","armorer-registry-office","watch-gear-unit",0],
    ["broker","broker-batch","control-cargo-unit",4],
    ["freight-receiver","broker-received-stock","control-cargo-unit",0],
    ["fleet","fleet-flatbed","fuel",40],
    ["jo","fleet-boxtruck","fuel",40],
    ["raul","fleet-reefer","fuel",40],
    ["broker","broker-van","fuel",25],
  ]) m.stock(holder,container,definition,amount);
  for (const e of m.entities.values()) if(e.agent) {
    m.believe(e.id,e.id,"available-cash",`我有 ${e.quantities.find(q=>q.definition_id==="eurodollar").amount} 欧元个人可用资金，其他账户须按各自约定使用。`);
    let parent=m.get(e.placement);
    for(let depth=0;depth<4&&parent;depth++) {
      m.know(e.id,parent.id,`我所在的${parent.name}及通向外侧的日常路径。`);
      parent=parent.placement ? m.get(parent.placement) : null;
    }
  }
}
