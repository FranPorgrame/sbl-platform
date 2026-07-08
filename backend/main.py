"""SBL Platform — API (FastAPI).

Expone el motor de optimización de colateral como servicio REST.
El frontend envía portfolio + reglas a /optimize y recibe la propuesta.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from models import OptimizeRequest, OptimizeResponse
from optimizer import optimize as run_optimizer

app = FastAPI(
    title="SBL Platform API",
    description="Securities Borrowing and Lending — collateral optimization",
    version="0.1.0",
)

# CORS: permite que el frontend (Vercel / localhost:3000) llame a la API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restringir a los dominios del frontend en producción
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/optimize", response_model=OptimizeResponse)
def optimize(req: OptimizeRequest) -> OptimizeResponse:
    """Recibe portfolio + reglas, devuelve la propuesta de colateral óptima."""
    return run_optimizer(req)
