// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { RenameDialog } from "./RenameDialog"

afterEach(cleanup)

describe("RenameDialog", () => {
  it("opens as the Rename Page dialog prefilled with the current name", () => {
    render(
      <RenameDialog
        isOpen
        onClose={vi.fn()}
        onRename={vi.fn()}
        initialName="Q4 Launch Plan"
        title="Rename Page"
        description="Enter a new name for your page."
      />
    )
    expect(screen.getByRole("dialog", { name: "Rename Page" })).toBeTruthy()
    expect(screen.getByText("Enter a new name for your page.")).toBeTruthy()
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Q4 Launch Plan")
  })

  it("hands the typed name to onRename on submit", () => {
    const onRename = vi.fn()
    render(
      <RenameDialog
        isOpen
        onClose={vi.fn()}
        onRename={onRename}
        initialName="Q4 Launch Plan"
        title="Rename Page"
        description="Enter a new name for your page."
      />
    )
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Q1 Plan" } })
    fireEvent.click(screen.getByRole("button", { name: "Rename" }))
    expect(onRename).toHaveBeenCalledWith("Q1 Plan")
  })

  it("closes through Cancel without renaming", () => {
    const onClose = vi.fn()
    const onRename = vi.fn()
    render(
      <RenameDialog
        isOpen
        onClose={onClose}
        onRename={onRename}
        initialName="Q4 Launch Plan"
        title="Rename Page"
        description="Enter a new name for your page."
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).toHaveBeenCalled()
    expect(onRename).not.toHaveBeenCalled()
  })

  it("renders nothing while closed", () => {
    render(
      <RenameDialog
        isOpen={false}
        onClose={vi.fn()}
        onRename={vi.fn()}
        initialName=""
        title="Rename Page"
        description="Enter a new name for your page."
      />
    )
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
