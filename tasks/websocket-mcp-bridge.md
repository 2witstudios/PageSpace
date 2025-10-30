# WebSocket MCP Bridge Epic

**Status**: 📋 PLANNED
**Goal**: Enable local MCP tool execution while maintaining server-side AI streaming

## Overview

Users need MCP tools to execute on their local machine (filesystem access, local databases, etc.) but PageSpace's AI runs on the VPS server. Without bidirectional communication, the server cannot trigger local tool execution, forcing us to return placeholder results. This epic implements a WebSocket bridge using the next-ws package, allowing the desktop app to maintain a persistent authenticated connection to the server, receive tool execution requests, execute them locally via Electron IPC, and return results in real-time—all while preserving server-side AI streaming, cross-device sync, monitoring, and rate limiting.

---

## Investigate Next.js WebSocket Implementation

Research and validate the next-ws package for WebSocket support in Next.js 15 App Router.

**Requirements**:
- Given next-ws package, should verify compatibility with Next.js 15 App Router
- Given PageSpace runs on VPS, should confirm next-ws supports non-serverless deployment
- Given patching requirement, should document patch process and implications for CI/CD
- Given alternative approaches exist, should evaluate SSE or Socket.IO as fallbacks
- Given deployment constraints, should identify any blockers for production use

---

## Install and Configure next-ws

Add next-ws package and configure Next.js to support WebSocket connections.

**Requirements**:
- Given package.json, should add next-ws and ws dependencies
- Given Next.js installation, should add prepare script to patch Next.js on install
- Given workspace setup, should verify patch works across all monorepo packages
- Given build process, should ensure WebSocket routes compile correctly
- Given TypeScript, should add proper type definitions for UPGRADE function

---

## Create WebSocket Route Handler

Implement WebSocket endpoint that accepts authenticated connections from desktop app.

**Requirements**:
- Given desktop connects to /api/mcp-ws, should validate JWT from connection headers
- Given valid JWT, should extract userId and register connection in memory Map
- Given connection registered, should respond to ping messages with pong for health checks
- Given client disconnects, should remove connection from Map and log disconnect reason
- Given malformed JWT, should reject connection with 401 Unauthorized
- Given duplicate connection for same userId, should close old connection and accept new one

---

## Implement Desktop WebSocket Client

Create WebSocket client in Electron main process that connects on app startup.

**Requirements**:
- Given app ready event fires, should extract JWT from web view localStorage or cookies
- Given JWT extracted, should connect to wss://pagespace.ai/mcp-ws with auth header
- Given connection succeeds, should send heartbeat ping every 30 seconds
- Given connection drops, should retry with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- Given tool execution request received, should validate message format before processing
- Given invalid message received, should log error and send error response to server
- Given app quit event, should close WebSocket gracefully with disconnect message

---

## Implement Tool Execution Message Protocol

Define bidirectional message protocol for tool execution requests and responses.

**Requirements**:
- Given server needs tool executed, should send message with type, unique id, serverName, toolName, and args
- Given desktop receives execute message, should call MCPManager.executeTool with parsed parameters
- Given tool succeeds, should send result message with matching id and success: true
- Given tool fails, should send error message with matching id, success: false, and error details
- Given message id doesn't match pending request, should log warning and ignore result
- Given result not received within 30 seconds, should timeout and reject promise

---

## Create Server-Side MCP Bridge

Implement bridge class that manages WebSocket connections and tool execution flow.

**Requirements**:
- Given MCPBridge initialized, should maintain Map of userId to WebSocket connections
- Given executeToolViaWebSocket called, should check if user has active connection
- Given user connected, should generate unique request id and send execute message
- Given result received, should resolve promise with tool result data
- Given timeout (30s), should reject promise and log timeout event
- Given user disconnected during execution, should reject promise with connection error
- Given multiple requests for same user, should queue them and execute sequentially

---

## Integrate Bridge into AI Chat Route

Replace placeholder MCP tool execute functions with real WebSocket execution.

**Requirements**:
- Given MCP tool in tools object, should create execute function that calls MCPBridge
- Given user has no active connection, should return error result instead of throwing
- Given tool execution succeeds, should return result exactly as received from desktop
- Given tool execution times out, should return timeout error and continue AI streaming
- Given tool execution fails, should include error message in tool result for AI context
- Given server-side tool and MCP tool coexist, should execute each via correct mechanism

---

## Add Connection Status to Preload and IPC

Expose WebSocket connection status to renderer process via IPC bridge.

**Requirements**:
- Given main process WebSocket state changes, should emit event to all renderer windows
- Given renderer requests status, should return connected boolean and last connected timestamp
- Given preload script, should expose getWebSocketStatus method on window.electron.mcp
- Given TypeScript definitions, should add WebSocketStatus interface with proper types

---

## Add Connection Status UI Indicator

Display real-time MCP connection status in AI chat header.

**Requirements**:
- Given chat page loads, should poll WebSocket status every 5 seconds via IPC
- Given status is connected, should show green dot with tooltip "MCP Ready (3 servers)"
- Given status is connecting, should show yellow dot with tooltip "Connecting to MCP..."
- Given status is disconnected, should show red dot with tooltip "MCP Unavailable"
- Given status changes, should update indicator without full page refresh
- Given user hovers indicator, should show last connected time and server count

---

## Add Structured Logging for WebSocket Events

Implement comprehensive logging for debugging and monitoring.

**Requirements**:
- Given WebSocket connects, should log userId, connection time, and client info
- Given tool execution starts, should log toolName, serverName, and request id with timing
- Given tool execution completes, should log duration, success, and result size
- Given connection drops, should log disconnect reason, duration connected, and auto-reconnect status
- Given message received, should log message type and validate schema before processing
- Given error occurs, should log full error stack with context for debugging

---

## Test Connection Lifecycle

Validate WebSocket connection, reconnection, and cleanup behavior.

**Requirements**:
- Given desktop app starts, should establish connection within 5 seconds
- Given network disconnects, should detect disconnect within 60 seconds via heartbeat
- Given network reconnects, should reestablish connection within 10 seconds
- Given app quits, should close WebSocket gracefully without hanging
- Given server restarts, should reconnect automatically when server available
- Given multiple tabs open, should maintain single connection per userId

---

## Test End-to-End Tool Execution

Validate complete flow from AI decision through tool execution to result.

**Requirements**:
- Given filesystem MCP server running, should execute file read and return contents
- Given AI requests tool execution, should complete within 2 seconds for simple tools
- Given tool execution succeeds, should see result integrated into AI response
- Given desktop disconnected, should show clear error message in chat response
- Given tool times out, should continue AI response with timeout error after 30s
- Given multiple sequential tool calls, should execute in order with correct context
