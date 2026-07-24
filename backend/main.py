"""SBL Platform — API (FastAPI). Con registro del guardado en logs."""
from __future__ import annotations
import json

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from models import (
    OptimizeRequest,
    OptimizeResponse,
    ProposedTransaction,
    ExecuteBreachRequest,
    BreachAlternativeRequest,
    ExecuteIssuerBreachRequest,
)
from optimizer import (
    optimize as run_optimizer,
    check_exposure_breach,
    check_issuer_breach_pre_solve,
    propose_breach_resolution,
    propose_breach_alternative,
    propose_issuer_breach_resolution,
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
    r = req.rules

    # --- Issuer limit breach sobre el existing collateral (pre-solve) ---
    # El solver ya evita AGREGAR colateral a un ISIN que pasó su cap
    # (remaining_issuer_cap en optimize()), pero no puede deshacer lo que
    # el AM ya tenía pignorado. Eso se resuelve con un recall explícito.
    issuer_excesses = check_issuer_breach_pre_solve(req)
    name_by_isin = {p.isin: p.name for p in req.positions}
    price_by_isin = {p.isin: p.price for p in req.positions}

    issuer_breach_transactions: list[ProposedTransaction] = []
    for isin, excess_mv in issuer_excesses.items():
        try:
            issuer_breach_transactions.append(
                propose_issuer_breach_resolution(
                    isin=isin,
                    excess_mv=excess_mv,
                    price=price_by_isin[isin],
                    name=name_by_isin[isin],
                    lot_size=r.lot_size,
                    existing_shares=r.existing_collateral[isin],
                )
            )
        except NoValidBreachResolutionError as e:
            print(f"[API] issuer breach sin resolución para {isin}: {e}", flush=True)

    # --- Optimizer ---
    result = run_optimizer(req)

    # --- AEL breach (post-solve, como ya estaba) ---
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
            raise HTTPException(
                status_code=422,
                detail={"error_code": "no_valid_breach_resolution", "message": str(e)}
            )

    result.proposed_transactions = proposed_transactions
    result.fully_resolved = fully_resolved

    # --- Campos nuevos del issuer breach ---
    result.issuer_breach = len(issuer_breach_transactions) > 0
    result.issuer_breach_transactions = issuer_breach_transactions

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
    print(f"[API] /optimize done — status={result.status} saved_id={saved_id} issuer_breach={result.issuer_breach}", flush=True)
    result.id = saved_id
    return result


@app.post("/execute-breach-resolution")
def execute_breach_resolution(req: ExecuteBreachRequest):
    recalled_value = sum(t.market_value for t in req.applied_transactions)
    new_provided = req.collateral_provided - recalled_value
    new_exposure = new_provided - req.collateral_needed

    result_id = db.save_breach_execution(
        rules=req.rules,
        applied_transactions=[t.model_dump() for t in req.applied_transactions],
        resolved_optimization_id=req.optimization_id,
        collateral_needed=req.collateral_needed,
        collateral_provided=new_provided,
        collateral_exposure=new_exposure,
    )
    if result_id is None:
        raise HTTPException(status_code=500, detail="The breach execution could not be saved.")
    return {"result_id": result_id, "collateral_provided": new_provided, "collateral_exposure": new_exposure}


@app.post("/execute-issuer-breach-resolution")
def execute_issuer_breach_resolution(req: ExecuteIssuerBreachRequest):
    current_shares = req.existing_collateral.get(req.isin)
    if current_shares is None:
        raise HTTPException(
            status_code=422,
            detail={"error_code": "isin_not_in_existing_collateral",
                    "message": f"{req.isin} no tiene existing collateral para hacer recall."}
        )
    if req.shares_recalled <= 0:
        raise HTTPException(
            status_code=422,
            detail={"error_code": "invalid_recall_amount",
                    "message": "El recall debe ser mayor que cero."}
        )
    if req.shares_recalled > current_shares:
        raise HTTPException(
            status_code=422,
            detail={"error_code": "recall_exceeds_existing",
                    "message": f"El recall ({req.shares_recalled}) supera el existing "
                               f"collateral de {req.isin} ({current_shares})."}
        )

    new_shares = current_shares - req.shares_recalled

    # Dejamos la clave con 0 en vez de borrarla: el frontend lee
    # updated_existing_collateral[isin] y un undefined rompería el payload
    # del siguiente /optimize (Pydantic espera dict[str, int]).
    updated_existing_collateral = dict(req.existing_collateral)
    updated_existing_collateral[req.isin] = new_shares

    needed_gross = req.rules.loan_value * (1 + req.rules.haircut_pct / 100)
    issuer_cap = (
        (req.rules.issuer_limit_pct / 100) * needed_gross
        if req.rules.issuer_limit_pct > 0 else None
    )

    new_mv = new_shares * req.price
    still_breached = issuer_cap is not None and new_mv > issuer_cap
    remaining_excess = round(max(0.0, new_mv - issuer_cap), 2) if issuer_cap is not None else 0.0

    print(
        f"[API] issuer breach — {req.isin} {current_shares} -> {new_shares} "
        f"still_breached={still_breached} remaining_excess={remaining_excess}",
        flush=True,
    )

    return {
        "isin": req.isin,
        "updated_existing_collateral": updated_existing_collateral,
        "recalled_market_value": round(req.shares_recalled * req.price, 2),
        "new_existing_mv": round(new_mv, 2),
        "issuer_cap": round(issuer_cap, 2) if issuer_cap is not None else None,
        "still_breached": still_breached,
        "remaining_excess": remaining_excess,
    }


@app.post("/propose-breach-alternative")
def propose_breach_alternative_endpoint(req: BreachAlternativeRequest):
    # Tope de 5 intentos — el intento 1 es la propuesta automática inicial
    if req.attempt_number >= 5:
        raise HTTPException(
            status_code=422,
            detail={"error_code": "max_attempts_reached",
                    "message": "The maximum of 5 attempts was reached."}
        )

    # Reconstruimos el proposal desde las posiciones, corriendo el optimizer.
    opt_result = run_optimizer(
        OptimizeRequest(positions=req.positions, rules=req.rules)
    )
    collateral_exposure = req.collateral_provided - req.collateral_needed

    try:
        transactions, fully_resolved = propose_breach_alternative(
            proposal=opt_result.proposal,
            collateral_exposure=collateral_exposure,
            absolute_exposure_limit=req.rules.absolute_exposure_limit,
            lot_size=req.rules.lot_size,
            issuer_limit_pct=req.rules.issuer_limit_pct,
            previous_attempts=req.previous_attempts,
        )
    except NoValidBreachResolutionError as e:
        raise HTTPException(
            status_code=422,
            detail={"error_code": "no_alternative_found", "message": str(e)}
        )

    return {
        "proposed_transactions": [t.model_dump() for t in transactions],
        "fully_resolved": fully_resolved,
        "collateral_exposure": collateral_exposure,
    }