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
    absolute_exposure_limit: float | None = Field(
        default=None, ge=0,
        description="Umbral de alerta post-optimización sobre el Collateral Exposure "
                    "(Total Collateral provisto - Needed). Ya NO limita al solver.",
    )
    max_pct_of_shares: float = Field(default=100, ge=0, le=100)
    lot_size: int = Field(default=1, ge=1)
    existing_collateral: dict[str, int] = Field(default_factory=dict)


from pydantic import BaseModel, model_validator

class OptimizeRequest(BaseModel):
    positions: list[Position]
    rules: Rules
    currency: str = "CHF"

    @model_validator(mode="after")
    def validate_existing_collateral_isins(self):
        portfolio_isins = {p.isin for p in self.positions}
        missing = set(self.rules.existing_collateral.keys()) - portfolio_isins
        if missing:
            raise ValueError(
                f"Existing collateral contiene ISIN(s) sin match en el portfolio: "
                f"{', '.join(sorted(missing))}. Subí un Excel con ISIN correcto."
            )
        return self


class ProposedLine(BaseModel):
    name: str
    isin: str
    proposed_shares: int
    proposed_mv: float
    pct_of_position: float



class ProposedTransaction(BaseModel):
    name: str
    isin: str
    action: str  # "recall" o "pledge"
    shares: int
    market_value: float


class OptimizeResponse(BaseModel):
    status: str                       # OPTIMAL | FEASIBLE | INFEASIBLE
    collateral_needed: float
    collateral_provided: float
    excess: float
    proposal: list[ProposedLine]
    collateral_exposure: float = 0.0
    exposure_breach: bool = False
    proposed_transactions: list[ProposedTransaction] = []
    fully_resolved: bool = True
