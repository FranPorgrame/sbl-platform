"""Capa de acceso a la base de datos (PostgreSQL) — con registro (logging).

Igual que antes, pero ahora save_optimization DEJA CONSTANCIA en los logs:
si guarda bien, imprime el id; si falla, imprime el error completo. Así
podemos ver en los Deploy Logs de Railway exactamente qué ocurre.
"""
from __future__ import annotations

import os
import json
import traceback

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

_engine: Engine | None = None


def _normalize(url: str) -> str:
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    if "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


def get_engine() -> Engine | None:
    global _engine
    if _engine is not None:
        return _engine
    raw = os.getenv("DATABASE_URL")
    if not raw:
        print("[DB] No DATABASE_URL set — persistence disabled", flush=True)
        return None
    _engine = create_engine(_normalize(raw), pool_pre_ping=True)
    return _engine


def persistence_enabled() -> bool:
    return get_engine() is not None


def save_optimization(rules: dict, result: dict) -> int | None:
    engine = get_engine()
    if engine is None:
        print("[DB] save_optimization skipped — no engine", flush=True)
        return None
    try:
        with engine.begin() as conn:
            rules_id = conn.execute(
                text(
                    """
                    INSERT INTO collateral_rules
                        (loan_value, haircut_pct, issuer_limit_pct,
                         absolute_exposure_limit, max_pct_of_shares,
                         lot_size, existing_collateral)
                    VALUES
                        (:loan_value, :haircut_pct, :issuer_limit_pct,
                        :absolute_exposure_limit, :max_pct_of_shares,
                        :lot_size, CAST(:existing_collateral AS JSONB))
                    RETURNING id
                    """
                ),
                rules,
            ).scalar_one()

            result_id = conn.execute(
                text(
                    """
                    INSERT INTO optimization_results
                        (rules_id, status, collateral_needed,
                         collateral_provided, excess, proposal,
                         collateral_exposure, exposure_breach,
                         proposed_transactions, fully_resolved)
                    VALUES
                        (:rules_id, :status, :collateral_needed,
                         :collateral_provided, :excess, CAST(:proposal AS JSONB),
                         :collateral_exposure, :exposure_breach,
                         CAST(:proposed_transactions AS JSONB), :fully_resolved)
                    RETURNING id
                    """
                ),
                {
                    "rules_id": rules_id,
                    "status": result["status"],
                    "collateral_needed": result["collateral_needed"],
                    "collateral_provided": result["collateral_provided"],
                    "excess": result["excess"],
                    "proposal": json.dumps(result["proposal"]),
                    "collateral_exposure": result["collateral_exposure"],
                    "exposure_breach": result["exposure_breach"],
                    "proposed_transactions": json.dumps(result["proposed_transactions"]),
                    "fully_resolved": result["fully_resolved"],
                },
            ).scalar_one()
        print(f"[DB] save_optimization OK — result_id={result_id}", flush=True)
        return result_id
    except Exception as e:
        print(f"[DB] save_optimization FAILED: {e}", flush=True)
        traceback.print_exc()
        return None

def save_breach_execution(
    rules: dict,
    applied_transactions: list[dict],
    resolved_optimization_id: int,
    collateral_needed: float,
    collateral_provided: float,
    collateral_exposure: float,
) -> int | None:
    engine = get_engine()
    if engine is None:
        print("[DB] save_breach_execution skipped — no engine", flush=True)
        return None
    try:
        with engine.begin() as conn:
            rules_id = conn.execute(
                text(
                    """
                    INSERT INTO collateral_rules
                        (loan_value, haircut_pct, issuer_limit_pct,
                         absolute_exposure_limit, max_pct_of_shares,
                         lot_size, existing_collateral)
                    VALUES
                        (:loan_value, :haircut_pct, :issuer_limit_pct,
                        :absolute_exposure_limit, :max_pct_of_shares,
                        :lot_size, CAST(:existing_collateral AS JSONB))
                    RETURNING id
                    """
                ),
                rules,
            ).scalar_one()

            excess = collateral_provided - collateral_needed

            result_id = conn.execute(
                text(
                    """
                    INSERT INTO optimization_results
                        (rules_id, status, collateral_needed,
                         collateral_provided, excess, proposal,
                         collateral_exposure, exposure_breach,
                         applied_transactions, resolved_optimization_id)
                    VALUES
                        (:rules_id, 'RESOLVED', :collateral_needed,
                         :collateral_provided, :excess, CAST('[]' AS JSONB),
                         :collateral_exposure, FALSE,
                         CAST(:applied_transactions AS JSONB), :resolved_optimization_id)
                    RETURNING id
                    """
                ),
                {
                    "rules_id": rules_id,
                    "collateral_needed": collateral_needed,
                    "collateral_provided": collateral_provided,
                    "excess": excess,
                    "collateral_exposure": collateral_exposure,
                    "applied_transactions": json.dumps(applied_transactions),
                    "resolved_optimization_id": resolved_optimization_id,
                },
            ).scalar_one()
        print(f"[DB] save_breach_execution OK — result_id={result_id}", flush=True)
        return result_id
    except Exception as e:
        print(f"[DB] save_breach_execution FAILED: {e}", flush=True)
        traceback.print_exc()
        return None

def list_history(limit: int = 20) -> list[dict]:
    engine = get_engine()
    if engine is None:
        return []
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT r.id, r.status, r.collateral_needed,
                       r.collateral_provided, r.excess, r.created_at
                FROM optimization_results r
                ORDER BY r.created_at DESC
                LIMIT :limit
                """
            ),
            {"limit": limit},
        ).mappings().all()
    return [dict(row) for row in rows]