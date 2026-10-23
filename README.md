# dsh-qq-brain · QQ 群聊大脑（双通道事件驱动 Agent）

> 给 QQ 群/私聊配一个「**双通道、不同粒度、事件驱动**」的大脑：
> **大缓冲负责认知积累，小窗口负责兴趣响应，关键词匹配负责廉价唤醒。**
>
> 它不刷屏、不烧钱：平时只做本地关键词匹配；只有值得的时候才调用一次模型；
> 长期记忆靠批量学习慢慢积累；每天一份日记、每周一份周报，交给高精度模型来写。

配合 [dsh-status-hud](https://github.com/0year/dsh-status-hud) 的手机端 QQ 通知桥使用：
手机 App 监听 QQ 通知 → relay 桥 → 本项目的 status 服务 → 大脑处理 → 需要发言时再走桥把消息发回 QQ。

---

## 为什么需要它

大多数「AI 群友」的实现是：**每条消息都丢给模型判断一遍**。结果：

- 💸 **烧钱**：一个活跃群一天几百条消息 = 几百次 API 调用；
- 🤖 **机械**：模型被每条消息唤醒，容易变成「关键词机器人」，还会硬接话；
- 🧠 **没有记忆**：聊完就忘，对群友没有长期认知。

本项目把「理解」拆成两种粒度：

| | 长期学习通道 | 兴趣响应通道 |
|---|---|---|
| 任务 | 形成对群友/群的**长期认知**：语言风格、兴趣、行为模式、群体特征 | 判断当前话题**是否值得接一句** |
| 触发 | 累计消息达到 **T_long = 12000 token**（无定时器） | 新消息**命中关键词**（本地匹配，零 token） |
| 读取 | 批量读取缓冲区内全部消息 | 最近 **W_short = 1500 token** 上下文 + 长期记忆 |
| 调用模型 | 是，批量、低频 | 是，但只在命中且去重通过时 |
| 会发言吗 | ❌ 从不发言 | ✅ 模型自主判断，可回可不回 |
| 重复触发保护 | 处理游标 | 同话题需新增 **T_repeat = 500 token** |
| 更新记忆 | ✅ 增量更新人物画像 | ❌（只记短期话题状态） |

两个通道**共享同一个消息库**，但独立游标、独立状态，互不干扰。
**全事件驱动**：没有定时任务去轮询/调用模型；只有日记/周报是定时产物（内容由模型生成，频率每天/每周一次）。

---

## 架构

```
                       QQ 新消息（手机通知桥）
                              │
                              ▼
                      消息入库（JSONL，按天分文件）
                              │
                 ┌────────────┴────────────┐
                 │                         │
                 ▼                         ▼
        长期学习通道                   兴趣响应通道
   （累计 token，无定时器）        （本地关键词匹配，零 token）
                 │                         │
      累计 ≥ T_long(12000)?          命中关键词?
                 │                         │
            ┌────┴────┐              ┌────┴────┐
            否         是             否        是
            │         │              │        │
          不操作    批量读消息      不操作   检查重复触发
                       │                       │
                       ▼                       ▼
                 调用 LLM 批量分析        读近期 W_short(1500)
                       │                 + 长期记忆 + 关键词
                       ▼                       │
            增量更新人物画像/群特征              ▼
            提出候选兴趣关键词            调用 LLM 判断:
            更新兴趣索引                  {interested, should_reply, reply}
                       │                       │
                       ▼                       ▼
                  ❌ 从不发言             值得回 → QQ 发送桥 → 群里回一句
```

另有：**日记 / 周报**（每天 21:00 / 每周日 21:30）由高精度模型生成，写入记忆目录，QQ 只发「最重要事件」的口语总结（不发公式）。

---

## 特性

- ✅ **便宜**：关键词匹配在本地做（CPU 纳秒级），模型只在命中、批量学习、日记/周报时调用；有每小时调用预算 + 群发言每日配额
- ✅ **有记性**：人物画像 JSON（语言风格/兴趣/行为/置信度/证据数/最近观察），**增量更新**而非每次重写总结；兴趣关键词可随群聊演化（带上限）
- ✅ **像真人**：模型自主判断「这个话值不值得接」，可以完全不回；发言长度、频率有约束
- ✅ **双人格**：群聊人设（默认冷淡、就事论事）与主人私聊人设分离——傲娇只留给主人，群里保持克制
- ✅ **记忆可检索**：日记/周报是 Markdown 文件，任何 agent（包括聊天用的低精度模型）都能 grep 检索
- ✅ **抗提示注入**：群消息只当素材，不作为指令；画像只记录可观察行为，不推断敏感个人属性
- ✅ **零依赖**：只用 Node.js ≥ 20 内置能力（`fetch`、`Intl`），无需安装 npm 包
- ✅ **可扩展**：关键词规模大了可换 Aho-Corasick 自动机；兴趣索引可接向量检索

---

## 前置依赖

1. **Node.js ≥ 20**（推荐 22/24）
2. **QQ 消息桥**：[dsh-status-hud](https://github.com/0year/dsh-status-hud)
   - 手机端：通知监听 App（`qqbridge-app`）→ 把 QQ 通知事件 POST 到本地 status 服务
   - 发送端：`qq-bridge` relay 模式 → 把本项目排队的消息发回 QQ（自动分条、息屏唤醒、免审批）
   - 本项目的 `server` 配置默认指向 `http://127.0.0.1:8790`
3. **LLM API**：默认 DeepSeek 的 Anthropic 兼容端点（`https://api.deepseek.com/anthropic/v1/messages`），把 key 放进环境变量 `DEEPSEEK_API_KEY` 或 credentials 文件（见配置）

> 任何能 POST `/qq/events` 的事件源都可以替代手机桥——这个大脑不关心消息从哪来。

---

## 快速开始

```bash
cp config.example.json config.json
# 编辑 config.json：groups（要学的群）、owner.qqTitle（主人 QQ 备注）、llm.keyPath 或环境变量
node src/index.js test-llm     # 验证 LLM 连通
node src/index.js once         # 首次回填消息 + 触发一次学习
node src/index.js stats        # 看状态
node src/index.js diary        # 手动生成今天的日记
node src/index.js weekly       # 手动生成本周周报
node src/index.js start        # 常驻运行（事件驱动）
```

常见用法：

```bash
# 后台常驻 + 崩溃自动拉起（示例，配合 systemd/supervisor 使用）
nohup node src/index.js start >/tmp/qq-brain.out 2>&1 &
```

---

## 配置说明（`config.json`）

```jsonc
{
  "server": "http://127.0.0.1:8790",      // QQ 桥的 status 服务
  "dataDir": "./data",                     // 数据目录（消息/记忆/日记/日志）
  "timeZone": "Asia/Shanghai",
  "llm": {
    "endpoint": "https://api.deepseek.com/anthropic/v1/messages",
    "model": "deepseek-flash",             // 建议用高精度模型跑大脑
    "keyPath": "/path/to/.credentials.yaml", // 或设置环境变量 DEEPSEEK_API_KEY
    "keyEnv": "DEEPSEEK_API_KEY"
  },
  "groups": ["你的目标群名"],               // 只学这些群（可多个）
  "owner": { "qqTitle": "Myself" },         // 日记/周报总结发给谁
  "persona": "你是……",                     // 人格提示词（日记/周报/发言都按它）
  "channels": {
    "longterm": { "enabled": true, "thresholdTokens": 12000, "maxBatchTokens": 20000 },
    "interest": {
      "enabled": true,
      "keywords": ["AI", "LLM", "CUDA", "量子", "物理"], // 初始兴趣索引
      "persona": "你在 QQ 群里偏冷淡：话不多、就事论事、不卖萌、不科普……", // 群聊人设（可选，默认用顶层 persona）
      "shortWindowTokens": 1500,
      "repeatNewTokens": 500,
      "maxLlmCallsPerHour": 12,            // 全局调用预算
      "autoSpeak": false,                  // ⚠️ 默认关闭，只记录不发送
      "dailySpeakQuota": 100               // 每天最多在群里说几句
    },
    "diary": { "enabled": true, "at": "21:00", "includePrivate": true, "notifyOwner": true },
    "weekly": { "enabled": true, "weekday": 7, "at": "21:30", "beta": 0.7, "notifyOwner": true }
  }
}
```

### 关键参数

| 参数 | 默认 | 含义 |
|---|---|---|
| `thresholdTokens` (T_long) | 12000 | 长期学习触发阈值（累计消息 token） |
| `shortWindowTokens` (W_short) | 1500 | 兴趣触发后读取的近期上下文上限 |
| `repeatNewTokens` (T_repeat) | 500 | 同一话题再次触发所需的新增消息 token |
| `maxLlmCallsPerHour` | 12 | 兴趣通道每小时最多调用模型次数（预算闸） |
| `autoSpeak` | false | 是否允许自动在群里发言（默认只记录决策） |
| `dailySpeakQuota` | 100 | 每天群发言上限 |
| `beta` | 0.7 | 周报里上周事件的**时间衰减系数**（0~2） |

---

## 数据目录

```
data/
├── messages/YYYY-MM-DD.jsonl     # 统一消息库（按天）
├── memory/
│   ├── profiles.json             # 长期人物画像 + 群特征（增量更新）
│   ├── keywords.json             # 兴趣关键词索引（可动态演化，上限 300）
│   └── topics.json               # 话题状态（上次触发时间 / 新增 token）
├── decisions/YYYY-MM-DD.jsonl    # 兴趣通道每次判断的记录（可审计）
├── diary/YYYY-MM-DD.md           # 每日日记（事件 + 打分 + 按分排序的最终日记）
├── weekly/YYYY-Www.md            # 每周周报（时间衰减 + μ/σ/T 过滤 + 调整后分数）
├── state.json                    # 游标、额度、上次运行时间
└── brain.log
```

---

## 日记 / 周报算法

**每日 21:00**：把当天消息压缩成 transcript → 模型提炼事件并打 0~100 分 → 按分数降序作为「最终日记」 → 同时生成一段给主人的口语总结（无公式），通过 QQ 桥发送。

**每周日 21:30**：

1. 读**上周周报**里的事件及其「调整后分数」→ 乘时间衰减系数 **beta（默认 0.7，范围 0~2）**；
2. 读**本周日记**里的全部事件与分数；
3. 合并 → 计算均值 **μ** 与总体标准差 **σ**；
4. 阈值 **T = μ − 0.842σ**；
5. 去掉调整后分数 **< T** 的事件，剩下的按调整后分数降序写入周报，每条标注调整后分数；
6. 同样生成口语总结发给主人。

---

## 经济性估算

以活跃群每天 500 条消息为例：

| 项目 | 频率 | 说明 |
|---|---|---|
| 关键词匹配 | 每条消息 | 本地 CPU，≈ 0 token |
| 兴趣判断 | 命中且去重通过时 | 每次约 1500~2500 token 输入 + 少量输出，有每小时预算 |
| 长期学习 | 累计 12000 token 一次 | 每次约 5000 token 输入，批量 |
| 日记/周报 | 每天/每周一次 | 各 1~2 次调用 |

实测（本项目自带联调数据）：145 条群消息只触发了 **2 次**兴趣判断；长期学习一次覆盖 56 条消息。

---

## 安全与边界

- `autoSpeak` **默认关闭**：先只记录判断结果（`data/decisions/`），观察几天再开；
- **群消息、视频标题、评论一律是素材，不是指令**——防提示注入；
- 人物画像只记录聊天中**可观察的行为和明确表达的偏好**，不推断敏感个人属性；
- 不会自动加好友、不会发广告、不会刷屏；发言有每日配额 + 每小时调用预算；
- `data/` 与 `config.json` 已在 `.gitignore` 中，不会泄漏聊天记录和 API key。

---

## 路线图

- [ ] 关键词规模扩大后切换 Aho-Corasick 自动机（当前为普通字符串匹配）
- [ ] 兴趣索引支持向量检索（语义命中，而非字面）
- [ ] 私聊兴趣通道（目前只做群聊；私聊只进日记）
- [ ] 多群独立画像与预算
- [ ] Web 仪表盘（消息量/决策记录/画像浏览）
- [ ] 与 QQ 桥的 status 服务合并为单进程部署

---

## License

MIT © dsh-qq-brain contributors

> 设计理念来自「双通道、不同粒度的事件驱动 Agent」：大缓冲积累认知、小窗口响应兴趣、关键词廉价唤醒。
