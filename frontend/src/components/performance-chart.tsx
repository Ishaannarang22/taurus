"use client";

import { useEffect, useRef } from "react";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
} from "chart.js";
import type { PerformancePoint } from "@/lib/data/types";
import styles from "./performance-chart.module.css";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
);

interface Props {
  data: PerformancePoint[];
}

export function PerformanceChart({ data }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const values = data.map((p) => p.value);
    const labels = data.map((p) => p.t);

    const up = values.length < 2 || values[values.length - 1] >= values[0];
    const color = up ? "#0a7c3e" : "#b91c1c";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const fill = ctx.createLinearGradient(0, 0, 0, canvas.height);
    fill.addColorStop(0, up ? "rgba(10,124,62,0.18)" : "rgba(185,28,28,0.18)");
    fill.addColorStop(1, up ? "rgba(10,124,62,0.00)" : "rgba(185,28,28,0.00)");

    if (chartRef.current) {
      chartRef.current.destroy();
    }

    chartRef.current = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: values,
            borderColor: color,
            backgroundColor: fill,
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 3,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: "#ffffff",
            pointHoverBorderWidth: 1,
            fill: true,
            tension: 0.18,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { display: false },
          y: {
            position: "right",
            grid: { color: "#eeeeec" },
            border: { display: false },
            ticks: {
              color: "#797978",
              font: {
                family: "JetBrains Mono, monospace",
                size: 10,
              },
              callback: (v) => "$" + Math.round(Number(v)).toLocaleString(),
              maxTicksLimit: 5,
            },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#0a0a0a",
            titleColor: "#ffffff",
            bodyColor: "#ffffff",
            borderColor: "#0a0a0a",
            borderWidth: 0,
            padding: 10,
            displayColors: false,
            cornerRadius: 0,
            titleFont: {
              family: "JetBrains Mono, monospace",
              size: 10,
              weight: "bold",
            },
            bodyFont: {
              family: "JetBrains Mono, monospace",
              size: 11,
            },
            callbacks: {
              title: () => "",
              label: (ctx) => "$" + (ctx.parsed.y ?? 0).toFixed(2),
            },
          },
        },
      },
    });

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [data]);

  if (data.length === 0) {
    return (
      <div className={styles.empty}>No performance data yet</div>
    );
  }

  return (
    <div className={styles.wrap}>
      <canvas ref={canvasRef} />
    </div>
  );
}
