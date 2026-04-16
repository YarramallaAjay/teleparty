# MovieParty – Watch Together

Watch Netflix, Prime Video, Disney+, Hulu, Max, YouTube and more in perfect sync with your friends — no matter where they are.

A Chrome browser extension that syncs video playback across everyone in a party and adds a shared chat sidebar directly on the streaming site.

---

## Supported Platforms

| Platform | |
|---|---|
| Netflix | ✓ |
| Amazon Prime Video | ✓ |
| Disney+ | ✓ |
| Hulu | ✓ |
| Max (HBO) | ✓ |
| YouTube | ✓ |
| Apple TV+ | ✓ |
| Peacock | ✓ |
| Paramount+ | ✓ |
| MUBI | ✓ |
| Crunchyroll | ✓ |
| Discovery+ | ✓ |

---

## How to Install

> Everyone who wants to join a party needs to install the extension. It takes about a minute.

### 1. Clone the repo

```bash
git clone https://github.com/YarramallaAjay/teleparty.git
```

### 2. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked**
4. Select the `extension/` folder inside the cloned repo

The MovieParty icon will appear in your Chrome toolbar. That's it — no build step, no npm install needed for the extension.

---

## How to Use

### Starting a party

1. Open any supported streaming site and navigate to the movie or show you want to watch
2. Click the red **MovieParty** tab that appears on the right edge of the page
3. Enter your display name
4. Click **Create Party**
5. A Room ID (e.g. `A3FX9KQ2`) will appear — share it with your friends

### Joining a party

1. Install the extension (see above)
2. Open the **same streaming site** and navigate to the same title
3. Click the MovieParty tab on the right edge
4. Enter your display name and the Room ID you received
5. Click **Join**

Once everyone has joined, playback is automatically kept in sync. Anyone pressing play, pause, or seeking will update everyone else in real time.

### Chat & reactions

- Type in the chat box at the bottom of the sidebar to send messages
- Click emoji buttons (😂 😮 ❤️ 👍 🔥 😭) to send floating reactions visible to the whole party

---

## Project Structure

```
teleparty/
├── extension/          ← Chrome extension (load this folder)
│   ├── manifest.json
│   ├── content.js      ← video sync + sidebar UI
│   ├── sidebar.css
│   ├── background.js
│   ├── popup.html/js/css
│   └── icons/
├── server/             ← Node.js WebSocket server
│   ├── index.js
│   └── package.json
└── generate-icons.js   ← regenerate PNG icons (no deps required)
```

---

## Running the Server Locally

The extension already points to the deployed server on Railway — you don't need to run the server yourself to use the extension.

If you want to run your own server:

```bash
cd server
npm install
npm start
```

Then update the `SERVER_URL` constant at the top of `extension/content.js`:

```js
const SERVER_URL = 'ws://localhost:8080';
```

And reload the extension in `chrome://extensions`.

---

## Tech Stack

- **Extension** — Chrome Manifest V3, vanilla JS + CSS (no build tools)
- **Server** — Node.js, [`ws`](https://github.com/websockets/ws) WebSocket library
- **Hosting** — [Railway](https://railway.app) (server)

---

## Contributing

Pull requests are welcome. Open an issue first for large changes.
