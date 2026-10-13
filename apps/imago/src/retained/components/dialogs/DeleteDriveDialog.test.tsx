// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { DeleteDriveDialog } from "./DeleteDriveDialog"

afterEach(cleanup)

const renderDialog = (onConfirm = vi.fn(), memberCount?: number) => {
  render(
    <DeleteDriveDialog
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      driveName="Studio"
      memberCount={memberCount}
    />
  )
  return onConfirm
}

describe("DeleteDriveDialog", () => {
  it("keeps Delete Drive disabled until the drive name is typed", () => {
    const onConfirm = renderDialog()
    const action = screen.getByRole("button", { name: "Delete Drive" }) as HTMLButtonElement
    expect(action.disabled).toBe(true)
    fireEvent.click(action)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Type the drive name/), { target: { value: "Studio" } })
    expect((screen.getByRole("button", { name: "Delete Drive" }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Delete Drive" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("does not enable Delete Drive for a partial name", () => {
    renderDialog()
    fireEvent.change(screen.getByPlaceholderText("Enter drive name"), { target: { value: "Stud" } })
    expect((screen.getByRole("button", { name: "Delete Drive" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("lists the other members who will lose access", () => {
    renderDialog(vi.fn(), 5)
    expect(screen.getByText("4 other members will lose access to this drive")).toBeTruthy()
  })
})
