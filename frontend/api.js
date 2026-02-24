/**
 * 板块轮动预测系统 V0.4 - API调用封装
 */

const API_BASE = '';  // 同域，无需指定

const API = {
    // ============ 板块 ============
    async getSectors(params = {}) {
        const url = new URL('/api/sectors', location.origin);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
        });
        const res = await fetch(url);
        return res.json();
    },

    async refreshSectors() {
        const res = await fetch('/api/sectors/refresh', { method: 'POST' });
        return res.json();
    },

    async updateSector(id, updates) {
        const res = await fetch(`/api/sectors/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        return res.json();
    },

    async getSectorDaily(id, days = 30) {
        const res = await fetch(`/api/sectors/${id}/daily?days=${days}`);
        return res.json();
    },

    // ============ 关联 ============
    async getRelations(params = {}) {
        const url = new URL('/api/relations', location.origin);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
        });
        const res = await fetch(url);
        return res.json();
    },

    async createRelation(data) {
        const res = await fetch('/api/relations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        return res.json();
    },

    async updateRelation(id, data) {
        const res = await fetch(`/api/relations/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        return res.json();
    },

    async deleteRelation(id) {
        const res = await fetch(`/api/relations/${id}`, { method: 'DELETE' });
        return res.json();
    },

    async getRelationTypes() {
        const res = await fetch('/api/relation-types');
        return res.json();
    },

    // ============ 得分 ============
    async runScoring() {
        const res = await fetch('/api/scoring/run', { method: 'POST' });
        return res.json();
    },

    async getRanking(params = {}) {
        const url = new URL('/api/ranking', location.origin);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
        });
        const res = await fetch(url);
        return res.json();
    },

    // ============================================================
    // 逻辑词库 API (Step 6.5)
    // ============================================================
    async getLogics() {
        const res = await fetch('/api/logics');
        return res.json();
    },
    async createLogic(data) {
        const res = await fetch('/api/logics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return res.json();
    },
    async deleteLogic(id) {
        const res = await fetch(`/api/logics/${id}`, { method: 'DELETE' });
        return res.json();
    },

    // ============================================================
    // AI 分析 API (Step 7)
    // ============================================================
    async runAIAnalyze(batchSize = 10) {
        const res = await fetch('/api/ai/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch_size: batchSize })
        });
        return res.json();
    },
    async getAIPending() {
        const res = await fetch('/api/ai/pending');
        return res.json();
    },
    async clearAIPending() {
        const res = await fetch('/api/ai/clear-pending', { method: 'POST' });
        return res.json();
    },
    async confirmAIResults(items) {
        const res = await fetch('/api/ai/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items)
        });
        return res.json();
    },

    // ============================================================
    // 系统配置 API (Step 10)
    // ============================================================
    async getConfig() {
        const res = await fetch('/api/config');
        return res.json();
    },
    async saveConfig(data) {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return res.json();
    },

    // ============================================================
    // 回测验证 API (Step 8)
    // ============================================================
    async runBacktest(days = 60) {
        const res = await fetch(`/api/backtest/run?days=${days}`, { method: 'POST' });
        return res.json();
    },
    // ============================================================
    // 回测复盘
    // ============================================================
    async getBacktestResults(limit = 30) {
        const res = await fetch(`/api/backtest/results?limit=${limit}`);
        return res.json();
    },
    async getBacktestDayDetail(date) {
        const res = await fetch(`/api/backtest/results/${date}`);
        return res.json();
    },

    // ============================================================
    // AI 解释器 (Step 13)
    // ============================================================
    async explainSectorScore(sectorId, date) {
        const res = await fetch(`/api/sectors/${sectorId}/explain?target_date=${date}`, {
            method: 'POST'
        });
        return res.json();
    },

    // ============================================================
    // 系统管理与自愈 (Step 14)
    // ============================================================
    async clearUnlockedRelations() {
        const res = await fetch('/api/relations/unlocked', { method: 'DELETE' });
        return res.json();
    },

    async getSyncStatus() {
        const res = await fetch('/api/sync-status');
        return res.json();
    },


    // ============ 系统摘要 ============
    async getSummary() {
        const res = await fetch('/api/summary');
        return res.json();
    },

    // ============ 系统 ============
    async healthCheck() {
        const res = await fetch('/api/health');
        return res.json();
    },
};
