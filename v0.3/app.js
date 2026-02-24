/**
 * 板块关系图谱 - V0.3 主逻辑
 * 新增：实时数据刷新功能
 */

// 全局变量
let chartInstance = null;
let sectorData = { sectors: [], relations: [] };
let editingSectorId = null;
let editingRelationId = null;

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    await initDefaultData();
    await loadData();
    initTabs();
    initChart();
    renderSectorList();
    renderSectorsTable();
    renderRelationsTable();
});

// 加载数据
async function loadData() {
    sectorData.sectors = await SectorDB.getAll();
    sectorData.relations = await RelationDB.getAll();
    console.log('数据加载完成:', sectorData);
}

// 刷新所有视图
async function refreshAll() {
    await loadData();
    updateChart();
    renderSectorList();
    renderSectorsTable();
    renderRelationsTable();
}

// ==================== 实时数据刷新 ====================

/**
 * 处理刷新按钮点击
 */
async function handleRefresh() {
    const btn = document.getElementById('btn-refresh');
    const status = document.getElementById('refresh-status');

    // 显示加载状态
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = '⏳ 刷新中...';
    status.textContent = '正在获取数据...';
    status.className = 'refresh-status';

    try {
        // 调用API获取数据
        const result = await SectorAPI.refreshFromAPI();

        // 刷新视图
        await refreshAll();

        // 显示成功状态
        status.textContent = `✓ 已更新 ${result.updated} 个板块 (${new Date().toLocaleTimeString()})`;
        status.className = 'refresh-status success';

        console.log('刷新完成:', result);
    } catch (error) {
        console.error('刷新失败:', error);
        status.textContent = `✗ 刷新失败: ${error.message}`;
        status.className = 'refresh-status error';
    } finally {
        // 恢复按钮状态
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.innerHTML = '🔄 刷新数据';
    }
}

// Tab切换
function initTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

            if (tab.dataset.tab === 'graph') {
                setTimeout(() => chartInstance?.resize(), 100);
            }
        });
    });
}

// ==================== 图表相关 ====================

function initChart() {
    const container = document.getElementById('graph-container');
    chartInstance = echarts.init(container, 'dark');
    updateChart();

    chartInstance.on('click', (params) => {
        if (params.dataType === 'node') {
            showSectorInfo(params.data.id);
        }
    });

    window.addEventListener('resize', () => chartInstance?.resize());
}

function updateChart() {
    const option = {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            formatter: (params) => {
                if (params.dataType === 'node') {
                    const sector = sectorData.sectors.find(s => s.id === params.data.id);
                    if (!sector) return '';
                    const changeClass = sector.dailyChange >= 0 ? 'color:#f5475b' : 'color:#00c48c';
                    return `
                        <div style="padding:8px">
                            <strong style="font-size:14px">${sector.name}</strong><br/>
                            <span style="${changeClass};font-size:16px;font-weight:bold">
                                ${sector.dailyChange >= 0 ? '+' : ''}${sector.dailyChange}%
                            </span><br/>
                            <span style="color:#888">层级: ${sector.level}级</span>
                        </div>
                    `;
                } else if (params.dataType === 'edge') {
                    return `
                        <div style="padding:8px">
                            <strong>${params.data.relationType}</strong><br/>
                            权重: ${params.data.weight}
                        </div>
                    `;
                }
            }
        },
        series: [{
            type: 'graph',
            layout: 'force',
            animation: true,
            roam: true,
            draggable: true,
            label: {
                show: true,
                position: 'bottom',
                fontSize: 12,
                color: '#e4e8f0'
            },
            emphasis: {
                focus: 'adjacency',
                lineStyle: { width: 6 }
            },
            force: {
                repulsion: 300,
                gravity: 0.1,
                edgeLength: [100, 200],
                friction: 0.6
            },
            data: sectorData.sectors.map(sector => ({
                id: sector.id,
                name: sector.name,
                symbolSize: 30 + (sector.volume || 50) * 0.4,
                itemStyle: {
                    color: getNodeColor(sector.dailyChange || 0)
                }
            })),
            edges: sectorData.relations.map(rel => ({
                source: rel.source,
                target: rel.target,
                relationType: rel.type,
                weight: rel.weight,
                lineStyle: {
                    width: 1 + Math.abs(rel.weight) * 0.3,
                    color: rel.weight > 0 ? 'rgba(245, 71, 91, 0.6)' : 'rgba(0, 196, 140, 0.6)',
                    curveness: 0.2
                },
                label: {
                    show: true,
                    formatter: rel.type,
                    fontSize: 10,
                    color: '#8892a6'
                }
            }))
        }]
    };

    chartInstance.setOption(option, true);
}

function getNodeColor(change) {
    if (change > 2) return '#f5475b';
    if (change > 0) return '#ff7875';
    if (change > -2) return '#52c41a';
    return '#00c48c';
}

// ==================== 板块列表和详情 ====================

function renderSectorList() {
    const container = document.getElementById('sector-list');
    const sortedSectors = [...sectorData.sectors].sort((a, b) => (b.dailyChange || 0) - (a.dailyChange || 0));

    container.innerHTML = sortedSectors.map(sector => `
        <div class="sector-item" onclick="showSectorInfo('${sector.id}')">
            <span class="sector-name">${sector.name}</span>
            <span class="sector-change ${(sector.dailyChange || 0) >= 0 ? 'positive' : 'negative'}">
                ${(sector.dailyChange || 0) >= 0 ? '+' : ''}${sector.dailyChange || 0}%
            </span>
        </div>
    `).join('');
}

function showSectorInfo(sectorId) {
    const sector = sectorData.sectors.find(s => s.id === sectorId);
    if (!sector) return;

    // 获取父板块
    const parent = sector.parentId ? sectorData.sectors.find(s => s.id === sector.parentId) : null;
    // 获取子板块
    const children = sectorData.sectors.filter(s => s.parentId === sectorId);
    // 获取关联板块
    const relations = sectorData.relations.filter(r => r.source === sectorId || r.target === sectorId);
    const relatedSectors = relations.map(r => {
        const otherId = r.source === sectorId ? r.target : r.source;
        const other = sectorData.sectors.find(s => s.id === otherId);
        return { name: other?.name || otherId, type: r.type, weight: r.weight };
    });

    const container = document.getElementById('sector-info');
    const changeClass = (sector.dailyChange || 0) >= 0 ? 'positive' : 'negative';

    container.innerHTML = `
        <div class="sector-detail">
            <div class="label">板块名称</div>
            <div class="value">${sector.name}</div>
        </div>
        <div class="sector-detail">
            <div class="label">今日涨跌</div>
            <div class="value sector-change ${changeClass}">
                ${(sector.dailyChange || 0) >= 0 ? '+' : ''}${sector.dailyChange || 0}%
            </div>
        </div>
        <div class="sector-detail">
            <div class="label">层级</div>
            <div class="value">${sector.level}级</div>
        </div>
        ${parent ? `
        <div class="sector-detail">
            <div class="label">↑ 父板块</div>
            <div class="value"><a href="#" onclick="showSectorInfo('${parent.id}'); return false;">${parent.name}</a></div>
        </div>` : ''}
        ${children.length > 0 ? `
        <div class="sector-detail">
            <div class="label">↓ 子板块 (${children.length})</div>
            <div class="value">${children.map(c => `<a href="#" onclick="showSectorInfo('${c.id}'); return false;">${c.name}</a>`).join('、')}</div>
        </div>` : ''}
        ${relatedSectors.length > 0 ? `
        <div class="sector-detail">
            <div class="label">🔗 关联板块 (${relatedSectors.length})</div>
            <div class="relations-list">
                ${relatedSectors.map(r => `
                    <div class="relation-item">
                        <span>${r.name}</span>
                        <span class="relation-tag">${r.type}</span>
                        <span class="relation-weight ${r.weight >= 0 ? 'positive' : 'negative'}">${r.weight > 0 ? '+' : ''}${r.weight}</span>
                    </div>
                `).join('')}
            </div>
        </div>` : ''}
    `;
}

// ==================== 板块管理 ====================

function renderSectorsTable() {
    const tbody = document.querySelector('#sectors-table tbody');
    tbody.innerHTML = sectorData.sectors.map(sector => `
        <tr>
            <td>${sector.id}</td>
            <td>${sector.name}</td>
            <td>${sector.level}级</td>
            <td>${sector.volume || '-'}</td>
            <td class="${(sector.dailyChange || 0) >= 0 ? 'sector-change positive' : 'sector-change negative'}">
                ${(sector.dailyChange || 0) >= 0 ? '+' : ''}${sector.dailyChange || 0}%
            </td>
            <td class="actions">
                <button class="btn btn-secondary btn-small" onclick="editSector('${sector.id}')">编辑</button>
                <button class="btn btn-danger btn-small" onclick="deleteSector('${sector.id}')">删除</button>
            </td>
        </tr>
    `).join('');
}

function showSectorForm(id = null) {
    editingSectorId = id;
    const modal = document.getElementById('sector-modal');
    const title = document.getElementById('sector-modal-title');
    const idInput = document.getElementById('sector-id');
    const parentSelect = document.getElementById('sector-parent');

    // 更新父板块选项
    const otherSectors = sectorData.sectors.filter(s => s.id !== id);
    parentSelect.innerHTML = '<option value="">无（顶级板块）</option>' +
        otherSectors.map(s => `<option value="${s.id}">${s.name}</option>`).join('');

    if (id) {
        const sector = sectorData.sectors.find(s => s.id === id);
        title.textContent = '编辑板块';
        idInput.value = sector.id;
        idInput.disabled = true;
        document.getElementById('sector-name').value = sector.name;
        document.getElementById('sector-level').value = sector.level;
        parentSelect.value = sector.parentId || '';
        document.getElementById('sector-volume').value = sector.volume || 50;
        document.getElementById('sector-daily').value = sector.dailyChange || 0;
        document.getElementById('sector-week').value = sector.weekChange || 0;
        document.getElementById('sector-month').value = sector.monthChange || 0;
    } else {
        title.textContent = '添加板块';
        document.getElementById('sector-form').reset();
        idInput.disabled = false;
    }

    modal.classList.add('active');
}

function editSector(id) {
    showSectorForm(id);
}

function closeSectorModal() {
    document.getElementById('sector-modal').classList.remove('active');
    editingSectorId = null;
}

async function saveSector(e) {
    e.preventDefault();

    const parentId = document.getElementById('sector-parent').value || null;
    const sector = {
        id: document.getElementById('sector-id').value.trim(),
        name: document.getElementById('sector-name').value.trim(),
        level: parseInt(document.getElementById('sector-level').value),
        parentId: parentId,
        volume: parseFloat(document.getElementById('sector-volume').value) || 50,
        dailyChange: parseFloat(document.getElementById('sector-daily').value) || 0,
        weekChange: parseFloat(document.getElementById('sector-week').value) || 0,
        monthChange: parseFloat(document.getElementById('sector-month').value) || 0,
        timeWeightMultiplier: 1.0
    };

    if (editingSectorId) {
        await SectorDB.update(sector.id, sector);
    } else {
        await SectorDB.add(sector);
    }

    closeSectorModal();
    await refreshAll();
}

async function deleteSector(id) {
    const sector = sectorData.sectors.find(s => s.id === id);
    if (confirm(`确定删除板块 "${sector.name}" 吗？\n相关的关联关系也会被删除。`)) {
        await SectorDB.delete(id);
        await refreshAll();
    }
}

// ==================== 关联管理 ====================

function renderRelationsTable() {
    const tbody = document.querySelector('#relations-table tbody');
    tbody.innerHTML = sectorData.relations.map(rel => {
        const source = sectorData.sectors.find(s => s.id === rel.source);
        const target = sectorData.sectors.find(s => s.id === rel.target);
        return `
            <tr>
                <td>${source?.name || rel.source}</td>
                <td>${target?.name || rel.target}</td>
                <td>${rel.type}</td>
                <td class="${rel.weight >= 0 ? 'sector-change positive' : 'sector-change negative'}">${rel.weight}</td>
                <td class="actions">
                    <button class="btn btn-secondary btn-small" onclick="editRelation(${rel.id})">编辑</button>
                    <button class="btn btn-danger btn-small" onclick="deleteRelation(${rel.id})">删除</button>
                </td>
            </tr>
        `;
    }).join('');
}

function updateSectorSelects() {
    const sourceSelect = document.getElementById('relation-source');
    const targetSelect = document.getElementById('relation-target');

    const options = sectorData.sectors.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    sourceSelect.innerHTML = options;
    targetSelect.innerHTML = options;
}

function showRelationForm(id = null) {
    editingRelationId = id;
    updateSectorSelects();

    const modal = document.getElementById('relation-modal');
    const title = document.getElementById('relation-modal-title');

    if (id) {
        const rel = sectorData.relations.find(r => r.id === id);
        title.textContent = '编辑关联';
        document.getElementById('relation-id').value = rel.id;
        document.getElementById('relation-source').value = rel.source;
        document.getElementById('relation-target').value = rel.target;
        document.getElementById('relation-type').value = rel.type;
        document.getElementById('relation-weight').value = rel.weight;
    } else {
        title.textContent = '添加关联';
        document.getElementById('relation-form').reset();
    }

    modal.classList.add('active');
}

function editRelation(id) {
    showRelationForm(id);
}

function closeRelationModal() {
    document.getElementById('relation-modal').classList.remove('active');
    editingRelationId = null;
}

async function saveRelation(e) {
    e.preventDefault();

    const relation = {
        source: document.getElementById('relation-source').value,
        target: document.getElementById('relation-target').value,
        type: document.getElementById('relation-type').value,
        weight: parseInt(document.getElementById('relation-weight').value) || 0,
        direction: 'forward',
        levelCoefficient: 0.8
    };

    if (editingRelationId) {
        await RelationDB.update(editingRelationId, relation);
    } else {
        await RelationDB.add(relation);
    }

    closeRelationModal();
    await refreshAll();
}

async function deleteRelation(id) {
    if (confirm('确定删除这条关联关系吗？')) {
        await RelationDB.delete(id);
        await refreshAll();
    }
}
