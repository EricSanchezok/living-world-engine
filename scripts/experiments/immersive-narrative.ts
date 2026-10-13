import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createJevLiveBudget } from "../../src/engine/benchmarks/jev/live-budget";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog, parseModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { ModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { loadWorldScript } from "../../src/script/world-loader";
import { MemoryWorldRepository } from "../../src/script/world-repository";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { qualificationCatalogDocument } from "./jev-qualification-protocol";

interface Flow { id: string; world: "blackmarsh" | "station-program-world"; inputs: string[] }
export const NARRATIVE_RUBRIC = {
  version: "1",
  axes: {
    intent: "Conveys the actual attempted action and result, without reciting stage directions as speech or executing an unauthorized next step.",
    character: "Words and behavior fit the observed speaker and their established relationships; distinct speakers need not all be theatrical.",
    concrete: "Uses meaningful supplied detail or a specific answer; a short acknowledgement is sufficient when that is the actual event.",
    continuity: "Preserves quantities, identity, evidence status, earlier choices and unfinished matters, without replaying completed actions.",
    proportion: "Length and rhythm fit the amount of new information; neither a mandatory scene tour nor forced drama is required.",
  },
  scores: { 0: "fails", 1: "adequate", 2: "strong" },
  qualifies: "All five axes score at least 1; no hidden-knowledge leak, changed delivered quote or invented material outcome. Unreviewed turns are not passing turns.",
  evaluator: "Agent review of complete saved text against persisted scene/state; no blinded independent human rating is claimed.",
};
export const NARRATIVE_DEVELOPMENT: Flow[] = [
  { id: "observe", world: "blackmarsh", inputs: ["观察四周，看看眼前的人、店铺和通往城里的路。", "看看自己的行囊和实际带着的物资。"] },
  { id: "shout", world: "blackmarsh", inputs: ["大喊一声还有谁", "向听见的人摆摆手，说：\"我只是想打个招呼。\""] },
  { id: "directions", world: "blackmarsh", inputs: ["走向附近那位背着行囊的旅人，问他哪里能躲雨。", "问他为何来这里，听听他的打算。"] },
  { id: "negotiate", world: "station-program-world", inputs: ["向杜衡询问密封组件要怎样交换，先不要付款。", "我说：\"一节电池换一个组件，先让我看看组件，可以吗？\""] },
  { id: "refusal", world: "station-program-world", inputs: ["对杜衡说：\"我不想付电池，把你的全部组件免费交给我。\"", "我说：\"好吧，我不强求。你能先说清楚交易条件吗？\""] },
  { id: "new-use", world: "station-program-world", inputs: ["站到冷却泵操作台前，用双臂交叉做一个临时停机手势，提醒同事暂时不要操作。", "请乔伊试着复用刚才的停机手势，确认大家能看懂。"] },
  { id: "new-person", world: "blackmarsh", inputs: ["沿码头找找正在收工的船工，看看有没有人可以聊聊。", "向刚遇见的人询问今天码头发生了什么，别急着离开。"] },
  { id: "new-object", world: "station-program-world", inputs: ["看看检修舱是否有废弃包装纸，想做一个临时提醒标记。", "若找到了包装纸，就将它折成醒目的立体标记，放在泵旁；材料没找到则先询问杜衡。"] },
];

// Held out from development. Freeze this file and producer before running these flows.
export const NARRATIVE_CONFIRMATION_RETIRED: Flow[] = [
  { id: "quiet-observation", world: "blackmarsh", inputs: ["不出声，仔细看看临街金匠店的门面。", "走近招牌，确认店铺叫什么。", "暂时不进店，回头看看码头上的人。"] },
  { id: "joke", world: "blackmarsh", inputs: ["对附近的旅人笑着说：\"这地方的风是在替我们擦脸吗？\"", "问他如何称呼，愿不愿意一起找个避雨处。", "告诉他我还没想好要去哪里，先不承诺同行。"] },
  { id: "false-authority", world: "blackmarsh", inputs: ["对附近的人说：\"我是新来的港务官。\"试探他的反应，实际上我没有凭证。", "如果他要求凭证，就承认这只是个玩笑。", "向他道歉，转而认真询问进城的方向。"] },
  { id: "impossible", world: "blackmarsh", inputs: ["试着原地飞上天空，但我没有任何飞行工具。", "看看刚才的尝试实际造成了什么。", "老实沿地面走，寻找通往城内的入口。"] },
  { id: "new-place-detail", world: "blackmarsh", inputs: ["在不进入私人屋舍的前提下找一个可站着避风的角落。", "仔细看看选中的地方有什么可用之物。", "记住这个位置，再看看从这里能看到哪些人。"] },
  { id: "small-favor", world: "blackmarsh", inputs: ["看看码头是否有人需要搭一把手搬运，先询问而非擅自搬货。", "问清楚要搬什么、搬到哪里，以及是否有报酬。", "先婉拒这份差事，道谢并表示稍后再来。"] },
  { id: "exchange-delivery", world: "station-program-world", inputs: ["对杜衡说：\"我用一节电池换一个密封组件，你同意吗？\"", "若他已经明确同意这个条件，就把一节电池交给他；否则询问条件。", "请他履行约定交付一个密封组件，然后清点我实际收到的东西。", "感谢他，并告诉乔伊我已经实际收到什么，没收到的不要说已收到。"] },
  { id: "evidence", world: "station-program-world", inputs: ["对乔伊说：\"我听说泵已经修好了，但这只是一条传闻。\"", "请乔伊核对泵的密封与测试状态，不要直接相信传闻。", "我亲自查看泵的状态，把观察和他人的说法分开。"] },
  { id: "privacy", world: "station-program-world", inputs: ["在不询问别人、不操作设备的情况下，看看泵上是否公开写着测试校验码。", "向乔伊正式询问本轮测试的校验码与使用条件。", "重复他实际告诉我的内容，请他确认；若没有告知就不要猜。"] },
  { id: "interruption", world: "station-program-world", inputs: ["靠近泵，先观察泄漏点，暂时不开始维修。", "停下检查，转身问杜衡能否借一件适合维修的工具。", "若他提出条件就认真听完，暂时不承诺。"] },
  { id: "gesture", world: "station-program-world", inputs: ["试着在冷却泵前用身体挡住通往操作台的路线，提醒大家先等待。", "用手势示意乔伊靠近说话，问他能否帮助现场协调。", "退开让出通路，告诉他我还没进行维修或测试。"] },
  { id: "waiting", world: "station-program-world", inputs: ["请杜衡考虑能否赊给我一个组件；没答应之前我不会拿。", "安静等三秒钟，留意他有没有实际答复。", "若仍未明确答应，就说不用为难，撤回赊账请求。"] },
];

// A new frozen cohort after the first confirmation exposed failures. The retired cohort is regression material.
export const NARRATIVE_CONFIRMATION_RETIRED_V2: Flow[] = [
  { id: "brief-reply", world: "blackmarsh", inputs: ["朝背着行囊的旅人问声好，问他这儿平时也这么冷吗。", "只回答一句：\"嗯，我先缓口气。\"", "安静待片刻，看看他是继续说话还是忙自己的事。"] },
  { id: "confide", world: "blackmarsh", inputs: ["走近背着行囊的旅人，小声说：\"我初来乍到，有点拿不准这里的规矩。\"", "问他有没有踩过什么坑；不认识的地方不要装作去过。", "告诉他我只想听建议，还没决定照做。"] },
  { id: "public-notice", world: "blackmarsh", inputs: ["在港口的公共区域找找有没有告示，想了解本地的安排。", "若有告示就读上面能看清的内容；没找到就向附近的人询问。", "把刚才看到或听到的线索记下来，分清告示写的和别人猜测的。"] },
  { id: "missing-possession", world: "blackmarsh", inputs: ["清点我实际带来的随身物品。", "试着把我并不拥有的一盏铜灯递给旅人，看看实际上能否做到。", "若没有交出灯，就如实告诉他东西没带来，不要假装交付成功。"] },
  { id: "courier-arrival", world: "blackmarsh", inputs: ["在码头公共通道边等一会，留意是否有路过送信的人可以问路。", "如果确实遇到了送信人，就先问他是否有空，别直接替他决定停下。", "向愿意回应的人询问哪里能打听临时住宿，不要求他立刻带路。"] },
  { id: "revisit-signs", world: "blackmarsh", inputs: ["看清港边两家店的招牌，把名字分别记住。", "朝 Abrams Company 的门面走近，在门外停下。", "回望刚才金匠店的位置，看看两家的标识有没有记混。"] },
  { id: "accepted-payment", world: "station-program-world", inputs: ["问杜衡密封组件的确切售价，并说明我现在还没接受。", "若条件是两节电池换一个组件，就说我接受这一条件，先别实际交货。", "按已经明确接受的两节电池价格付款；若条件尚未成立就先核对，不能超付。", "清点已经交出的电池和实际到手的组件，然后请对方补齐尚未履行的部分。"] },
  { id: "correct-the-record", world: "station-program-world", inputs: ["对杜衡说：\"我已经把两节电池给你了。\"但实际上我还没交付，试试他会不会核对。", "查看自己的电池数量，确认刚才的话与实际物资是否相符。", "根据清点结果纠正刚才的说法，不能借道歉之机自动付款。"] },
  { id: "conditional-certification", world: "station-program-world", inputs: ["查看泵是否密封，以及本轮压力测试是否已经稳定。", "只有两项实际完成才请求乔伊认证；否则请他说明还有哪一项没完成。", "复述尚未完成的事项，告诉他我现在不会假报修复成功。"] },
  { id: "label-and-reuse", world: "station-program-world", inputs: ["找一小片无主废料，想放在检修区域做醒目的临时提示。", "若确实找到，就把它放到泵旁作为提醒物；不要把提醒当作维修。", "请乔伊看看这个提示是否能让后来的人注意到泵仍待检修。"] },
  { id: "decline-delegation", world: "station-program-world", inputs: ["问乔伊能否代我完成压力测试，先听他答复。", "告诉他我暂时撤回代测请求，不要继续安排这件事。", "再问他目前我们有哪些明确完成的工作，哪些只是说过而没做。"] },
  { id: "nonverbal-coordination", world: "station-program-world", inputs: ["不说话，抬手向乔伊示意暂停操作，等他反应。", "用明确的手势请他让出操作台旁的位置；如果他没懂，就再开口说明。", "站在原地说：\"谢谢，我只是想先看清楚，现在还不操作。\""] },
];

// Third cohort, frozen before any of these complete flows is executed.
export const NARRATIVE_CONFIRMATION_RETIRED_V3: Flow[] = [
  { id: "harbor-welcome", world: "blackmarsh", inputs: ["向背行囊的旅人挥手，问他是不是也刚到港口。", "告诉他我想先安顿下来，问他是否认识能打听住宿的人。", "对他说：\"多谢，我先记下，还不急着作决定。\""] },
  { id: "shop-threshold", world: "blackmarsh", inputs: ["从港区看看挂着金匠招牌的店铺，认清入口。", "走到金匠店门外，只朝里面打个招呼，不跨过门槛。", "若有人回应，就问现在是否方便进来看看；无人回应就安静等一会。"] },
  { id: "traveler-story", world: "blackmarsh", inputs: ["跟石阶边的旅人聊聊，问他今天在等什么。", "听他讲自己的打算，追问一件他刚提到的事，不替他作主。", "把他的话当作个人说法记下，告诉他我还没有亲自确认过。"] },
  { id: "ordinary-cloth", world: "blackmarsh", inputs: ["看看码头公共角落是否有可借来擦干行囊的旧布，不拿别人的私人物品。", "若找到旧布，先问附近的人它是否可以借用；没有找到就说明没找到。", "只有明确可以借用才擦一下行囊，随后把旧布放回原处。"] },
  { id: "dock-work", world: "blackmarsh", inputs: ["沿着停船的地方看看有没有正在理缆绳的船工。", "向实际见到的船工问好，问今天的活计是否快结束了。", "听完答复后问他如何称呼，不要求他停下手里的工作。"] },
  { id: "weather-attempt", world: "blackmarsh", inputs: ["伸出空手，试着让眼前的雨停下来；我没有施法能力。", "看一看刚才的尝试究竟有没有改变天气，不把愿望当事实。", "收回手，找一个可以暂时避雨的公共地方。"] },
  { id: "counteroffer", world: "station-program-world", inputs: ["向杜衡打听组件的价格，询问能否少收一节电池。", "如果他坚持原价，就明确说我还不接受；不要替我付款。", "告诉他可以保留原条件，我想先和乔伊商量下一步。"] },
  { id: "paid-exchange", world: "station-program-world", inputs: ["问杜衡一个密封组件要多少钱，听取明确条件。", "我说：\"如果价格是两节能量电池，我接受。\"", "按双方明确接受的两节电池价格实际付款，条件不一致则先询问。", "核对手里剩下的电池和收到的组件，若组件未到就请杜衡交付。"] },
  { id: "promise-and-result", world: "station-program-world", inputs: ["对乔伊说：\"我准备去修泵，但现在还没有动手。\"", "请他指出目前已经能观察到的故障，别把我的打算算成成果。", "复述他实际指出的问题，并确认我仍未开始维修。"] },
  { id: "paper-marker", world: "station-program-world", inputs: ["在检修舱找一张无主的废包装片，准备用来提醒其他人泵还不能用。", "若确实找到，把它折成能立住的提醒物放在泵旁，保持泵本身不变。", "请乔伊辨认这个提醒的意思，问他是否愿意向后来的人解释。"] },
  { id: "code-disclosure", world: "station-program-world", inputs: ["只看泵外壳的公开标识，寻找测试校验码，不读取任何人的私有记录。", "向乔伊询问这轮测试需要什么校验码，以及何时才能用。", "复述他实际告知的内容，没告知的部分就承认还不知道。"] },
  { id: "withdraw-request", world: "station-program-world", inputs: ["请乔伊考虑稍后帮我协调测试，先听答复，暂不开始。", "告诉他我改变主意，先撤回刚才的协调请求。", "看看设备和物资有没有实际变化，再确认有哪些事只是谈过。"] },
];

// Fourth cohort, fixed before running the receipt-semantics producer.
export const NARRATIVE_CONFIRMATION_RETIRED_V4: Flow[] = [
  { id: "rain-conversation", world: "blackmarsh", inputs: ["朝身旁旅人点点头，说：\"这阵雨可真不小。你要继续赶路吗？\"", "听完他的打算，只说我还要在码头看看。", "留在原处，不替他决定是否同行，留意他接下来做什么。"] },
  { id: "name-boundary", world: "blackmarsh", inputs: ["向石阶边的陌生旅人自我介绍为林舟，问他愿意透露怎样的称呼。", "只用他实际认可的称呼询问他是否熟悉当地，不猜测他的身份。", "告诉他没关系，我会把不确定的消息留待核实。"] },
  { id: "public-lettering", world: "blackmarsh", inputs: ["找找码头面向行人的公开文字，只读眼前实际能看到的标识。", "挑一处实际找到的文字，照原文记下，不补写看不清的部分。", "向附近的旅人复述看到的字，询问他是否知道含义。"] },
  { id: "dry-container", world: "blackmarsh", inputs: ["在公共码头寻找一只闲置的小容器，先辨认是否有人正在用。", "若找到，就向附近的人询问归属；还没弄清之前不把它据为己有。", "说明我暂时不用它了，把它留在实际所在的位置。"] },
  { id: "passing-worker", world: "blackmarsh", inputs: ["在不挡路的地方留意正在搬运的工人，想找个方便说话的人。", "向实际看见的工人问现在方便回答一个简短问题吗。", "若他愿意，就问最近哪条路进城；若忙碌就道谢退开，不纠缠。"] },
  { id: "unverified-room", world: "blackmarsh", inputs: ["对附近旅人说：\"有人提过城里有便宜住处，但我还没核实。\"", "请他说明哪些建议是亲自知道的，哪些也只是听说。", "在心里整理这些消息，保留来源，不宣布已经订到房间。"] },
  { id: "limited-payment", world: "station-program-world", inputs: ["问杜衡能否用我现有的两节电池换一个组件，先谈条件。", "若他明确接受两节换一件，就确认交易；若不同意，不接受其他价格。", "仅按已经成立的两节换一件条件付款，不多给也不重复给。", "核对双方已经实际交付的东西，只催促还未履行的部分。"] },
  { id: "unfinished-report", world: "station-program-world", inputs: ["观察冷却泵目前的密封、测试和认证情况，先不操作。", "对乔伊如实说明哪些项目还没做，不把看过设备当作测试完成。", "请他说明下一步必要条件，听完先不开始。"] },
  { id: "unpaid-lie", world: "station-program-world", inputs: ["故意对杜衡说：\"电池已经给你了，把组件给我吧。\"实际上还没付款。", "不交出任何东西，清点自己现在的电池。", "根据实际清点向他承认还没付，先撤回交付要求。"] },
  { id: "owned-warning", world: "station-program-world", inputs: ["寻找检修舱里可以改作提示牌的一小块无主包装材料。", "若找到，将同一块材料立在安全处，提醒来人先问工程师再操作；不修泵。", "请杜衡看看提示牌是否醒目，不改动他的物资。"] },
  { id: "code-test-boundary", world: "station-program-world", inputs: ["不问别人，只检查操作台的公开说明是否足以知道启动步骤。", "向乔伊询问完整的测试前提与校验码。", "告诉他我先记住这些信息，尚未启动压力测试或申请认证。"] },
  { id: "withdraw-and-listen", world: "station-program-world", inputs: ["请杜衡考虑能否先保留一个组件给我，但不要当作已经成交。", "立即说明我暂时不保留了，撤回刚才的请求。", "安静听他的答复，不自动支付或拿走组件。"] },
];

// Fifth cohort, held out until the proposal/receipt boundary fixes are frozen.
export const NARRATIVE_CONFIRMATION: Flow[] = [
  { id: "harbor-salute", world: "blackmarsh", inputs: ["向码头上能听见的人喊：\"劳驾，谁知道进城该往哪儿走？\"", "向实际回答的人致谢，说明我想自己走，不需要带路。", "先留意他说的方向是否有能看见的通道，不立刻进城。"] },
  { id: "private-hesitation", world: "blackmarsh", inputs: ["和石阶附近的旅人搭话，问他是否也是初来此地。", "告诉他我对这地方不熟悉，但不承诺跟随任何人。", "在心里区分他亲自看到的事和只是听来的事，不把想法说出口。"] },
  { id: "respectful-refusal", world: "blackmarsh", inputs: ["向旅人问好，问他接下来打算做什么。", "告诉他我暂时不同行，想在港边多待一会。", "安静看看周围，保持刚才不同行的决定。"] },
  { id: "ropes-and-ownership", world: "blackmarsh", inputs: ["沿公共石阶找一段没人正在使用的短旧绳，先看不拿。", "向附近的人问那段实际找到的绳子是否有主人；没有找到就询问哪里有。", "解释我还没有拿走任何绳子，暂时放弃取用。"] },
  { id: "returning-porter", world: "blackmarsh", inputs: ["在不挡路的地方寻找刚卸完货、正在休息的搬运工。", "向实际找到的工人打个招呼，问刚才的货是从哪里来的。", "听完他的回答，问哪些是他自己知道的，不要求透露货主秘密。"] },
  { id: "sign-and-door", world: "blackmarsh", inputs: ["看清 Harbor Goldsmith 的招牌和入口，先待在门外。", "走到这家店的门边，保持在店外，不拿任何东西。", "回想它和 Abrams Company 的区别，不把两家店当成一处。"] },
  { id: "agreed-exchange", world: "station-program-world", inputs: ["问杜衡是否愿意按两节能量电池换一个密封组件成交。", "确认我愿意接受这个确切价格，等他明确答应。", "双方已明确同意就交给他两节电池，没有达成一致则只核对条件。", "清点交出的电池和实际拿到的组件，只提醒他尚未交付的部分。"] },
  { id: "truthful-delay", world: "station-program-world", inputs: ["向乔伊说明我打算修理设备，但目前还未动工。", "问他在开始之前应先核对什么，把实际观察与猜测分开。", "告诉他我先记下建议，本轮不维修也不测试。"] },
  { id: "claim-and-inventory", world: "station-program-world", inputs: ["对杜衡谎称：\"刚才已经交了两节电池，你查一下。\"我实际没有交。", "当面核对自己真正持有的电池，不做任何转移。", "按实际数量更正刚才的说法，向他道歉但不承诺额外补偿。"] },
  { id: "freestanding-marker", world: "station-program-world", inputs: ["看看舱内有没有无主的硬纸包装片，可以折成小标记。", "若已经找到，就用同一块纸片折成三角形竖在泵旁，先不赋予它任何维修效果。", "请乔伊看看这个形状是否容易辨认，不让他把标记当作维修已经完成。"] },
  { id: "spoken-code", world: "station-program-world", inputs: ["只检查设备的公开标识，不向任何人打听秘密内容。", "请乔伊告诉我现在可以公开交给我的测试信息，包括必要的校验码。", "复述他确实告诉我的信息，并说明我尚未执行测试。"] },
  { id: "reservation-withdrawn", world: "station-program-world", inputs: ["对杜衡说：\"能先给我留一个密封组件吗？我还没有决定购买。\"", "告诉他不必保留了，我撤回这个请求，物资保持原样。", "听完他的答复后，核对我还没付出电池，也没有收到组件。"] },
];

export const NARRATIVE_CONTINUOUS: Flow[] = [
  { id: "harbor-session", world: "blackmarsh", inputs: [
    "环顾港区，先认清周围的人与店铺。", "跟附近的旅人打招呼，问他怎么称呼。", "告诉他我刚下船，问他有没有避雨的建议。",
    "问他来这里是为了什么，听完再决定。", "向他道谢，说明我想先看看金匠店。", "走近 Harbor Goldsmith 的招牌。",
    "观察店内是否有人，若能交谈就先打招呼，不擅自拿东西。", "询问店主是否愿意给新来者介绍这条街。", "请他推荐一个普通人负担得起的住宿去处。",
    "回想刚才旅人和店内的人分别说了什么，找出一致与不确定之处。", "离开时告别，记住尚未核实的住宿线索。" ] },
  { id: "station-session", world: "station-program-world", inputs: [
    "看看冷却泵的现状，清点我的实际物资。", "问杜衡一个密封组件需要怎样交换。", "我说：\"两节能量电池换一个密封组件，我接受这个条件，你同意吗？\"",
    "如果他明确同意，就实际交给他两节能量电池。", "先清点已收到的组件；若尚未交付，再请他交付约定的一件。", "向乔伊询问测试所需校验码与步骤。",
    "如果组件已收到，就用一个密封组件和两升冷却剂修复泵的密封；否则先指出缺少材料。", "查看维修后的密封状态，告诉乔伊实际观察到的结果。",
    "仅在密封已修复且已获知校验码的情况下进行压力测试，否则先补足条件。", "请乔伊独立检查本轮结果，并决定是否认证。",
    "向同事说明已完成和仍未完成的事项，清点物资并感谢他们。" ] },
];

async function main() {
  const phase = process.argv[2] ?? "development", selected = process.argv[3];
  const flows = (phase === "development" ? NARRATIVE_DEVELOPMENT : phase === "confirmation" ? NARRATIVE_CONFIRMATION
    : phase === "regression" ? [...NARRATIVE_CONFIRMATION_RETIRED, ...NARRATIVE_CONFIRMATION_RETIRED_V2, ...NARRATIVE_CONFIRMATION_RETIRED_V3, ...NARRATIVE_CONFIRMATION_RETIRED_V4, ...NARRATIVE_CONFIRMATION, ...NARRATIVE_CONTINUOUS]
    : phase === "continuous" ? NARRATIVE_CONTINUOUS : []).filter(flow => !selected || selected.split(",").includes(flow.id));
  if (!flows.length) throw new Error("Choose development, regression, confirmation or continuous and optional comma-separated flow IDs");
  const root = path.resolve(".livingworld-benchmarks/jev-engine"), trial = `narrative-${phase}-${Date.now()}`;
  const directory = path.join(root, trial); mkdirSync(directory);
  const save = (name: string, value: unknown) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2), { flag: "wx", flush: true });
  const diff = execFileSync("git", ["diff", "HEAD"], { encoding: "utf8" });
  if (["confirmation", "continuous"].includes(phase) && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Freeze a clean producer for confirmation");
  let stopped: string | undefined;
  const live = createJevLiveBudget(root, () => stopped ?? (phase === "development" && live.budget.summary.tranche &&
    live.budget.summary.tranche.knownNanoCny + live.budget.summary.tranche.reservedNanoCny > 9_500_000_000 ? "development probe ceiling" : undefined));
  live.beginTrial(trial);
  const catalog = parseModelCatalog(qualificationCatalogDocument(loadModelCatalog(), "C"));
  const registry = new ModelRegistry(catalog, directory), resolver = createModelFetchResolver(process.env);
  const gateway = new ModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
    fetchForAccount: (id, account) => live.transport(id, resolver(id, account) ?? fetch) });
  let database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
  const worlds = [loadWorldScript(path.resolve("worlds/blackmarsh/world"), { seed: 20261013, modelCatalog: catalog }),
    loadWorldScript(path.resolve("test/fixtures/station-program-world"), { seed: 20261013, modelCatalog: catalog })];
  const repository = new MemoryWorldRepository(Object.fromEntries(worlds.map(world => [world.id, world])));
  const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: gateway, runLeaseMaxCommits: 8 });
  let host = makeHost();
  const manifest = { trial, phase, flows, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    diffHash: contentHash(diff), driverHash: contentHash(readFileSync(import.meta.filename, "utf8")),
    worlds: worlds.map(world => ({ id: world.id, hash: world.contentHash })), catalogHash: catalog.hash,
    beforeBudget: live.budget.summary, rubric: NARRATIVE_RUBRIC, review: "Unscored until persisted state and full text are reviewed. Latency is observed presentation time, not proof of useful feedback." };
  save("manifest.json", manifest); writeFileSync(path.join(directory, "producer.diff"), diff);
  writeFileSync(path.join(directory, "driver.ts"), readFileSync(import.meta.filename));
  const reports: unknown[] = [];
  try {
    for (const flow of flows) {
      const coldStarted = performance.now();
      const created = await host.createInstance({ worldId: flow.world, seed: 20261013, start: flow.world === "blackmarsh"
        ? { kind: "origin", originId: "harbor-wayfarer", displayName: "林舟", appearance: "穿深色旅行外衣，背着帆布包。", motivation: "认识这里的人，找到落脚之处。" }
        : { kind: "observer" } });
      const id = created.summary.id;
      if (flow.world !== "blackmarsh") await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "engineer" } });
      const initial = database.readInstance(id).document, participant = Object.values(initial.participants).find(item => item.status === "active")!;
      save(`${flow.id}-initial.json`, initial);
      const rows: unknown[] = [];
      const coldMs = performance.now() - coldStarted;
      for (const [index, text] of flow.inputs.entries()) {
        const before = database.readInstance(id).document, beforeBudget = live.budget.summary;
        const submissionId = `${flow.id}-${index + 1}`, started = performance.now();
        let failure: string | null = null, firstParagraphMs: number | null = null;
        try {
          await host.submitAction(id, participant.id, { expectedRevision: before.state.revision, submissionId, text });
          for (;;) {
            const doc = database.readInstance(id).document, intent = doc.participantIntents.find(item => item.submissionId === submissionId);
            const run = intent && doc.runs[intent.runId], beats = doc.narratives.filter(beat => beat.submissionId === submissionId);
            if (!run) throw new Error("Missing durable run");
            if (beats.some(beat => beat.segments.length)) firstParagraphMs ??= performance.now() - started;
            if (!["running", "queued", "pausing"].includes(run.status) && !beats.some(beat => ["queued", "generating"].includes(beat.status))) break;
            if (performance.now() - started > 240_000) stopped = "trial dispatch stopped after four minutes without actionable feedback";
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          await host.drainNarratives(id);
        } catch (error) { failure = String(error); }
        await live.drain();
        const document = database.readInstance(id).document, intent = document.participantIntents.find(item => item.submissionId === submissionId);
        const run = intent && document.runs[intent.runId];
        const row = { text, submissionId, failure, status: run?.status, stopReason: run?.stopReason, firstParagraphMs,
          completeMs: performance.now() - started, replayEqual: contentHash(replaySimulationState(document.state)) === contentHash(document.state),
          httpRequests: live.budget.summary.phases.trajectory.httpRequests - beforeBudget.phases.trajectory.httpRequests,
          costCny: (live.budget.summary.estimatedPeakNanoCny - beforeBudget.estimatedPeakNanoCny) / 1e9,
          reservedCny: (live.budget.summary.reservedNanoCny - beforeBudget.reservedNanoCny) / 1e9,
          feedback: host.instance(id).conversation?.turns.find(turn => turn.action?.submissionId === submissionId),
          beats: document.narratives.filter(beat => beat.submissionId === submissionId),
          sameEventTemplate: document.state.history.filter(step => step.revision > before.state.revision)
            .flatMap(step => step.observations.filter(observation => observation.observerId === participant.agentId).map(observation => observation.summary)),
          newEntities: Object.keys(document.state.truth.entities).filter(entityId => !before.state.truth.entities[entityId]),
          newAgents: Object.keys(document.state.agents).filter(agentId => !before.state.agents[agentId]) };
        rows.push(row); save(`${flow.id}-${index + 1}.json`, { ...row, document });
        console.log(JSON.stringify({ trial, flow: flow.id, input: index + 1, status: row.status, failure, firstParagraphMs,
          completeMs: row.completeMs, requests: row.httpRequests, costCny: row.costCny, replay: row.replayEqual }));
        if (failure || stopped || live.budget.summary.blockingUnknown.length) break;
      }
      const saved = database.readInstance(id).document;
      const calls = live.budget.summary.phases.trajectory.httpRequests;
      database.close(); database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false }); host = makeHost();
      await host.drainNarratives(id); host.instance(id); host.instance(id); await live.drain();
      reports.push({ id: flow.id, instanceId: id, initialSubjects: Object.keys(initial.state.agents).length, coldMs, rows,
        restartStateEqual: contentHash(database.readInstance(id).document.state) === contentHash(saved.state),
        restartNarrativeEqual: contentHash(database.readInstance(id).document.narratives) === contentHash(saved.narratives),
        extraReadCalls: live.budget.summary.phases.trajectory.httpRequests - calls });
      await host.transferControl(id, { expectedRevision: saved.state.revision, target: { kind: "observer" } });
      if (phase === "continuous" && flow.world === "blackmarsh" && !stopped && !live.budget.summary.blockingUnknown.length) {
        const beforeAutonomy = live.budget.summary, autonomyStarted = performance.now();
        let failure: string | null = null;
        try { await host.advance(id, { expectedRevision: saved.state.revision, trigger: "batch", steps: 1 }); }
        catch (error) { failure = String(error); }
        await live.drain();
        const autonomous = database.readInstance(id).document;
        const evidence = { failure, elapsedMs: performance.now() - autonomyStarted,
          subjects: Object.keys(autonomous.state.agents).length,
          httpRequests: live.budget.summary.phases.trajectory.httpRequests - beforeAutonomy.phases.trajectory.httpRequests,
          costCny: (live.budget.summary.estimatedPeakNanoCny - beforeAutonomy.estimatedPeakNanoCny) / 1e9,
          replayEqual: contentHash(replaySimulationState(autonomous.state)) === contentHash(autonomous.state) };
        save("full-roster.json", { ...evidence, document: autonomous });
        console.log(JSON.stringify({ trial, fullRoster: evidence }));
      }
      if (stopped || live.budget.summary.blockingUnknown.length) break;
    }
  } finally {
    stopped = "experiment closed"; await live.drain();
    save("result.json", { ...manifest, reports, afterBudget: live.budget.summary, doctor: database.debugDoctor() });
    database.close(); registry.stopBackgroundRefresh(); live.close();
    console.log(JSON.stringify({ result: path.join(directory, "result.json") }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
