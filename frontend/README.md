# Frontend — React + TypeScript / Next.js

Esta carpeta alojará la interfaz de la plataforma (Buy-Side y SBL Desk).

El esqueleto de Next.js se genera con un comando (no se sube a mano). Desde
aquí, dentro de `frontend/`:

```bash
npx create-next-app@latest .
```

Opciones recomendadas: TypeScript **sí**, ESLint **sí**, Tailwind **sí**,
App Router **sí**.

Luego, para las tablas de datos (portfolio, propuesta de colateral):

```bash
npm install ag-grid-react ag-grid-community
```

El prototipo funcional ya construido (`sbl_collateral_optimizer.jsx`) sirve de
referencia visual y de lógica para esta interfaz: replica el motor en el
navegador. La versión de producción llamará al backend real vía el endpoint
`POST http://localhost:8000/optimize`.
