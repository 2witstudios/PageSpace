// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"
import { fetchWithAuth } from "@/retained/lib/auth/auth-fetch"
import { PermissionsList } from "./PermissionsList"

vi.mock("@/retained/hooks/usePage", () => ({
  usePageStore: (selector: (state: { pageId: string }) => unknown) => selector({ pageId: "plan" }),
}))

vi.mock("@/retained/lib/auth/auth-fetch", () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  patch: vi.fn(),
}))

const permissionsPayload = {
  owner: { id: "u1", name: "Jono", email: "jono@studio.example", image: null },
  permissions: [
    {
      id: "p1",
      userId: "u2",
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
      grantedBy: "u1",
      grantedAt: new Date("2026-01-01T00:00:00Z"),
      user: { id: "u2", name: "Dana Whitfield", email: "dana@studio.example", image: null },
    },
  ],
  roles: [{ roleId: "r1", name: "Reviewer", color: null, canView: true, canEdit: false, canShare: false }],
}

describe("PermissionsList (share dialog, Permissions tab)", () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => permissionsPayload,
    } as unknown as Response)
  })

  afterEach(() => {
    cleanup()
  })

  it("lists the owner, roles and people with Full access and a Remove access control", async () => {
    render(<PermissionsList pageId="plan" />)

    await waitFor(() => expect(screen.getByText("Full access")).toBeTruthy())
    expect(screen.getByText("Jono")).toBeTruthy()
    expect(screen.getByText("Owner")).toBeTruthy()
    expect(screen.getByText("Roles")).toBeTruthy()
    expect(screen.getByText("Reviewer")).toBeTruthy()
    expect(screen.getByText("People")).toBeTruthy()
    expect(screen.getByText("Dana Whitfield")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Remove access" })).toHaveLength(2)
  })

  it("gives each person View, Edit, Share and Delete checkboxes, and roles without Delete", async () => {
    render(<PermissionsList pageId="plan" />)
    await waitFor(() => expect(screen.getByText("Dana Whitfield")).toBeTruthy())

    expect(screen.getAllByRole("checkbox", { name: "View" })).toHaveLength(2)
    expect(screen.getAllByRole("checkbox", { name: "Edit" })).toHaveLength(2)
    expect(screen.getAllByRole("checkbox", { name: "Share" })).toHaveLength(2)
    expect(screen.getAllByRole("checkbox", { name: "Delete" })).toHaveLength(1)
  })

  it("does not show a Guest badge or an outside-Studio line before the drive-membership API exists", async () => {
    render(<PermissionsList pageId="plan" />)
    await waitFor(() => expect(screen.getByText("Dana Whitfield")).toBeTruthy())

    expect(screen.queryByText("Guest")).toBeNull()
    expect(screen.queryByText(/outside Studio/)).toBeNull()
  })

  it("SEAT-9 (partial) a lapsed org disables wider grants but keeps narrowing and revocation available", async () => {
    render(<PermissionsList {...{ pageId: "plan", lapsed: true }} />)
    await waitFor(() => expect(screen.getByText("Dana Whitfield")).toBeTruthy())
    for (const permission of ["Edit", "Share", "Delete"]) {
      for (const checkbox of screen.getAllByRole("checkbox", { name: permission })) {
        expect(checkbox.hasAttribute("disabled")).toBe(true)
      }
    }
    for (const checkbox of screen.getAllByRole("checkbox", { name: "View" })) {
      expect(checkbox.hasAttribute("disabled")).toBe(false)
    }
    for (const revoke of screen.getAllByRole("button", { name: "Remove access" })) {
      expect(revoke.hasAttribute("disabled")).toBe(false)
    }
  })

})
