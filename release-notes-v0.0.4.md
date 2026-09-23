# Trace Review v0.0.4

修复一个严重的分类 bug:**带图片的用户消息被误判为 synthetic**。

## 问题

真实用户输入如果包含粘贴的截图(消息 content 为 `[text, image]` 数组而非纯文本),解析器只处理了纯文本路径,数组消息落入兜底分支被标记为 `synthetic / injected`。结果:你贴图的每条消息都从 User 分类里"消失",显示成紫色的 synthetic 行。

## 修复

- 数组内容(text/image 块,无 tool_result)与纯文本走**同一套判定链**(isCompactSummary / isMeta / origin.kind / 启发式)— `origin.kind=human` + 图片 = 真实用户消息
- 带图消息在轨迹中显示 🖼 标记
- isMeta 的 `[Image: source: …]` 图片路径回显(harness 写入,非用户输入)仍正确标为 synthetic

**实测**:受影响的会话从 6 user / 10 synthetic 修正为 11 user / 5 synthetic(剩余 5 条全部是真正的 harness 注入)。

## 验证

34/34 测试(含新增回归用例)、e2e 9/9(对打包产物)。
