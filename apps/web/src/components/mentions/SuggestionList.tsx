import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import { MentionSuggestion } from '@/types/mentions';
import { Users, FileText } from 'lucide-react';

interface SuggestionListProps {
  items: MentionSuggestion[];
  command: (item: MentionSuggestion) => void;
}

const SuggestionList = forwardRef((props: SuggestionListProps, ref: React.Ref<{ onKeyDown: (props: { event: KeyboardEvent; }) => boolean; }>) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (item) {
      props.command(item);
    }
  };

  const upHandler = () => {
    setSelectedIndex(
      (selectedIndex + props.items.length - 1) % props.items.length
    );
  };

  const downHandler = () => {
    setSelectedIndex((selectedIndex + 1) % props.items.length);
  };

  const enterHandler = () => {
    selectItem(selectedIndex);
  };

  useEffect(() => setSelectedIndex(0), [props.items]);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'page':
        return <FileText className="w-4 h-4" />;
      case 'user':
        return <Users className="w-4 h-4" />;
      default:
        return <FileText className="w-4 h-4" />;
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'page':
        return 'text-blue-600';
      case 'user':
        return 'text-green-600';
      default:
        return 'text-gray-600';
    }
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === 'ArrowUp') {
        upHandler();
        return true;
      }
      if (event.key === 'ArrowDown') {
        downHandler();
        return true;
      }
      if (event.key === 'Enter') {
        enterHandler();
        return true;
      }
      return false;
    },
  }));

  return (
    <div className="mention-suggestions bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
      {props.items.length ? (
        props.items.map((item, index) => (
          <button
            className={`w-full p-3 text-left hover:bg-gray-50 flex items-center gap-3 transition-colors ${
              index === selectedIndex ? 'bg-blue-50 border-l-2 border-blue-500' : ''
            }`}
            key={index}
            onClick={() => selectItem(index)}
          >
            <div className={`flex-shrink-0 ${getTypeColor(item.type)}`}>
              {getTypeIcon(item.type)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900 truncate">{item.label}</div>
              <div className="text-sm text-gray-500 truncate">
                {item.description || item.type.charAt(0).toUpperCase() + item.type.slice(1).toLowerCase()}
              </div>
            </div>
          </button>
        ))
      ) : (
        <div className="p-3 text-gray-500 text-center">No results found</div>
      )}
    </div>
  );
});

SuggestionList.displayName = 'SuggestionList';

export default SuggestionList;