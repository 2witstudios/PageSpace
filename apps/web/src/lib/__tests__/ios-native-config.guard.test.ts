/**
 * App Review requirements that live in the iOS shell's native config. Read as
 * text for the same reason as `capacitor-allow-navigation.guard.test.ts`: the
 * iOS app is not in the turbo test graph.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IOS = resolve(HERE, '../../../../ios/ios/App');

const infoPlist = readFileSync(resolve(IOS, 'App/Info.plist'), 'utf-8');
const pbxproj = readFileSync(resolve(IOS, 'App.xcodeproj/project.pbxproj'), 'utf-8');
const privacyManifest = readFileSync(resolve(IOS, 'PrivacyInfo.xcprivacy'), 'utf-8');

const plistString = (key: string): string | null => {
  const match = infoPlist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return match ? match[1] : null;
};

describe('iOS native config for App Review', () => {
  // Dictation uses the Web Speech API, which WebKit backs with on-device speech
  // recognition — a protected resource of its own, separate from the microphone.
  it('given dictation in AI chat, should declare a specific speech recognition purpose string with an example (5.1.1(ii))', () => {
    const purpose = plistString('NSSpeechRecognitionUsageDescription');
    expect(purpose).not.toBeNull();
    expect(purpose).toMatch(/for example/i);
  });

  it('given build 8 was rejected, should build the resubmission as build 9 or later', () => {
    const builds = [...pbxproj.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]));
    expect(builds.length).toBeGreaterThan(0);
    for (const build of builds) expect(build).toBeGreaterThanOrEqual(9);
  });

  it('given voice calls send microphone audio to the server, should declare audio data in the privacy manifest', () => {
    expect(privacyManifest).toMatch(/NSPrivacyCollectedDataTypeAudioData/);
  });
});
