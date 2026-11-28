// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, act, cleanup, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { Toaster } from "./sonner"

vi.mock("@/retained-adapters/theme", () => ({
  useTheme: () => ({ theme: "light" }),
}))

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function toasts(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"))
}

describe("Imago v3 toast stack (C-Shell-Toasts)", () => {
  afterEach(() => {
    act(() => toast.dismiss())
    cleanup()
  })

  it("renders the stack as dark pills in both themes", async () => {
    render(<Toaster />)
    await act(async () => {
      toast("Link copied")
    })
    await flush()
    const host = document.querySelector<HTMLElement>("[data-sonner-toaster]")
    const style = host?.getAttribute("style") ?? ""
    expect(style).toContain("--normal-bg: oklch(0.22 0.02 235)")
    expect(style).toContain("--normal-text: oklch(0.97 0 0)")
    expect(screen.getByText("Link copied")).toBeTruthy()
    expect(toasts()[0].className).toContain("shadow-[0_8px_24px_rgb(0_0_0_/_0.2)]")
  })

  it("shows at most three toasts, newest last", async () => {
    render(<Toaster />)
    await act(async () => {
      toast("one")
      toast("two")
      toast("three")
      toast("four")
    })
    await flush()
    const visible = toasts().filter((el) => el.getAttribute("data-visible") !== "false")
    const texts = visible.map((el) => el.textContent ?? "")
    expect(visible.length).toBeLessThanOrEqual(3)
    expect(texts.some((text) => text.includes("one"))).toBe(false)
    expect(texts.some((text) => text.includes("four"))).toBe(true)
  })

  it("auto-dismisses after 4 seconds", async () => {
    render(<Toaster />)
    await act(async () => {
      toast("Page renamed.")
    })
    await flush()
    expect(screen.getByText("Page renamed.")).toBeTruthy()
    await waitFor(() => expect(screen.queryByText("Page renamed.")).toBeNull(), { timeout: 6000 })
  }, 10000)

  it("moves a loading toast to its result under the same id", async () => {
    render(<Toaster />)
    await act(async () => {
      toast.loading("Moving page to trash...", { id: "trash" })
    })
    await flush()
    expect(screen.getByText("Moving page to trash...")).toBeTruthy()
    await act(async () => {
      toast.success("Page moved to trash.", { id: "trash" })
    })
    await flush()
    expect(screen.queryByText("Moving page to trash...")).toBeNull()
    expect(screen.getByText("Page moved to trash.")).toBeTruthy()
  })

  it("leads error toasts with a danger dot", async () => {
    render(<Toaster />)
    await act(async () => {
      toast.error("Error renaming page.")
    })
    await flush()
    const errorToast = toasts().find((el) => el.textContent?.includes("Error renaming page."))
    expect(errorToast).toBeTruthy()
    expect(errorToast?.querySelector('[data-testid="toast-danger-dot"]')).not.toBeNull()
  })
})
