// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { UserSafetyMenu } from "./UserSafetyMenu"

const post = vi.fn()
const toast = { success: vi.fn(), error: vi.fn() }

vi.mock("@/retained/lib/auth/auth-fetch", () => ({
  post: (...args: unknown[]) => post(...args),
}))
vi.mock("sonner", () => ({
  toast: { success: (...args: unknown[]) => toast.success(...args), error: (...args: unknown[]) => toast.error(...args) },
}))

const openMenu = () => {
  fireEvent.keyDown(screen.getByRole("button", { name: "More options for Dana" }), { key: "Enter" })
}

describe("UserSafetyMenu", () => {
  afterEach(cleanup)

  beforeEach(() => {
    post.mockReset()
    post.mockResolvedValue({})
    toast.success.mockReset()
    toast.error.mockReset()
  })

  it("opens a menu with Report and Block items from the More options trigger", () => {
    render(<UserSafetyMenu userId="u2" displayName="Dana" />)
    openMenu()
    expect(screen.getByRole("menuitem", { name: "Report Dana" })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: "Block Dana" })).toBeTruthy()
  })

  it("keeps Send report disabled until a reason is typed, then posts the report", async () => {
    render(<UserSafetyMenu userId="u2" displayName="Dana" conversationId="c1" />)
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Report Dana" }))

    const dialog = screen.getByRole("dialog")
    expect(dialog).toBeTruthy()
    expect(screen.getByText("0 / 2,000")).toBeTruthy()
    const send = screen.getByRole("button", { name: "Send report" }) as HTMLButtonElement
    expect(send.disabled).toBe(true)

    const reason = screen.getByLabelText("What happened?") as HTMLTextAreaElement
    fireEvent.change(reason, { target: { value: "  abusive  " } })
    expect(screen.getByText("11 / 2,000")).toBeTruthy()
    expect(send.disabled).toBe(false)

    fireEvent.click(send)
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/user-reports", {
      targetUserId: "u2",
      conversationId: "c1",
      reason: "abusive",
    }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("blocks through POST /api/users/[id]/block and reports back so the caller can leave the thread", async () => {
    const onBlocked = vi.fn()
    render(<UserSafetyMenu userId="u2" displayName="Dana" onBlocked={onBlocked} />)
    openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Block Dana" }))

    expect(screen.getByRole("alertdialog")).toBeTruthy()
    expect(screen.getByText("Block Dana?")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Block" }))
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/users/u2/block"))
    await waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1))
  })
})
