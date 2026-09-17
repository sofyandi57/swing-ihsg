import { useEffect, useRef, useState } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";
import { authFetch } from "../lib/supabaseClient.js";

const TIMEFRAMES = [
  { id: "1", label: "1m" },
  { id: "5", label: "5m" },
  { id: "15", label: "15m" },
  { id: "30", label: "30m" },
  { id: "60", label: "1h" },
  { id: "D", label: "Daily" },
];

function toUnixTime(dateStr) {
  // Data intraday dari Invezgo pakai ISO datetime, data daily pakai tanggal saja —
  // lightweight-charts butuh unix seconds untuk timeframe intraday supaya jam
  // tampil benar di sumbu waktu.
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

// Sama persis dengan technical-analysis.js — swing high/low dari 80 candle
// terakhir. Dihitung di BROWSER (bukan lewat API lagi) supaya garis langsung
// tergambar begitu chart dimuat, tanpa menunggu klik tombol terpisah.
function findSupportResistance(candles, currentPrice, lookback = 3) {
  const window = candles.slice(-80);
  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < window.length - lookback; i++) {
    const slice = window.slice(i - lookback, i + lookback + 1);
    const current = window[i];
    if (current.high === Math.max(...slice.map((c) => c.high))) swingHighs.push(current.high);
    if (current.low === Math.min(...slice.map((c) => c.low))) swingLows.push(current.low);
  }

  const resistances = [...new Set(swingHighs)].filter((h) => h > currentPrice).sort((a, b) => a - b);
  const supports = [...new Set(swingLows)].filter((l) => l < currentPrice).sort((a, b) => b - a);

  return {
    nearestSupport: supports[0] ?? null,
    nearestResistance: resistances[0] ?? null,
  };
}

// Fibonacci retracement standar antara swing high dan swing low TERTINGGI/
// TERENDAH dalam 80 candle terakhir (bukan yang "nearest" seperti support/
// resistance) — level 0%/100% di titik ekstrem, sisanya di antaranya.
const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

function computeFibonacci(candles) {
  const window = candles.slice(-80);
  if (window.length < 10) return null;

  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (const c of window) {
    if (c.high > swingHigh) swingHigh = c.high;
    if (c.low < swingLow) swingLow = c.low;
  }
  if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow) || swingHigh <= swingLow) return null;

  const range = swingHigh - swingLow;
  return FIB_RATIOS.map((ratio) => ({
    ratio,
    price: swingHigh - range * ratio,
  }));
}

export default function ChartTab() {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const priceLinesRef = useRef([]); // garis S/R + Fibonacci yang sedang tergambar — perlu di-remove manual sebelum gambar ulang

  const [code, setCode] = useState("BBCA");
  const [inputValue, setInputValue] = useState("BBCA");
  const [timeframe, setTimeframe] = useState("D");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [emptyNote, setEmptyNote] = useState("");
  const [lastCandle, setLastCandle] = useState(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const candlesRef = useRef([]);

  const [taStatus, setTaStatus] = useState("idle"); // idle | loading | done | error
  const [taResult, setTaResult] = useState(null);
  const [taError, setTaError] = useState("");

  // Setup chart sekali saat mount
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#8b909c",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1b1e24" },
        horzLines: { color: "#1b1e24" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#262930" },
      timeScale: { borderColor: "#262930", timeVisible: true, secondsVisible: false },
      height: 320,
      autoSize: true,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });

    chartRef.current = chart;
    seriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  function clearOverlay() {
    priceLinesRef.current.forEach((line) => {
      try {
        seriesRef.current?.removePriceLine(line);
      } catch (e) {
        // chart/series sudah di-remove (unmount) — abaikan
      }
    });
    priceLinesRef.current = [];
  }

  function drawOverlay(candles) {
    clearOverlay();
    if (!showOverlay || candles.length < 20) return;

    const currentPrice = candles[candles.length - 1].close;
    const { nearestSupport, nearestResistance } = findSupportResistance(candles, currentPrice);
    const fib = computeFibonacci(candles);

    const lines = [];
    if (nearestSupport) {
      lines.push(
        seriesRef.current.createPriceLine({
          price: nearestSupport,
          color: "#22c55e",
          lineWidth: 2,
          lineStyle: 2, // dashed
          axisLabelVisible: true,
          title: "Support",
        })
      );
    }
    if (nearestResistance) {
      lines.push(
        seriesRef.current.createPriceLine({
          price: nearestResistance,
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "Resistance",
        })
      );
    }
    if (fib) {
      fib.forEach(({ ratio, price }) => {
        // 0% dan 100% sudah terwakili sebagai swing high/low — tetap digambar
        // tipis supaya konteks range-nya kelihatan, tapi warna lebih redup.
        const isEdge = ratio === 0 || ratio === 1;
        lines.push(
          seriesRef.current.createPriceLine({
            price,
            color: isEdge ? "#5f636c" : "#8b6bff",
            lineWidth: 1,
            lineStyle: 3, // dotted
            axisLabelVisible: true,
            title: `Fib ${(ratio * 100).toFixed(1)}%`,
          })
        );
      });
    }
    priceLinesRef.current = lines;
  }

  async function loadChart(symbolCode, tf) {
    setStatus("loading");
    setError("");
    setEmptyNote("");
    clearOverlay();

    try {
      const resp = await authFetch(`/api/stock-chart?code=${encodeURIComponent(symbolCode)}&timeframe=${tf}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      const candles = json.candles || [];
      candlesRef.current = candles;
      setTaResult(null);
      setTaError("");

      if (candles.length === 0) {
        setStatus("done");
        setLastCandle(null);
        setEmptyNote(json.note || "");
        seriesRef.current?.setData([]);
        volumeSeriesRef.current?.setData([]);
        return;
      }

      const candleData = candles.map((c) => ({
        time: toUnixTime(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      const volumeData = candles.map((c) => ({
        time: toUnixTime(c.time),
        value: c.volume,
        color: c.close >= c.open ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
      }));

      seriesRef.current?.setData(candleData);
      volumeSeriesRef.current?.setData(volumeData);
      chartRef.current?.timeScale().fitContent();
      drawOverlay(candles);

      setLastCandle(candles[candles.length - 1]);
      setStatus("done");
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  }

  useEffect(() => {
    loadChart(code, timeframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, timeframe]);

  useEffect(() => {
    if (candlesRef.current.length > 0) drawOverlay(candlesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOverlay]);

  function handleSearch(e) {
    e.preventDefault();
    const trimmed = inputValue.trim().toUpperCase();
    if (!trimmed) return;
    setCode(trimmed);
  }

  async function runTechnicalAnalysis() {
    if (candlesRef.current.length < 20) {
      setTaError("Data candle belum cukup (minimal 20) untuk analisa teknikal.");
      setTaStatus("error");
      return;
    }

    setTaStatus("loading");
    setTaError("");
    setTaResult(null);

    try {
      const resp = await authFetch("/api/technical-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, timeframe, candles: candlesRef.current }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      setTaResult(json);
      setTaStatus("done");
    } catch (e) {
      setTaError(e.message);
      setTaStatus("error");
    }
  }

  return (
    <>
      <div className="card">
        <h2>📊 OHLCV Chart</h2>
        <p className="sub">
          Candlestick multi-timeframe dari Invezgo. Timeframe 1/5/15/30 menit dan
          1 jam terbatas rentang historisnya (lihat catatan di bawah chart).
        </p>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            className="input"
            style={{ minHeight: 40, flex: 1 }}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Kode saham, misal BBCA"
          />
          <button className="btn btn-primary" type="submit" style={{ minHeight: 40 }}>
            Cari
          </button>
        </form>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.id}
              className="btn btn-ghost"
              style={{
                background: timeframe === tf.id ? "var(--accent-bg)" : "var(--panel-2)",
                color: timeframe === tf.id ? "var(--accent)" : "var(--text)",
                borderColor: timeframe === tf.id ? "var(--accent)" : "var(--border)",
              }}
              onClick={() => setTimeframe(tf.id)}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" checked={showOverlay} onChange={(e) => setShowOverlay(e.target.checked)} />
          📐 Tampilkan Support/Resistance + Fibonacci di chart
        </label>
      </div>

      {error && <div className="error-box">Gagal memuat chart: {error}</div>}

      <div className="card" style={{ padding: 8 }}>
        <div style={{ padding: "8px 8px 0" }}>
          <span className="result-code">{code}</span>{" "}
          {lastCandle && (
            <span className="sub" style={{ display: "inline" }}>
              · O {lastCandle.open} H {lastCandle.high} L {lastCandle.low} C {lastCandle.close} · Vol{" "}
              {new Intl.NumberFormat("id-ID").format(lastCandle.volume)}
            </span>
          )}
        </div>
        <div ref={containerRef} style={{ width: "100%", height: 320 }} />
        {status === "loading" && (
          <div className="state-box">
            <div className="spinner" />
            Memuat chart...
          </div>
        )}
        {status === "done" && !lastCandle && (
          <div className="state-box">
            Tidak ada data candlestick untuk {code} pada timeframe ini.
            {emptyNote && <div style={{ marginTop: 8, fontSize: 12 }}>{emptyNote}</div>}
          </div>
        )}
      </div>

      {status === "done" && lastCandle && (
        <div className="card">
          <h2>🎯 Analisa Teknikal</h2>
          <p className="sub">
            Hitung SMA20/50, RSI14, dan support/resistance dari swing high/low —
            lalu AI narasikan jadi area beli, area jual, dan stop-loss. Alat
            bantu baca data, bukan rekomendasi transaksi.
          </p>
          <button className="btn btn-primary btn-block" onClick={runTechnicalAnalysis} disabled={taStatus === "loading"}>
            {taStatus === "loading" ? "⏳ Menganalisa..." : "🎯 Analisa Teknikal Sekarang"}
          </button>

          {taError && <div className="error-box" style={{ marginTop: 12 }}>Gagal analisa: {taError}</div>}

          {taResult && (
            <div style={{ marginTop: 12 }}>
              <div className="result-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginBottom: 12 }}>
                <div className="result-metric">
                  <span className="result-metric-label">Tren</span>
                  <span className="result-metric-value">
                    {taResult.indicators.trend === "uptrend" ? "📈 Uptrend" : taResult.indicators.trend === "downtrend" ? "📉 Downtrend" : "➡️ Sideways"}
                  </span>
                </div>
                <div className="result-metric">
                  <span className="result-metric-label">RSI(14)</span>
                  <span className="result-metric-value">{taResult.indicators.rsi14 ? taResult.indicators.rsi14.toFixed(1) : "—"}</span>
                </div>
                <div className="result-metric">
                  <span className="result-metric-label">Support Terdekat</span>
                  <span className="result-metric-value up">{taResult.indicators.nearestSupport ?? "—"}</span>
                </div>
                <div className="result-metric">
                  <span className="result-metric-label">Resistance Terdekat</span>
                  <span className="result-metric-value down">{taResult.indicators.nearestResistance ?? "—"}</span>
                </div>
                <div className="result-metric">
                  <span className="result-metric-label">SMA20</span>
                  <span className="result-metric-value">{taResult.indicators.sma20 ? taResult.indicators.sma20.toFixed(1) : "—"}</span>
                </div>
                <div className="result-metric">
                  <span className="result-metric-label">SMA50</span>
                  <span className="result-metric-value">{taResult.indicators.sma50 ? taResult.indicators.sma50.toFixed(1) : "—"}</span>
                </div>
              </div>

              {taResult.narrative ? (
                <div className="insight-box">
                  <div className="insight-label">🤖 Kesimpulan Area Beli/Jual</div>
                  {taResult.narrative}
                </div>
              ) : (
                <div className="sub">
                  ⚠ Narasi AI tidak tersedia (Groq nonaktif{taResult.groqSkipReason ? ": " + taResult.groqSkipReason : ""}).
                  Baca angka support/resistance & tren di atas secara manual: area beli wajar
                  dekat support, area jual/target dekat resistance, stop-loss sedikit di bawah support.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
