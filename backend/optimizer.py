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

import math

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
            existing_mv_this_isin = r.existing_collateral.get(p.isin, 0) * p.price
            remaining_issuer_cap = max(0.0, issuer_cap - existing_mv_this_isin)
            caps_shares.append(remaining_issuer_cap / p.price)
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


def check_issuer_breach_pre_solve(req: OptimizeRequest) -> dict[str, float]:
    """Compara el existing collateral de cada ISIN contra el issuer cap,
    ANTES de correr el solver. Devuelve {isin: exceso_en_CHF}."""
    r = req.rules
    price_by_isin = {p.isin: p.price for p in req.positions}

    if r.issuer_limit_pct <= 0:
        return {}

    needed_gross = r.loan_value * (1 + r.haircut_pct / 100)
    issuer_cap = (r.issuer_limit_pct / 100) * needed_gross

    breaches: dict[str, float] = {}
    for isin, shares in r.existing_collateral.items():
        price = price_by_isin.get(isin)
        if price is None:
            continue
        mv = shares * price
        if mv > issuer_cap:
            breaches[isin] = round(mv - issuer_cap, 2)
    return breaches


def propose_issuer_breach_resolution(
    isin: str,
    excess_mv: float,
    price: float,
    name: str,
    lot_size: int,
    existing_shares: int,
) -> "ProposedTransaction":
    """Recall mínimo (en lotes) para bajar ESTE ISIN puntual a su issuer cap.
    Mismo patrón de lotes que _greedy_recall, pero apuntado a un solo ISIN
    en vez de a un exceso total del AEL.

    El recall nunca puede superar las acciones realmente pignoradas en ese
    ISIN, y siempre es múltiplo del lot size.
    """
    lot_value = price * lot_size
    if lot_value <= 0:
        raise NoValidBreachResolutionError(
            f"No se puede calcular un recall válido para {isin}: precio o lote inválido."
        )

    lots_needed = math.ceil(excess_mv / lot_value)
    lots_available = existing_shares // lot_size
    lots_to_recall = min(lots_needed, lots_available)

    if lots_to_recall <= 0:
        raise NoValidBreachResolutionError(
            f"No hay lotes completos disponibles en {isin} para resolver el issuer breach."
        )

    shares_to_recall = lots_to_recall * lot_size
    mv_to_recall = shares_to_recall * price

    return ProposedTransaction(
        name=name, isin=isin, action="recall",
        shares=shares_to_recall, market_value=round(mv_to_recall, 2),
    )


class NoValidBreachResolutionError(Exception):
    """No recall combination was found that resolves the AEL 
    breach without generating a new issuer limit breach.."""
    pass


def check_issuer_limit_post_recall(proposal: list, transactions: list["ProposedTransaction"]) -> dict[str, float]:
    """Simulate the proposal after applying the transactions and return
    the percentage of each remaining ISIN on the new pledged total."""
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
            "No recall transaction could be generated: the excess to be recovered "
            "is smaller than the value of the minimum lot of any available position."
        )
    raise NoValidBreachResolutionError(
        "No recall combination was found that resolves the AEL breach "
        "without generating a new issuer limit breach."
    )

def propose_breach_alternative(
    proposal: list,
    collateral_exposure: float,
    absolute_exposure_limit: float,
    lot_size: int,
    issuer_limit_pct: float,
    previous_attempts: list[list[str]],
) -> tuple[list["ProposedTransaction"], bool]:
    min_recall = collateral_exposure - absolute_exposure_limit
    max_recall = collateral_exposure

    prev_sets = [set(a) for a in previous_attempts]

    # ISIN de cada posición del proposal.
    # ⚠️ CONFIRMAR: ¿los items de `proposal` son dicts (p["isin"]) u objetos (p.isin)?
    #    Ajustá _isin_of según lo que tengas.
    def _isin_of(p):
        return p.isin        # <-- si es objeto, cambiá por: return p.isin

    all_isins = [_isin_of(p) for p in proposal]

    # Priorizamos prohibir securities ya usados en intentos previos:
    # son los que fuerzan una combinación distinta.
    used_before = set().union(*prev_sets) if prev_sets else set()
    forbid_order = list(used_before) + [i for i in all_isins if i not in used_before]

    for forbidden in forbid_order:
        reduced_pool = [p for p in proposal if _isin_of(p) != forbidden]
        if not reduced_pool:
            continue

        for strategy in (_greedy_recall, _proportional_recall):
            transactions, recalled = strategy(reduced_pool, min_recall, max_recall, lot_size)
            if not transactions:
                continue

            cand_isins = {t.isin for t in transactions}

            # Regla estricta: debe diferir en >=1 security entero de TODOS los intentos previos.
            # Como comparamos sets de ISIN, "igual set" = misma combinación => se descarta.
            if cand_isins in prev_sets:
                continue

            # Mismo chequeo de issuer limit que en propose_breach_resolution.
            issuer_pcts = check_issuer_limit_post_recall(proposal, transactions)
            if any(pct > issuer_limit_pct for pct in issuer_pcts.values()):
                continue

            fully_resolved = recalled >= min_recall
            return transactions, fully_resolved

    raise NoValidBreachResolutionError(
        "No recall combination was found that resolves the AEL breach."
    )