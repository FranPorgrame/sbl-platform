-- SBL Platform — esquema PostgreSQL (MVP)
-- Tres tablas: posiciones del portfolio, reglas de colateral, resultados.
-- NUMERIC de precisión exacta: en finanzas un redondeo mal puesto es dinero real.

CREATE TABLE IF NOT EXISTS positions (
    id          SERIAL PRIMARY KEY,
    name        TEXT            NOT NULL,
    isin        TEXT            NOT NULL,
    quantity    NUMERIC(18, 4)  NOT NULL,   -- (+) largo / (-) corto
    price       NUMERIC(18, 4)  NOT NULL CHECK (price > 0),
    currency    CHAR(3)         NOT NULL DEFAULT 'CHF',
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collateral_rules (
    id                       SERIAL PRIMARY KEY,
    loan_value               NUMERIC(18, 2)  NOT NULL,
    haircut_pct              NUMERIC(6, 3)   NOT NULL,
    issuer_limit_pct         NUMERIC(6, 3)   NOT NULL,
    absolute_exposure_limit  NUMERIC(18, 2),            -- NULL = sin tope
    max_pct_of_shares        NUMERIC(6, 3)   NOT NULL DEFAULT 100,
    lot_size                 INTEGER         NOT NULL DEFAULT 1 CHECK (lot_size >= 1),
    existing_collateral      NUMERIC(18, 2)  NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS optimization_results (
    id                   SERIAL PRIMARY KEY,
    rules_id             INTEGER REFERENCES collateral_rules(id),
    status               TEXT            NOT NULL,   -- OPTIMAL | FEASIBLE | INFEASIBLE
    collateral_needed    NUMERIC(18, 2)  NOT NULL,
    collateral_provided  NUMERIC(18, 2)  NOT NULL,
    excess               NUMERIC(18, 2)  NOT NULL,
    proposal             JSONB           NOT NULL,   -- líneas propuestas (security/isin/shares)
    created_at           TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_positions_isin ON positions (isin);
CREATE INDEX IF NOT EXISTS idx_results_rules  ON optimization_results (rules_id);
