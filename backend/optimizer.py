"""Motor de optimización de colateral — MILP con Google OR-Tools.

Función objetivo: minimizar el colateral total inmovilizado.
Como el requerimiento es constante, minimizar el colateral bruto pignorado
equivale a minimizar el EXCESO sobre el requerimiento. Lo único que impide
que el exceso sea cero exacto es la granularidad del lot size — por eso es
un problema entero (MILP) y no una simple división.

Variables de decisión:
    lots_i  (entero >= 0)  ->  shares_i = lots_i * lot_size

Objetivo:
    min  sum_i (shares_i * price_i)

Sujeto a:
    (cobertura)   sum_i (shares_i * price_i)          >= needed
    (emisor)      shares_i * price_i                   <= issuer_cap
    (max shares)  shares_i                             <= max_pct * owned_i
    (lote)        shares_i = lots_i * lot_size,  lots_i entero

absolute_exposure_limit ya NO es una restricción del solver: es un umbral de
alerta post-optimización, evaluado por check_exposure_breach() sobre el
resultado ya calculado.
"""
from __future__ import annotations

from ortools.linear_solver import pywraplp

from models import OptimizeRequest, OptimizeResponse, ProposedLine


def optimize(req: OptimizeRequest) -> OptimizeResponse:
    r = req.rules
    longs = [p for p in req.positions if p.quantity > 0]

    needed_gross = r.loan_value * (1 + r.haircut_pct / 100)
    needed = max(0.0, needed_gross - r.existing_collateral)

    issuer_cap = (r.issuer_limit_pct / 100) * needed_gross if r.issuer_limit_pct > 0 else None
    lot = r.lot_size

    solver = pywraplp.Solver.CreateSolver("CBC")
    if solver is None:
        raise RuntimeError("OR-Tools CBC solver no disponible")

    lot_vars: dict[str, object] = {}
    for p in longs:
        # Cota superior de lotes: el mínimo entre lo que permite cada regla.
        caps_shares = [p.quantity * (r.max_pct_of_shares / 100)]
        if issuer_cap is not None:
            caps_shares.append(issuer_cap / p.price)
        max_shares = min(caps_shares)
        max_lots = int(max_shares // lot)
        if max_lots <= 0:
            continue
        lot_vars[p.isin] = solver.IntVar(0, max_lots, f"lots_{p.isin}")

    price_by_isin = {p.isin: p.price for p in longs}
    qty_by_isin = {p.isin: p.quantity for p in longs}
    name_by_isin = {p.isin: p.name for p in longs}

    # Valor de mercado pignorado por nombre y total.
    total_mv = solver.Sum(
        lot_vars[isin] * (lot * price_by_isin[isin]) for isin in lot_vars
    )

    # Restricción de cobertura.
    solver.Add(total_mv >= needed)

    # Objetivo: minimizar el colateral total (== minimizar el exceso).
    solver.Minimize(total_mv)

    result = solver.Solve()

    status_map = {
        pywraplp.Solver.OPTIMAL: "OPTIMAL",
        pywraplp.Solver.FEASIBLE: "FEASIBLE",
        pywraplp.Solver.INFEASIBLE: "INFEASIBLE",
    }
    status = status_map.get(result, "INFEASIBLE")

    proposal: list[ProposedLine] = []
    provided = 0.0
    if status in ("OPTIMAL", "FEASIBLE"):
        for isin, var in lot_vars.items():
            shares = int(round(var.solution_value())) * lot
            if shares <= 0:
                continue
            mv = shares * price_by_isin[isin]
            provided += mv
            proposal.append(
                ProposedLine(
                    name=name_by_isin[isin],
                    isin=isin,
                    proposed_shares=shares,
                    proposed_mv=round(mv, 2),
                    pct_of_position=round(100 * shares / qty_by_isin[isin], 2),
                )
            )
        proposal.sort(key=lambda x: x.proposed_mv, reverse=True)

    return OptimizeResponse(
        status=status,
        collateral_needed=round(needed, 2),
        collateral_provided=round(provided, 2),
        excess=round(provided - needed, 2),
        proposal=proposal,
    )


def check_exposure_breach(result: OptimizeResponse, rules) -> tuple[bool, float]:
    """Evalúa el Collateral Exposure del resultado ya optimizado contra el AEL.

    Collateral Exposure = Total Collateral provisto - Needed. No modifica
    el resultado del optimizer de ninguna manera, solo evalúa y reporta.
    """
    exposure = result.collateral_provided - result.collateral_needed
    if rules.absolute_exposure_limit is None:
        return False, exposure
    breach = abs(exposure) > rules.absolute_exposure_limit
    return breach, exposure
