/**
 * JARVIS as a desktop application.
 *
 * The web build assumes two terminals and a browser tab. This process replaces
 * all three: it starts the bridge, serves the built interface over loopback,
 * and opens one window onto it. Quitting takes the bridge down with it, so
 * there is nothing left running that the user did not ask for.
 *
 *   npm run app        — the packaged interface from dist/
 *   npm run app:dev    — against a Vite dev server you started yourself
 */

const { app, BrowserWindow, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const os = require('node:os')

/**
 * Where the app's own files live.
 *
 * Packaged, the bridge and the built interface are unpacked beside the
 * executable rather than inside the asar archive — the bridge spawns a child
 * process and reads its own directory, neither of which works from inside an
 * archive.
 */
const ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..')

const DIST = path.join(ROOT, 'dist')
const BRIDGE = path.join(ROOT, 'bridge', 'server.mjs')

const DEV = process.argv.includes('--dev')
const DEV_URL = 'http://localhost:5173'

/** The bridge's port. The interface looks for it here by default. */
const BRIDGE_PORT = 8787

let bridge = null
let server = null
let win = null

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * A GUI app inherits almost nothing.
 *
 * Launched from Finder rather than a shell, this process gets a PATH of
 * /usr/bin:/bin:/usr/sbin:/sbin and no profile. The bridge's whole job is to
 * spawn the `claude` CLI, which lives in none of those, so without this the
 * app starts perfectly and then cannot think — the one failure that looks like
 * a bug in the model rather than a missing directory.
 */
function pathForChildren() {
  const extra = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.bun', 'bin'),
  ]
  const current = (process.env.PATH ?? '').split(':').filter(Boolean)
  return [...new Set([...extra, ...current])].join(':')
}

/**
 * Secrets, from a file rather than the environment.
 *
 * There is no shell to export a key in when the app is launched by
 * double-click, so `~/.jarvis.env` stands in for one: plain KEY=VALUE lines,
 * read once at startup. The bridge also finds an ElevenLabs key in the
 * `elevenlabs` MCP server of ~/.claude.json, so this is the second of two
 * places to look, not the only one.
 */
function fileEnv() {
  const file = path.join(os.homedir(), '.jarvis.env')
  const out = {}
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return out // absent is the normal case
  }
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const eq = text.indexOf('=')
    if (eq < 1) continue
    const key = text.slice(0, eq).trim()
    const value = text.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (key) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Serving the interface
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
}

function freePort(from, to) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > to) return reject(new Error(`no free port in ${from}-${to}`))
      const probe = net.createServer()
      probe.once('error', () => tryPort(port + 1))
      probe.once('listening', () => probe.close(() => resolve(port)))
      probe.listen(port, '127.0.0.1')
    }
    tryPort(from)
  })
}

/**
 * Serve dist/ over loopback.
 *
 * Not file://, which is not a secure context in the way getUserMedia wants,
 * and not a public interface either. The port is deliberately inside the range
 * the bridge already trusts as a local dev origin, so the WebSocket handshake
 * is not rejected by a check that is doing exactly its job.
 */
async function serveDist() {
  const port = await freePort(4173, 4199)
  server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    const rel = url === '/' ? 'index.html' : decodeURIComponent(url.replace(/^\/+/, ''))
    const file = path.join(DIST, rel)

    // Confine to dist/. A packaged app serving arbitrary paths off the disk
    // would be a gift to anything that can reach this port.
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      })
      res.end(body)
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return `http://localhost:${port}`
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

function startBridge(origin) {
  const env = {
    ...process.env,
    ...fileEnv(),
    PATH: pathForChildren(),
    // Run the bundled Node rather than looking for one on the system: a
    // packaged app cannot assume the machine has node installed at all.
    ELECTRON_RUN_AS_NODE: '1',
    JARVIS_BRIDGE_PORT: String(BRIDGE_PORT),
    JARVIS_BRIDGE_HOST: '127.0.0.1',
    // The whole point of the desktop build: this is the user's own machine,
    // and they asked for it.
    JARVIS_ALLOW_WRITES: '1',
    JARVIS_ALLOWED_ORIGINS: [origin, origin.replace('localhost', '127.0.0.1')].join(','),
  }

  bridge = spawn(process.execPath, [BRIDGE], { env, cwd: ROOT })
  const tag = (stream) => (data) =>
    String(data)
      .split('\n')
      .filter(Boolean)
      .forEach((line) => stream(`[bridge] ${line}`))
  bridge.stdout.on('data', tag(console.log))
  bridge.stderr.on('data', tag(console.error))
  bridge.on('exit', (code) => {
    console.error(`[jarvis] bridge exited (${code})`)
    bridge = null
  })
}

/** Wait until the bridge answers, so the window never opens onto a dead socket. */
async function bridgeReady(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`)
      if (res.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

function createWindow(url) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#04070c',
    title: 'J.A.R.V.I.S.',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  // The microphone and camera are the application, so there is no question to
  // ask here. macOS still asks once, for the app as a whole, which is the
  // prompt that actually protects the user.
  const granted = new Set(['media', 'audioCapture', 'videoCapture'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) =>
    done(granted.has(permission)),
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    granted.has(permission),
  )

  // Anything he is asked to open belongs in the real browser, with the user's
  // sessions and extensions, not in this window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  win.loadURL(url)
  win.on('closed', () => {
    win = null
  })
}

// ---------------------------------------------------------------------------

app.on('ready', async () => {
  try {
    const url = DEV ? DEV_URL : await serveDist()
    startBridge(url)
    if (!(await bridgeReady())) {
      console.error('[jarvis] bridge did not come up — opening the window anyway')
    }
    createWindow(url)
  } catch (err) {
    console.error('[jarvis] failed to start:', err)
    app.quit()
  }
})

app.on('activate', () => {
  if (!win) app.emit('ready')
})

app.on('window-all-closed', () => app.quit())

app.on('will-quit', () => {
  // Leaving the bridge running would leave an agent with write access to the
  // machine alive after its window is gone.
  bridge?.kill('SIGTERM')
  server?.close()
})
