export const computeHasContent = (content: string | null | undefined): boolean => {
  if (!content) return false;
  return content.replace(/<[^>]*>/g, '').trim().length > 0;
};
