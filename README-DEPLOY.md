# Chess Party — Render deployment bundle

This bundle contains the Node.js game server and the current browser client. Deploying both together keeps the browser client and WebSocket server on the same origin, so the current client can connect without a separate WebSocket URL setting.

## Deploy to Render

1. Extract this ZIP.
2. Put the extracted files in a GitHub repository (the `server.js`, `package.json`, `render.yaml`, and `public/` folder must be at the repository root).
3. In Render, choose **New + → Blueprint** and connect that repository. Render reads `render.yaml` and creates the web service.
   - Alternatively, create a **Web Service** manually with:
     - Runtime: Node
     - Build command: `npm install`
     - Start command: `npm start`
4. Wait for deployment to finish. Open the service's `onrender.com` URL.
5. Check `https://YOUR-SERVICE.onrender.com/health`. It should return `{"ok":true,"service":"chess-party"}`.
6. Share the service URL with testers. Open it on multiple devices and create/join a room.

## Notes

- Render provides `PORT`; the server listens on it automatically.
- WebSocket connections use the same host as the page and support secure `wss://` automatically when served over HTTPS.
- The free instance may spin down after inactivity, so the first visit after a quiet period can take a little while.
- Room data is stored in server memory. A server restart clears active rooms and scores.
- This is an MVP. Test with a small group before relying on it; reconnect handling, persistence, abuse protection, and automated integration tests still need work.
