/**
 * 板块关系图谱 - V0.1 主逻辑
 */

// 全局变量
let chartInstance = null;
let sectorData = null;

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    initChart();
    renderSectorList();
});

// 加载数据
async function loadData() {
    try {
        const response = await fetch('data.json');
        sectorData = await response.json();
        console.log('数据加载成功:', sectorData);
    } catch (error) {
        console.error('数据加载失败:', error);
        // 如果fetch失败（本地文件），使用内联数据
        sectorData = getInlineData();
    }
}

// 内联备用数据（解决本地file://协议问题）
function getInlineData() {
    return {
        sectors: [
            { id: "xinnengyuanqiche", name: "新能源汽车", level: 1, volume: 100, dailyChange: 3.0, weekChange: 5.2, monthChange: 8.5 },
            { id: "donglidianchi", name: "动力电池", level: 2, volume: 80, dailyChange: 2.5, weekChange: 4.0, monthChange: 6.0 },
            { id: "gutaidianchi", name: "固态电池", level: 3, volume: 40, dailyChange: 1.8, weekChange: 3.5, monthChange: 10.2 },
            { id: "likuang", name: "锂矿", level: 2, volume: 60, dailyChange: -1.2, weekChange: -2.0, monthChange: -5.0 },
            { id: "chongdianzhuang", name: "充电桩", level: 2, volume: 50, dailyChange: 2.0, weekChange: 3.0, monthChange: 4.5 }
        ],
        relations: [
            { source: "xinnengyuanqiche", target: "donglidianchi", type: "应用", weight: 9 },
            { source: "xinnengyuanqiche", target: "chongdianzhuang", type: "配套", weight: 7 },
            { source: "donglidianchi", target: "gutaidianchi", type: "技术同源", weight: 8 },
            { source: "donglidianchi", target: "likuang", type: "供应", weight: 8 },
            { source: "likuang", target: "gutaidianchi", type: "成本影响", weight: 6 },
            { source: "xinnengyuanqiche", target: "gutaidianchi", type: "需求影响", weight: 5 }
        ]
    };
}

// 初始化图表
function initChart() {
    const container = document.getElementById('graph-container');
    chartInstance = echarts.init(container, 'dark');
    
    const option = {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            formatter: (params) => {
                if (params.dataType === 'node') {
                    const sector = sectorData.sectors.find(s => s.id === params.data.id);
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
        legend: {
            show: false
        },
        series: [{
            type: 'graph',
            layout: 'force',
            animation: true,
            animationDuration: 1500,
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
                lineStyle: {
                    width: 6
                }
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
                symbolSize: 30 + sector.volume * 0.4,
                itemStyle: {
                    color: getNodeColor(sector.dailyChange)
                },
                label: {
                    show: true
                }
            })),
            edges: sectorData.relations.map(rel => ({
                source: rel.source,
                target: rel.target,
                relationType: rel.type,
                weight: rel.weight,
                lineStyle: {
                    width: 1 + rel.weight * 0.3,
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
    
    chartInstance.setOption(option);
    
    // 点击事件
    chartInstance.on('click', (params) => {
        if (params.dataType === 'node') {
            showSectorInfo(params.data.id);
        }
    });
    
    // 响应式
    window.addEventListener('resize', () => {
        chartInstance.resize();
    });
}

// 获取节点颜色
function getNodeColor(change) {
    if (change > 2) return '#f5475b';      // 大涨 - 红色
    if (change > 0) return '#ff7875';      // 小涨 - 浅红
    if (change > -2) return '#52c41a';     // 小跌 - 浅绿
    return '#00c48c';                       // 大跌 - 绿色
}

// 渲染板块列表
function renderSectorList() {
    const container = document.getElementById('sector-list');
    
    const sortedSectors = [...sectorData.sectors].sort((a, b) => b.dailyChange - a.dailyChange);
    
    container.innerHTML = sortedSectors.map(sector => `
        <div class="sector-item" onclick="showSectorInfo('${sector.id}')">
            <span class="sector-name">${sector.name}</span>
            <span class="sector-change ${sector.dailyChange >= 0 ? 'positive' : 'negative'}">
                ${sector.dailyChange >= 0 ? '+' : ''}${sector.dailyChange}%
            </span>
        </div>
    `).join('');
}

// 显示板块详情
function showSectorInfo(sectorId) {
    const sector = sectorData.sectors.find(s => s.id === sectorId);
    if (!sector) return;
    
    const relations = sectorData.relations.filter(r => 
        r.source === sectorId || r.target === sectorId
    );
    
    const container = document.getElementById('sector-info');
    const changeClass = sector.dailyChange >= 0 ? 'positive' : 'negative';
    
    container.innerHTML = `
        <div class="sector-detail">
            <div class="label">板块名称</div>
            <div class="value">${sector.name}</div>
        </div>
        <div class="sector-detail">
            <div class="label">今日涨跌</div>
            <div class="value sector-change ${changeClass}">
                ${sector.dailyChange >= 0 ? '+' : ''}${sector.dailyChange}%
            </div>
        </div>
        <div class="sector-detail">
            <div class="label">层级</div>
            <div class="value">${sector.level}级</div>
        </div>
        <div class="sector-detail">
            <div class="label">关联板块</div>
            <div class="value">${relations.length}个</div>
        </div>
    `;
}
