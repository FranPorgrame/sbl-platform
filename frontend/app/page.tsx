"use client";
import React, { useState, useMemo, useRef, useCallback } from "react";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { Upload, Zap, RotateCcw, Trash2, RefreshCw, Server, Wifi, WifiOff } from "lucide-react";

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

const rowsFromSample = () =>
  SAMPLE.positions.map(([name, isin, qty, price], i) => ({ id: `${isin}-${i}`, name, isin, qty, price }));

// ---- Local fallback engine (greedy) -----------------------
function optimizeLocal(longs, excluded, { loanValue, haircut, issuerLimit, absLimit, maxPct, lot }) {
  const needed = loanValue * (1 + haircut / 100);
  const issuerCapMV = issuerLimit > 0 ? (issuerLimit / 100) * needed : Infinity;
  const absCap = absLimit && absLimit > 0 ? absLimit : Infinity;
  const capMV = Math.min(issuerCapMV, absCap);
  const elig = longs.filter((l) => !excluded.has(l.id)).map((l) => ({ ...l, mv: l.qty * l.price })).sort((a, b) => b.mv - a.mv);
  let provided = 0; const prop = {};
  for (const l of elig) {
    if (provided >= needed - 1e-6) break;
    const maxByShares = Math.floor(l.qty * (maxPct / 100));
    const maxByMV = Math.floor(capMV / l.price);
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
    <div style={{ /* ...igual... */ }}>{label}</div>
    <input
      value={numeric && value !== "" ? Number(value).toLocaleString('en-US') : value}
      placeholder={placeholder}
      onChange={(e) => onChange(numeric ? e.target.value.replace(/,/g, '') : e.target.value)}
      style={{ width, /* ...igual... */ }}
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

// ============================================================
export default function App() {
  const [rows, setRows] = useState([]);
  const [filename, setFilename] = useState("");
  const [ccy, setCcy] = useState("CHF");
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

  const fmt = useFmt(ccy);

  const params = useMemo(() => ({
    loanValue: parseNum(loanValue) || 0, haircut: parseNum(haircut) || 0,
    issuerLimit: parseNum(issuerLimit) || 0, absLimit: parseNum(absLimit) || 0,
    maxPct: parseNum(maxPct) || 100, lot,
  }), [loanValue, haircut, issuerLimit, absLimit, maxPct, lot]);

  const longs = useMemo(() => rows.filter((r) => r.qty > 0).map((r) => ({ ...r, mv: r.qty * r.price })), [rows]);
  const shorts = useMemo(() => rows.filter((r) => r.qty < 0).map((r) => ({ ...r, mv: Math.abs(r.qty) * r.price })), [rows]);
  const grossShort = useMemo(() => shorts.reduce((a, s) => a + s.mv, 0), [shorts]);
  const totalMV = useMemo(() => rows.reduce((a, r) => a + Math.abs(r.qty) * r.price, 0), [rows]);
  const needed = params.loanValue * (1 + params.haircut / 100);
  const provided = useMemo(() => longs.reduce((a, l) => a + (proposals[l.id] || 0) * l.price, 0), [longs, proposals]);
  const exposure = provided - needed;
  const exposureLabel = params.absLimit > 0
    ? (exposure < -params.absLimit ? "shortfall" : exposure > params.absLimit ? "excess" : null)
    : null;

  const loadRows = (data, name) => {
    const mapped = data.map((r, i) => {
      const nm = r.name ?? r.Security ?? r["Security name"] ?? r.SECURITY ?? "";
      const isin = r.isin ?? r.ISIN ?? "";
      const qty = parseNum(r.qty ?? r.Quantity ?? r.quantity ?? r.QTY ?? r.shares);
      const price = parseNum(r.price ?? r.Price ?? r.PRICE);
      return nm && Number.isFinite(qty) && Number.isFinite(price)
        ? { id: `${isin || nm}-${i}`, name: String(nm), isin: String(isin), qty, price } : null;
    }).filter(Boolean);
    if (!mapped.length) { setError("No valid positions. Expected: Security · ISIN · Quantity · Price."); return; }
    setError(""); setRows(mapped); setFilename(name); setProposals({}); setExcluded(new Set()); setEngine("idle");
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

  const handleFile = useCallback((file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "csv") {
      Papa.parse(file, { header: true, skipEmptyLines: true, complete: (res) => loadRows(res.data, file.name), error: () => setError("Could not read CSV.") });
    } else if (["xlsx", "xls"].includes(ext)) {
      const reader = new FileReader();
      reader.onload = (e) => { try { const wb = XLSX.read(e.target.result, { type: "array" }); loadRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }), file.name); } catch { setError("Could not read Excel."); } };
      reader.readAsArrayBuffer(file);
    } else setError("Unsupported file. Use .xlsx, .xls or .csv.");
  }, []);

  // ---- AUTO-PROPOSE: calls the REAL backend ----------------
  const autoPropose = async () => {
    setEngine("loading"); setEngineMsg("");
    const payload = {
      positions: rows.map((r) => ({ name: r.name, isin: r.isin, quantity: r.qty, price: r.price })),
      rules: {
        loan_value: params.loanValue, haircut_pct: params.haircut, issuer_limit_pct: params.issuerLimit,
        absolute_exposure_limit: params.absLimit > 0 ? params.absLimit : null,
        max_pct_of_shares: params.maxPct, lot_size: params.lot, existing_collateral: {},
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Map backend proposal (keyed by isin) back to row ids, honouring exclusions.
      const next = {};
      for (const line of data.proposal || []) {
        const row = longs.find((l) => l.isin === line.isin && !excluded.has(l.id));
        if (row) next[row.id] = line.proposed_shares;
      }
      setProposals(next);
      setEngine("backend");
      setEngineMsg(`${data.status} · excess ${fmt.money(data.excess)}`);
    } catch (e) {
      // Fallback: local engine so the demo never dies.
      setProposals(optimizeLocal(longs, excluded, params));
      setEngine("local");
      setEngineMsg(e.name === "AbortError" ? "backend timeout" : "backend unreachable");
    }
  };

  const reset = () => { setProposals({}); setExcluded(new Set()); setEngine("idle"); setEngineMsg(""); };
  const clearAll = () => { setRows([]); setFilename(""); setProposals({}); setExcluded(new Set()); setLoanValue(""); setError(""); setEngine("idle"); };
  const toggleExclude = (id) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else { next.add(id); const p = { ...proposals }; delete p[id]; setProposals(p); }
    setExcluded(next);
  };
  const editProposed = (id, val) => setProposals((p) => ({ ...p, [id]: Math.max(0, Math.round(parseNum(val) || 0)) }));

  const rowBreach = (l) => {
    const sh = proposals[l.id] || 0; if (!sh) return null;
    const issuerCapMV = params.issuerLimit > 0 ? (params.issuerLimit / 100) * needed : Infinity;
    const absCap = params.absLimit > 0 ? params.absLimit : Infinity;
    if (sh * l.price > Math.min(issuerCapMV, absCap) + 1) return "issuer";
    if (sh > l.qty * (params.maxPct / 100) + 0.5) return "shares";
    if (lot > 0 && sh % lot !== 0) return "lot";
    return null;
  };

  const hasData = rows.length > 0;
  const covered = provided >= needed - 1e-6;
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
          <select value={ccy} onChange={(e) => setCcy(e.target.value)} style={{ background: C.panelAlt, color: C.text, border: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 11, padding: "6px 8px" }}>
            {["CHF", "EUR", "USD", "GBP"].map((c) => <option key={c}>{c}</option>)}
          </select>
          {hasData
            ? <><Btn icon={RefreshCw} onClick={() => fileRef.current?.click()}>Replace</Btn><Btn icon={Trash2} onClick={clearAll}>Close</Btn></>
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
            <div style={{ fontSize: 12.5, color: C.text }}>Security · ISIN · Quantity · Price</div>
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
            <Card label="TOTAL COLLATERAL" accent={covered ? C.green : C.amber} sub={`Needed ${fmt.money(needed)}`}>{fmt.money(provided)}</Card>
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
              {engine === "idle" && "ready"}
            </div>
          </div>

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
            <Btn primary icon={Zap} onClick={autoPropose} disabled={engine === "loading"}>Optimize</Btn>
            <Btn icon={RotateCcw} onClick={reset}>Reset</Btn>
            </div>
          </div>

          {/* Long book */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${C.line}`, color: C.dim, fontSize: 10, letterSpacing: 1.5 }}>
              <span>LONG POSITIONS</span><span>Proposed {fmt.money(provided)} / required {fmt.money(needed)}</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr style={{ color: C.dim, fontSize: 9, letterSpacing: 1 }}>
                  {["SECURITY", "ISIN", "QTY TOTAL", "PRICE", "MARKET VALUE", "PROPOSED TRANSACTIONS", "PROPOSED MV", "% POS", "% COLL", "ACTION"].map((h, i) => (
                    <th key={h} style={{ textAlign: i < 2 ? "left" : "right", padding: "10px 16px", fontWeight: 400, whiteSpace: "nowrap" }}>{h}</th>))}
                </tr></thead>
                <tbody>
                  {longs.map((l) => {
                    const ex = excluded.has(l.id); const sh = proposals[l.id] || 0;
                    const pct = l.qty > 0 ? (sh / l.qty) * 100 : 0; const breach = rowBreach(l);
                    const coll = provided > 0 ? (sh * l.price / provided) * 100 : 0;
                    return (
                      <tr key={l.id} className="rowh" style={{ borderTop: `1px solid ${C.lineSoft}`, opacity: ex ? 0.32 : 1 }}>
                        <td style={{ padding: "12px 16px", fontWeight: 600 }}>{l.name}</td>
                        <td style={{ padding: "12px 16px", color: C.dim }}>{l.isin}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right", color: C.dim }}>{fmt.int(l.qty)}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right", color: C.dim }}>{fmt.price(l.price)}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right" }}>{fmt.money(l.mv)}</td>
                        <td style={{ padding: "8px 16px", textAlign: "right" }}>
                          {!ex && <input value={sh ? Number(sh).toLocaleString('en-US') : ""} onChange={(e) => editProposed(l.id, e.target.value.replace(/,/g, ''))}
                          style={{ width: 96, textAlign: "right", background: C.panelAlt, border: `1px solid ${breach ? C.red : C.line}`, color: breach ? C.red : C.text, fontFamily: MONO, fontSize: 12.5, padding: "6px 8px", outline: "none" }} />}
                        </td>
                        <td style={{ padding: "12px 16px", textAlign: "right", fontWeight: sh ? 600 : 400, color: sh ? C.text : C.dimmer }}>{sh ? fmt.money(sh * l.price) : "—"}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right", color: pct > 90 ? C.amber : C.dim }}>{sh ? `${pct.toFixed(1)}%` : "—"}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right", color: C.dim }}>{sh ? `${coll.toFixed(1)}%` : "—"}</td>
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
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
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
