import type { ReactNode } from 'react';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
export default function Layout({ children }: { children: ReactNode }) { return <RetainedSurface>{children}</RetainedSurface>; }
