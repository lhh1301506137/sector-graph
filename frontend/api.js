/**
 * 板块轮动预测系统 V0.5 - API 调用封装
 */

const API_BASE = ''; // 同域部署

async function requestJSON(path, options = {}) {
    const res = await fetch(path, options);
    let data = null;

    try {
        data = await res.json();
    } catch (_) {
        data = null;
    }

    if (!res.ok) {
        const msg = data && (
            data.error ||
            (data.detail && (data.detail.error || data.detail))
        ) ? (data.error || data.detail.error || data.detail) : `HTTP ${res.status}`;
        const err = new Error(msg);
        err.payload = data;
        throw err;
    }

    // 兼容历史后端：部分错误以 {"error": "..."} + 200 返回
    if (data && typeof data === 'object' && data.error) {
        const err = new Error(data.error);
        err.payload = data;
        throw err;
    }

    return data;
}

const API = {
    // ============ 板块 ============
    async getSectors(params = {}) {
        const url = new URL('/api/sectors', location.origin);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
        });
        return requestJSON(url);
    },

    async refreshSectors() {
        return requestJSON('/api/sectors/refresh', { method: 'POST' });
    },

    async updateSector(id, updates) {
        return requestJSON(`/api/sectors/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
    },

    async deleteSector(id) {
        return requestJSON(`/api/sectors/${id}`, { method: 'DELETE' });
    },

    async getSectorDaily(id, days = 30) {
        return requestJSON(`/api/sectors/${id}/daily?days=${days}`);
    },

    // ============ 关联 ============
    async getRelations(params = {}) {
        const url = new URL('/api/relations', location.origin);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
        });
        return requestJSON(url);
    },

    async createRelation(data) {
        return requestJSON('/api/relations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },

    async updateRelation(id, data) {
        return requestJSON(`/api/relations/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },

    async deleteRelation(id) {
        return requestJSON(`/api/relations/${id}`, { method: 'DELETE' });
    },

    async getRelationTypes() {
        return requestJSON('/api/relation-types');
    },

    // ============ 得分 ============
    async runScoring() {
        return requestJSON('/api/scoring/run', { method: 'POST' });
    },

    async getLatestDataQuality(targetDate = '') {
        const q = targetDate ? `?target_date=${encodeURIComponent(targetDate)}` : '';
        return requestJSON(`/api/data-quality/latest${q}`);
    },

    async getDataQualityTrend(days = 10) {
        return requestJSON(`/api/data-quality/trend?days=${encodeURIComponent(days)}`);
    },

    async getFailedDataQualityRows(params = {}) {
        const url = new URL('/api/data-quality/failed', location.origin);
        if (params.targetDate) url.searchParams.set('target_date', params.targetDate);
        if (params.reason) url.searchParams.set('reason', params.reason);
        if (params.categoryType) url.searchParams.set('category_type', params.categoryType);
        if (params.search) url.searchParams.set('search', params.search);
        if (params.limit !== undefined && params.limit !== null && params.limit !== '') {
            url.searchParams.set('limit', String(params.limit));
        }
        return requestJSON(url);
    },

    async getRanking(params = {}) {
        const url = new URL('/api/ranking', location.origin);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
        });
        return requestJSON(url);
    },

    // ============ 逻辑词库 ============
    async getLogics() {
        return requestJSON('/api/logics');
    },

    async createLogic(data) {
        return requestJSON('/api/logics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },

    async deleteLogic(id) {
        return requestJSON(`/api/logics/${id}`, { method: 'DELETE' });
    },

    // ============ AI 分析 ============
    async runAIAnalyze(batchSize = 10) {
        return requestJSON('/api/ai/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch_size: batchSize }),
        });
    },

    async getAIPending() {
        return requestJSON('/api/ai/pending');
    },

    async clearAIPending() {
        return requestJSON('/api/ai/clear-pending', { method: 'POST' });
    },

    async confirmAIResults(items) {
        return requestJSON('/api/ai/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items),
        });
    },

    // ============ 系统配置 ============
    async generateOptimizationSuggestion(runId = '') {
        return requestJSON('/api/ai/optimization/suggestions/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ run_id: runId || '' }),
        });
    },

    async getOptimizationSuggestions(limit = 10, runId = '') {
        const q = new URLSearchParams();
        q.set('limit', String(limit));
        if (runId) q.set('run_id', String(runId));
        return requestJSON(`/api/ai/optimization/suggestions?${q.toString()}`);
    },

    async getConfig() {
        return requestJSON('/api/config');
    },

    async saveConfig(data) {
        return requestJSON('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    },

    async getConfigVersioningStatus() {
        return requestJSON('/api/config/versioning/status');
    },

    async getConfigVersions(limit = 20) {
        return requestJSON(`/api/config/versions?limit=${encodeURIComponent(limit)}`);
    },

    async saveConfigVersion(payload) {
        return requestJSON('/api/config/versions/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
        });
    },

    async applyConfigVersion(versionId, reasonOrOptions = '') {
        const payload = (reasonOrOptions && typeof reasonOrOptions === 'object')
            ? reasonOrOptions
            : { reason: reasonOrOptions || '' };
        return requestJSON(`/api/config/versions/${encodeURIComponent(versionId)}/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    },

    async getDataSourcesHealth() {
        return requestJSON('/api/data-sources/health');
    },

    async applyRecommendedDataSource() {
        return requestJSON('/api/data-sources/recommend/apply', { method: 'POST' });
    },

    // ============ 回测 ============
    async runBacktest(days = 60) {
        return requestJSON(`/api/backtest/run?days=${days}`, { method: 'POST' });
    },

    async getBacktestJobs(limit = 20) {
        return requestJSON(`/api/backtest/jobs?limit=${limit}`);
    },

    async getBacktestJob(runId) {
        return requestJSON(`/api/backtest/jobs/${encodeURIComponent(runId)}`);
    },

    async cancelBacktestJob(runId) {
        return requestJSON(`/api/backtest/jobs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
    },

    async retryBacktestJob(runId) {
        return requestJSON(`/api/backtest/jobs/${encodeURIComponent(runId)}/retry`, { method: 'POST' });
    },

    async getBacktestResults(limit = 30, runId = '') {
        const q = new URLSearchParams();
        q.set('limit', String(limit));
        if (runId) q.set('run_id', String(runId));
        return requestJSON(`/api/backtest/results?${q.toString()}`);
    },

    async getBacktestDayDetail(date, runId = '') {
        const q = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
        return requestJSON(`/api/backtest/results/${date}${q}`);
    },

    // ============ AI 解释 ============
    async explainSectorScore(sectorId, date) {
        return requestJSON(`/api/sectors/${sectorId}/explain?target_date=${date}`, {
            method: 'POST',
        });
    },

    // ============ 系统自愈 ============
    async clearUnlockedRelations() {
        return requestJSON('/api/relations/unlocked', { method: 'DELETE' });
    },

    async getSyncStatus() {
        return requestJSON('/api/sync-status');
    },

    async getMaintenanceInspectionLatest(alertsLimit = 5) {
        return requestJSON(`/api/maintenance/inspection/latest?alerts_limit=${encodeURIComponent(alertsLimit)}`);
    },

    // ============ 摘要 ============
    async getSummary() {
        return requestJSON('/api/summary');
    },

    // ============ 健康检查 ============
    async healthCheck() {
        return requestJSON('/api/health');
    },
};
