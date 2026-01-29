"use client"

import { useTheme } from "next-themes"
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
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      offset={offset}
      {...props}
    />
  )
}

export { Toaster }
