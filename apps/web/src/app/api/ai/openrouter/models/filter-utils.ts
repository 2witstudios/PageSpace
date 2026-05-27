export type OpenRouterModel = {
  id: string;
  name: string;
  pricing?: { prompt: string };
  supported_parameters?: string[];
};

const hasToolSupport = (m: OpenRouterModel) =>
  m.supported_parameters?.includes('tools') === true &&
  m.supported_parameters?.includes('tool_choice') === true;

export const filterFreeModels = (models: OpenRouterModel[]): Record<string, string> =>
  Object.fromEntries(
    models
      .filter(m => m.id.endsWith(':free') && m.pricing?.prompt === '0' && hasToolSupport(m))
      .map(m => [m.id, m.name])
  );
