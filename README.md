# 板块轮动预测系统 (sector-graph)

## 项目定位
`sector-graph` 是当前主开发项目（自研），目标是构建 A 股板块关系图谱与轮动预测系统。  
`go-stock-dev` 仅作为参考项目（API 与实现思路参考），不是本项目主线代码。

## 当前开发状态（2026-02-27）
- 后端：`FastAPI + SQLAlchemy + SQLite`
- 前端：`原生 HTML/CSS/JS + ECharts`
- 版本现状：
  - 后端 API 标识：`v0.4`（见 `server/app.py`）
  - 前端主逻辑标识：`v0.5`（见 `frontend/app.js`）
- 当前阶段锁：
  - `维护模式（回归巡检）`
- 已完成阶段：
  - `API 拉取 -> 数据质量门控`
  - 最新验收报告：`reports/quality_gate_acceptance_20260226_214608.json`
  - `回测验证与任务编排（run_type 生产隔离）`
  - 最新验收报告：`reports/backtest_stage_acceptance_20260226_214600.json`
- 已形成可运行主链路：
  - 刷新数据 -> 计算评分 -> 查看排行/图谱
  - 回测复盘 -> AI 分析 -> 人工确认入库
  - 参数建议 -> 配置版本化 -> 应用并回灌评分/回测（`S -> K` 闭环）
- AI增强阶段稳定性：
  - 10 轮连续通过：`reports/ai_enhancement_stability_20260227_014625.json`
  - 阶段验收文档：`docs/阶段验收-AI增强-参数优化建议与配置版本化.md`
- UI美化阶段（已完成，作为回归基线）：
  - 首页排行筛选/排序/重置与结果摘要已完成
  - 阶段卡已切换到 `UI美化`，AI增强显示“已完成”
  - 文案可读性与乱码修复已完成（首页/设置页/弹窗/详情面板）
  - 验收截图：
    - `reports/ui_polish_acceptance_desktop_wide_20260227.png`
    - `reports/ui_polish_acceptance_mobile_20260227.png`
- 上一阶段（监控与验收可见性固化）已完成并转为基线
  - 文档：`docs/阶段验收-监控与验收可见性固化.md`
  - 报告：`reports/ops_observability_acceptance_20260227_150025.json`
- 上一阶段（发布准备与运行保障）已完成并转为基线
  - 文档：`docs/阶段验收-发布准备与运行保障.md`
  - 报告：`reports/release_stage_acceptance_20260227_162946.json`
  - 运行手册：`docs/发布运行手册-发布准备与运行保障.md`
- 上一阶段（发布后运行观察与收官验收）已完成并转为基线
  - 文档：`docs/阶段验收-发布后运行观察与收官验收.md`
  - 报告：`reports/post_release_observe_acceptance_20260227_162946.json`
  - 归档口径：`docs/收官归档口径-发布后运行观察与收官验收.md`
- 上一阶段（收官归档与维护交接）已完成并转为基线
  - 文档：`docs/阶段验收-收官归档与维护交接.md`
  - 报告：`reports/closure_archive_acceptance_20260227_175746.json`
- 当前阶段（维护模式-回归巡检）：
  - 阶段卡新增第 12 步并切换为进行中
  - 首页新增“维护模式（回归巡检）”面板（5 项巡检检查）
  - 当前状态：`维护巡检通过（5/5），可持续运行`
  - 验收脚本：`.\scripts\run_maintenance_mode_acceptance.ps1 -BaseUrl http://127.0.0.1:<PORT>`
  - 稳定性脚本：`.\scripts\run_maintenance_mode_stability.ps1 -BaseUrl http://127.0.0.1:<PORT> -Runs 3 -IntervalSec 15`
  - 一键入口：`check_maintenance_mode_stability.bat`
  - 最新报告：`reports/maintenance_mode_acceptance_20260227_225408.json`
  - 稳定性汇总：`reports/maintenance_mode_stability_20260227_225046.json`
  - 告警日志：`reports/maintenance_mode_alerts_20260227_225046.jsonl`
  - 验收截图：`reports/maintenance_mode_stage_step12_desktop_20260227.png`
  - 阶段文档：`docs/阶段验收-维护模式-回归巡检.md`

## 本轮关键更新（V0.6 数据源稳定性专项）
- 数据源支持健康检查与推荐主源
- 支持双源比对（主源 + 校验源）
- 同步状态显示“请求源/实际源/校验源/降级标记”
- 代理配置可视化（启用、代理地址、代理策略）
- 系统设置页默认展示所有数据源状态（未检测）
- 东方财富不可用时支持降级兜底，避免整链路中断
- 数据质量门控支持“低/中/高”系统值预设，一键切换并保存

## 已实现功能
- 板块管理：刷新、查询、编辑、删除、历史日线查看
- 关联管理：增删改查、来源筛选、锁定控制、清理未锁定关系
- 评分与排行：偏差累计评分、当日排行输出
- 回测与复盘：后台回测任务、走势图、单日明细
- AI 能力：
  - 板块关系分析（待确认队列）
  - 批量确认入库
  - 板块得分解释器
- 配置中心：
  - AI 提供商/API Key/模型参数
  - 算法参数
  - 数据源与代理参数
- 首页摘要：最近数据、命中率、最强板块提示、总量统计

## 项目结构
```text
sector-graph/
├── docs/                    # 需求、设计、变更记录
├── data/                    # SQLite 数据文件
├── frontend/                # 前端页面与交互
├── server/                  # FastAPI 服务、路由、核心算法
├── scripts/                 # 初始化与模拟脚本
├── v0.1/ v0.2/ v0.21/ v0.3/ # 历史原型（保留参考）
├── setup.bat                # 首次安装依赖
└── start.bat                # 启动系统
```

## 启动方式
1. 首次安装依赖：
```bat
setup.bat
```
2. 启动系统：
```bat
start.bat
```
3. 浏览器访问：
```text
http://127.0.0.1:<PORT>
```

## 主要接口分组
- `/api/sectors`：板块数据
- `/api/relations`：关联管理
- `/api/scoring`、`/api/ranking`：评分与排行
- `/api/ai/*`：AI 分析与确认
- `/api/backtest/*`：回测与复盘
- `/api/config`：系统配置
- `/api/data-sources/*`：数据源健康检查与推荐
- `/api/sync-status`：同步状态（含数据源/降级信息）
- `/api/summary`：首页摘要

## 新开发者快速接手
1. 先读总导航（强约束）：
   - `docs/新对话接手-总导航.md`
2. 再读文档：
   - `docs/开发交接-当前阶段-2026-02-26.md`
   - `docs/阶段验收-UI美化-搜索分类可读性.md`
   - `docs/阶段验收-回测任务编排与生产隔离.md`
   - `docs/阶段验收-发布后运行观察与收官验收.md`
   - `docs/阶段验收-收官归档与维护交接.md`
   - `docs/阶段验收-维护模式-回归巡检.md`
   - `docs/阶段验收-数据质量门控.md`
   - `docs/CHANGELOG.md`
   - `docs/数据状态机.md`
   - `docs/接口与表结构改造清单.md`
   - `docs/go-stock-数据源参考与迁移建议.md`
3. 再看代码入口：
   - `server/app.py`
   - `server/routes/backtest_routes.py`
   - `server/core/backtest.py`
   - `server/routes/score_routes.py`
   - `frontend/app.js`
4. 本地验证建议顺序：
   - `系统设置 -> 检查数据源连通性`
   - `预测排行 -> 刷新数据`
   - `执行计算评分 -> 查看排行更新`
5. 上一阶段回归基线（数据质量门控）：
   - `.\scripts\run_quality_gate_acceptance.ps1`
   - `check_quality_gate_acceptance.bat`
   - 连续稳定性验证：`.\scripts\run_quality_gate_stability.ps1 -Runs 3 -IntervalSec 60`
   - 说明文档：`docs/阶段验收-数据质量门控.md`
6. 回测阶段验收口径（已完成，作为回归基线）：
   - 说明文档：`docs/阶段验收-回测任务编排与生产隔离.md`
   - 核心接口：`/api/backtest/run`、`/api/backtest/jobs/*`、`/api/backtest/results*`、`/api/ranking?run_type=prod|backtest`
   - 一键验收脚本：`.\scripts\run_backtest_stage_acceptance.ps1 -BaseUrl http://127.0.0.1:<PORT> -Days 20`
   - 稳定性脚本：`.\scripts\run_backtest_stage_stability.ps1 -BaseUrl http://127.0.0.1:<PORT> -Runs 3 -IntervalSec 10 -Days 20`
7. 当前阶段（维护模式-回归巡检）：
   - 目标：持续巡检关键链路，确保版本长期可运行、可追溯
   - 当前进展：维护巡检 5/5 已通过（进入持续巡检）
   - 一键验收脚本：`.\scripts\run_maintenance_mode_acceptance.ps1 -BaseUrl http://127.0.0.1:<PORT>`
   - 连续巡检脚本：`.\scripts\run_maintenance_mode_stability.ps1 -BaseUrl http://127.0.0.1:<PORT> -Runs 3 -IntervalSec 15`
   - 一键入口（Windows）：`check_maintenance_mode_stability.bat`
   - 最新报告：`reports/maintenance_mode_acceptance_20260227_225408.json`
   - 阶段说明：`docs/阶段验收-维护模式-回归巡检.md`

## 开发约定
- 主开发目录：`sector-graph`
- 参考目录：`go-stock-dev`（只读参考）
- 阶段变更请同步维护：`docs/CHANGELOG.md`


### 运行端口说明
- start.bat 会自动选择可用端口（优先 8000/18008/18080/18081）。
- 启动后请以终端输出的 URL 为准，例如 http://127.0.0.1:<PORT>。
