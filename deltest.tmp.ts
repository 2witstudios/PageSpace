import { getUserPersonalization } from './apps/web/src/lib/ai/core/personalization-utils';

const r = await getUserPersonalization('du');
console.log('RESULT:', JSON.stringify(r));
console.log('injects legacy content?', JSON.stringify(r ?? {}).includes('SHOULD NOT COME BACK'));
