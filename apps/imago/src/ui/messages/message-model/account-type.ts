// Agent Signup Phase 2c: `users.accountType` rides along with a name so the
// view can mark an agent account. It is copied only when the server sent one,
// so a row without it keeps exactly the shape it had.

/** `{ [key]: accountType }` when there is one, else nothing. */
export const withAccountType = <K extends string>(
  key: K,
  accountType: string | null | undefined,
): { readonly [P in K]?: string } => (accountType ? ({ [key]: accountType } as { readonly [P in K]: string }) : {});
