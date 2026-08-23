// The renderer talks to the core backend over HTTP and WebSocket, so it needs
// nothing from Node. This file exists to keep contextIsolation on with an empty,
// explicit bridge rather than exposing the main process by accident.
