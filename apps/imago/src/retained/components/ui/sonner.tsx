"use client"

import { useTheme } from "@/retained-adapters/theme"
import { useEffect, useState } from "react"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const [offset, setOffset] = useState("80px")

  useEffect(() => {
    // Check for iOS Capacitor app and adjust offset for safe area
    const isCapacitorIOS = document.documentElement.classList.contains('capacitor-ios')
    if (isCapacitorIOS) {
      // Get the safe area inset from CSS custom property
      const safeAreaTop = getComputedStyle(document.documentElement)
        .getPropertyValue('--safe-area-top')
        .trim()

      if (safeAreaTop && safeAreaTop !== '0px') {
        // Parse the safe area value and add to base offset
        const safeAreaValue = parseInt(safeAreaTop, 10) || 0
        setOffset(`${80 + safeAreaValue}px`)
      }
    }
  }, [])

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          // Imago v3 toast: a dark pill in both themes (board C-Shell-Toasts).
          "--normal-bg": "oklch(0.22 0.02 235)",
          "--normal-text": "oklch(0.97 0 0)",
          "--normal-border": "transparent",
          "--border-radius": "10px",
        } as React.CSSProperties
      }
      // At most three pills stacked; each auto-dismisses after 4s.
      visibleToasts={3}
      duration={4000}
      gap={8}
      toastOptions={{
        classNames: {
          toast: "shadow-[0_8px_24px_rgb(0_0_0_/_0.2)]",
        },
      }}
      // Errors lead with a danger dot instead of the stock error glyph.
      icons={{ error: <span data-testid="toast-danger-dot" aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9999, background: "oklch(0.65 0.2 25)" }} /> }}
      offset={offset}
      {...props}
    />
  )
}

export { Toaster }
