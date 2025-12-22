"use client";

import { useBreakpoint } from "./use-breakpoint";

const MOBILE_QUERY = "(max-width: 767px)";

export function useMobile() {
  return useBreakpoint(MOBILE_QUERY);
}
