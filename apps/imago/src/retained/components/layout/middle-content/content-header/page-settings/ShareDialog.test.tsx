// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { ShareDialog } from "./ShareDialog"

vi.mock("@/retained/hooks/usePage", () => ({
  usePageStore: (selector: (state: { pageId: string }) => unknown) => selector({ pageId: "plan" }),
}))

vi.mock("@/retained/hooks/usePageTree", () => ({
  usePageTree: () => ({
    tree: [{ id: "plan", title: "Q4 Launch Plan", type: "DOCUMENT", isPrivate: false, children: [] }],
  }),
}))

vi.mock("@/retained-adapters/navigation", () => ({
  useParams: () => ({ driveId: "studio" }),
  imagoBrowserPath: (href: string) => href,
}))

vi.mock("@/retained/hooks/usePermissions", () => ({
  usePermissions: () => ({
    permissions: { canView: true, canEdit: true, canShare: true, canDelete: true },
    isLoading: false,
    error: null,
    isOwner: true,
  }),
  getPermissionErrorMessage: () => "You do not have permission",
}))

vi.mock("@/retained/hooks/useMobile", () => ({ useMobile: () => false }))

vi.mock("@/retained/hooks/usePageShareLink", () => ({
  usePageShareLink: () => ({
    links: [],
    isLoading: false,
    isGenerating: false,
    revokingId: null,
    handleGenerate: vi.fn(),
    handleCopy: vi.fn(),
    handleRevoke: vi.fn(),
  }),
}))

vi.mock("@/retained/lib/auth/auth-fetch", () => ({
  fetchWithAuth: vi.fn(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.includes("/permissions")) {
        return {
          owner: { id: "u1", name: "Jono", email: "jono@studio.example", image: null },
          permissions: [],
          roles: [],
        }
      }
      return { roles: [] }
    },
  })),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  patch: vi.fn(),
}))

describe("ShareDialog (re-skinned share dialog)", () => {
  afterEach(() => {
    cleanup()
  })

  it("opens from the Share button with the page title, Link and ID copy rows, and the privacy toggle", async () => {
    render(<ShareDialog pageId="plan" />)
    fireEvent.click(screen.getByRole("button", { name: /Share/ }))

    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(screen.getByText("Share “Q4 Launch Plan”")).toBeTruthy()
    expect(screen.getByLabelText("Page link")).toBeTruthy()
    expect(screen.getByLabelText("Page ID")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy page link" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy page id" })).toBeTruthy()
    expect(screen.getByText("Private page")).toBeTruthy()
    expect(screen.getByRole("switch", { name: "Toggle page privacy" })).toBeTruthy()
  })

  it("offers Share and Permissions tabs, and switches to the Permissions list", async () => {
    render(<ShareDialog pageId="plan" />)
    fireEvent.click(screen.getByRole("button", { name: /Share/ }))
    await screen.findByRole("dialog")

    expect(screen.getByRole("tab", { name: /Share/ })).toBeTruthy()
    const permissionsTab = screen.getByRole("tab", { name: /Permissions/ })
    fireEvent.mouseDown(permissionsTab, { button: 0, ctrlKey: false })

    await waitFor(() => expect(screen.getByText("Full access")).toBeTruthy())
    expect(screen.queryByText("Guest")).toBeNull()
  })
})
