import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

type WithChildren = { readonly children?: ReactNode };

/**
 * Depth-first search of a rendered element tree (the output of a pure
 * render* function, not a mounted DOM) for the first element `matches`
 * accepts, so tests can reach its props and call its handlers directly.
 */
export const findElement = <P,>(
  node: ReactNode,
  matches: (element: ReactElement<P & WithChildren>) => boolean,
): ReactElement<P & WithChildren> | undefined => {
  if (!isValidElement<P & WithChildren>(node)) return undefined;
  if (matches(node)) return node;
  return Children.toArray(node.props.children)
    .map((child) => findElement<P>(child, matches))
    .find((element) => element !== undefined);
};
