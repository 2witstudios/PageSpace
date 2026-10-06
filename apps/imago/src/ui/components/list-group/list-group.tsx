import { renderListGroup, type ListGroupRenderProps } from './list-group.render';

export type ListGroupProps = ListGroupRenderProps;

/** A labelled run of sidebar rows. */
export function ListGroup(props: ListGroupProps) {
  return renderListGroup(props);
}
