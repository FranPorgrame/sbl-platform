"use client";
import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Upload, Zap, RotateCcw, Trash2, RefreshCw, Server, Wifi, WifiOff, Download } from "lucide-react";

/* ============================================================
   SBL — SECURITIES LENDING AND BORROWING
   Frontend conectado al BACKEND REAL (FastAPI + OR-Tools MILP).
   El botón AUTO-PROPOSE envía portfolio + reglas al endpoint
   POST {backendUrl}/optimize y renderiza la propuesta óptima.
   Si el backend no responde, cae a un cálculo local de respaldo.
   ============================================================ */

const BACKEND_DEFAULT = "https://sbl-platform-production.up.railway.app";

// ---- Theme -------------------------------------------------
const C = {
  bg: "#0a0b0d", panel: "#111317", panelAlt: "#0d0f12", line: "#1e2228",
  lineSoft: "#181b20", text: "#e6e8eb", dim: "#6b7280", dimmer: "#454b54",
  green: "#4ade80", greenDim: "#1f8a4c", red: "#f26d6d", blue: "#5b8cff",
  blueBg: "#1a2540", amber: "#f5b544",
};
const MONO = "'IBM Plex Mono','SF Mono',ui-monospace,Menlo,Consolas,monospace";

// ---- Sample data (Swiss equities, from the beta) -----------
const SAMPLE = {
  filename: "Collateral_130_30.xlsx", loanValue: 64985360.18, haircut: 30,
  issuerLimit: 25, absLimit: "", maxPct: 100, lot: 100,
  positions: [
    ["ROCHE HOLDINGS (GENUSSCHEINE)", "CH0012032048", 142096, 328.2],
    ["NESTLE SA-REG", "CH0038863350", 460215, 78.74],
    ["NOVARTIS AG CHF0.50 (REGD)", "CH0012005267", 269676, 109.6],
    ["UBS GROUP AG", "CH0244767585", 597460, 36.96],
    ["ZURICH INSURANCE GROUP AG CHF0.10", "CH0011075394", 27201, 601.8],
    ["ABB LTD-REG", "CH0012221716", 255052, 59.41],
    ["CIE FINANCIERE RICHEMONT-REG", "CH0210483332", 73073, 173.93],
    ["ALCON INC", "CH0432492467", 118500, 78.9],
    ["GEBERIT AG-REG", "CH0030170408", 24800, 585.2],
    ["HOLCIM LTD", "CH0012214059", 191000, 88.6],
    ["SGS SA-REG", "CH1176493729", 118000, 94.7],
    ["SIKA AG-REG", "CH0418792922", 61500, 236.4],
    ["LONZA GROUP AG-REG", "CH0013841017", 39800, 548.0],
    ["SCHINDLER-HLDG CH0.1(PART CERT)", "CH0024638196", -26017, 299.2],
    ["CHOCOLADEFABRIKEN LINDT-REG", "CH0010570759", -59, 116400.0],
    ["BUCHER INDUSTRIES AG-REG CHF0.20", "CH0002432174", -17682, 368.5],
    ["AVOLTA AG", "CH0023405456", -87660, 47.14],
    ["ROCHE HOLDINGS CHF1 (BR)", "CH0012032113", -11599, 335.2],
    ["SULZER AG CHF0.01", "CH0038388911", -24149, 147.4],
    ["SWISS PRIME SITE A CHF15.30", "CH0008038389", -28666, 123.2],
    ["EFG INTERNATIONAL CHF0.50", "CH0022268228", -184809, 19.06],
    ["SWATCH GROUP AG REG CHF0.45", "CH0012255144", -102113, 34.46],
    ["SENSIRION HOLDING LTD", "CH0486705126", -46689, 61.6],
    ["SUNRISE COMMUNICATIONS AG-A", "CH1386228409", -63645, 42.42],
    ["LOGITECH INTL CHF0.25 (REGD)", "CH0025751329", -19244, 81.54],
    ["VAT GROUP AG", "CH0311864901", -3648, 385.9],
    ["BARRY CALLEBAUT AG", "CH0009002962", -1060, 1306.0],
  ],
};

const lotFloor = (x, lot) => (lot > 0 ? Math.floor(x / lot) * lot : Math.floor(x));
const lotCeil = (x, lot) => (lot > 0 ? Math.ceil(x / lot) * lot : Math.ceil(x));
const num = (v) => (Number.isFinite(v) ? v : 0);

function parseNum(v) {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  let s = String(v).trim().replace(/\s|CHF|EUR|USD|GBP|'/gi, "");
  if (s === "" || s.toLowerCase() === "none") return NaN;
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  s = lc > ld ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

const SUPPORTED_CCY = ["CHF", "EUR", "USD", "GBP"];
const CCY_TOKEN = /\b(CHF|EUR|USD|GBP)\b/i;
const CCY_SYMBOL = { "€": "EUR", "£": "GBP", "$": "USD" };

// Extrae un código de divisa de cualquier texto: "Price (EUR)" -> "EUR"
function ccyFromText(v) {
  const s = String(v ?? "");
  const m = s.match(CCY_TOKEN);
  if (m) return m[1].toUpperCase();
  for (const sym of Object.keys(CCY_SYMBOL)) {
    if (s.includes(sym)) return CCY_SYMBOL[sym];
  }
  return null;
}

const rowsFromSample = () =>
  SAMPLE.positions.map(([name, isin, qty, price], i) => ({ id: `${isin}-${i}`, name, isin, qty, price }));

// ---- Local fallback engine (greedy) -----------------------
function optimizeLocal(longs, excluded, { loanValue, haircut, issuerLimit, maxPct, lot }) {
  const needed = loanValue * (1 + haircut / 100);
  const issuerCapMV = issuerLimit > 0 ? (issuerLimit / 100) * needed : Infinity;
  const elig = longs.filter((l) => !excluded.has(l.id)).map((l) => ({ ...l, mv: l.qty * l.price })).sort((a, b) => b.mv - a.mv);
  let provided = 0; const prop = {};
  for (const l of elig) {
    if (provided >= needed - 1e-6) break;
    const maxByShares = Math.floor(l.qty * (maxPct / 100));
    const maxByMV = Math.floor(issuerCapMV / l.price);
    const maxShares = lotFloor(Math.min(maxByShares, maxByMV), lot);
    if (maxShares <= 0) continue;
    const ideal = lotCeil((needed - provided) / l.price, lot);
    const shares = Math.min(ideal, maxShares);
    if (shares <= 0) continue;
    prop[l.id] = shares; provided += shares * l.price;
  }
  return prop;
}

const useFmt = (ccy) => {
  const money = (v, sign = false) => {
    const n = num(v);
    const s = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.abs(Math.round(n)));
    return `${sign && n > 0 ? "+" : n < 0 ? "\u2212" : ""}${ccy} ${s}`;
  };
  const int = (v) => new Intl.NumberFormat("en-US").format(Math.round(num(v)));
  const price = (v) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num(v));
  return { money, int, price };
};

const Card = ({ label, children, sub, accent }) => (
  <div style={{ flex: 1, minWidth: 200, background: C.panel, border: `1px solid ${C.line}`, padding: "16px 18px" }}>
    <div style={{ color: C.dim, fontSize: 10, letterSpacing: 1.5, marginBottom: 10 }}>{label}</div>
    <div style={{ color: accent || C.text, fontSize: 24, fontWeight: 600, letterSpacing: 0.5 }}>{children}</div>
    {sub && <div style={{ color: C.dim, fontSize: 11, marginTop: 6 }}>{sub}</div>}
  </div>
);
const Field = ({ label, value, onChange, width = 110, placeholder, numeric }) => (
  <div>
    <div style={{ color: C.dim, fontSize: 9, letterSpacing: 1.2, marginBottom: 6 }}>{label}</div>
    <input
      value={numeric && value !== "" ? Number(value).toLocaleString('en-US') : value}
      placeholder={placeholder}
      onChange={(e) => onChange(numeric ? e.target.value.replace(/,/g, '') : e.target.value)}
      style={{ width, background: C.panelAlt, border: `1px solid ${C.line}`, color: C.text,
        fontFamily: MONO, fontSize: 12.5, padding: "8px 10px", outline: "none" }}
    />
  </div>
);
const Btn = ({ children, onClick, primary, disabled, icon: Icon }) => (
  <button onClick={onClick} disabled={disabled}
    style={{ display: "inline-flex", alignItems: "center", gap: 6, background: primary ? C.blueBg : "transparent",
      border: `1px solid ${primary ? C.blue : C.line}`, color: disabled ? C.dimmer : primary ? "#cfe0ff" : C.text,
      fontFamily: MONO, fontSize: 11, letterSpacing: 1, padding: "8px 14px", cursor: disabled ? "not-allowed" : "pointer", textTransform: "uppercase" }}>
    {Icon && <Icon size={13} />} {children}
  </button>
);

// ---- Excel-like cell selection (multi-rango con Ctrl/Cmd + click) ----
function useGridSelection(matrix) {
  const [ranges, setRanges] = useState([]); // rectángulos ya confirmados
  const [anchor, setAnchor] = useState(null); // {r, c}
  const [focus, setFocus] = useState(null);   // {r, c}
  const dragging = useRef(false);
  const matrixRef = useRef(matrix);
  matrixRef.current = matrix;

  // Rectángulo que se está dibujando ahora mismo.
  const active = useMemo(() => {
    if (!anchor || !focus) return null;
    return {
      r1: Math.min(anchor.r, focus.r), r2: Math.max(anchor.r, focus.r),
      c1: Math.min(anchor.c, focus.c), c2: Math.max(anchor.c, focus.c),
    };
  }, [anchor, focus]);

  const allRects = useMemo(
    () => (active ? [...ranges, active] : ranges),
    [ranges, active]
  );

  // Ref para que el handler de teclado siempre lea la selección actual.
  const rectsRef = useRef(allRects);
  rectsRef.current = allRects;

  const inRect = (r, c, x) => r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2;
  const isSel = useCallback(
    (r, c) => allRects.some((x) => inRect(r, c, x)),
    [allRects]
  );

  const start = (r, c, e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "button" || tag === "select") return; // no pisar la edición manual

    const additive = e.ctrlKey || e.metaKey; // Ctrl en Windows, Cmd en Mac

    if (e.shiftKey && anchor) { setFocus({ r, c }); return; }

    if (additive) {
      // Congelamos el bloque actual y abrimos uno nuevo encima.
      if (active) setRanges((prev) => [...prev, active]);
    } else {
      setRanges([]); // click limpio -> selección desde cero
    }

    dragging.current = true;
    setAnchor({ r, c }); setFocus({ r, c });
  };

  const extend = (r, c) => { if (dragging.current) setFocus({ r, c }); };

  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "Escape") { setRanges([]); setAnchor(null); setFocus(null); return; }

      const rects = rectsRef.current;
      if (!rects.length) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const m = matrixRef.current;

        // Caja envolvente de todos los bloques seleccionados.
        const r1 = Math.min(...rects.map((x) => x.r1));
        const r2 = Math.max(...rects.map((x) => x.r2));
        const c1 = Math.min(...rects.map((x) => x.c1));
        const c2 = Math.max(...rects.map((x) => x.c2));

        const lines = [];
        for (let r = r1; r <= r2; r++) {
          const cells = [];
          for (let c = c1; c <= c2; c++) {
            const selected = rects.some((x) => inRect(r, c, x));
            cells.push(selected ? (m[r]?.[c] ?? "") : "");
          }
          lines.push(cells.join("\t"));
        }
        const text = lines.join("\n");

        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
        else {
          const ta = document.createElement("textarea");
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand("copy"); document.body.removeChild(ta);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // El borde se dibuja solo contra vecinos NO seleccionados: así dos bloques
  // pegados se ven como un único contorno, igual que en Excel.
  const selStyle = (r, c) => {
    if (!isSel(r, c)) return null;
    const edges = [];
    if (!isSel(r - 1, c)) edges.push(`inset 0 1px 0 0 ${C.blue}`);
    if (!isSel(r + 1, c)) edges.push(`inset 0 -1px 0 0 ${C.blue}`);
    if (!isSel(r, c - 1)) edges.push(`inset 1px 0 0 0 ${C.blue}`);
    if (!isSel(r, c + 1)) edges.push(`inset -1px 0 0 0 ${C.blue}`);
    return { background: "rgba(91,140,255,0.14)", boxShadow: edges.join(", ") || undefined };
  };

  return { start, extend, selStyle, clear: () => { setRanges([]); setAnchor(null); setFocus(null); } };
}

// ============================================================
export default function App() {
  const [rows, setRows] = useState([]);
  const [filename, setFilename] = useState("");
  const [ccy, setCcy] = useState("CHF");
  const [ccyInfo, setCcyInfo] = useState(null); // { ccy, mixed, msg }
  const [excluded, setExcluded] = useState(new Set());
  const [proposals, setProposals] = useState({});
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const [loanValue, setLoanValue] = useState("");
  const [haircut, setHaircut] = useState("30");
  const [issuerLimit, setIssuerLimit] = useState("25");
  const [absLimit, setAbsLimit] = useState("");
  const [maxPct, setMaxPct] = useState("100");
  const [lot, setLot] = useState(100);

  const [backendUrl, setBackendUrl] = useState(BACKEND_DEFAULT);
  const [engine, setEngine] = useState("idle"); // idle | loading | backend | local | error
  const [engineMsg, setEngineMsg] = useState("");

  const [breachInfo, setBreachInfo] = useState(null);
  const [executingBreach, setExecutingBreach] = useState(false);
  const [breachError, setBreachError] = useState("");
  const [proposingAgain, setProposingAgain] = useState(false);
  const [noMoreAlternatives, setNoMoreAlternatives] = useState(false);

  const [issuerBreachInfo, setIssuerBreachInfo] = useState(null);
  const [executingIssuerBreach, setExecutingIssuerBreach] = useState(false);
  const [issuerBreachError, setIssuerBreachError] = useState("");
  
  const fmt = useFmt(ccy);

  const params = useMemo(() => ({
    loanValue: parseNum(loanValue) || 0, haircut: parseNum(haircut) || 0,
    issuerLimit: parseNum(issuerLimit) || 0, absLimit: parseNum(absLimit) || 0,
    maxPct: parseNum(maxPct) || 100, lot,
  }), [loanValue, haircut, issuerLimit, absLimit, maxPct, lot]);

  const [existingCollateralOverrides, setExistingCollateralOverrides] = useState({});

  // Existing collateral efectivo = lo que vino del Excel, sobrescrito por los
  // recalls de issuer breach ya ejecutados. Única fuente de verdad.
  const existingCollateral = useMemo(() => {
    const dict = {};
    for (const r of rows) {
      if (r.qty > 0 && r.existingQty > 0) dict[r.isin] = Math.round(r.existingQty);
    }
    return { ...dict, ...existingCollateralOverrides };
  }, [rows, existingCollateralOverrides]);

  // longs ya trae el existingQty efectivo: la tabla, longMatrix, el export y
  // existingCollateralValue leen todos de acá, así que se corrigen solos.
  const longs = useMemo(() => rows.filter((r) => r.qty > 0).map((r) => ({
    ...r,
    existingQty: existingCollateral[r.isin] ?? 0,
    mv: r.qty * r.price,
  })), [rows, existingCollateral]);

  const shorts = useMemo(() => rows.filter((r) => r.qty < 0).map((r) => ({ ...r, mv: Math.abs(r.qty) * r.price })), [rows]);

  const existingCollateralValue = useMemo(
    () => longs.reduce((a, l) => a + l.existingQty * l.price, 0),
    [longs]
  );
  const grossShort = useMemo(() => shorts.reduce((a, s) => a + s.mv, 0), [shorts]);
  const totalMV = useMemo(() => rows.reduce((a, r) => a + Math.abs(r.qty) * r.price, 0), [rows]);
  const neededGross = params.loanValue * (1 + params.haircut / 100);
  const needed = Math.max(0, neededGross - existingCollateralValue); // residual que debe cubrir el optimizer (se sigue usando en el long book)
  const provided = useMemo(() => longs.reduce((a, l) => a + (proposals[l.id] || 0) * l.price, 0), [longs, proposals]);
  const totalCollateral = existingCollateralValue + provided; // existing collateral + lo que propone el optimizer
  const exposure = totalCollateral - neededGross;
  const exposureLabel = params.absLimit > 0
    ? (exposure < -params.absLimit ? "shortfall" : exposure > params.absLimit ? "excess" : null)
    : null;

  const loadRows = (data, name, detected) => {
    const mapped = data.map((r, i) => {
      const nm = r.name ?? r.Security ?? r["Security name"] ?? r.SECURITY ?? "";
      const isin = r.isin ?? r.ISIN ?? "";
      const qty = parseNum(r.qty ?? r.Quantity ?? r.quantity ?? r.QTY ?? r.shares);
      const price = parseNum(r.price ?? r.Price ?? r.PRICE);
      const existingQty = parseNum(
      r.existingQty ?? r["Existing Collateral"] ?? r["Existing Collateral Qty"] ?? r.existingCollateral ?? r.ExistingCollateral
      );
      const existingCcy = r["Existing Collateral CCY"] ?? r.existingCcy ?? r.CCY ?? "";
      return nm && Number.isFinite(qty) && Number.isFinite(price)
        ? {
            id: `${isin || nm}-${i}`, name: String(nm), isin: String(isin), qty, price,
            existingQty: Number.isFinite(existingQty) ? existingQty : 0,
            existingCcy: String(existingCcy),
          }
        : null;
    }).filter(Boolean);
    if (!mapped.length) { setError("No valid positions. Expected: Security · ISIN · Quantity · Price · Existing Collateral."); return; }
    setError(""); setRows(mapped); setFilename(name); setProposals({}); setExcluded(new Set()); setEngine("idle"); setExistingCollateralOverrides({});

    if (detected?.mixed) {
      setCcyInfo({
        mixed: true,
        msg: `Multiple currencies in file (${detected.all.join(", ")}) — no FX conversion applied. Select currency manually.`,
      });
    } else if (detected?.ccy) {
      setCcy(detected.ccy);
      setCcyInfo({ mixed: false, ccy: detected.ccy, msg: `auto-detected from file` });
    } else {
      setCcyInfo(null);
    }
    const gs = mapped.filter((r) => r.qty < 0).reduce((a, r) => a + Math.abs(r.qty) * r.price, 0);
    setLoanValue(String(Math.round(gs * 100) / 100));
  };

  const loadSample = () => {
    setRows(rowsFromSample()); setFilename(SAMPLE.filename); setCcy("CHF");
    const gs = SAMPLE.positions.filter((p) => p[2] < 0).reduce((a, p) => a + Math.abs(p[2]) * p[3], 0);
    setLoanValue(String(Math.round(gs * 100) / 100));
    setIssuerLimit(String(SAMPLE.issuerLimit)); setAbsLimit(SAMPLE.absLimit);
    setMaxPct(String(SAMPLE.maxPct)); setLot(SAMPLE.lot);
    setProposals({}); setExcluded(new Set()); setError(""); setEngine("idle");
  };

  // ---- Flexible header detection (funciona con headers en cualquier fila
  //      y con nombres de columna variables, ej. "Security Name", "Price (EUR)") --
  const HEADER_PATTERNS = {
    existingCcy: /existing.*collateral.*ccy|existing.*ccy/i,
    existingQty: /existing.*collateral/i,
    ccy: /^(ccy|currency|curr|divisa|moneda)$|^price\s*(ccy|currency)/i,
    isin: /^isin/i,
    qty: /^(qty|quantity|shares)/i,
    price: /^price/i,
    name: /^(security|name|instrument)/i,
  };

  function matchField(header) {
    const h = String(header ?? "").trim();
    if (!h) return null;
    // Orden importa: los patrones más específicos van primero.
    if (HEADER_PATTERNS.existingCcy.test(h)) return "existingCcy";
    if (HEADER_PATTERNS.existingQty.test(h)) return "existingQty";
    if (HEADER_PATTERNS.ccy.test(h)) return "ccy";
    if (HEADER_PATTERNS.isin.test(h)) return "isin";
    if (HEADER_PATTERNS.qty.test(h)) return "qty";
    if (HEADER_PATTERNS.price.test(h)) return "price";
    if (HEADER_PATTERNS.name.test(h)) return "name";
    return null;
  }

  // Busca en las primeras filas cuál es la fila de headers reales
  // (la que tenga columna ISIN + al menos 3 campos reconocidos).
  function findHeaderRow(rows2D) {
    const maxScan = Math.min(rows2D.length, 15);
    let best = { index: -1, score: 0 };
    for (let i = 0; i < maxScan; i++) {
      const row = rows2D[i] || [];
      let score = 0, hasIsin = false;
      for (const cell of row) {
        const f = matchField(cell);
        if (f) { score++; if (f === "isin") hasIsin = true; }
      }
      if (hasIsin && score >= 3 && score > best.score) best = { index: i, score };
    }
    return best.index;
  }

  // Convierte una matriz cruda (array de arrays) en objetos {name, isin, qty, price, ...}
  // sin importar en qué fila esté el header ni el orden/nombre exacto de las columnas.
  // Detecta la divisa del portfolio en 3 niveles de confianza.
  function detectCurrency(rows2D, headerIdx, fieldByCol) {
    const counts = {};
    const bump = (c) => { if (c) counts[c] = (counts[c] || 0) + 1; };
    const empty = () => Object.keys(counts).length === 0;

    // Nivel 1: columna CCY explícita
    const ccyCol = fieldByCol.indexOf("ccy");
    if (ccyCol !== -1) {
      for (let i = headerIdx + 1; i < rows2D.length; i++) {
        bump(ccyFromText((rows2D[i] || [])[ccyCol]));
      }
    }

    // Nivel 2: el header lo dice ("Price (EUR)")
    if (empty()) {
      for (const cell of rows2D[headerIdx] || []) bump(ccyFromText(cell));
    }

    // Nivel 3: los valores de price traen el prefijo ("CHF 328.20")
    if (empty()) {
      const priceCol = fieldByCol.indexOf("price");
      if (priceCol !== -1) {
        for (let i = headerIdx + 1; i < rows2D.length; i++) {
          bump(ccyFromText((rows2D[i] || [])[priceCol]));
        }
      }
    }

    const found = Object.entries(counts)
      .filter(([c]) => SUPPORTED_CCY.includes(c))
      .sort((a, b) => b[1] - a[1]);

    if (!found.length) return { ccy: null, mixed: false, all: [] };
    return {
      ccy: found[0][0],
      mixed: found.length > 1,
      all: found.map(([c, n]) => `${c} × ${n}`),
    };
  }

  // Convierte una matriz cruda (array de arrays) en objetos {name, isin, qty, price, ...}
  // sin importar en qué fila esté el header ni el orden/nombre exacto de las columnas.
  function rowsFromSheetArray(rows2D) {
    const headerIdx = findHeaderRow(rows2D);
    if (headerIdx === -1) return null;
    const fieldByCol = (rows2D[headerIdx] || []).map(matchField);
    const out = [];
    for (let i = headerIdx + 1; i < rows2D.length; i++) {
      const row = rows2D[i] || [];
      const obj = {};
      fieldByCol.forEach((field, col) => { if (field) obj[field] = row[col]; });
      out.push(obj);
    }
    return { rows: out, currency: detectCurrency(rows2D, headerIdx, fieldByCol) };
  }

  const handleFile = useCallback((file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "csv") {
      Papa.parse(file, {
        header: false, skipEmptyLines: true,
        complete: (res) => {
          const parsed = rowsFromSheetArray(res.data);
          if (!parsed) { setError("No ISIN/Quantity/Price columns were found in the CSV."); return; }
          loadRows(parsed.rows, file.name, parsed.currency);
        },
        error: () => setError("Could not read CSV."),
      });
    } else if (["xlsx", "xls"].includes(ext)) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: "array" });

          // El portfolio puede estar en cualquier hoja (ej. "Portfolio" en la 3ra,
          // con "Summary"/"Assumptions" delante). Recorremos TODAS y nos quedamos
          // con la que tenga un header válido y MÁS filas con ISIN reconocido.
          let best = null;
          for (const sheetName of wb.SheetNames) {
            const arr2D = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
            const parsed = rowsFromSheetArray(arr2D);
            if (!parsed) continue;
            const validCount = parsed.rows.filter((r) => String(r.isin ?? "").trim()).length;
            if (!best || validCount > best.validCount) best = { ...parsed, validCount };
          }

          if (!best) { setError("No se encontraron columnas ISIN/Quantity/Price en ninguna hoja del Excel."); return; }
          loadRows(best.rows, file.name, best.currency);
        } catch { setError("Could not read Excel."); }
      };
      reader.readAsArrayBuffer(file);
    } else setError("Unsupported file. Use .xlsx, .xls or .csv.");
  }, []);

  // ---- AUTO-PROPOSE: calls the REAL backend ----------------
  const autoPropose = async (existingOverride) => {
    setEngine("loading"); setEngineMsg("");
    const existingForCall = existingOverride ?? existingCollateral;
    const payload = {
      positions: rows.map((r) => ({ name: r.name, isin: r.isin, quantity: r.qty, price: r.price })),
      rules: {
        loan_value: params.loanValue, haircut_pct: params.haircut, issuer_limit_pct: params.issuerLimit,
        absolute_exposure_limit: params.absLimit > 0 ? params.absLimit : null,
        max_pct_of_shares: params.maxPct, lot_size: params.lot, existing_collateral: existingForCall,
        excluded_isins: longs.filter((l) => excluded.has(l.id)).map((l) => l.isin),
      },
      currency: ccy,
    };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${backendUrl}/optimize`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: ctrl.signal,
      });
      clearTimeout(t);

      if (res.status === 422) {
        const errData = await res.json();
        const code = errData.detail?.error_code;
        const msg = errData.detail?.message || "El backend rechazó la solicitud.";
        // Marcamos el error de negocio para distinguirlo de una caída de red
        const bizErr = new Error(msg);
        bizErr.isBusinessError = !!code;
        throw bizErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const next = {};
      for (const line of data.proposal || []) {
        const row = longs.find((l) => l.isin === line.isin && !excluded.has(l.id));
        if (row) next[row.id] = line.proposed_shares;
      }
      setProposals(next);
      setEngine("backend");
      setEngineMsg(`${data.status} · excess ${fmt.money(data.excess)}`);

      const firstTx = data.proposed_transactions || [];
      setBreachInfo({
        optimizationId: data.id,
        exposureBreach: data.exposure_breach,
        proposedTransactions: firstTx,
        fullyResolved: data.fully_resolved,
        collateralNeeded: data.collateral_needed,
        collateralProvided: data.collateral_provided,
        exposure: data.collateral_exposure,
        attemptNumber: 1,
        previousAttempts: [firstTx.map((t) => t.isin)],
      });

      if (data.issuer_breach) {
        setIssuerBreachInfo({
          transactions: data.issuer_breach_transactions,
        });
      } else {
        setIssuerBreachInfo(null);
      }
      setIssuerBreachError("");
      
      setBreachError("");
      setNoMoreAlternatives(false);
    } catch (e) {
      if (e.isBusinessError) {
        setEngine("error");
        setEngineMsg(e.message);
        setBreachInfo(null);
      } else {
        setProposals(optimizeLocal(longs, excluded, params));
        setEngine("local");
        setEngineMsg(e.name === "AbortError" ? "backend timeout" : "backend unreachable");
        setBreachInfo(null);
      }
    }
  };

    const executeBreach = async () => {
    if (!breachInfo) return;
    setExecutingBreach(true);
    setBreachError("");
    try {
      const payload = {
        optimization_id: breachInfo.optimizationId,
        rules: {
          loan_value: params.loanValue,
          haircut_pct: params.haircut,
          issuer_limit_pct: params.issuerLimit,
          absolute_exposure_limit: params.absLimit > 0 ? params.absLimit : null,
          max_pct_of_shares: params.maxPct,
          lot_size: params.lot,
          existing_collateral: existingCollateral,
        },
        applied_transactions: breachInfo.proposedTransactions,
        collateral_needed: breachInfo.collateralNeeded,
        collateral_provided: breachInfo.collateralProvided,
      };
      const res = await fetch(`${backendUrl}/execute-breach-resolution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      setProposals((prev) => {
      const next = { ...prev };
      for (const t of breachInfo.proposedTransactions) {
        const row = longs.find((l) => l.isin === t.isin);
        if (row) {
          const current = next[row.id] || 0;
          next[row.id] = Math.max(0, current - t.shares);
        }
      }
      return next;
    });

      setBreachInfo((b) => ({
        ...b,
        exposureBreach: false,
        collateralProvided: data.collateral_provided,
        exposure: data.collateral_exposure,
      }));
    } catch (e) {
      setBreachError("An alternative proposal could not be generated.");
    } finally {
      setExecutingBreach(false);
    }
  };

    const executeIssuerBreach = async (tx) => {
      setExecutingIssuerBreach(true);
      setIssuerBreachError("");
      try {
        const payload = {
          isin: tx.isin,
          name: tx.name,
          price: longs.find((l) => l.isin === tx.isin)?.price || 0,
          shares_recalled: tx.shares,
          existing_collateral: existingCollateral,
          rules: {
            loan_value: params.loanValue,
            haircut_pct: params.haircut,
            issuer_limit_pct: params.issuerLimit,
            absolute_exposure_limit: params.absLimit > 0 ? params.absLimit : null,
            max_pct_of_shares: params.maxPct,
            lot_size: params.lot,
            existing_collateral: existingCollateral,
          },
        };
        const res = await fetch(`${backendUrl}/execute-issuer-breach-resolution`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        setExistingCollateralOverrides((prev) => ({
          ...prev,
          [tx.isin]: data.updated_existing_collateral[tx.isin],
        }));

        // El recall baja el existing collateral -> el needed sube -> la proposal
        // en pantalla queda obsoleta. Re-optimizamos con el dict ya actualizado
        // en vez de parchear el estado a mano.
        await autoPropose({
          ...existingCollateral,
          [tx.isin]: data.updated_existing_collateral[tx.isin],
        });
      } catch (e) {
        setIssuerBreachError("The issuer breach resolution could not be executed.");
      } finally {
        setExecutingIssuerBreach(false);
      }
    };

  const proposeAgain = async () => {
    if (!breachInfo) return;
    setProposingAgain(true);
    setBreachError("");
    try {
      const payload = {
        positions: rows.map((r) => ({ name: r.name, isin: r.isin, quantity: r.qty, price: r.price })),
        rules: {
          loan_value: params.loanValue,
          haircut_pct: params.haircut,
          issuer_limit_pct: params.issuerLimit,
          absolute_exposure_limit: params.absLimit > 0 ? params.absLimit : null,
          max_pct_of_shares: params.maxPct,
          lot_size: params.lot,
          existing_collateral: existingCollateral,
          excluded_isins: longs.filter((l) => excluded.has(l.id)).map((l) => l.isin),
        },
        collateral_needed: breachInfo.collateralNeeded,
        collateral_provided: breachInfo.collateralProvided,
        previous_attempts: breachInfo.previousAttempts,
        attempt_number: breachInfo.attemptNumber,
      };
      const res = await fetch(`${backendUrl}/propose-breach-alternative`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 422) {
        const errData = await res.json();
        const code = errData.detail?.error_code;
        if (code === "no_alternative_found" || code === "max_attempts_reached") {
          setNoMoreAlternatives(true);
          setBreachError(errData.detail?.message || "No other combination was found.");
          return;
        }
        throw new Error(errData.detail?.message || "The backend rejected the request.");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const newTx = data.proposed_transactions || [];
      setBreachInfo((b) => ({
        ...b,
        proposedTransactions: newTx,
        fullyResolved: data.fully_resolved,
        exposure: data.collateral_exposure,
        attemptNumber: b.attemptNumber + 1,
        previousAttempts: [...b.previousAttempts, newTx.map((t) => t.isin)],
      }));
    } catch (e) {
      setBreachError("An alternative proposal could not be generated.");
    } finally {
      setProposingAgain(false);
    }
  };

  const exportToExcel = () => {
    const wb = XLSX.utils.book_new();

    // Hoja 1: Summary — KPIs + parámetros
    const summary = [
      ["SBL — Collateral Optimization Export"],
      ["File", filename],
      ["Currency", ccy],
      [],
      ["METRIC", "VALUE"],
      ["Total Market Value", Math.round(totalMV)],
      ["Total Borrowing", Math.round(grossShort)],
      ["Total Collateral", Math.round(totalCollateral)],
      ["Needed", Math.round(neededGross)],
      ["Collateral Exposure", Math.round(exposure)],
      [],
      ["PARAMETER", "VALUE"],
      ["Haircut %", params.haircut],
      ["Issuer Limit %", params.issuerLimit],
      ["Absolute Exposure Limit", params.absLimit > 0 ? params.absLimit : "none"],
      ["Max % of Shares", params.maxPct],
      ["Lot Size", params.lot],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");

    // Hoja 2: Long Positions — mismas columnas que la tabla en pantalla
    const longHeader = [
      "Security", "ISIN", "Qty Total", "Price", "Market Value",
      "Existing Collateral (Shares)", "Existing MV", "Proposed Transactions", "Proposed MV", "% Pos", "% Coll",
    ];
    const longRows = longs.map((l) => {
      const sh = proposals[l.id] || 0;
      const pct = l.qty > 0 ? ((sh + (l.existingQty || 0)) / l.qty) * 100 : 0;
      const rowCombinedValue = sh * l.price + (l.existingQty || 0) * l.price;
      const coll = totalCollateral > 0 ? (rowCombinedValue / totalCollateral) * 100 : 0;
      return [
        l.name, l.isin, l.qty, l.price, Math.round(l.mv),
        l.existingQty || 0, Math.round((l.existingQty || 0) * l.price),
        sh, sh ? Math.round(sh * l.price) : 0,
        sh ? Number(pct.toFixed(1)) : 0, sh ? Number(coll.toFixed(1)) : 0,
      ];
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([longHeader, ...longRows]), "Long Positions");

    // Hoja 3: Short Positions
    const shortHeader = ["Security", "ISIN", "Shares", "Price", "Borrow Value"];
    const shortRows = shorts.map((s) => [s.name, s.isin, s.qty, s.price, Math.round(s.mv)]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([shortHeader, ...shortRows]), "Short Positions");

    const base = filename ? filename.replace(/\.(xlsx|xls|csv)$/i, "") : "sbl";
    XLSX.writeFile(wb, `${base}_export.xlsx`);
  };

  const reset = () => { setProposals({}); setExcluded(new Set()); setEngine("idle"); setEngineMsg(""); };
  const clearAll = () => { setRows([]); setFilename(""); setProposals({}); setExcluded(new Set()); setLoanValue(""); setError(""); setEngine("idle"); setExistingCollateralOverrides({}); setCcyInfo(null); };
  const toggleExclude = (id) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else { next.add(id); const p = { ...proposals }; delete p[id]; setProposals(p); }
    setExcluded(next);
  };
  const editProposed = (id, val) => setProposals((p) => ({ ...p, [id]: Math.max(0, Math.round(parseNum(val) || 0)) }));

  const rowBreach = (l) => {
    const sh = proposals[l.id] || 0; if (!sh) return null;
    const totalPledgedShares = sh + (l.existingQty || 0);
    const totalPledgedMV = totalPledgedShares * l.price;
    const issuerCapMV = params.issuerLimit > 0 ? (params.issuerLimit / 100) * neededGross : Infinity;
    if (totalPledgedMV > issuerCapMV + 1) return "issuer";
    if (totalPledgedShares > l.qty * (params.maxPct / 100) + 0.5) return "shares";
    if (lot > 0 && sh % lot !== 0) return "lot";
    return null;
  };

  // Matriz de valores crudos del long book — el orden de columnas debe
  // coincidir 1:1 con el <thead> de la tabla (índices 0..9; ACTION no se copia).
  const longMatrix = useMemo(() => longs.map((l) => {
    const sh = proposals[l.id] || 0;
    const pct = l.qty > 0 ? ((sh + (l.existingQty || 0)) / l.qty) * 100 : 0;
    const totalCollateralValue = provided + existingCollateralValue;
    const rowCombinedValue = sh * l.price + (l.existingQty || 0) * l.price;
    const coll = totalCollateralValue > 0 ? (rowCombinedValue / totalCollateralValue) * 100 : 0;
    const existingMV = (l.existingQty || 0) * l.price;
    return [
      l.name, l.isin, l.qty, l.price, l.mv,
      l.existingQty || 0, existingMV, sh, sh * l.price,
      sh ? Number(pct.toFixed(1)) : 0, sh ? Number(coll.toFixed(1)) : 0,
    ];
  }), [longs, proposals, provided, existingCollateralValue]);

  const grid = useGridSelection(longMatrix);

  const hasData = rows.length > 0;
  const covered = totalCollateral >= neededGross - 1e-6;
  const engineColor = engine === "backend" ? C.green : engine === "local" ? C.amber : engine === "error" ? C.red : C.dim;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: MONO, color: C.text, padding: 20 }}>
      <style>{`input::placeholder{color:${C.dimmer}}*{box-sizing:border-box}.rowh:hover{background:${C.lineSoft}}::-webkit-scrollbar{height:8px;width:8px}::-webkit-scrollbar-thumb{background:${C.line}}`}</style>

      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.panel, border: `1px solid ${C.line}`, padding: "14px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 26, height: 26, border: `1px solid ${C.dim}`, display: "grid", placeItems: "center", fontSize: 13 }}>❋</div>
          <span style={{ letterSpacing: 3, fontSize: 13 }}>SECURITIES LENDING AND BORROWING</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {hasData && <span style={{ color: C.text, fontSize: 12, marginRight: 6 }}>{filename}</span>}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
            <select value={ccy} onChange={(e) => { setCcy(e.target.value); setCcyInfo(null); }}
              style={{ background: C.panelAlt, color: C.text, border: `1px solid ${ccyInfo?.mixed ? C.red : ccyInfo ? C.green : C.line}`, fontFamily: MONO, fontSize: 11, padding: "6px 8px" }}>
              {["CHF", "EUR", "USD", "GBP"].map((c) => <option key={c}>{c}</option>)}
            </select>
            {ccyInfo && (
              <span style={{ color: ccyInfo.mixed ? C.red : C.dim, fontSize: 9, letterSpacing: 0.5, maxWidth: 260, textAlign: "right" }}>
                {ccyInfo.msg}
              </span>
            )}
          </div>
          {hasData
            ? <><Btn icon={Download} onClick={exportToExcel}>Export</Btn><Btn icon={RefreshCw} onClick={() => fileRef.current?.click()}>Replace</Btn><Btn icon={Trash2} onClick={clearAll}>Close</Btn></>
            : <Btn onClick={loadSample}>Load sample</Btn>}
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />

      {!hasData && (
        <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }} onClick={() => fileRef.current?.click()}
          style={{ background: C.panel, border: `1px solid ${dragOver ? C.blue : C.line}`, padding: "70px 20px", textAlign: "center", cursor: "pointer" }}>
          <div style={{ width: 54, height: 54, border: `1px solid ${C.line}`, margin: "0 auto 22px", display: "grid", placeItems: "center" }}><Upload size={20} color={C.dim} /></div>
          <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Drop the account position file here</div>
          <div style={{ color: C.dim, fontSize: 12, marginBottom: 26 }}>Excel (.xlsx / .xls) or .csv · or click to browse</div>
          <div style={{ maxWidth: 520, margin: "0 auto", border: `1px solid ${C.line}`, padding: 18, textAlign: "left" }}>
            <div style={{ color: C.dimmer, fontSize: 9, letterSpacing: 1.5, marginBottom: 10 }}>EXPECTED COLUMNS</div>
            <div style={{ fontSize: 12.5, color: C.text }}>Security · ISIN · Quantity · Price · Existing Collateral</div>
            <div style={{ color: C.dim, fontSize: 11, marginTop: 10 }}>Positive quantities are treated as long collateral; negative quantities as the short (borrowing) book.</div>
          </div>
          {error && <div style={{ color: C.red, fontSize: 12, marginTop: 18 }}>{error}</div>}
        </div>
      )}

      {hasData && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <Card label="TOTAL MARKET VALUE">{fmt.money(totalMV)}</Card>
            <Card label="TOTAL BORROWING" accent={C.text}>{fmt.money(grossShort)}</Card>
            <Card label="TOTAL COLLATERAL" accent={covered ? C.green : C.amber} sub={`Needed ${fmt.money(neededGross)}`}>{fmt.money(totalCollateral)}</Card>
            <Card label="COLLATERAL EXPOSURE" accent={exposure >= 0 ? C.green : C.red} sub={exposureLabel}>{fmt.money(exposure, true)}</Card>
          </div>

          {/* Backend connection bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, background: C.panelAlt, border: `1px solid ${C.line}`, padding: "10px 16px", marginBottom: 14, flexWrap: "wrap" }}>
            <Server size={14} color={C.dim} />
            <span style={{ color: C.dim, fontSize: 10, letterSpacing: 1 }}>BACKEND</span>
            <input value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)}
              style={{ width: 240, background: C.bg, border: `1px solid ${C.line}`, color: C.text, fontFamily: MONO, fontSize: 12, padding: "6px 10px", outline: "none" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: engineColor, fontSize: 11 }}>
              {engine === "backend" ? <Wifi size={13} /> : engine === "local" ? <WifiOff size={13} /> : null}
              {engine === "loading" && "optimizing…"}
              {engine === "backend" && `MILP engine · ${engineMsg}`}
              {engine === "local" && `browser fallback · ${engineMsg}`}
              {engine === "error" && `⚠ ${engineMsg}`}
              {engine === "idle" && "ready"}
            </div>
          </div>
          
          {issuerBreachInfo?.transactions?.length > 0 && (
            <div style={{ background: "#2a1414", border: `1px solid ${C.red}`, padding: "14px 18px", marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <span style={{ color: C.red, fontSize: 12, letterSpacing: 1 }}>
                  ISSUER LIMIT BREACH — {issuerBreachInfo.transactions.length} security{issuerBreachInfo.transactions.length > 1 ? "ies" : ""} exceeding cap
                </span>
              </div>
              <table style={{ width: "100%", fontSize: 12, marginBottom: 12 }}>
                <thead><tr style={{ color: C.dim, fontSize: 9 }}>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>SECURITY</th>
                  <th style={{ textAlign: "left", padding: "4px 8px" }}>ISIN</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>ACTION</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>SHARES</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}>MARKET VALUE</th>
                  <th style={{ textAlign: "right", padding: "4px 8px" }}></th>
                </tr></thead>
                <tbody>
                  {issuerBreachInfo.transactions.map((t, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.lineSoft}` }}>
                      <td style={{ padding: "6px 8px" }}>{t.name}</td>
                      <td style={{ padding: "6px 8px", color: C.dim }}>{t.isin}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>{t.action}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt.int(t.shares)}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt.money(t.market_value)}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>
                        <Btn primary onClick={() => executeIssuerBreach(t)} disabled={executingIssuerBreach}>
                          {executingIssuerBreach ? "Executing" : "Execute"}
                        </Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {issuerBreachError && <span style={{ color: C.red, fontSize: 11 }}>{issuerBreachError}</span>}
            </div>
          )}

          {breachInfo?.exposureBreach && (
          <div style={{ background: "#2a1414", border: `1px solid ${C.red}`, padding: "14px 18px", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ color: C.red, fontSize: 12, letterSpacing: 1 }}>
                AEL BREACH — exposure {fmt.money(breachInfo.exposure, true)}
              </span>
              {!breachInfo.fullyResolved && (
                <span style={{ color: C.amber, fontSize: 10 }}>Partial Resolution</span>
              )}
            </div>
            <table style={{ width: "100%", fontSize: 12, marginBottom: 12 }}>
              <thead><tr style={{ color: C.dim, fontSize: 9 }}>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>SECURITY</th>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>ISIN</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>ACTION</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>SHARES</th>
                <th style={{ textAlign: "right", padding: "4px 8px" }}>MARKET VALUE</th>
              </tr></thead>
              <tbody>
                {breachInfo.proposedTransactions.map((t, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${C.lineSoft}` }}>
                    <td style={{ padding: "6px 8px" }}>{t.name}</td>
                    <td style={{ padding: "6px 8px", color: C.dim }}>{t.isin}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>{t.action}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt.int(t.shares)}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt.money(t.market_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Btn primary onClick={executeBreach} disabled={executingBreach}>
                {executingBreach ? "Executing" : "Execute"}
              </Btn>
              <Btn
                onClick={proposeAgain}
                disabled={proposingAgain || noMoreAlternatives || breachInfo.attemptNumber >= 5}
              >
                {proposingAgain ? "Searching" : `Again (${breachInfo.attemptNumber}/5)`}
              </Btn>
              {breachError && <span style={{ color: C.red, fontSize: 11 }}>{breachError}</span>}
            </div>
          </div>
        )}

          {/* Parameters */}
          <div style={{ marginBottom: 14, display: "flex", alignItems: "stretch", gap: 12 }}>
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, padding: "16px 18px", display: "flex", alignItems: "flex-end", gap: 18 }}>
            <Field label="HAIRCUT %" value={haircut} onChange={setHaircut} width={70} />
            <Field label="ISSUER LIMIT %" value={issuerLimit} onChange={setIssuerLimit} width={80} />
            <Field label="ABSOLUTE EXPOSURE LIMIT" value={absLimit} onChange={setAbsLimit} width={130} placeholder="none" numeric/>
            </div>
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, padding: "16px 18px", display: "flex", alignItems: "flex-end", gap: 18, flex: 1 }}>
            <Field label="MAX % OF SHARES" value={maxPct} onChange={setMaxPct} width={90} />
            <div>
              <div style={{ color: C.dim, fontSize: 9, letterSpacing: 1.2, marginBottom: 6 }}>LOT SIZE</div>
              <div style={{ display: "flex" }}>
                {[1, 10, 100, 1000].map((L) => (
                  <button key={L} onClick={() => setLot(L)} style={{ background: lot === L ? C.blueBg : C.panelAlt, color: lot === L ? "#cfe0ff" : C.dim, border: `1px solid ${lot === L ? C.blue : C.line}`, marginLeft: L === 1 ? 0 : -1, fontFamily: MONO, fontSize: 12, padding: "8px 12px", cursor: "pointer" }}>{L}</button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <Btn primary icon={Zap} onClick={() => autoPropose()} disabled={engine === "loading"}>Optimize</Btn>
            <Btn icon={RotateCcw} onClick={reset}>Reset</Btn>
            </div>
          </div>

          {/* Long book */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${C.line}`, color: C.dim, fontSize: 10, letterSpacing: 1.5 }}>
              <span>LONG POSITIONS</span><span>Proposed {fmt.money(provided)} / required {fmt.money(needed)}</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, userSelect: "none" }}>
                <thead><tr style={{ color: C.dim, fontSize: 9, letterSpacing: 1 }}>
                  {["SECURITY", "ISIN", "QTY TOTAL", "PRICE", "MARKET VALUE", "EXISTING COLLATERAL (SHARES)", "EXISTING MV", "PROPOSED TRANSACTIONS", "PROPOSED MV", "% POS", "% COLL", "ACTION"].map((h, i) => (
                    <th key={h} style={{ textAlign: i < 2 ? "left" : "right", padding: "10px 16px", fontWeight: 400, whiteSpace: "nowrap" }}>{h}</th>))}
                </tr></thead>
                <tbody>
                  {longs.map((l, ri) => {
                    const ex = excluded.has(l.id); const sh = proposals[l.id] || 0;
                    const pct = l.qty > 0 ? ((sh + (l.existingQty || 0)) / l.qty) * 100 : 0; const breach = rowBreach(l);
                    const totalCollateralValue = provided + existingCollateralValue;
                    const rowCombinedValue = sh * l.price + (l.existingQty || 0) * l.price;
                    const coll = totalCollateralValue > 0 ? (rowCombinedValue / totalCollateralValue) * 100 : 0;
                    const existingMV = (l.existingQty || 0) * l.price;
                    const cell = (ci) => ({
                      onMouseDown: (e) => grid.start(ri, ci, e),
                      onMouseEnter: () => grid.extend(ri, ci),
                    });
                    const S = (ci, base) => ({ ...base, ...(grid.selStyle(ri, ci) || {}) });
                    return (
                      <tr key={l.id} className="rowh" style={{ borderTop: `1px solid ${C.lineSoft}`, opacity: ex ? 0.32 : 1 }}>
                        <td {...cell(0)} style={S(0, { padding: "12px 16px", fontWeight: 600 })}>{l.name}</td>
                        <td {...cell(1)} style={S(1, { padding: "12px 16px", color: C.dim })}>{l.isin}</td>
                        <td {...cell(2)} style={S(2, { padding: "12px 16px", textAlign: "right", color: C.dim })}>{fmt.int(l.qty)}</td>
                        <td {...cell(3)} style={S(3, { padding: "12px 16px", textAlign: "right", color: C.dim })}>{fmt.price(l.price)}</td>
                        <td {...cell(4)} style={S(4, { padding: "12px 16px", textAlign: "right" })}>{fmt.money(l.mv)}</td>
                        <td {...cell(5)} style={S(5, { padding: "12px 16px", textAlign: "right", color: l.existingQty > 0 ? C.text : C.dimmer })}>
                            {l.existingQty > 0 ? fmt.int(l.existingQty) : "—"}
                        </td>
                        <td {...cell(6)} style={S(6, { padding: "12px 16px", textAlign: "right", color: l.existingQty > 0 ? C.text : C.dimmer })}>
                            {l.existingQty > 0 ? fmt.money(existingMV) : "—"}
                        </td>
                        <td {...cell(7)} style={S(7, { padding: "8px 16px", textAlign: "right" })}>
                          {!ex && <input value={sh ? Number(sh).toLocaleString('en-US') : ""} onChange={(e) => editProposed(l.id, e.target.value.replace(/,/g, ''))}
                          style={{ width: 96, textAlign: "right", background: C.panelAlt, border: `1px solid ${breach ? C.red : C.line}`, color: breach ? C.red : C.text, fontFamily: MONO, fontSize: 12.5, padding: "6px 8px", outline: "none" }} />}
                        </td>
                        <td {...cell(8)} style={S(8, { padding: "12px 16px", textAlign: "right", fontWeight: sh ? 600 : 400, color: sh ? C.text : C.dimmer })}>{sh ? fmt.money(sh * l.price) : "—"}</td>
                        <td {...cell(9)} style={S(9, { padding: "12px 16px", textAlign: "right", color: pct > 90 ? C.amber : C.dim })}>{(sh || l.existingQty) ? `${pct.toFixed(1)}%` : "—"}</td>
                        <td {...cell(10)} style={S(10, { padding: "12px 16px", textAlign: "right", color: C.dim })}>{(sh || l.existingQty) ? `${coll.toFixed(1)}%` : "—"}</td>
                        <td style={{ padding: "8px 16px", textAlign: "right" }}>
                          <button onClick={() => toggleExclude(l.id)} style={{ background: ex ? C.blueBg : "transparent", border: `1px solid ${ex ? C.blue : C.line}`, color: ex ? "#cfe0ff" : C.dim, fontFamily: MONO, fontSize: 10, letterSpacing: 1, padding: "5px 10px", cursor: "pointer" }}>{ex ? "INCLUDE" : "EXCLUDE"}</button>
                        </td>
                      </tr>);
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Short book */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${C.line}`, color: C.dim, fontSize: 10, letterSpacing: 1.5 }}>
              <span>SHORT POSITIONS</span><span>Gross {fmt.money(grossShort)}</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, }}>
                <thead><tr style={{ color: C.dim, fontSize: 9, letterSpacing: 1 }}>
                  {["SECURITY", "ISIN", "SHARES", "PRICE", "BORROW VALUE"].map((h, i) => (
                    <th key={h} style={{ textAlign: i < 2 ? "left" : "right", padding: "10px 16px", fontWeight: 400 }}>{h}</th>))}
                </tr></thead>
                <tbody>
                  {shorts.map((s) => (
                    <tr key={s.id} className="rowh" style={{ borderTop: `1px solid ${C.lineSoft}` }}>
                      <td style={{ padding: "11px 16px", fontWeight: 600 }}>{s.name}</td>
                      <td style={{ padding: "11px 16px", color: C.dim }}>{s.isin}</td>
                      <td style={{ padding: "11px 16px", textAlign: "right", color: C.red }}>{fmt.int(s.qty)}</td>
                      <td style={{ padding: "11px 16px", textAlign: "right", color: C.dim }}>{fmt.price(s.price)}</td>
                      <td style={{ padding: "11px 16px", textAlign: "right" }}>{fmt.money(s.mv)}</td>
                    </tr>))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ color: C.dimmer, fontSize: 10, marginTop: 14, letterSpacing: 0.5 }}>
            AUTO-PROPOSE calls the FastAPI backend (OR-Tools MILP). If the backend is unreachable it falls back to a
            local greedy engine so the demo never breaks. Edit any proposed quantity manually — red border flags a rule breach.
          </div>
        </>
      )}
    </div>
  );
}
