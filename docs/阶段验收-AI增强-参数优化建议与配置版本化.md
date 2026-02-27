# 阶段验收：AI增强（参数优化建议 -> 配置版本化 -> 回灌评分）
更新时间：2026-02-27 01:50

阶段状态：`已完成（已切阶段，作为回归基线）`
上一阶段基线：`docs/阶段验收-回测任务编排与生产隔离.md`

## 1. 阶段目标
- 打通 `回测报告 -> 参数建议(run_id绑定) -> 配置版本化 -> 回灌评分/回测` 最小闭环。
- 保证链路可追踪：建议来源、版本来源、回灌 `run_id` 都可在接口/页面查看。
- 将本阶段固化为可重复执行的验收脚本与稳定性脚本。

## 2. 切阶段硬门槛
1. `POST /api/ai/optimization/suggestions/generate` 可返回建议，且包含 `run_id`。
2. `GET /api/ai/optimization/suggestions` 可查询建议历史，状态可见 `generated/applied`。
3. `POST /api/config/versions/save` 可保存版本；`GET /api/config/versions` 可查询版本。
4. `POST /api/config/versions/{id}/apply` 支持：
- `run_scoring=true` 时返回 `scoring.status=ok`。
- `run_backtest=true` 时返回 `backtest.run_id` 且对应任务可达到 `completed`。
5. 版本状态可进入 `refeeded`，并在 `GET /api/config/versioning/status` 可见。
6. Web 可视化：
- 设置页显示“算法配置版本化（保存/查询/应用）”
- 版本行显示“应用并回灌评分”按钮
- 首页第 6 步显示“已回灌评分”文案

## 3. 最小验收步骤
### 3.1 单轮验收（推荐）
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_ai_enhancement_acceptance.ps1 -BaseUrl http://127.0.0.1:8000 -RunBacktest -BacktestDays 20
```

### 3.2 连续稳定性回归（建议切阶段前）
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_ai_enhancement_stability.ps1 -BaseUrl http://127.0.0.1:8000 -Runs 10 -IntervalSec 3 -BacktestDays 20 -RunBacktest $true -PreRefresh $true
```

## 4. 本阶段脚本
- 单轮验收：`scripts/run_ai_enhancement_acceptance.ps1`
- 稳定性回归：`scripts/run_ai_enhancement_stability.ps1`
- 说明：稳定性脚本已内置预刷新开关 `PreRefresh`，用于避免 freshness 门控导致误判。

## 5. 验收证据（最新）
1. 单轮验收通过：
- `reports/ai_enhancement_acceptance_20260227_014702.json`
- 关键字段：`version_status=refeeded`、`scoring_status=ok`、`backtest_status=completed`

2. 稳定性首轮（问题复现）：
- `reports/ai_enhancement_stability_20260227_014400.json`
- 现象：`apply_status=ok` 且 `backtest_status=completed`，但 `scoring_status=blocked`（freshness 门控）

3. 稳定性修复后复测（10 轮）：
- `reports/ai_enhancement_stability_20260227_014625.json`
- 结果：`all_passed=true`、`passed_count=10`、`failed_count=0`
- 日志：`reports/ai_enhancement_stability_20260227_014625.log`

## 6. Web 可见验收点（你可直接核验）
1. 系统设置页“算法配置版本化”区块可见版本列表与“应用并回灌评分”按钮。
2. 点击“应用并回灌评分”后，版本状态可进入 `refeeded`。
3. 首页“链路进度（阶段锁）”第 6 步显示“已回灌评分”文案。
4. 回测任务面板可看到新增回灌触发的 `run_id` 且终态为 `completed`。

## 7. 阶段锁说明
- 本阶段已完成并切换阶段锁到 `UI美化`。
- 本文档作为后续阶段回归基线保留。
