// I hate batncies
const PROCESSOR_CODE = `
class ModProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.channels = [];
        this.masterGain = 1.0;
        
        this.port.onmessage = (event) => {
            const { type, data } = event.data;
            if (type === 'init') {
                const numChannels = data.numChannels || 4;
                const mode = data.type || 'MOD';
                
                // Adjormat
                let formatMult = 1.0;
                if (mode === 'S3M') formatMult = 0.5; 
                else if (mode === 'XM') formatMult = 0.8;
                
                this.masterGain = formatMult;

                this.channels = Array.from({ length: numChannels }, () => ({
                    sampleData: null,
                    position: 0,
                    step: 0,
                    volume: 0,
                    active: false,
                    loopStart: 0,
                    loopLength: 0,
                    loopType: 0,
                    panning: 0,
                    pingPongDir: 1
                }));

                // Default Panning
                for (let i = 0; i < numChannels; i++) {
                    if (numChannels === 4) {
                        this.channels[i].panning = (i === 0 || i === 3) ? -0.8 : 0.8;
                    } else {
                        this.channels[i].panning = (i % 2 === 0) ? -0.5 : 0.5;
                    }
                }
            } else if (type === 'updateChannel') {
                const { index, ...updates } = data;
                if (this.channels[index]) {
                    Object.assign(this.channels[index], updates);
                    if (updates.trigger) {
                        this.channels[index].position = updates.position || 0;
                        this.channels[index].pingPongDir = 1;
                    }
                }
            } else if (type === 'stop') {
                this.channels.forEach(c => c.active = false);
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || !output[0]) return true;
        
        const left = output[0];
        const right = output[1];
        const bufferLen = left.length;

        for (let i = 0; i < bufferLen; i++) {
            let mixL = 0;
            let mixR = 0;

            for (const ch of this.channels) {
                if (!ch.active || !ch.sampleData) continue;

                // Simple Linear Interpolation
                const pos = ch.position;
                const idx = Math.floor(pos);
                const fract = pos - idx;

                let s1 = ch.sampleData[idx] || 0;
                let nextIdx = idx + 1;
                
                // Loop Logic
                if (ch.loopType === 1) { // Forward
                    if (nextIdx >= ch.loopStart + ch.loopLength) nextIdx = ch.loopStart;
                } else if (ch.loopType === 2) { // PingPong
                    if (ch.pingPongDir > 0) {
                        if (nextIdx >= ch.loopStart + ch.loopLength) nextIdx = idx - 1; 
                    } else {
                        nextIdx = idx - 1; 
                        if (nextIdx < ch.loopStart) nextIdx = ch.loopStart;
                    }
                } else {
                    if (nextIdx >= ch.sampleData.length) nextIdx = -1;
                }

                let s2 = (nextIdx !== -1) ? (ch.sampleData[nextIdx] || 0) : 0;
                const sample = s1 + fract * (s2 - s1);
                
                const vol = ch.volume / 64.0;
                const val = sample * vol;

                const panL = Math.min(1, Math.max(0, (1 - ch.panning) / 2));
                const panR = Math.min(1, Math.max(0, (1 + ch.panning) / 2));

                mixL += val * panL;
                mixR += val * panR;

                // Advance Position
                if (ch.loopType === 2) { // PingPment
                    ch.position += ch.step * ch.pingPongDir;
                    if (ch.pingPongDir > 0) {
                        if (ch.position >= ch.loopStart + ch.loopLength) {
                            ch.position = (ch.loopStart + ch.loopLength) * 2 - ch.position;
                            ch.pingPongDir = -1;
                        }
                    } else {
                        if (ch.position <= ch.loopStart) {
                            ch.position = ch.loopStart * 2 - ch.position;
                            ch.pingPongDir = 1;
                        }
                    }
                } else { // Forward / None
                    ch.position += ch.step;
                    if (ch.loopType === 1) {
                        if (ch.position >= ch.loopStart + ch.loopLength) {
                            ch.position -= ch.loopLength;
                        }
                    } else {
                        if (ch.position >= ch.sampleData.length) {
                            ch.active = false;
                        }
                    }
                }
            }

            left[i] = Math.max(-1, Math.min(1, mixL * this.masterGain));
            right[i] = Math.max(-1, Math.min(1, mixR * this.masterGain));
        }

        return true;
    }
}
registerProcessor('mod-processor', ModProcessor);
`;

export class ModPlayer {
    constructor() {
        this.ctx = null;
        this.workletNode = null;
        this.analyser = null;
        this.module = null;
        this.playing = false;
        this.paused = false;
        this.position = 0;
        this.row = 0;
        this.tick = 0;
        this.speed = 6;
        this.bpm = 125;
        this.globalVolume = 64;
        this.breakRow = -1;
        this.jumpPos = -1;
        this.channelState = [];
        this.timerId = 0;
        this.nextTickTime = 0;
        this.AMIGA_CLOCK = 7093789.2;
    }

    async init() {
        if (this.ctx) return;
        this.ctx = new AudioContext();
        
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.6;

        try {
            const blob = new Blob([PROCESSOR_CODE], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            await this.ctx.audioWorklet.addModule(url);
            
            this.workletNode = new AudioWorkletNode(this.ctx, 'mod-processor', { 
                outputChannelCount: [2] 
            });
            
            this.workletNode.connect(this.analyser);
            this.analyser.connect(this.ctx.destination);
            
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('Failed to init AudioWorklet:', e);
        }
    }

    getScopeData() {
        if (!this.analyser) return null;
        const data = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteTimeDomainData(data);
        return data;
    }

    load(module) {
        this.module = module;
        this.stop();
        this.position = 0;
        this.row = 0;
        this.tick = 0;
        this.speed = module.initialSpeed || 6;
        this.bpm = module.initialBPM || 125;
        this.globalVolume = (module.globalVolume !== undefined) ? module.globalVolume : 64;
        this.breakRow = -1;
        this.jumpPos = -1;

        this.channelState = Array.from({ length: module.channels }, () => ({
            instrument: 0,
            volume: 64,
            note: 0,
            period: 0, // Currriod
            targetPeriod: 0, // Destiamento
            finetune: 0,
            relativeNote: 0,
            sampleData: null,
            loopStart: 0,
            loopLength: 0,
            effect: 0,
            effectParam: 0,
            portaSpeed: 0,
            delayTick: 0,
            delayedNote: null,
            offsetMemory: 0,
            
            // XM Enve\te
            volEnvTick: 0,
            panEnvTick: 0,
            fadeOut: 65536,
            panning: 0,
            autoVibPhase: 0,
            vibPhase: 0,
            tremPhase: 0,
            keyOff: false,
            
            effectMemory: {},
            volEffect: 0,
            volEffectParam: 0,
            
            arp1: 0,
            arp2: 0,
            vibSpeed: 0,
            vibDepth: 0,
            tremSpeed: 0,
            tremDepth: 0,
            vibOffset: 0,
            tremOffset: 0
        }));

        this.workletNode?.port.postMessage({
            type: 'init',
            data: { sampleRate: this.ctx?.sampleRate || 44100, numChannels: module.channels, type: module.type }
        });
    }

    play() {
        if (!this.module || this.playing) return;
        this.ctx?.resume();
        this.playing = true;
        this.tick = this.speed - 1;
        this.nextTickTime = performance.now();
        this.schedule();
    }

    stop() {
        this.playing = false;
        this.paused = false;
        clearTimeout(this.timerId);
        this.workletNode?.port.postMessage({ type: 'stop' });
    }

    pause() {
        if (!this.playing) return;
        this.paused = !this.paused;
        if (!this.paused) {
            this.nextTickTime = performance.now();
            this.schedule();
        }
    }

    schedule() {
        if (!this.playing || this.paused) return;
        const now = performance.now();
        while (this.nextTickTime < now + 30) {
            this.processTick();
            const tickMillis = 2500 / this.bpm;
            this.nextTickTime += tickMillis;
        }
        this.timerId = setTimeout(() => this.schedule(), 10);
    }

    processTick() {
        if (!this.module) return;
        if (++this.tick >= this.speed) {
            this.tick = 0;
            this.processRow();
        } else {
            this.processTickEffects();
        }
    }

    processRow() {
        const songOrder = this.module.songOrder || this.module.patternOrder;
        if (!songOrder) return;
        const patternIdx = songOrder[this.position];
        const pattern = this.module.patterns[patternIdx];
        if (!pattern || !pattern.rows) return;
        const row = pattern.rows[this.row];

        for (let i = 0; i < this.module.channels; i++) {
            const n = row?.[i];
            if (!n) continue;
            const state = this.channelState[i];

            // Hanx)
            if ((this.module.type === 'S3M' && n.effect === 0x13 && (n.param >> 4) === 0x0D) ||
                (this.module.type === 'XM' && n.effect === 0x0E && (n.param >> 4) === 0x0D)) {
                state.delayTick = n.param & 0x0F;
                state.delayedNote = { ...n, effect: 0 }; 
                continue;
            }

            this.triggerNote(i, n);
        }

        if (this.breakRow !== -1 || this.jumpPos !== -1 || ++this.row >= (pattern.numRows || 64)) {
            const count = songOrder.length;
            this.position = (this.jumpPos !== -1) ? this.jumpPos : (this.position + 1) % count;
            this.row = (this.breakRow !== -1) ? this.breakRow : 0;
            this.breakRow = -1; this.jumpPos = -1;
            if (this.position >= count) this.position = 0;
        }
    }

    triggerNote(ch, n) {
        const state = this.channelState[ch];
        const isXM = (this.module.type === 'XM');
        const isS3M = (this.module.type === 'S3M');
        const isMOD = (this.module.type === 'MOD');

        state.effect = n.effect;
        state.effectParam = n.param !== undefined ? n.param : 0;
        state.volEffect = 0;
        state.volEffectParam = 0;

        const newInst = n.sample || n.instrument;
        if (newInst > 0) state.instrument = newInst;

        let hasNote = false;
        let noteKey = n.note;

        // hbj
        if (isMOD) {
            if (n.period > 0) {
                const semitones = Math.round(12 * Math.log2(856 / n.period));
                state.note = 12 + semitones;
                hasNote = true;
            }
        } else {
            // S3M / M
            if (noteKey > 0 && noteKey < 97) {
                hasNote = true;
            } else if (noteKey === 97) { // Key 
                state.keyOff = true;
            }
        }

        // ----
        let inst = null;
        if (newInst > 0 || (hasNote && state.instrument > 0)) {
            if (isXM && this.module.instruments) inst = this.module.instruments[state.instrument - 1];
            else if (this.module.samples) inst = this.module.samples[state.instrument - 1];
        }

        let sample = null;
        if (inst) {
            if (isXM) {
                const sampleIdx = inst.sampleMap ? inst.sampleMap[Math.min(95, (hasNote ? noteKey - 1 : state.note))] : 0;
                sample = inst.samples[sampleIdx];
            } else {
                sample = inst; // S3M/Mects
            }
        }

        if (sample && (newInst > 0 || (hasNote && state.sampleData === null))) {
            state.sampleData = sample.data;
            state.loopStart = sample.loopStart;
            state.loopLength = sample.loopLength;
            state.loopType = isXM ? (sample.type & 3) : (sample.loopLength > 0 ? 1 : 0);
            state.finetune = sample.finetune || 0;
            state.relativeNote = sample.relativeNote || 0;
            
            // Defaulume
            if (newInst > 0) state.volume = sample.volume;
            
            // Defau
            if (sample.pan !== undefined) state.panning = (sample.pan - 128) / 128;
            else if (isMOD) state.panning = (ch % 4 === 0 || ch === 3) ? -0.8 : 0.8;
            else state.panning = (ch % 2 === 0) ? -0.5 : 0.5;
        }

        // nm 
        if (isXM && n.volume !== undefined && n.volume !== 255) {
            const v = n.volume;
            if (v >= 0x10 && v <= 0x50) state.volume = v - 0x10;
            else if (v >= 0x60 && v <= 0x6F) { state.volEffect = 0x0A; state.volEffectParam = (v & 0x0F); } // Vide Down
            else if (v >= 0x70 && v <= 0x7F) { state.volEffect = 0x0A; state.volEffectParam = (v & 0x0F) << 4; } // ol Slide Up
            else if (v >= 0x80 && v <= 0x8F) { state.volEffect = 0x0A; state.volEffectParam = (v & 0x0F); } // Fine wn
            else if (v >= 0x90 && v <= 0x9F) { state.volEffect = 0x0A; state.volEffectParam = (v & 0x0F) << 4; } // ne Up
            else if (v >= 0xC0 && v <= 0xCF) state.panning = ((v & 0x0F) * 16 - 128) / 128; 
            else if (v >= 0xF0 && v <= 0xFF) { // Tone Porta
                 state.volEffect = 0x03; 
                 // Mapping voam is mesup, 
                 // but stam is 0
                 const table = [0, 1, 4, 8, 16, 32, 64, 96, 128, 256]; // Apation
                 state.volEffectParam = table[v & 0x0F] || 0; 
            }
        } else if (!isXM && n.volume !== undefined && n.volume !== 255) {
             state.volume = Math.min(64, n.volume);
        }

        // -Die
        const isTonePorta = (state.effect === 0x03 || state.effect === 0x05 || state.volEffect === 0x03);

        if (hasNote) {
            state.note = noteKey;
            const targetPeriod = this.getPeriod(state.note, state.finetune, state.relativeNote);
            
            if (isTonePorta) {
                state.targetPeriod = targetPeriod;
                if (state.period === 0) state.period = targetPeriod; // No prt
            } else {
                state.period = targetPeriod;
                state.targetPeriod = 0;
                
                // Triet
                state.keyOff = false;
                state.volEnvTick = 0;
                state.panEnvTick = 0;
                state.fadeOut = 65536;
                state.autoVibPhase = 0;
                state.vibPhase = 0;
                state.tremPhase = 0;

                // Selet
                let offset = 0;
                if (state.effect === 0x09) offset = (state.effectParam || state.offsetMemory) * 256;
                
                if (state.sampleData) {
                    this.updateWorkletChannel(ch, {
                        sampleData: state.sampleData,
                        loopStart: state.loopStart,
                        loopLength: state.loopLength,
                        loopType: state.loopType,
                        active: true,
                        trigger: true,
                        position: offset,
                        pingPongDir: 1
                    });
                }
            }
        }

        state.vibOffset = 0;
        state.tremOffset = 0;

        // Proceck 0
        this.handleEffect(ch, state.effect, state.effectParam, true);
        if (state.volEffect) this.handleEffect(ch, state.volEffect, state.volEffectParam, true);

        // Calte
        const env = this.processEnvelopes(ch);
        const finalPan = Math.max(-1, Math.min(1, (state.panning || 0) + env.pan));
        
        this.updateWorkletChannel(ch, {
            volume: this.calculateFinalVolume(ch, state.volume),
            step: this.calculateFrequency(ch),
            panning: finalPan
        });
    }

    processTickEffects() {
        for (let i = 0; i < this.module.channels; i++) {
            const state = this.channelState[i];

            if (state.delayTick > 0 && --state.delayTick === 0) {
                if (state.delayedNote) { this.triggerNote(i, state.delayedNote); state.delayedNote = null; }
            }

            state.vibOffset = 0;
            state.tremOffset = 0;

            if (state.effect !== 0) this.handleEffect(i, state.effect, state.effectParam, false);
            if (state.volEffect !== 0) this.handleEffect(i, state.volEffect, state.volEffectParam, false);

            this.advanceEnvelopes(i);
            const env = this.processEnvelopes(i);
            const finalPan = Math.max(-1, Math.min(1, (state.panning || 0) + env.pan));

            this.updateWorkletChannel(i, {
                volume: this.calculateFinalVolume(i, state.volume),
                step: this.calculateFrequency(i),
                panning: finalPan
            });
        }
    }

    getPeriod(note, fine, relative) {
        // XM Liiga
        if (this.module.linearFreq) {
             return 7680 - (note + relative - 1) * 64 - (fine / 2);
        } else {
             // Ami3M
             const realNote = note + relative;
             const periods = [1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 906];
             const oct = Math.floor((realNote - 1) / 12);
             const n = (realNote - 1) % 12;
             let p = periods[n] || 0;
             // Apply Oase octads
             const shift = oct - 3; 
             if (shift >= 0) p = p >> shift;
             else p = p << (-shift);
             return p;
        }
    }

    calculateFrequency(ch) {
        const state = this.channelState[ch];
        const sampleRate = this.ctx?.sampleRate || 44100;
        if (!state.period) return 0;

        let p = state.period;
        
        // Apply Vibreg
        let arpNote = 0;
        if (state.arp1 > 0 || state.arp2 > 0) {
            const ph = this.tick % 3;
            if (ph === 1) arpNote = state.arp1;
            else if (ph === 2) arpNote = state.arp2;
        }

        if (this.module.linearFreq) {
             p = p - (arpNote * 64) - (state.vibOffset * 4); // Vib depaled
             const freq = 8363 * Math.pow(2, (4608 - p) / 768);
             return freq / sampleRate;
        } else {
             // Amiode
             if (arpNote !== 0) {
                 //riod table again
                 p = p / Math.pow(2, arpNote / 12); 
             }
             p = p + state.vibOffset; // Amigectly
             if (p < 1) p = 1;
             return (this.AMIGA_CLOCK / (p * 2)) / sampleRate;
        }
    }

    // --- Envelopes ---
    processEnvelopes(ch) {
        const state = this.channelState[ch];
        if (this.module.type !== 'XM') return { vol: 1.0, pan: 0.0 };

        const inst = this.module.instruments?.[state.instrument - 1];
        let volEnv = 64.0;
        let panEnv = 32.0;

        if (inst) {
            if (inst.volPoints && inst.volPoints.length > 0 && (inst.volType & 1)) {
                volEnv = this.getEnvelopeValue(inst.volPoints, inst.numVolPoints, state.volEnvTick);
            }
            if (inst.panPoints && inst.panPoints.length > 0 && (inst.panType & 1)) {
                panEnv = this.getEnvelopeValue(inst.panPoints, inst.numPanPoints, state.panEnvTick);
            }
        }

        return {
            vol: (volEnv / 64.0) * (state.fadeOut / 65536.0),
            pan: (panEnv - 32.0) / 32.0
        };
    }

    advanceEnvelopes(ch) {
        const state = this.channelState[ch];
        if (this.module.type !== 'XM') return;

        const inst = this.module.instruments?.[state.instrument - 1];
        if (!inst) {
             if (state.keyOff) state.fadeOut = Math.max(0, state.fadeOut - 1024); // Default fade if no inst
             return;
        }

        // Vollope
        if ((inst.volType & 1) && inst.volPoints) { // On
            let advance = true;
            
            // Sain
            if ((inst.volType & 2) && !state.keyOff) {
                if (state.volEnvTick === inst.volPoints[inst.volSustain]?.x) advance = false;
            }

            // Poop
            if ((inst.volType & 4) && state.volEnvTick >= inst.volPoints[inst.volLoopEnd]?.x) {
                state.volEnvTick = inst.volPoints[inst.volLoopStart]?.x || 0;
            } else if (advance) {
                state.volEnvTick++;
            }
        }

        // Paope
        if ((inst.panType & 1) && inst.panPoints) { // On
            let advance = true;
            if ((inst.panType & 2) && !state.keyOff) {
                if (state.panEnvTick === inst.panPoints[inst.panSustain]?.x) advance = false;
            }
            if ((inst.panType & 4) && state.panEnvTick >= inst.panPoints[inst.panLoopEnd]?.x) {
                state.panEnvTick = inst.panPoints[inst.panLoopStart]?.x || 0;
            } else if (advance) {
                state.panEnvTick++;
            }
        }

        // Faut
        if (state.keyOff) {
            state.fadeOut = Math.max(0, state.fadeOut - (inst.fadeout || 0));
        }
    }

    getEnvelopeValue(points, num, tick) {
        if (!points || num === 0) return 64.0;
        let i = 0;
        for (i = 0; i < num - 1; i++) {
            if (tick <= points[i + 1].x) break;
        }
        
        // Clamd
        if (i >= num - 1) return points[num - 1].y;
        
        const p1 = points[i];
        const p2 = points[i + 1];
        if (tick < p1.x) return p1.y;

        const dx = p2.x - p1.x;
        if (dx === 0) return p2.y;
        
        const dy = p2.y - p1.y;
        return p1.y + (tick - p1.x) * (dy / dx);
    }

    handleEffect(ch, eff, param, tick0) {
        const state = this.channelState[ch];
        const isXM = (this.module.type === 'XM');
        const isS3M = (this.module.type === 'S3M');

        if (param > 0) state.effectMemory[eff] = param;
        const p = state.effectMemory[eff] || 0;

        if (tick0) {
            // -cts 
            switch(eff) {
                case 0x01: // PortD/XM)
                case 0x02: // PoM)
                    if (isS3M) { /* S3M handow */ }
                    else { if (param > 0) state.portaSpeed = param; }
                    break;
                case 0x03: // Toa
                    if (param > 0) state.portaSpeed = param;
                    break;
                case 0x0C: // Sl
                    state.volume = Math.min(64, param);
                    break;
                case 0x0F: // SePM
                    if (param < 32) this.speed = param; else this.bpm = param;
                    break;
                // ... (Keep exisak) ...
                case 0x0B: this.jumpPos = param; this.breakRow = 0; break;
                case 0x0D: this.breakRow = ((param >> 4) * 10) + (param & 0x0F); break;
            }
        } else {
            // --cts 
            switch(eff) {
                case 0x01: // Porta Up
                    if (state.period > 0) {
                        const slide = (p * 4); // 4x multipic? 
                        // Actually in Linone.
                        // In Amigaion.
                        if (this.module.linearFreq) state.period -= slide; 
                        else state.period -= p; // Amiiod
                        if (state.period < 1) state.period = 1;
                    }
                    break;
                case 0x02: // Porta Down
                    if (state.period > 0) {
                        const slide = (p * 4); 
                        if (this.module.linearFreq) state.period += slide;
                        else state.period += p;
                    }
                    break;
                case 0x03: // Torta
                case 0x05: // Tone Pide
                    if (state.targetPeriod > 0 && state.period > 0) {
                        const speed = state.portaSpeed * (this.module.linearFreq ? 4 : 1);
                        if (state.period < state.targetPeriod) {
                            state.period += speed;
                            if (state.period > state.targetPeriod) state.period = state.targetPeriod;
                        } else if (state.period > state.targetPeriod) {
                            state.period -= speed;
                            if (state.period < state.targetPeriod) state.period = state.targetPeriod;
                        }
                    }
                    if (eff === 0x05) this.doVolSlide(ch, p); // de
                    break;
                case 0x0A: // Vo
                    this.doVolSlide(ch, p);
                    break;
                case 0x04: // Vibr
                case 0x06: // dick
                    {
                        const d = (p & 0x0F) || state.vibDepth;
                        const s = (p >> 4)   || state.vibSpeed;
                        state.vibDepth = d; state.vibSpeed = s;
                        
                        const phase = (state.vibPhase * Math.PI * 2) / 64;
                        
                        state.vibOffset = Math.sin(phase) * d * 2; 
                        state.vibPhase = (state.vibPhase + s) & 0x3F;
                        
                        if (eff === 0x06) this.doVolSlide(ch, 0); 
                    }
                    break;
            }
        }
    }

    doVolSlide(ch, p) {
        const state = this.channelState[ch];
        
        let up = (p >> 4);
        let down = (p & 0x0F);
        
        
        
        if (up > 0) state.volume = Math.min(64, state.volume + up);
        else if (down > 0) state.volume = Math.max(0, state.volume - down);
    }

    calculateFinalVolume(ch, vol) {
        const state = this.channelState[ch];
        const gVol = this.globalVolume / 64;
        const env = this.processEnvelopes(ch);
        const finalVol = Math.max(0, Math.min(64, vol));
        return finalVol * gVol * env.vol;
    }
    
    updateWorkletChannel(index, data) {
        this.workletNode?.port.postMessage({ type: 'updateChannel', data: { index, ...data } });
    }
}