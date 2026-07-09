"""SBL Platform — API (FastAPI).

Expone el motor de optimización de colateral como servicio REST.
Cada optimización se guarda en PostgreSQL (reglas + resultado; NUNCA la
cartera del AM, por privacidad). Si no hay DATABASE_URL, corre sin persistir.
"""
from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()  # carga DATABASE_URL desde backend/.env si existe

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from models import OptimizeRequest, OptimizeResponse
from optimizer import optimize as run_optimizer
import db

app = FastAPI(
    title="SBL Platform API",
    description="Securities Borrowing and Lending — collateral optimization",
    version="0.2.0",
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restringir a los dominios del frontend en producción
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "persistence": db.persistence_enabled()}


@app.post("/optimize", response_model=OptimizeResponse)
def optimize(req: OptimizeRequest) -> OptimizeResponse:
    """Recibe portfolio + reglas, devuelve la propuesta óptima y la persiste."""
    result = run_optimizer(req)

    # Persistir SOLO reglas + resultado (nunca las posiciones/carteras).
    r = req.rules
    db.save_optimization(
        rules={
            "loan_value": r.loan_value,
            "haircut_pct": r.haircut_pct,
            "issuer_limit_pct": r.issuer_limit_pct,
            "absolute_exposure_limit": r.absolute_exposure_limit,
            "max_pct_of_shares": r.max_pct_of_shares,
            "lot_size": r.lot_size,
            "existing_collateral": r.existing_collateral,
        },
        result=result.model_dump(),
    )
    return result


@app.get("/history")
def history(limit: int = 20) -> dict:
    """Últimas optimizaciones guardadas (sin datos de cartera)."""
    return {"history": db.list_history(limit)}