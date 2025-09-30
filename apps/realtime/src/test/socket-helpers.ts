import { io, Socket } from 'socket.io-client'

export class SocketTestClient {
  private socket: Socket | null = null

  async connect(token: string, port: number = 3001): Promise<Socket> {
    return new Promise((resolve, reject) => {
      this.socket = io(`http://localhost:${port}`, {
        auth: { token },
        transports: ['websocket'],
      })

      this.socket.on('connect', () => {
        resolve(this.socket!)
      })

      this.socket.on('connect_error', (error) => {
        reject(error)
      })

      setTimeout(() => reject(new Error('Connection timeout')), 5000)
    })
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }

  async waitForEvent(eventName: string, timeout: number = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Event ${eventName} not received within ${timeout}ms`))
      }, timeout)

      this.socket!.once(eventName, (data) => {
        clearTimeout(timer)
        resolve(data)
      })
    })
  }

  emit(eventName: string, data: any) {
    this.socket!.emit(eventName, data)
  }
}