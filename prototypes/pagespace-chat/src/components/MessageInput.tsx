'use client';

import { useRef, useState, useEffect } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  agentTitle?: string;
}

export default function MessageInput({ onSend, disabled, agentTitle }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="px-4 pb-4 pt-2">
      <div className={`flex items-end gap-2 bg-[#1a1a22] rounded-2xl border transition-colors px-4 py-3 ${
        disabled ? 'border-white/5 opacity-60' : 'border-white/10 focus-within:border-indigo-500/50'
      }`}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={agentTitle ? `Message ${agentTitle}…` : 'Select an agent to start chatting…'}
          rows={1}
          className="flex-1 bg-transparent text-sm text-gray-100 placeholder-gray-500 resize-none outline-none leading-relaxed min-h-[24px]"
          style={{ maxHeight: '200px' }}
        />
        <button
          onClick={submit}
          disabled={disabled || !value.trim()}
          className={`flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
            value.trim() && !disabled
              ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-500/20'
              : 'bg-white/5 text-gray-600 cursor-not-allowed'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
      <p className="text-center text-xs text-gray-700 mt-2">
        {disabled ? 'Generating response…' : 'Enter to send · Shift+Enter for newline'}
      </p>
    </div>
  );
}
