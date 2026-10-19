// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { SWRConfig } from "swr"

const mocks = vi.hoisted(() => ({ billingProvider: null as string | null, appStoreRenews: false }))
vi.mock("@/retained/lib/auth/auth-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/retained/lib/auth/auth-fetch")>()),
  fetchWithAuth: vi.fn(async () => ({ ok: true, json: async () => ({ billingProvider: mocks.billingProvider, appStoreRenews: mocks.appStoreRenews }) })),
}))

import { ApiRequestError } from "@/retained/lib/auth/auth-fetch"
import { DeleteAccountDialog, ownedOrganizationsFrom } from "./DeleteAccountDialog"

afterEach(() => {
  cleanup()
  mocks.billingProvider = null
  mocks.appStoreRenews = false
})

const renderDialog = (overrides: Partial<React.ComponentProps<typeof DeleteAccountDialog>> = {}) => {
  const onConfirm = vi.fn()
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
    <DeleteAccountDialog
      isOpen
      onClose={vi.fn()}
      onConfirm={onConfirm}
      userEmail="jono@studio.example"
      isDeleting={false}
      soloDrivesCount={0}
      {...overrides}
    />
    </SWRConfig>
  )
  return { onConfirm }
}

const deleteButton = () => screen.getByRole("button", { name: "Delete Account Permanently" }) as HTMLButtonElement

describe("ownedOrganizationsFrom", () => {
  it("reads the organizations a refused deletion names", () => {
    const error = new ApiRequestError("refused", 400, { error: "refused", ownedOrganizations: ["Studio", "Ops"] })
    expect(ownedOrganizationsFrom(error)).toEqual(["Studio", "Ops"])
  })

  it("is undefined when the response carries no organization list, so the refusal stays hidden", () => {
    expect(ownedOrganizationsFrom(new ApiRequestError("failed", 500, { error: "failed" }))).toBeUndefined()
    expect(ownedOrganizationsFrom(new ApiRequestError("failed", 500))).toBeUndefined()
    expect(ownedOrganizationsFrom(new ApiRequestError("failed", 400, { ownedOrganizations: [] }))).toBeUndefined()
    expect(ownedOrganizationsFrom(new ApiRequestError("failed", 400, { ownedOrganizations: [7] }))).toBeUndefined()
    expect(ownedOrganizationsFrom(new ApiRequestError("failed", 400, null))).toBeUndefined()
    expect(ownedOrganizationsFrom(new Error("network down"))).toBeUndefined()
  })
})

describe("DeleteAccountDialog", () => {
  it("tells an App Store subscriber that deleting the account does not cancel the subscription, and where to cancel it", async () => {
    mocks.billingProvider = "apple"
    renderDialog()
    expect(await screen.findByTestId("app-store-deletion-notice")).toBeTruthy()
    expect(screen.getByText(/Settings › Apple ID › Subscriptions/)).toBeTruthy()
  })

  it("warns when Apple will charge again even though Stripe sells the current plan", async () => {
    mocks.billingProvider = "stripe"
    mocks.appStoreRenews = true
    renderDialog()
    expect(await screen.findByTestId("app-store-deletion-notice")).toBeTruthy()
  })

  it("shows no App Store notice to anyone else", async () => {
    mocks.billingProvider = "stripe"
    renderDialog()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("app-store-deletion-notice")).toBeNull()
  })

  it("keeps Delete Account Permanently disabled until the email is typed", () => {
    const { onConfirm } = renderDialog()
    expect(deleteButton().disabled).toBe(true)
    fireEvent.click(deleteButton())
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Type your email address/), { target: { value: "jono@studio.example" } })
    expect(deleteButton().disabled).toBe(false)
    fireEvent.click(deleteButton())
    expect(onConfirm).toHaveBeenCalledWith("jono@studio.example")
  })

  it("shows no refusal when the server named no owned organizations", () => {
    renderDialog()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("shows the refusal with each organization and blocks confirming", () => {
    const { onConfirm } = renderDialog({ ownedOrganizations: ["Studio", "Ops"] })
    const refusal = screen.getByRole("status")
    expect(refusal.textContent).toContain(
      "Transfer ownership of your organizations or delete them before deleting your account"
    )
    expect([...refusal.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Studio", "Ops"])
    // The per-organization Transfer link is not built: no API names an organization id yet.
    expect(screen.queryByRole("link")).toBeNull()

    fireEvent.change(screen.getByLabelText(/Type your email address/), { target: { value: "jono@studio.example" } })
    expect(deleteButton().disabled).toBe(true)
    fireEvent.click(deleteButton())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
