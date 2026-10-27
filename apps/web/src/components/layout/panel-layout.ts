export const SIDEBAR_DEFAULT_SIZE = 18;
export const SIDEBAR_MIN_SIZE = 13;
export const LEFT_SIDEBAR_MAX_SIZE = 32;
export const RIGHT_SIDEBAR_MAX_SIZE = 50;
export const MAIN_MIN_SIZE = 30;

const MAIN_PANEL_ID = "main-content";
const LEFT_PANEL_ID = "left-sidebar";
const RIGHT_PANEL_ID = "right-sidebar";

export type ResizablePanelLayout = Record<string, number>;

interface BuildPanelLayoutOptions {
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  leftSidebarSize: number;
  rightSidebarSize: number;
}

function isFiniteNumber(value: number) {
  return Number.isFinite(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function clampLeftSidebarSize(size: number) {
  return clamp(
    isFiniteNumber(size) ? size : SIDEBAR_DEFAULT_SIZE,
    SIDEBAR_MIN_SIZE,
    LEFT_SIDEBAR_MAX_SIZE
  );
}

export function clampRightSidebarSize(size: number) {
  return clamp(
    isFiniteNumber(size) ? size : SIDEBAR_DEFAULT_SIZE,
    SIDEBAR_MIN_SIZE,
    RIGHT_SIDEBAR_MAX_SIZE
  );
}

function fitSidebarsToMainMin(leftSize: number, rightSize: number) {
  let nextLeftSize = leftSize;
  let nextRightSize = rightSize;
  const maxSidebarTotal = 100 - MAIN_MIN_SIZE;
  const sidebarTotal = nextLeftSize + nextRightSize;

  if (sidebarTotal <= maxSidebarTotal) {
    return { leftSize: nextLeftSize, rightSize: nextRightSize };
  }

  let excess = sidebarTotal - maxSidebarTotal;
  const leftShrinkCapacity = nextLeftSize - SIDEBAR_MIN_SIZE;
  const rightShrinkCapacity = nextRightSize - SIDEBAR_MIN_SIZE;
  const totalShrinkCapacity = leftShrinkCapacity + rightShrinkCapacity;

  if (totalShrinkCapacity > 0) {
    const leftShrink = Math.min(
      leftShrinkCapacity,
      excess * (leftShrinkCapacity / totalShrinkCapacity)
    );
    nextLeftSize -= leftShrink;
    excess -= leftShrink;
  }

  if (excess > 0) {
    const rightShrink = Math.min(rightShrinkCapacity, excess);
    nextRightSize -= rightShrink;
  }

  return {
    leftSize: nextLeftSize,
    rightSize: nextRightSize,
  };
}

export function buildResizablePanelLayout({
  leftPanelVisible,
  rightPanelVisible,
  leftSidebarSize,
  rightSidebarSize,
}: BuildPanelLayoutOptions): ResizablePanelLayout {
  let leftSize = leftPanelVisible ? clampLeftSidebarSize(leftSidebarSize) : 0;
  let rightSize = rightPanelVisible ? clampRightSidebarSize(rightSidebarSize) : 0;

  if (leftPanelVisible && rightPanelVisible) {
    const fitted = fitSidebarsToMainMin(leftSize, rightSize);
    leftSize = fitted.leftSize;
    rightSize = fitted.rightSize;
  }

  const layout: ResizablePanelLayout = {
    [MAIN_PANEL_ID]: 100 - leftSize - rightSize,
  };

  if (leftPanelVisible) {
    layout[LEFT_PANEL_ID] = leftSize;
  }

  if (rightPanelVisible) {
    layout[RIGHT_PANEL_ID] = rightSize;
  }

  return layout;
}

export function getLeftSidebarSizeFromLayout(layout: ResizablePanelLayout) {
  const size = layout[LEFT_PANEL_ID];
  return typeof size === "number" ? clampLeftSidebarSize(size) : undefined;
}

export function getRightSidebarSizeFromLayout(layout: ResizablePanelLayout) {
  const size = layout[RIGHT_PANEL_ID];
  return typeof size === "number" ? clampRightSidebarSize(size) : undefined;
}
