import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const HOME_DIR = process.env.HOME || os.homedir();
const WHISPER_BIN =
  process.env.WHISPER_BIN || path.join(HOME_DIR, 'tools/whisper.cpp/build/bin/whisper-cli');
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || path.join(HOME_DIR, 'tools/whisper.cpp/models/ggml-base.en.bin');
const WHISPER_THREADS = String(process.env.WHISPER_THREADS || 4);

export function voiceSupported() {
  return fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);
}

// whisper hallucinates on quiet / short / non-English audio: "[BLANK_AUDIO]",
// "(speaks in foreign language)", "(silence)", lone "you", "Thank you." loops.
// Strip bracketed/parenthetical segments and see if anything real is left.
function isNoise(text) {
  const core = text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
  if (core.length < 3) return true;
  return /^(you|thank you[.! ]*)+$/i.test(text.trim());
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(cmd)} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) =>
      reject(e.code === 'ENOENT' ? new Error(`${path.basename(cmd)} is not installed`) : e)
    );
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-300)}`));
    });
  });
}

/**
 * Transcribe a local audio file (Telegram voice notes are OGG/Opus `.oga`).
 * Normalises to 16 kHz mono WAV with ffmpeg first — the most reliable input for
 * whisper.cpp — then runs whisper-cli and returns the plain text.
 */
export async function transcribe(audioPath) {
  if (!voiceSupported()) throw new Error('voice transcription is not set up on this VPS');
  const base = path.join(os.tmpdir(), `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const wav = `${base}.wav`;
  const txt = `${base}.txt`;
  try {
    await run('ffmpeg', ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', wav], 60000);
    await run(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', wav, '-otxt', '-of', base, '-np', '-t', WHISPER_THREADS],
      180000
    );
    const text = fs.readFileSync(txt, 'utf8').replace(/\s+/g, ' ').trim();
    return isNoise(text) ? '' : text;
  } finally {
    for (const f of [wav, txt]) fs.promises.unlink(f).catch(() => {});
  }
}
