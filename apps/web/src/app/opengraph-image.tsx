import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Renewable Pulse — a live instrument panel for global renewable electricity generation";

// Colors are the sRGB equivalents of this app's actual AlignUI tokens
// (globals.css: --color-slate-950/900/500/50, --color-primary-base →
// --color-orange-500/600) — Satori (next/og's renderer) doesn't support
// oklch(), so these are computed once from the same source values, not a
// separate invented palette (docs/brand.md §5: no colors outside the
// AlignUI ramps).
const colors = {
  bg: "#0e121b",
  panel: "#181b25",
  textStrong: "#f5f7fa",
  textMuted: "#717784",
  orange: "#fa7319",
  orangeDim: "#e16614",
};

// next/og needs raw font bytes (Satori doesn't read next/font's CSS
// variables) — fetched once at build time from Google's CDN, the same
// documented pattern Vercel's own og-examples repo uses. Requesting with
// an old-browser User-Agent gets a .ttf back instead of .woff2, which
// Satori parses directly.
async function loadInter(weight: 400 | 700) {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=Inter:wght@${weight}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/534.34 (KHTML, like Gecko) PhantomJS/1.9.7 Safari/534.34",
    },
  }).then((res) => res.text());

  const fontUrl = css.match(/src: url\(([^)]+)\) format\('truetype'\)/)?.[1];
  if (!fontUrl) throw new Error("opengraph-image: could not resolve Inter font URL");
  return fetch(fontUrl).then((res) => res.arrayBuffer());
}

// The four generation-source colors from docs/brand.md §2's categorical
// palette (hydro/solar/wind/thermal), used purely as decoration here (a
// small stylized mix bar) — not tied to any real reading.
const mixBar = [
  { color: "#2b7fff", width: 46 }, // hydro — information ramp
  { color: colors.orange, width: 22 }, // solar — primary
  { color: "#22a5a0", width: 18 }, // wind — stable/teal
  { color: "#e0403a", width: 14 }, // thermal — error/red
];

export default async function OpengraphImage() {
  const [interRegular, interBold] = await Promise.all([loadInter(400), loadInter(700)]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: colors.bg,
          fontFamily: "Inter",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(250, 115, 25, 0.2)",
            }}
          >
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: colors.orange }} />
          </div>
          <div style={{ display: "flex", fontSize: 28, color: colors.textMuted, letterSpacing: 1 }}>
            RENEWABLE PULSE
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              display: "flex",
              fontSize: 68,
              fontWeight: 700,
              color: colors.textStrong,
              lineHeight: 1.1,
              maxWidth: 980,
            }}
          >
            How much of the world&apos;s electricity is already renewable?
          </div>
          <div style={{ display: "flex", fontSize: 28, color: colors.textMuted, maxWidth: 860 }}>
            A live instrument panel sourced entirely from real grid-operator data — Brazil,
            Norway, and the USA.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", width: "100%", height: 14, borderRadius: 7, overflow: "hidden" }}>
            {mixBar.map((seg) => (
              <div key={seg.color} style={{ display: "flex", width: `${seg.width}%`, height: "100%", background: seg.color }} />
            ))}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: colors.textMuted }}>
            ONS · ENTSO-E · EIA — real API responses, no synthetic data
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Inter", data: interRegular, weight: 400, style: "normal" },
        { name: "Inter", data: interBold, weight: 700, style: "normal" },
      ],
    },
  );
}
