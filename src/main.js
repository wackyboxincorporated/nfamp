import { ModParser } from './parser/mod-parser.js';
import { S3MParser } from './parser/s3m-parser.js';
import { XMParser } from './parser/xm-parser.js';
import { ModPlayer } from './engine/player.js';

const player = new ModPlayer();

const el = {
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('fileInput'),
    moduleName: document.getElementById('module-name'),
    playBtn: document.getElementById('playBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    stopBtn: document.getElementById('stopBtn'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    posVal: document.getElementById('pos-val'),
    rowVal: document.getElementById('row-val'),
    bpmVal: document.getElementById('bpm-val'),
    spdVal: document.getElementById('spd-val'),
    timeVal: document.getElementById('time-val'),
    meters: document.getElementById('meters'),
    patternView: document.getElementById('pattern-view'),
    instList: document.getElementById('inst-list'),
    canvas: document.getElementById('main-scope'),
};

let module = null;

async function init() {
    await player.init();

    el.dropzone?.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', handleFile);

    el.playBtn?.addEventListener('click', () => {
        player.play();
        el.playBtn.classList.add('active');
        el.pauseBtn.classList.remove('active');
    });

    el.pauseBtn?.addEventListener('click', () => {
        player.pause();
        el.pauseBtn.classList.toggle('active');
    });

    el.stopBtn?.addEventListener('click', () => {
        player.stop();
        el.playBtn.classList.remove('active');
        el.pauseBtn.classList.remove('active');
    });

    el.nextBtn?.addEventListener('click', () => player.nextPos?.());
    el.prevBtn?.addEventListener('click', () => player.prevPos?.());

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.dropzone?.classList.remove('hidden');
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files[0];
        if (file) handleFile({ target: { files: [file] } });
    });

    requestAnimationFrame(updateUI);
}

async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(buffer);
    let modParser = null;

    const xmSig = String.fromCharCode(...uint8.slice(0, 15));
    const s3mSig = String.fromCharCode(...uint8.slice(0x2C, 0x30));

    if (xmSig === 'Extended Module') modParser = new XMParser(buffer);
    else if (s3mSig === 'SCRM') modParser = new S3MParser(buffer);
    else modParser = new ModParser(buffer);

    try {
        module = modParser.parse();
    } catch (err) {
        console.error('Failed to parse module:', err);
        alert(`Failed to parse module: ${err.message}`);
        return;
    }

    el.moduleName.innerText = (module.name || 'UNTITLED').toUpperCase();
    el.dropzone?.classList.add('hidden');

    player.load(module);
    setupMeters(module.channels);
    if (module.instruments) setupInstruments(module.instruments);
    else if (module.samples) setupInstruments(module.samples);
}

function setupMeters(count) {
    el.meters.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const meter = document.createElement('div');
        meter.className = 'meter';
        meter.innerHTML = `<div class="meter-fill" id="meter-${i}" style="height: 0%"></div>`;
        el.meters.appendChild(meter);
    }
}

function setupInstruments(items) {
    el.instList.innerHTML = '';
    if (!items) return;
    items.forEach((item, i) => {
        const name = (item.name || '').trim();
        const div = document.createElement('div');
        div.className = 'inst-item';
        div.innerText = `${String(i + 1).padStart(2, '0')}: ${name || '---'}`;
        el.instList.appendChild(div);
    });
}

function updateUI() {
    const state = player;
    if (module) {
        el.posVal.innerText = String(state.position).padStart(2, '0');
        el.rowVal.innerText = String(state.row).padStart(2, '0');
        el.bpmVal.innerText = String(state.bpm).padStart(3, '0');
        el.spdVal.innerText = String(state.speed).padStart(2, '0');

        if (state.playing && !state.paused) {
            for (let i = 0; i < (module.channels || 0); i++) {
                const meterFill = document.getElementById(`meter-${i}`);
                if (meterFill) {
                    const chState = state.channelState[i];
                    const vol = chState ? chState.volume : 0;
                    meterFill.style.height = `${(vol / 64) * 100}%`;
                }
            }
        }
        updatePatternView(state.position, state.row);
    }
    drawScope();
    requestAnimationFrame(updateUI);
}

function updatePatternView(pos, row) {
    if (!module) return;
    const songOrder = module.songOrder || module.patternOrder;
    const pIdx = songOrder[pos];
    const pattern = module.patterns[pIdx];
    if (!pattern) return;

    let html = '';
    const visibleRows = 16;
    const startRow = Math.max(0, row - 8);
    const endRow = Math.min(pattern.rows.length, startRow + visibleRows);

    for (let r = startRow; r < endRow; r++) {
        const isCurrent = r === row;
        const color = isCurrent ? '#00ffff' : '#888';
        const bg = isCurrent ? 'rgba(0, 255, 255, 0.1)' : 'transparent';

        html += `<div style="color: ${color}; background: ${bg}; font-family: 'JetBrains Mono', monospace; font-size: 11px; white-space: pre; padding: 2px 0; border-bottom: 1px solid #111;">`;
        html += `${String(r).padStart(2, '0')} | `;

        for (let c = 0; c < Math.min(module.channels, 16); c++) {
            const n = pattern.rows[r][c];
            if (!n || (n.note === 255 && (!n.period || n.period === 0) && !n.sample)) {
                html += `... .. ... | `;
                continue;
            }

            let noteName = '...';
            const names = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
            if (module.type === 'XM' || module.type === 'S3M') {
                if (n.note < 97) noteName = names[n.note % 12] + Math.floor(n.note / 12);
                else if (n.note === 97 || n.note === 255) noteName = '==='; 
                else if (n.note === 254) noteName = '^^^'; 
            } else if (n.period > 0) {
                const semitones = Math.round(12 * Math.log2(856 / n.period));
                noteName = names[semitones % 12] + (1 + Math.floor(semitones / 12));
            }

            const smp = (n.sample || n.instrument) ? String(n.sample || n.instrument).padStart(2, '0') : '..';
            const effRaw = (n.effect !== 255 && n.effect !== undefined) ? n.effect : -1;
            let effChar = '.';
            if (effRaw !== -1) {
                if (module.type === 'S3M') {
                    const map = '.ABCDEFGHIJKLMNOPQRSTUVWXYZ';
                    effChar = map[effRaw] || '.';
                } else {
                    effChar = effRaw.toString(16).toUpperCase().slice(-1);
                }
            }
            const prm = (n.param !== undefined) ? n.param.toString(16).padStart(2, '0').toUpperCase() : '..';

            html += `<span style="color: #fff">${noteName}</span> `;
            html += `<span style="color: #0c0">${smp}</span> `;
            html += `<span style="color: #ff0">${effChar}${prm}</span> | `;
        }
        html += '</div>';
    }
    el.patternView.innerHTML = html;
}

const canvasCtx = el.canvas.getContext('2d');

function drawScope() {
    const w = el.canvas.width = el.canvas.clientWidth;
    const h = el.canvas.height = el.canvas.clientHeight;
    
    canvasCtx.fillStyle = '#000';
    canvasCtx.fillRect(0, 0, w, h);
    
    canvasCtx.lineWidth = 1;
    canvasCtx.strokeStyle = '#00ffcc';
    canvasCtx.beginPath();
    
    // audio data from player
    const data = player.getScopeData();
    
    if (!data) {
        canvasCtx.moveTo(0, h / 2);
        canvasCtx.lineTo(w, h / 2);
    } else {
        const sliceWidth = w * 1.0 / data.length;
        let x = 0;
        
        for (let i = 0; i < data.length; i++) {
            const v = data[i] / 128.0; // 128 is zero-crossing
            const y = v * h / 2;
            
            if (i === 0) canvasCtx.moveTo(x, y);
            else canvasCtx.lineTo(x, y);
            
            x += sliceWidth;
        }
    }
    
    canvasCtx.stroke();
}

init();