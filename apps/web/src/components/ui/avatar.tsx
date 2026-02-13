"use client"

import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/lib/utils"

function sanitizeAvatarSrc(src: string | undefined): string | undefined {
  if (!src) {
    return src
  }

  if (!/^https?:\/\//i.test(src)) {
    return src
  }

  if (typeof window === "undefined") {
    return undefined
  }

  try {
    const parsed = new URL(src, window.location.origin)
    return parsed.origin === window.location.origin ? src : undefined
  } catch {
    return undefined
  }
}

function Avatar({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 overflow-hidden rounded-full",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({
  className,
  crossOrigin = "anonymous",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  const safeSrc = sanitizeAvatarSrc(typeof props.src === "string" ? props.src : undefined)

  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full object-cover", className)}
      crossOrigin={crossOrigin}
      {...props}
      src={safeSrc}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "bg-muted flex size-full items-center justify-center rounded-full",
        className
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback }
