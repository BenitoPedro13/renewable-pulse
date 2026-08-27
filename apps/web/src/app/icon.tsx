import { ImageResponse } from "next/og";

// A literal "pulse": a filled orange dot with one soft ring, matching the
// live-indicator motif described in docs/brand.md §4 ("a small pulsing dot
// ... kept subtle"). Colors are the sRGB equivalents of this app's actual
// AlignUI tokens (globals.css: --color-slate-950, --color-primary-base →
// --color-orange-500) — Satori (next/og's renderer) doesn't support oklch(),
// so these are computed once from the same source values, not invented.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0e121b",
          borderRadius: 7,
        }}
      >
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(250, 115, 25, 0.25)",
          }}
        >
          <div
            style={{
              width: 11,
              height: 11,
              borderRadius: "50%",
              background: "#fa7319",
            }}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}
