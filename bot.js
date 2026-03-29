// ══════════════════════════════════════════════
//  MineWeb Bot
//  Stays connected 24/7, auto-reconnects,
//  responds to chat commands, wanders the world.
//
//  Usage:   node bot.js [ws://server:port]
//  Install: npm install ws
// ══════════════════════════════════════════════

const WebSocket = require('ws');

// ── Config ────────────────────────────────────
const SERVER_URL   = process.argv[2] || 'ws://localhost:8080';
const BOT_NAME     = process.env.BOT_NAME  || 'MineBot';
const BOT_COLOR    = '#f0a030'; // shown in chat only (server assigns actual color)
const RECONNECT_MS = 5000;     // ms between reconnect attempts
const MOVE_TICK    = 800;      // ms between wander steps
const CHAT_PREFIX  = '!';      // all commands start with !

// ── State ─────────────────────────────────────
let ws        = null;
let myId      = null;
let connected = false;
let seed      = null;
let wrad      = 38;

// Bot's current position (starts at world centre)
const pos = { x: 0.5, y: 52, z: 0.5 };
const rot = { rx: 0, ry: 0 };

// Known players: id -> { name, color, x, y, z }
const players = new Map();

// Simple in-memory notes: player name -> string
const notes = new Map();

// Uptime
const startTime = Date.now();

// ── Helpers ───────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function chat(text) {
  send({ type: 'chat', text: String(text) });
  log(`[say] ${text}`);
}

function formatUptime() {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function formatPos(x, y, z) {
  return `(${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)})`;
}

// ── Commands ──────────────────────────────────
// Each command: { help: string, run: (args, fromName) => void }
const COMMANDS = {

  help: {
    help: 'List all commands',
    run(args) {
      const list = Object.keys(COMMANDS).map(k => `!${k}`).join('  ');
      chat(`Commands: ${list}`);
    },
  },

  ping: {
    help: 'Check if the bot is alive',
    run(args, from) {
      chat(`Pong! 🏓 I'm alive, ${from}.`);
    },
  },

  uptime: {
    help: 'How long the bot has been running',
    run() {
      chat(`⏱ Bot uptime: ${formatUptime()}`);
    },
  },

  pos: {
    help: 'Show the bot\'s current position',
    run() {
      chat(`📍 I'm at ${formatPos(pos.x, pos.y, pos.z)}`);
    },
  },

  players: {
    help: 'List connected players',
    run() {
      if (players.size === 0) {
        chat('No other players online (just me!)');
        return;
      }
      const list = [...players.values()].map(p => p.name).join(', ');
      chat(`👥 Online (${players.size}): ${list}`);
    },
  },

  whereis: {
    help: '!whereis <name> — find a player\'s location',
    run(args) {
      const target = args.join(' ').toLowerCase();
      if (!target) { chat('Usage: !whereis <name>'); return; }
      const found = [...players.values()].find(p => p.name.toLowerCase().includes(target));
      if (!found) { chat(`Player "${args.join(' ')}" not found.`); return; }
      chat(`📍 ${found.name} is at ${formatPos(found.x, found.y, found.z)}`);
    },
  },

  seed: {
    help: 'Show the world seed',
    run() {
      chat(`🌍 World seed: ${seed ?? 'unknown'}`);
    },
  },

  say: {
    help: '!say <message> — make the bot say something',
    run(args) {
      const msg = args.join(' ');
      if (!msg) { chat('Usage: !say <message>'); return; }
      chat(msg);
    },
  },

  note: {
    help: '!note <text> — save a note  |  !note — read your note',
    run(args, from) {
      if (args.length === 0) {
        const n = notes.get(from);
        chat(n ? `📝 Your note: ${n}` : `You have no saved note. Use !note <text> to save one.`);
      } else {
        notes.set(from, args.join(' '));
        chat(`📝 Note saved for ${from}!`);
      }
    },
  },

  clearnote: {
    help: 'Delete your saved note',
    run(args, from) {
      notes.delete(from);
      chat(`🗑 Note cleared for ${from}.`);
    },
  },

  time: {
    help: 'Show current server time (UTC)',
    run() {
      chat(`🕐 Server time: ${new Date().toUTCString()}`);
    },
  },

  roll: {
    help: '!roll [N] — roll a dice (default d6)',
    run(args) {
      const sides = Math.max(2, Math.min(10000, parseInt(args[0]) || 6));
      const result = Math.floor(Math.random() * sides) + 1;
      chat(`🎲 Rolled d${sides}: ${result}`);
    },
  },

  flip: {
    help: 'Flip a coin',
    run() {
      chat(`🪙 ${Math.random() < 0.5 ? 'Heads!' : 'Tails!'}`);
    },
  },

  count: {
    help: 'Count how many players have ever connected this session',
    run() {
      chat(`Players ever seen this session: ${playerHistory.size}`);
    },
  },

  about: {
    help: 'Info about the bot',
    run() {
      chat(`🤖 I'm ${BOT_NAME}, a 24/7 MineWeb bot. Type !help for commands. Uptime: ${formatUptime()}`);
    },
  },
};

// Track all players ever seen (for !count)
const playerHistory = new Set();

// ── Chat handler ──────────────────────────────
function handleChat(from, name, text) {
  // Ignore own messages
  if (from === myId) return;

  log(`[chat] ${name}: ${text}`);

  if (!text.startsWith(CHAT_PREFIX)) return;

  const parts   = text.slice(CHAT_PREFIX.length).trim().split(/\s+/);
  const cmdName = parts[0].toLowerCase();
  const args    = parts.slice(1);

  const cmd = COMMANDS[cmdName];
  if (cmd) {
    try {
      cmd.run(args, name);
    } catch (e) {
      log(`[cmd error] ${e.message}`);
      chat(`⚠️ Error running !${cmdName}`);
    }
  } else {
    chat(`Unknown command: !${cmdName} — type !help for a list.`);
  }
}

// ── Wander behaviour ──────────────────────────
// Bot slowly roams around the spawn area
let _wanderTimer = null;

function wander() {
  if (!connected) return;

  // Random small step
  const angle = Math.random() * Math.PI * 2;
  const dist  = 1 + Math.random() * 2;
  pos.x += Math.cos(angle) * dist;
  pos.z += Math.sin(angle) * dist;

  // Stay within a 20-block radius of spawn
  const distFromSpawn = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
  if (distFromSpawn > 20) {
    // Nudge back toward centre
    pos.x *= 0.85;
    pos.z *= 0.85;
  }

  // Face a random direction
  rot.ry = Math.random() * Math.PI * 2;

  // Send position to server
  send({ type: 'move', x: pos.x, y: pos.y, z: pos.z, rx: rot.rx, ry: rot.ry, slot: 0 });
}

// ── WebSocket connection ──────────────────────
let _reconnectTimer = null;
let _reconnectCount = 0;

function connect() {
  clearTimeout(_reconnectTimer);
  log(`Connecting to ${SERVER_URL}…`);

  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    log('WebSocket open — waiting for init…');
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'init': {
        myId      = msg.id;
        seed      = msg.seed;
        wrad      = msg.wrad || 38;
        connected = true;
        _reconnectCount = 0;

        // Set our display name
        send({ type: 'setName', name: BOT_NAME });

        // Register existing players
        for (const p of (msg.players || [])) {
          players.set(p.id, p);
          playerHistory.add(p.name);
        }

        log(`Connected! id=${myId}  seed=${seed}  players=${players.size}`);
        chat(`👋 ${BOT_NAME} is online! Type !help for commands.`);

        // Start wandering
        clearInterval(_wanderTimer);
        _wanderTimer = setInterval(wander, MOVE_TICK);
        break;
      }

      case 'playerJoin': {
        players.set(msg.id, { id: msg.id, name: msg.name, color: msg.color, x: msg.x, y: msg.y, z: msg.z });
        playerHistory.add(msg.name);
        log(`[join] ${msg.name}`);
        // Greet the player after a short delay so it doesn't fire during their load
        setTimeout(() => {
          if (connected) chat(`Welcome, ${msg.name}! 👋 Type !help for bot commands.`);
        }, 3000);
        break;
      }

      case 'playerLeave': {
        const p = players.get(msg.id);
        if (p) {
          log(`[leave] ${p.name}`);
          players.delete(msg.id);
        }
        break;
      }

      case 'playerName': {
        const p = players.get(msg.id);
        if (p) {
          log(`[rename] ${p.name} → ${msg.name}`);
          p.name = msg.name;
          playerHistory.add(msg.name);
        }
        break;
      }

      case 'positions': {
        for (const pd of (msg.list || [])) {
          if (pd.id === myId) continue;
          const p = players.get(pd.id);
          if (p) { p.x = pd.x; p.y = pd.y; p.z = pd.z; }
        }
        break;
      }

      case 'chat': {
        handleChat(msg.from, msg.name, msg.text);
        break;
      }
    }
  });

  ws.on('close', (code, reason) => {
    connected = false;
    clearInterval(_wanderTimer);
    _reconnectCount++;
    const delay = Math.min(RECONNECT_MS * _reconnectCount, 60000); // cap at 60s
    log(`Disconnected (${code}) — reconnecting in ${delay / 1000}s… (attempt ${_reconnectCount})`);
    _reconnectTimer = setTimeout(connect, delay);
  });

  ws.on('error', (err) => {
    log(`Socket error: ${err.message}`);
    // onclose fires right after, which handles reconnect
  });
}

// ── Boot ──────────────────────────────────────
log(`MineWeb Bot "${BOT_NAME}" starting…`);
log(`Server: ${SERVER_URL}`);
log(`Commands: ${Object.keys(COMMANDS).map(c => '!' + c).join('  ')}`);
log('─'.repeat(48));
connect();
