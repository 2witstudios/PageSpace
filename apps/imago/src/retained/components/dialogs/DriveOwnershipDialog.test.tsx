// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DriveOwnershipDialog } from "./DriveOwnershipDialog"

const mocks = vi.hoisted(() => ({ post: vi.fn(), toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("@/retained/lib/auth/auth-fetch", () => ({ post: mocks.post }))
vi.mock("sonner", () => ({ toast: mocks.toast }))

const drives = [
  {
    id: "drive-1",
    name: "Studio",
    memberCount: 5,
    admins: [{ id: "user-2", name: "Dana", email: "dana@studio.example" }],
  },
  { id: "drive-2", name: "Lab", memberCount: 2, admins: [] },
]

const renderDialog = () => {
  const onAllDrivesHandled = vi.fn()
  render(
    <DriveOwnershipDialog
      isOpen
      onClose={vi.fn()}
      onAllDrivesHandled={onAllDrivesHandled}
      multiMemberDrives={drives}
    />
  )
  return { onAllDrivesHandled }
}

beforeEach(() => {
  mocks.post.mockReset().mockResolvedValue({})
  mocks.toast.success.mockReset()
  mocks.toast.error.mockReset()
})

afterEach(cleanup)

describe("DriveOwnershipDialog", () => {
  it("opens as Handle Drive Ownership and counts the drives shared with other members", () => {
    renderDialog()
    expect(screen.getByRole("dialog", { name: "Handle Drive Ownership" })).toBeTruthy()
    expect(screen.getByText("You own 2 drives with other members:")).toBeTruthy()
  })

  it("keeps Transfer disabled until a new admin owner is chosen", () => {
    renderDialog()
    const transfer = screen.getAllByRole("button", { name: "Transfer" })[0] as HTMLButtonElement
    expect(transfer.disabled).toBe(true)
  })

  it("a drive with no admins can only be deleted, and Delete Drive asks the handle-drive route to delete it", async () => {
    const { onAllDrivesHandled } = renderDialog()
    expect(screen.getByText(/No admins available to transfer to/)).toBeTruthy()

    fireEvent.click(screen.getAllByRole("button", { name: "Delete Drive" })[1] as HTMLButtonElement)

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith("/api/account/handle-drive", { driveId: "drive-2", action: "delete" })
    )
    expect(mocks.toast.success).toHaveBeenCalledWith('Deleted drive "Lab"')
    expect(onAllDrivesHandled).not.toHaveBeenCalled()
  })
})
