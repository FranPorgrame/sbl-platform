"""SBL Platform — API (FastAPI). Con registro del guardado en logs."""
from __future__ import annotations
import json

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from models import OptimizeRequest, OptimizeResponse, ProposedTransaction
from optimizer import (
    optimize as run_optimizer,
    check_exposure_breach,
    propose_breach_resolution,
    NoValidBreachResolutionError,
)
import db

app = FastAPI(
    title="SBL Platform API",
    description="Securities Borrowing and Lending — collateral optimization",
    version="0.3.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "persistence": db.persistence_enabled()}


@app.get("/history")
def history(limit: int = 20) -> dict:
    return {"history": db.list_history(limit)}


@app.post("/optimize", response_model=OptimizeResponse)
def optimize(req: OptimizeRequest) -> OptimizeResponse:
    result = run_optimizer(req)
    r = req.rules

    breach, exposure = check_exposure_breach(result, r)
    result.exposure_breach = breach
    result.collateral_exposure = round(exposure, 2)

    proposed_transactions: list[ProposedTransaction] = []
    fully_resolved = True

    if breach:
        try:
            proposed_transactions, fully_resolved = propose_breach_resolution(
                result.proposal, exposure, r.absolute_exposure_limit, r.lot_size, r.issuer_limit_pct
            )
        except NoValidBreachResolutionError as e:
            raise HTTPException(status_code=422, detail=str(e))

    result.proposed_transactions = proposed_transactions
    result.fully_resolved = fully_resolved

    saved_id = db.save_optimization(
        rules={
            "loan_value": r.loan_value,
            "haircut_pct": r.haircut_pct,
            "issuer_limit_pct": r.issuer_limit_pct,
            "absolute_exposure_limit": r.absolute_exposure_limit,
            "max_pct_of_shares": r.max_pct_of_shares,
            "lot_size": r.lot_size,
            "existing_collateral": json.dumps(r.existing_collateral),
        },
        result=result.model_dump(),
    )
    print(f"[API] /optimize done — status={result.status} saved_id={saved_id}", flush=True)
    return result