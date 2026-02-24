/**
 * 板块关系图谱 - V0.3 数据API
 * 封装新浪板块数据接口
 */

// CORS代理服务器（用于开发测试）
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

// 新浪板块API配置
const SINA_API = {
    // 板块资金流向（分类：1-行业，0-概念）
    sectorMoney: 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk',
};

/**
 * 获取板块列表及涨跌数据
 * @param {string} fenlei - 分类：1-行业板块，0-概念板块
 * @param {number} num - 获取数量
 * @returns {Promise<Array>} 板块数据数组
 */
async function fetchSectorData(fenlei = '1', num = 50) {
    const url = `${SINA_API.sectorMoney}?page=1&num=${num}&sort=netamount&asc=0&fenlei=${fenlei}`;

    try {
        // 尝试直接请求（可能因CORS失败）
        let response;
        try {
            response = await fetch(url, {
                headers: {
                    'Referer': 'https://finance.sina.com.cn'
                }
            });
        } catch (corsError) {
            // 使用CORS代理
            console.log('直接请求失败，使用CORS代理...');
            response = await fetch(CORS_PROXY + encodeURIComponent(url));
        }

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log(`获取到 ${data.length} 个板块数据`);
        return data;
    } catch (error) {
        console.error('获取板块数据失败:', error);
        return [];
    }
}

/**
 * 解析板块数据，转换为统一格式
 * @param {Array} rawData - 原始API数据
 * @returns {Array} 标准化的板块数据
 */
function parseSectorData(rawData) {
    return rawData.map(item => ({
        id: item.category || item.name,
        name: item.name,
        dailyChange: parseFloat(item.avg_changeratio) * 100, // 转为百分比
        netAmount: parseFloat(item.netamount) / 100000000,   // 转为亿
        turnover: parseFloat(item.turnover),
        leadStock: item.ts_name,
        leadStockChange: parseFloat(item.ts_changeratio) * 100,
        updateTime: new Date().toLocaleTimeString()
    }));
}

/**
 * 更新本地数据库中的板块涨跌数据
 * @param {Array} apiData - API返回的板块数据
 * @returns {Object} 更新结果 {updated, notFound}
 */
async function updateSectorChanges(apiData) {
    const result = { updated: 0, notFound: [], newSectors: [] };
    const existingSectors = await SectorDB.getAll();
    const existingMap = new Map(existingSectors.map(s => [s.name, s]));

    for (const item of apiData) {
        const existing = existingMap.get(item.name);
        if (existing) {
            // 更新已有板块的涨跌数据
            await SectorDB.update(existing.id, {
                dailyChange: item.dailyChange,
                netAmount: item.netAmount,
                leadStock: item.leadStock,
                updateTime: item.updateTime
            });
            result.updated++;
        } else {
            result.notFound.push(item.name);
        }
    }

    return result;
}

/**
 * 一键刷新：获取API数据并更新本地
 */
async function refreshFromAPI() {
    console.log('开始刷新板块数据...');

    // 获取行业板块和概念板块
    const [industryData, conceptData] = await Promise.all([
        fetchSectorData('1', 30),  // 行业板块
        fetchSectorData('0', 30)   // 概念板块
    ]);

    const allData = [...parseSectorData(industryData), ...parseSectorData(conceptData)];
    console.log(`共获取 ${allData.length} 个板块`);

    const result = await updateSectorChanges(allData);
    console.log(`更新完成: ${result.updated} 个板块已更新`);

    if (result.notFound.length > 0) {
        console.log(`未匹配的板块: ${result.notFound.slice(0, 5).join(', ')}...`);
    }

    return {
        total: allData.length,
        updated: result.updated,
        notFound: result.notFound,
        rawData: allData
    };
}

// 导出API
window.SectorAPI = {
    fetchSectorData,
    parseSectorData,
    updateSectorChanges,
    refreshFromAPI
};
