'use client';

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { useVoiceModeStore, type TTSVoice, type VoiceInteractionMode } from '@/stores/useVoiceModeStore';

const VOICE_OPTIONS: { value: TTSVoice; label: string; description: string }[] = [
  { value: 'alloy', label: 'Alloy', description: 'Neutral and balanced' },
  { value: 'echo', label: 'Echo', description: 'Warm and conversational' },
  { value: 'fable', label: 'Fable', description: 'Expressive and dynamic' },
  { value: 'onyx', label: 'Onyx', description: 'Deep and authoritative' },
  { value: 'nova', label: 'Nova', description: 'Friendly and upbeat' },
  { value: 'shimmer', label: 'Shimmer', description: 'Clear and pleasant' },
];

const INTERACTION_MODE_OPTIONS: { value: VoiceInteractionMode; label: string; description: string }[] = [
  {
    value: 'tap-to-speak',
    label: 'Tap to Speak',
    description: 'Tap the mic to start/stop recording',
  },
  {
    value: 'barge-in',
    label: 'Barge-in',
    description: 'Automatically listens - speak to interrupt AI',
  },
];

/**
 * VoiceModeSettings - Settings panel for voice mode configuration.
 *
 * Allows users to configure:
 * - Interaction mode (tap-to-speak vs barge-in)
 * - TTS voice selection
 * - TTS speed
 * - Auto-send transcriptions
 */
export function VoiceModeSettings() {
  const interactionMode = useVoiceModeStore((s) => s.interactionMode);
  const ttsVoice = useVoiceModeStore((s) => s.ttsVoice);
  const ttsSpeed = useVoiceModeStore((s) => s.ttsSpeed);
  const autoSend = useVoiceModeStore((s) => s.autoSend);

  const setInteractionMode = useVoiceModeStore((s) => s.setInteractionMode);
  const setTTSVoice = useVoiceModeStore((s) => s.setTTSVoice);
  const setTTSSpeed = useVoiceModeStore((s) => s.setTTSSpeed);
  const setAutoSend = useVoiceModeStore((s) => s.setAutoSend);

  return (
    <Card className="border shadow-lg">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Voice Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Interaction Mode */}
        <div className="space-y-2">
          <Label htmlFor="interaction-mode">Interaction Mode</Label>
          <Select
            value={interactionMode}
            onValueChange={(value) => setInteractionMode(value as VoiceInteractionMode)}
          >
            <SelectTrigger id="interaction-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERACTION_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Voice Selection */}
        <div className="space-y-2">
          <Label htmlFor="tts-voice">Voice</Label>
          <Select
            value={ttsVoice}
            onValueChange={(value) => setTTSVoice(value as TTSVoice)}
          >
            <SelectTrigger id="tts-voice">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VOICE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Speech Speed */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="tts-speed">Speech Speed</Label>
            <span className="text-sm text-muted-foreground">{ttsSpeed.toFixed(1)}x</span>
          </div>
          <Slider
            id="tts-speed"
            min={0.5}
            max={2.0}
            step={0.1}
            value={[ttsSpeed]}
            onValueChange={([value]) => setTTSSpeed(value)}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Slower</span>
            <span>Faster</span>
          </div>
        </div>

        {/* Auto-send */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="auto-send">Auto-send</Label>
            <p className="text-xs text-muted-foreground">
              Automatically send message after transcription
            </p>
          </div>
          <Switch
            id="auto-send"
            checked={autoSend}
            onCheckedChange={setAutoSend}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default VoiceModeSettings;
