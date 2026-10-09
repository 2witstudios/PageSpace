import { create } from 'zustand';
import type { Socket } from 'socket.io-client';
import { getBrowserRealtimeClient } from '@/realtime/realtime-client';

interface SocketStore {
  socket: Socket | null;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  isInitialized: boolean;
  connect: (forceReconnect?: boolean) => Promise<void>;
  disconnect: () => void;
  getSocket: () => Socket | null;
}

let clearStatusListeners = () => {};

// Imago owns the connection's lifetime. Retained hooks subscribe to that same
// Socket; they may not mint a second connection or disconnect other consumers.
export const useSocketStore = create<SocketStore>((set, get) => ({
  socket: null,
  connectionStatus: 'disconnected',
  isInitialized: false,
  connect: async () => {
    const socket = getBrowserRealtimeClient().socket() as Socket;
    if (get().socket === socket) return;
    clearStatusListeners();
    const sync = () => set({ connectionStatus: socket.connected ? 'connected' : 'disconnected' });
    socket.on('connect', sync);
    socket.on('disconnect', sync);
    clearStatusListeners = () => { socket.off('connect', sync); socket.off('disconnect', sync); };
    set({ socket, isInitialized: true, connectionStatus: socket.connected ? 'connected' : 'connecting' });
  },
  disconnect: () => {},
  getSocket: () => get().socket,
}));
