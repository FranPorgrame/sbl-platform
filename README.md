# SBL Platform — Securities Borrowing and Lending Automation

Herramienta financiera B2B que automatiza el proceso de prestar y recibir valores
(securities) entre bancos/brokers (SBL desk, lado prestamista) y hedge funds /
asset managers (lado prestatario). La plataforma se vende a bancos para
automatizar su mesa de préstamo de valores.

**Fase 1 (MVP):** módulo de optimización de colateral. Un motor MILP que, dado
un portfolio y un conjunto de reglas, propone qué securities pignorar como
colateral **minimizando el exceso de colateral inmovilizado**.

## Estructura del repositorio (monorepo)

```
sbl-platform/
├── frontend/     React + TypeScript / Next.js — interfaz Buy-Side y SBL Desk
├── backend/      Python + FastAPI — API y motor de optimización (OR-Tools)
└── db/           PostgreSQL — esquema de datos
```

## Arranque rápido

### Backend
```bash
cd backend
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
# API viva en http://localhost:8000  ·  docs en http://localhost:8000/docs
```

### Frontend
```bash
cd frontend
npx create-next-app@latest .
npm run dev
# UI viva en http://localhost:3000
```

## Función objetivo del motor

Minimizar el colateral total inmovilizado sujeto a que cubra el requerimiento,
respetando: límite por emisor, límite de exposición absoluta, lot size y máximo
porcentaje de acciones por posición. Ver `backend/optimizer.py`.
