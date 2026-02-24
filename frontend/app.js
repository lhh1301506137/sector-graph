/**
 * 板块轮动预测系统 V0.5 - 核心逻辑
 * 整合了回测验证、AI 分析及可视化详情面板
 */

const App = {
    state: {
        currentPage: 'ranking',
        rankingData: [],
        sectorsData: [],
        relationsData: [],
        logicsData: [],
        aiPendingData: [],
        config: {},
        favFilter: false,
        isLoading: false,
        graphInstance: null,
        backtestChart: null
    },

    // ============================================================
    // 初始化与核心控制
    // ============================================================
    async init() {
        console.log('🚀 应用初始化...');
        this.updateStatus('系统就绪');
        await this.loadSyncStatus();
        await this.loadSectors(); // 优先加载基础数据
        await this.loadSummary(); // 加载顶部看板
        await this.switchPage('ranking'); // 统一通过 switchPage 初始化第一页
    },

    async loadSyncStatus() {
        try {
            const res = await API.getSyncStatus();
            const badge = document.getElementById('sync-status-badge');
            if (badge) {
                badge.innerText = `📅 数据同步于: ${res.last_sync_date || '暂无数据'}`;
            }
        } catch (e) {
            console.error('获取同步状态失败:', e);
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
        ['btn-refresh', 'btn-calc', 'btn-ai'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = loading;
        });
        this.updateStatus(loading ? '正在同步数据...' : '就绪');
    },

    // ============================================================
    // 系统管理与自愈 (Step 14)
    // ============================================================
    async clearUnlockedRelations() {
        if (!confirm('确定要清理未带锁定标志（🔒）的关联吗？主要用于抹除 AI 分析关系。')) return;
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

        // 页面特定的数据加载逻辑
        if (page === 'ranking') await this.loadRanking();
        if (page === 'graph') setTimeout(() => this.renderGraph(), 100);

        // 原数据管理子页拆分后的加载逻辑
        if (page === 'manage-sectors') await this.loadSectors();
        if (page === 'manage-relations') await this.loadRelations();
        if (page === 'manage-logics') await this.loadLogics();

        if (page === 'backtest') {
            setTimeout(() => {
                this.loadBacktestDashboard();
                if (this.state.backtestChart) this.state.backtestChart.resize();
            }, 50);
        }

        if (page === 'settings') await this.loadSettingsIntoView();
    },

    async loadSettingsIntoView() {
        const cfg = await API.getConfig();
        if (cfg.ai) {
            document.getElementById('cfg-ai-provider').value = cfg.ai.provider || '';
            document.getElementById('cfg-ai-key').value = cfg.ai.api_key || '';
            document.getElementById('cfg-ai-url').value = cfg.ai.base_url || '';
            document.getElementById('cfg-ai-model').value = cfg.ai.model || '';
        }
        if (cfg.algo) {
            document.getElementById('cfg-algo-mode').value = cfg.algo.deviation_mode || '';
            document.getElementById('cfg-algo-decay').value = cfg.algo.time_decay_days || 30;
        }
    },

    async loadManageData() {
        if (this.state.currentManageSubtab === 'sectors') await this.loadSectors();
        else if (this.state.currentManageSubtab === 'relations') await this.loadRelations();
        else if (this.state.currentManageSubtab === 'logics') await this.loadLogics();
    },

    // ============================================================
    // 排行榜逻辑 (Step 9 Upgrade)
    // ============================================================
    async loadRanking() {
        try {
            const params = {
                category_type: document.getElementById('ranking-type').value,
                search: document.getElementById('ranking-search').value,
                favorited: this.state.favFilter ? true : null
            };
            const data = await API.getRanking(params);
            this.state.rankingData = data;
            this.renderRanking();
        } catch (e) {
            console.error('加载排行失败:', e);
        }
    },

    renderRanking() {
        const container = document.getElementById('ranking-content');
        if (this.state.rankingData.length === 0) {
            container.innerHTML = `<div class="empty-state"><div class="icon">📊</div><p>点击"计算得分"获取预测排行</p></div>`;
            return;
        }

        let html = `<table class="ranking-table fade-in"><thead><tr>
            <th>#</th><th>⭐</th><th>板块名称</th><th>类型</th><th>今日涨幅</th><th>预期涨幅</th><th>今日偏差</th><th class="score-cell">得分</th><th>领涨股</th>
        </tr></thead><tbody>`;

        this.state.rankingData.forEach(item => {
            const updownClass = item.daily_change >= 0 ? 'change-up' : 'change-down';
            const expClass = item.expected_change >= 0 ? 'change-up' : 'change-down';
            html += `
                <tr class="${item.rank <= 3 ? 'rank-top' : ''}" style="cursor: pointer" onclick="App.showSectorDetail(${item.sector_id})">
                    <td class="rank-cell">${item.rank}</td>
                    <td onclick="event.stopPropagation(); App.toggleFavorite(${item.sector_id}, ${item.is_favorited})">
                        <span class="fav-star ${item.is_favorited ? 'active' : 'inactive'}">${item.is_favorited ? '★' : '☆'}</span>
                    </td>
                    <td class="name-cell">${item.name}</td>
                    <td><span class="type-badge ${item.category_type === '行业' ? 'industry' : 'concept'}">${item.category_type}</span></td>
                    <td class="${updownClass}">${item.daily_change !== null ? item.daily_change.toFixed(2) + '%' : '-'}</td>
                    <td class="${expClass}">${item.expected_change !== null ? item.expected_change.toFixed(2) + '%' : '-'}</td>
                    <td class="change-up">${item.deviation !== null ? '+' + item.deviation.toFixed(2) + '%' : '-'}</td>
                    <td class="score-cell">${item.score.toFixed(2)}</td>
                    <td class="change-up">${item.lead_stock || '-'} <small>${item.lead_stock_change ? '+' + item.lead_stock_change.toFixed(1) + '%' : ''}</small></td>
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
        document.getElementById('detail-fav-btn').innerText = sector.is_favorited ? '⭐' : '☆';

        // 每次打开面板，先隐藏和重置 AI 解释器区域
        document.getElementById('ai-explainer-box').style.display = 'none';

        const rankItem = this.state.rankingData.find(r => r.sector_id === id);
        document.getElementById('detail-sector-score').innerText = `得分: ${rankItem ? rankItem.score.toFixed(2) : '0.0'}`;
        // The original line for detail-sector-fav is replaced by detail-fav-btn above.
        // document.getElementById('detail-sector-fav').innerText = sector.is_favorited ? '★ 关注' : '☆ 关注';

        try {
            const history = await API.getSectorDaily(id);
            // 这里我们使用真实能查到的最新的回测或拉取日期作为目标上下文
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
                        <span class="direction-hint">${isSource ? '影响 ➔' : '受控于 ⇠'}</span>
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
        const currentFav = icon === '⭐';
        await this.toggleFavorite(this.state.currentDetailId, currentFav);
        document.getElementById('detail-fav-btn').innerText = currentFav ? '☆' : '⭐';
    },

    // ============================================================
    // AI 逻辑解释器 (Step 13)
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
                    // 打字结束后高亮其中的数值 (此步之前全是纯文本)
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
                tooltip: { trigger: 'item', formatter: p => p.dataType === 'node' ? `<b>${p.data.name}</b><br/>得分: ${p.data.value.toFixed(2)}` : '' },
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
        const params = { category_type: document.getElementById('sector-type-filter')?.value, search: document.getElementById('sector-search')?.value };
        const data = await API.getSectors(params);
        this.state.sectorsData = data;
        const wrap = document.getElementById('sectors-table-wrap');
        if (!wrap) return;
        wrap.innerHTML = `<table><thead><tr><th>ID</th><th>名称</th><th>类型</th><th>状态</th><th>操作</th></tr></thead><tbody>` +
            data.map(s => `<tr><td>${s.id}</td><td>${s.name}</td><td>${s.category_type}</td><td>${s.is_active ? '✅' : '❌'}</td>
                <td><button class="label-btn" onclick="App.toggleSectorActive(${s.id}, ${s.is_active})">${s.is_active ? '隐藏' : '显示'}</button></td></tr>`).join('') + `</tbody></table>`;
    },

    async toggleSectorActive(id, current) {
        await API.updateSector(id, { is_active: !current });
        this.loadSectors();
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
        if (confirm('确定删除逻辑模板？')) { await API.deleteLogic(id); this.loadLogics(); }
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
            this.showToast(`同步完毕！共更新了 ${res.updated} 个板块的最新行情。`, 'success');
            await this.loadRanking();
            await this.loadSyncStatus(); // 刷新后立刻更新顶部的日期微标
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
            await API.runScoring();
            this.showToast('算力运行结束，已提取正向偏差板块！', 'success');
            await this.loadRanking();
        } catch (e) {
            this.showToast('计算评分失败，请查看后台运行日志', 'error');
        } finally {
            this.setLoading(false);
        }
    },

    async handleAIAnalyze() {
        const size = prompt('要AI分析的对数？(1-50)', '10');
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
        if (confirm('确认清空？')) { await API.clearAIPending(); this.closeModal('modal-ai-pending'); }
    },

    // ============================================================
    // 设置与回测
    // ============================================================
    // 为保持兼容性，重定向旧的 toggleSettings
    async toggleSettings() {
        await this.switchPage('settings');
    },

    switchSettingsTab(tab) {
        ['ai', 'algo'].forEach(t => document.getElementById(`settings-${t}`).style.display = (t === tab ? 'block' : 'none'));
        ['ai', 'algo'].forEach(t => document.getElementById(`tab-btn-${t}`).classList.toggle('active', t === tab));
    },

    async saveSettings() {
        if (this.state.isLoading) return;

        const data = {
            ai: {
                provider: document.getElementById('cfg-ai-provider').value,
                api_key: document.getElementById('cfg-ai-key').value,
                base_url: document.getElementById('cfg-ai-url').value,
                model: document.getElementById('cfg-ai-model').value
            },
            algo: {
                deviation_mode: document.getElementById('cfg-algo-mode').value,
                time_decay_days: document.getElementById('cfg-algo-decay').value
            }
        };

        this.setLoading(true);
        try {
            await API.saveConfig(data);
            this.showToast('⚙️ 配置保存成功！算法变更将在下次计算得分时生效。', 'success');
            await this.loadSettingsIntoView(); // 刷新当前设置页数据
        } catch (e) {
            console.error(e);
            alert('❌ 保存配置失败，请检查网络或后端日志');
        } finally {
            this.setLoading(false);
        }
    },

    async handleRunBacktest() {
        const days = document.getElementById('backtest-days').value || 60;
        if (!confirm(`将启动 ${days} 日双盲回测，可能消耗 API 额度，确定？`)) return;
        this.setLoading(true);
        try {
            const res = await API.runBacktest(parseInt(days));
            this.showToast(res.message, 'success');
        } catch (e) { alert('回测启动失败'); }
        this.setLoading(false);
    },

    // ============================================================
    // 回测复盘 (Step 12)
    // ============================================================
    async loadBacktestDashboard() {
        try {
            this.setLoading(true);
            const data = await API.getBacktestResults(60);
            if (!data || data.length === 0) return;

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
                    name: '命中率 (%)',
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
        document.getElementById('bt-detail-date').innerText = `交易日: ${date}`;
        const container = document.getElementById('bt-detail-container');
        container.innerHTML = `<div class="empty-state"><div class="icon">⏳</div><p>加载中...</p></div>`;

        try {
            const data = await API.getBacktestDayDetail(date);
            const details = data.details || [];

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
