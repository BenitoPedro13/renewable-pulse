import { ImageResponse } from "next/og";

// Same mark as icon.tsx, at Apple's recommended touch-icon size — see that
// file's comment for where the colors come from.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
        }}
      >
        <div
          style={{
            width: 108,
            height: 108,
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(250, 115, 25, 0.25)",
          }}
        >
          <div
            style={{
              width: 60,
              height: 60,
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
