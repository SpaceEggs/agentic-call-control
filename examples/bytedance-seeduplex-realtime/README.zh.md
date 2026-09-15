# Agentic Call Control — 字节跳动 Seeduplex 实时语音（3.0 duplex）

将 **3CX PBX** 通过 CallControl SDK 接入 **字节跳动 Seeduplex 3.0**（豆包实时语音）的语音智能体示例。使用 **文本 JSON duplex WebSocket**，STT / 推理 / TTS 在同一双向音频流中完成。

> **协议状态（2026-09-15）：** payload 已按官方 `go1.24_duplex_demo.zip`、`python3.7_duplex_demo.zip` 与 API 文档核验。真实通话验收仍需已开通的 3CX 与火山引擎凭据。详见 `docs/development/issue-2-p0-protocol-status.md`。
>
> 本示例**只使用 3.0 文本 JSON** 接口。遇到 403/权限不足时**禁止**回退到 Seeduplex **1.0 二进制**协议。

---

## 前置条件

### 3CX Service Principal

1. 打开 3CX Web Client
2. **Admin → Integrations → API → Add Service Principal**
3. 设置 **Client ID**（如 `assistant`）作为 `appId`
4. 启用 **Call Control API**
5. （可选）分配 DID 与可控分机
6. 保存后得到 `appSecret`

### 火山引擎 / 豆包语音凭据

1. 打开火山引擎豆包语音控制台
2. 创建或选择应用，复制 **APP ID** → `volcAppId`，**API Key** → `volcApiKey`
3. Seeduplex **3.0 duplex** 可能需要邀请或开通
4. **403/权限不足表示需要开通 3.0**，不能通过切换到 1.0 端点规避

`appId`（3CX）与 `volcAppId`（火山）含义不同，不得互换。

---

## 快速开始

在仓库根目录：

```bash
cp examples/bytedance-seeduplex-realtime/config.yaml.example examples/bytedance-seeduplex-realtime/config.yaml
```

编辑 `examples/bytedance-seeduplex-realtime/config.yaml`，填入凭据后：

```bash
yarn install
yarn start:bytedance-seeduplex
```

默认中文接待员 profile 为 `receptionist_cn`，模型字符串 `1.2.6.0`，默认音色 `zh_female_vv_jupiter_bigtts`。

---

## 音频路径

```
3CX PCM 8 kHz → 2× 上采样 → 16 kHz Base64 → input_audio_buffer.append
Seeduplex PCM 24 kHz Base64 → 3× 下采样 → 8 kHz → 3CX audioWriter
```

单声道 16-bit little-endian。上行按官方建议封装为 20 ms / 640 字节，
重采样跨帧保留状态，下行在 3:1 抽取前使用轻量抗混叠滤波。

打断：收到 `conversation.item.input_audio_transcription.started` 时立即清空 writer、
取消 PBX stream queue 并发送 `response.cancel`。SDK 0.1.10 的
`audioWriter.cancel()` 会永久关闭 writer，因此只在桥接最终结束时调用；下一轮回复仍可播放。

---

## 工具与路由

- schema provider：`seeduplex`（初始设计复用 openai profile，保留数值/布尔类型）
- 名称规范化后在执行前还原为原始 MCP 名
- 本地 `transfer_call` / `drop_call` / `transfer_to_voicemail` 复用原有筛选、允许列表与可用性检查
- 首版断线后不自动重放工具、不透明重建对话

---

## 测试

```bash
yarn workspace @3cx-examples/bytedance-seeduplex-realtime test
yarn workspace @3cx-examples/mcp test
```

自动化测试覆盖官方 payload、20 ms 分包、重采样、生命周期、打断恢复、
工具批量回传/去重/名称还原与路由锁。

### 真实环境验收清单

1. 使用已开通 3.0 的 API Key 启动，确认收到 `session.created`。
2. 发起 3CX 来电，确认只问候一次、上行连续、24 kHz → 8 kHz 下行可听。
3. 各调用一次本地工具和 3CX MCP 工具，确认 `call_id` 对应且结果以一次
   `conversation.item.create` 批量回传。
4. 播放中插话，确认旧音频立即停止且下一轮回复仍可播放。
5. 验证转接成功、转接失败后重试、语音信箱与挂断，每通话最多执行一个终态动作。
6. 双方分别挂断，确认 `session.close`、监听器清理且迟到音频/工具结果不再写入。
7. 进行至少 15 分钟持续通话，观察 WebSocket 与播放缓冲积压告警。

Mock 测试不能证明账号权限、广域网表现或真实 PBX 媒体行为。

---

## 故障排查

| 现象 | 可能原因 |
| --- | --- |
| 启动提示缺失字段 | 补齐 `volcAppId` / `volcApiKey` / 3CX 凭据 |
| WebSocket 401/403 | 密钥错误或未开通 3.0 duplex — 不要改用 1.0 |
| 无问候/无音频 | 会话未进入 ready（检查 session.create ack 日志） |
| 工具未调用 | 未列入 profile `mcpTools`，或名称冲突被拒绝 |
| 模型被拒绝 | 当前官方 demo 使用 `1.2.6.1`；将 `realtimeModel` 改为账号已开通版本 |
| 英文音色不对 | 选择账号已开通且支持英文的音色 |
