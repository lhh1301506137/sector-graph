/**
 * 板块关系图谱 - 数据库封装
 * 使用Dexie.js封装IndexedDB
 */

// 初始化数据库 - V0.3使用独立数据库
const db = new Dexie('SectorGraphDB_v03');

// 定义表结构 - V2增加parentId支持层级
db.version(2).stores({
    sectors: 'id, name, level, parentId, volume, dailyChange, weekChange, monthChange, timeWeightMultiplier',
    relations: '++id, source, target, type, weight, direction, levelCoefficient',
    config: 'key'
}).upgrade(tx => {
    // 升级时给现有数据添加parentId
    return tx.table('sectors').toCollection().modify(sector => {
        if (!sector.parentId) {
            sector.parentId = null;
        }
    });
});

// 兼容旧版本
db.version(1).stores({
    sectors: 'id, name, level, volume, dailyChange, weekChange, monthChange, timeWeightMultiplier',
    relations: '++id, source, target, type, weight, direction, levelCoefficient',
    config: 'key'
});

// 板块管理API
const SectorDB = {
    // 获取所有板块
    async getAll() {
        return await db.sectors.toArray();
    },

    // 添加板块
    async add(sector) {
        return await db.sectors.add(sector);
    },

    // 更新板块
    async update(id, changes) {
        return await db.sectors.update(id, changes);
    },

    // 删除板块
    async delete(id) {
        // 同时删除相关的关联
        await db.relations.where('source').equals(id).delete();
        await db.relations.where('target').equals(id).delete();
        // 将子板块的parentId清空
        const children = await db.sectors.where('parentId').equals(id).toArray();
        for (const child of children) {
            await db.sectors.update(child.id, { parentId: null });
        }
        return await db.sectors.delete(id);
    },

    // 根据ID获取
    async get(id) {
        return await db.sectors.get(id);
    },

    // 获取子板块
    async getChildren(parentId) {
        return await db.sectors.where('parentId').equals(parentId).toArray();
    },

    // 获取顶级板块（无父级）
    async getRoots() {
        return await db.sectors.filter(s => !s.parentId).toArray();
    }
};

// 关联管理API
const RelationDB = {
    // 获取所有关联
    async getAll() {
        return await db.relations.toArray();
    },

    // 添加关联
    async add(relation) {
        return await db.relations.add(relation);
    },

    // 更新关联
    async update(id, changes) {
        return await db.relations.update(id, changes);
    },

    // 删除关联
    async delete(id) {
        return await db.relations.delete(id);
    }
};

// 初始化默认数据（首次使用时）
async function initDefaultData() {
    const count = await db.sectors.count();
    if (count === 0) {
        console.log('初始化默认数据...');

        // 默认板块 - 添加parentId层级关系
        await db.sectors.bulkAdd([
            { id: "xinnengyuanqiche", name: "新能源汽车", level: 1, parentId: null, volume: 100, dailyChange: 3.0, weekChange: 5.2, monthChange: 8.5, timeWeightMultiplier: 1.0 },
            { id: "donglidianchi", name: "动力电池", level: 2, parentId: "xinnengyuanqiche", volume: 80, dailyChange: 2.5, weekChange: 4.0, monthChange: 6.0, timeWeightMultiplier: 1.0 },
            { id: "gutaidianchi", name: "固态电池", level: 3, parentId: "donglidianchi", volume: 40, dailyChange: 1.8, weekChange: 3.5, monthChange: 10.2, timeWeightMultiplier: 1.0 },
            { id: "likuang", name: "锂矿", level: 2, parentId: null, volume: 60, dailyChange: -1.2, weekChange: -2.0, monthChange: -5.0, timeWeightMultiplier: 1.0 },
            { id: "chongdianzhuang", name: "充电桩", level: 2, parentId: "xinnengyuanqiche", volume: 50, dailyChange: 2.0, weekChange: 3.0, monthChange: 4.5, timeWeightMultiplier: 1.0 }
        ]);

        // 默认关联
        await db.relations.bulkAdd([
            { source: "xinnengyuanqiche", target: "donglidianchi", type: "应用", weight: 9, direction: "bidirectional", levelCoefficient: 0.8 },
            { source: "xinnengyuanqiche", target: "chongdianzhuang", type: "配套", weight: 7, direction: "bidirectional", levelCoefficient: 0.8 },
            { source: "donglidianchi", target: "gutaidianchi", type: "技术同源", weight: 8, direction: "bidirectional", levelCoefficient: 0.8 },
            { source: "donglidianchi", target: "likuang", type: "供应", weight: 8, direction: "forward", levelCoefficient: 1.0 },
            { source: "likuang", target: "gutaidianchi", type: "成本影响", weight: 6, direction: "forward", levelCoefficient: 0.8 },
            { source: "xinnengyuanqiche", target: "gutaidianchi", type: "需求影响", weight: 5, direction: "forward", levelCoefficient: 0.5 }
        ]);

        console.log('默认数据初始化完成');
    }
}
