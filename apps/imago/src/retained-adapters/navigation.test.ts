import { describe, expect, it } from 'vitest';
import { imagoHref, imagoBrowserPath, classicPathname } from './navigation';
import { stageFor } from '@/ui/frame/stage/stage';

describe('retained destinations stay inside the persistent shell', () => {
  it.each([
    ['/dashboard', '/'],
    ['/settings?tab=profile#name', '/account?tab=profile#name'],
    ['/settings/ai?model=a#config', '/account/ai?model=a#config'],
    ['/dashboard/drive123/page456?tab=code#selection', '/drive123/files/page456?tab=code#selection'],
    ['/dashboard/drive123/channels/page456', '/drive123/messages/page456'],
    ['/dashboard/channels/page456', '/p/page456'],
    ['/dashboard/dms/new', '/dm/new'],
    ['/dashboard/drive123/agents?workspace=w&c=c', '/drive123/agents?workspace=w&c=c'],
    ['/api/pages/page456', '/api/pages/page456'],
    ['https://other.example/dashboard', 'https://other.example/dashboard'],
  ])('maps %s to %s', (source, destination) => expect(imagoHref(source)).toBe(destination));
  it.each([
    ['/dashboard', '/imago'],
    ['/settings/integrations?connected=true#provider', '/imago/account/integrations?connected=true#provider'],
    ['/dashboard/drive123/settings/integrations', '/imago/drive123/settings/integrations'],
    ['/imago/drive123/agents?c=c', '/imago/drive123/agents?c=c'],
    ['/imago?c=c#chat', '/imago?c=c#chat'],
  ])('returns the native callback path for %s', (source, destination) => expect(imagoBrowserPath(source)).toBe(destination));
  it('gives retained path readers their established drive/section shape', () => {
    expect(classicPathname('/drive123/files/page456')).toBe('/dashboard/drive123/page456');
    expect(classicPathname('/drive123/messages/page456')).toBe('/dashboard/drive123/channels/page456');
    expect(classicPathname('/account/ai')).toBe('/settings/ai');
  });
  it('renders cross-drive resolution before a drive has been resolved', () => {
    const stage = stageFor('/p/page456');
    expect(stage.driveId).toBeNull();
    expect(stage.object).not.toBeNull();
  });
});
