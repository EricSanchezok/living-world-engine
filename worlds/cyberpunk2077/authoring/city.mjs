export function authorCity(m) {
  m.entity("night-city", "夜之城", "region", null, "2077 年的沿海都市。公司高楼、居民街区、制造业、夜生活和私人武力相互依赖。时间切片在 V 与杰克共同生活半年之后、《The Rescue》之前。", "P01; P03 pp20-29; S01");
  m.fact("night-city", "epoch", "2077-pre-rescue", "过去固定，劫案与此后的任务结果尚未发生。原作没有确定的这一刻位置采用作者安排，不强制复现后续剧情。");
  const districts = [
    ["watson", "沃森", "工业衰退、移民生活、诊所和贸易挤在一起，企业滨水区有自己的安保。", "D01"],
    ["westbrook", "威斯特布鲁克", "娱乐、商务住宅与有私人保安的精英住区构成不同生活圈。", "D02"],
    ["city-center", "市政中心", "公司总部、金融与高档服务聚集，安全和通行并不对所有人平等。", "D06"],
    ["heywood", "海伍德", "家庭、住房与公共机构密集；不同街区的贫富和治安差异明显。", "D03"],
    ["santo-domingo", "圣多明戈", "工厂、废弃工业设施与工人住宅彼此依存。", "D05"],
    ["pacifica", "太平洲", "未完成的旅游建设与被忽视的居民社区；地方网络和外来武装交错。", "D04"],
    ["badlands", "恶土", "城市外围的道路、营地和工业设施；运输、补给与车队共同维持生活。", "P03 p29; P13"],
  ];
  for (const [id, name, description, source] of districts) m.entity(id, name, "district", "night-city", description, source);
  const neighborhoods = [
    ["northside", "北区工业区", "watson", "废弃厂房与仍在营业的企业、工作住宅相连。", "D01"],
    ["little-china", "小唐人街", "watson", "密集高层住宅、商业与旧医疗设施。", "D01"],
    ["kabuki", "歌舞伎区", "watson", "窄巷与市场；丽姿酒吧、商户、诊所与居民共存。", "D01; S03"],
    ["waterfront", "荒坂滨水区", "watson", "企业港口与装卸设施，进入内部需要相应授权。", "D01"],
    ["japantown", "日本街", "westbrook", "夜场、餐饮、旅店与营业到深夜的街市。", "D02"],
    ["charter-hill", "宪章山", "westbrook", "公司从业者住宅和通勤生活。", "D02"],
    ["north-oak", "北橡区", "westbrook", "高端住宅区，私人访客和服务商也受业主安保约束。", "D02"],
    ["corpo-plaza", "公司广场", "city-center", "荒坂、军用科技、康陶等企业的办公建筑集中。", "D06"],
    ["downtown", "市中心", "city-center", "酒店、办公、餐饮和文娱场所。", "D06"],
    ["wellsprings", "美泉区", "heywood", "日常居住、服务业与公司雇员生活。", "D03"],
    ["glen", "谷地区", "heywood", "政府机构及其周边街区。", "D03"],
    ["vista-del-rey", "丽景区", "heywood", "投资不足的住宅和街头生意；居民仍有具体生活。", "D03"],
    ["arroyo", "河谷区", "santo-domingo", "运作中的工厂、废弃设施与回收生意。", "D05"],
    ["rancho-coronado", "科罗纳多农场", "santo-domingo", "与河谷工业带相连的工人居住区。", "D05"],
    ["pacifica-coast", "太平洲沿岸社区", "pacifica", "临海的居民生活与闲置旅游设施；这是作者使用的区域节点，不宣称精确行政边界。", "D04; author-topology"],
    ["dogtown", "狗镇", "pacifica", "有墙和关卡的城区，汉森依靠幽冥犬与走私利益维持统治。", "P02; P03 pp27-28,49"],
  ];
  for (const [id, name, parent, description, source] of neighborhoods) m.entity(id, name, "neighborhood", parent, description, source);
  const places = [
    ["kabuki-market", "歌舞伎市场", "kabuki", "零件摊、食物、日用品与灰色交易；同一街市并非所有商户都做非法生意。", "D01; S03"],
    ["lizzies", "丽姿酒吧", "kabuki", "莫克斯经营的夜场与超梦生意；后台和工作间不是公开区域。", "P01; S03; S10"],
    ["judy-workshop", "朱迪的超梦工作间", "lizzies", "编辑设备、工作椅与待处理素材；需得到主人的许可。", "S10"],
    ["misty-shop", "米丝蒂的灵性用品店", "little-china", "香、饰物与供人歇脚交谈的空间；占卜是文化与交流，不是预知一切。", "P03 p43; author-topology"],
    ["vik-clinic", "维克多的诊所", "little-china", "与米丝蒂的店相通的义体诊所；诊疗、手术与器材需要专业安排。", "P03 p43; author-topology"],
    ["afterlife", "来生", "little-china", "罗格经营的佣兵与中间人社交场所；每份委托背后有客户与风险。", "P03 p46; P12; author-topology"],
    ["all-foods", "全食品工厂", "northside", "漩涡帮占据的工业场地，交易、武器和首领之间的冲突聚集于此。", "S02"],
    ["brick-room", "工厂内的封闭房间", "all-foods", "从厂房进入的封闭空间，不能只知道名字就隔墙接触其中的人。", "S02"],
    ["totentanz", "死亡之舞", "northside", "漩涡帮活动圈中的酒吧，音乐和暴力威慑并存。", "D01"],
    ["konpeki", "绀碧大厦", "waterfront", "高端酒店；套房、服务区与安全网络有不同权限。", "S11; author-topology"],
    ["konpeki-suite", "赖宣租用的酒店套房", "konpeki", "安保与私人事务交汇的套房；物品位置与保密不能由外人全知。", "S10; S11"],
    ["regina-office", "瑞吉娜的办公点", "kabuki", "用于联络客户、核实消息与安排委托的办公空间。", "S06"],
    ["wakako-office", "和歌子的会客处", "japantown", "日本街中间人接洽委托的场所。", "S06; author-interior"],
    ["dino-office", "迪诺的业务会客区", "downtown", "中间人处理客户、表演圈和城区生意的会客空间。", "S06; author-interior"],
    ["padre-office", "神父的街区会客点", "glen", "供伊巴拉与熟人及客户谈事的空间。", "P12; author-interior"],
    ["muamar-garage", "老船长的车库会客点", "rancho-coronado", "车辆、委托和熟人消息在这里汇合。", "S06; author-interior"],
    ["dakota-garage", "达科塔的车库", "badlands", "车队和城市客户交换消息、安排运输的场所。", "S06; P06 p4"],
    ["kerry-home", "克里的住宅", "north-oak", "音乐人的私人住宅；名望不等于允许任意陌生人闯入。", "P03 p46"],
    ["river-office", "警务办公点", "glen", "瑞弗处理工作的一个原创日常办公场景。", "P03 p46; author-interior"],
    ["militech-office", "军用科技地区办公区", "corpo-plaza", "办公室、安保与调查工作分区；部门之间并不共享全部信息。", "D06; S02; author-interior"],
    ["arasaka-office", "荒坂地区办公区", "corpo-plaza", "受控的企业工作空间；职位、家族关系和行动授权各有边界。", "D06; author-interior"],
    ["dogtown-market", "狗镇市场", "dogtown", "商户、居民与走私运输的交接场所。", "P02; author-interior"],
    ["dogtown-checkpoint", "狗镇通行检查站", "dogtown", "幽冥犬维持的通道；货物、身份、利益与武力影响通行。", "P02; author-interior"],
    ["hansen-command", "汉森的事务空间", "dogtown", "处理统治与贸易事务的受控内区；具体房间为作者安排。", "P02; author-interior"],
    ["alex-bar", "亚历克斯经营的酒吧", "dogtown", "居民能在这里点饮料、交换日常消息；经营者的秘密职业不写在招牌上。", "P03 p48"],
    ["reed-club", "李德工作的夜场", "dogtown", "夜场入口与值班区；普通客人只知道这里有一位保安。", "P03 p48; author-interior"],
    ["hands-office", "汉兹的私人会客室", "dogtown", "须有约定才能进入的会客场所；房间为作者安排。", "P03 p49; author-interior"],
    ["nomad-camp", "城外车队临时驻地", "badlands", "原创的临时停靠与维修节点；不声称是原作阿德卡多固定营地坐标。", "original"],
    ["panam-stop", "帕南暂住的车旅停靠点", "badlands", "用于这一时点的原创落脚空间，保留她与家族的关系。", "P01; author-staging"],
    ["independent-lounge", "独立工作者休息室", "little-china", "可租用的安静房间与消息终端，原创佣兵日常节点。", "original"],
    ["offshore", "夜之城之外", "night-city", "地图外远景，不与市内道路直接相通；远行需要实际运输与时间。", "author-topology"],
    ["arasaka-japan", "荒坂在日本的事务空间", "offshore", "三郎、华子与竹村在此版本初始时点的远景安排；不是可从街角步行到达的房间。", "P03 pp44,46; author-staging"],
    ["nusa-office", "NUSA 总统事务空间", "offshore", "迈尔斯与宋昭美在这一初始切片的远景安排；具体行程不冒充正典日期。", "P02; author-staging"],
    ["cassel-stop", "卡塞尔兄妹的境外临时住处", "offshore", "国际工作者的远景安排；两人此时没有被强制送到狗镇任务现场。", "P03 p49; author-staging"],
    ["old-net", "被隔离的旧网远景", null, "数字领域，不能以肉身走入；接入须有设备、路径、防护与真实条件。", "S18; conservative-adaptation"],
  ];
  for (const [id, name, parent, description, source] of places) m.entity(id, name, "place", parent, description, source);
  const groups = [
    ["arasaka", "荒坂", "arasaka-office", "大型企业与家族权力结构，内部成员并非共享一切目标。", "D01; D06; P03 p46"],
    ["militech", "军用科技", "militech-office", "军事技术与企业利益体系，调查与采购部门各负其责。", "D06; S02"],
    ["kang-tao", "康陶", "corpo-plaza", "夜之城主要企业之一；具体部门需要通过接触了解。", "D06"],
    ["biotechnica", "生物技术", "corpo-plaza", "城市企业体系中的一员，雇员与资产不等于全知组织人格。", "D06"],
    ["petrochem", "石油化工", "corpo-plaza", "工业与企业事务的一方。", "D06"],
    ["nusa", "新美利坚合众国", "nusa-office", "迈尔斯担任总统的国家；夜之城与狗镇有自己的政治条件。", "P02; P03 p49"],
    ["fia", "联邦情报局", "nusa-office", "NUSA 的情报机构，特工身份和任务并非公众知识。", "P03 p48"],
    ["ncpd", "夜之城警察局", "glen", "地区警务覆盖、实际资源与私人安保并不相同。", "D03; D04"],
    ["trauma-team", "创伤小组", "city-center", "提供有合同条件的武装医疗服务；不保证任意人都可免费调用。", "S01"],
    ["netwatch", "网络监察", "city-center", "网络事务与调查的参与者，其具体权限须有证据。", "S18"],
    ["maelstrom", "漩涡帮", "northside", "重度义体文化、工业空间与内部权力斗争。", "D01; S02"],
    ["tyger-claws", "虎爪帮", "japantown", "街头组织与夜生活生意有联系。", "D01; S04"],
    ["valentinos", "瓦伦蒂诺帮", "heywood", "重视圈内联系的街头组织，杰克曾是成员。", "D03; P03 p43"],
    ["sixth-street", "六街帮", "santo-domingo", "有退伍军人起源的街头组织，地方保护与利益控制交织。", "D05; S04"],
    ["mox", "莫克斯", "lizzies", "以丽姿为中心的自卫与职业社群，资源与保护范围有限。", "P01; S04"],
    ["voodoo-boys", "巫毒帮", "pacifica-coast", "有海地社群背景的网络技术组织；秘密计划不属于公众知识。", "D04; S18"],
    ["animals", "动物帮", "pacifica", "以身体强化与战斗工作见长的组织，不独占整个太平洲。", "S04"],
    ["scavengers", "清道夫网络", "watson", "涉及绑架与非法义体回收的多个团伙，不设置虚构的全城统一首领。", "D01; S01"],
    ["aldecaldos", "阿德卡多", "badlands", "流浪者家族网络；成员有彼此不同的生活目标。", "P01; S04"],
    ["wraiths", "Wraiths 掠夺团伙", "badlands", "威胁城外运输与小群体的掠夺者。", "S04"],
    ["barghest", "幽冥犬", "hansen-command", "汉森赖以统治狗镇的武装组织。", "P02; P03 p49"],
    ["fixer-network", "中间人职业网络", "night-city", "彼此独立的委托人脉网络；不是统一公会，不共享全知。", "P12; S06"],
  ];
  for (const [id, name, parent, description, source] of groups) m.entity(id, name, "organization", parent, description, source);
  for (const [id] of districts) {
    m.reference(id, "route", "night-city", "可通过城市交通与其他片区往来，必须考虑具体路线、交通和时间。");
    m.reference("night-city", "route", id, "城市道路与运输连接该片区，不代表瞬移。");
  }
  for (const [left, right] of [["misty-shop", "vik-clinic"], ["kabuki-market", "lizzies"], ["all-foods", "brick-room"], ["dogtown-checkpoint", "dogtown-market"], ["nomad-camp", "dakota-garage"]]) {
    m.reference(left, "passage", right, "两处存在可通行的连接；门禁、距离和实际条件仍需满足。");
    m.reference(right, "passage", left, "两处存在可通行的连接；门禁、距离和实际条件仍需满足。");
  }
  for (const id of ["waterfront", "konpeki-suite", "arasaka-office", "militech-office", "hansen-command", "dogtown-checkpoint", "arasaka-japan", "nusa-office"]) {
    m.fact(id, "restricted-access", true, "内区需要对应身份、许可或经过实际裁决的进入方式。知道地点名称不等于取得通行权。");
  }
}
