# go-stock 参考实现结论（面向 sector-graph）

更新时间：2026-02-25

## 1. 本地运行验证结果

- 参考仓库路径：`h:\bankuai\go-stock-dev\go-stock-dev`
- 可执行性验证：
  - `go build ./...` 通过
  - `go test ./backend/data -run TestGetStockConceptInfo -count=1 -v` 通过（成功拉取东方财富概念板块数据）

结论：该项目的数据抓取链路在当前环境可跑通，可作为接口组织与异常处理的参考。

## 2. 值得借鉴的实现点

### 2.1 配置层有“超时/代理”开关

- 位置：`backend/data/settings_api.go`
- 已有字段：
  - `crawl_time_out`
  - `http_proxy`
  - `http_proxy_enabled`

可借鉴：我们在 `sector-graph` 已开始做统一 HTTP 配置，这个方向正确，应继续扩展到“按数据源独立配置”。

### 2.2 多来源并行存在（Sina / Tencent / Eastmoney / Tushare）

- 位置：`backend/data/stock_data_api.go`
- 特点：
  - 行情、K线、概念、资金流等来自不同站点
  - 对不同市场（A/HK/US）走不同接口

可借鉴：我们的“多源+主备”设计应保留“按市场/按能力路由”的思想，而不是所有源做同构替换。

### 2.3 源站特殊解析经验可复用

- JS 包裹 JSON（`callback(...)`）解析：大量使用 `otto` 执行
- 编码处理：GB18030 -> UTF-8 转换
- 防封锁 header：`Host/Referer/User-Agent`

可借鉴：我们要把这些放进适配器层，不污染业务层。

## 3. 不建议照搬的点（需要规避）

### 3.1 HTTP 客户端初始化分散

- 各函数大量 `resty.New()`，缺少统一拦截、统一重试、统一日志追踪。

影响：参数不一致、问题排查困难。

### 3.2 代理使用不统一

- 有些函数读取配置代理，有些硬编码代理（例：`SetProxy("http://localhost:10809")`）。

影响：环境迁移风险高。

### 3.3 字段标准化层薄弱

- 多源字段直接进入业务模型，缺“原始层/标准层/特征层”清晰边界。

影响：后续接入新源时回归成本高。

### 3.4 重试与质量评分缺统一框架

- 超时较常见，但没有统一“重试 + 熔断 + 质量打分”策略。

影响：出现脏数据时很难自动降级或回滚。

## 4. 对 sector-graph 的落地建议（按优先级）

## P0（本周）

1. 完成统一 HTTP 工厂收口（已在进行）
   - 统一超时、重试、退避、代理、UA
   - 请求日志统一记录：`source`, `url`, `latency_ms`, `status`, `retry_count`
2. 数据源身份可见化
   - API 返回 `source_name`, `source_version`, `fetched_at`
   - 前端顶部显示当前主源与刷新时间（秒级）
3. 错误分层
   - 区分网络错误、解析错误、字段缺失错误，便于验证与告警

## P1（下一阶段）

1. 建立三层数据模型
   - `raw`：原始 payload（按 source 存）
   - `normalized`：统一字段
   - `features`：评分/排序输入
2. 双源对比模式
   - 主源写业务表，校验源只做对比
   - 输出：匹配率、偏差、告警列表
3. 源适配器接口
   - `fetch()`, `normalize()`, `quality_score()`, `supports()`

## P2（后续）

1. 多源融合策略
   - 优先级、置信度、时间窗、冲突仲裁规则
2. 付费源接入预留
   - 将来接入 `unshared` 等只需新增 adapter，不改业务主链路

## 5. 立即可执行的下一步（建议）

1. 在 `sector-graph` 增加“数据源诊断面板”接口：
   - 最近 20 次抓取的源、耗时、成功率、异常类型
2. 把当前 `sina/akshare` 两个源先接入同一 `SourceAdapter` 抽象
3. 在刷新接口加 `quality_summary` 返回，前端先展示只读指标

