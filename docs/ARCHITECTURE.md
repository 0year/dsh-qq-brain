# 架构与实现说明

本文档说明 dsh-qq-brain 的内部结构、数据流与设计取舍，配合 README 阅读。

## 1. 模块地图

```
src/
├── index.js              入口/CLI + 常驻主循环（事件轮询 + 定时日记周报）
├── config.js             配置加载（默认值 + config.json 深合并 + paths 覆盖）
├── util.js               工具：token 估算、时区日期、JSON 提取、JSONL 读写
├── store.js              消息库 + 状态 + 画像/关键词/话题持久化（启动时从磁盘恢复）
├── ingest.js             从 QQ 桥拉取事件 → 规范化（群聊/私聊/发送者）→ 入库去重
├── llm.js                Anthropic 兼容 Messages API 客户端（JSON 模式、超时、key 读取）
├── qq.js                 通过 QQ 桥发送消息（POST /qq/ui-send）
└── channels/
    ├── longterm.js       长期学习通道（批量 → 增量更新画像 → 演化关键词）
    ├── interest.js       兴趣响应通道（关键词 → 去重 → 小窗口上下文 → 判断是否回复）
    └── diary.js          日记/周报通道（LLM 生成 + μ/σ/T 过滤）
```

## 2. 数据流

```
QQ 通知事件（status 服务 /qq/events）
   → ingest.normalizeEvent：解析「群名(8条新消息)」+「发送者: 内容」
   → store.appendMessages：写 data/messages/YYYY-MM-DD.jsonl，分配递增 seq
   → channels/interest.onNewMessages：逐条做本地关键词匹配
        → 命中 + 去重通过 → buildContext（W_short 窗口 + 画像）→ LLM 判断
             → should_reply && autoSpeak && 配额未满 → POST /qq/ui-send → 桥把消息发回 QQ
   → channels/longterm.maybeLearn：累计 token ≥ T_long → 批量 LLM → merge 画像/群特征/新关键词
```

**关键点**：兴趣通道和长期学习共享 `recent` 消息缓冲，但各自独立游标：
- 兴趣通道不推进学习游标（被兴趣读过的消息仍会参与长期学习）；
- 长期学习游标（`state.longCursorSeq`）只被学习通道推进。

## 3. 状态与幂等

`data/state.json`：

```jsonc
{
  "eventCursor": 0,      // 已消化的 QQ 事件 id（避免重复入库）
  "msgSeq": 0,           // 消息自增序号（全局）
  "pendingTokens": 0,    // 距上次学习累计的 token（可重算）
  "longCursorSeq": 0,    // 长期学习已处理到的消息 seq
  "lastDiaryDate": "",   // 已生成日记的日期
  "lastWeeklyKey": "",   // 已生成周报的 ISO 周
  "speakQuota": { "date": "", "used": 0 }
}
```

- 事件去重：`eventCursor` + 90 秒内 `chat|sender|text` 哈希去重（QQ 会重复推送通知）；
- 消息去重：JSONL 里按 seq 唯一，启动时从磁盘恢复 `recent` 并重算 `pendingTokens`；
- 日记/周报：按 `lastDiaryDate`/`lastWeeklyKey` 保证每天/每周只生成一次（手动命令可覆盖重生成）。

## 4. 长期学习通道

**触发**：`pendingTokens ≥ thresholdTokens` 且当前没有学习任务在跑。

**批量**：
- 取 `seq > longCursorSeq` 且属于目标群的消息；
- 裁剪到 `maxBatchTokens`；
- transcript 再裁到约 5000 token，发送者上限 20 人（避免画像 JSON 过长被截断）；
- 把「这些人已有的画像」和「群的已有特征」一起给模型，要求**增量修正**。

**模型输出**：

```json
{
  "profiles": {
    "昵称": {
      "communication_style": {"directness":"high","verbosity":"low","humor":"medium"},
      "language_style": {
        "sentence_length": "short",
        "punctuation_habit": "少用句末标点，爱用问号/括号",
        "emoji_usage": "medium",
        "tone": "技术吐槽与玩梗混杂",
        "catchphrases": ["buff拉满", "可还行"],
        "style_examples": ["逐字摘自聊天记录的招牌原话"]
      },
      "interests": ["理论物理","学术八卦"],
      "behavior": ["短句接梗"],
      "notes": "爱用联想插梗",
      "confidence": 0.55
    }
  },
  "group_features": {"topics": ["..."], "culture": "一句话"},
  "candidate_keywords": ["vLLM", "KV Cache"]
}
```

**合并策略**（`longterm.merge`）：
- 只接受本批出现过的发送者，防止模型凭空造人；
- `interests`/`behavior` 取并集并截断；
- `evidenceCount += 1`，`lastSeen = now`，confidence 限制在 0~1；
- `groupFeatures.topics` 取并集；
- `candidate_keywords` 去重后加入兴趣索引，总数上限 300（防止热门话题淹没原兴趣）。

**失败处理**：JSON 解析失败（上下文过大被截断）时，把批次对半拆开递归重试（最多两层）。

## 5. 兴趣响应通道

**本地匹配**（零 token）：
- 纯 ASCII 关键词用词边界正则（避免 `AI` 命中 `said`）；
- 中文关键词用普通子串匹配；
- 每个关键词维护 `topics[k] = {lastTriggerAt, tokensSince}`：
  - 首次命中 → 立即触发；
  - 再次命中 → 需要 `tokensSince ≥ repeatNewTokens`（默认 500）才触发；
  - 触发后 `tokensSince` 清零。

**预算**：`callTimes` 环形记录最近 1 小时调用 → 超过 `maxLlmCallsPerHour` 直接跳过。

**人设分离**：群聊用 `channels.interest.persona`（默认冷淡、就事论事），
顶层 `persona`（傲娇大小姐）留给主人私聊与日记/周报总结——「傲娇只给主人」。
**风格模仿**：兴趣通道 prompt 会注入 `profiles.groupStyle`（群的整体说话方式）与相关发言者的
`language_style`（含口头禅与招牌例句），并要求回复必须模仿群风格。

**上下文**：`W_short` 预算内最近消息 + 相关发送者的画像摘要 + 群特征。

**模型输出**：

```json
{"interested": true, "should_reply": true, "reply": "这句话", "reason": "一句话理由"}
```

**发送前检查**：
- `autoSpeak` 开关；
- 每日发言配额（`dailySpeakQuota`）；
- 长度裁剪、去掉 `@所有人`；
- 随机 0.8~2s 延迟（更像真人）。

**审计**：所有判断写入 `data/decisions/YYYY-MM-DD.jsonl`，包括没发送的情况（便于调参和复盘）。

## 6. 日记 / 周报

**日记**（每天 `diary.at`，默认 21:00）：
- 取当天消息（群聊 + 可选私聊），压缩到约 9000 token（超长时按步长采样）；
- 模型输出 `{"events":[{"desc","score"}],"summary":"给主人的口语总结"}`；
- 写 `diary/YYYY-MM-DD.md`：事件清单（原序）+ 最终日记（按分数降序）；
- `summary` 通过 QQ 桥发给主人（`notifyOwner` 可关）。

**周报**（每周日 `weekly.at`，默认 21:30）：
- 从本周日记解析「事件 + 分数」，从上周周报解析「调整后分数」；
- 上周分数 × `beta`（默认 0.7）做时间衰减；
- 合并排序统计：`μ`、总体标准差 `σ`、阈值 `T = μ − 0.842σ`；
- 保留 `score ≥ T` 的事件，按调整后分数降序写入周报并标注；
- 生成一段无公式的口语总结发给主人。

## 7. 经济性与调参

- 关键词匹配是纯 CPU，消息量再大也不烧 token；
- 兴趣通道的调用次数由「命中率 × 去重阈值 × 每小时预算」三重限制；
- 长期学习每次处理约 12000 token 消息、输出约 2000 token，按天算成本极低；
- 想让学习更快：调小 `thresholdTokens`；想更省钱：调大它；
- 想让接话更积极：调小 `repeatNewTokens`；想更安静：调大它或关闭 `autoSpeak`。

## 8. 扩展点

- **关键词规模**：>500 个后建议换 Aho-Corasick（一次扫描完成全部匹配）；
- **语义兴趣**：用 embedding 替代字面匹配，需要接入向量库；
- **多群独立画像**：给 profiles 增加按群的命名空间；
- **事件源无关**：只要往 `/qq/events` 推送符合格式的事件，任何 IM 都能用。

## 9. 安全设计

- 群消息/标题/评论里的文字只作为**素材**，不作为行为指令（防提示注入）；
- 画像只记录可观察行为和明确偏好，不推断敏感属性；
- 默认不自动发言（`autoSpeak=false`）；
- 所有发送都经过配额和长度过滤；
- `data/`、`config.json` 不入库（`.gitignore`）。
