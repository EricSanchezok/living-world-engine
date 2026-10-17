# 正文来源与核对

本目录保存元数据，不保存小说全文。[基线报告](baseline.json)给出原始字节指纹、候选版本、目录与比较状态。[完整目录](catalogue.json)保留正文和非正文项目；[差异清单](discrepancies.json)保留标题差异及正文比对异常。自动比对不等于文学版本校勘。

候选全文来自公开存档中标为「校对版全本＋番外」的 GB18030 文本，固定在提交 `094be1bb8dd4c8ed26bc2b298ec2351b6d22fa03`。原始指纹为 `2fc1698410418bf136448807335c6359bf515b75e6f9c1e1d1f443a1c928e6cc`。文件自带的出版、校对与广告说明不是本项目核实的事实。正文之后的三篇外传单独隔离，不作为本传章节输入。

目录使用阅文的《凡人修仙传》站点返回的书号 `107580` 数据。起点目录地址当前返回 HTTP 202 检查页，因此没有宣称直接校验过该页的完整目录内容。阅文目录的章号存在重号、缺字、错别字、标题删改和内部序号异常，正文匹配以来源章节 ID、相邻顺序与文本为依据。不能把最后一章显示的「2446」当作文件必须只有 2446 段的校验条件，也不能把 2611 个目录项目全部当作正文章节。

官方公开页面的前段章节可取得完整正文，后期章节通常只返回约 300 字预览。工具分别记为 `full`、`preview` 或尚未获取；预览吻合只支持该段文字及章节对应关系，不能证明整章没有删节。正文事实使用候选工作版本时必须引用其指纹；存在实质差异的条目复核后才能采用。

[完整性调查](integrity-findings.json)保存人工定位的缺段、异文及第二份文本指纹。第二份文本只作比对材料，其下卷实际属于仙界续作，已排除。候选《雪猿、冰壁、宫殿》存在缺失开头，另一版本又有重复与截断；该章在修复并复核之前不能进入运行资料。章节齐全与目录对齐不能消除这项阻断。

## 操作

在仓库根目录运行以下命令。缓存存在时复用原始文件；删除或替换资料应先保留旧指纹与差异。下载只访问公开页面，不处理付费解锁或身份验证。

```sh
python3 scripts/world-authoring/fanren_sources.py acquire
python3 scripts/world-authoring/fanren_sources.py references
python3 scripts/world-authoring/fanren_sources.py audit
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/world-authoring -p 'test_*.py'
```

`references --limit 8` 可核对最前面的八个正文项目。`audit` 写入[章节母表](../coverage/chapters.jsonl)与[阅读批次](../coverage/batches.json)。同一指纹下保留已记录的语义进度；字节内容变化后，不沿用旧的阅读、提取或复核状态。批次不会自动升级为已阅读。
