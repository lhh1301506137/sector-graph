/**
 * 板块轮动预测系统 V0.5 - 核心逻辑
 * 整合了回测验证AI 分析及可视化详情面板
 */

const App = {
    state: {
        currentPage: 'ranking',
        rankingData: [],
        sectorsData: [],
        sectorsAllData: [],
        sectorTableSort: { key: 'id', order: 'asc' },
        sectorIgnoreKeywords: [],
        sectorIgnoreKeywordsLoaded: false,
        currentSectorManageView: 'sectors',
        selectedSectorIds: [],
        relationsData: [],
        logicsData: [],
        aiPendingData: [],
        config: {},
        favFilter: false,
        isLoading: false,
        graphInstance: null,
        backtestChart: null,
        lastDataSourceHealth: null,
        lastQualityStatus: null,
        lastQualityTrend: null,
        lastQualityFailedSamples: null,
        lastQualityLatestSnapshot: null,
        qualitySampleFilters: {
            reason: '',
            categoryType: '',
            search: '',
            limit: 6,
        },
        qualitySampleDebounceTimer: null,
        qualitySelectedDate: '',
        qualityPresetListenersBound: false,
        lastSyncStatus: null,
        lastBacktestRunId: '',
        pipelineStageLock: 'maintenance_mode',
        rankingFilterDebounceTimer: null,
        backtestJobs: [],
        backtestSelectedRunId: '',
        backtestPollingTimer: null,
        backtestPollingEnabled: true,
        backtestJobsSignature: '',
        backtestResultRunId: '',
        backtestResultParamsSnapshot: '{}',
        backtestConsistency: {
            runId: '',
            status: 'idle',
            checkedAt: '',
            total: 0,
            mismatches: 0,
            message: '口径校验：未执行',
        },
        optimizationSuggestions: [],
        lastOptimizationSuggestion: null,
        configVersions: [],
        configVersionStatus: null,
        opsMonitorSelectedSignal: '',
        maintenanceInspection: null,
        maintenanceInspectionPollingTimer: null,
    },

    // ============================================================
    // 初始化与核心控制
    // ============================================================
    async init() {
        console.log('🚀 应用初始化...');
        this.updateStatus('系统就绪');
        await this.loadSyncStatus();
        await this.loadDataQualityStatus();
        await this.loadSectors(); // 优先加载基础数据
        await this.loadSummary(); // 加载顶部看板
        await this.loadBacktestJobs(true); // 预加载回测任务，首页阶段卡可直接展示 run_id
        await this.loadOptimizationSuggestions();
        await this.loadConfigVersions();
        await this.loadMaintenanceInspectionStatus(true);
        this.startMaintenanceInspectionPolling();
        this.renderBacktestConsistencyStatus();
        this.renderOpsMonitorPanel();
        await this.switchPage('ranking'); // 统一通过 switchPage 初始化第一页
        this.renderPipelineStageProgress();
    },

    async loadSyncStatus() {
        try {
            const res = await API.getSyncStatus();
            this.state.lastSyncStatus = res;
            const badge = document.getElementById('sync-status-badge');
            if (badge) {
                const sourceDisplay = res.source_display_name || res.source_name || '未知来源';
                const requestedSourceDisplay = res.requested_source_display_name || res.requested_source_name || sourceDisplay;
                const syncDate = res.last_sync_date || '暂无数据';
                const syncAt = res.last_sync_at || '';
                const syncTime = syncAt && syncAt.includes(' ') ? syncAt.split(' ').pop() : (syncAt || '--:--:--');
                const fallbackHint = res.fallback_used ? `（降级: ${requestedSourceDisplay} -> ${sourceDisplay}）` : '';
                const degradedHint = res.source_degraded ? '（降级数据）' : '';
                const verifyDisplay = (res.dual_compare_enabled && (res.verify_source_display_name || res.verify_source_name))
                    ? ` · 校验源: ${res.verify_source_display_name || res.verify_source_name}`
                    : '';
                badge.innerText = `📅 数据同步于: ${syncDate} ${syncTime} · 数据源: ${sourceDisplay}${degradedHint}${fallbackHint}${verifyDisplay}`;
                const c = res.compare || {};
                const reason = (c.message || '').toString();
                const reasonShort = reason ? `${reason.slice(0, 72)}${reason.length > 72 ? '...' : ''}` : '';
                const fallbackReason = (res.fallback_reason || '').toString();
                const fallbackReasonShort = fallbackReason ? `${fallbackReason.slice(0, 72)}${fallbackReason.length > 72 ? '...' : ''}` : '';
                badge.title = syncAt
                    ? `最后刷新时间: ${syncAt} | 双源比对: ${c.status || 'disabled'} | 匹配:${c.matched_count || 0} 警告:${c.warn_count || 0}${fallbackReasonShort ? ` | 降级: ${fallbackReasonShort}` : ''}${reasonShort ? ` | 原因: ${reasonShort}` : ''}`
                    : '';

                const compareMain = document.getElementById('sum-compare-main');
                const compareSub = document.getElementById('sum-compare-sub');
                if (compareMain && compareSub) {
                    const status = c.status || 'disabled';
                    if (status === 'ok') {
                        compareMain.innerText = `OK · 平均差${c.mean_abs_diff ?? 0}%`;
                    } else if (status === 'disabled') {
                        compareMain.innerText = 'disabled';
                    } else {
                        compareMain.innerText = status;
                    }
                    if (status === 'error' && reasonShort) {
                        compareSub.innerText = reasonShort;
                        compareSub.title = reason;
                    } else {
                        compareSub.innerText = `匹配${c.matched_count || 0} / 警告${c.warn_count || 0}`;
                        compareSub.title = '';
                    }
                }
            }
            this.renderOpsMonitorPanel();

            const ingestMain = document.getElementById('sum-ingest-main');
            const ingestSub = document.getElementById('sum-ingest-sub');
            if (ingestMain && ingestSub) {
                const totalRows = Number(res.last_total_rows || 0);
                const okRows = Number(res.last_quality_ok_rows || 0);
                const failedRows = Number(res.last_quality_failed_rows || 0);
                const newSectors = Number(res.last_new_sectors || 0);
                const updatedRows = Number(res.last_updated_rows || 0);
                if (totalRows > 0) {
                    ingestMain.innerText = `通过 ${okRows}/${totalRows}`;
                    ingestSub.innerText = `新增${newSectors} / 更新${updatedRows} / 失败${failedRows}`;
                } else {
                    ingestMain.innerText = '--';
                    ingestSub.innerText = '新增0 / 更新0 / 失败0';
                }
            }
            this.renderPipelineStageProgress();
            this.renderOpsMonitorPanel();
        } catch (e) {
            console.error('获取同步状态失败:', e);
            this.renderPipelineStageProgress();
            this.renderOpsMonitorPanel();
        }
    },

    async loadSummary() {
        try {
            const data = await API.getSummary();
            document.getElementById('sum-date').innerText = data.latest_date;
            document.getElementById('sum-hit').innerText = data.hit_rate;
            document.getElementById('sum-alert').innerText = data.alert_sector;
            document.getElementById('sum-total').innerText = data.total_count;
        } catch (e) {
            console.error('加载摘要失败:', e);
        }
    },

    async loadMaintenanceInspectionStatus(silent = true) {
        try {
            const data = await API.getMaintenanceInspectionLatest(5);
            this.state.maintenanceInspection = data || null;
            this.renderOpsMonitorPanel();
            this.renderPipelineStageProgress();
            this.renderMaintenanceModePanel();
        } catch (e) {
            console.error('加载维护巡检状态失败:', e);
            if (!silent) this.showToast('加载维护巡检状态失败，请查看后端日志。', 'error');
        }
    },

    startMaintenanceInspectionPolling() {
        if (this.state.maintenanceInspectionPollingTimer) {
            clearInterval(this.state.maintenanceInspectionPollingTimer);
            this.state.maintenanceInspectionPollingTimer = null;
        }
        this.state.maintenanceInspectionPollingTimer = setInterval(async () => {
            await this.loadMaintenanceInspectionStatus(true);
        }, 15000);
    },

    stopMaintenanceInspectionPolling() {
        if (this.state.maintenanceInspectionPollingTimer) {
            clearInterval(this.state.maintenanceInspectionPollingTimer);
            this.state.maintenanceInspectionPollingTimer = null;
        }
    },

    getPipelineStageDefinitions() {
        return [
            { id: 'api_fetch', label: 'API拉取' },
            { id: 'quality_gate', label: '数据质量门控' },
            { id: 'ingest_align', label: '对齐入库' },
            { id: 'publish_prod', label: '生产评分发布' },
            { id: 'backtest_orchestration', label: '回测任务编排与生产隔离' },
            { id: 'ai_enhancement', label: 'AI增强' },
            { id: 'ui_polish', label: 'UI美化' },
            { id: 'ops_observability', label: '监控与验收可见性固化' },
            { id: 'release_hardening', label: '发布准备与运行保障' },
            { id: 'post_release_observe', label: '发布后运行观察与收官验收' },
            { id: 'closure_archive', label: '收官归档与维护交接' },
            { id: 'maintenance_mode', label: '维护模式（回归巡检）' },
        ];
    },

    getOpsObservabilitySnapshot() {
        const sync = this.state.lastSyncStatus || {};
        const quality = this.state.lastQualityLatestSnapshot || this.state.lastQualityStatus || {};
        const compare = sync?.compare || {};
        const latestJob = (this.state.backtestJobs || [])[0] || null;
        const latestAppliedVersion = this.state.configVersionStatus?.latest_applied_version || null;
        const maintenanceInspection = this.state.maintenanceInspection || {};
        const maintenanceStability = maintenanceInspection.stability || {};
        const maintenanceAlerts = Array.isArray(maintenanceInspection.alerts) ? maintenanceInspection.alerts : [];
        const syncAt = String(sync.last_sync_at || '').trim();
        const hasQualitySnapshot = Object.prototype.hasOwnProperty.call(quality, 'publish_allowed');
        const compareStatus = String(compare.status || '').trim().toLowerCase();
        const hasCompareSnapshot =
            compareStatus === 'ok' ||
            compareStatus === 'disabled' ||
            compareStatus === 'error' ||
            compareStatus === 'empty';
        const hasBacktestJob = !!String(latestJob?.run_id || '').trim();
        const hasVersionTrace = !!latestAppliedVersion;
        const hasMaintenanceStability = !!maintenanceStability?.has_report;

        const compareWarnCount = Number(compare.warn_count || 0);
        const compareMatchedCount = Number(compare.matched_count || 0);
        const compareStatusText = compareStatus || 'unknown';
        const latestJobStatus = String(latestJob?.status || '').trim().toLowerCase();
        const latestVersionStatus = String(latestAppliedVersion?.status || '').trim().toLowerCase();
        const maintenanceRuns = Number(maintenanceStability?.runs || 0);
        const maintenancePassedCount = Number(maintenanceStability?.passed_count || 0);
        const maintenanceAlertCount = Number(maintenanceStability?.alert_count ?? maintenanceAlerts.length ?? 0);
        const maintenancePassed = !!maintenanceStability?.passed;
        const maintenanceTimestamp = String(maintenanceStability?.timestamp || '').trim();

        const items = [
            {
                id: 'sync',
                label: '同步心跳',
                ok: !!syncAt,
                severity: syncAt
                    ? (sync.source_degraded || sync.fallback_used ? 'warn' : 'ok')
                    : 'pending',
                statusText: syncAt ? `最近同步 ${syncAt}` : '未获取同步时间',
                hintText: sync.source_degraded
                    ? '存在降级标记'
                    : (sync.fallback_used ? '已触发降级兜底' : ''),
            },
            {
                id: 'quality',
                label: '质量门控快照',
                ok: hasQualitySnapshot,
                severity: !hasQualitySnapshot
                    ? 'pending'
                    : (quality.publish_allowed ? 'ok' : 'error'),
                statusText: hasQualitySnapshot
                    ? `发布${quality.publish_allowed ? '允许' : '禁止'} · ${quality.ok_rows || 0}/${quality.total_rows || 0}`
                    : '待生成快照',
                hintText: !hasQualitySnapshot
                    ? ''
                    : (quality.publish_allowed ? '' : `阻断: ${((quality.publish_blocked_reasons || [])[0]?.message || 'unknown')}`),
            },
            {
                id: 'compare',
                label: '双源比对快照',
                ok: hasCompareSnapshot,
                severity: !hasCompareSnapshot
                    ? 'pending'
                    : (compareStatus === 'error'
                        ? 'error'
                        : (compareStatus === 'ok'
                            ? (compareWarnCount > 0 ? 'warn' : 'ok')
                            : 'warn')),
                statusText: hasCompareSnapshot
                    ? `${compareStatusText} · 匹配${compareMatchedCount} 警告${compareWarnCount}`
                    : '待生成快照',
                hintText: compareStatus === 'error'
                    ? String(compare.message || 'compare_error')
                    : '',
            },
            {
                id: 'backtest',
                label: '回测任务可追踪',
                ok: hasBacktestJob,
                severity: !hasBacktestJob
                    ? 'pending'
                    : ((latestJobStatus === 'failed' || latestJobStatus === 'cancelled')
                        ? 'warn'
                        : 'ok'),
                statusText: hasBacktestJob
                    ? `${latestJob.run_id} · ${this.getBacktestStatusText(latestJob.status)}`
                    : '暂无 run_id（可在回测复盘页启动）',
                hintText: !hasBacktestJob
                    ? ''
                    : ((latestJobStatus === 'failed' || latestJobStatus === 'cancelled') ? '最近任务未成功完成' : ''),
            },
            {
                id: 'version',
                label: '配置版本可追踪',
                ok: hasVersionTrace,
                severity: !hasVersionTrace
                    ? 'pending'
                    : (latestVersionStatus === 'refeeded' ? 'ok' : 'warn'),
                statusText: hasVersionTrace
                    ? `V${latestAppliedVersion.id || '--'} · ${latestAppliedVersion.status || 'saved'}`
                    : '暂无已应用版本',
                hintText: !hasVersionTrace
                    ? ''
                    : (latestVersionStatus === 'refeeded' ? '' : '建议回灌评分/回测确认效果'),
            },
            {
                id: 'maintenance_alerts',
                label: '维护巡检告警',
                ok: !hasMaintenanceStability || (maintenancePassed && maintenanceAlertCount <= 0),
                severity: !hasMaintenanceStability
                    ? 'pending'
                    : ((maintenanceAlertCount > 0 || !maintenancePassed) ? 'warn' : 'ok'),
                statusText: hasMaintenanceStability
                    ? `最近巡检 ${maintenancePassedCount}/${maintenanceRuns || '--'} · 告警${maintenanceAlertCount}`
                    : '未获取连续巡检结果',
                hintText: hasMaintenanceStability
                    ? (maintenanceTimestamp ? `时间 ${maintenanceTimestamp}` : '')
                    : '建议执行 maintenance_mode_stability 脚本',
            },
        ];
        const readyCount = items.filter((item) => item.ok).length;
        const severityCount = {
            ok: 0,
            warn: 0,
            error: 0,
            pending: 0,
        };
        items.forEach((item) => {
            const key = ['ok', 'warn', 'error', 'pending'].includes(item.severity) ? item.severity : (item.ok ? 'ok' : 'pending');
            severityCount[key] += 1;
        });
        const firstIssueItem = items.find((item) => item.severity === 'error')
            || items.find((item) => item.severity === 'warn')
            || items.find((item) => item.severity === 'pending')
            || null;
        const healthLevel = severityCount.error > 0
            ? 'error'
            : (severityCount.warn > 0 ? 'warn' : (severityCount.pending > 0 ? 'pending' : 'ok'));
        const summaryText = `信号 ${readyCount}/${items.length} · 异常${severityCount.error} · 告警${severityCount.warn} · 待接入${severityCount.pending}`;
        return {
            items,
            readyCount,
            totalCount: items.length,
            severityCount,
            firstIssueItem,
            healthLevel,
            summaryText,
            sync,
            quality,
            compare,
            latestJob,
            latestAppliedVersion,
            maintenanceInspection,
        };
    },

    selectOpsMonitorSignal(signalId) {
        const nextId = String(signalId || '').trim();
        if (!nextId) return;
        this.state.opsMonitorSelectedSignal = nextId;
        this.renderOpsMonitorPanel();
    },

    buildOpsMonitorDetail(snapshot, signalId) {
        const id = String(signalId || '').trim();
        const sync = snapshot.sync || {};
        const quality = snapshot.quality || {};
        const compare = snapshot.compare || {};
        const latestJob = snapshot.latestJob || null;
        const latestAppliedVersion = snapshot.latestAppliedVersion || null;

        if (id === 'sync') {
            const fallbackReason = String(sync.fallback_reason || '').trim();
            return {
                title: '同步心跳明细',
                level: !sync.last_sync_at ? 'pending' : (sync.source_degraded || sync.fallback_used ? 'warn' : 'ok'),
                lines: [
                    `最近同步: ${sync.last_sync_at || '--'}`,
                    `请求源/实际源: ${sync.requested_source_name || '--'} -> ${sync.source_name || '--'}`,
                    `校验源: ${sync.verify_source_name || '--'}（dual=${sync.dual_compare_enabled ? 'on' : 'off'}）`,
                    `降级标记: ${sync.source_degraded ? 'true' : 'false'}，fallback_used=${sync.fallback_used ? 'true' : 'false'}`,
                    fallbackReason ? `降级原因: ${fallbackReason}` : '降级原因: --',
                ],
            };
        }

        if (id === 'quality') {
            const blockedRules = Array.isArray(quality.publish_blocked_reasons)
                ? quality.publish_blocked_reasons.map((item) => String(item?.message || item?.rule || '')).filter(Boolean)
                : [];
            const failureBuckets = quality.failure_buckets || {};
            return {
                title: '质量门控明细',
                level: !Object.prototype.hasOwnProperty.call(quality, 'publish_allowed')
                    ? 'pending'
                    : (quality.publish_allowed ? 'ok' : 'error'),
                lines: [
                    `发布结果: ${Object.prototype.hasOwnProperty.call(quality, 'publish_allowed') ? (quality.publish_allowed ? '允许' : '禁止') : '--'}`,
                    `通过/总量: ${quality.ok_rows ?? '--'}/${quality.total_rows ?? '--'}（失败 ${quality.failed_rows ?? '--'}）`,
                    `阈值: max_failed_rows=${quality.max_failed_rows ?? '--'}, stale_minutes=${quality.stale_minutes ?? '--'}`,
                    `新鲜度: ${quality.freshness_ok ? '通过' : '失败'} (${quality.freshness_reason || '--'})`,
                    `失败桶: missing=${Number(failureBuckets.missing_rows || 0)}, anomaly=${Number(failureBuckets.anomaly_rows || 0)}, invalid=${Number(failureBuckets.invalid_rows || 0)}, fallback=${Number(failureBuckets.fallback_rows || 0)}`,
                    blockedRules.length > 0 ? `阻断原因: ${blockedRules.join(' | ')}` : '阻断原因: --',
                ],
            };
        }

        if (id === 'compare') {
            const status = String(compare.status || '--');
            const message = String(compare.message || '').trim();
            return {
                title: '双源比对明细',
                level: status === 'error' ? 'error' : (status === 'ok' ? 'ok' : 'warn'),
                lines: [
                    `比对状态: ${status}`,
                    `匹配/警告: ${Number(compare.matched_count || 0)}/${Number(compare.warn_count || 0)}`,
                    `均值偏差: ${Number(compare.mean_abs_diff || 0)}%，最大偏差: ${Number(compare.max_abs_diff || 0)}%`,
                    `最大偏差样本: ${compare.max_diff_name || '--'}`,
                    message ? `提示: ${message}` : '提示: --',
                ],
            };
        }

        if (id === 'backtest') {
            const runId = String(latestJob?.run_id || '').trim();
            const status = String(latestJob?.status || '').trim().toLowerCase();
            return {
                title: '回测任务追踪明细',
                level: !runId ? 'pending' : ((status === 'failed' || status === 'cancelled') ? 'warn' : 'ok'),
                lines: !runId ? [
                    '当前无可追踪 run_id',
                    '建议在“回测复盘”页手动启动一次回测任务以补齐监控信号。',
                ] : [
                    `run_id: ${runId}`,
                    `任务状态: ${this.getBacktestStatusText(status)}`,
                    `任务天数: ${latestJob.days ?? '--'}`,
                    `开始/结束: ${latestJob.started_at || '--'} / ${latestJob.ended_at || '--'}`,
                    latestJob.error_message ? `错误信息: ${latestJob.error_message}` : '错误信息: --',
                ],
            };
        }

        if (id === 'version') {
            const vid = Number(latestAppliedVersion?.id || 0);
            const changedKeys = Array.isArray(latestAppliedVersion?.changed_keys) ? latestAppliedVersion.changed_keys : [];
            const status = String(latestAppliedVersion?.status || '').trim().toLowerCase();
            return {
                title: '配置版本追踪明细',
                level: vid <= 0 ? 'pending' : (status === 'refeeded' ? 'ok' : 'warn'),
                lines: vid <= 0 ? [
                    '当前无已应用配置版本。',
                    '建议先在系统设置页执行“保存并应用”形成可追踪版本。'
                ] : [
                    `版本号: V${vid}`,
                    `版本状态: ${latestAppliedVersion.status || '--'}`,
                    `来源类型/run_id: ${latestAppliedVersion.source_type || '--'} / ${latestAppliedVersion.source_run_id || '--'}`,
                    `应用时间: ${latestAppliedVersion.applied_at || '--'}`,
                    `变更字段: ${changedKeys.length > 0 ? changedKeys.join(', ') : '无'}`,
                ],
            };
        }

        if (id === 'maintenance_alerts') {
            const inspection = snapshot.maintenanceInspection || {};
            const acceptance = inspection.acceptance || {};
            const stability = inspection.stability || {};
            const alerts = Array.isArray(inspection.alerts) ? inspection.alerts : [];
            const hasAcceptance = !!acceptance.has_report;
            const hasStability = !!stability.has_report;
            const runs = Number(stability.runs || 0);
            const passedCount = Number(stability.passed_count || 0);
            const alertCount = Number(stability.alert_count ?? alerts.length ?? 0);
            const passed = !!stability.passed;
            const level = !hasStability ? 'pending' : ((passed && alertCount <= 0) ? 'ok' : 'warn');
            const alertPreview = alerts.slice(-3).map((item) => {
                const ts = String(item?.timestamp || item?.time || '').trim();
                const rule = String(item?.rule || item?.type || item?.level || '').trim();
                const msg = String(item?.message || item?.detail || '').trim();
                return [ts || '--', rule || 'alert', msg || '--'].join(' | ');
            });
            return {
                title: '维护巡检告警明细',
                level,
                lines: [
                    `acceptance_report: ${hasAcceptance ? 'yes' : 'no'} | passed=${hasAcceptance ? (!!acceptance.passed) : '--'} | failed_checks=${Number(acceptance.failed_count || 0)}`,
                    `stability_report: ${hasStability ? 'yes' : 'no'} | passed=${hasStability ? passed : '--'} | runs=${runs} | passed_count=${passedCount} | alert_count=${alertCount}`,
                    `acceptance_path: ${acceptance.report_path || '--'}`,
                    `stability_path: ${stability.report_path || '--'}`,
                    `alert_log: ${stability.alert_log || '--'}`,
                    ...(alertPreview.length > 0
                        ? alertPreview.map((line, idx) => `alert_${idx + 1}: ${line}`)
                        : ['alert_preview: --']),
                ],
            };
        }

        return {
            title: '监控信号明细',
            level: 'pending',
            lines: ['未找到该监控信号'],
        };
    },

    renderOpsMonitorPanel() {
        const panelEl = document.getElementById('ops-monitor-panel');
        const summaryEl = document.getElementById('ops-monitor-summary');
        const itemsEl = document.getElementById('ops-monitor-items');
        const detailEl = document.getElementById('ops-monitor-detail');
        if (!panelEl || !summaryEl || !itemsEl || !detailEl) return;

        const snapshot = this.getOpsObservabilitySnapshot();
        summaryEl.innerText = snapshot.summaryText || `监控信号 ${snapshot.readyCount}/${snapshot.totalCount} 已接入`;
        const selectedExists = snapshot.items.some((item) => item.id === this.state.opsMonitorSelectedSignal);
        if (!selectedExists) {
            const firstPending = snapshot.items.find((item) => !item.ok);
            this.state.opsMonitorSelectedSignal = (firstPending || snapshot.items[0] || {}).id || '';
        }

        itemsEl.innerHTML = snapshot.items.map((item) => {
            const statusClass = item.severity || (item.ok ? 'ok' : 'pending');
            const activeClass = item.id === this.state.opsMonitorSelectedSignal ? ' active' : '';
            const statusLabel = statusClass === 'error'
                ? '异常'
                : (statusClass === 'warn'
                    ? '告警'
                    : (item.ok ? '已接入' : '待接入'));
            const hintText = item.hintText ? `<span class="ops-monitor-item-hint">${this.escapeHTML(item.hintText)}</span>` : '';
            return (
                `<div class="ops-monitor-item ${statusClass}${activeClass}" onclick="App.selectOpsMonitorSignal('${item.id}')">` +
                `<span class="ops-monitor-item-label">${this.escapeHTML(item.label)}</span>` +
                `<span class="ops-monitor-item-value">${this.escapeHTML(item.statusText)}${hintText}</span>` +
                `<span class="ops-monitor-item-status">${statusLabel}</span>` +
                `</div>`
            );
        }).join('');

        const detail = this.buildOpsMonitorDetail(snapshot, this.state.opsMonitorSelectedSignal);
        const detailLevel = detail.level || 'pending';
        detailEl.className = `ops-monitor-detail ${detailLevel}`;
        detailEl.innerHTML = [
            `<div class="ops-monitor-detail-title">${this.escapeHTML(detail.title || '监控明细')}</div>`,
            `<div class="ops-monitor-detail-lines">`,
            ...(detail.lines || []).map((line) => `<div class="ops-monitor-detail-line">${this.escapeHTML(line)}</div>`),
            `</div>`,
        ].join('');
    },

    getReleaseReadinessSnapshot() {
        const ops = this.getOpsObservabilitySnapshot();
        const quality = this.state.lastQualityLatestSnapshot || this.state.lastQualityStatus || {};
        const latestJob = (this.state.backtestJobs || [])[0] || null;
        const latestVersion = this.state.configVersionStatus?.latest_applied_version || null;
        const hasQuality = Object.prototype.hasOwnProperty.call(quality, 'publish_allowed');
        const qualityPassed = hasQuality && !!quality.publish_allowed;
        const backtestStatus = String(latestJob?.status || '').trim().toLowerCase();
        const backtestPassed = !!String(latestJob?.run_id || '').trim() && backtestStatus === 'completed';
        const versionPassed = !!latestVersion && String(latestVersion?.status || '').trim().toLowerCase() === 'refeeded';
        const opsErrors = Number(ops?.severityCount?.error || 0);
        const opsWarns = Number(ops?.severityCount?.warn || 0);
        const opsPassed = opsErrors <= 0;

        const checks = [
            {
                id: 'ops_health',
                label: '监控健康基线',
                passed: opsPassed,
                detail: `异常${opsErrors} · 告警${opsWarns}`,
            },
            {
                id: 'quality_gate',
                label: '质量门控可发布',
                passed: qualityPassed,
                detail: hasQuality ? `publish_allowed=${quality.publish_allowed ? 'true' : 'false'}` : '待生成快照',
            },
            {
                id: 'backtest_latest',
                label: '最近回测任务完成',
                passed: backtestPassed,
                detail: latestJob
                    ? `${latestJob.run_id || '--'} · ${this.getBacktestStatusText(backtestStatus || latestJob.status)}`
                    : '暂无回测任务',
            },
            {
                id: 'version_refeeded',
                label: '最新配置版本已回灌',
                passed: versionPassed,
                detail: latestVersion
                    ? `V${latestVersion.id || '--'} · ${latestVersion.status || '--'}`
                    : '暂无已应用版本',
            },
        ];
        const passedCount = checks.filter((item) => item.passed).length;
        const allReady = passedCount === checks.length;
        return {
            checks,
            passedCount,
            totalCount: checks.length,
            allReady,
            summaryText: allReady
                ? `已就绪 ${passedCount}/${checks.length}`
                : `未就绪 ${passedCount}/${checks.length}`,
        };
    },

    renderReleaseReadinessPanel() {
        const panelEl = document.getElementById('release-check-panel');
        const summaryEl = document.getElementById('release-check-summary');
        const itemsEl = document.getElementById('release-check-items');
        if (!panelEl || !summaryEl || !itemsEl) return;

        const snapshot = this.getReleaseReadinessSnapshot();
        panelEl.className = `release-check-panel ${snapshot.allReady ? 'ready' : 'pending'}`;
        summaryEl.innerText = snapshot.summaryText;
        itemsEl.innerHTML = snapshot.checks.map((item, index) => (
            `<div class="release-check-item ${item.passed ? 'passed' : 'failed'}">` +
            `<span class="release-check-index">${index + 1}</span>` +
            `<span class="release-check-label">${this.escapeHTML(item.label)}</span>` +
            `<span class="release-check-detail">${this.escapeHTML(item.detail)}</span>` +
            `<span class="release-check-status">${item.passed ? '通过' : '待补齐'}</span>` +
            `</div>`
        )).join('');
    },

    getReleaseRunbookSnapshot() {
        const readiness = this.getReleaseReadinessSnapshot();
        const checkMap = new Map((readiness.checks || []).map((item) => [item.id, item]));
        const rankingCount = Array.isArray(this.state.rankingData) ? this.state.rankingData.length : 0;
        const qualityCheck = checkMap.get('quality_gate');
        const backtestCheck = checkMap.get('backtest_latest');
        const versionCheck = checkMap.get('version_refeeded');
        const scorePassed = rankingCount > 0;

        const steps = [
            {
                id: 'refresh_quality',
                label: '步骤1：刷新数据并确认质量门控可发布',
                passed: !!qualityCheck?.passed,
                detail: qualityCheck?.detail || '待生成快照',
                action: 'refresh',
                actionLabel: '执行刷新',
            },
            {
                id: 'scoring_publish',
                label: '步骤2：执行计算评分并确认排行可见',
                passed: scorePassed,
                detail: scorePassed ? `当前排行 ${rankingCount} 条` : '当前排行为空',
                action: 'calculate',
                actionLabel: '执行评分',
            },
            {
                id: 'backtest_confirm',
                label: '步骤3：回测复盘确认最近任务 completed',
                passed: !!backtestCheck?.passed,
                detail: backtestCheck?.detail || '暂无回测任务',
                action: 'goto_backtest',
                actionLabel: '去回测复盘',
            },
            {
                id: 'version_confirm',
                label: '步骤4：配置版本确认 refeeded 可追溯',
                passed: !!versionCheck?.passed,
                detail: versionCheck?.detail || '暂无已应用版本',
                action: 'goto_settings',
                actionLabel: '去系统设置',
            },
        ];
        const passedCount = steps.filter((item) => item.passed).length;
        const allReady = passedCount === steps.length;
        return {
            steps,
            passedCount,
            totalCount: steps.length,
            allReady,
            summaryText: allReady
                ? `手册就绪 ${passedCount}/${steps.length}（可执行发布）`
                : `手册未就绪 ${passedCount}/${steps.length}（禁止发布）`,
        };
    },

    renderReleaseRunbookPanel() {
        const panelEl = document.getElementById('release-runbook-panel');
        const summaryEl = document.getElementById('release-runbook-summary');
        const stepsEl = document.getElementById('release-runbook-steps');
        const rollbackEl = document.getElementById('release-runbook-rollback');
        if (!panelEl || !summaryEl || !stepsEl || !rollbackEl) return;

        const lockId = this.state.pipelineStageLock || 'maintenance_mode';
        if (!['release_hardening', 'post_release_observe', 'closure_archive', 'maintenance_mode'].includes(lockId)) {
            panelEl.style.display = 'none';
            return;
        }

        panelEl.style.display = '';
        const snapshot = this.getReleaseRunbookSnapshot();
        const baseUrl = `${window.location.origin}`;
        panelEl.className = `release-runbook-panel ${snapshot.allReady ? 'ready' : 'pending'}`;
        summaryEl.innerText = lockId === 'post_release_observe'
            ? (snapshot.allReady
                ? `基线保持 ${snapshot.passedCount}/${snapshot.totalCount}（发布后观察）`
                : `基线回落 ${snapshot.passedCount}/${snapshot.totalCount}（需处置）`)
            : (lockId === 'closure_archive'
                ? `收官基线 ${snapshot.passedCount}/${snapshot.totalCount}（交接维护）`
                : (lockId === 'maintenance_mode'
                    ? `维护基线 ${snapshot.passedCount}/${snapshot.totalCount}（巡检模式）`
                    : snapshot.summaryText));
        stepsEl.innerHTML = snapshot.steps.map((item, index) => {
            const btnLabel = item.passed ? `复核：${item.actionLabel}` : item.actionLabel;
            return (
                `<div class="release-runbook-step ${item.passed ? 'passed' : 'failed'}">` +
                `<span class="release-runbook-index">${index + 1}</span>` +
                `<div class="release-runbook-main">` +
                `<span class="release-runbook-label">${this.escapeHTML(item.label)}</span>` +
                `<span class="release-runbook-detail">${this.escapeHTML(item.detail)}</span>` +
                `</div>` +
                `<div class="release-runbook-actions">` +
                `<span class="release-runbook-status">${item.passed ? '通过' : '待补齐'}</span>` +
                `<button class="release-runbook-action-btn" onclick="App.handleReleaseRunbookAction('${item.action}')">${this.escapeHTML(btnLabel)}</button>` +
                `</div>` +
                `</div>`
            );
        }).join('');

        const rollbackTitle = snapshot.allReady
            ? '回滚口径（发布后异常时执行）'
            : '回滚口径（未就绪时禁止发布）';
        const rollbackLines = snapshot.allReady
            ? [
                '1. 发现异常后立即在“系统设置”切回上一个稳定配置版本。',
                '2. 在“回测复盘”页定位最近 run_id，核对异常日期与指标漂移。',
                '3. 记录异常窗口与回滚版本，保留验收报告再恢复发布。',
            ]
            : [
                '1. 未达到 4/4 前禁止进入发布动作。',
                '2. 优先补齐“待补齐”项，再执行验收脚本复核。',
                `3. 验收命令：powershell -ExecutionPolicy Bypass -File scripts/run_release_stage_acceptance.ps1 -BaseUrl ${baseUrl}`,
            ];
        rollbackEl.innerHTML = [
            `<div class="release-runbook-rollback-title">${this.escapeHTML(rollbackTitle)}</div>`,
            ...rollbackLines.map((line) => `<div class="release-runbook-rollback-line">${this.escapeHTML(line)}</div>`),
            `<div class="release-runbook-rollback-actions">`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleReleaseRunbookAction('goto_settings')">去系统设置处理版本</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleReleaseRunbookAction('goto_backtest')">去回测复盘定位 run_id</button>`,
            `</div>`,
        ].join('');
    },

    async handleReleaseRunbookAction(action) {
        const key = String(action || '').trim();
        if (!key) return;
        if (key === 'refresh') {
            await this.handleRefresh();
            return;
        }
        if (key === 'calculate') {
            await this.handleCalculate();
            return;
        }
        if (key === 'goto_backtest') {
            await this.switchPage('backtest');
            return;
        }
        if (key === 'goto_settings') {
            await this.switchPage('settings');
            return;
        }
        if (key === 'goto_ranking') {
            await this.switchPage('ranking');
        }
    },

    getPostReleaseObserveSnapshot() {
        const release = this.getReleaseReadinessSnapshot();
        const ops = this.getOpsObservabilitySnapshot();
        const quality = this.state.lastQualityLatestSnapshot || this.state.lastQualityStatus || {};
        const latestVersion = this.state.configVersionStatus?.latest_applied_version || null;
        const sync = this.state.lastSyncStatus || {};
        const hasQualitySnapshot = Object.prototype.hasOwnProperty.call(quality, 'publish_allowed');
        const qualityPassed = hasQualitySnapshot && !!quality.publish_allowed;
        const versionPassed = !!latestVersion && String(latestVersion?.status || '').trim().toLowerCase() === 'refeeded';
        const syncAt = String(sync.last_sync_at || '').trim();
        const syncPassed = !!syncAt;
        const opsErrors = Number(ops?.severityCount?.error || 0);
        const opsWarns = Number(ops?.severityCount?.warn || 0);
        const opsPassed = opsErrors <= 0;

        const checks = [
            {
                id: 'release_baseline',
                label: '发布前检查基线保持',
                passed: !!release.allReady,
                detail: `发布检查 ${release.passedCount}/${release.totalCount}`,
            },
            {
                id: 'sync_heartbeat',
                label: '同步心跳持续可用',
                passed: syncPassed,
                detail: syncPassed ? `最近同步 ${syncAt}` : '未获取同步时间',
            },
            {
                id: 'quality_publishable',
                label: '质量门控维持可发布',
                passed: qualityPassed,
                detail: hasQualitySnapshot
                    ? `publish_allowed=${quality.publish_allowed ? 'true' : 'false'}`
                    : '待生成质量快照',
            },
            {
                id: 'version_traceable',
                label: '配置版本可追溯可回滚',
                passed: versionPassed,
                detail: latestVersion
                    ? `V${latestVersion.id || '--'} · ${latestVersion.status || '--'}`
                    : '暂无已应用版本',
            },
            {
                id: 'ops_clean',
                label: '监控异常清零（允许告警）',
                passed: opsPassed,
                detail: `异常${opsErrors} · 告警${opsWarns}`,
            },
        ];
        const passedCount = checks.filter((item) => item.passed).length;
        const allHealthy = passedCount === checks.length;
        return {
            checks,
            passedCount,
            totalCount: checks.length,
            allHealthy,
            errorCount: opsErrors,
            warnCount: opsWarns,
            summaryText: allHealthy
                ? `收官观察通过 ${passedCount}/${checks.length}`
                : `收官观察进行中 ${passedCount}/${checks.length}`,
        };
    },

    renderPostReleaseObservePanel() {
        const panelEl = document.getElementById('post-release-observe-panel');
        const summaryEl = document.getElementById('post-release-observe-summary');
        const itemsEl = document.getElementById('post-release-observe-items');
        const actionsEl = document.getElementById('post-release-observe-actions');
        const archiveEl = document.getElementById('post-release-observe-archive');
        if (!panelEl || !summaryEl || !itemsEl || !actionsEl || !archiveEl) return;

        const lockId = this.state.pipelineStageLock || 'maintenance_mode';
        if (!['post_release_observe', 'closure_archive', 'maintenance_mode'].includes(lockId)) {
            panelEl.style.display = 'none';
            return;
        }
        panelEl.style.display = '';

        const snapshot = this.getPostReleaseObserveSnapshot();
        const baseUrl = `${window.location.origin}`;
        panelEl.className = `post-release-observe-panel ${snapshot.allHealthy ? 'ready' : 'pending'}`;
        summaryEl.innerText = lockId === 'post_release_observe'
            ? snapshot.summaryText
            : `已完成：${snapshot.summaryText}（已切阶段）`;
        itemsEl.innerHTML = snapshot.checks.map((item, index) => (
            `<div class="post-release-observe-item ${item.passed ? 'passed' : 'failed'}">` +
            `<span class="post-release-observe-index">${index + 1}</span>` +
            `<span class="post-release-observe-label">${this.escapeHTML(item.label)}</span>` +
            `<span class="post-release-observe-detail">${this.escapeHTML(item.detail)}</span>` +
            `<span class="post-release-observe-status">${item.passed ? '通过' : '待处置'}</span>` +
            `</div>`
        )).join('');
        actionsEl.innerHTML = [
            `<button class="release-runbook-action-btn secondary" onclick="App.handlePostReleaseObserveAction('refresh')">执行刷新</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handlePostReleaseObserveAction('calculate')">执行评分</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handlePostReleaseObserveAction('goto_backtest')">去回测复盘</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handlePostReleaseObserveAction('goto_settings')">去系统设置</button>`,
            `<span class="post-release-observe-command">建议复核：powershell -ExecutionPolicy Bypass -File scripts/run_release_stage_acceptance.ps1 -BaseUrl ${this.escapeHTML(baseUrl)}</span>`,
        ].join('');
        const archiveStatusText = snapshot.allHealthy ? '可归档' : '待归档';
        const archiveStatusClass = snapshot.allHealthy ? 'ready' : 'pending';
        const archiveLines = snapshot.allHealthy
            ? [
                '归档建议1：reports/release_stage_acceptance_*.json（发布基线）',
                '归档建议2：reports/post_release_observe_acceptance_*.json（观察验收）',
                '归档建议3：reports/post_release_stage_step1_desktop_*.png（Web证据）',
            ]
            : [
                '当前仍有待处置项，暂不建议归档。',
                '请先补齐面板中“待处置”项后再执行归档。',
            ];
        archiveEl.className = `post-release-observe-archive ${archiveStatusClass}`;
        archiveEl.innerHTML = [
            `<div class="post-release-observe-archive-title">收官归档清单：${archiveStatusText}</div>`,
            ...archiveLines.map((line) => `<div class="post-release-observe-archive-line">${this.escapeHTML(line)}</div>`),
            `<div class="post-release-observe-archive-line">归档口径文档：docs/收官归档口径-发布后运行观察与收官验收.md</div>`,
        ].join('');
    },

    async handlePostReleaseObserveAction(action) {
        await this.handleReleaseRunbookAction(action);
    },

    getClosureArchiveSnapshot() {
        const release = this.getReleaseReadinessSnapshot();
        const postRelease = this.getPostReleaseObserveSnapshot();
        const sync = this.state.lastSyncStatus || {};
        const latestSyncDate = String(sync.last_sync_date || '').trim();
        const latestSyncAt = String(sync.last_sync_at || '').trim();
        const latestVersion = this.state.configVersionStatus?.latest_applied_version || null;
        const versionReady = !!latestVersion && String(latestVersion?.status || '').trim().toLowerCase() === 'refeeded';

        const checks = [
            {
                id: 'release_baseline',
                label: '发布基线验收可复核',
                passed: !!release.allReady,
                detail: `发布检查 ${release.passedCount}/${release.totalCount}`,
            },
            {
                id: 'post_release_baseline',
                label: '发布后观察基线可复核',
                passed: !!postRelease.allHealthy,
                detail: `观察检查 ${postRelease.passedCount}/${postRelease.totalCount}`,
            },
            {
                id: 'sync_trace',
                label: '最近同步时间可追溯',
                passed: !!latestSyncAt,
                detail: latestSyncAt ? `${latestSyncDate || '--'} ${latestSyncAt}` : '缺少同步时间',
            },
            {
                id: 'version_trace',
                label: '配置版本已回灌可追溯',
                passed: versionReady,
                detail: latestVersion
                    ? `V${latestVersion.id || '--'} · ${latestVersion.status || '--'}`
                    : '暂无已应用版本',
            },
        ];

        const passedCount = checks.filter((item) => item.passed).length;
        const totalCount = checks.length;
        const allReady = passedCount === totalCount;
        return {
            checks,
            passedCount,
            totalCount,
            allReady,
            summaryText: allReady
                ? `收官归档就绪 ${passedCount}/${totalCount}`
                : `收官归档准备中 ${passedCount}/${totalCount}`,
        };
    },

    renderClosureArchivePanel() {
        const panelEl = document.getElementById('closure-archive-panel');
        const summaryEl = document.getElementById('closure-archive-summary');
        const itemsEl = document.getElementById('closure-archive-items');
        const actionsEl = document.getElementById('closure-archive-actions');
        if (!panelEl || !summaryEl || !itemsEl || !actionsEl) return;

        const lockId = this.state.pipelineStageLock || 'maintenance_mode';
        if (!['closure_archive', 'maintenance_mode'].includes(lockId)) {
            panelEl.style.display = 'none';
            return;
        }

        const snapshot = this.getClosureArchiveSnapshot();
        panelEl.style.display = '';
        panelEl.className = `closure-archive-panel ${snapshot.allReady ? 'ready' : 'pending'}`;
        summaryEl.innerText = lockId === 'maintenance_mode'
            ? `已完成：${snapshot.summaryText}（维护复核）`
            : snapshot.summaryText;
        itemsEl.innerHTML = snapshot.checks.map((item, index) => (
            `<div class="closure-archive-item ${item.passed ? 'passed' : 'failed'}">` +
            `<span class="closure-archive-index">${index + 1}</span>` +
            `<span class="closure-archive-label">${this.escapeHTML(item.label)}</span>` +
            `<span class="closure-archive-detail">${this.escapeHTML(item.detail)}</span>` +
            `<span class="closure-archive-status">${item.passed ? '已归档' : '待归档'}</span>` +
            `</div>`
        )).join('');
        actionsEl.innerHTML = [
            `<button class="release-runbook-action-btn secondary" onclick="App.handleClosureArchiveAction('refresh')">执行刷新</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleClosureArchiveAction('calculate')">执行评分</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleClosureArchiveAction('goto_backtest')">去回测复盘</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleClosureArchiveAction('goto_settings')">去系统设置</button>`,
            `<span class="post-release-observe-command">维护口径：保持“刷新 -> 评分 -> 回测复核 -> 归档”日常巡检节奏。</span>`,
        ].join('');
    },

    async handleClosureArchiveAction(action) {
        await this.handleReleaseRunbookAction(action);
    },

    getMaintenanceModeSnapshot() {
        const sync = this.state.lastSyncStatus || {};
        const quality = this.state.lastQualityLatestSnapshot || this.state.lastQualityStatus || {};
        const release = this.getReleaseReadinessSnapshot();
        const postRelease = this.getPostReleaseObserveSnapshot();
        const closure = this.getClosureArchiveSnapshot();
        const latestJob = (this.state.backtestJobs || [])[0] || null;
        const inspection = this.state.maintenanceInspection || {};
        const acceptance = inspection.acceptance || {};
        const stability = inspection.stability || {};

        const syncAt = String(sync.last_sync_at || '').trim();
        const hasQuality = Object.prototype.hasOwnProperty.call(quality, 'publish_allowed');
        const qualityPassed = hasQuality && !!quality.publish_allowed;
        const latestRunId = String(latestJob?.run_id || '').trim();
        const latestRunStatus = String(latestJob?.status || '').trim().toLowerCase();
        const backtestPassed = !!latestRunId && latestRunStatus === 'completed';
        const hasStability = !!stability.has_report;
        const acceptancePassed = !acceptance.has_report || !!acceptance.passed;
        const inspectionAlertCount = Number(stability.alert_count ?? 0);
        const inspectionPassed = hasStability && !!stability.passed && inspectionAlertCount <= 0 && acceptancePassed;

        const checks = [
            {
                id: 'sync_heartbeat',
                label: '同步心跳正常',
                passed: !!syncAt,
                detail: syncAt ? `最近同步 ${syncAt}` : '未获取同步时间',
            },
            {
                id: 'quality_publishable',
                label: '质量门控可发布',
                passed: qualityPassed,
                detail: hasQuality
                    ? `publish_allowed=${quality.publish_allowed ? 'true' : 'false'}`
                    : '待生成质量快照',
            },
            {
                id: 'inspection_report',
                label: '维护巡检报告可见且无告警',
                passed: inspectionPassed,
                detail: hasStability
                    ? `stability ${Number(stability.passed_count || 0)}/${Number(stability.runs || 0)} | alerts=${inspectionAlertCount} | acceptance=${acceptancePassed ? 'ok' : 'failed'}`
                    : '未发现 maintenance_mode_stability 报告',
            },
            {
                id: 'baseline_integrity',
                label: '发布与收官基线完整',
                passed: !!release.allReady && !!postRelease.allHealthy && !!closure.allReady,
                detail: `发布 ${release.passedCount}/${release.totalCount} · 观察 ${postRelease.passedCount}/${postRelease.totalCount} · 收官 ${closure.passedCount}/${closure.totalCount}`,
            },
            {
                id: 'backtest_replay',
                label: '最近回测任务可复核',
                passed: backtestPassed,
                detail: latestRunId
                    ? `${latestRunId} · ${this.getBacktestStatusText(latestRunStatus)}`
                    : '暂无回测任务',
            },
        ];

        const passedCount = checks.filter((item) => item.passed).length;
        const totalCount = checks.length;
        const allHealthy = passedCount === totalCount;
        return {
            checks,
            passedCount,
            totalCount,
            allHealthy,
            summaryText: allHealthy
                ? `维护巡检通过 ${passedCount}/${totalCount}`
                : `维护巡检进行中 ${passedCount}/${totalCount}`,
        };
    },

    renderMaintenanceModePanel() {
        const panelEl = document.getElementById('maintenance-mode-panel');
        const summaryEl = document.getElementById('maintenance-mode-summary');
        const itemsEl = document.getElementById('maintenance-mode-items');
        const actionsEl = document.getElementById('maintenance-mode-actions');
        if (!panelEl || !summaryEl || !itemsEl || !actionsEl) return;

        const lockId = this.state.pipelineStageLock || 'maintenance_mode';
        if (lockId !== 'maintenance_mode') {
            panelEl.style.display = 'none';
            return;
        }

        const snapshot = this.getMaintenanceModeSnapshot();
        const inspection = this.state.maintenanceInspection || {};
        const acceptance = inspection.acceptance || {};
        const stability = inspection.stability || {};
        const alerts = Array.isArray(inspection.alerts) ? inspection.alerts : [];
        const hasStability = !!stability.has_report;
        const hasAcceptance = !!acceptance.has_report;
        const alertCount = Number(stability.alert_count ?? alerts.length ?? 0);
        const inspectionSummary = hasStability
            ? `巡检 ${Number(stability.passed_count || 0)}/${Number(stability.runs || 0)} | alerts=${alertCount} | acceptance=${hasAcceptance ? (acceptance.passed ? 'ok' : 'failed') : '--'}`
            : '巡检状态：未发现稳定性巡检报告';
        const alertPreview = alerts
            .slice(-2)
            .map((item) => {
                const ts = String(item?.timestamp || item?.time || '').trim();
                const msg = String(item?.message || item?.detail || item?.rule || '').trim();
                return `${ts || '--'} | ${msg || '--'}`;
            })
            .join(' || ');
        panelEl.style.display = '';
        panelEl.className = `maintenance-mode-panel ${snapshot.allHealthy ? 'ready' : 'pending'}`;
        summaryEl.innerText = snapshot.summaryText;
        const baseUrl = `${window.location.origin}`;
        itemsEl.innerHTML = snapshot.checks.map((item, index) => (
            `<div class="maintenance-mode-item ${item.passed ? 'passed' : 'failed'}">` +
            `<span class="maintenance-mode-index">${index + 1}</span>` +
            `<span class="maintenance-mode-label">${this.escapeHTML(item.label)}</span>` +
            `<span class="maintenance-mode-detail">${this.escapeHTML(item.detail)}</span>` +
            `<span class="maintenance-mode-status">${item.passed ? '通过' : '待巡检'}</span>` +
            `</div>`
        )).join('');
        actionsEl.innerHTML = [
            `<button class="release-runbook-action-btn secondary" onclick="App.handleMaintenanceModeAction('reload_inspection')">刷新巡检状态</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleMaintenanceModeAction('refresh')">执行刷新</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleMaintenanceModeAction('calculate')">执行评分</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleMaintenanceModeAction('goto_backtest')">去回测复盘</button>`,
            `<button class="release-runbook-action-btn secondary" onclick="App.handleMaintenanceModeAction('goto_settings')">去系统设置</button>`,
            `<span class="post-release-observe-command">${this.escapeHTML(inspectionSummary)}</span>`,
            (alertPreview ? `<span class="post-release-observe-command">${this.escapeHTML(`latest_alerts: ${alertPreview}`)}</span>` : ''),
            `<span class="post-release-observe-command">巡检命令：powershell -ExecutionPolicy Bypass -File scripts/run_maintenance_mode_acceptance.ps1 -BaseUrl ${this.escapeHTML(baseUrl)}</span>`,
            `<span class="post-release-observe-command">stability命令：powershell -ExecutionPolicy Bypass -File scripts/run_maintenance_mode_stability.ps1 -BaseUrl ${this.escapeHTML(baseUrl)} -Runs 3 -IntervalSec 2</span>`,
        ].join('');
    },

    async handleMaintenanceModeAction(action) {
        const key = String(action || '').trim();
        if (!key) return;
        if (key === 'reload_inspection') {
            await this.loadMaintenanceInspectionStatus(false);
            return;
        }
        await this.handleReleaseRunbookAction(key);
    },

    getPipelineRuntimeInfo(stepId) {
        const sync = this.state.lastSyncStatus || {};
        const quality = this.state.lastQualityStatus || {};
        const rankingCount = Array.isArray(this.state.rankingData) ? this.state.rankingData.length : 0;
        const syncAt = String(sync.last_sync_at || '').trim();
        const totalRows = Number(sync.last_total_rows || 0);
        const okRows = Number(sync.last_quality_ok_rows || 0);
        const failedRows = Number(sync.last_quality_failed_rows || 0);

        if (stepId === 'api_fetch') {
            if (syncAt) return { ready: true, text: `最近同步：${syncAt}` };
            return { ready: false, text: '最近同步：未检测（请先点“刷新数据”）' };
        }

        if (stepId === 'quality_gate') {
            if (quality && Object.prototype.hasOwnProperty.call(quality, 'publish_allowed')) {
                const gateText = quality.publish_allowed ? '允许发布' : '禁止发布';
                return {
                    ready: true,
                    text: `门控结果：${gateText}（通过 ${quality.ok_rows || 0}/${quality.total_rows || 0}）`,
                };
            }
            if (totalRows > 0) {
                return { ready: true, text: `门控快照加载中（最近入库 ${okRows}/${totalRows}）` };
            }
            return { ready: false, text: '门控结果：未生成快照（请先点“刷新数据”）' };
        }

        if (stepId === 'ingest_align') {
            if (totalRows > 0) {
                return { ready: true, text: `入库统计：通过 ${okRows}/${totalRows}，失败 ${failedRows}` };
            }
            return { ready: false, text: '入库统计：暂无入库数据' };
        }

        if (stepId === 'publish_prod') {
            if (rankingCount > 0) return { ready: true, text: `生产排行榜：已生成 ${rankingCount} 条` };
            if (totalRows > 0) {
                return { ready: true, text: '生产排行榜：可更新（点击“执行计算评分”触发最新发布）' };
            }
            return { ready: false, text: '生产排行榜：未生成（请先刷新数据）' };
        }

        if (stepId === 'backtest_orchestration') {
            const lockId = this.state.pipelineStageLock || 'maintenance_mode';
            const lockBeyondBacktest = ['ai_enhancement', 'ui_polish', 'ops_observability', 'release_hardening', 'post_release_observe', 'closure_archive', 'maintenance_mode'].includes(lockId);
            const selectedRunId = String(this.state.backtestSelectedRunId || this.state.lastBacktestRunId || '').trim();
            const selectedJob = (this.state.backtestJobs || []).find(
                (item) => String(item?.run_id || '').trim() === selectedRunId
            );
            const latestJob = selectedJob || this.state.backtestJobs[0] || null;
            if (latestJob) {
                const runId = String(latestJob.run_id || '').trim() || selectedRunId || '--';
                const statusText = this.getBacktestStatusText(latestJob.status);
                const status = String(latestJob.status || '').trim().toLowerCase();
                const ready = lockBeyondBacktest ? true : (status === 'completed');
                return {
                    ready,
                    text: `回测任务：${runId} · ${statusText}`,
                };
            }
            if (this.state.lastBacktestRunId) {
                return {
                    ready: lockBeyondBacktest,
                    text: `回测任务已触发：${this.state.lastBacktestRunId}`,
                };
            }
            if (lockBeyondBacktest) {
                return { ready: true, text: '已完成：阶段验收已通过（当前无活跃回测任务）' };
            }
            return { ready: false, text: '回测任务：暂无（请先在“回测复盘”页启动）' };
        }

        if (stepId === 'ai_enhancement') {
            const lockId = this.state.pipelineStageLock || 'maintenance_mode';
            const versionStatus = this.state.configVersionStatus || null;
            const latestAppliedVersion = versionStatus?.latest_applied_version || null;

            if (lockId === 'ai_enhancement') {
                if (latestAppliedVersion) {
                    const vid = String(latestAppliedVersion?.id || '--');
                    const runId = String(latestAppliedVersion?.source_run_id || '').trim();
                    const runHint = runId ? `（run_id=${runId}）` : '';
                    const versionStatusText = String(latestAppliedVersion?.status || '').trim().toLowerCase();
                    if (versionStatusText === 'refeeded') {
                        return { ready: true, text: `已达切阶段门槛：配置版本 V${vid} 已回灌评分${runHint}` };
                    }
                    return { ready: false, text: `进行中：配置版本 V${vid} 已应用${runHint} -> 待回灌评分/回测` };
                }
                const latestSuggestion = this.state.lastOptimizationSuggestion
                    || ((this.state.optimizationSuggestions || [])[0] || null);
                if (latestSuggestion) {
                    const runId = String(latestSuggestion?.run_id || '--').trim() || '--';
                    return { ready: false, text: `进行中：已生成参数建议（run_id=${runId}）-> 待配置版本化` };
                }
                return { ready: false, text: '进行中：参数优化建议 -> 配置版本化（仅做功能链路，不做UI美化）' };
            }

            if (lockId === 'ui_polish' || lockId === 'ops_observability' || lockId === 'release_hardening' || lockId === 'post_release_observe' || lockId === 'closure_archive' || lockId === 'maintenance_mode') {
                if (latestAppliedVersion) {
                    const vid = String(latestAppliedVersion?.id || '--');
                    const runId = String(latestAppliedVersion?.source_run_id || '').trim();
                    const runHint = runId ? `（run_id=${runId}）` : '';
                    const versionStatusText = String(latestAppliedVersion?.status || '').trim().toLowerCase();
                    if (versionStatusText === 'refeeded') {
                        return { ready: true, text: `已完成：配置版本 V${vid} 已回灌评分${runHint}` };
                    }
                    return { ready: true, text: `已完成：阶段锁已推进（版本 V${vid} 已应用${runHint}）` };
                }
                return { ready: true, text: '已完成：阶段锁已推进到后续阶段' };
            }

            return { ready: false, text: '按阶段锁，暂未进入' };
        }

        if (stepId === 'ui_polish') {
            const lockId = this.state.pipelineStageLock || 'maintenance_mode';
            if (lockId === 'ui_polish') {
                return { ready: false, text: '进行中：搜索/分类/可读性与交互细节优化' };
            }
            if (lockId === 'ops_observability' || lockId === 'release_hardening' || lockId === 'post_release_observe' || lockId === 'closure_archive' || lockId === 'maintenance_mode') {
                return { ready: true, text: '已完成：搜索/分类/可读性优化已验收' };
            }
            return { ready: false, text: '按阶段锁，暂未进入' };
        }

        if (stepId === 'ops_observability') {
            const lockId = this.state.pipelineStageLock || 'maintenance_mode';
            const snapshot = this.getOpsObservabilitySnapshot();
            if (lockId === 'ops_observability') {
                const sc = snapshot.severityCount || {};
                const errorCount = Number(sc.error || 0);
                const warnCount = Number(sc.warn || 0);
                const pendingCount = Number(sc.pending || 0);
                const healthySuffix = (errorCount <= 0 && warnCount <= 0 && pendingCount <= 0)
                    ? ' · 当前无异常'
                    : ` · 异常${errorCount} 告警${warnCount} 待接入${pendingCount}`;
                return {
                    ready: false,
                    text: `进行中：监控信号 ${snapshot.readyCount}/${snapshot.totalCount} 已固化${healthySuffix}`,
                };
            }
            if (lockId === 'release_hardening' || lockId === 'post_release_observe' || lockId === 'closure_archive' || lockId === 'maintenance_mode') {
                return {
                    ready: true,
                    text: `已完成：监控阶段验收通过（信号 ${snapshot.readyCount}/${snapshot.totalCount}）`,
                };
            }
            return { ready: false, text: '按阶段锁，暂未进入' };
        }

        if (stepId === 'release_hardening') {
            const lockId = this.state.pipelineStageLock || 'maintenance_mode';
            const snapshot = this.getReleaseReadinessSnapshot();
            if (lockId === 'release_hardening') {
                return {
                    ready: false,
                    text: `进行中：发布前检查 ${snapshot.passedCount}/${snapshot.totalCount}`,
                };
            }
            if (lockId === 'post_release_observe' || lockId === 'closure_archive' || lockId === 'maintenance_mode') {
                return {
                    ready: true,
                    text: `已完成：发布前检查 ${snapshot.passedCount}/${snapshot.totalCount}（已切阶段）`,
                };
            }
            return { ready: false, text: '按阶段锁，暂未进入' };
        }

        if (stepId === 'post_release_observe') {
            const lockId = this.state.pipelineStageLock || 'maintenance_mode';
            const snapshot = this.getPostReleaseObserveSnapshot();
            if (lockId === 'post_release_observe') {
                return {
                    ready: false,
                    text: `进行中：运行观察 ${snapshot.passedCount}/${snapshot.totalCount} · 异常${snapshot.errorCount} 告警${snapshot.warnCount}`,
                };
            }
            if (lockId === 'closure_archive' || lockId === 'maintenance_mode') {
                return {
                    ready: true,
                    text: `已完成：运行观察 ${snapshot.passedCount}/${snapshot.totalCount}（已切阶段）`,
                };
            }
            return { ready: false, text: '按阶段锁，暂未进入' };
        }

        if (stepId === 'closure_archive') {
            const lockId = this.state.pipelineStageLock || 'maintenance_mode';
            const snapshot = this.getClosureArchiveSnapshot();
            if (lockId === 'closure_archive') {
                return {
                    ready: false,
                    text: `进行中：归档与交接 ${snapshot.passedCount}/${snapshot.totalCount}`,
                };
            }
            if (lockId === 'maintenance_mode') {
                return {
                    ready: true,
                    text: `已完成：归档与交接 ${snapshot.passedCount}/${snapshot.totalCount}（已切阶段）`,
                };
            }
            return { ready: false, text: '按阶段锁，暂未进入' };
        }

        if (stepId === 'maintenance_mode') {
            const lockId = this.state.pipelineStageLock || 'maintenance_mode';
            const snapshot = this.getMaintenanceModeSnapshot();
            if (lockId === 'maintenance_mode') {
                return {
                    ready: false,
                    text: `进行中：维护巡检 ${snapshot.passedCount}/${snapshot.totalCount}`,
                };
            }
            return { ready: false, text: '按阶段锁，暂未进入' };
        }

        return { ready: false, text: '' };
    },

    renderPipelineStageProgress() {
        const lockEl = document.getElementById('pipeline-stage-lock');
        const legendEl = document.getElementById('pipeline-stage-legend');
        const stepsEl = document.getElementById('pipeline-stage-steps');
        const tipEl = document.getElementById('pipeline-stage-tip');
        if (!lockEl || !stepsEl || !tipEl) return;
        const setTip = (text, level = 'normal') => {
            tipEl.innerText = text;
            tipEl.className = `pipeline-stage-tip ${level}`;
        };

        const definitions = this.getPipelineStageDefinitions();
        const lockId = this.state.pipelineStageLock || 'maintenance_mode';
        const lockIndex = Math.max(0, definitions.findIndex((item) => item.id === lockId));
        const statusLabelMap = {
            done: '已完成',
            doing: '进行中',
            pending: '待开始',
            blocked: '待补齐',
        };

        const evaluated = definitions.map((step, index) => {
            const runtime = this.getPipelineRuntimeInfo(step.id);
            let status = 'pending';
            if (index < lockIndex) status = runtime.ready ? 'done' : 'blocked';
            else if (index === lockIndex) status = 'doing';
            else status = 'pending';
            return {
                ...step,
                status,
                runtimeText: runtime.text,
            };
        });

        const currentStep = evaluated[lockIndex] || null;
        const isAiGateReady =
            lockId === 'ai_enhancement'
            && !!currentStep
            && String(currentStep.runtimeText || '').includes('已达切阶段门槛');
        const lockSuffix = isAiGateReady ? '（已达切阶段门槛，待确认）' : '';
        lockEl.innerText = `阶段锁：当前推进到「${definitions[lockIndex].label}」${lockSuffix}`;
        stepsEl.innerHTML = evaluated.map((step, index) => (
            `<div class="pipeline-stage-step ${step.status}">` +
            `<span class="pipeline-stage-step-index">${index + 1}</span>` +
            `<div class="pipeline-stage-step-main">` +
            `<span class="pipeline-stage-step-label">${this.escapeHTML(step.label)}</span>` +
            `<span class="pipeline-stage-step-desc">${this.escapeHTML(step.runtimeText)}</span>` +
            `</div>` +
            `<span class="pipeline-stage-step-status">${statusLabelMap[step.status]}</span>` +
            `</div>`
        )).join('');

        if (legendEl) {
            const countByStatus = {
                done: evaluated.filter((step) => step.status === 'done').length,
                doing: evaluated.filter((step) => step.status === 'doing').length,
                blocked: evaluated.filter((step) => step.status === 'blocked').length,
                pending: evaluated.filter((step) => step.status === 'pending').length,
            };
            const legendLabels = {
                done: '已完成',
                doing: '进行中',
                blocked: '待补齐',
                pending: '待开始',
            };
            legendEl.innerHTML = ['done', 'doing', 'blocked', 'pending'].map((status) => (
                `<span class="pipeline-stage-legend-item ${status}">` +
                `<span class="pipeline-stage-legend-dot"></span>` +
                `<span>${legendLabels[status]} ${countByStatus[status]}</span>` +
                `</span>`
            )).join('');
        }

        const blockedCount = evaluated.filter((step) => step.status === 'blocked').length;
        const doneCount = evaluated.filter((step) => step.status === 'done').length;
        const opsSnapshot = ['ops_observability', 'release_hardening', 'post_release_observe', 'closure_archive', 'maintenance_mode'].includes(lockId)
            ? this.getOpsObservabilitySnapshot()
            : null;
        const releaseSnapshot = ['release_hardening', 'post_release_observe', 'closure_archive', 'maintenance_mode'].includes(lockId)
            ? this.getReleaseReadinessSnapshot()
            : null;
        const postReleaseSnapshot = ['post_release_observe', 'closure_archive', 'maintenance_mode'].includes(lockId)
            ? this.getPostReleaseObserveSnapshot()
            : null;
        const closureSnapshot = ['closure_archive', 'maintenance_mode'].includes(lockId)
            ? this.getClosureArchiveSnapshot()
            : null;
        const maintenanceSnapshot = lockId === 'maintenance_mode'
            ? this.getMaintenanceModeSnapshot()
            : null;
        if (blockedCount > 0) {
            setTip(`提示：前置链路还有 ${blockedCount} 项待补齐，建议先完成“刷新数据 -> 执行计算评分”再推进下一阶段。`, 'error');
        } else if (isAiGateReady) {
            setTip('当前链路进度：AI增强阶段已达到切阶段门槛，等待你确认后再切换下一阶段。', 'warn');
        } else if (lockId === 'ops_observability' && opsSnapshot) {
            const sc = opsSnapshot.severityCount || {};
            const errorCount = Number(sc.error || 0);
            const warnCount = Number(sc.warn || 0);
            const pendingCount = Number(sc.pending || 0);
            const firstIssueLabel = String(opsSnapshot.firstIssueItem?.label || '').trim();
            if (errorCount > 0) {
                setTip(
                    `当前链路进度：监控阶段发现 ${errorCount} 项异常（告警 ${warnCount}，待接入 ${pendingCount}）。${firstIssueLabel ? `优先检查：${firstIssueLabel}` : ''}`,
                    'error'
                );
            } else if (warnCount > 0) {
                setTip(
                    `当前链路进度：监控阶段存在 ${warnCount} 项告警（待接入 ${pendingCount}）。${firstIssueLabel ? `建议先检查：${firstIssueLabel}` : ''}`,
                    'warn'
                );
            } else if (pendingCount > 0) {
                setTip(
                    `当前链路进度：监控阶段待接入 ${pendingCount} 项信号，已固化 ${opsSnapshot.readyCount}/${opsSnapshot.totalCount}。`,
                    'pending'
                );
            } else {
                setTip(
                    `当前链路进度：监控信号已全部固化（${opsSnapshot.readyCount}/${opsSnapshot.totalCount}），当前无异常。`,
                    'ok'
                );
            }
        } else if (lockId === 'release_hardening' && opsSnapshot) {
            const sc = opsSnapshot.severityCount || {};
            const errorCount = Number(sc.error || 0);
            const warnCount = Number(sc.warn || 0);
            const failedChecks = Number((releaseSnapshot?.totalCount || 0) - (releaseSnapshot?.passedCount || 0));
            if (errorCount > 0) {
                setTip(
                    `当前链路进度：已进入发布准备阶段，但监控仍有 ${errorCount} 项异常（告警 ${warnCount}），建议先清零再做发布动作。`,
                    'error'
                );
            } else if (failedChecks > 0) {
                setTip(
                    `当前链路进度：发布前检查未完成（已通过 ${releaseSnapshot.passedCount}/${releaseSnapshot.totalCount}），请先补齐待补齐项。`,
                    'warn'
                );
            } else if (warnCount > 0) {
                setTip(
                    `当前链路进度：已进入发布准备阶段，监控存在 ${warnCount} 项告警，建议先完成治理并留存证据。`,
                    'warn'
                );
            } else {
                setTip(
                    '当前链路进度：已进入发布准备阶段，监控基线健康，可继续执行发布前检查项。',
                    'ok'
                );
            }
        } else if (lockId === 'post_release_observe' && postReleaseSnapshot) {
            if (postReleaseSnapshot.errorCount > 0) {
                setTip(
                    `当前链路进度：发布后运行观察发现 ${postReleaseSnapshot.errorCount} 项异常，请优先处置后再继续收官验收。`,
                    'error'
                );
            } else if (!postReleaseSnapshot.allHealthy) {
                setTip(
                    `当前链路进度：发布后运行观察已通过 ${postReleaseSnapshot.passedCount}/${postReleaseSnapshot.totalCount}，仍有待处置项。`,
                    'warn'
                );
            } else {
                setTip(
                    `当前链路进度：发布后运行观察已通过（${postReleaseSnapshot.passedCount}/${postReleaseSnapshot.totalCount}），可进入收官归档。`,
                    'ok'
                );
            }
        } else if (lockId === 'closure_archive' && closureSnapshot) {
            if (!postReleaseSnapshot?.allHealthy) {
                setTip(
                    `当前链路进度：收官归档前置条件未满足（发布后观察 ${postReleaseSnapshot?.passedCount || 0}/${postReleaseSnapshot?.totalCount || 0}）。`,
                    'warn'
                );
            } else if (!closureSnapshot.allReady) {
                setTip(
                    `当前链路进度：收官归档准备中（${closureSnapshot.passedCount}/${closureSnapshot.totalCount}），请补齐待归档项。`,
                    'warn'
                );
            } else {
                setTip(
                    `当前链路进度：收官归档与维护交接就绪（${closureSnapshot.passedCount}/${closureSnapshot.totalCount}），可进入维护模式。`,
                    'ok'
                );
            }
        } else if (lockId === 'maintenance_mode' && maintenanceSnapshot) {
            if (!maintenanceSnapshot.allHealthy) {
                setTip(
                    `当前链路进度：维护巡检进行中（${maintenanceSnapshot.passedCount}/${maintenanceSnapshot.totalCount}），请补齐待巡检项。`,
                    'warn'
                );
            } else {
                setTip(
                    `当前链路进度：维护巡检通过（${maintenanceSnapshot.passedCount}/${maintenanceSnapshot.totalCount}），可持续运行。`,
                    'ok'
                );
            }
        } else {
            setTip(`当前链路进度：已完成 ${doneCount}/${definitions.length}，正在执行「${definitions[lockIndex].label}」。`, 'normal');
        }
        this.renderReleaseReadinessPanel();
        this.renderReleaseRunbookPanel();
        this.renderPostReleaseObservePanel();
        this.renderClosureArchivePanel();
        this.renderMaintenanceModePanel();
    },

    async loadDataQualityStatus(targetDate = '') {
        try {
            const requestedDate = String(targetDate || '').trim();
            const [q, trend] = await Promise.all([
                API.getLatestDataQuality(requestedDate),
                API.getDataQualityTrend(7).catch(() => this.state.lastQualityTrend || null),
            ]);
            const latestTrendDate = String(trend?.items?.[0]?.date || '').trim();
            const currentDate = String(q?.date || '').trim();
            if (!requestedDate || (latestTrendDate && latestTrendDate === currentDate)) {
                this.state.lastQualityLatestSnapshot = q;
            } else {
                const latestSnapshot = await API.getLatestDataQuality().catch(() => null);
                if (latestSnapshot && typeof latestSnapshot === 'object') {
                    this.state.lastQualityLatestSnapshot = latestSnapshot;
                }
            }
            const failedSamples = await this.fetchQualityFailedSamples(q);
            this.state.lastQualityStatus = q;
            this.state.lastQualityTrend = trend;
            this.state.lastQualityFailedSamples = failedSamples;
            this.state.qualitySelectedDate = requestedDate;
            this.updateStatus(`质量: ${q.ok_rows}/${q.total_rows} 通过, 失败 ${q.failed_rows}, 阈值${q.max_failed_rows}`);
            this.renderQualityDateToolbar(q, trend);
            this.renderQualityGateStatus(q);
            this.renderQualityReasonCompare(q);
            this.renderQualityGateTrend(trend);
            this.renderQualitySampleFilters(q);
            this.renderQualityFailedSamples(failedSamples, q);
            this.renderPipelineStageProgress();
            this.renderOpsMonitorPanel();
        } catch (e) {
            console.error('加载数据质量状态失败:', e);
            this.renderQualityDateToolbar(null, this.state.lastQualityTrend);
            this.renderQualityReasonCompare(null);
            this.renderQualitySampleFilters(null);
            this.renderQualityFailedSamples(null, null);
            this.renderPipelineStageProgress();
            this.renderOpsMonitorPanel();
        }
    },

    renderQualityDateToolbar(q, trendData) {
        const barEl = document.getElementById('quality-gate-date-toolbar');
        if (!barEl) return;
        if (!q) {
            barEl.innerHTML = '';
            return;
        }

        const items = Array.isArray(trendData?.items) ? trendData.items : [];
        const latestDate = String(items?.[0]?.date || q?.date || '').trim();
        const currentDate = String(q?.date || '').trim();
        const isLatestView = !latestDate || currentDate === latestDate;
        this.state.qualitySelectedDate = isLatestView ? '' : currentDate;

        const modeText = isLatestView ? '最新快照' : '历史下钻';
        const resetBtn = isLatestView
            ? ''
            : `<button class="quality-gate-date-btn" onclick="App.resetQualityDateToLatest()">回到最新</button>`;

        barEl.innerHTML = [
            `<span class="quality-gate-date-mode">${this.escapeHTML(modeText)}</span>`,
            `<span class="quality-gate-date-value">观察日期 ${this.escapeHTML(currentDate || '--')}</span>`,
            resetBtn,
        ].join('');
    },

    renderQualityReasonCompare(q) {
        const compareEl = document.getElementById('quality-gate-reason-compare');
        if (!compareEl) return;
        if (!q) {
            compareEl.innerHTML = '';
            return;
        }

        const currentDate = String(q?.date || '').trim();
        const currentReasons = Array.isArray(q?.reason_distribution) ? q.reason_distribution : [];
        const currentFailedRows = Number(q?.failed_rows || 0);
        const latestSnapshot = this.state.lastQualityLatestSnapshot || null;
        const latestDate = String(latestSnapshot?.date || '').trim();
        const latestFailedRows = Number(latestSnapshot?.failed_rows || 0);
        const latestReasons = Array.isArray(latestSnapshot?.reason_distribution) ? latestSnapshot.reason_distribution : [];
        const hasLatestBaseline = !!latestSnapshot && !!latestDate && latestDate !== currentDate;
        const currentReasonFilter = String(this.state.qualitySampleFilters?.reason || '').trim();
        const currentMap = new Map();
        currentReasons.forEach((item) => {
            const reason = String(item?.reason || '').trim();
            if (!reason) return;
            currentMap.set(reason, Number(item?.count || 0));
        });

        if (currentFailedRows <= 0 || currentReasons.length === 0) {
            const emptySummary = hasLatestBaseline
                ? `原因分布：${this.escapeHTML(currentDate)} 无失败；最新 ${this.escapeHTML(latestDate)} 失败 ${latestFailedRows}`
                : `原因分布：${this.escapeHTML(currentDate)} 无失败`;
            let html = `<span class="quality-gate-compare-empty">${emptySummary}</span>`;
            if (hasLatestBaseline && latestReasons.length > 0) {
                const disappearedLabels = latestReasons
                    .slice(0, 4)
                    .map((it) => `${it.reason} × ${Number(it.count || 0)}`)
                    .join('，');
                if (disappearedLabels) {
                    html += `<span class="quality-gate-compare-divider"></span>`;
                    html += `<span class="quality-gate-compare-drift down">相对最新已消失: ${this.escapeHTML(disappearedLabels)}</span>`;
                }
            }
            compareEl.innerHTML = html;
            return;
        }

        const baseMap = new Map();
        latestReasons.forEach((item) => {
            const reason = String(item?.reason || '').trim();
            if (!reason) return;
            baseMap.set(reason, Number(item?.count || 0));
        });

        const summary = hasLatestBaseline
            ? `原因分布对比：${this.escapeHTML(currentDate)}(失败${currentFailedRows}) vs 最新 ${this.escapeHTML(latestDate)}(失败${latestFailedRows})`
            : `原因分布：${this.escapeHTML(currentDate)}(失败${currentFailedRows})`;

        const chips = currentReasons.slice(0, 6).map((item) => {
            const reason = String(item?.reason || '').trim();
            if (!reason) return '';
            const count = Number(item?.count || 0);
            const baseCount = Number(baseMap.get(reason) || 0);
            const delta = count - baseCount;
            const deltaText = hasLatestBaseline
                ? ` | 最新${baseCount} | ${delta >= 0 ? `+${delta}` : `${delta}`}`
                : '';
            const cls = hasLatestBaseline
                ? (delta > 0 ? ' up' : (delta < 0 ? ' down' : ' same'))
                : '';
            const activeClass = reason === currentReasonFilter ? ' active' : '';
            return (
                `<span class="quality-gate-compare-chip${cls}${activeClass}" ` +
                `data-reason="${this.escapeHTML(reason)}" ` +
                `onclick="App.applyQualityReasonQuickFilter(this.dataset.reason)" ` +
                `title="${this.escapeHTML(`点击按该原因筛选失败样本: ${reason}`)}">` +
                `${this.escapeHTML(`${reason} × ${count}${deltaText}`)}</span>`
            );
        }).filter(Boolean);

        compareEl.innerHTML =
            `<span class="quality-gate-compare-summary">${summary}</span>` +
            (chips.length > 0 ? chips.join('') : `<span class="quality-gate-compare-empty">无可展示原因</span>`);

        if (!hasLatestBaseline) return;

        const addedReasons = [];
        currentMap.forEach((count, reason) => {
            const baseCount = Number(baseMap.get(reason) || 0);
            if (count > 0 && baseCount <= 0) {
                addedReasons.push({ reason, count });
            }
        });
        const disappearedReasons = [];
        baseMap.forEach((count, reason) => {
            const currentCount = Number(currentMap.get(reason) || 0);
            if (count > 0 && currentCount <= 0) {
                disappearedReasons.push({ reason, count });
            }
        });

        const driftHints = [];
        if (addedReasons.length > 0) {
            const labels = addedReasons
                .slice(0, 4)
                .map((it) => `${it.reason} × ${it.count}`)
                .join('，');
            driftHints.push(`<span class="quality-gate-compare-drift up">历史新增: ${this.escapeHTML(labels)}</span>`);
        }
        if (disappearedReasons.length > 0) {
            const labels = disappearedReasons
                .slice(0, 4)
                .map((it) => `${it.reason} × ${it.count}`)
                .join('，');
            driftHints.push(`<span class="quality-gate-compare-drift down">相对最新已消失: ${this.escapeHTML(labels)}</span>`);
        }
        if (driftHints.length > 0) {
            compareEl.innerHTML = `${compareEl.innerHTML}<span class="quality-gate-compare-divider"></span>${driftHints.join('')}`;
        }
    },

    renderQualityGateStatus(q) {
        const mainEl = document.getElementById('quality-gate-main');
        const subEl = document.getElementById('quality-gate-sub');
        const reasonsEl = document.getElementById('quality-gate-reasons');
        const sourceEl = document.getElementById('quality-gate-source');
        if (!mainEl || !subEl || !reasonsEl || !sourceEl || !q) return;

        const blockedReasons = Array.isArray(q.publish_blocked_reasons) ? q.publish_blocked_reasons : [];
        const reasonDistribution = Array.isArray(q.reason_distribution) ? q.reason_distribution : [];
        const hasFreshness = Object.prototype.hasOwnProperty.call(q, 'freshness_ok');
        let freshnessText = '新鲜度待检测';
        if (hasFreshness) {
            freshnessText = q.freshness_ok
                ? `新鲜度通过（${q.sync_age_minutes ?? '--'}m / 阈值${q.stale_minutes ?? '--'}m）`
                : `新鲜度失败（${q.freshness_reason || 'unknown'}）`;
        }

        if (q.publish_allowed) {
            mainEl.classList.remove('blocked');
            mainEl.classList.add('ok');
            mainEl.innerText = '质量门控：允许发布';
        } else {
            mainEl.classList.remove('ok');
            mainEl.classList.add('blocked');
            mainEl.innerText = '质量门控：禁止发布';
        }

        subEl.innerText =
            `总计${q.total_rows ?? '--'}，失败${q.failed_rows ?? '--'}，阈值${q.max_failed_rows ?? '--'}，${freshnessText}`;

        const fb = q.failure_buckets || {};
        const bucketSummary = [
            `缺失${Number(fb.missing_rows || 0)}`,
            `异常${Number(fb.anomaly_rows || 0)}`,
            `解析${Number(fb.invalid_rows || 0)}`,
            `降级${Number(fb.fallback_rows || 0)}`,
        ].join("，");
        subEl.innerText = `${subEl.innerText}，${bucketSummary}`;

        const currentReasonFilter = String(this.state.qualitySampleFilters?.reason || '').trim();
        const blockedReasonTags = blockedReasons.map((item) => {
            const text = (item && item.message) ? String(item.message) : '';
            if (!text) return '';
            return `<span class="quality-gate-reason quality-gate-reason-blocked">阻断: ${this.escapeHTML(text)}</span>`;
        }).filter(Boolean);

        const distributionReasonTags = reasonDistribution.slice(0, 6).map((item) => {
            const reason = String(item?.reason || '').trim();
            if (!reason) return '';
            const count = Number(item?.count || 0);
            const activeClass = reason === currentReasonFilter ? ' active' : '';
            return (
                `<span class="quality-gate-reason quality-gate-reason-filter${activeClass}" ` +
                `data-reason="${this.escapeHTML(reason)}" ` +
                `title="点击按该原因筛选失败样本" ` +
                `onclick="App.applyQualityReasonQuickFilter(this.dataset.reason)">` +
                `${this.escapeHTML(`${reason} × ${count}`)}</span>`
            );
        }).filter(Boolean);

        const reasonTags = blockedReasonTags.concat(distributionReasonTags);
        if (reasonTags.length === 0) {
            reasonsEl.innerHTML = `<span class="quality-gate-reason">暂无失败原因</span>`;
        } else {
            reasonsEl.innerHTML = reasonTags.join('');
        }

        const sourceDistribution = Array.isArray(q.source_distribution) ? q.source_distribution : [];
        if (sourceDistribution.length === 0) {
            sourceEl.innerHTML = `<span class="quality-gate-source-empty">来源分布：暂无</span>`;
            return;
        }

        const sourceSummary = `<span class="quality-gate-source-summary">来源分布</span>`;
        const sourceChips = sourceDistribution.slice(0, 6).map((item) => {
            const sourceName = String(item?.source_name || 'unknown_source');
            const totalRows = Number(item?.total_rows || 0);
            const failedRows = Number(item?.failed_rows || 0);
            const okRows = Number(item?.ok_rows || Math.max(0, totalRows - failedRows));
            const text = `${sourceName}: ${okRows}/${totalRows} (fail ${failedRows})`;
            return `<span class="quality-gate-source-chip">${this.escapeHTML(text)}</span>`;
        });
        sourceEl.innerHTML = sourceSummary + sourceChips.join('');
    },

    renderQualityGateTrend(trendData) {
        const trendEl = document.getElementById('quality-gate-trend');
        if (!trendEl) return;

        const items = Array.isArray(trendData?.items) ? trendData.items : [];
        const currentViewDate = String(this.state.lastQualityStatus?.date || '').trim();
        if (items.length === 0) {
            trendEl.innerHTML = `<span class="quality-gate-trend-empty">趋势数据暂不可用</span>`;
            return;
        }

        const stableDays = items.filter((item) => !!item?.publish_allowed).length;
        const summary = `<span class="quality-gate-trend-summary">近${items.length}日可发布 ${stableDays}/${items.length}</span>`;

        const chips = items.slice(0, 7).map((item) => {
            const d = String(item?.date || '--');
            const shortDate = d.length >= 10 ? d.slice(5, 10) : d;
            const isOk = !!item?.publish_allowed;
            const failedRows = Number(item?.failed_rows || 0);
            const chipClass = isOk ? 'ok' : 'blocked';
            const activeClass = d === currentViewDate ? ' active' : '';
            const label = isOk ? `${shortDate} √` : `${shortDate} ×${failedRows}`;
            const blocked = Array.isArray(item?.blocked_rules) ? item.blocked_rules.join(',') : '';
            const topReason = String(item?.top_reason || '');
            const fb = item?.failure_buckets || {};
            const bucketText = [
                `missing=${Number(fb.missing_rows || 0)}`,
                `anomaly=${Number(fb.anomaly_rows || 0)}`,
                `invalid=${Number(fb.invalid_rows || 0)}`,
                `fallback=${Number(fb.fallback_rows || 0)}`,
            ].join(', ');
            const tip = isOk
                ? `date=${d}, failed_rows=${failedRows}, ${bucketText}`
                : `date=${d}, blocked=${blocked || '-'}, top_reason=${topReason || '-'}, ${bucketText}`;

            return (
                `<span class="quality-gate-trend-chip ${chipClass}${activeClass}" ` +
                `data-date="${this.escapeHTML(d)}" ` +
                `onclick="App.onQualityTrendDateSelect(this.dataset.date)" ` +
                `title="${this.escapeHTML(tip)}">${this.escapeHTML(label)}</span>`
            );
        });

        trendEl.innerHTML = summary + chips.join('');
    },

    async onQualityTrendDateSelect(targetDate) {
        const selectedDate = String(targetDate || '').trim();
        const currentDate = String(this.state.lastQualityStatus?.date || '').trim();
        if (!selectedDate || selectedDate === currentDate) return;

        this.state.qualitySampleFilters = {
            reason: '',
            categoryType: '',
            search: '',
            limit: 6,
        };
        this.updateStatus(`质量: 正在切换到 ${selectedDate} ...`);
        await this.loadDataQualityStatus(selectedDate);
    },

    async resetQualityDateToLatest() {
        if (!this.state.qualitySelectedDate) return;
        this.state.qualitySampleFilters = {
            reason: '',
            categoryType: '',
            search: '',
            limit: 6,
        };
        this.state.qualitySelectedDate = '';
        this.updateStatus('质量: 正在切换到最新快照 ...');
        await this.loadDataQualityStatus('');
    },

    hasQualitySampleFilter() {
        const filters = this.state.qualitySampleFilters || {};
        return !!(
            String(filters.reason || '').trim() ||
            String(filters.categoryType || '').trim() ||
            String(filters.search || '').trim()
        );
    },

    buildQualitySampleQuery(q) {
        const filters = this.state.qualitySampleFilters || {};
        const limitRaw = Number(filters.limit || 6);
        return {
            targetDate: q?.date || '',
            reason: String(filters.reason || '').trim(),
            categoryType: String(filters.categoryType || '').trim(),
            search: String(filters.search || '').trim(),
            limit: Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 6,
        };
    },

    async fetchQualityFailedSamples(q) {
        if (!q || Number(q?.failed_rows || 0) <= 0) return null;
        return API.getFailedDataQualityRows(this.buildQualitySampleQuery(q)).catch(() => null);
    },

    renderQualitySampleFilters(q) {
        const filtersEl = document.getElementById('quality-gate-sample-filters');
        if (!filtersEl) return;

        if (!q || Number(q?.failed_rows || 0) <= 0) {
            filtersEl.innerHTML = '';
            return;
        }

        const filters = this.state.qualitySampleFilters || {};
        const reasonDistribution = Array.isArray(q.reason_distribution) ? q.reason_distribution : [];
        const reasonOptions = reasonDistribution.slice(0, 20).map((item) => {
            const reason = String(item?.reason || '').trim();
            if (!reason) return '';
            const selected = reason === String(filters.reason || '') ? 'selected' : '';
            const label = `${reason} (${item.count || 0})`;
            return `<option value="${this.escapeHTML(reason)}" ${selected}>${this.escapeHTML(label)}</option>`;
        }).join('');
        const categoryType = String(filters.categoryType || '');
        const categoryIndustrySelected = categoryType === '行业' ? 'selected' : '';
        const categoryConceptSelected = categoryType === '概念' ? 'selected' : '';
        const searchValue = this.escapeHTML(String(filters.search || ''));

        filtersEl.innerHTML = `
            <span class="quality-gate-filter-title">样本筛选</span>
            <select class="quality-gate-filter-select" onchange="App.onQualitySampleFilterChange('reason', this.value)">
                <option value="">全部原因</option>
                ${reasonOptions}
            </select>
            <select class="quality-gate-filter-select" onchange="App.onQualitySampleFilterChange('categoryType', this.value)">
                <option value="">全部类型</option>
                <option value="行业" ${categoryIndustrySelected}>行业</option>
                <option value="概念" ${categoryConceptSelected}>概念</option>
            </select>
            <input
                class="quality-gate-filter-input"
                type="text"
                value="${searchValue}"
                placeholder="筛选板块名"
                oninput="App.onQualitySampleFilterChange('search', this.value)"
            >
            <button class="quality-gate-filter-btn" onclick="App.resetQualitySampleFilters()">重置</button>
        `;
    },

    applyQualityReasonQuickFilter(reason) {
        const reasonValue = String(reason || '').trim();
        if (!reasonValue) return;
        const filters = this.state.qualitySampleFilters || (this.state.qualitySampleFilters = {});
        const currentReason = String(filters.reason || '').trim();
        filters.reason = currentReason === reasonValue ? '' : reasonValue;
        const q = this.state.lastQualityStatus;
        this.renderQualityGateStatus(q);
        this.renderQualityReasonCompare(q);
        this.renderQualitySampleFilters(q);
        this.reloadQualityFailedSamples();
    },

    onQualitySampleFilterChange(field, value) {
        const filters = this.state.qualitySampleFilters || (this.state.qualitySampleFilters = {});
        filters[field] = String(value || '');

        if (field === 'search') {
            if (this.state.qualitySampleDebounceTimer) {
                clearTimeout(this.state.qualitySampleDebounceTimer);
            }
            this.state.qualitySampleDebounceTimer = setTimeout(() => {
                this.reloadQualityFailedSamples();
            }, 350);
            return;
        }
        const q = this.state.lastQualityStatus;
        this.renderQualityGateStatus(q);
        this.renderQualityReasonCompare(q);
        this.renderQualitySampleFilters(q);
        this.reloadQualityFailedSamples();
    },

    resetQualitySampleFilters() {
        this.state.qualitySampleFilters = {
            reason: '',
            categoryType: '',
            search: '',
            limit: 6,
        };
        const q = this.state.lastQualityStatus;
        this.renderQualityGateStatus(q);
        this.renderQualityReasonCompare(q);
        this.renderQualitySampleFilters(q);
        this.reloadQualityFailedSamples();
    },

    async reloadQualityFailedSamples() {
        const q = this.state.lastQualityStatus;
        if (!q) return;
        if (Number(q?.failed_rows || 0) <= 0) {
            this.state.lastQualityFailedSamples = null;
            this.renderQualityFailedSamples(null, q);
            return;
        }
        const samplesEl = document.getElementById('quality-gate-samples');
        if (samplesEl) {
            samplesEl.innerHTML = `<span class="quality-gate-samples-empty">失败样本：加载中...</span>`;
        }
        const failedSamples = await this.fetchQualityFailedSamples(q);
        this.state.lastQualityFailedSamples = failedSamples;
        this.renderQualityFailedSamples(failedSamples, q);
    },

    renderQualityFailedSamples(sampleData, q) {
        const samplesEl = document.getElementById('quality-gate-samples');
        if (!samplesEl) return;

        const failedRowsFromStatus = Number(q?.failed_rows || 0);
        const items = Array.isArray(sampleData?.items) ? sampleData.items : [];
        const hasActiveFilter = this.hasQualitySampleFilter();
        const sampleTotalRows = Number(sampleData?.total_failed_rows || 0);
        const totalFailedRows = hasActiveFilter
            ? sampleTotalRows
            : (failedRowsFromStatus > 0 ? failedRowsFromStatus : sampleTotalRows);

        if (failedRowsFromStatus <= 0 && totalFailedRows <= 0) {
            samplesEl.innerHTML = `<span class="quality-gate-samples-empty">失败样本：当前无失败行</span>`;
            return;
        }

        if (items.length === 0) {
            const emptyText = hasActiveFilter
                ? '失败样本：筛选后无结果'
                : '失败样本：加载中或暂不可用';
            samplesEl.innerHTML = `<span class="quality-gate-samples-empty">${emptyText}</span>`;
            return;
        }

        const summaryLabel = hasActiveFilter ? '失败样本(筛选)' : '失败样本';
        const summary = `<span class="quality-gate-samples-summary">${summaryLabel} ${items.length}/${totalFailedRows}</span>`;
        const chips = items.slice(0, 6).map((item) => {
            const name = String(item?.sector_name || item?.sector_id || 'unknown');
            const reasons = Array.isArray(item?.quality_reasons) ? item.quality_reasons : [];
            const reasonText = reasons.length > 0
                ? reasons.slice(0, 2).join(',')
                : String(item?.quality_reason || 'unknown_reason');
            const tip =
                `name=${name}, reasons=${reasonText}, daily_change=${item?.daily_change ?? '--'}, ` +
                `net_amount=${item?.net_amount ?? '--'}, turnover=${item?.turnover ?? '--'}, ` +
                `lead_stock_change=${item?.lead_stock_change ?? '--'}`;
            const label = `${name} · ${reasonText}`;
            return `<span class="quality-gate-sample-chip" title="${this.escapeHTML(tip)}">${this.escapeHTML(label)}</span>`;
        });

        samplesEl.innerHTML = summary + chips.join('');
    },

    updateStatus(msg) {
        const el = document.getElementById('toolbar-status');
        if (el) el.innerText = msg ? `| ${msg}` : '';
    },

    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container') || this._createToastContainer();
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
            <span class="toast-msg">${message}</span>
        `;
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    },

    _createToastContainer() {
        const el = document.createElement('div');
        el.id = 'toast-container';
        document.body.appendChild(el);
        return el;
    },

    setLoading(loading) {
        this.state.isLoading = loading;
        [
            'btn-refresh',
            'btn-calc',
            'btn-ai',
            'btn-data-health',
            'btn-data-apply',
            'btn-quality-preset-low',
            'btn-quality-preset-medium',
            'btn-quality-preset-high',
            'btn-backtest-run-inline',
            'btn-backtest-jobs-refresh',
            'btn-backtest-consistency-check',
        ].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = loading;
        });
        this.updateStatus(loading ? '正在同步数据...' : '就绪');
    },
    getQualityGatePresets() {
        const requiredFields = 'name,category_type,daily_change,net_amount,turnover,lead_stock_change';
        return {
            low: {
                label: '低（宽松）',
                quality_max_failed_rows: '60',
                quality_min_total_rows: '120',
                quality_stale_minutes: '360',
                quality_require_freshness_for_publish: '0',
                quality_required_fields: requiredFields,
                quality_daily_change_abs_max: '25',
                quality_lead_stock_change_abs_max: '30',
                quality_turnover_abs_max: '50',
                quality_net_amount_abs_max: '800',
            },
            medium: {
                label: '中（推荐）',
                quality_max_failed_rows: '25',
                quality_min_total_rows: '180',
                quality_stale_minutes: '240',
                quality_require_freshness_for_publish: '1',
                quality_required_fields: requiredFields,
                quality_daily_change_abs_max: '20',
                quality_lead_stock_change_abs_max: '25',
                quality_turnover_abs_max: '30',
                quality_net_amount_abs_max: '500',
            },
            high: {
                label: '高（严格）',
                quality_max_failed_rows: '0',
                quality_min_total_rows: '220',
                quality_stale_minutes: '120',
                quality_require_freshness_for_publish: '1',
                quality_required_fields: requiredFields,
                quality_daily_change_abs_max: '15',
                quality_lead_stock_change_abs_max: '20',
                quality_turnover_abs_max: '20',
                quality_net_amount_abs_max: '300',
            },
        };
    },
    detectQualityPresetFromInputs() {
        const presets = this.getQualityGatePresets();
        const getVal = (id) => String(document.getElementById(id)?.value || '').trim();
        const freshness = document.getElementById('cfg-quality-require-freshness')?.checked ? '1' : '0';
        const current = {
            quality_max_failed_rows: getVal('cfg-quality-max-failed-rows'),
            quality_min_total_rows: getVal('cfg-quality-min-total-rows'),
            quality_stale_minutes: getVal('cfg-quality-stale-minutes'),
            quality_require_freshness_for_publish: freshness,
            quality_required_fields: getVal('cfg-quality-required-fields'),
            quality_daily_change_abs_max: getVal('cfg-quality-daily-change-max'),
            quality_lead_stock_change_abs_max: getVal('cfg-quality-lead-stock-change-max'),
            quality_turnover_abs_max: getVal('cfg-quality-turnover-max'),
            quality_net_amount_abs_max: getVal('cfg-quality-net-amount-max'),
        };
        const keys = Object.keys(presets);
        for (const key of keys) {
            const p = presets[key];
            const matched = (
                current.quality_max_failed_rows === p.quality_max_failed_rows
                && current.quality_min_total_rows === p.quality_min_total_rows
                && current.quality_stale_minutes === p.quality_stale_minutes
                && current.quality_require_freshness_for_publish === p.quality_require_freshness_for_publish
                && current.quality_required_fields === p.quality_required_fields
                && current.quality_daily_change_abs_max === p.quality_daily_change_abs_max
                && current.quality_lead_stock_change_abs_max === p.quality_lead_stock_change_abs_max
                && current.quality_turnover_abs_max === p.quality_turnover_abs_max
                && current.quality_net_amount_abs_max === p.quality_net_amount_abs_max
            );
            if (matched) return key;
        }
        return '';
    },
    updateQualityPresetUI(activePresetKey = '') {
        const ids = ['low', 'medium', 'high'];
        ids.forEach((key) => {
            const btn = document.getElementById(`btn-quality-preset-${key}`);
            if (!btn) return;
            btn.classList.toggle('active', key === activePresetKey);
        });
        const hintEl = document.getElementById('quality-preset-hint');
        if (!hintEl) return;
        const presets = this.getQualityGatePresets();
        const preset = activePresetKey ? presets[activePresetKey] : null;
        hintEl.innerText = preset ? `当前档位：${preset.label}` : '当前档位：自定义';
    },
    bindQualityPresetWatchers() {
        if (this.state.qualityPresetListenersBound) return;
        const watchIds = [
            'cfg-quality-max-failed-rows',
            'cfg-quality-min-total-rows',
            'cfg-quality-stale-minutes',
            'cfg-quality-required-fields',
            'cfg-quality-daily-change-max',
            'cfg-quality-lead-stock-change-max',
            'cfg-quality-turnover-max',
            'cfg-quality-net-amount-max',
            'cfg-quality-require-freshness',
        ];
        watchIds.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const eventName = (id === 'cfg-quality-require-freshness') ? 'change' : 'input';
            el.addEventListener(eventName, () => {
                this.updateQualityPresetUI(this.detectQualityPresetFromInputs());
            });
        });
        this.state.qualityPresetListenersBound = true;
    },
    applyQualityPresetToInputs(presetKey) {
        const preset = this.getQualityGatePresets()[presetKey];
        if (!preset) return null;
        const setVal = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = String(value);
        };
        setVal('cfg-quality-max-failed-rows', preset.quality_max_failed_rows);
        setVal('cfg-quality-min-total-rows', preset.quality_min_total_rows);
        setVal('cfg-quality-stale-minutes', preset.quality_stale_minutes);
        setVal('cfg-quality-required-fields', preset.quality_required_fields);
        setVal('cfg-quality-daily-change-max', preset.quality_daily_change_abs_max);
        setVal('cfg-quality-lead-stock-change-max', preset.quality_lead_stock_change_abs_max);
        setVal('cfg-quality-turnover-max', preset.quality_turnover_abs_max);
        setVal('cfg-quality-net-amount-max', preset.quality_net_amount_abs_max);
        const freshness = document.getElementById('cfg-quality-require-freshness');
        if (freshness) freshness.checked = preset.quality_require_freshness_for_publish === '1';
        this.updateQualityPresetUI(presetKey);
        return preset;
    },
    async handleApplyQualityPreset(presetKey) {
        if (this.state.isLoading) return;
        const preset = this.applyQualityPresetToInputs(presetKey);
        if (!preset) {
            this.showToast('未知质量门控档位。', 'error');
            return;
        }
        await this.saveSettings();
    },
    getDefaultDataSourceHealthRows() {
        const sourceDisplayMap = {
            sina: '新浪财经',
            akshare: 'AKShare',
            eastmoney: '东方财富',
            tushare: 'TuShare',
        };
        const sel = document.getElementById('cfg-data-primary');
        let sources = ['sina', 'akshare', 'eastmoney', 'tushare'];
        if (sel && sel.options && sel.options.length > 0) {
            const fromSelect = Array.from(sel.options)
                .map((opt) => String(opt.value || '').trim())
                .filter(Boolean);
            if (fromSelect.length > 0) sources = fromSelect;
        }
        const uniq = Array.from(new Set(sources));
        return uniq.map((src) => ({
            source_name: src,
            source_display_name: sourceDisplayMap[src] || src,
            status: 'unknown',
        }));
    },
    escapeHTML(text) {
        return String(text || '').replace(/[&<>\"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '\"': '&quot;',
            "'": '&#39;',
        }[ch]));
    },
    // ============================================================
    // 系统管理与自检 (Step 14)
    // ============================================================
    async clearUnlockedRelations() {
        if (!confirm('确定要清理所有未锁定（🔒）的关联吗？此操作通常用于撤销 AI 生成关联。')) return;
        this.setLoading(true);
        try {
            const res = await API.clearUnlockedRelations();
            this.showToast(`清理完成，移除了 ${res.deleted_count} 条`, 'success');
            await this.loadRelations();
        } catch (e) {
            console.error(e);
            this.showToast('清理失败', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async switchPage(page) {
        this.state.currentPage = page;

        // 更新导航高亮 (侧边栏)
        document.querySelectorAll('.nav-item').forEach(el =>
            el.classList.toggle('active', el.dataset.tab === page)
        );

        // 更新面板显示 (严格切换)
        document.querySelectorAll('.tab-panel').forEach(el =>
            el.classList.toggle('active', el.id === `panel-${page}`)
        );

        // 页面特定的数据加载辑
        if (page === 'ranking') {
            await this.loadRanking();
            await this.loadBacktestJobs(true);
        }
        if (page === 'graph') setTimeout(() => this.renderGraph(), 100);

        // 原数据管理子页拆分后的加载辑
        if (page === 'manage-sectors') {
            this.updateSectorManageViewButtons();
            await this.loadSectors();
        }
        if (page === 'manage-relations') await this.loadRelations();
        if (page === 'manage-logics') await this.loadLogics();

        if (page === 'backtest') {
            setTimeout(async () => {
                await this.loadBacktestJobs(true);
                await this.loadBacktestDashboard(this.state.backtestSelectedRunId || this.state.lastBacktestRunId || '');
                this.startBacktestJobPolling();
                if (this.state.backtestChart) this.state.backtestChart.resize();
            }, 50);
        } else {
            this.stopBacktestJobPolling();
        }

        if (page === 'settings') await this.loadSettingsIntoView();
    },

    async loadSettingsIntoView() {
        const healthSummary = document.getElementById('data-health-summary');
        const placeholderResults = this.getDefaultDataSourceHealthRows();
        const renderPendingDataSourceHealth = () => {
            this.renderDataSourceHealth({
                checked_at: '未检测',
                status: 'unknown',
                recommended_primary_source: '',
                recommended_primary_source_display_name: '',
                recommended_verify_source: '',
                recommended_verify_source_display_name: '',
                results: placeholderResults,
            });
            // 首次进入设置页，保持“推荐主源”按钮禁用，避免误操作
            this.state.lastDataSourceHealth = null;
            const applyBtn = document.getElementById('btn-data-apply');
            if (applyBtn) applyBtn.disabled = true;
            if (healthSummary) healthSummary.title = '点击“检查数据源连通性”获取实时状态';
        };

        // 先渲染“未检测”占位，避免配置接口异常导致区域空白
        renderPendingDataSourceHealth();

        const setValueIfExists = (id, value) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = value;
        };
        const setCheckedIfExists = (id, checked) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.checked = !!checked;
        };

        try {
            const cfg = await API.getConfig();
            if (cfg.ai) {
                setValueIfExists('cfg-ai-provider', cfg.ai.provider || '');
                const keyInput = document.getElementById('cfg-ai-key');
                if (keyInput) {
                    keyInput.value = '';
                    keyInput.placeholder = cfg.ai.api_key_set
                        ? `已配置: ${cfg.ai.api_key_masked || '****'}（留空则不修改）`
                        : '在此输入您的 API Key';
                }
                setValueIfExists('cfg-ai-url', cfg.ai.base_url || '');
                setValueIfExists('cfg-ai-model', cfg.ai.model || '');
            }
            if (cfg.algo) {
                setValueIfExists('cfg-algo-mode', cfg.algo.deviation_mode || '');
                setValueIfExists('cfg-algo-decay', cfg.algo.time_decay_days || 30);
                const qualityRequireFreshness = document.getElementById('cfg-quality-require-freshness');
                setValueIfExists('cfg-quality-max-failed-rows', cfg.algo.quality_max_failed_rows || '25');
                setValueIfExists('cfg-quality-min-total-rows', cfg.algo.quality_min_total_rows || '180');
                setValueIfExists('cfg-quality-stale-minutes', cfg.algo.quality_stale_minutes || '240');
                setValueIfExists(
                    'cfg-quality-required-fields',
                    cfg.algo.quality_required_fields || 'name,category_type,daily_change,net_amount,turnover,lead_stock_change'
                );
                setValueIfExists('cfg-quality-daily-change-max', cfg.algo.quality_daily_change_abs_max || '20');
                setValueIfExists('cfg-quality-lead-stock-change-max', cfg.algo.quality_lead_stock_change_abs_max || '25');
                setValueIfExists('cfg-quality-turnover-max', cfg.algo.quality_turnover_abs_max || '30');
                setValueIfExists('cfg-quality-net-amount-max', cfg.algo.quality_net_amount_abs_max || '500');
                if (qualityRequireFreshness) {
                    qualityRequireFreshness.checked = ['1', 'true', 'yes', 'on'].includes(
                        String(cfg.algo.quality_require_freshness_for_publish || '1').toLowerCase()
                    );
                }
            }
            if (cfg.data) {
                setValueIfExists('cfg-data-primary', cfg.data.primary_source || 'sina');
                setValueIfExists('cfg-data-verify', cfg.data.verify_source || '');
                const tushareTokenInput = document.getElementById('cfg-data-tushare-token');
                if (tushareTokenInput) {
                    tushareTokenInput.value = '';
                    tushareTokenInput.placeholder = cfg.data.tushare_token_set
                        ? `已配置: ${cfg.data.tushare_token_masked || '****'}（留空则不修改）`
                        : '输入 TuShare Token（留空则不修改）';
                }
                setCheckedIfExists(
                    'cfg-data-dual',
                    ['1', 'true', 'yes', 'on'].includes(String(cfg.data.dual_compare_enabled || '0').toLowerCase())
                );
                setValueIfExists('cfg-data-threshold', cfg.data.compare_warn_threshold_pct || '0.8');
                setCheckedIfExists(
                    'cfg-data-proxy-enabled',
                    ['1', 'true', 'yes', 'on'].includes(String(cfg.data.http_proxy_enabled || '0').toLowerCase())
                );
                setValueIfExists('cfg-data-proxy', cfg.data.http_proxy || '');
                setValueIfExists('cfg-data-proxy-strategy', cfg.data.http_proxy_strategy || 'auto');
                setValueIfExists('cfg-data-ignore-list', cfg.data.sector_ignore_keywords || '');
                this.setSectorIgnoreKeywords(cfg.data.sector_ignore_keywords || '');
                this.state.sectorIgnoreKeywordsLoaded = true;
                this.renderSectorIgnoreKeywordPreview();
            }
        } catch (e) {
            console.error('加载设置失败，保留数据源未检测占位:', e);
            this.showToast('加载设置失败，已保留数据源未检测占位。', 'error');
        } finally {
            this.handleProxyConfigToggle();
            this.bindQualityPresetWatchers();
            this.updateQualityPresetUI(this.detectQualityPresetFromInputs());
            const runInput = document.getElementById('cfg-opt-run-id');
            if (runInput) {
                const inferredRunId = String(
                    this.state.backtestResultRunId || this.state.backtestSelectedRunId || this.state.lastBacktestRunId || ''
                ).trim();
                if (!runInput.value && inferredRunId) runInput.value = inferredRunId;
            }
            await this.loadOptimizationSuggestions();
            await this.loadConfigVersions();
            await this.handleRefreshSectorIgnoreHitPreview(false, true);
        }
    },

    handleProxyConfigToggle() {
        const proxyEnabled = !!document.getElementById('cfg-data-proxy-enabled')?.checked;
        const proxyInput = document.getElementById('cfg-data-proxy');
        const proxyStrategy = document.getElementById('cfg-data-proxy-strategy');
        if (proxyInput) proxyInput.disabled = !proxyEnabled;
        if (proxyStrategy) proxyStrategy.disabled = !proxyEnabled;
    },

    renderDataSourceHealth(res) {
        const summaryEl = document.getElementById('data-health-summary');
        const resultEl = document.getElementById('data-health-result');
        const applyBtn = document.getElementById('btn-data-apply');
        this.state.lastDataSourceHealth = res || null;
        if (!resultEl) return;

        const fallbackRows = this.getDefaultDataSourceHealthRows();
        const inputRows = Array.isArray(res?.results) ? res.results : [];
        const rowMap = new Map();
        inputRows.forEach((item) => {
            const key = String(item?.source_name || '').trim();
            if (!key) return;
            rowMap.set(key, item);
        });
        const rows = fallbackRows.map((fallback) => {
            const key = String(fallback.source_name || '').trim();
            return rowMap.get(key) || fallback;
        });
        inputRows.forEach((item) => {
            const key = String(item?.source_name || '').trim();
            if (!key) return;
            if (!rows.some((x) => String(x?.source_name || '').trim() === key)) {
                rows.push(item);
            }
        });
        if (summaryEl) {
            const checkedAt = res?.checked_at || '--';
            const overall = res?.status || 'unknown';
            const recommended = res?.recommended_primary_source_display_name || res?.recommended_primary_source || '无';
            const recommendedVerify = res?.recommended_verify_source_display_name || res?.recommended_verify_source || '无';
            const overallText = overall === 'unknown' ? '未检测' : overall;
            const recText = overall === 'unknown' ? '未检测' : recommended;
            const recVerifyText = overall === 'unknown' ? '未检测' : recommendedVerify;
            summaryEl.innerText = `${checkedAt} · 总体: ${overallText} · 推荐主源: ${recText} · 推荐校验源: ${recVerifyText}`;
        }
        if (applyBtn) {
            const rec = (res?.recommended_primary_source || '').toString().trim();
            applyBtn.disabled = !rec;
        }

        resultEl.innerHTML = rows.map((item) => {
            const status = (item.status || 'unknown').toString().toLowerCase();
            const ok = status === 'ok';
            const pending = status === 'unknown' || status === 'unchecked' || status === 'pending';
            const degraded = !!item.degraded;
            const statusClass = ok ? 'health-ok' : (pending ? 'health-pending' : 'health-error');
            const statusText = ok ? (degraded ? 'OK(降级)' : 'OK') : (pending ? '未检测' : 'ERROR');
            const source = this.escapeHTML(item.source_display_name || item.source_name || '未知');
            const metric = ok
                ? `${item.latency_ms || 0}ms · ${item.count || 0}条${degraded && item.note ? ` · ${this.escapeHTML(item.note)}` : ''}`
                : (pending ? '点击“检查数据源连通性”获取实时状态' : this.escapeHTML(item.error || 'unknown error'));
            return `
                <div class="health-item">
                    <span>${source}</span>
                    <span class="${statusClass}">${statusText} · ${metric}</span>
                </div>
            `;
        }).join('');
    },

    async handleCheckDataSources() {
        if (this.state.isLoading) return;
        this.setLoading(true);
        try {
            const res = await API.getDataSourcesHealth();
            this.renderDataSourceHealth(res);
            if (res.status === 'ok') {
                this.showToast('数据源检查完成：全部可用。', 'success');
            } else if (res.status === 'partial') {
                this.showToast('数据源检查完成：部分可用。', 'info');
            } else {
                this.showToast('数据源检查完成：全部异常。', 'error');
            }
        } catch (e) {
            console.error('数据源检查失败:', e);
            this.showToast('数据源检查失败，请查看后端日志。', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleApplyRecommendedSource() {
        if (this.state.isLoading) return;
        this.setLoading(true);
        try {
            const res = await API.applyRecommendedDataSource();
            if (Array.isArray(res.results)) {
                this.renderDataSourceHealth({
                    checked_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
                    status: res.results.some(x => x.status === 'ok')
                        ? (res.results.every(x => x.status === 'ok') ? 'ok' : 'partial')
                        : 'error',
                    recommended_primary_source: res.new_primary_source || '',
                    recommended_primary_source_display_name: res.new_primary_source_display_name || '',
                    recommended_verify_source: res.recommended_verify_source || '',
                    recommended_verify_source_display_name: res.recommended_verify_source_display_name || '',
                    results: res.results,
                });
            }

            const primarySel = document.getElementById('cfg-data-primary');
            const verifySel = document.getElementById('cfg-data-verify');
            if (primarySel && res.new_primary_source) {
                primarySel.value = res.new_primary_source;
            }
            if (verifySel && Object.prototype.hasOwnProperty.call(res, 'new_verify_source')) {
                verifySel.value = res.new_verify_source || '';
            }

            if (res.status === 'ok' && res.applied) {
                this.showToast(`已应用推荐主源：${res.new_primary_source_display_name || res.new_primary_source}`, 'success');
                if (res.verify_source_adjusted) {
                    if (res.new_verify_source) this.showToast(`校验源已自动调整为：${res.new_verify_source_display_name || res.new_verify_source}`, 'info');
                    else this.showToast('校验源已自动关闭（当前无可用校验源）。', 'info');
                }
            } else if (res.status === 'ok') {
                this.showToast('当前主源已是推荐源，无需变更。', 'info');
                if (res.verify_source_adjusted) {
                    if (res.new_verify_source) this.showToast(`校验源已自动调整为：${res.new_verify_source_display_name || res.new_verify_source}`, 'info');
                    else this.showToast('校验源已自动关闭（当前无可用校验源）。', 'info');
                }
            } else {
                this.showToast('暂无可用推荐主源，请稍后重试。', 'error');
            }
        } catch (e) {
            console.error('应用推荐主源失败:', e);
            this.showToast('应用推荐主源失败，请查看后端日志。', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    renderOptimizationSuggestions(list = [], hint = '') {
        const summaryEl = document.getElementById('opt-suggestion-summary');
        const resultEl = document.getElementById('opt-suggestion-result');
        const rows = Array.isArray(list) ? list : [];
        this.state.optimizationSuggestions = rows;
        this.state.lastOptimizationSuggestion = rows.length > 0 ? rows[0] : null;

        if (!resultEl) {
            this.renderPipelineStageProgress();
            this.renderOpsMonitorPanel();
            return;
        }

        if (summaryEl) {
            if (hint) summaryEl.innerText = hint;
            else if (rows.length > 0) {
                const latest = rows[0];
                const runId = String(latest?.run_id || '--');
                const changed = Array.isArray(latest?.changed_keys) ? latest.changed_keys.length : 0;
                summaryEl.innerText = `最近建议 run_id=${runId} · 参数变更 ${changed} 项`;
            } else {
                summaryEl.innerText = '暂无建议记录';
            }
        }

        if (rows.length === 0) {
            resultEl.innerHTML = `
                <div class="health-item">
                    <span>状态</span>
                    <span class="health-pending">暂无建议（先生成或刷新）</span>
                </div>
            `;
            this.renderPipelineStageProgress();
            return;
        }

        resultEl.innerHTML = rows.slice(0, 6).map((item) => {
            const runId = this.escapeHTML(item?.run_id || '--');
            const createdAt = this.escapeHTML(item?.created_at || '--');
            const status = this.escapeHTML(item?.status || 'generated');
            const summary = item?.summary || {};
            const avgAlpha = Number(summary?.avg_alpha || 0).toFixed(2);
            const avgHit = Number(summary?.avg_hit_rate || 0).toFixed(2);
            const avgRandom = Number(summary?.avg_random_hit_rate || 0).toFixed(2);
            const changed = Array.isArray(item?.changed_keys) ? item.changed_keys : [];
            const changedText = changed.length > 0 ? changed.map((k) => this.escapeHTML(k)).join(', ') : '无';
            const reasons = Array.isArray(item?.reasoning) ? item.reasoning : [];
            const reasonHtml = reasons.length > 0
                ? `<div style="margin-top:6px; color: var(--text-dim); font-size:12px;">${this.escapeHTML(reasons[0])}</div>`
                : '';
            return `
                <div class="health-item" style="display:block;">
                    <div style="display:flex; justify-content:space-between; gap:10px;">
                        <span>run_id=${runId}</span>
                        <span class="health-ok">${status} · ${createdAt}</span>
                    </div>
                    <div style="margin-top:4px; color: var(--text-dim); font-size:12px;">
                        Alpha=${avgAlpha}% · 命中=${avgHit}% · 随机基准=${avgRandom}% · 变更字段=${changedText}
                    </div>
                    ${reasonHtml}
                </div>
            `;
        }).join('');
        this.renderPipelineStageProgress();
    },

    async loadOptimizationSuggestions(runId = '') {
        const runInput = document.getElementById('cfg-opt-run-id');
        const inferredRunId = String(
            runId || runInput?.value || this.state.backtestResultRunId || this.state.backtestSelectedRunId || this.state.lastBacktestRunId || ''
        ).trim();
        try {
            const rows = await API.getOptimizationSuggestions(10, inferredRunId);
            this.renderOptimizationSuggestions(rows || [], inferredRunId ? `当前筛选 run_id=${inferredRunId}` : '');
            if (runInput && !runInput.value && inferredRunId) runInput.value = inferredRunId;
        } catch (e) {
            console.error('加载参数优化建议失败:', e);
            this.renderOptimizationSuggestions([], '建议列表加载失败');
        }
    },

    async handleGenerateOptimizationSuggestion() {
        if (this.state.isLoading) return;
        const runInput = document.getElementById('cfg-opt-run-id');
        const requestedRunId = String(runInput?.value || '').trim();
        this.setLoading(true);
        try {
            const res = await API.generateOptimizationSuggestion(requestedRunId);
            const suggestion = res?.suggestion || null;
            const resolvedRunId = String(suggestion?.run_id || requestedRunId || '').trim();
            if (runInput && resolvedRunId) runInput.value = resolvedRunId;
            await this.loadOptimizationSuggestions(resolvedRunId);
            if (resolvedRunId) {
                this.showToast(`参数建议已生成（run_id=${resolvedRunId}）`, 'success');
            } else {
                this.showToast('参数建议已生成。', 'success');
            }
        } catch (e) {
            console.error('生成参数优化建议失败:', e);
            this.showToast(`生成参数建议失败：${e.message || '请查看后端日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async buildAlgoSnapshotFromView() {
        const cfg = await API.getConfig().catch(() => ({ algo: {} }));
        const base = { ...(cfg?.algo || {}) };
        base.deviation_mode = document.getElementById('cfg-algo-mode')?.value || base.deviation_mode || 'positive_only';
        base.time_decay_days = document.getElementById('cfg-algo-decay')?.value || base.time_decay_days || '30';
        base.quality_max_failed_rows = document.getElementById('cfg-quality-max-failed-rows')?.value || base.quality_max_failed_rows || '25';
        base.quality_min_total_rows = document.getElementById('cfg-quality-min-total-rows')?.value || base.quality_min_total_rows || '180';
        base.quality_stale_minutes = document.getElementById('cfg-quality-stale-minutes')?.value || base.quality_stale_minutes || '240';
        base.quality_require_freshness_for_publish = document.getElementById('cfg-quality-require-freshness')?.checked ? '1' : '0';
        base.quality_required_fields = (document.getElementById('cfg-quality-required-fields')?.value || '').trim()
            || base.quality_required_fields
            || 'name,category_type,daily_change,net_amount,turnover,lead_stock_change';
        base.quality_daily_change_abs_max = document.getElementById('cfg-quality-daily-change-max')?.value || base.quality_daily_change_abs_max || '20';
        base.quality_lead_stock_change_abs_max = document.getElementById('cfg-quality-lead-stock-change-max')?.value || base.quality_lead_stock_change_abs_max || '25';
        base.quality_turnover_abs_max = document.getElementById('cfg-quality-turnover-max')?.value || base.quality_turnover_abs_max || '30';
        base.quality_net_amount_abs_max = document.getElementById('cfg-quality-net-amount-max')?.value || base.quality_net_amount_abs_max || '500';
        return base;
    },

    renderConfigVersions(versions = [], versionStatus = null, hint = '') {
        const summaryEl = document.getElementById('cfg-version-summary');
        const resultEl = document.getElementById('cfg-version-result');
        this.state.configVersions = Array.isArray(versions) ? versions : [];
        this.state.configVersionStatus = versionStatus || null;

        if (summaryEl) {
            if (hint) {
                summaryEl.innerText = hint;
            } else {
                const current = versionStatus?.current_version || null;
                const latestApplied = versionStatus?.latest_applied_version || null;
                if (current) {
                    const runId = String(current?.source_run_id || '').trim();
                    const runHint = runId ? ` · 来源 run_id=${runId}` : '';
                    const stateHint = String(current?.status || '').trim().toLowerCase() === 'refeeded'
                        ? ' · 已回灌评分'
                        : '';
                    summaryEl.innerText = `当前参数版本 V${current.id}${runHint}${stateHint}`;
                } else if (latestApplied) {
                    summaryEl.innerText = `当前参数未匹配版本快照 · 最近应用 V${latestApplied.id}`;
                } else {
                    summaryEl.innerText = '当前参数版本：未建立';
                }
            }
        }

        if (!resultEl) {
            this.renderPipelineStageProgress();
            return;
        }

        if (this.state.configVersions.length === 0) {
            resultEl.innerHTML = `
                <div class="health-item">
                    <span>版本列表</span>
                    <span class="health-pending">暂无版本记录（先保存当前参数版本）</span>
                </div>
            `;
            this.renderPipelineStageProgress();
            this.renderOpsMonitorPanel();
            return;
        }

        resultEl.innerHTML = this.state.configVersions.slice(0, 8).map((item) => {
            const id = Number(item?.id || 0);
            const status = this.escapeHTML(item?.status || 'saved');
            const sourceType = this.escapeHTML(item?.source_type || 'manual');
            const runId = this.escapeHTML(item?.source_run_id || '--');
            const createdAt = this.escapeHTML(item?.created_at || '--');
            const appliedAt = this.escapeHTML(item?.applied_at || '--');
            const changedKeys = Array.isArray(item?.changed_keys) ? item.changed_keys : [];
            const changedText = changedKeys.length > 0
                ? changedKeys.map((x) => this.escapeHTML(String(x))).join(', ')
                : '无';
            const canApply = id > 0;
            return `
                <div class="health-item" style="display:block;">
                    <div style="display:flex; justify-content:space-between; gap:10px;">
                        <span>V${id} · ${sourceType} · run_id=${runId}</span>
                        <span class="health-ok">${status} · 保存 ${createdAt}</span>
                    </div>
                    <div style="margin-top:4px; color: var(--text-dim); font-size:12px;">
                        变更字段=${changedText} · 应用时间=${appliedAt}
                    </div>
                    <div style="margin-top:8px; display:flex; gap:8px;">
                        <button class="toolbar-btn" ${canApply ? '' : 'disabled'} onclick="App.handleApplyConfigVersion(${id})">应用此版本</button>
                        <button class="toolbar-btn" ${canApply ? '' : 'disabled'} onclick="App.handleApplyConfigVersionWithRefeed(${id})">应用并回灌评分</button>
                    </div>
                </div>
            `;
        }).join('');
        this.renderPipelineStageProgress();
        this.renderOpsMonitorPanel();
    },

    async loadConfigVersions() {
        try {
            const [versions, status] = await Promise.all([
                API.getConfigVersions(20),
                API.getConfigVersioningStatus(),
            ]);
            this.renderConfigVersions(versions || [], status || null);
        } catch (e) {
            console.error('加载配置版本失败:', e);
            this.renderConfigVersions([], null, '配置版本加载失败');
        }
    },

    async handleSaveCurrentAlgoVersion() {
        if (this.state.isLoading) return;
        this.setLoading(true);
        try {
            const snapshot = await this.buildAlgoSnapshotFromView();
            const res = await API.saveConfigVersion({
                snapshot,
                source_type: 'manual',
                reason: 'manual_save_current_algo',
                apply_now: true,
            });
            const versionId = Number(res?.version?.id || 0);
            await this.loadSettingsIntoView();
            if (versionId > 0) this.showToast(`算法参数版本已保存并应用：V${versionId}`, 'success');
            else this.showToast('算法参数版本已保存并应用。', 'success');
        } catch (e) {
            console.error('保存算法参数版本失败:', e);
            this.showToast(`保存算法参数版本失败：${e.message || '请查看后端日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleSaveAndApplyLatestSuggestion() {
        if (this.state.isLoading) return;
        const latest = this.state.lastOptimizationSuggestion || (this.state.optimizationSuggestions || [])[0] || null;
        if (!latest) {
            this.showToast('暂无可应用的参数建议，请先生成建议。', 'info');
            return;
        }
        const snapshot = latest?.suggested_params;
        if (!snapshot || typeof snapshot !== 'object') {
            this.showToast('建议参数快照无效，无法应用。', 'error');
            return;
        }

        this.setLoading(true);
        try {
            const res = await API.saveConfigVersion({
                snapshot,
                source_type: 'suggestion',
                source_run_id: String(latest?.run_id || '').trim(),
                source_suggestion_id: Number(latest?.id || 0),
                reason: 'apply_latest_optimization_suggestion',
                apply_now: true,
            });
            const versionId = Number(res?.version?.id || 0);
            await this.loadSettingsIntoView();
            if (versionId > 0) this.showToast(`建议已版本化并应用：V${versionId}`, 'success');
            else this.showToast('建议已版本化并应用。', 'success');
        } catch (e) {
            console.error('应用参数建议失败:', e);
            this.showToast(`应用参数建议失败：${e.message || '请查看后端日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleApplyConfigVersion(versionId) {
        const vid = Number(versionId || 0);
        if (vid <= 0) return;
        if (!confirm(`确认应用参数版本 V${vid} 吗？`)) return;
        if (this.state.isLoading) return;

        this.setLoading(true);
        try {
            const res = await API.applyConfigVersion(vid, 'manual_apply_existing_version');
            const changed = Array.isArray(res?.applied_changed_keys) ? res.applied_changed_keys.length : 0;
            await this.loadSettingsIntoView();
            this.showToast(`版本 V${vid} 已应用（变更 ${changed} 项）`, 'success');
        } catch (e) {
            console.error('应用参数版本失败:', e);
            this.showToast(`应用参数版本失败：${e.message || '请查看后端日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleApplyConfigVersionWithRefeed(versionId) {
        const vid = Number(versionId || 0);
        if (vid <= 0) return;
        if (!confirm(`确认应用参数版本 V${vid} 并回灌评分吗？`)) return;
        if (this.state.isLoading) return;

        const daysInput = Number(document.getElementById('backtest-days')?.value || 60);
        const backtestDays = Number.isFinite(daysInput) && daysInput > 0 ? Math.round(daysInput) : 60;
        const runBacktest = confirm(`是否同时启动 ${backtestDays} 日回测？\n确定：评分+回测；取消：仅回灌评分`);

        this.setLoading(true);
        try {
            const res = await API.applyConfigVersion(vid, {
                reason: 'manual_apply_and_refeed',
                run_scoring: true,
                run_backtest: runBacktest,
                backtest_days: backtestDays,
            });

            const scoring = res?.scoring || null;
            if (scoring?.status === 'ok') {
                this.showToast(`版本 V${vid} 已回灌评分（run_id=${scoring.run_id || '--'}）`, 'success');
            } else if (scoring?.status === 'blocked') {
                this.showToast('版本已应用，但质量门控阻止了回灌评分。', 'error');
            } else {
                this.showToast(`版本 V${vid} 已应用（未触发评分）`, 'info');
            }

            const bt = res?.backtest || null;
            if (bt?.run_id) {
                this.state.lastBacktestRunId = String(bt.run_id || '').trim();
                this.showToast(`已启动回测任务：${bt.run_id}`, 'info');
                await this.loadBacktestJobs(true);
            }

            await this.loadSettingsIntoView();
            await this.loadRanking();
            await this.loadMaintenanceInspectionStatus(true);
            this.renderPipelineStageProgress();
        } catch (e) {
            console.error('应用并回灌失败:', e);
            this.showToast(`应用并回灌失败：${e.message || '请查看后端日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async loadManageData() {
        if (this.state.currentManageSubtab === 'sectors') await this.loadSectors();
        else if (this.state.currentManageSubtab === 'relations') await this.loadRelations();
        else if (this.state.currentManageSubtab === 'logics') await this.loadLogics();
    },

    filterSectors() {
        this.loadSectors();
    },

    filterRelations() {
        this.loadRelations();
    },

    normalizeCategoryType(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const lower = raw.toLowerCase();
        if (lower === 'industry' || raw === '行业') return '行业';
        if (lower === 'concept' || raw === '概念') return '概念';
        return raw;
    },

    async ensureSectorIgnoreKeywordsLoaded(force = false) {
        if (this.state.sectorIgnoreKeywordsLoaded && !force) return;
        try {
            const cfg = await API.getConfig();
            const raw = cfg?.data?.sector_ignore_keywords || '';
            this.setSectorIgnoreKeywords(raw);
            this.state.sectorIgnoreKeywordsLoaded = true;
            const textarea = document.getElementById('cfg-data-ignore-list');
            if (textarea && textarea.value !== raw) textarea.value = raw;
        } catch (e) {
            console.error('加载忽略名单失败:', e);
        }
    },

    async setSectorManageView(view) {
        const next = String(view || '').toLowerCase() === 'ignored' ? 'ignored' : 'sectors';
        this.state.currentSectorManageView = next;
        this.updateSectorManageViewButtons();
        await this.ensureSectorIgnoreKeywordsLoaded();
        if (!Array.isArray(this.state.sectorsData) || this.state.sectorsData.length === 0) {
            await this.loadSectors();
            return;
        }
        this.renderCurrentSectorManageView();
    },

    updateSectorManageViewButtons() {
        const view = this.state.currentSectorManageView || 'sectors';
        const btnSectors = document.getElementById('btn-sector-view-sectors');
        const btnIgnored = document.getElementById('btn-sector-view-ignored');
        if (btnSectors) btnSectors.classList.toggle('active', view === 'sectors');
        if (btnIgnored) btnIgnored.classList.toggle('active', view === 'ignored');
        if (btnIgnored) {
            const rows = Array.isArray(this.state.sectorsData) ? this.state.sectorsData : [];
            const ignoredCount = rows.filter((item) => this.isIgnoredSector(item)).length;
            btnIgnored.innerText = ignoredCount > 0 ? `忽略板块 (${ignoredCount})` : '忽略板块';
        }
    },

    renderCurrentSectorManageView() {
        this.updateSectorManageViewButtons();
        this.renderSectorBatchSelectionSummary();
        if ((this.state.currentSectorManageView || 'sectors') === 'ignored') {
            this.renderIgnoredSectorsTable();
            return;
        }
        this.renderSectorsTable();
    },

    getSelectedSectorIds() {
        return Array.from(new Set(
            (Array.isArray(this.state.selectedSectorIds) ? this.state.selectedSectorIds : [])
                .map((x) => Number(x))
                .filter((x) => Number.isFinite(x) && x > 0)
        ));
    },

    isSectorSelected(sectorId) {
        const sid = Number(sectorId);
        if (!Number.isFinite(sid) || sid <= 0) return false;
        return this.getSelectedSectorIds().includes(sid);
    },

    getVisibleSectorRowsForSelection() {
        return (this.state.currentSectorManageView || 'sectors') === 'ignored'
            ? this.getIgnoredSectorsRows()
            : this.getDisplaySectorsRows();
    },

    getSelectedSectorsFromData() {
        const ids = new Set(this.getSelectedSectorIds());
        const rows = Array.isArray(this.state.sectorsData) ? this.state.sectorsData : [];
        return rows.filter((item) => ids.has(Number(item?.id || 0)));
    },

    setSelectedSectorIds(ids) {
        this.state.selectedSectorIds = Array.from(new Set(
            (Array.isArray(ids) ? ids : [])
                .map((x) => Number(x))
                .filter((x) => Number.isFinite(x) && x > 0)
        ));
        this.renderSectorBatchSelectionSummary();
    },

    renderSectorBatchSelectionSummary() {
        const el = document.getElementById('sector-batch-selected');
        if (!el) return;
        const count = this.getSelectedSectorIds().length;
        el.innerText = `已选 ${count}`;
    },

    toggleSectorSelection(sectorId, checked = null) {
        const sid = Number(sectorId);
        if (!Number.isFinite(sid) || sid <= 0) return;
        const current = new Set(this.getSelectedSectorIds());
        const shouldSelect = checked === null ? !current.has(sid) : !!checked;
        if (shouldSelect) current.add(sid);
        else current.delete(sid);
        this.setSelectedSectorIds(Array.from(current));
        this.renderCurrentSectorManageView();
    },

    toggleSelectAllVisible(checked) {
        const shouldSelect = !!checked;
        const visibleIds = this.getVisibleSectorRowsForSelection()
            .map((item) => Number(item?.id || 0))
            .filter((id) => Number.isFinite(id) && id > 0);
        const current = new Set(this.getSelectedSectorIds());
        visibleIds.forEach((id) => {
            if (shouldSelect) current.add(id);
            else current.delete(id);
        });
        this.setSelectedSectorIds(Array.from(current));
        this.renderCurrentSectorManageView();
    },

    clearSectorSelection(silent = false) {
        this.setSelectedSectorIds([]);
        if (this.state.currentPage === 'manage-sectors') this.renderCurrentSectorManageView();
        if (!silent) this.showToast('已清空选择。', 'info');
    },

    getMatchedIgnoreKeywords(item) {
        const keywords = Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [];
        if (!keywords.length) return [];
        const name = String(item?.name || '').toLowerCase();
        const apiId = String(item?.api_id || '').toLowerCase();
        return keywords.filter((keyword) => {
            const needle = String(keyword || '').trim().toLowerCase();
            if (!needle) return false;
            return name.includes(needle) || apiId.includes(needle);
        });
    },

    getIgnoredSectorsRows() {
        const rows = Array.isArray(this.state.sectorsData) ? this.state.sectorsData : [];
        return rows
            .filter((item) => this.isIgnoredSector(item))
            .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0));
    },

    renderIgnoredSectorsTable() {
        const wrap = document.getElementById('sectors-table-wrap');
        if (!wrap) return;
        const rows = this.getIgnoredSectorsRows();
        if (rows.length === 0) {
            wrap.innerHTML = `<div class="empty-state"><div class="icon">🧾</div><p>当前筛选范围内没有忽略板块</p></div>`;
            return;
        }
        const visibleIds = rows.map((item) => Number(item?.id || 0)).filter((x) => Number.isFinite(x) && x > 0);
        const selectedSet = new Set(this.getSelectedSectorIds());
        const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
        const body = rows.map((item) => {
            const typeText = this.escapeHTML(this.normalizeCategoryType(item?.category_type) || '-');
            const nameText = this.escapeHTML(String(item?.name || ''));
            const codeText = this.escapeHTML(String(item?.api_id || '-'));
            const hits = this.getMatchedIgnoreKeywords(item);
            const hitText = hits.length > 0 ? hits.map((x) => this.escapeHTML(x)).join(' / ') : '--';
            const sid = Number(item?.id || 0);
            const checked = selectedSet.has(sid) ? 'checked' : '';
            return `<tr>
                <td><input type="checkbox" ${checked} onchange="App.toggleSectorSelection(${sid}, this.checked)"></td>
                <td>${sid}</td>
                <td>${nameText}</td>
                <td>${codeText}</td>
                <td>${typeText}</td>
                <td>${hitText}</td>
                <td>
                    <div class="row-actions">
                        <button class="toolbar-btn mini" type="button" onclick="App.handleSectorRowUnignore(${sid})">移出忽略</button>
                        <button class="toolbar-btn mini" type="button" onclick="App.toggleSectorActive(${sid}, ${item?.is_active ? 'true' : 'false'})">${item?.is_active ? '隐藏' : '显示'}</button>
                        <button class="toolbar-btn mini alert" type="button" onclick="App.handleSectorRowDelete(${sid})">删除</button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        wrap.innerHTML = `<div class="ignored-table-hint">以下板块已入库，但在“板块列表”中被忽略隐藏。</div>
            <div class="sector-table-scroll"><table class="manage-table ignored-sector-table"><thead><tr>
                <th><input type="checkbox" ${allChecked ? 'checked' : ''} onchange="App.toggleSelectAllVisible(this.checked)"></th>
                <th>编号</th><th>板块名称</th><th>代号</th><th>类型</th><th>命中关键词</th><th>操作</th>
            </tr></thead><tbody>${body}</tbody></table></div>`;
    },

    parseSectorIgnoreKeywords(raw) {
        return Array.from(new Set(
            String(raw || '')
                .split(/[\n,;，；]+/g)
                .map((item) => item.trim())
                .filter(Boolean)
        ));
    },

    setSectorIgnoreKeywords(raw) {
        const list = this.parseSectorIgnoreKeywords(raw);
        this.state.sectorIgnoreKeywords = list;
        return list;
    },

    syncSectorIgnoreKeywordsFromInput() {
        const raw = document.getElementById('cfg-data-ignore-list')?.value || '';
        this.setSectorIgnoreKeywords(raw);
        this.renderSectorIgnoreKeywordPreview();
        if (this.state.currentPage === 'manage-sectors') this.renderCurrentSectorManageView();
    },

    getSectorIgnoreHitMap(sourceRows = null) {
        const keywords = Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [];
        const rows = Array.isArray(sourceRows)
            ? sourceRows
            : (Array.isArray(this.state.sectorsAllData) && this.state.sectorsAllData.length
                ? this.state.sectorsAllData
                : (Array.isArray(this.state.sectorsData) ? this.state.sectorsData : []));

        const hitMap = new Map();
        const matchedSectorIds = new Set();
        keywords.forEach((keyword) => {
            const needle = String(keyword || '').trim().toLowerCase();
            if (!needle) {
                hitMap.set(keyword, 0);
                return;
            }
            let hitCount = 0;
            rows.forEach((item) => {
                const name = String(item?.name || '').toLowerCase();
                const apiId = String(item?.api_id || '').toLowerCase();
                if (name.includes(needle) || apiId.includes(needle)) {
                    hitCount += 1;
                    matchedSectorIds.add(String(item?.id ?? `${item?.name || ''}:${item?.api_id || ''}`));
                }
            });
            hitMap.set(keyword, hitCount);
        });
        return {
            hitMap,
            uniqueMatchedCount: matchedSectorIds.size,
            sourceCount: rows.length,
        };
    },

    renderSectorIgnoreKeywordPreview() {
        const summaryEl = document.getElementById('cfg-data-ignore-hit-preview');
        const listEl = document.getElementById('cfg-data-ignore-list-preview');
        if (!summaryEl || !listEl) return;

        const keywords = Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [];
        if (!keywords.length) {
            summaryEl.innerText = '当前无忽略关键词。';
            summaryEl.title = '';
            listEl.innerHTML = '';
            return;
        }

        const { hitMap, uniqueMatchedCount, sourceCount } = this.getSectorIgnoreHitMap();
        summaryEl.innerText = `关键词 ${keywords.length} 个，命中板块 ${uniqueMatchedCount} 条（入库但不在板块管理展示）`;
        summaryEl.title = sourceCount > 0 ? `命中统计样本：${sourceCount} 条` : '命中统计样本为空';
        listEl.innerHTML = keywords.map((keyword) => {
            const hit = Number(hitMap.get(keyword) || 0);
            const arg = JSON.stringify(keyword);
            return (
                `<span class="ignore-list-chip">` +
                `<span class="kw">${this.escapeHTML(keyword)}</span>` +
                `<span class="hit">命中 ${hit}</span>` +
                `<button class="remove" type="button" title="移除该关键词" onclick='App.handleRemoveSectorIgnoreKeyword(${arg})'>×</button>` +
                `</span>`
            );
        }).join('');
    },

    handleRemoveSectorIgnoreKeyword(keyword) {
        const needle = String(keyword || '').trim();
        if (!needle) return;
        const next = (Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [])
            .filter((item) => String(item || '').trim() !== needle);
        const textarea = document.getElementById('cfg-data-ignore-list');
        if (textarea) textarea.value = next.join('\n');
        this.setSectorIgnoreKeywords(next.join('\n'));
        this.renderSectorIgnoreKeywordPreview();
        if (this.state.currentPage === 'manage-sectors') this.renderCurrentSectorManageView();
    },

    handleClearSectorIgnoreKeywords() {
        if (!confirm('确认清空板块忽略名单吗？')) return;
        const textarea = document.getElementById('cfg-data-ignore-list');
        if (textarea) textarea.value = '';
        this.setSectorIgnoreKeywords('');
        this.renderSectorIgnoreKeywordPreview();
        if (this.state.currentPage === 'manage-sectors') this.renderCurrentSectorManageView();
    },

    handleImportSectorIgnoreKeywords() {
        const input = window.prompt('请粘贴要导入的忽略关键词（支持逗号/分号/换行分隔）', '');
        if (input === null) return;
        const imported = this.parseSectorIgnoreKeywords(input);
        if (!imported.length) {
            this.showToast('未识别到可导入关键词。', 'info');
            return;
        }
        const current = Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [];
        const merged = Array.from(new Set([...current, ...imported]));
        const textarea = document.getElementById('cfg-data-ignore-list');
        if (textarea) textarea.value = merged.join('\n');
        this.setSectorIgnoreKeywords(merged.join('\n'));
        this.renderSectorIgnoreKeywordPreview();
        if (this.state.currentPage === 'manage-sectors') this.renderCurrentSectorManageView();
        this.showToast(`已导入 ${imported.length} 个关键词。`, 'success');
    },

    async handleExportSectorIgnoreKeywords() {
        const keywords = Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [];
        if (!keywords.length) {
            this.showToast('忽略名单为空，无需导出。', 'info');
            return;
        }
        const text = keywords.join('\n');
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                this.showToast(`已复制 ${keywords.length} 个关键词到剪贴板。`, 'success');
                return;
            }
        } catch (_) {
            // fallback to prompt below
        }
        window.prompt('请复制以下忽略名单内容：', text);
    },

    async handleRefreshSectorIgnoreHitPreview(force = true, silent = false) {
        try {
            const hasCached = Array.isArray(this.state.sectorsAllData) && this.state.sectorsAllData.length > 0;
            if (force || !hasCached) {
                const allRows = await API.getSectors({ exclude_ignored: false });
                this.state.sectorsAllData = Array.isArray(allRows) ? allRows : [];
            }
            this.renderSectorIgnoreKeywordPreview();
            if (this.state.currentPage === 'manage-sectors') this.renderCurrentSectorManageView();
        } catch (e) {
            console.error('刷新忽略名单命中预览失败', e);
            if (!silent) this.showToast('刷新忽略名单命中预览失败，请检查后端日志。', 'error');
        }
    },

    isIgnoredSector(item) {
        const keywords = Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [];
        if (!keywords.length) return false;
        const name = String(item?.name || '').toLowerCase();
        const apiId = String(item?.api_id || '').toLowerCase();
        return keywords.some((keyword) => {
            const needle = String(keyword || '').toLowerCase();
            if (!needle) return false;
            return name.includes(needle) || apiId.includes(needle);
        });
    },

    buildIgnoreKeywordsFromSectors(rows) {
        return Array.from(new Set(
            (Array.isArray(rows) ? rows : []).map((item) => {
                const apiId = String(item?.api_id || '').trim();
                if (apiId) return apiId;
                return String(item?.name || '').trim();
            }).filter(Boolean)
        ));
    },

    async persistSectorIgnoreKeywords(nextKeywords, options = {}) {
        const { showToast = true, toastMessage = '' } = options;
        const keywords = Array.from(new Set((Array.isArray(nextKeywords) ? nextKeywords : [])
            .map((x) => String(x || '').trim())
            .filter(Boolean)));
        const raw = keywords.join('\n');
        await API.saveConfig({ data: { sector_ignore_keywords: raw } });
        this.setSectorIgnoreKeywords(raw);
        this.state.sectorIgnoreKeywordsLoaded = true;
        const textarea = document.getElementById('cfg-data-ignore-list');
        if (textarea) textarea.value = raw;
        await this.handleRefreshSectorIgnoreHitPreview(true, true);
        if (showToast) {
            this.showToast(toastMessage || `忽略名单已更新（${keywords.length} 条）。`, 'success');
        }
    },

    async addSectorsToIgnore(rows) {
        const candidates = this.buildIgnoreKeywordsFromSectors(rows);
        if (!candidates.length) {
            this.showToast('未找到可加入忽略名单的板块。', 'info');
            return;
        }
        const current = Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [];
        const merged = Array.from(new Set([...current, ...candidates]));
        await this.persistSectorIgnoreKeywords(merged, {
            showToast: true,
            toastMessage: `已加入忽略名单 ${candidates.length} 条（当前 ${merged.length} 条）。`,
        });
        await this.loadSectors();
    },

    async removeSectorsFromIgnore(rows) {
        const candidates = this.buildIgnoreKeywordsFromSectors(rows);
        if (!candidates.length) {
            this.showToast('未找到可移出忽略名单的板块。', 'info');
            return;
        }
        const removeSet = new Set(candidates.map((x) => String(x || '').trim()));
        const current = Array.isArray(this.state.sectorIgnoreKeywords) ? this.state.sectorIgnoreKeywords : [];
        const next = current.filter((kw) => !removeSet.has(String(kw || '').trim()));
        await this.persistSectorIgnoreKeywords(next, {
            showToast: true,
            toastMessage: `已移出忽略名单 ${candidates.length} 条（当前 ${next.length} 条）。`,
        });
        await this.loadSectors();
    },

    async applyBatchSectorUpdate(patch, label) {
        const selected = this.getSelectedSectorsFromData();
        if (!selected.length) {
            this.showToast('请先选择至少一个板块。', 'info');
            return;
        }
        const ids = selected.map((item) => Number(item?.id || 0)).filter((x) => Number.isFinite(x) && x > 0);
        this.setLoading(true);
        try {
            await Promise.all(ids.map((id) => API.updateSector(id, patch)));
            this.showToast(`${label}完成：${ids.length} 条。`, 'success');
            this.clearSectorSelection(true);
            await this.loadSectors();
        } catch (e) {
            console.error(`${label}失败:`, e);
            this.showToast(`${label}失败：${e.message || '请查看后端日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleSectorBatchIgnore() {
        const selected = this.getSelectedSectorsFromData();
        if (!selected.length) {
            this.showToast('请先选择至少一个板块。', 'info');
            return;
        }
        await this.addSectorsToIgnore(selected);
        this.clearSectorSelection(true);
    },

    async handleSectorBatchUnignore() {
        const selected = this.getSelectedSectorsFromData();
        if (!selected.length) {
            this.showToast('请先选择至少一个板块。', 'info');
            return;
        }
        await this.removeSectorsFromIgnore(selected);
        this.clearSectorSelection(true);
    },

    async handleSectorBatchHide() {
        await this.applyBatchSectorUpdate({ is_active: false }, '批量隐藏');
    },

    async handleSectorBatchShow() {
        await this.applyBatchSectorUpdate({ is_active: true }, '批量显示');
    },

    async handleSectorBatchDelete() {
        const selected = this.getSelectedSectorsFromData();
        if (!selected.length) {
            this.showToast('请先选择至少一个板块。', 'info');
            return;
        }
        if (!confirm(`确认删除已选 ${selected.length} 个板块吗？此操作不可恢复。`)) return;
        const ids = selected.map((item) => Number(item?.id || 0)).filter((x) => Number.isFinite(x) && x > 0);
        this.setLoading(true);
        try {
            await Promise.all(ids.map((id) => API.deleteSector(id)));
            this.showToast(`已删除 ${ids.length} 个板块。`, 'success');
            this.clearSectorSelection(true);
            await this.loadSectors();
        } catch (e) {
            console.error('批量删除失败:', e);
            this.showToast(`批量删除失败：${e.message || '请查看后端日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleSectorRowIgnore(sectorId) {
        const sid = Number(sectorId);
        if (!Number.isFinite(sid) || sid <= 0) return;
        const rows = Array.isArray(this.state.sectorsData) ? this.state.sectorsData : [];
        const row = rows.find((item) => Number(item?.id || 0) === sid);
        if (!row) return;
        await this.addSectorsToIgnore([row]);
    },

    async handleSectorRowUnignore(sectorId) {
        const sid = Number(sectorId);
        if (!Number.isFinite(sid) || sid <= 0) return;
        const rows = Array.isArray(this.state.sectorsData) ? this.state.sectorsData : [];
        const row = rows.find((item) => Number(item?.id || 0) === sid);
        if (!row) return;
        await this.removeSectorsFromIgnore([row]);
    },

    async handleSectorRowDelete(sectorId) {
        const sid = Number(sectorId);
        if (!Number.isFinite(sid) || sid <= 0) return;
        const rows = Array.isArray(this.state.sectorsData) ? this.state.sectorsData : [];
        const row = rows.find((item) => Number(item?.id || 0) === sid);
        const name = row?.name || `#${sid}`;
        if (!confirm(`确认删除板块「${name}」吗？此操作不可恢复。`)) return;
        this.setLoading(true);
        try {
            await API.deleteSector(sid);
            this.showToast(`已删除板块：${name}`, 'success');
            const left = this.getSelectedSectorIds().filter((x) => x !== sid);
            this.setSelectedSectorIds(left);
            await this.loadSectors();
        } catch (e) {
            console.error('删除板块失败:', e);
            this.showToast(`删除失败：${e.message || '请查看后端日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    getSectorSortIcon(key) {
        const sort = this.state.sectorTableSort || { key: 'id', order: 'asc' };
        if (sort.key !== key) return '<>';
        return sort.order === 'asc' ? '^' : 'v';
    },

    setSectorSort(key) {
        const sort = this.state.sectorTableSort || { key: 'id', order: 'asc' };
        if (sort.key === key) {
            this.state.sectorTableSort = { key, order: sort.order === 'asc' ? 'desc' : 'asc' };
        } else {
            this.state.sectorTableSort = { key, order: key === 'id' ? 'asc' : 'desc' };
        }
        this.renderSectorsTable();
    },

    getSectorSortValue(item, key) {
        const toNumOrNull = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        switch (key) {
            case 'id': return toNumOrNull(item?.id);
            case 'name': return String(item?.name || '');
            case 'api_id': return String(item?.api_id || '');
            case 'category_type': return String(this.normalizeCategoryType(item?.category_type) || '');
            case 'daily_change': return toNumOrNull(item?.daily_change);
            case 'volume': return toNumOrNull(item?.volume);
            case 'turnover': return toNumOrNull(item?.turnover);
            case 'lead_stock': return String(item?.lead_stock || '');
            case 'net_amount': return toNumOrNull(item?.net_amount);
            case 'deviation': return toNumOrNull(item?.deviation);
            case 'cumulative_deviation': return toNumOrNull(item?.cumulative_deviation);
            case 'latest_score': return toNumOrNull(item?.latest_score);
            case 'quality_status': return String(item?.quality_status || '');
            case 'quality_reason': return String(item?.quality_reason || '');
            case 'latest_date': return String(item?.latest_date || '');
            case 'available_data_level': {
                const lv = String(item?.available_data_level || '').toLowerCase();
                if (lv === 'advanced') return 3;
                if (lv === 'mid') return 2;
                if (lv === 'basic') return 1;
                return 0;
            }
            default: return String(item?.[key] || '');
        }
    },

    getDisplaySectorsRows() {
        const sourceRows = Array.isArray(this.state.sectorsData) ? this.state.sectorsData : [];
        const rows = sourceRows.filter((item) => !this.isIgnoredSector(item));
        const sort = this.state.sectorTableSort || { key: 'id', order: 'asc' };
        rows.sort((a, b) => {
            const av = this.getSectorSortValue(a, sort.key);
            const bv = this.getSectorSortValue(b, sort.key);
            const an = typeof av === 'number';
            const bn = typeof bv === 'number';
            let cmp = 0;

            if (an || bn) {
                if (av === null && bv === null) cmp = 0;
                else if (av === null) cmp = 1;
                else if (bv === null) cmp = -1;
                else cmp = av - bv;
            } else {
                cmp = String(av || '').localeCompare(String(bv || ''), 'zh-CN');
            }

            if (cmp === 0) {
                cmp = Number(a?.id || 0) - Number(b?.id || 0);
            }
            return sort.order === 'asc' ? cmp : -cmp;
        });
        return rows;
    },

    renderSectorDataState(value, options = {}) {
        const {
            showAbnormalWhenFailed = false,
            qualityStatus = '',
            formatter = null,
        } = options;

        if (showAbnormalWhenFailed && String(qualityStatus || '').toLowerCase() === 'failed') {
            return '<span class="sector-data-state abnormal">异常</span>';
        }
        if (value === null || value === undefined) {
            return '<span class="sector-data-state missing">未获取</span>';
        }
        if (typeof value === 'string' && value.trim() === '') {
            return '<span class="sector-data-state empty">空</span>';
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
            return '<span class="sector-data-state abnormal">异常</span>';
        }

        try {
            const output = formatter ? formatter(value) : value;
            if (output === null || output === undefined) {
                return '<span class="sector-data-state missing">未获取</span>';
            }
            const txt = String(output);
            if (!txt.trim()) {
                return '<span class="sector-data-state empty">空</span>';
            }
            return this.escapeHTML(txt);
        } catch (_) {
            return '<span class="sector-data-state abnormal">异常</span>';
        }
    },

    renderSectorsTable() {
        const wrap = document.getElementById('sectors-table-wrap');
        if (!wrap) return;

        const rows = this.getDisplaySectorsRows();
        if (rows.length === 0) {
            wrap.innerHTML = `<div class="empty-state"><div class="icon">📭</div><p>暂无板块数据</p></div>`;
            return;
        }
        const visibleIds = rows.map((item) => Number(item?.id || 0)).filter((x) => Number.isFinite(x) && x > 0);
        const selectedSet = new Set(this.getSelectedSectorIds());
        const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));

        const sortTh = (key, label) =>
            `<th><button class="table-sort-btn" type="button" onclick="App.setSectorSort('${key}')">${label}<span class="sort-icon">${this.getSectorSortIcon(key)}</span></button></th>`;

        const fmtSignedPercent = (v, digits = 2) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return '--';
            return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
        };
        const fmtUnsignedPercent = (v, digits = 2) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return '--';
            return `${n.toFixed(digits)}%`;
        };

        const body = rows.map((s) => {
            const dailyChange = Number(s?.daily_change);
            const dailyChangeClass = Number.isFinite(dailyChange)
                ? (dailyChange > 0 ? 'change-up' : (dailyChange < 0 ? 'change-down' : 'change-flat'))
                : 'change-flat';

            const turnover = Number(s?.turnover);
            const turnoverText = Number.isFinite(turnover) ? fmtUnsignedPercent(turnover, 2) : '--';
            const netAmount = Number(s?.net_amount);
            const netAmountText = Number.isFinite(netAmount) ? netAmount.toFixed(2) : '--';

            const leadStockChange = Number(s?.lead_stock_change);
            const leadStockChangeText = Number.isFinite(leadStockChange)
                ? ` (${leadStockChange > 0 ? '+' : ''}${leadStockChange.toFixed(2)}%)`
                : '';

            const qualityStatusRaw = String(s?.quality_status || '').toLowerCase();
            const qualityStatusText = qualityStatusRaw === 'ok'
                ? '<span class="sector-data-state ok">合格</span>'
                : (qualityStatusRaw === 'failed'
                    ? '<span class="sector-data-state abnormal">异常</span>'
                    : '<span class="sector-data-state missing">未获取</span>');

            const qualityReasonText = qualityStatusRaw === 'failed'
                ? this.renderSectorDataState(s?.quality_reason, { formatter: (v) => String(v || '').trim() || '未知异常' })
                : this.renderSectorDataState(s?.quality_reason, { formatter: (v) => String(v || '').trim() });

            const nameText = this.escapeHTML(s?.name || '');
            const codeText = this.renderSectorDataState(s?.api_id, { formatter: (v) => `代码: ${v}` });
            const typeText = this.escapeHTML(this.normalizeCategoryType(s?.category_type) || '-');
            const levelText = this.escapeHTML(s?.available_data_level_label || '未知');
            const leadStockText = this.renderSectorDataState(s?.lead_stock, {
                formatter: (v) => `${String(v)}${leadStockChangeText}`,
            });
            const sid = Number(s?.id || 0);
            const checked = selectedSet.has(sid) ? 'checked' : '';
            const isIgnored = this.isIgnoredSector(s);

            return `<tr>
                <td><input type="checkbox" ${checked} onchange="App.toggleSectorSelection(${sid}, this.checked)"></td>
                <td>${s.id}</td>
                <td class="sector-name-cell"><div class="sector-name-main">${nameText}</div><div class="sector-name-sub">${codeText}</div></td>
                <td>${typeText}</td>
                <td class="${dailyChangeClass}">${fmtSignedPercent(s?.daily_change, 2)}</td>
                <td>${this.renderSectorDataState(s?.volume, { showAbnormalWhenFailed: true, qualityStatus: qualityStatusRaw, formatter: (v) => `${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}万手` })}</td>
                <td>${turnoverText}</td>
                <td>${leadStockText}</td>
                <td>${this.renderSectorDataState(s?.net_amount, { showAbnormalWhenFailed: true, qualityStatus: qualityStatusRaw, formatter: () => `${netAmountText}亿` })}</td>
                <td>${this.renderSectorDataState(s?.deviation, { showAbnormalWhenFailed: true, qualityStatus: qualityStatusRaw, formatter: (v) => fmtSignedPercent(v, 2) })}</td>
                <td>${this.renderSectorDataState(s?.cumulative_deviation, { showAbnormalWhenFailed: true, qualityStatus: qualityStatusRaw, formatter: (v) => Number(v).toFixed(2) })}</td>
                <td>${this.renderSectorDataState(s?.latest_score, { showAbnormalWhenFailed: true, qualityStatus: qualityStatusRaw, formatter: (v) => Number(v).toFixed(2) })}</td>
                <td><span class="sector-data-level">${levelText}</span></td>
                <td>${qualityStatusText}</td>
                <td class="quality-reason-cell"><div class="quality-reason-text">${qualityReasonText}</div></td>
                <td>${this.renderSectorDataState(s?.latest_date, { formatter: (v) => v })}</td>
                <td>
                    <div class="row-actions">
                        <button class="toolbar-btn mini" type="button" onclick="App.toggleSectorActive(${s.id}, ${s.is_active})">${s.is_active ? '隐藏' : '显示'}</button>
                        <button class="toolbar-btn mini" type="button" onclick="${isIgnored ? `App.handleSectorRowUnignore(${sid})` : `App.handleSectorRowIgnore(${sid})`}">${isIgnored ? '移出忽略' : '加入忽略'}</button>
                        <button class="toolbar-btn mini alert" type="button" onclick="App.handleSectorRowDelete(${sid})">删除</button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        wrap.innerHTML = `<div class="sector-table-scroll"><table class="manage-table sector-manage-table"><thead><tr>
            <th><input type="checkbox" ${allChecked ? 'checked' : ''} onchange="App.toggleSelectAllVisible(this.checked)"></th>
            ${sortTh('id', '编号')}
            ${sortTh('name', '名称/代码')}
            ${sortTh('category_type', '类型')}
            ${sortTh('daily_change', '基础-涨幅')}
            ${sortTh('volume', '基础-交易量')}
            ${sortTh('turnover', '基础-换手率')}
            ${sortTh('lead_stock', '基础-领涨股')}
            ${sortTh('net_amount', '中级-净流入')}
            ${sortTh('deviation', '中级-偏差')}
            ${sortTh('cumulative_deviation', '中级-累计偏差')}
            ${sortTh('latest_score', '高级-评分')}
            ${sortTh('available_data_level', '可用级别')}
            ${sortTh('quality_status', '高级-质量')}
            ${sortTh('quality_reason', '高级-异常识别')}
            ${sortTh('latest_date', '更新日期')}
            <th>操作</th>
        </tr></thead><tbody>${body}</tbody></table></div>`;
    },

    // ============================================================
    // 排行榜逻辑 (Step 9 Upgrade)
    // ============================================================
    filterRanking() {
        if (this.state.rankingFilterDebounceTimer) {
            clearTimeout(this.state.rankingFilterDebounceTimer);
        }
        this.state.rankingFilterDebounceTimer = setTimeout(() => {
            this.loadRanking();
        }, 200);
    },

    toggleFavFilter() {
        this.state.favFilter = !this.state.favFilter;
        this.renderRankingToolbarState();
        this.loadRanking();
    },

    resetRankingFilters() {
        const searchEl = document.getElementById('ranking-search');
        const typeEl = document.getElementById('ranking-type');
        const scoreBandEl = document.getElementById('ranking-score-band');
        const sortEl = document.getElementById('ranking-sort');
        if (searchEl) searchEl.value = '';
        if (typeEl) typeEl.value = '';
        if (scoreBandEl) scoreBandEl.value = '';
        if (sortEl) sortEl.value = 'rank_asc';
        this.state.favFilter = false;
        this.renderRankingToolbarState();
        this.loadRanking();
    },

    getDisplayRankingRows() {
        const rows = Array.isArray(this.state.rankingData) ? [...this.state.rankingData] : [];
        const scoreBand = String(document.getElementById('ranking-score-band')?.value || '').trim();
        const sortBy = String(document.getElementById('ranking-sort')?.value || 'rank_asc').trim();
        const num = (value) => {
            const n = Number(value);
            return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
        };

        let filtered = rows;
        if (scoreBand === 'strong') {
            filtered = filtered.filter((item) => num(item?.score) >= 8);
        } else if (scoreBand === 'watch') {
            filtered = filtered.filter((item) => num(item?.score) >= 5 && num(item?.score) < 8);
        } else if (scoreBand === 'weak') {
            filtered = filtered.filter((item) => num(item?.score) < 5);
        }

        filtered.sort((a, b) => {
            if (sortBy === 'score_desc') {
                return num(b?.score) - num(a?.score) || num(a?.rank) - num(b?.rank);
            }
            if (sortBy === 'daily_change_desc') {
                return num(b?.daily_change) - num(a?.daily_change) || num(a?.rank) - num(b?.rank);
            }
            if (sortBy === 'deviation_desc') {
                return num(b?.deviation) - num(a?.deviation) || num(a?.rank) - num(b?.rank);
            }
            return num(a?.rank) - num(b?.rank);
        });

        return filtered;
    },

    renderRankingToolbarState(rows = null) {
        const favBtn = document.getElementById('ranking-fav-toggle');
        if (favBtn) {
            favBtn.classList.toggle('active', !!this.state.favFilter);
            favBtn.innerText = this.state.favFilter ? '★ 仅关注（已开启）' : '☆ 仅关注';
        }

        const summaryEl = document.getElementById('ranking-filter-summary');
        if (!summaryEl) return;

        const displayRows = Array.isArray(rows) ? rows : this.getDisplayRankingRows();
        const total = displayRows.length;
        let industry = 0;
        let concept = 0;
        displayRows.forEach((item) => {
            const category = this.normalizeCategoryType(item?.category_type);
            if (category === '行业') industry += 1;
            if (category === '概念') concept += 1;
        });
        summaryEl.innerText = `当前结果 ${total} 条 · 行业 ${industry} · 概念 ${concept}`;
    },

    async loadRanking() {
        try {
            const selectedCategory = this.normalizeCategoryType(
                document.getElementById('ranking-type')?.value
            );
            const params = {
                run_type: 'prod',
                category_type: selectedCategory,
                search: document.getElementById('ranking-search').value,
                favorited: this.state.favFilter ? true : null
            };
            const data = await API.getRanking(params);
            this.state.rankingData = data;
            this.renderRanking();
            this.renderRankingToolbarState();
            this.renderPipelineStageProgress();
        } catch (e) {
            console.error('加载排行失败:', e);
            this.renderPipelineStageProgress();
        }
    },

    renderRanking() {
        const container = document.getElementById('ranking-content');
        const displayRows = this.getDisplayRankingRows();
        this.renderRankingToolbarState(displayRows);
        if (displayRows.length === 0) {
            const hasFilters = !!(
                String(document.getElementById('ranking-search')?.value || '').trim()
                || String(document.getElementById('ranking-type')?.value || '').trim()
                || String(document.getElementById('ranking-score-band')?.value || '').trim()
                || !!this.state.favFilter
            );
            const hint = hasFilters ? '当前筛选条件下无结果，可点击“重置筛选”。' : '点击“计算得分”获取预测排行。';
            container.innerHTML = `<div class="empty-state"><div class="icon">📊</div><p>${hint}</p></div>`;
            return;
        }

        let html = `<table class="ranking-table fade-in"><thead><tr>
            <th>#</th><th>☆</th><th>板块名称</th><th>类型</th><th>今日涨幅</th><th>预期涨幅</th><th>今日偏差</th><th class="score-cell">得分</th><th>领涨股</th>
        </tr></thead><tbody>`;

        displayRows.forEach((item, index) => {
            const updownClass = Number(item?.daily_change) >= 0 ? 'change-up' : 'change-down';
            const expClass = Number(item?.expected_change) >= 0 ? 'change-up' : 'change-down';
            const deviationClass = Number(item?.deviation) >= 0 ? 'change-up' : 'change-down';
            const leadStockChange = Number(item?.lead_stock_change);
            const normalizedCategory = this.normalizeCategoryType(item?.category_type);
            const categoryClass = normalizedCategory === '行业' ? 'industry' : (normalizedCategory === '概念' ? 'concept' : '');
            const leadStockChangeText = Number.isFinite(leadStockChange)
                ? `${leadStockChange > 0 ? '+' : ''}${leadStockChange.toFixed(1)}%`
                : '';
            const scoreVal = Number(item?.score || 0);
            html += `
                <tr class="${item.rank <= 3 ? 'rank-top' : ''}" style="cursor: pointer" onclick="App.showSectorDetail(${item.sector_id})">
                    <td class="rank-cell" title="ԭʼ Rank: ${item.rank}">${index + 1}</td>
                    <td onclick="event.stopPropagation(); App.toggleFavorite(${item.sector_id}, ${item.is_favorited})">
                        <span class="fav-star ${item.is_favorited ? 'active' : 'inactive'}">${item.is_favorited ? '★' : '☆'}</span>
                    </td>
                    <td class="name-cell">${item.name}</td>
                    <td><span class="type-badge ${categoryClass}">${normalizedCategory || '-'}</span></td>
                    <td class="${updownClass}">${item.daily_change !== null ? item.daily_change.toFixed(2) + '%' : '-'}</td>
                    <td class="${expClass}">${item.expected_change !== null ? item.expected_change.toFixed(2) + '%' : '-'}</td>
                    <td class="${deviationClass}">${item.deviation !== null ? `${Number(item.deviation) > 0 ? '+' : ''}${item.deviation.toFixed(2)}%` : '-'}</td>
                    <td class="score-cell">${scoreVal.toFixed(2)}</td>
                    <td class="change-up">${item.lead_stock || '-'} <small>${leadStockChangeText}</small></td>
                </tr>
            `;
        });
        container.innerHTML = html + `</tbody></table>`;
    },

    async toggleFavorite(id, current) {
        await API.updateSector(id, { is_favorited: !current });
        // 同步内存数据
        const sector = this.state.sectorsData.find(s => s.id === id);
        if (sector) sector.is_favorited = !current;
        this.loadRanking();
    },

    // ============================================================
    // 板块详情面板 (Step 9 Upgrade - Dual Axis)
    // ============================================================
    async showSectorDetail(id) {
        const modal = document.getElementById('side-detail-panel');
        if (!modal) return;
        modal.classList.add('active');

        const sector = this.state.sectorsData.find(s => s.id === id);
        if (!sector) return;

        this.state.currentDetailId = id;
        document.getElementById('detail-name').innerText = sector.name;
        document.getElementById('detail-sector-type').innerText = sector.category_type || '领域';
        document.getElementById('detail-fav-btn').innerText = sector.is_favorited ? '★' : '☆';

        // 每次打开面板，先隐藏和重置 AI 解释器区域
        document.getElementById('ai-explainer-box').style.display = 'none';

        const rankItem = this.state.rankingData.find(r => r.sector_id === id);
        document.getElementById('detail-sector-score').innerText = `得分: ${rankItem ? rankItem.score.toFixed(2) : '0.0'}`;
        // The original line for detail-sector-fav is replaced by detail-fav-btn above.
        // document.getElementById('detail-sector-fav').innerText = sector.is_favorited ? '★关注' : '☆关注';

        try {
            const history = await API.getSectorDaily(id);
            // 这里我们使用真实能查到的朢新的回测或拉取日期作为目标上下文
            const latestDate = history.length > 0 ? history[0].date : new Date().toISOString().split('T')[0];
            document.getElementById('btn-ai-explain').onclick = () => this.handleExplainScore(id, sector.name, latestDate);

            const sortedHistory = [...history].reverse();
            this.renderTrendChart(sortedHistory);

            const historyList = document.getElementById('detail-history-list');
            historyList.innerHTML = sortedHistory.slice(-5).reverse().map(h => `
                <div class="history-item ${h.daily_change >= 0 ? 'up' : 'down'}">
                    <span>${h.date}</span>
                    <span style="float:right">${h.daily_change > 0 ? '+' : ''}${h.daily_change.toFixed(2)}%</span>
                    <div style="font-size:0.75rem; color:var(--text-dim); margin-top:4px;">
                        预期: ${h.expected_change?.toFixed(2)}% | 偏差: <span style="${h.deviation > 0 ? 'color:var(--accent-red)' : ''}">${h.deviation?.toFixed(2)}%</span>
                    </div>
                </div>
            `).join('');
        } catch (e) { console.error(e); }

        const relations = this.state.relationsData.filter(r => r.source_id === id || r.target_id === id);
        const relSummary = document.getElementById('detail-relation-summary');
        relSummary.innerHTML = relations.slice(0, 8).map(r => {
            const isSource = r.source_id === id;
            const otherId = isSource ? r.target_id : r.source_id;
            const otherName = this.state.sectorsData.find(s => s.id === otherId)?.name || '未知';
            const weightColor = r.weight > 7 ? 'var(--accent-red)' : (r.weight > 4 ? '#f59e0b' : '#888');
            return `
                <div class="summary-item" style="border-right: 3px solid ${weightColor}; cursor:pointer;" onclick="App.showSectorDetail(${otherId})">
                    <div class="summary-info">
                        <span class="direction-hint">${isSource ? '影响 ->' : '受影响 <-'}</span>
                        <span class="target-name">${otherName}</span>
                    </div>
                    <span class="tag">${r.logic_name || r.type} (w:${r.weight})</span>
                </div>
            `;
        }).join('') || '<div class="empty-hint">暂无关联节点</div>';
    },

    renderTrendChart(data) {
        const chartDom = document.getElementById('detail-trend-chart');
        if (this.trendChart) this.trendChart.dispose();
        this.trendChart = echarts.init(chartDom);

        const option = {
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            grid: { top: 30, left: 40, right: 40, bottom: 30 },
            xAxis: {
                type: 'category',
                data: data.map(d => d.date.split('-').slice(1).join('/')),
                axisLabel: { color: '#888', fontSize: 10 }
            },
            yAxis: [
                { type: 'value', name: '得分', nameTextStyle: { color: '#888' }, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: '#333' } } },
                { type: 'value', name: '涨跌%', nameTextStyle: { color: '#888' }, axisLabel: { fontSize: 10 }, splitLine: { show: false } }
            ],
            series: [
                {
                    name: '累计得分', type: 'line', smooth: true, data: data.map(d => d.cumulative_deviation || 0),
                    lineStyle: { color: '#00f3ff', width: 2 }, areaStyle: { color: 'rgba(0, 243, 255, 0.1)' }
                },
                {
                    name: '日涨幅', type: 'bar', yAxisIndex: 1, barWidth: '30%', data: data.map(d => d.daily_change || 0),
                    itemStyle: { color: p => p.value >= 0 ? 'rgba(239, 68, 68, 0.4)' : 'rgba(34, 197, 94, 0.4)' }
                }
            ]
        };
        this.trendChart.setOption(option);
        if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
        this._resizeHandler = () => this.trendChart && this.trendChart.resize();
        window.addEventListener('resize', this._resizeHandler);
    },

    closeSidePanel() {
        document.getElementById('side-detail-panel').classList.remove('active');
        if (this.trendChart) { this.trendChart.dispose(); this.trendChart = null; }
    },

    async toggleDetailFav() {
        if (!this.state.currentDetailId) return;
        const icon = document.getElementById('detail-fav-btn').innerText;
        const currentFav = icon === '★';
        await this.toggleFavorite(this.state.currentDetailId, currentFav);
        document.getElementById('detail-fav-btn').innerText = currentFav ? '☆' : '★';
    },

    // ============================================================
    // AI 逻辑解释 (Step 13)
    // ============================================================
    async handleExplainScore(sectorId, sectorName, targetDate) {
        const btn = document.getElementById('btn-ai-explain');
        const box = document.getElementById('ai-explainer-box');
        const contentDom = document.getElementById('ai-explainer-content');

        box.style.display = 'block';
        contentDom.innerHTML = `<span class="blink">正在调用 AI 引擎进行深度演算，请稍候...</span>`;
        btn.disabled = true;

        try {
            const res = await API.explainSectorScore(sectorId, targetDate);
            if (res.error) {
                contentDom.innerHTML = `⚠️ ${res.error}`;
                return;
            }

            // 打字机流光效果
            const text = res.explanation;
            contentDom.textContent = ''; // 务必使用 textContent 以防止初期的 HTML 标签解析灾难
            let i = 0;
            const typeWriter = setInterval(() => {
                if (i < text.length) {
                    contentDom.textContent += text.charAt(i);
                    i++;
                } else {
                    clearInterval(typeWriter);
                    // 打字结束后高亮其中的数字（此步之前全是纯文本）
                    contentDom.innerHTML = contentDom.textContent.replace(/([0-9.]+%?|-?\d+\.\d+)/g, '<span class="highlight">$1</span>');
                }
            }, 30); // 30ms 每字

        } catch (e) {
            console.error(e);
            contentDom.innerHTML = `❌ 请求解释失败，请检查 AI API 配置与网络。`;
        } finally {
            btn.disabled = false;
        }
    },

    // ============================================================
    // 关系图谱逻辑 (Part 2)
    // ============================================================
    async renderGraph() {
        const container = document.getElementById('graph-container');
        if (!container) return;
        if (!this.state.graphInstance) this.state.graphInstance = echarts.init(container);

        this.state.graphInstance.showLoading();
        try {
            const [sectors, relations] = await Promise.all([API.getSectors(), API.getRelations()]);
            const nodes = sectors.map(s => {
                const rItem = this.state.rankingData.find(r => r.sector_id === s.id);
                const score = rItem ? rItem.score : 0;
                return {
                    id: s.id.toString(), name: s.name, value: score,
                    symbolSize: 15 + Math.sqrt(score) * 20,
                    itemStyle: {
                        color: (rItem?.daily_change > 0) ? '#ef4444' : (rItem?.daily_change < 0 ? '#22c55e' : '#5a5e72'),
                        borderColor: s.is_favorited ? '#f59e0b' : 'transparent', borderWidth: 2
                    },
                    label: { show: score > 5 || s.is_favorited }
                };
            });
            const links = relations.map(r => ({
                source: r.source_id.toString(), target: r.target_id.toString(), value: r.weight,
                lineStyle: { width: Math.abs(r.weight) * 0.5 + 1, color: r.weight > 0 ? '#4a9eff' : '#ef4444', curveness: 0.1 }
            }));

            this.state.graphInstance.setOption({
                tooltip: { trigger: 'item', formatter: (p) => p.dataType === 'node' ? `<b>${p.data.name}</b><br/>得分: ${p.data.value.toFixed(2)}` : '' },
                series: [{ type: 'graph', layout: 'force', data: nodes, links: links, roam: true, label: { position: 'right', color: '#e8e8f0' }, force: { repulsion: 150, edgeLength: 100 } }]
            });
            this.state.graphInstance.off('click');
            this.state.graphInstance.on('click', p => p.dataType === 'node' && this.showSectorDetail(parseInt(p.data.id)));
        } catch (e) { console.error(e); }
        this.state.graphInstance.hideLoading();
    },

    // ============================================================
    // 数据管理 (Sectors, Relations, Logics)
    // ============================================================
    async loadSectors() {
        await this.ensureSectorIgnoreKeywordsLoaded();
        const params = {
            category_type: this.normalizeCategoryType(document.getElementById('sector-type-filter')?.value),
            search: document.getElementById('sector-search')?.value,
            exclude_ignored: false,
        };
        const data = await API.getSectors(params);
        this.state.sectorsData = Array.isArray(data) ? data : [];
        const idSet = new Set(this.state.sectorsData.map((item) => Number(item?.id || 0)).filter((x) => Number.isFinite(x) && x > 0));
        const kept = this.getSelectedSectorIds().filter((id) => idSet.has(id));
        this.setSelectedSectorIds(kept);
        const hasFilter = !!String(params.category_type || '').trim() || !!String(params.search || '').trim();
        if (!hasFilter) {
            this.state.sectorsAllData = [...this.state.sectorsData];
        }
        this.renderCurrentSectorManageView();
        this.renderSectorIgnoreKeywordPreview();
    },

    async toggleSectorActive(id, current) {
        await API.updateSector(id, { is_active: !current });
        await this.loadSectors();
    },

    async loadRelations() {
        const relations = await API.getRelations({ source: document.getElementById('relation-source-filter')?.value });
        this.state.relationsData = relations;
        const wrap = document.getElementById('relations-table-wrap');
        if (!wrap) return;
        wrap.innerHTML = `<table><thead><tr><th>源</th><th>方向</th><th>目标</th><th>权重</th><th>来源</th><th>🔒</th><th>操作</th></tr></thead><tbody>` +
            relations.map(r => `<tr><td>${r.source_name}</td><td>${r.direction}</td><td>${r.target_name}</td><td>${r.weight}</td><td>${r.source}</td>
                <td><input type="checkbox" ${r.is_locked ? 'checked' : ''} onchange="App.toggleRelationLock(${r.id}, ${r.is_locked})"></td>
                <td><button class="label-btn" onclick="App.deleteRelation(${r.id})">删除</button></td></tr>`).join('') + `</tbody></table>`;
    },

    async toggleRelationLock(id, current) {
        await API.updateRelation(id, { is_locked: !current });
        this.loadRelations();
    },

    async deleteRelation(id) {
        if (confirm('确定删除此关联？')) { await API.deleteRelation(id); this.loadRelations(); }
    },

    async loadLogics() {
        const data = await API.getLogics();
        this.state.logicsData = data;
        const wrap = document.getElementById('logics-table-wrap');
        if (!wrap) return;
        wrap.innerHTML = `<table><thead><tr><th>逻辑名称</th><th>大类</th><th>权重</th><th>重要度</th><th>操作</th></tr></thead><tbody>` +
            data.map(l => `<tr><td><b>${l.logic_name}</b></td><td>${l.category}</td><td>${l.default_weight}</td><td>${l.importance}</td>
                <td><button class="label-btn" onclick="App.deleteLogic(${l.id})">删除</button></td></tr>`).join('') + `</tbody></table>`;
    },

    async deleteLogic(id) {
        if (confirm('确定删除该逻辑模板吗？')) { await API.deleteLogic(id); this.loadLogics(); }
    },

    showAddLogic() { document.getElementById('modal-add-logic').classList.add('active'); },

    async submitLogic() {
        const data = {
            logic_name: document.getElementById('logic-name').value,
            category: document.getElementById('logic-category').value,
            default_weight: parseFloat(document.getElementById('logic-weight').value || 5),
            importance: 1.0, description: document.getElementById('logic-desc').value, prompt_template: document.getElementById('logic-prompt').value
        };
        if (!data.logic_name) return alert('名称必填');
        await API.createLogic(data);
        this.closeModal('modal-add-logic');
        this.loadLogics();
    },

    showAddRelation() {
        const options = this.state.sectorsData.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        document.getElementById('rel-source-id').innerHTML = options;
        document.getElementById('rel-target-id').innerHTML = options;
        document.getElementById('modal-add-relation').classList.add('active');
    },

    async submitRelation() {
        const data = {
            source_id: parseInt(document.getElementById('rel-source-id').value),
            target_id: parseInt(document.getElementById('rel-target-id').value),
            type: document.getElementById('rel-type').value,
            weight: parseFloat(document.getElementById('rel-weight').value || 5),
            direction: document.getElementById('rel-direction').value
        };
        if (data.source_id === data.target_id) return alert('源目标不能相同');
        await API.createRelation(data);
        this.closeModal('modal-add-relation');
        this.loadRelations();
    },

    closeModal(id) { document.getElementById(id).classList.remove('active'); },

    // ============================================================
    // 工具栏与 AI 交互
    // ============================================================
    async handleRefresh() {
        if (this.state.isLoading) return;
        this.setLoading(true);
        try {
            const res = await API.refreshSectors();
            const sourceDisplay = res.source_display_name || res.source_name || '未知来源';
            const requestedSourceDisplay = res.requested_source_display_name || res.requested_source_name || sourceDisplay;
            let msg = `同步完成（${sourceDisplay}），共更新 ${res.updated} 个板块的最新行情。`;
            if (res.quality) {
                msg += ` 入库：新增${res.new_sectors || 0}，更新${res.updated || 0}；质量通过 ${res.quality.ok_rows || 0}/${res.quality.total_rows || 0}（失败 ${res.quality.failed_rows || 0}）。`;
            }
            if (res.fallback_used) {
                msg += ` 已自动降级：${requestedSourceDisplay} -> ${sourceDisplay}。`;
            }
            const cmp = res.compare || {};
            if (cmp.status === 'ok') {
                msg += ` 双源比对: 匹配${cmp.matched_count}，警告${cmp.warn_count}，平均差${cmp.mean_abs_diff}%`;
            } else if (cmp.status && cmp.status !== 'disabled') {
                msg += ` 双源比对状态: ${cmp.status}`;
                if (cmp.message) msg += `（${String(cmp.message).slice(0, 80)}${String(cmp.message).length > 80 ? '...' : ''}）`;
            }
            this.showToast(msg, 'success');
            this.state.qualitySelectedDate = '';
            this.state.qualitySampleFilters = {
                reason: '',
                categoryType: '',
                search: '',
                limit: 6,
            };
            await this.loadRanking();
            await this.loadSyncStatus();
            await this.loadDataQualityStatus();
            await this.loadMaintenanceInspectionStatus(true);
        } catch (e) {
            this.showToast('同步失败，请检查网络连接', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleCalculate() {
        if (this.state.isLoading) return;
        this.setLoading(true);
        try {
            const res = await API.runScoring();
            if (res.quality) {
                const q = res.quality;
                this.showToast(`评分完成：${res.calculated}个板块，质量通过 ${q.ok_rows}/${q.total_rows}（失败 ${q.failed_rows}）`, 'success');
                this.updateStatus(`质量: ${q.ok_rows}/${q.total_rows} 通过, 失败 ${q.failed_rows}, 阈值 ${q.max_failed_rows}`);
                this.state.qualitySelectedDate = '';
                this.state.qualitySampleFilters = {
                    reason: '',
                    categoryType: '',
                    search: '',
                    limit: 6,
                };
                this.state.lastQualityLatestSnapshot = q;
                this.state.lastQualityStatus = q;
                this.renderQualityGateStatus(q);
                this.renderQualityDateToolbar(q, this.state.lastQualityTrend);
                this.renderQualityReasonCompare(q);
                this.renderQualityGateTrend(this.state.lastQualityTrend);
                this.renderQualitySampleFilters(q);
                await this.reloadQualityFailedSamples();
            } else {
                this.showToast('算力运行结束，已提取正向偏差板块！', 'success');
            }
            await this.loadRanking();
            await this.loadMaintenanceInspectionStatus(true);
        } catch (e) {
            const quality = e?.payload?.detail?.quality || e?.payload?.quality || null;
            if (quality) {
                this.state.qualitySelectedDate = '';
                this.state.qualitySampleFilters = {
                    reason: '',
                    categoryType: '',
                    search: '',
                    limit: 6,
                };
                this.state.lastQualityLatestSnapshot = quality;
                this.state.lastQualityStatus = quality;
                this.renderQualityGateStatus(quality);
                this.renderQualityDateToolbar(quality, this.state.lastQualityTrend);
                this.renderQualityReasonCompare(quality);
                this.renderQualityGateTrend(this.state.lastQualityTrend);
                this.renderQualitySampleFilters(quality);
                await this.reloadQualityFailedSamples();
            }
            await this.loadMaintenanceInspectionStatus(true);
            this.showToast(`计算评分失败：${e.message || '请查看后台运行日志'}`, 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleAIAnalyze() {
        const size = prompt('ҪAI分析的对数？(1-50)', '10');
        if (!size) return;
        this.setLoading(true);
        try {
            await API.runAIAnalyze(parseInt(size));
            alert('AI分析指令下达，建议稍后再查看反馈。');
            setTimeout(() => this.checkAIPending(), 3000);
        } catch (e) { alert('AI任务启动失败'); }
        this.setLoading(false);
    },

    async checkAIPending() {
        const data = await API.getAIPending();
        if (data && data.length > 0) {
            this.state.aiPendingData = data;
            this.renderAIPending();
            document.getElementById('modal-ai-pending').classList.add('active');
        }
    },

    renderAIPending() {
        const container = document.getElementById('ai-pending-list');
        container.innerHTML = `<table><thead><tr><th>源</th><th>逻辑</th><th>目标</th><th>权重</th><th>理由</th></tr></thead><tbody>` +
            this.state.aiPendingData.map((it, idx) => `<tr>
                <td>${it.source_name}</td>
                <td><input value="${it.logic_name}" onchange="App.state.aiPendingData[${idx}].logic_name=this.value"></td>
                <td>${it.target_name}</td>
                <td><input type="number" value="${it.weight}" onchange="App.state.aiPendingData[${idx}].weight=parseFloat(this.value)"></td>
                <td style="font-size:0.75rem">${it.reason}</td>
            </tr>`).join('') + `</tbody></table>`;
    },

    async confirmAIResults() {
        await API.confirmAIResults(this.state.aiPendingData);
        alert('导入成功');
        this.closeModal('modal-ai-pending');
        this.loadRelations();
    },

    async clearAIPending() {
        if (confirm('确认清空待确认列表吗？')) { await API.clearAIPending(); this.closeModal('modal-ai-pending'); }
    },

    // ============================================================
    // 设置与回?
    // ============================================================
    // 为保持兼容，重定向旧?toggleSettings
    async toggleSettings() {
        await this.switchPage('settings');
    },

    switchSettingsTab(tab) {
        ['ai', 'algo'].forEach(t => document.getElementById(`settings-${t}`).style.display = (t === tab ? 'block' : 'none'));
        ['ai', 'algo'].forEach(t => document.getElementById(`tab-btn-${t}`).classList.toggle('active', t === tab));
    },

    async saveSettings() {
        if (this.state.isLoading) return;

        const primarySource = document.getElementById('cfg-data-primary')?.value || 'sina';
        const dualCompareEnabled = document.getElementById('cfg-data-dual')?.checked;
        const proxyEnabled = document.getElementById('cfg-data-proxy-enabled')?.checked;
        const proxyValue = (document.getElementById('cfg-data-proxy')?.value || '').trim();
        const proxyStrategy = document.getElementById('cfg-data-proxy-strategy')?.value || 'auto';
        let verifySource = document.getElementById('cfg-data-verify')?.value || '';
        if (dualCompareEnabled && (!verifySource || verifySource === primarySource)) {
            const healthRecVerify = (this.state.lastDataSourceHealth?.recommended_verify_source || '').toString().trim();
            const autoVerify = (healthRecVerify && healthRecVerify !== primarySource) ? healthRecVerify : '';
            const verifySelect = document.getElementById('cfg-data-verify');
            if (autoVerify) {
                verifySource = autoVerify;
                if (verifySelect) verifySelect.value = autoVerify;
                this.showToast(`双源比对已自动设置校验源：${autoVerify}`, 'info');
            } else {
                verifySource = '';
                if (verifySelect) verifySelect.value = '';
                this.showToast('当前无可用校验源，已自动关闭校验源。', 'info');
            }
        }
        if (proxyEnabled && proxyStrategy === 'force_proxy' && !proxyValue) {
            this.showToast('force_proxy 模式需要填写代理地址。', 'error');
            return;
        }
        const qualityRequiredFieldsInput = (document.getElementById('cfg-quality-required-fields').value || '').trim();
        const qualityRequiredFields = qualityRequiredFieldsInput || 'name,category_type,daily_change,net_amount,turnover,lead_stock_change';
        const sectorIgnoreRaw = (document.getElementById('cfg-data-ignore-list')?.value || '').trim();
        this.setSectorIgnoreKeywords(sectorIgnoreRaw);
        this.state.sectorIgnoreKeywordsLoaded = true;
        this.renderSectorIgnoreKeywordPreview();

        const data = {
            ai: {
                provider: document.getElementById('cfg-ai-provider').value,
                base_url: document.getElementById('cfg-ai-url').value,
                model: document.getElementById('cfg-ai-model').value
            },
            algo: {
                deviation_mode: document.getElementById('cfg-algo-mode').value,
                time_decay_days: document.getElementById('cfg-algo-decay').value,
                quality_max_failed_rows: document.getElementById('cfg-quality-max-failed-rows').value || '25',
                quality_min_total_rows: document.getElementById('cfg-quality-min-total-rows').value || '180',
                quality_stale_minutes: document.getElementById('cfg-quality-stale-minutes').value || '240',
                quality_require_freshness_for_publish: document.getElementById('cfg-quality-require-freshness')?.checked ? '1' : '0',
                quality_required_fields: qualityRequiredFields,
                quality_daily_change_abs_max: document.getElementById('cfg-quality-daily-change-max').value || '20',
                quality_lead_stock_change_abs_max: document.getElementById('cfg-quality-lead-stock-change-max').value || '25',
                quality_turnover_abs_max: document.getElementById('cfg-quality-turnover-max').value || '30',
                quality_net_amount_abs_max: document.getElementById('cfg-quality-net-amount-max').value || '500'
            },
            data: {
                primary_source: primarySource,
                verify_source: verifySource,
                tushare_token: '',
                dual_compare_enabled: dualCompareEnabled ? '1' : '0',
                compare_warn_threshold_pct: document.getElementById('cfg-data-threshold')?.value || '0.8',
                http_proxy_enabled: proxyEnabled ? '1' : '0',
                http_proxy: proxyValue,
                http_proxy_strategy: proxyStrategy,
                sector_ignore_keywords: sectorIgnoreRaw
            }
        };
        const newTushareToken = (document.getElementById('cfg-data-tushare-token')?.value || '').trim();
        if (newTushareToken) data.data.tushare_token = newTushareToken;
        else delete data.data.tushare_token;
        const newApiKey = document.getElementById('cfg-ai-key').value.trim();
        if (newApiKey) data.ai.api_key = newApiKey;

        this.setLoading(true);
        try {
            await API.saveConfig(data);
            const algoSnapshot = await this.buildAlgoSnapshotFromView();
            await API.saveConfigVersion({
                snapshot: algoSnapshot,
                source_type: 'manual',
                reason: 'save_settings_auto_version',
                apply_now: false,
            });
            this.showToast('⚙️ 配置保存成功，且已生成参数版本记录。', 'success');
            await this.loadSettingsIntoView(); // 刷新当前设置页数?
        } catch (e) {
            console.error(e);
            alert('❌ 保存配置失败，请检查网络或后端日志');
        } finally {
            this.setLoading(false);
        }
    },

    normalizeBacktestJobStatus(status) {
        return String(status || 'unknown').trim().toLowerCase();
    },

    isBacktestJobTerminal(status) {
        const s = this.normalizeBacktestJobStatus(status);
        return s === 'completed' || s === 'failed' || s === 'cancelled';
    },

    getBacktestStatusText(status) {
        const s = this.normalizeBacktestJobStatus(status);
        if (s === 'queued') return '排队中';
        if (s === 'running') return '运行中';
        if (s === 'completed') return '已完成';
        if (s === 'failed') return '已失败';
        if (s === 'cancelled') return '已取消';
        return s || 'unknown';
    },

    syncBacktestJobMeta(job) {
        if (!job) return;
        const runId = String(job.run_id || '').trim();
        if (runId) {
            this.state.lastBacktestRunId = runId;
            this.state.backtestSelectedRunId = runId;
        }
        const currentEl = document.getElementById('backtest-job-current');
        if (currentEl) {
            const statusText = this.getBacktestStatusText(job.status);
            currentEl.innerText = runId
                ? `当前任务：${runId} · ${statusText}`
                : '当前任务：未选择';
        }
        this.renderBacktestResultRunMeta();
    },

    renderBacktestResultRunMeta() {
        const el = document.getElementById('backtest-job-result-run');
        if (!el) return;
        const runId = String(this.state.backtestResultRunId || '').trim();
        if (!runId) {
            el.innerText = '结果视角：最新任务';
            el.title = '';
            return;
        }
        let daysHint = '';
        let snapshotText = String(this.state.backtestResultParamsSnapshot || '{}');
        try {
            const parsed = JSON.parse(snapshotText || '{}');
            if (parsed && parsed.days !== undefined && parsed.days !== null) {
                daysHint = ` · ${parsed.days}天`;
            }
        } catch (_) {
            snapshotText = '{}';
        }
        el.innerText = `结果视角：${runId}${daysHint}`;
        el.title = `run_id=${runId} | params_snapshot=${snapshotText}`;
    },

    resetBacktestConsistencyStatus(runId = '', message = '口径校验：未执行') {
        this.state.backtestConsistency = {
            runId: String(runId || '').trim(),
            status: 'idle',
            checkedAt: '',
            total: 0,
            mismatches: 0,
            message,
        };
        this.renderBacktestConsistencyStatus();
    },

    renderBacktestConsistencyStatus() {
        const el = document.getElementById('backtest-consistency-status');
        if (!el) return;
        const s = this.state.backtestConsistency || {};
        const status = String(s.status || 'idle');
        el.className = `backtest-consistency-status ${status === 'ok' ? 'ok' : status === 'failed' ? 'failed' : 'idle'}`;
        el.innerText = String(s.message || '口径校验：未执行');
        const checkedAt = String(s.checkedAt || '');
        const runId = String(s.runId || '');
        const total = Number(s.total || 0);
        const mismatches = Number(s.mismatches || 0);
        el.title = checkedAt
            ? `run_id=${runId} | checked_at=${checkedAt} | total=${total} | mismatches=${mismatches}`
            : (runId ? `run_id=${runId}` : '');
    },

    renderBacktestJobs() {
        const listEl = document.getElementById('backtest-job-list');
        const pollingEl = document.getElementById('backtest-job-polling');
        if (!listEl) return;

        if (pollingEl) {
            pollingEl.innerText = this.state.backtestPollingEnabled
                ? '自动轮询：开启（3s）'
                : '自动轮询：关闭';
        }

        const jobs = Array.isArray(this.state.backtestJobs) ? this.state.backtestJobs : [];
        if (jobs.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <div class="icon">🧩</div>
                    <p>暂无回测任务，点击“启动回测任务”开始。</p>
                </div>
            `;
            return;
        }

        const rows = jobs.slice(0, 12).map((job) => {
            const runId = String(job?.run_id || '').trim();
            const status = this.normalizeBacktestJobStatus(job?.status || 'unknown');
            const statusText = this.getBacktestStatusText(status);
            const canCancel = status === 'queued' || status === 'running';
            const canRetry = status === 'failed' || status === 'cancelled';
            const canView = status === 'completed' || status === 'cancelled';
            const createdAt = String(job?.created_at || '--');
            const startedAt = String(job?.started_at || '--');
            const endedAt = String(job?.ended_at || '--');
            const errorText = String(job?.error_message || '').trim();
            const runIdLabel = runId.length > 26 ? `${runId.slice(0, 26)}...` : runId;
            const selectedCls = runId && runId === this.state.backtestSelectedRunId ? ' active' : '';
            return (
                `<tr class="backtest-job-row${selectedCls}">` +
                `<td title="${this.escapeHTML(runId)}">${this.escapeHTML(runIdLabel || '--')}</td>` +
                `<td><span class="backtest-job-status ${status}">${this.escapeHTML(statusText)}</span></td>` +
                `<td>${Number(job?.days || 0)}</td>` +
                `<td>${this.escapeHTML(createdAt)}</td>` +
                `<td>${this.escapeHTML(startedAt)}</td>` +
                `<td>${this.escapeHTML(endedAt)}</td>` +
                `<td>` +
                `<div class="backtest-job-actions-cell">` +
                `<button class="backtest-job-mini-btn" onclick="App.handleInspectBacktestJob('${this.escapeHTML(runId)}')">详情</button>` +
                `<button class="backtest-job-mini-btn" onclick="App.handleViewBacktestRunResult('${this.escapeHTML(runId)}')" ${canView ? '' : 'disabled'}>查看结果</button>` +
                `<button class="backtest-job-mini-btn" onclick="App.handleCancelBacktestJob('${this.escapeHTML(runId)}')" ${canCancel ? '' : 'disabled'}>取消</button>` +
                `<button class="backtest-job-mini-btn" onclick="App.handleRetryBacktestJob('${this.escapeHTML(runId)}')" ${canRetry ? '' : 'disabled'}>重试</button>` +
                `</div>` +
                (errorText ? `<div class="backtest-job-error">${this.escapeHTML(errorText)}</div>` : '') +
                `</td>` +
                `</tr>`
            );
        }).join('');

        listEl.innerHTML = `
            <table class="backtest-job-table">
                <thead>
                    <tr>
                        <th>run_id</th>
                        <th>状态</th>
                        <th>天数</th>
                        <th>创建时间</th>
                        <th>开始时间</th>
                        <th>结束时间</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    },

    async loadBacktestJobs(silent = false) {
        try {
            const jobs = await API.getBacktestJobs(20);
            this.state.backtestJobs = Array.isArray(jobs) ? jobs : [];
            const signature = JSON.stringify(this.state.backtestJobs.map((item) => ({
                run_id: item?.run_id || '',
                status: item?.status || '',
                updated_at: item?.updated_at || '',
            })));
            if (!this.state.backtestSelectedRunId && this.state.backtestJobs.length > 0) {
                const firstRunId = String(this.state.backtestJobs[0]?.run_id || '').trim();
                if (firstRunId) this.state.backtestSelectedRunId = firstRunId;
            }
            const selected = this.state.backtestJobs.find((item) => String(item?.run_id || '').trim() === this.state.backtestSelectedRunId)
                || this.state.backtestJobs[0]
                || null;
            this.syncBacktestJobMeta(selected);
            this.renderBacktestResultRunMeta();
            this.renderBacktestConsistencyStatus();
            if (signature !== this.state.backtestJobsSignature) {
                this.state.backtestJobsSignature = signature;
                this.renderBacktestJobs();
            }
            this.renderPipelineStageProgress();
            this.renderOpsMonitorPanel();
        } catch (e) {
            console.error('加载回测任务列表失败', e);
            if (!silent) this.showToast('加载回测任务列表失败，请查看后端日志。', 'error');
        }
    },

    startBacktestJobPolling() {
        this.state.backtestPollingEnabled = true;
        if (this.state.backtestPollingTimer) {
            clearInterval(this.state.backtestPollingTimer);
            this.state.backtestPollingTimer = null;
        }
        this.state.backtestPollingTimer = setInterval(async () => {
            if (this.state.currentPage !== 'backtest') return;
            await this.loadBacktestJobs(true);
        }, 3000);
        this.renderBacktestJobs();
    },

    stopBacktestJobPolling() {
        this.state.backtestPollingEnabled = false;
        if (this.state.backtestPollingTimer) {
            clearInterval(this.state.backtestPollingTimer);
            this.state.backtestPollingTimer = null;
        }
        this.renderBacktestJobs();
    },

    async handleInspectBacktestJob(runId) {
        const id = String(runId || '').trim();
        if (!id) return;
        try {
            const job = await API.getBacktestJob(id);
            this.syncBacktestJobMeta(job);
            this.renderBacktestJobs();
            const statusText = this.getBacktestStatusText(job?.status);
            this.showToast(`任务 ${id} 当前状态：${statusText}`, 'info');
            if (this.isBacktestJobTerminal(job?.status)) {
                await this.loadBacktestDashboard(id);
            }
        } catch (e) {
            console.error('查询回测任务详情失败', e);
            this.showToast('查询回测任务详情失败。', 'error');
        }
    },

    async handleViewBacktestRunResult(runId) {
        const id = String(runId || '').trim();
        if (!id) return;
        this.state.backtestResultRunId = id;
        this.state.backtestSelectedRunId = id;
        this.resetBacktestConsistencyStatus(id, `口径校验：待执行（run_id=${id}）`);
        this.renderBacktestResultRunMeta();
        await this.loadBacktestDashboard(id);
        this.showToast(`已切换回测结果视角：${id}`, 'info');
    },

    async handleCheckBacktestConsistency() {
        const runId = String(
            this.state.backtestResultRunId || this.state.backtestSelectedRunId || this.state.lastBacktestRunId || ''
        ).trim();
        if (!runId) {
            this.showToast('暂无可校验 run_id，请先选择任务。', 'info');
            return;
        }
        this.setLoading(true);
        try {
            const trend = await API.getBacktestResults(12, runId);
            const rows = Array.isArray(trend) ? trend : [];
            if (rows.length === 0) {
                this.state.backtestConsistency = {
                    runId,
                    status: 'idle',
                    checkedAt: new Date().toLocaleString(),
                    total: 0,
                    mismatches: 0,
                    message: `口径校验：${runId} 暂无结果行`,
                };
                this.renderBacktestConsistencyStatus();
                return;
            }

            const sampleRows = rows.slice(0, Math.min(5, rows.length));
            const mismatches = [];
            for (const item of sampleRows) {
                const date = String(item?.date || '').trim();
                if (!date) continue;
                const detail = await API.getBacktestDayDetail(date, runId);
                const trendHits = Number(item?.hits || 0);
                const trendAlpha = Number(item?.alpha || 0);
                const detailHits = Number(detail?.hits || 0);
                const detailAlpha = Number(detail?.alpha || 0);
                const sameHits = trendHits === detailHits;
                const sameAlpha = Math.abs(trendAlpha - detailAlpha) < 0.0001;
                if (!sameHits || !sameAlpha) {
                    mismatches.push({
                        date,
                        trendHits,
                        detailHits,
                        trendAlpha,
                        detailAlpha,
                    });
                }
            }

            const checkedAt = new Date().toLocaleString();
            const pass = mismatches.length === 0;
            this.state.backtestConsistency = {
                runId,
                status: pass ? 'ok' : 'failed',
                checkedAt,
                total: sampleRows.length,
                mismatches: mismatches.length,
                message: pass
                    ? `口径校验：通过（${sampleRows.length}/${sampleRows.length}）`
                    : `口径校验：失败 ${mismatches.length}/${sampleRows.length}`,
            };
            this.renderBacktestConsistencyStatus();
            if (pass) {
                this.showToast(`口径校验通过（run_id=${runId}）`, 'success');
            } else {
                const first = mismatches[0];
                this.showToast(`口径校验失败：${first.date} 命中/alpha 不一致`, 'error');
            }
        } catch (e) {
            console.error('校验回测口径失败', e);
            this.state.backtestConsistency = {
                runId,
                status: 'failed',
                checkedAt: new Date().toLocaleString(),
                total: 0,
                mismatches: 0,
                message: '口径校验：执行失败',
            };
            this.renderBacktestConsistencyStatus();
            this.showToast('口径校验失败，请查看后端日志。', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleCancelBacktestJob(runId) {
        const id = String(runId || '').trim();
        if (!id) return;
        if (!confirm(`确认取消任务 ${id} ?`)) return;
        this.setLoading(true);
        try {
            const res = await API.cancelBacktestJob(id);
            this.showToast(`取消结果：${res.status || 'ok'} - ${res.message || ''}`, 'info');
            await this.loadBacktestJobs(true);
            await this.loadMaintenanceInspectionStatus(true);
        } catch (e) {
            console.error('取消回测任务失败', e);
            this.showToast('取消回测任务失败。', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleRetryBacktestJob(runId) {
        const id = String(runId || '').trim();
        if (!id) return;
        this.setLoading(true);
        try {
            const res = await API.retryBacktestJob(id);
            const newRunId = String(res?.new_run_id || '').trim();
            if (newRunId) {
                this.state.lastBacktestRunId = newRunId;
                this.state.backtestSelectedRunId = newRunId;
                this.state.backtestResultRunId = newRunId;
                this.resetBacktestConsistencyStatus(newRunId, `口径校验：待执行（run_id=${newRunId}）`);
            }
            this.showToast(`重试结果：${res.status || 'ok'}${newRunId ? `，新任务 ${newRunId}` : ''}`, 'success');
            await this.loadBacktestJobs(true);
            await this.loadMaintenanceInspectionStatus(true);
        } catch (e) {
            console.error('重试回测任务失败', e);
            this.showToast('重试回测任务失败。', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleRunBacktest() {
        const inlineDays = document.getElementById('backtest-days-inline')?.value;
        const settingsDays = document.getElementById('backtest-days')?.value;
        const days = this.state.currentPage === 'settings'
            ? (settingsDays || inlineDays || 60)
            : (inlineDays || settingsDays || 60);
        if (!confirm(`将启动 ${days} 日双盲回测，可能消耗 API 配额，确定吗？`)) return;
        this.setLoading(true);
        try {
            const res = await API.runBacktest(parseInt(days));
            const runInfo = res.run_id ? `（任务ID: ${res.run_id}）` : '';
            this.state.lastBacktestRunId = String(res.run_id || '').trim();
            if (this.state.lastBacktestRunId) {
                this.state.backtestSelectedRunId = this.state.lastBacktestRunId;
                this.state.backtestResultRunId = this.state.lastBacktestRunId;
                this.resetBacktestConsistencyStatus(
                    this.state.lastBacktestRunId,
                    `口径校验：待执行（run_id=${this.state.lastBacktestRunId}）`
                );
            }
            this.showToast(`${res.message}${runInfo}`, 'success');
            await this.loadBacktestJobs(true);
            await this.loadMaintenanceInspectionStatus(true);
            this.renderPipelineStageProgress();
        } catch (e) { alert('回测启动失败'); }
        this.setLoading(false);
    },

    // ============================================================
    // 回测复盘 (Step 12)
    // ============================================================
    async loadBacktestDashboard(runId = '') {
        try {
            this.setLoading(true);
            const prevResultRunId = String(this.state.backtestResultRunId || '').trim();
            const requestedRunId = String(
                runId || this.state.backtestResultRunId || this.state.backtestSelectedRunId || this.state.lastBacktestRunId || ''
            ).trim();
            const data = await API.getBacktestResults(60, requestedRunId);
            if (!data || data.length === 0) {
                document.getElementById('bt-days').innerText = '0';
                document.getElementById('bt-alpha').innerText = '0.00%';
                document.getElementById('bt-hit').innerText = '0.00%';
                document.getElementById('bt-baseline').innerText = '0.00%';
                this.state.backtestResultRunId = requestedRunId;
                this.state.backtestResultParamsSnapshot = '{}';
                if (requestedRunId && requestedRunId !== prevResultRunId) {
                    this.resetBacktestConsistencyStatus(requestedRunId, `口径校验：待执行（run_id=${requestedRunId}）`);
                } else {
                    this.renderBacktestConsistencyStatus();
                }
                this.renderBacktestResultRunMeta();
                if (this.state.backtestChart) {
                    this.state.backtestChart.clear();
                }
                return;
            }

            const resolvedRunId = String(data[0]?.run_id || requestedRunId || '').trim();
            const snapshotText = String(data[0]?.params_snapshot || '{}');
            this.state.backtestResultRunId = resolvedRunId;
            this.state.backtestResultParamsSnapshot = snapshotText;
            if (resolvedRunId && resolvedRunId !== prevResultRunId) {
                this.resetBacktestConsistencyStatus(resolvedRunId, `口径校验：待执行（run_id=${resolvedRunId}）`);
            } else {
                this.renderBacktestConsistencyStatus();
            }
            this.renderBacktestResultRunMeta();

            data.reverse(); // 从旧到新排序，符合图表 X 轴习惯

            const totalDays = data.length;
            const avgAlpha = data.reduce((sum, item) => sum + item.alpha, 0) / totalDays;
            const avgHit = data.reduce((sum, item) => sum + item.hit_rate, 0) / totalDays;
            const avgBaseline = data.reduce((sum, item) => sum + item.random_hit_rate, 0) / totalDays;

            document.getElementById('bt-days').innerText = totalDays;
            document.getElementById('bt-alpha').innerText = (avgAlpha > 0 ? '+' : '') + avgAlpha.toFixed(2) + '%';
            document.getElementById('bt-alpha').style.color = avgAlpha > 0 ? 'var(--accent-red)' : 'var(--accent-green)';
            document.getElementById('bt-hit').innerText = avgHit.toFixed(2) + '%';
            document.getElementById('bt-baseline').innerText = avgBaseline.toFixed(2) + '%';

            this.renderBacktestChart(data);
        } catch (e) {
            console.error('加载回测面板失败', e);
            this.showToast('加载回测复盘失败', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    renderBacktestChart(data) {
        const chartDom = document.getElementById('backtest-alpha-chart');
        if (!this.state.backtestChart) {
            this.state.backtestChart = echarts.init(chartDom);

            // 绑定图表点击事件以加载明细
            this.state.backtestChart.on('click', (params) => {
                const date = params.name;
                this.showBacktestDayDetail(date);
            });

            window.addEventListener('resize', () => {
                if (this.state.currentTab === 'backtest') {
                    this.state.backtestChart.resize();
                }
            });
        }

        const dates = data.map(i => i.date);
        const alphas = data.map(i => parseFloat(i.alpha.toFixed(2)));
        const hits = data.map(i => parseFloat(i.hit_rate.toFixed(2)));
        const baselines = data.map(i => parseFloat(i.random_hit_rate.toFixed(2)));

        const option = {
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross', crossStyle: { color: 'var(--text-muted)' } },
                backgroundColor: 'hsla(225, 25%, 10%, 0.85)',
                borderColor: 'var(--border-glass)',
                textStyle: { color: 'var(--text-main)' },
                formatter: function (params) {
                    let html = `<div style="font-weight:700; margin-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:4px;">📅 ${params[0].name}</div>`;
                    let alpha = 0, hit = 0, base = 0;
                    params.forEach(p => {
                        html += `<div>${p.marker} ${p.seriesName}: <b>${p.value}%</b></div>`;
                        if (p.seriesName.includes('Alpha')) alpha = p.value;
                        if (p.seriesName.includes('Top10')) hit = p.value;
                        if (p.seriesName.includes('随机')) base = p.value;
                    });
                    const diff = (hit - base).toFixed(2);
                    const diffColor = diff > 0 ? 'var(--accent-red)' : 'var(--accent-green)';
                    html += `<div style="margin-top:8px; padding-top:4px; border-top:1px dashed rgba(255,255,255,0.1); font-size:11px; color:var(--text-dim);">
                        💡 相较随机抛硬币，超额胜率：<span style="color:${diffColor}; font-weight:700;">${diff > 0 ? '+' : ''}${diff}%</span>
                    </div>`;
                    return html;
                }
            },
            legend: {
                data: ['Alpha 超额(%)', 'Top10 命中率(%)', '随机基准命中率(%)'],
                textStyle: { color: 'var(--text-dim)' },
                bottom: 0
            },
            grid: { left: '3%', right: '3%', bottom: '15%', top: '10%', containLabel: true },
            xAxis: {
                type: 'category',
                data: dates,
                axisLabel: { color: 'var(--text-muted)', fontSize: 10 }
            },
            yAxis: [
                {
                    type: 'value',
                    name: 'Alpha (%)',
                    position: 'left',
                    splitLine: { lineStyle: { color: 'var(--border-glass)', type: 'dashed' } },
                    axisLabel: { color: 'var(--text-muted)' }
                },
                {
                    type: 'value',
                    name: '命中率(%)',
                    position: 'right',
                    max: 100,
                    min: 0,
                    splitLine: { show: false },
                    axisLabel: { color: 'var(--text-muted)' }
                }
            ],
            series: [
                {
                    name: 'Top10 命中率(%)',
                    type: 'bar',
                    yAxisIndex: 1,
                    data: hits,
                    itemStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(59, 130, 246, 0.8)' },
                            { offset: 1, color: 'rgba(59, 130, 246, 0.1)' }
                        ]),
                        borderRadius: [4, 4, 0, 0]
                    },
                    barWidth: '40%'
                },
                {
                    name: '随机基准命中率(%)',
                    type: 'line',
                    yAxisIndex: 1,
                    data: baselines,
                    itemStyle: { color: '#a78bfa' },
                    lineStyle: { type: 'dashed', width: 2 },
                    symbol: 'none'
                },
                {
                    name: 'Alpha 超额(%)',
                    type: 'line',
                    yAxisIndex: 0,
                    data: alphas,
                    itemStyle: { color: '#f43f5e' },
                    lineStyle: { width: 3, shadowColor: 'rgba(244, 63, 94, 0.5)', shadowBlur: 10 },
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(244, 63, 94, 0.3)' },
                            { offset: 1, color: 'rgba(244, 63, 94, 0)' }
                        ])
                    },
                    symbolSize: 6,
                    markLine: {
                        data: [{ yAxis: 0, name: 'Alpha 零界线' }],
                        lineStyle: { color: '#fbbf24', type: 'solid', width: 1 },
                        label: { show: false },
                        symbol: ['none', 'none']
                    }
                }
            ]
        };

        this.state.backtestChart.setOption(option);
    },

    async showBacktestDayDetail(date) {
        const activeRunId = String(this.state.backtestResultRunId || '').trim();
        const runHint = activeRunId ? ` · run_id=${activeRunId}` : '';
        document.getElementById('bt-detail-date').innerText = `交易日: ${date}${runHint}`;
        const container = document.getElementById('bt-detail-container');
        container.innerHTML = `<div class="empty-state"><div class="icon">⏳</div><p>加载中...</p></div>`;

        try {
            const data = await API.getBacktestDayDetail(date, activeRunId);
            const details = data.details || [];
            if (data?.run_id) {
                this.state.backtestResultRunId = String(data.run_id || '').trim();
            }
            if (data?.params_snapshot) {
                this.state.backtestResultParamsSnapshot = String(data.params_snapshot || '{}');
            }
            this.renderBacktestResultRunMeta();

            if (details.length === 0) {
                container.innerHTML = `<div class="empty-state">⚠️ 该日无记录或非交易日</div>`;
                return;
            }

            let html = `<table class="backtest-detail-table fade-in">
                <thead><tr><th>#</th><th>板块名称</th><th>T+0 得分</th><th>T+1 涨跌</th><th>预测结论</th></tr></thead>
                <tbody>`;

            details.forEach((item, index) => {
                const changeVal = parseFloat(item.change_t1);
                let changeColor = "change-flat";
                let changeText = "0.00%";

                if (changeVal > 0) {
                    changeColor = "change-up";
                    changeText = `+${changeVal.toFixed(2)}%`;
                } else if (changeVal < 0) {
                    changeColor = "change-down";
                    changeText = `${changeVal.toFixed(2)}%`;
                }

                const hitBadge = item.is_hit
                    ? `<span class="hit-badge hit-yes">跑赢基准</span>`
                    : `<span class="hit-badge hit-no">未及预期</span>`;

                html += `<tr>
                    <td class="rank-cell">#${index + 1}</td>
                    <td style="font-weight: 700; color: var(--text-bright);">${item.name}</td>
                    <td style="color: var(--text-dim);">${parseFloat(item.score).toFixed(2)}</td>
                    <td class="${changeColor}">${changeText}</td>
                    <td>${hitBadge}</td>
                </tr>`;
            });

            html += `</tbody></table>`;
            container.innerHTML = html;
        } catch (e) {
            console.error('加载回测详情失败', e);
            container.innerHTML = `<div class="empty-state">❌ 加载详情失败</div>`;
        }
    }
};

window.addEventListener('DOMContentLoaded', () => App.init());
window.addEventListener('beforeunload', () => App.stopMaintenanceInspectionPolling());



