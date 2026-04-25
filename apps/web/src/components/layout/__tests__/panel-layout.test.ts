import { describe, expect, it } from "vitest";

import {
  MAIN_MIN_SIZE,
  SIDEBAR_DEFAULT_SIZE,
  SIDEBAR_MIN_SIZE,
  buildResizablePanelLayout,
  getLeftSidebarSizeFromLayout,
  getRightSidebarSizeFromLayout,
} from "../panel-layout";

describe("buildResizablePanelLayout", () => {
  it("builds the default three-panel layout", () => {
    expect(
      buildResizablePanelLayout({
        leftPanelVisible: true,
        rightPanelVisible: true,
        leftSidebarSize: SIDEBAR_DEFAULT_SIZE,
        rightSidebarSize: SIDEBAR_DEFAULT_SIZE,
      })
    ).toEqual({
      "left-sidebar": SIDEBAR_DEFAULT_SIZE,
      "main-content": 64,
      "right-sidebar": SIDEBAR_DEFAULT_SIZE,
    });
  });

  it("omits hidden sidebars from the default layout", () => {
    expect(
      buildResizablePanelLayout({
        leftPanelVisible: true,
        rightPanelVisible: false,
        leftSidebarSize: SIDEBAR_DEFAULT_SIZE,
        rightSidebarSize: SIDEBAR_DEFAULT_SIZE,
      })
    ).toEqual({
      "left-sidebar": SIDEBAR_DEFAULT_SIZE,
      "main-content": 82,
    });
  });

  it("clamps invalid persisted sidebar sizes", () => {
    expect(
      buildResizablePanelLayout({
        leftPanelVisible: true,
        rightPanelVisible: true,
        leftSidebarSize: -10,
        rightSidebarSize: Number.NaN,
      })
    ).toEqual({
      "left-sidebar": SIDEBAR_MIN_SIZE,
      "main-content": 69,
      "right-sidebar": SIDEBAR_DEFAULT_SIZE,
    });
  });

  it("keeps the main panel at or above its minimum when both sidebars are open", () => {
    const layout = buildResizablePanelLayout({
      leftPanelVisible: true,
      rightPanelVisible: true,
      leftSidebarSize: 32,
      rightSidebarSize: 50,
    });

    expect(layout["main-content"]).toBeGreaterThanOrEqual(MAIN_MIN_SIZE);
    expect(
      layout["left-sidebar"] + layout["main-content"] + layout["right-sidebar"]
    ).toBeCloseTo(100);
  });
});

describe("getSidebarSizeFromLayout", () => {
  it("returns clamped sidebar sizes from a panel layout", () => {
    expect(getLeftSidebarSizeFromLayout({ "left-sidebar": 4 })).toBe(
      SIDEBAR_MIN_SIZE
    );
    expect(getRightSidebarSizeFromLayout({ "right-sidebar": 500 })).toBe(50);
  });

  it("returns undefined when the sidebar panel is absent", () => {
    expect(getLeftSidebarSizeFromLayout({ "main-content": 100 })).toBeUndefined();
    expect(getRightSidebarSizeFromLayout({ "main-content": 100 })).toBeUndefined();
  });
});
