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

from models import OptimizeRequest, OptimizeResponse, ProposedLine, ProposedTransaction


def optimize(req: OptimizeRequest) -> OptimizeResponse:
    r = req.rules
    longs = [p for p in req.positions if p.quantity > 0]

    price_by_isin = {p.isin: p.price for p in req.positions}
    existing_collateral_value = sum(
        shares * price_by_isin[isin]
        for isin, shares in r.existing_collateral.items()
    )

    needed_gross = r.loan_value * (1 + r.haircut_pct / 100)
    needed = max(0.0, needed_gross - existing_collateral_value)

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



import math

class NoValidBreachResolutionError(Exception):
    """No se encontró ninguna combinación de recall que resuelva
    el AEL breach sin generar un nuevo issuer limit breach."""
    pass


def check_issuer_limit_post_recall(proposal: list, transactions: list["ProposedTransaction"]) -> dict[str, float]:
    """Simula el proposal después de aplicar las transactions y devuelve
    el % de cada ISIN restante sobre el nuevo total pledgeado."""
    recalled_by_isin = {t.isin: t.shares for t in transactions}

    remaining_mv_by_isin = {}
    for position in proposal:
        recalled_shares = recalled_by_isin.get(position.isin, 0)
        remaining_shares = position.proposed_shares - recalled_shares
        if remaining_shares <= 0:
            continue
        price_per_share = position.proposed_mv / position.proposed_shares
        remaining_mv_by_isin[position.isin] = remaining_shares * price_per_share

    new_total = sum(remaining_mv_by_isin.values())
    if new_total == 0:
        return {}

    return {isin: (mv / new_total) * 100 for isin, mv in remaining_mv_by_isin.items()}


def _greedy_recall(proposal, min_recall, max_recall, lot_size):
    sorted_proposal = sorted(proposal, key=lambda p: p.proposed_mv, reverse=True)
    transactions = []
    recalled_so_far = 0.0

    for position in sorted_proposal:
        if recalled_so_far >= min_recall:
            break
        if position.proposed_shares == 0:
            continue

        price_per_share = position.proposed_mv / position.proposed_shares
        lot_value = price_per_share * lot_size
        if lot_value == 0:
            continue

        remaining_room = max_recall - recalled_so_far
        max_lots_here = min(
            position.proposed_shares // lot_size,
            int(remaining_room // lot_value),
        )
        lots_needed = math.ceil((min_recall - recalled_so_far) / lot_value)
        lots_to_recall = min(max_lots_here, max(lots_needed, 1))

        if lots_to_recall <= 0:
            continue

        shares_to_recall = lots_to_recall * lot_size
        mv_to_recall = shares_to_recall * price_per_share

        transactions.append(ProposedTransaction(
            name=position.name, isin=position.isin, action="recall",
            shares=shares_to_recall, market_value=round(mv_to_recall, 2),
        ))
        recalled_so_far += mv_to_recall

    return transactions, recalled_so_far


def _proportional_recall(proposal, min_recall, max_recall, lot_size):
    total_mv = sum(p.proposed_mv for p in proposal if p.proposed_shares > 0)
    if total_mv == 0:
        return [], 0.0

    target = (min_recall + max_recall) / 2
    transactions = []
    recalled_so_far = 0.0

    for position in proposal:
        if position.proposed_shares == 0:
            continue
        price_per_share = position.proposed_mv / position.proposed_shares
        lot_value = price_per_share * lot_size
        if lot_value == 0:
            continue

        share_of_target = target * (position.proposed_mv / total_mv)
        lots_to_recall = min(
            position.proposed_shares // lot_size,
            round(share_of_target / lot_value),
        )
        if lots_to_recall <= 0:
            continue

        shares_to_recall = lots_to_recall * lot_size
        mv_to_recall = shares_to_recall * price_per_share

        transactions.append(ProposedTransaction(
            name=position.name, isin=position.isin, action="recall",
            shares=shares_to_recall, market_value=round(mv_to_recall, 2),
        ))
        recalled_so_far += mv_to_recall

    return transactions, recalled_so_far


def propose_breach_resolution(
    proposal: list,
    collateral_exposure: float,
    absolute_exposure_limit: float,
    lot_size: int,
    issuer_limit_pct: float,
) -> tuple[list["ProposedTransaction"], bool]:
    min_recall = collateral_exposure - absolute_exposure_limit
    max_recall = collateral_exposure

    no_transactions_found = True
    issuer_breach_found = False

    for strategy in (_greedy_recall, _proportional_recall):
        transactions, recalled_so_far = strategy(proposal, min_recall, max_recall, lot_size)
        fully_resolved = recalled_so_far >= min_recall

        if not transactions:
            continue

        no_transactions_found = False
        issuer_pcts = check_issuer_limit_post_recall(proposal, transactions)
        issuer_breach = any(pct > issuer_limit_pct for pct in issuer_pcts.values())

        if not issuer_breach:
            return transactions, fully_resolved

        issuer_breach_found = True

    if no_transactions_found:
        raise NoValidBreachResolutionError(
            "No se pudo generar ninguna transacción de recall: el excedente a recuperar "
            "es menor al valor de un lote mínimo de cualquier posición disponible."
        )
    raise NoValidBreachResolutionError(
        "No se encontró ninguna combinación de recall que resuelva el AEL breach "
        "sin generar un nuevo issuer limit breach."
    )
