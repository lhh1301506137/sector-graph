## [V0.77] - 2026-02-27 阶段验收脚本统一（自动 BaseUrl + 固定 reports）

### 调整
- 统一以下脚本支持 `-BaseUrl` 可选（未传时自动探测可用服务）：
  - `run_backtest_stage_acceptance.ps1`
  - `run_backtest_stage_stability.ps1`
  - `run_ai_enhancement_acceptance.ps1`
  - `run_ai_enhancement_stability.ps1`
  - `run_ops_observability_acceptance.ps1`
  - `run_release_stage_acceptance.ps1`
  - `run_post_release_observe_acceptance.ps1`
  - `run_closure_archive_acceptance.ps1`
- 统一脚本输出目录解析：相对路径 `reports` 统一锚定到 `sector-graph/reports`。
- 修复稳定性脚本单轮运行时通过计数边界（`passed_count` 为空）的历史问题：
  - `run_backtest_stage_stability.ps1`

### 验收
- 不传 `-BaseUrl` 运行以下脚本均通过并写入 `sector-graph/reports`：
  - `ops_observability_acceptance_20260227_230745.json`
  - `release_stage_acceptance_20260227_230750.json`
  - `post_release_observe_acceptance_20260227_230737.json`
  - `closure_archive_acceptance_20260227_230817.json`
  - `ai_enhancement_acceptance_20260227_230832.json`
  - `ai_enhancement_stability_20260227_230905.json`
  - `backtest_stage_acceptance_20260227_230941.json`
  - `backtest_stage_stability_20260227_230956.json`

---
## [V0.76] - 2026-02-27 维护巡检收尾：脚本自动探测与口径统一

### 调整
- `scripts/run_maintenance_mode_acceptance.ps1`
  - `-BaseUrl` 改为可选，默认自动探测可用服务地址（校验 `/api/sync-status`）。
  - 报告输出目录锚定到项目内 `sector-graph/reports`。
- `scripts/run_maintenance_mode_stability.ps1`
  - `-BaseUrl` 改为可选，默认自动探测。
  - 报告输出目录锚定到项目内 `sector-graph/reports`。
  - 修复单轮巡检（`Runs=1`）时 `passed_count` 统计为 `null` 的问题。
- `check_maintenance_mode_stability.bat`
  - 支持可选参数：`[BaseUrl] [Runs] [IntervalSec]`。
- `README.md` 与 `docs/阶段验收-维护模式-回归巡检.md`
  - 维护巡检口径统一为 `5/5`。
  - 更新最新验收/稳定性报告文件名。

### 验收
- `run_maintenance_mode_acceptance.ps1`：`reports/maintenance_mode_acceptance_20260227_225408.json`
- `run_maintenance_mode_stability.ps1 -Runs 3 -IntervalSec 2`：
  - `reports/maintenance_mode_stability_20260227_225046.json`
  - `reports/maintenance_mode_stability_20260227_225046.log`
  - `reports/maintenance_mode_alerts_20260227_225046.jsonl`（0 条）
- `check_maintenance_mode_stability.bat http://127.0.0.1:18008 1 0` 通过。

---
# 变更记录 (Changelog)

记录每次开发的修改内容，帮助追踪进度。

---

## [V0.75] - 2026-02-27 端口自适配与可观测补齐

### 调整
- `start.bat` 增加可用端口自动选择（优先 `8000/18008/18080/18081`），并输出实际访问 URL。
- `server/app.py` 启动日志改为读取 `APP_HOST/APP_PORT`，避免日志与实际端口不一致。
- `frontend/app.js` 将双源比对 `status=empty` 视为“已生成快照”，避免监控项误判为未接入。

### 验收
- 代码检查：`node --check frontend/app.js`。
- 运行验证：通过 `start.bat` 启动并以终端输出 URL 访问。
- 前端验证：运维可观测面板确认“双源比对快照”不再因 `empty` 计为未接入。

---
## [V0.74] - 2026-02-27 ✅ 维护模式补齐连续巡检与失败告警落盘

### 调整
- ✅ 新增维护模式稳定性脚本：
  - `scripts/run_maintenance_mode_stability.ps1`
  - 支持参数：`BaseUrl/Runs/IntervalSec/RefreshBeforeCheck/OutputDir`
- ✅ 脚本能力：
  - 连续调用 `run_maintenance_mode_acceptance.ps1`
  - 输出稳定性汇总：`maintenance_mode_stability_*.json`
  - 输出运行日志：`maintenance_mode_stability_*.log`
  - 失败时写入告警落盘：`maintenance_mode_alerts_*.jsonl`
- ✅ 兼容性修正：
  - `scripts/run_maintenance_mode_acceptance.ps1` 的 `RefreshBeforeCheck` 改为宽松解析（支持 `true/false/1/0`）
  - 避免在子进程调用时出现布尔参数转换失败

### 文档
- ✅ 同步更新维护模式口径：
  - `README.md`
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `docs/阶段验收-维护模式-回归巡检.md`

### 验收
- ✅ 连续巡检通过（3/3）：
  - `reports/maintenance_mode_stability_20260227_182923.json`
  - `reports/maintenance_mode_stability_20260227_182923.log`
  - `reports/maintenance_mode_alerts_20260227_182923.jsonl`（0 条）
- ✅ 告警落盘故障注入验证（错误端口）：
  - `reports/maintenance_mode_stability_20260227_183315.json`
  - `reports/maintenance_mode_alerts_20260227_183315.jsonl`（1 条，`script_runtime`）
- ✅ 新增一键入口：
  - `check_maintenance_mode_stability.bat`

---

## [V0.73] - 2026-02-27 ✅ 切阶段到「维护模式（回归巡检）」并完成首轮巡检门槛

### 调整
- ✅ 前端阶段锁切换：
  - `frontend/app.js` 中 `pipelineStageLock` 切换为 `maintenance_mode`
  - 阶段卡新增第 12 步：`维护模式（回归巡检）`
- ✅ 首页新增“维护模式（回归巡检）”面板（4 项）：
  - 最近同步心跳正常
  - 质量门控可发布
  - 最近回测任务完成
  - 最新配置版本已回灌
- ✅ `发布准备检查`、`发布后观察`、`收官归档`面板在维护阶段保持可见，作为长期巡检基线

### 验收
- ✅ 新增维护模式阶段验收脚本：
  - `scripts/run_maintenance_mode_acceptance.ps1`
- ✅ 最新通过报告：
  - `reports/maintenance_mode_acceptance_20260227_181325.json`
- ✅ Web 验收截图：
  - `reports/maintenance_mode_stage_step12_desktop_20260227.png`
- ✅ 基线复跑报告：
  - `reports/release_stage_acceptance_20260227_175745.json`
  - `reports/post_release_observe_acceptance_20260227_175745.json`
  - `reports/closure_archive_acceptance_20260227_175746.json`

### 文档
- ✅ 新增阶段验收文档：
  - `docs/阶段验收-维护模式-回归巡检.md`
- ✅ 上一阶段文档状态切为“已完成（基线）”：
  - `docs/阶段验收-收官归档与维护交接.md`
- ✅ 同步更新：
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `docs/业务流程图-升级版.md`
  - `docs/业务流程图-升级版.html`
  - `README.md`

---

## [V0.72] - 2026-02-27 ✅ 切阶段到「收官归档与维护交接」并完成第1~4步

### 调整
- ✅ 前端阶段锁切换：
  - `frontend/app.js` 中 `pipelineStageLock` 切换为 `closure_archive`
  - 阶段卡新增第 11 步：`收官归档与维护交接`
- ✅ 首页新增“收官归档与维护交接”面板（4 项）：
  - 发布基线验收可复核
  - 发布后观察基线可复核
  - 最近同步时间可追溯
  - 配置版本已回灌可追溯
- ✅ 发布后观察与运行手册面板在新阶段继续可见，作为归档前复核基线
- ✅ 阶段提示文案新增“归档与交接 X/4”口径

### 验收
- ✅ 新增收官归档阶段验收脚本：
  - `scripts/run_closure_archive_acceptance.ps1`
- ✅ 最新通过报告：
  - `reports/closure_archive_acceptance_20260227_172701.json`
- ✅ Web 验收截图：
  - `reports/closure_archive_stage_step1_desktop_20260227.png`
  - `reports/closure_archive_stage_step4_desktop_20260227.png`

### 文档
- ✅ 新增阶段验收文档：
  - `docs/阶段验收-收官归档与维护交接.md`
- ✅ 上一阶段文档状态切为“已完成（基线）”：
  - `docs/阶段验收-发布后运行观察与收官验收.md`
- ✅ 同步更新：
  - `docs/新对话接手-总导航.md`
  - `docs/业务流程图-升级版.md`
  - `docs/业务流程图-升级版.html`
  - `README.md`

---

## [V0.71] - 2026-02-27 ✅ 切阶段到「发布后运行观察与收官验收」并完成第1~4步

### 调整
- ✅ 前端阶段锁切换：
  - `frontend/app.js` 中 `pipelineStageLock` 切换为 `post_release_observe`
  - 阶段卡新增第 10 步：`发布后运行观察与收官验收`
- ✅ 首页新增“发布后运行观察与收官验收”面板（5 项）：
  - 发布前检查基线保持
  - 同步心跳持续可用
  - 质量门控维持可发布
  - 配置版本可追溯可回滚
  - 监控异常清零（允许告警）
- ✅ 发布运行手册面板在新阶段继续可见，改为“基线保持/基线回落”口径
- ✅ 新增“收官归档清单”提示区：
  - 显示 `可归档/待归档`
  - 固化归档报告与截图清单口径

### 验收
- ✅ 新增发布后观察验收脚本：
  - `scripts/run_post_release_observe_acceptance.ps1`
- ✅ 最新通过报告：
  - `reports/post_release_observe_acceptance_20260227_162946.json`
- ✅ Web 验收截图：
  - `reports/post_release_stage_step1_desktop_20260227.png`
  - `reports/post_release_stage_step4_desktop_20260227.png`

### 文档
- ✅ 新增阶段验收文档：
  - `docs/阶段验收-发布后运行观察与收官验收.md`
- ✅ 新增收官归档口径文档：
  - `docs/收官归档口径-发布后运行观察与收官验收.md`
- ✅ 同步更新：
  - `docs/阶段验收-发布准备与运行保障.md`
  - `docs/业务流程图-升级版.md`
  - `docs/新对话接手-总导航.md`
  - `docs/接口与表结构改造清单.md`
  - `README.md`

---

## [V0.70] - 2026-02-27 ✅ 发布阶段第4步完成（运行手册+回滚口径固化）

### 调整
- ✅ 首页新增“发布运行手册与回滚口径”面板：
  - 4 步发布顺序（刷新/评分/回测复核/版本复核）
  - 每步支持“复核/补齐”按钮（可跳转或直接执行）
  - 未就绪时显示“禁止发布”，就绪时显示“可执行发布”
- ✅ 新增回滚操作入口：
  - “去系统设置处理版本”
  - “去回测复盘定位 run_id”
- ✅ 阶段提示与发布检查联动保持一致：
  - 第 9 步文案 `发布前检查 X/4`
  - 顶部提示显示是否可继续发布动作

### 验收
- ✅ 发布阶段脚本复跑通过：
  - `reports/release_stage_acceptance_20260227_154957.json`
- ✅ 监控阶段脚本复跑通过（回归基线）：
  - `reports/ops_observability_acceptance_20260227_154518.json`
- ✅ 新增 Web 验收截图：
  - `reports/release_runbook_panel_20260227.png`
  - `reports/release_stage_step4_desktop_20260227.png`

### 文档
- ✅ 新增运行手册文档：
  - `docs/发布运行手册-发布准备与运行保障.md`
- ✅ 发布阶段验收文档更新为“4/4 完成，待确认切阶段”：
  - `docs/阶段验收-发布准备与运行保障.md`
- ✅ 交接口径同步：
  - `README.md`
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `docs/业务流程图-升级版.md`
  - `docs/接口与表结构改造清单.md`

---

## [V0.69] - 2026-02-27 ✅ 切阶段到「发布准备与运行保障」并启动第1~3步

### 调整
- ✅ 前端阶段锁切换：
  - `frontend/app.js` 中 `pipelineStageLock` 切换为 `release_hardening`
  - 阶段卡新增第 9 步：`发布准备与运行保障`
- ✅ 首页新增“发布准备检查”面板（4 项）：
  - 监控健康基线
  - 质量门控可发布
  - 最近回测任务完成
  - 最新配置版本已回灌
- ✅ 阶段提示文案联动发布前检查通过数：
  - 第 9 步文案：`进行中：发布前检查 X/4`
  - 顶部提示：未通过时给出待补齐提醒，通过后提示可继续发布前检查

### 验收
- ✅ 新增发布阶段验收脚本：
  - `scripts/run_release_stage_acceptance.ps1`
- ✅ 最新通过报告：
  - `reports/release_stage_acceptance_20260227_153006.json`
- ✅ Web 验收截图：
  - `reports/release_stage_panel_20260227.png`
  - `reports/release_check_panel_20260227.png`
  - `reports/release_stage_step1_panel_20260227.png`
  - `reports/release_stage_step1_desktop_20260227.png`

### 文档
- ✅ 新增发布阶段验收文档：
  - `docs/阶段验收-发布准备与运行保障.md`
- ✅ 上一阶段文档状态切为“已完成（基线）”：
  - `docs/阶段验收-监控与验收可见性固化.md`
- ✅ 口径同步：
  - `README.md`
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `docs/业务流程图-升级版.md`
  - `docs/接口与表结构改造清单.md`

---

## [V0.68] - 2026-02-27 ✅ T阶段第3/4步完成（联动增强 + 验收固化）

### 调整
- ✅ 监控信号与阶段卡联动增强：
  - `frontend/app.js`：
    - 监控快照新增健康聚合（`severityCount / healthLevel / firstIssueItem / summaryText`）
    - 第 8 步文案改为：`监控信号 X/5 已固化 · 异常A 告警B 待接入C`
    - 顶部阶段提示支持等级联动（异常/告警/待接入/全健康）
    - 监控面板状态标签支持 `异常/告警/已接入/待接入`
- ✅ 阶段提示样式增强：
  - `frontend/style.css` 新增 `.pipeline-stage-tip.ok/.warn/.error/.pending`

### 验收
- ✅ 新增命令化验收脚本：
  - `scripts/run_ops_observability_acceptance.ps1`
- ✅ 最新通过报告：
  - `reports/ops_observability_acceptance_20260227_150025.json`
- ✅ Web 验收截图：
  - `reports/ops_observability_acceptance_desktop_20260227.png`
  - `reports/ops_observability_acceptance_mobile_20260227.png`
  - `reports/ops_observability_stage_panel_20260227.png`
  - `reports/ops_observability_monitor_panel_20260227.png`

### 文档
- ✅ 更新监控阶段验收文档为“4/4 已完成，待确认切阶段”：
  - `docs/阶段验收-监控与验收可见性固化.md`
- ✅ 同步更新接手口径：
  - `README.md`
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`

---

## [V0.67] - 2026-02-27 ✅ 切阶段到 T（监控与验收可见性固化）并启动第1步

### 调整
- ✅ 前端阶段锁切换：
  - `frontend/app.js` 中 `pipelineStageLock` 切换为 `ops_observability`
  - 阶段卡新增第 8 步：`监控与验收可见性固化`
- ✅ 首页新增“系统监控与验收可见性”面板：
  - 监控信号：同步心跳、质量门控快照、双源比对快照、回测任务可追踪、配置版本可追踪
  - 阶段提示联动显示：`监控信号 X/5 已固化`
- ✅ 可读性修正：
  - 回测任务表头“状态”文案修复

### 文档
- ✅ 新增监控阶段验收文档（进行中）：
  - `docs/阶段验收-监控与验收可见性固化.md`
- ✅ 阶段锁口径同步更新：
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `docs/阶段验收-UI美化-搜索分类可读性.md`
  - `docs/业务流程图-升级版.md`
  - `README.md`
  - `docs/接口与表结构改造清单.md`
- ✅ 监控阶段首版截图：
  - `reports/ops_stage_step1_desktop_20260227.png`
  - `reports/ops_stage_step1_mobile_20260227.png`

---

## [V0.66] - 2026-02-27 ✅ UI美化阶段收口（可读性修复 + 验收证据固化）

### 调整
- ✅ 前端中文可读性与乱码修复：
  - 修复首页/设置页/弹窗/详情面板多处乱码文案
  - 修复状态与兜底文案（如“状态/缺失/加载中/失败提示”）
  - 新增 favicon 占位（`data:,`）减少无关 404 噪声
- ✅ 启动链路稳健性修复：
  - `start.bat` 优先选择项目虚拟环境解释器，避免误用 MYSYS Python 导致依赖缺失
  - `setup.bat` 统一创建/安装 `.venv-win`，降低环境漂移

### 验收
- ✅ UI阶段桌面截图：`reports/ui_polish_acceptance_desktop_wide_20260227.png`
- ✅ UI阶段移动截图：`reports/ui_polish_acceptance_mobile_20260227.png`
- ✅ 乱码扫描命令返回空结果：
  - `rg -n "锟|鈥|闃|锛|锟斤拷|�" frontend/index.html frontend/app.js frontend/style.css -S`

### 文档
- ✅ UI阶段验收文档更新为“已达切阶段门槛（待确认）”：
  - `docs/阶段验收-UI美化-搜索分类可读性.md`
- ✅ 交接与导航口径更新：
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `README.md`
  - `docs/业务流程图-升级版.md`

---

## [V0.65] - 2026-02-27 ✅ 阶段锁切换至 UI 美化并启动首批可见优化

### 调整
- ✅ 阶段锁从 `AI增强` 切换到 `UI美化`：
  - 前端默认阶段锁：`frontend/app.js` 中 `pipelineStageLock='ui_polish'`
  - 阶段卡语义修正：切锁后 `AI增强` 显示“已完成”，不再误标为阻塞
- ✅ 首页“预测排行”筛选增强：
  - 新增得分区间筛选（强势/观察/弱势）
  - 新增排序切换（Rank/得分/日涨幅/偏差）
  - 新增一键重置筛选
  - 新增筛选结果摘要（总数/行业数/概念数）
- ✅ 补齐缺失交互函数：
  - `filterRanking`
  - `toggleFavFilter`
  - `resetRankingFilters`
  - `filterSectors`
  - `filterRelations`

### 文档
- ✅ 阶段锁口径同步更新：
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `README.md`
  - `docs/阶段验收-AI增强-参数优化建议与配置版本化.md`
  - `docs/业务流程图-升级版.md`

---

## [V0.64] - 2026-02-27 ✅ AI增强阶段稳定性回归收口（10轮）

### 新增
- ✅ 稳定性脚本新增预刷新能力：`scripts/run_ai_enhancement_stability.ps1`
  - 新增参数 `PreRefresh`（默认 `true`）
  - 稳定性回归前自动执行 `POST /api/sectors/refresh`

### 调整
- ✅ AI增强阶段验收文档更新为“已达切阶段门槛（待确认）”：
  - `docs/阶段验收-AI增强-参数优化建议与配置版本化.md`
- ✅ 交接与导航文档同步稳定性结论：
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `docs/新对话接手-总导航.md`
  - `README.md`
- ✅ 流程图状态更新为：
  - `A -> S` 标记为已完成（绿色）
  - `T` 标记为进行中（黄色）
  - 同步文档：`docs/业务流程图-升级版.md/.html`
- ✅ 首页“链路进度（阶段锁）”增强：
  - AI阶段满足 `refeeded` 时显示“已达切阶段门槛（待确认）”
  - 顶部提示同步显示“等待确认后切换下一阶段”

### 验收
- ✅ 稳定性首轮问题复现：`reports/ai_enhancement_stability_20260227_014400.json`
  - 现象：`scoring_status=blocked`（freshness 门控）
- ✅ 修复后 10 轮稳定性通过：`reports/ai_enhancement_stability_20260227_014625.json`
  - 结果：`all_passed=true`、`passed_count=10`、`failed_count=0`

---

## [V0.63] - 2026-02-26 ✅ 回测阶段验收收口并切换到 AI 增强阶段

### 调整
- ✅ 回测阶段验收文档状态更新为“已完成（可切阶段）”：
  - `docs/阶段验收-回测任务编排与生产隔离.md`
- ✅ 首页阶段锁默认推进到第 6 步 `AI增强`：
  - `frontend/app.js` 中 `pipelineStageLock` 从 `backtest_orchestration` 调整为 `ai_enhancement`
- ✅ 首页第 5 步（回测编排）完成判定收紧：
  - 必须存在 `completed` 状态回测任务，避免“无任务也显示完成”
- ✅ 流程图阶段着色更新：
  - `A -> Q` 标记为已完成（绿色）
  - `R -> S` 标记为进行中（黄色）
  - 同步文档：`docs/业务流程图-升级版.md/.html`
- ✅ 阶段交接与总导航切换到新阶段：
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `docs/新对话接手-总导航.md`
  - `README.md`

### 验收
- ✅ 回测阶段一键验收通过：`reports/backtest_stage_acceptance_20260226_214600.json`
- ✅ 质量门控回归基线通过（1轮）：`reports/quality_gate_acceptance_20260226_214608.json`

---

## [V0.62] - 2026-02-26 ✅ 回测阶段可追踪性增强（run_id 视角）

### 新增
- ✅ 回测阶段一键验收脚本：`scripts/run_backtest_stage_acceptance.ps1`
  - 覆盖：触发、终态、取消语义、重试语义、结果查询、`run_type` 隔离
  - 产出：`reports/backtest_stage_acceptance_*.json`
- ✅ 回测阶段稳定性脚本：`scripts/run_backtest_stage_stability.ps1`
  - 支持 `-Runs/-IntervalSec` 连续回归
  - 产出：`reports/backtest_stage_stability_*.json`

### 调整
- ✅ 回测结果接口支持按任务过滤：
  - `GET /api/backtest/results?run_id=...`
  - `GET /api/backtest/results/{target_date}?run_id=...`
- ✅ 回测结果返回补充 `run_id` 与 `params_snapshot`（用于复现追踪）
- ✅ 前端“回测任务状态机”新增“查看结果”动作，支持按 `run_id` 切换结果视角
- ✅ 前端新增 `🧪 校验口径`，可视化展示趋势 vs 单日明细一致性
- ✅ 首页“链路进度（阶段锁）”第 5 步改为实时展示 `回测任务：run_id · 状态`
- ✅ 后端启动时自动补齐历史库 `backtest_results.run_id` 列与索引（兼容旧库）
- ✅ 无效 `target_date` 返回 400（避免 500）

### 文档
- ✅ 更新 `docs/阶段验收-回测任务编排与生产隔离.md`
- ✅ 更新 `README.md`（新增回测阶段一键验收入口）

---

## [V0.61] - 2026-02-26 ✅ 阶段切换（文档与阶段锁）

### 新增
- ✅ 新增回测阶段验收文档：`docs/阶段验收-回测任务编排与生产隔离.md`

### 调整
- ✅ 阶段锁从 `API 拉取 -> 数据质量门控` 切换为 `回测验证与任务编排（run_type 生产隔离）`
- ✅ 同步更新文档：
  - `docs/新对话接手-总导航.md`
  - `docs/开发交接-当前阶段-2026-02-26.md`
  - `docs/接口与表结构改造清单.md`
  - `docs/阶段验收-数据质量门控.md`（改为回归基线）
  - `README.md`
  - `docs/业务流程图-升级版.md`

### 验收基线
- ✅ 质量门控最新通过报告：`reports/quality_gate_acceptance_20260226_192648.json`

---

## [V0.1] - 2026-02-08 ✅ 已完成

### 新增
- ✅ 创建项目文件夹 `sector-graph`
- ✅ 创建 `docs/想法文档.md` - 需求规划
- ✅ 创建 `docs/CHANGELOG.md` - 变更记录
- ✅ 创建 `v0.1/data.json` - 5个测试板块数据
- ✅ 创建 `v0.1/index.html` - 主页面
- ✅ 创建 `v0.1/style.css` - 深色主题样式
- ✅ 创建 `v0.1/app.js` - ECharts关系图渲染

### 验收结果
- ✅ 页面显示5个板块节点
- ✅ 节点之间有连线并显示关系类型
- ✅ 鼠标悬停显示涨跌幅tooltip
- ✅ 点击节点右侧显示详情
- ✅ 节点可拖拽移动

---

## 下一阶段

- V0.2 本地数据管理（SQLite + 增删改查界面）

---

## [V0.2] - 2026-02-09 ~ 2026-02-12 ✅ 已完成（补录）

### 新增
- ✅ 引入 SQLite 持久化（`server/database.py`）
- ✅ 建立核心数据模型（`sectors / relations / daily_data / predictions / config`）
- ✅ 完成板块与关联基础 CRUD API
- ✅ 提供初始化脚本（`setup.bat` / `scripts/init_db.py`）

### 结果
- ✅ 由静态 JSON 过渡到数据库驱动
- ✅ 前后端数据读写链路打通

---

## [V0.3] - 2026-02-12 ✅ 已完成（补录）

### 新增
- ✅ 关系图谱可视化增强（ECharts Graph）
- ✅ 前端多页面/多面板组织（排行、图谱、管理）
- ✅ 历史原型保留（`v0.1 / v0.2 / v0.21 / v0.3`）

### 结果
- ✅ 图谱交互能力可用（缩放、拖拽、节点查看）
- ✅ 页面结构从 Demo 进入可维护形态

---

## [V0.4] - 2026-02-12 ~ 2026-02-22 ✅ 已完成（补录）

### 新增
- ✅ 接入新浪板块资金流 API（`/api/sectors/refresh`）
- ✅ 偏差累计评分引擎（`server/core/scoring.py`）
- ✅ 排行与摘要接口（`/api/ranking`、`/api/summary`）
- ✅ 回测引擎与结果接口（`server/core/backtest.py`、`/api/backtest/*`）
- ✅ 配置中心（AI/算法配置持久化）

### 结果
- ✅ 形成“刷新数据 -> 计算评分 -> 查看排行/图谱”的完整闭环
- ✅ 回测复盘具备可视化与明细查看能力

---

## [V0.5] - 2026-02-22 ~ 2026-02-23 ✅ 已完成（补录）

### 新增
- ✅ AI 关联分析流程（待确认队列）
- ✅ AI 结果确认入库（pending -> relation）
- ✅ 板块得分 AI 解释器
- ✅ 系统自愈能力：清理未锁定关联、同步状态查询
- ✅ 前端设置页与运营化交互完善

### 结果
- ✅ AI 从“可选工具”升级为“可控辅助流程”（确认后入库）
- ✅ 系统从原型阶段进入可持续迭代阶段

---

## [Docs] - 2026-02-24 ✅ 文档状态校准

### 调整
- ✅ 更新 `README.md`：明确 `sector-graph` 为主开发项目
- ✅ 补录 `CHANGELOG` 的 V0.2 ~ V0.5 阶段内容
- ✅ 对齐当前代码真实状态（后端 v0.4、前端 v0.5）

### 说明
- `go-stock-dev` 继续保留为参考项目，不作为主线开发目录。

---

## [V0.6] - 2026-02-25 🚧 进行中（数据源稳定性专项）

### 新增
- ✅ 多数据源健康检查结果中新增“降级”语义（`source_degraded`）
- ✅ 东方财富数据源不可达时，增加可用降级路径（经 AKShare/Sina 板块通道兜底）
- ✅ 同步状态返回中补充数据源信息：请求源/实际源/校验源/降级标记
- ✅ 系统设置页新增代理配置项：
  - `是否启用代理`
  - `代理地址`
  - `代理策略(auto / force_direct / force_proxy)`
- ✅ 系统设置页数据源状态默认可见（未点击检查前显示“未检测”）

### 调整
- ✅ HTTP 请求层支持代理策略与重试策略组合
- ✅ 默认策略调整为 `auto`（直连优先，代理兜底）
- ✅ 数据源健康检查与刷新链路对齐，避免“检查通过但刷新失败”的体验割裂
- ✅ 文档同步更新：`README.md`、`历史开发过程记忆.md`、`接口与表结构改造清单.md`、`数据状态机.md`
- ✅ A1 核心字段落地：`predictions.run_type/run_id` 唯一键升级 + `daily_data.quality_status/quality_reason` 主链路生效
- ✅ 新增迁移脚本能力：`scripts/migrate_p0_state_fields.py` 可将旧 `predictions` 唯一键迁移为 `(sector_id,date,run_type)`
- ✅ A2 首项落地：`backtest_jobs` 任务表与查询接口（`/api/backtest/jobs`、`/api/backtest/jobs/{run_id}`）
- ✅ 回测任务增强：支持取消/重试接口（`/api/backtest/jobs/{run_id}/cancel`、`/api/backtest/jobs/{run_id}/retry`）

### 验收结论
- ✅ 在代理 `127.0.0.1:7890` 下，`sina`/`akshare` 可稳定使用
- ✅ `eastmoney` 在网络抖动场景可降级运行，不阻断主链路
- ✅ 前端可直接看到数据源状态，不再依赖先点“检查”才出现列表

### 新开发者接手提示
- 主开发目录：`sector-graph`
- 参考目录：`go-stock-dev`（仅参考实现，不直接作为主线）
- 优先阅读：
  - `server/routes/sector_routes.py`
  - `server/core/http_client.py`
  - `frontend/app.js`
  - `docs/接口与表结构改造清单.md`
  - `docs/数据状态机.md`

---

## [Process] - 2026-02-26 ⚠️ 顺序纠偏

### 说明
- 本轮出现一次“阶段顺序偏移”：在用户要求继续“数据质量门控阶段”时，提前进入了 A2 回测任务扩展。
- 原因判定：执行控制偏差（阶段锁未显式确认 + “继续”指令歧义 + 长上下文多目标并行），非代码记忆缺失。

### 处理
- 新增交接文档：`docs/开发交接-当前阶段-2026-02-26.md`
- 新增总导航文档：`docs/新对话接手-总导航.md`
- 明确当前阶段锁定为：`API 拉取 -> 数据质量门控`
- 后续开发按“阶段内最小步推进”，未完成当前阶段不跨入回测/AI增强。

---

## [V0.6] - 2026-02-26 ✅ 质量门控验收固化

### 新增
- ✅ 阶段验收脚本：`scripts/run_quality_gate_acceptance.ps1`
  - 自动执行：主链路 + 阻断场景 + 失败行场景
  - 产出：`reports/quality_gate_acceptance_*.json/.log`
- ✅ 根目录一键入口：`check_quality_gate_acceptance.bat`
- ✅ 连续稳定性脚本：`scripts/run_quality_gate_stability.ps1`
  - 支持 `-Runs/-IntervalSec` 多轮验收
  - 产出：`reports/quality_gate_stability_*.json/.log`
- ✅ 阶段验收说明：`docs/阶段验收-数据质量门控.md`

### 调整
- ✅ `README.md` 增加当前阶段一键验收入口
- ✅ 验收报告结构补充 `checks` 与 `failed_checks` 字段
- ✅ 验收判定升级为“所有检查项通过才 PASS”
- ✅ `scripts/quality_gate_smoke.py` 增加刷新重试与超时兜底，降低连续回归的偶发超时失败

### 验收
- ✅ 执行 `check_quality_gate_acceptance.bat` 通过
- ✅ 最新报告：`reports/quality_gate_acceptance_20260226_160845.json`
- ✅ 执行 `run_quality_gate_stability.ps1 -Runs 3 -IntervalSec 10` 连续通过
- ✅ 稳定性汇总：`reports/quality_gate_stability_20260226_162459.json`
- ✅ 执行 `run_quality_gate_stability.ps1 -Runs 5 -IntervalSec 10` 连续通过
- ✅ 稳定性汇总：`reports/quality_gate_stability_20260226_164000.json`
- ✅ 执行 `run_quality_gate_stability.ps1 -Runs 10 -IntervalSec 10` 连续通过
- ✅ 稳定性汇总：`reports/quality_gate_stability_20260226_165519.json`

---

## [V0.6] - 2026-02-26 ✅ 数据源扩展（TuShare）

### 新增
- ✅ 新增数据源：`tushare`
  - 后端拉取：`moneyflow_ind_ths`（行业）+ `moneyflow_cnt_ths`（概念）
  - 健康检查与推荐链路纳入 `tushare`
- ✅ 新增配置项：`data.tushare_token`
  - `GET /api/config` 返回脱敏字段：`tushare_token_masked / tushare_token_set`
  - `POST /api/config` 支持保存 token（空值不覆盖）
- ✅ 前端系统设置支持：
  - 主源/校验源下拉包含 `TuShare`
  - 新增 `TuShare Token` 输入框
  - 未检测占位列表包含 `TuShare`

### 验证
- ✅ `GET /api/data-sources/health` 返回 `tushare` 状态
- ✅ 未配置 token 时，`tushare` 显示错误但不影响主链路
- ✅ 选择 `tushare` 作为主源且 token 缺失时，刷新链路自动降级回 `sina`
