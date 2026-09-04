"use client";

import {
  CandlestickSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import { saleMarkerTimes, toBars, type Candle } from "@/lib/market/series";

/**
 * The price chart (#12), on the Lightweight Charts v5 API.
 *
 * v5 renamed enough that stale snippets compile to nothing: series are added
 * with `addSeries(CandlestickSeries, …)` rather than `addCandlestickSeries(…)`,
 * and markers are a primitive created with `createSeriesMarkers(series, …)`
 * rather than `series.setMarkers(…)`, which no longer exists on `ISeriesApi`.
 *
 * ## Direction survives greyscale
 *
 * Up candles are filled green, down candles are hollow with a red border. The
 * fill is the signal and the colour is the reinforcement, so a greyscale print
 * or a red-green colour-blind reader still reads direction correctly. This is
 * the one surface in the product where green and red are permitted, and they
 * mean price direction and nothing else.
 *
 * ## What is drawn
 *
 * Candles come from sampled asks and markers from real purchases. There is no
 * path in this component that can add either — it renders what it is handed, and
 * `toBars`/`saleMarkerTimes` refuse to invent anything upstream of it.
 *
 * ## Lifecycle
 *
 * The chart is created once per (data, size) change and removed in cleanup.
 * Recreating it per render duplicates canvases and leaks listeners; never
 * removing it leaks the whole chart on unmount.
 */

/**
 * The chart's palette, read from the design tokens rather than repeated here.
 *
 * A canvas cannot consume a CSS custom property, so the values have to be real
 * colour strings by the time the library sees them — but hard-coding them would
 * fork the palette, which is exactly what the `no-raw-hex` rule exists to stop.
 * Reading the tokens keeps one source of truth: retheme the app and the chart
 * follows.
 *
 * Safe to read here because the chart is only ever created in an effect, long
 * after the stylesheet has applied.
 */
function palette() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();

  return {
    /** Filled up. The one place in the product green means anything. */
    up: token("--color-up"),
    /** Hollow with this border down — the fill, not the hue, carries direction. */
    down: token("--color-down"),
    /** A sale. Navy, like every other marker of a real event in this product. */
    sale: token("--color-navy"),
    grid: token("--color-chart-grid"),
    ink: token("--color-ink"),
    paper: token("--color-paper"),
  };
}

/** A transparent body is what makes a down candle hollow. */
const TRANSPARENT = "rgba(0,0,0,0)";

export type PriceChartProps = {
  candles: Candle[];
  saleMs: number[];
  /** The slot's base rate in cents, drawn as the dashed reference line. */
  baseHrCents: number;
  /** Sparkline: a navy line, no axes, no interaction. Under 620px (#12). */
  spark?: boolean;
  height?: number;
};

export function PriceChart({
  candles,
  saleMs,
  baseHrCents,
  spark = false,
  height,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chartHeight = height ?? (spark ? 110 : 260);
    const colour = palette();

    const chart: IChartApi = createChart(container, {
      width: container.clientWidth,
      height: chartHeight,
      layout: {
        background: { color: colour.paper },
        textColor: colour.ink,
        fontFamily: "Verdana, Geneva, sans-serif",
        fontSize: 10,
        // The licence is satisfied by the attribution in the panel footer, which
        // is a deliberate, visible home for it rather than a hidden watermark.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: spark ? TRANSPARENT : colour.grid },
        horzLines: { color: spark ? TRANSPARENT : colour.grid },
      },
      rightPriceScale: { visible: !spark, borderColor: colour.ink },
      timeScale: {
        visible: !spark,
        borderColor: colour.ink,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 0 },
      // A sparkline is a summary, not something to pan around in.
      handleScroll: !spark,
      handleScale: !spark,
    });

    const bars = toBars(candles);

    if (spark) {
      const line: ISeriesApi<"Line"> = chart.addSeries(LineSeries, {
        color: colour.sale,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      line.setData(bars.map((bar) => ({ time: bar.time as UTCTimestamp, value: bar.close })));
    } else {
      const series: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
        upColor: colour.up,
        borderUpColor: colour.up,
        wickUpColor: colour.up,
        // Hollow, so direction is legible without relying on hue at all.
        downColor: TRANSPARENT,
        borderDownColor: colour.down,
        wickDownColor: colour.down,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      });
      series.setData(bars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })));

      series.createPriceLine({
        price: baseHrCents / 100,
        color: colour.ink,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "base",
      });

      // A marker whose time does not match a data point is dropped silently, so
      // `saleMarkerTimes` only returns hours that actually have a candle.
      createSeriesMarkers(
        series,
        saleMarkerTimes(saleMs, candles).map((time) => ({
          time: time as UTCTimestamp,
          position: "belowBar" as const,
          color: colour.sale,
          shape: "circle" as const,
          size: 0.6,
        })),
      );
    }

    chart.timeScale().fitContent();

    // The panel is fluid, so the chart has to follow its container rather than
    // the viewport — a media query would miss a resize that changes the column.
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [candles, saleMs, baseHrCents, spark, height]);

  return (
    <div
      ref={containerRef}
      data-testid="price-chart"
      data-spark={spark ? "true" : "false"}
      className="w-full"
      // The canvas carries no text, so the reading of it lives here.
      role="img"
      aria-label={
        spark
          ? `Sparkline of the ask over ${candles.length} sampled hours`
          : `Hourly candles of the ask over ${candles.length} sampled hours, with a dashed line at the base rate`
      }
    />
  );
}
