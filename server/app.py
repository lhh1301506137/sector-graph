# server/app.py
# FastAPI 主入口 - 板块轮动预测系统 V0.4

import os
import sys
from contextlib import asynccontextmanager

# 确保项目根目录在 Python 路径中
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from server.database import init_db, SessionLocal
from server.config import init_default_config


def _runtime_base_url() -> str:
    host = str(os.getenv("APP_HOST", "127.0.0.1") or "127.0.0.1").strip()
    port = str(os.getenv("APP_PORT", "8000") or "8000").strip()
    display_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
    return f"http://{display_host}:{port}"


# ============================================================
# 启动/关闭事件
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时初始化数据库和配置"""
    print("=" * 50)
    print("Sector Graph System V0.4 starting...")
    print("=" * 50)

    # 初始化数据库表
    init_db()

    from server.config import init_default_config, init_default_logics

    # 初始化默认配置
    db = SessionLocal()
    try:
        init_default_config(db)
        init_default_logics(db)
    finally:
        db.close()

    base_url = _runtime_base_url()
    print("=" * 50)
    print(f"System ready: {base_url}")
    print(f"API docs: {base_url}/docs")
    print("=" * 50)

    yield  # 应用运行中

    print("System stopped.")


# 创建 FastAPI 应用
app = FastAPI(
    title="板块轮动预测系统",
    description="A股板块关系图谱与轮动预测",
    version="0.4",
    lifespan=lifespan
)

# ============================================================
# 注册路由（后续Step中逐步添加）
# ============================================================

from server.routes.sector_routes import router as sector_router
app.include_router(sector_router, prefix="/api")

from server.routes.relation_routes import router as relation_router
app.include_router(relation_router, prefix="/api")

from server.routes.score_routes import router as score_router
app.include_router(score_router, prefix="/api")

from server.routes.logic_routes import router as logic_router
app.include_router(logic_router, prefix="/api")

from server.routes.ai_routes import router as ai_router
app.include_router(ai_router, prefix="/api")

from server.routes.config_routes import router as config_router
app.include_router(config_router, prefix="/api")

from server.routes.backtest_routes import router as backtest_router
app.include_router(backtest_router, prefix="/api")

from server.routes.summary_routes import router as summary_router
app.include_router(summary_router, prefix="/api")

from server.routes.maintenance_routes import router as maintenance_router
app.include_router(maintenance_router, prefix="/api")


# ============================================================
# 托管前端静态文件
# ============================================================

FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")

# 确保 frontend 目录存在
os.makedirs(FRONTEND_DIR, exist_ok=True)


@app.get("/")
async def serve_index():
    """首页 → 返回前端 index.html"""
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "板块轮动预测系统 V0.4 - 前端文件待创建", "status": "ok"}


# 挂载静态文件目录（CSS、JS等）
if os.path.exists(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


# ============================================================
# 健康检查接口
# ============================================================

@app.get("/api/health")
async def health_check():
    """健康检查"""
    return {"status": "ok", "version": "0.4"}




# ============================================================
# 直接运行入口
# ============================================================

if __name__ == "__main__":
    import uvicorn
    host = str(os.getenv("APP_HOST", "0.0.0.0") or "0.0.0.0").strip()
    try:
        port = int(str(os.getenv("APP_PORT", "8000") or "8000").strip())
    except ValueError:
        port = 8000
    uvicorn.run(
        "server.app:app",
        host=host,
        port=port,
        reload=True  # 开发模式：代码修改自动重启
    )
