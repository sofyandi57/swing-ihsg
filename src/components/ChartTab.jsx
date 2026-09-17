import { useEffect, useRef, useState } from "react";
import { createChart, CrosshairMode } from "lightweight-charts";

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

export default function ChartTab() {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);

  const [code, setCode] = useState("BBCA");
  const [inputValue, setInputValue] = useState("BBCA");
  const [timeframe, setTimeframe] = useState("D");
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [error, setError] = useState("");
  const [lastCandle, setLastCandle] = useState(null);

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

  async function loadChart(symbolCode, tf) {
    setStatus("loading");
    setError("");

    try {
      const resp = await fetch(`/api/stock-chart?code=${encodeURIComponent(symbolCode)}&timeframe=${tf}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);

      const candles = json.candles || [];
      if (candles.length === 0) {
        setStatus("done");
        setLastCandle(null);
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

  function handleSearch(e) {
    e.preventDefault();
    const trimmed = inputValue.trim().toUpperCase();
    if (!trimmed) return;
    setCode(trimmed);
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
          <div className="state-box">Tidak ada data candlestick untuk {code} pada timeframe ini.</div>
        )}
      </div>
    </>
  );
}
