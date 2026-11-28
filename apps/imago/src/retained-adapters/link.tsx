'use client';

import NextLink from 'next/link';
import type { ComponentProps } from 'react';
import { imagoHref } from './navigation';

export default function Link({ href, ...props }: ComponentProps<typeof NextLink>) {
  return <NextLink href={typeof href === 'string' ? imagoHref(href) : { ...href, pathname: imagoHref(href.pathname ?? '') }} {...props} />;
}
