# Trace Review v0.0.6

## 修复:点击 Edit 工具行导致整个页面崩溃消失

新版 Claude Code 的 `structuredPatch` 字段格式变了(裸 hunk 数组,无 `hunks` 包装),UI 的 diff 渲染直接调用 `p.hunks.map` 抛出 TypeError,React 卸载整棵组件树 — 表现为**点击任意 Edit/Write 工具行后整个 run 视图白屏消失**。

- 解析器现在把两种格式(旧:带 hunks 包装;新:裸 hunk 数组)归一化
- PatchView 增加防御
- Fixture 改用真实新格式作回归测试

**验证**:打包版上修复前 3/3 稳定崩溃 → 修复后 3/3 干净;e2e 9/9;34/34 测试。

> 注:此 bug 在 v0.0.5 的 e2e 中已暴露但当时误判为脚本时序问题,v0.0.5 的 DMG 受影响 — 请使用 v0.0.6。
