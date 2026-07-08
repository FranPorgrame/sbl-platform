"""Pydantic models — contratos de datos de entrada y salida de la API.

Pydantic valida estrictamente cada campo antes de que llegue al motor de
optimización: ningún número corrupto o tipo equivocado entra al cálculo.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class Position(BaseModel):
    """Una posición del portfolio.

    Cantidad positiva -> libro largo (colateral disponible).
    Cantidad negativa -> libro corto (borrowing).
    """
    name: str
    isin: str
    quantity: float
    price: float = Field(gt=0)


class Rules(BaseModel):
    """Reglas del SBL Desk + reglas internas del AM."""
    loan_value: float = Field(ge=0)
    haircut_pct: float = Field(ge=0, description="Margen de sobre-cobertura sobre el loan")
    issuer_limit_pct: float = Field(ge=0, le=100, description="Máx % del colateral necesario por emisor")
    absolute_exposure_limit: float | None = Field(default=None, ge=0)
    max_pct_of_shares: float = Field(default=100, ge=0, le=100)
    lot_size: int = Field(default=1, ge=1)
    existing_collateral: float = Field(default=0, ge=0)


class OptimizeRequest(BaseModel):
    positions: list[Position]
    rules: Rules
    currency: str = "CHF"


class ProposedLine(BaseModel):
    name: str
    isin: str
    proposed_shares: int
    proposed_mv: float
    pct_of_position: float


class OptimizeResponse(BaseModel):
    status: str                       # OPTIMAL | FEASIBLE | INFEASIBLE
    collateral_needed: float
    collateral_provided: float
    excess: float
    proposal: list[ProposedLine]
