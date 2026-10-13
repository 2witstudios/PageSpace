// @vitest-environment jsdom
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./sheet"
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger,
} from "./dropdown-menu"

describe("v3 overlay primitives", () => {
  it("renders a dialog with radius, scrim and a Close button", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>T</DialogTitle>
          <DialogDescription>D</DialogDescription>
        </DialogContent>
      </Dialog>
    )
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("rounded-xl")
    expect(dialog.className).toContain("shadow-xl")
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
    expect(document.querySelector("[data-slot=dialog-overlay]")).not.toBeNull()
  })

  it("renders menu rows at 32px with a submenu trigger flagged as popup", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    expect(screen.getByRole("menu")).toBeTruthy()
    const item = screen.getByRole("menuitem", { name: "One" })
    expect(item.className).toContain("h-8")
    expect(screen.getByRole("menuitem", { name: "More" }).getAttribute("aria-haspopup")).toBe("menu")
    expect(document.querySelector("[data-slot=dropdown-menu-separator]")).not.toBeNull()
  })

  it("renders a right sheet with a 48px header and Close", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>S</SheetTitle>
            <SheetDescription>d</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    )
    expect(document.querySelector("[data-slot=sheet-header]")?.className).toContain("min-h-12")
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
  })
})
