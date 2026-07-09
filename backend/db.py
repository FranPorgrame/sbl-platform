"""Capa de acceso a la base de datos (PostgreSQL).

Medidas de seguridad del MVP incorporadas:
  - La credencial (DATABASE_URL) se lee de una VARIABLE DE ENTORNO, nunca
    se escribe en el código ni se sube a GitHub (.env está en .gitignore).
  - Conexión TLS/SSL forzada (sslmode=require) para cifrar el tráfico.
  - NO se persisten las carteras del AM (tabla positions): solo se guardan
    las reglas usadas y el resultado de cada optimización. Decisión de
    privacidad deliberada.

Si DATABASE_URL no está definida, el backend sigue funcionando en modo
"sin persistencia" (calcula pero no guarda), útil para desarrollo.
"""
from __future__ import annotations

import os
import json

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

_engine: Engine | None = None


def _normalize(url: str) -> str:
    # Railway entrega 'postgresql://...'; forzamos driver psycopg y SSL.
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg://", 1)
    elif url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    if "sslmode=" not in url:
        url += ("&" if "?" in url else "?") + "sslmode=require"
    return url


def get_engine() -> Engine | None:
    """Devuelve el engine, o None si no hay DATABASE_URL configurada."""
    global _engine
    if _engine is not None:
        return _engine
    raw = os.getenv("DATABASE_URL")
    if not raw:
        return None
    _engine = create_engine(_normalize(raw), pool_pre_ping=True)
    return _engine


def persistence_enabled() -> bool:
    return get_engine() is not None


def save_optimization(rules: dict, result: dict) -> int | None:
    """Guarda las reglas + el resultado. NO guarda las posiciones (privacidad).

    Devuelve el id del resultado insertado, o None si no hay persistencia.
    """
    engine = get_engine()
    if engine is None:
        return None

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
                     :lot_size, :existing_collateral)
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
                     collateral_provided, excess, proposal)
                VALUES
                    (:rules_id, :status, :collateral_needed,
                     :collateral_provided, :excess, CAST(:proposal AS JSONB))
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
            },
        ).scalar_one()

    return result_id


def list_history(limit: int = 20) -> list[dict]:
    """Devuelve las últimas optimizaciones guardadas (sin carteras)."""
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