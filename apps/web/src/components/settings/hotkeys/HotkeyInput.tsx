"use client";

interface HotkeyInputProps {
  initialValue: string;
  onSave: (binding: string) => void;
  onCancel: () => void;
}

export function HotkeyInput({ initialValue, onSave, onCancel }: HotkeyInputProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Press keys... (stub)</span>
      <button onClick={() => onSave(initialValue)}>Save</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}
