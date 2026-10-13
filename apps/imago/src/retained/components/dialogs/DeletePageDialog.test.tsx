// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { DeletePageDialog } from "./DeletePageDialog"

afterEach(cleanup)

describe("DeletePageDialog", () => {
  it("offers a single Move to Trash for a page without children", () => {
    const onConfirm = vi.fn()
    render(<DeletePageDialog isOpen onClose={vi.fn()} onConfirm={onConfirm} hasChildren={false} />)
    expect(screen.getByRole("alertdialog", { name: "Are you sure?" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Move Page Only" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it("offers Move Page Only and Move Page and All Contents for a folder with children", () => {
    const onConfirm = vi.fn()
    render(<DeletePageDialog isOpen onClose={vi.fn()} onConfirm={onConfirm} hasChildren />)
    expect(screen.queryByRole("button", { name: "Move to Trash" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Move Page Only" }))
    expect(onConfirm).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole("button", { name: "Move Page and All Contents" }))
    expect(onConfirm).toHaveBeenLastCalledWith(true)
  })

  it("cancels without confirming", () => {
    const onConfirm = vi.fn()
    render(<DeletePageDialog isOpen onClose={vi.fn()} onConfirm={onConfirm} hasChildren={false} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
