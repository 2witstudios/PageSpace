// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"
import type { SelectedPageInfo } from "@/retained/stores/useMultiSelectStore"

const h = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(() => "toast-id") },
}))

vi.mock("sonner", () => ({ toast: h.toast }))
vi.mock("@/retained/lib/auth/auth-fetch", () => ({ fetchWithAuth: h.fetchWithAuth }))
vi.mock("@/retained/hooks/useDrive", () => {
  const state = {
    drives: [{ id: "d1", name: "Studio", isOwned: true, role: "OWNER" }],
    fetchDrives: () => undefined,
    isLoading: false,
  }
  return { useDriveStore: (selector: (s: typeof state) => unknown) => selector(state) }
})

import { MovePageDialog } from "./MovePageDialog"
import { CopyPageDialog } from "./CopyPageDialog"

const tree = [
  { id: "launch", title: "Launch", type: "FOLDER", children: [] },
  { id: "research", title: "Research", type: "FOLDER", children: [] },
]

const docInLaunch: SelectedPageInfo[] = [
  { id: "p1", title: "Q4 Launch Plan", type: "DOCUMENT", driveId: "d1", parentId: "launch" },
]
const folderAtTop: SelectedPageInfo[] = [
  { id: "f1", title: "Launch", type: "FOLDER", driveId: "d1", parentId: null },
]

const okResponse = (body: unknown) => ({ ok: true, json: async () => body })

beforeEach(() => {
  h.fetchWithAuth.mockReset()
  h.fetchWithAuth.mockImplementation(async (url: string) =>
    url === "/api/pages/tree" ? okResponse({ tree }) : okResponse({})
  )
})

afterEach(cleanup)

describe("MovePageDialog", () => {
  it("shows the destination drive, the folder tree and marks the current folder", async () => {
    render(<MovePageDialog isOpen onClose={vi.fn()} pages={docInLaunch} />)
    expect(screen.getByRole("dialog", { name: "Move Page" })).toBeTruthy()
    expect(screen.getByText("Destination Drive")).toBeTruthy()
    expect(screen.getByText("Destination Folder (optional)")).toBeTruthy()
    await screen.findByText("Launch")
    expect(screen.getByText("Root (Top Level)")).toBeTruthy()
    const launchRow = screen.getByText("Launch").closest("div") as HTMLElement
    expect(launchRow.textContent).toContain("current")
    expect(screen.getByText("Root (Top Level)").parentElement?.textContent).not.toContain("current")
  })

  it("never offers Include child pages", async () => {
    render(<MovePageDialog isOpen onClose={vi.fn()} pages={folderAtTop} />)
    await screen.findByText("Launch")
    expect(screen.queryByText("Include child pages")).toBeNull()
  })

  it("posts the selection to bulk-move on confirm", async () => {
    const onSuccess = vi.fn()
    render(<MovePageDialog isOpen onClose={vi.fn()} pages={docInLaunch} onSuccess={onSuccess} />)
    await screen.findByText("Launch")
    fireEvent.click(screen.getByRole("button", { name: "Move Page" }))
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    const [url, init] = h.fetchWithAuth.mock.calls.find((c) => c[0] === "/api/pages/bulk-move") ?? []
    expect(url).toBe("/api/pages/bulk-move")
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      pageIds: ["p1"],
      targetDriveId: "d1",
      targetParentId: null,
    })
  })
})

describe("CopyPageDialog", () => {
  it("shows Include child pages only when the selection has children", async () => {
    const { unmount } = render(<CopyPageDialog isOpen onClose={vi.fn()} pages={docInLaunch} />)
    await screen.findByText("Launch")
    expect(screen.queryByText("Include child pages")).toBeNull()
    unmount()

    render(<CopyPageDialog isOpen onClose={vi.fn()} pages={folderAtTop} />)
    await screen.findByText("Launch")
    expect(screen.getByText("Include child pages")).toBeTruthy()
  })

  it("posts bulk-copy with includeChildren on confirm", async () => {
    const onSuccess = vi.fn()
    render(<CopyPageDialog isOpen onClose={vi.fn()} pages={folderAtTop} onSuccess={onSuccess} />)
    await screen.findByText("Launch")
    fireEvent.click(screen.getByRole("button", { name: "Copy Page" }))
    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    const call = h.fetchWithAuth.mock.calls.find((c) => c[0] === "/api/pages/bulk-copy")
    expect(JSON.parse((call?.[1] as { body: string }).body)).toMatchObject({
      pageIds: ["f1"],
      targetDriveId: "d1",
      includeChildren: true,
    })
  })
})
