// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect, useRef } from "react"
import { ImageCropperDialog } from "./ImageCropperDialog"

const mocks = vi.hoisted(() => ({ completeOnMount: false }))

// react-image-crop measures a real image, which jsdom cannot lay out. The stand-in reports the
// circular flag it was given, and completes a crop on mount only when a test asks for one.
vi.mock("react-image-crop", () => ({
  default: function MockReactCrop({
    children,
    circularCrop,
    onComplete,
  }: {
    children: React.ReactNode
    circularCrop?: boolean
    onComplete: (crop: { x: number; y: number; width: number; height: number; unit: "px" }) => void
  }) {
    const completed = useRef(false)
    useEffect(() => {
      if (completed.current || !mocks.completeOnMount) return
      completed.current = true
      onComplete({ x: 0, y: 0, width: 100, height: 100, unit: "px" })
    }, [onComplete])
    return <div data-testid="crop-window" data-circular={String(circularCrop)}>{children}</div>
  },
  centerCrop: (crop: unknown) => crop,
  makeAspectCrop: () => ({ unit: "%", x: 0, y: 0, width: 90, height: 90 }),
}))
vi.mock("react-image-crop/dist/ReactCrop.css", () => ({}))

const renderDialog = (overrides: Partial<React.ComponentProps<typeof ImageCropperDialog>> = {}) => {
  const onOpenChange = vi.fn()
  const onCropComplete = vi.fn()
  render(
    <ImageCropperDialog
      open
      onOpenChange={onOpenChange}
      imageSrc="data:image/png;base64,AAAA"
      onCropComplete={onCropComplete}
      {...overrides}
    />
  )
  return { onOpenChange, onCropComplete }
}

const shapeButton = (name: "Circle" | "Square") => screen.getByRole("radio", { name }) as HTMLButtonElement

beforeEach(() => {
  mocks.completeOnMount = false
  // jsdom has no 2d canvas or PNG encoder; the stand-ins let an Apply reach onCropComplete.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        scale: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        clip: vi.fn(),
        drawImage: vi.fn(),
      }) as unknown as CanvasRenderingContext2D
  )
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value(callback: BlobCallback) {
      callback(new Blob(["png"], { type: "image/png" }))
    },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ImageCropperDialog", () => {
  it("opens as Crop Avatar with a Circle or Square radio group, circle first", () => {
    renderDialog()
    expect(screen.getByRole("dialog", { name: "Crop Avatar" })).toBeTruthy()
    expect(screen.getByRole("radiogroup", { name: "Crop shape" })).toBeTruthy()
    expect(shapeButton("Circle").getAttribute("aria-checked")).toBe("true")
    expect(screen.getByTestId("crop-window").getAttribute("data-circular")).toBe("true")
  })

  it("switches the crop window to a square when Square is chosen", () => {
    renderDialog()
    fireEvent.click(shapeButton("Square"))
    expect(shapeButton("Square").getAttribute("aria-checked")).toBe("true")
    expect(screen.getByTestId("crop-window").getAttribute("data-circular")).toBe("false")
  })

  it("keeps Apply disabled until a crop has been made", () => {
    renderDialog()
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("Cancel closes the dialog without producing a cropped image", () => {
    mocks.completeOnMount = true
    const { onOpenChange, onCropComplete } = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onCropComplete).not.toHaveBeenCalled()
  })

  it("Apply hands the cropped PNG to the page and closes the dialog", async () => {
    mocks.completeOnMount = true
    const { onOpenChange, onCropComplete } = renderDialog()
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement
    await waitFor(() => expect(apply.disabled).toBe(false))
    fireEvent.click(apply)
    await waitFor(() => expect(onCropComplete).toHaveBeenCalledTimes(1))
    const blob = onCropComplete.mock.calls[0]?.[0] as Blob
    expect(blob.type).toBe("image/png")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
