// i put this in here because like just in case you hate yourself
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
                
                // Adjust gain headroom based on format
                // S3M/XM often need more headroom due to global volume scaling
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
                if (ch.loopType === 2) { // PingPong Movement
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
        this.analyser = null; // its not a very good visualiser but thats because im lazy and i stole the implementation 
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
        
        // Do it
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.6;

        try {
            // Eat dick for free by creating a blob with the thing I put at the top
            const blob = new Blob([PROCESSOR_CODE], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            await this.ctx.audioWorklet.addModule(url);
            
            this.workletNode = new AudioWorkletNode(this.ctx, 'mod-processor', { 
                outputChannelCount: [2] 
            });
            
            // connect 
            this.workletNode.connect(this.analyser);
            this.analyser.connect(this.ctx.destination);
            
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('Failed to init AudioWorklet:', e);
        }
    }

    // exposE
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
            targetNote: 0,
            finetune: 0,
            relativeNote: 0,
            sampleData: null,
            loopStart: 0,
            loopLength: 0,
            effect: 0,
            effectParam: 0,
            pitchOffset: 0,
            portaSpeed: 0,
            delayTick: 0,
            delayedNote: null,
            lastParam: 0, 
            lastPortaSpeed: 0,
            offsetMemory: 0,
            s3mMem: {}, 
            // XM specific
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
        // Look ahead
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

            // nude delay
            let isDelayed = false;
            if ((this.module.type === 'S3M' && n.effect === 0x13 && (n.param >> 4) === 0x0D) ||
                (this.module.type === 'XM' && n.effect === 0x0E && (n.param >> 4) === 0x0D)) {
                state.delayTick = n.param & 0x0F;
                state.delayedNote = { ...n, effect: 0 }; 
                isDelayed = true;
            }

            if (isDelayed) continue;

            this.triggerNote(i, n);
        }
// Gay people don'tlive here
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

        state.effect = n.effect;
        state.effectParam = n.param !== undefined ? n.param : 0;
        state.volEffect = 0;
        state.volEffectParam = 0;

        const newInst = n.sample || n.instrument;
        if (newInst > 0) state.instrument = newInst;

        let hasNote = false;
        let currentNote = n.note;

        if (this.module.type === 'MOD') {
            if (n.period > 0) {
                // approximate conversion 
                const semitones = Math.round(12 * Math.log2(856 / n.period));
                state.note = 12 + semitones;
                hasNote = true;
            }
        } else {
            if (currentNote < 97 && currentNote !== 255) {
                const isPorta = (this.module.type === 'S3M' ? state.effect === 0x07 : state.effect === 0x03);
                if (isPorta && state.note > 0) {
                    state.targetNote = currentNote;
                } else {
                    state.note = currentNote;
                    state.pitchOffset = 0;
                    hasNote = true;
                }
            } else if (currentNote === 97) { 
                state.keyOff = true;
            } else if (currentNote === 254) { 
                state.volume = 0;
            }
        }

        let trigger = true;
        let position = 0;

        if (state.effect === 0x09 || (this.module.type === 'S3M' && state.effect === 0x0F)) {
            if (state.effectParam > 0) state.offsetMemory = state.effectParam;
            position = state.offsetMemory * 256;
            trigger = (newInst > 0 || hasNote); 
        }

        if (hasNote || (newInst > 0 && n.note === 255)) {
            const inst = (this.module.type === 'XM' && this.module.instruments) ? this.module.instruments[state.instrument - 1] : null;
            const noteMapping = (this.module.type === 'XM' && n.note < 97) ? n.note : state.note;
            const sampleIdx = inst?.sampleMap ? inst.sampleMap[Math.min(95, noteMapping)] : 0;
            const s = inst ? inst.samples[sampleIdx] : (this.module.samples ? this.module.samples[state.instrument - 1] : null);

            if (s) {
                state.finetune = s.finetune || 0;
                state.relativeNote = s.relativeNote || 0;
                state.sampleData = s.data;
                state.loopStart = s.loopStart;
                state.loopLength = s.loopLength;
                state.loopType = (this.module.type === 'XM') ? (s.type & 3) : (state.loopLength > 0 ? 1 : 0);
                if (s.pan !== undefined) state.panning = (s.pan - 128) / 128;
                else if (this.module.type === 'MOD') state.panning = (ch === 0 || ch === 3 || (ch % 4 === 0)) ? -0.8 : 0.8;
                else state.panning = (ch % 2 === 0) ? -0.5 : 0.5;

                const hasVolCommand = (n.volume !== undefined && n.volume !== 255);
                if (newInst > 0 || (hasNote && !hasVolCommand)) {
                    state.volume = s.volume;
                }

                if (state.sampleData) {
                    if (hasNote || newInst > 0) {
                        state.keyOff = false;
                        state.volEnvTick = 0;
                        state.panEnvTick = 0;
                        state.fadeOut = 65536;
                        state.autoVibPhase = 0;
                        state.vibPhase = 0;
                        state.tremPhase = 0;
                    }

                    if (hasNote) {
                        this.updateWorkletChannel(ch, {
                            sampleData: state.sampleData,
                            loopStart: state.loopStart,
                            loopLength: state.loopLength,
                            loopType: state.loopType,
                            active: true,
                            trigger: trigger,
                            position: position,
                            pingPongDir: 1
                        });
                    }
                }
            }
        }

        if (this.module.type === 'XM' && n.volume !== undefined && n.volume !== 255) {
            const v = n.volume;
            if (v >= 0x10 && v <= 0x50) state.volume = v - 0x10;
            else if (v >= 0x60 && v <= 0x6F) { state.volEffect = 0x0A; state.volEffectParam = (v & 0x0F); } 
            else if (v >= 0x70 && v <= 0x7F) { state.volEffect = 0x0A; state.volEffectParam = (v & 0x0F) << 4; } 
            else if (v >= 0x80 && v <= 0x8F) { state.volEffect = 0x0A; state.volEffectParam = (v & 0x0F); } 
            else if (v >= 0x90 && v <= 0x9F) { state.volEffect = 0x0A; state.volEffectParam = (v & 0x0F) << 4; } 
            else if (v >= 0xC0 && v <= 0xCF) state.panning = ((v & 0x0F) * 16 - 128) / 128; 
            else if (v >= 0xD0 && v <= 0xDF) { state.volEffect = 0x19; state.volEffectParam = (v & 0x0F); } 
            else if (v >= 0xE0 && v <= 0xEF) { state.volEffect = 0x19; state.volEffectParam = (v & 0x0F) << 4; } 
            else if (v >= 0xF0 && v <= 0xFF) {
                state.volEffect = 0x03;
                const table = [0, 1, 4, 8, 16, 32, 64, 96, 128, 256];
                state.volEffectParam = table[v & 0x0F] || 0;
            } 
        } else if (this.module.type !== 'XM' && n.volume !== 255 && n.volume !== undefined) {
            state.volume = Math.min(64, n.volume);
        }

        state.vibOffset = 0;
        state.tremOffset = 0;
        this.handleEffect(ch, state.effect, state.effectParam, true);
        if (state.volEffect) this.handleEffect(ch, state.volEffect, state.volEffectParam, true);

        const env = this.processEnvelopes(ch);
        const finalPan = Math.max(-1, Math.min(1, (state.panning || 0) + env.pan));

        this.updateWorkletChannel(ch, {
            volume: this.calculateFinalVolume(ch, state.volume),
            step: this.getStep(ch),
            panning: finalPan
        });
    }

    calculateFinalVolume(ch, vol) {
        const state = this.channelState[ch];
        const gVol = this.globalVolume / 64;
        const env = this.processEnvelopes(ch);
        const finalVol = Math.max(0, Math.min(64, vol + (state.tremOffset || 0)));
        return finalVol * gVol * env.vol;
    }

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
        if (!inst) return;

        if (inst.volPoints && inst.volPoints.length > 0 && (inst.volType & 1)) {
            if (!((inst.volType & 2) && !state.keyOff && state.volEnvTick === inst.volPoints[inst.volSustain].x)) {
                state.volEnvTick++;
            }
            if ((inst.volType & 4) && state.volEnvTick >= inst.volPoints[inst.volLoopEnd].x) {
                state.volEnvTick = inst.volPoints[inst.volLoopStart].x;
            }
        }

        if (inst.panPoints && inst.panPoints.length > 0 && (inst.panType & 1)) {
            if (!((inst.panType & 2) && !state.keyOff && state.panEnvTick === inst.panPoints[inst.panSustain].x)) {
                state.panEnvTick++;
            }
            if ((inst.panType & 4) && state.panEnvTick >= inst.panPoints[inst.panLoopEnd].x) {
                state.panEnvTick = inst.panPoints[inst.panLoopStart].x;
            }
        }

        if (state.keyOff) {
            state.fadeOut = Math.max(0, state.fadeOut - (inst.fadeout || 0));
        }
    }

    getEnvelopeValue(points, num, tick) {
        if (!points || num === 0) return 64.0;
        let i = 0;
        for (i = 0; i < num - 1; i++) {
            if (tick < points[i + 1].x) break;
        }
        if (i >= num - 1) return points[num - 1].y;
        const p1 = points[i], p2 = points[i + 1];
        const dx = p2.x - p1.x;
        if (dx === 0) return p2.y;
        return p1.y + (tick - p1.x) * (p2.y - p1.y) / dx;
    }

    getStep(ch) {
        const state = this.channelState[ch];
        const sampleRate = this.ctx?.sampleRate || 44100;
        if (!state.sampleData) return 0;

        let arpOffset = 0;
        const isXM = (this.module.type === 'XM');

        if (state.arp1 > 0 || state.arp2 > 0) {
            const phase = this.tick % 3;
            if (phase === 1) arpOffset = state.arp1;
            else if (phase === 2) arpOffset = state.arp2;
        }

        let effectiveNote = state.note + state.pitchOffset + arpOffset + (state.vibOffset || 0);

        if (isXM) {
            effectiveNote += this.getVibratoOffset(ch);
            const totalNote = effectiveNote + state.relativeNote;
            let freq;
            if (this.module.linearFreq) {
                const period = 7680 - totalNote * 64 - (state.finetune / 2);
                freq = 8363 * Math.pow(2, (4608 - period) / 768);
            } else {
                freq = 8363 * Math.pow(2, (totalNote - 48 + state.finetune / 128) / 12);
            }
            return Math.min(8.0, freq / sampleRate);
        } else if (this.module.type === 'S3M') {
            const s = this.getSample(state.instrument);
            // s3m formuler
            const freq = (s?.c2spd || 8363) * Math.pow(2, (effectiveNote - 48) / 12);
            return freq / sampleRate;
        } else {
            const p = this.noteToAmigaPeriod(effectiveNote, state.finetune);
            // amiger freuqnen
            return (this.AMIGA_CLOCK / (p * 2)) / sampleRate;
        }
    }

    getVibratoOffset(ch) {
        const state = this.channelState[ch];
        const inst = this.module.instruments?.[state.instrument - 1];
        let offset = 0;

        if (inst && inst.vibDepth > 0) {
            const sweep = inst.vibSweep > 0 ? Math.min(1.0, state.volEnvTick / inst.vibSweep) : 1.0;
            const phase = (state.autoVibPhase * Math.PI * 2) / 256;
            offset += Math.sin(phase) * (inst.vibDepth / 64) * sweep;
            state.autoVibPhase = (state.autoVibPhase + inst.vibRate) & 0xFF;
        }

        return offset;
    }

    noteToAmigaPeriod(note, fine) {
        const periods = [1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 906];
        const oct = Math.floor(note / 12);
        const n = note % 12;
        let p = periods[n];
        
        // low octaves (negative shift) correctly
        const shift = oct - 1;
        if (shift >= 0) {
            p = p >> shift;
        } else {
            p = p << (-shift);
        }

        if (fine !== 0) p *= Math.pow(2, -fine / (12 * 128));
        return Math.max(1, p);
    }

    getSample(idx) {
        if (!this.module || idx <= 0) return null;
        if (this.module.type === 'XM' && this.module.instruments) {
            const inst = this.module.instruments[idx - 1];
            if (!inst || !inst.samples || inst.samples.length === 0) return null;
            return inst.samples[0];
        } else if (this.module.samples) {
            return this.module.samples[idx - 1] || null;
        }
        return null;
    }

    processTickEffects() {
        for (let i = 0; i < this.module.channels; i++) {
            const state = this.channelState[i];

            if (state.delayTick > 0 && --state.delayTick === 0) {
                if (state.delayedNote) { this.triggerNote(i, state.delayedNote); state.delayedNote = null; }
            }

            state.vibOffset = 0;
            state.tremOffset = 0;

            if (state.effect !== 0) {
                this.handleEffect(i, state.effect, state.effectParam, false);
            }
            if (state.volEffect !== 0) {
                this.handleEffect(i, state.volEffect, state.volEffectParam, false);
            }

            this.advanceEnvelopes(i);

            const env = this.processEnvelopes(i);
            const finalPan = Math.max(-1, Math.min(1, (state.panning || 0) + env.pan));

            this.updateWorkletChannel(i, {
                volume: this.calculateFinalVolume(i, state.volume),
                step: this.getStep(i),
                panning: finalPan
            });
        }
    }

    handleEffect(ch, eff, param, tick0) {
        const state = this.channelState[ch];
        const isXM = (this.module.type === 'XM');
        const isS3M = (this.module.type === 'S3M');

        let p = param;

        // efect memeroy
        if (isXM) {
            //  (0x00 means use previous non-zero value)
            // 1=PortaUp, 2=PortaDown, 3=TonePorta, 4=Vib, 5=VolSlide+TonePorta, 6=VolSlide+Vib
            // A=VolSlide, E=Ext(some), H=GlobSlide, P=PanSlide, R=Retrig, X=Extra
            const memEffects = [0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0xA, 0x11, 0x19, 0x1B, 0x21];
            if (memEffects.includes(eff)) {
                if (param > 0) {
                    state.effectMemory[eff] = param;
                } else {
                    p = state.effectMemory[eff] || 0;
                }
            }
        } else {
            // ric fallback
            if (param > 0) {
                state.effectMemory[eff] = param;
            }
            p = state.effectMemory[eff] || 0;
        }

        if (tick0) {
            if (isS3M) {
                switch (eff) {
                    case 0x01: this.speed = p; break;
                    case 0x14: this.bpm = p; break;
                    case 0x16: this.globalVolume = Math.min(64, p); break; // S3M Global vol 0-64
                    case 0x0D: state.volume = Math.min(64, p); break;
                    case 0x02: this.jumpPos = p; break;
                    case 0x03: this.breakRow = p; break;
                    case 0x07: if (p > 0) state.portaSpeed = p; break;
                    case 0x04: { 
                        const dx = (p >> 4), dy = p & 0x0F;
                        if (dx === 0x0F && dy > 0) state.volume = Math.max(0, state.volume - dy);
                        else if (dy === 0x0F && dx > 0) state.volume = Math.min(64, state.volume + dx);
                        break;
                    }
                }
            } else { // XM / MOD
                switch (eff) {
                    case 0x00: 
                        state.arp1 = (param >> 4);
                        state.arp2 = (param & 0x0F);
                        break;
                    case 0x0C: state.volume = Math.min(64, param); break;
                    case 0x0B: this.jumpPos = param; this.breakRow = 0; break;
                    case 0x0D: this.breakRow = ((param >> 4) * 10) + (param & 0x0F); break;
                    case 0x0F: if (param < 32) this.speed = param; else this.bpm = param; break;
                    case 0x03: if (p > 0) state.portaSpeed = p; break;
                    case 0x08: state.panning = (param - 128) / 128; break;
                    case 0x0E: { 
                        const extEff = (param >> 4);
                        const extPrm = (param & 0x0F);
                        if (extEff === 0x08) state.panning = (extPrm * 16 + 8 - 128) / 128;
                        else if (extEff === 0x06) {
                            if (extPrm === 0) state.loopRow = this.row;
                            else if (state.loopCount === undefined || state.loopCount === 0) {
                                state.loopCount = extPrm;
                                this.breakRow = state.loopRow || 0;
                            } else {
                                if (--state.loopCount > 0) this.breakRow = state.loopRow || 0;
                            }
                        } else if (isXM && extEff === 0x01) { 
                            state.pitchOffset += (extPrm / 64);
                        } else if (isXM && extEff === 0x02) { 
                            state.pitchOffset -= (extPrm / 64);
                        } else if (isXM && extEff === 0x0A) { 
                            state.volume = Math.min(64, state.volume + extPrm);
                        } else if (isXM && extEff === 0x0B) { 
                            state.volume = Math.max(0, state.volume - extPrm);
                        }
                        break;
                    }
                    case 0x10: this.globalVolume = Math.min(64, param); break;
                    case 0x19: state.panSlide = (param >> 4) > 0 ? (param >> 4) : -(param & 0x0F); break;
                }
            }
        } else {
            // Tick effects
            if (isS3M) {
                switch (eff) {
                    case 0x04: {
                        const dx = (p >> 4), dy = p & 0x0F;
                        if (dx === 0x0F || dy === 0x0F) break;
                        if (dx > 0 && dy === 0) state.volume = Math.min(64, state.volume + dx);
                        else if (dy > 0 && dx === 0) state.volume = Math.max(0, state.volume - dy);
                        break;
                    }
                    case 0x05: state.pitchOffset -= (p / 64); break;
                    case 0x06: state.pitchOffset += (p / 64); break;
                    case 0x07:
                        if (state.targetNote > 0 && state.portaSpeed > 0) {
                            const diff = state.targetNote - state.note;
                            const speed = state.portaSpeed / 32;
                            if (Math.abs(diff) < speed) { state.note = state.targetNote; state.targetNote = 0; }
                            else state.note += (diff > 0 ? speed : -speed);
                        }
                        break;
                    case 0x17: { // Wxy
                        const x = (p >> 4), y = p & 0x0F;
                        if (x > 0) this.globalVolume = Math.min(64, this.globalVolume + x);
                        else if (y > 0) this.globalVolume = Math.max(0, this.globalVolume - y);
                        break;
                    }
                }
            } else {
                switch (eff) {
                    case 0x00: break; 
                    case 0x0A: { 
                        const x = (p >> 4), y = p & 0x0F;
                        if (x > 0) state.volume = Math.min(64, state.volume + x);
                        else if (y > 0) state.volume = Math.max(0, state.volume - y);
                        break;
                    }
                    case 0x01: state.pitchOffset += (p / 64); break;
                    case 0x02: state.pitchOffset -= (p / 64); break;
                    case 0x03: 
                        if (state.targetNote > 0 && state.portaSpeed > 0) {
                            const diff = state.targetNote - state.note;
                            const speed = state.portaSpeed / 64;
                            if (Math.abs(diff) < speed) { state.note = state.targetNote; state.targetNote = 0; }
                            else state.note += (diff > 0 ? speed : -speed);
                        }
                        break;
                    case 0x04: 
                    case 0x06: { 
                        if (eff === 0x06) {
                            const x = (p >> 4), y = p & 0x0F;
                            if (x > 0) state.volume = Math.min(64, state.volume + x);
                            else if (y > 0) state.volume = Math.max(0, state.volume - y);
                        }
                        const vP = state.effectMemory[0x04] || 0;
                        const x = (vP >> 4), y = vP & 0x0F;
                        if (x > 0) state.vibSpeed = x;
                        if (y > 0) state.vibDepth = y;
                        const phase = (state.vibPhase * Math.PI * 2) / 64;
                        state.vibOffset = Math.sin(phase) * (state.vibDepth / 8);
                        state.vibPhase = (state.vibPhase + state.vibSpeed) & 0x3F;
                        break;
                    }
                    case 0x05: { 
                        const x = (p >> 4), y = p & 0x0F;
                        if (x > 0) state.volume = Math.min(64, state.volume + x);
                        else if (y > 0) state.volume = Math.max(0, state.volume - y);
                        
                        if (state.targetNote > 0 && state.portaSpeed > 0) {
                            const diff = state.targetNote - state.note;
                            const speed = state.portaSpeed / 64;
                            if (Math.abs(diff) < speed) { state.note = state.targetNote; state.targetNote = 0; }
                            else state.note += (diff > 0 ? speed : -speed);
                        }
                        break;
                    }
                    case 0x07: { 
                        const x = (p >> 4), y = p & 0x0F;
                        if (x > 0) state.tremSpeed = x;
                        if (y > 0) state.tremDepth = y;
                        const phase = (state.tremPhase * Math.PI * 2) / 64;
                        state.tremOffset = Math.sin(phase) * (state.tremDepth / 4);
                        state.tremPhase = (state.tremPhase + state.tremSpeed) & 0x3F;
                        break;
                    }
                    case 0x11: { 
                        const x = (p >> 4), y = p & 0x0F;
                        if (x > 0) this.globalVolume = Math.min(64, this.globalVolume + x);
                        else if (y > 0) this.globalVolume = Math.max(0, this.globalVolume - y);
                        break;
                    }
                    case 0x19: { 
                        const x = (p >> 4), y = p & 0x0F;
                        if (x > 0) state.panning = Math.min(1, state.panning + x / 128);
                        else if (y > 0) state.panning = Math.max(-1, state.panning - y / 128);
                        break;
                    }
                    case 0x1B: { 
                        const x = (p >> 4), y = p & 0x0F;
                        if (y > 0 && (this.tick % y) === 0) {
                            if (x === 1) state.volume = Math.max(0, state.volume - 1);
                            else if (x === 2) state.volume = Math.max(0, state.volume - 2);
                            else if (x === 3) state.volume = Math.max(0, state.volume - 4);
                            else if (x === 4) state.volume = Math.max(0, state.volume - 8);
                            else if (x === 5) state.volume = Math.max(0, state.volume - 16);
                            else if (x === 6) state.volume = Math.floor(state.volume * 2 / 3);
                            else if (x === 7) state.volume = Math.floor(state.volume / 2);
                            else if (x === 9) state.volume = Math.min(64, state.volume + 1);
                            else if (x === 0xA) state.volume = Math.min(64, state.volume + 2);
                            else if (x === 0xB) state.volume = Math.min(64, state.volume + 4);
                            else if (x === 0xC) state.volume = Math.min(64, state.volume + 8);
                            else if (x === 0xD) state.volume = Math.min(64, state.volume + 16);
                            else if (x === 0xE) state.volume = Math.floor(state.volume * 3 / 2);
                            else if (x === 0xF) state.volume = Math.floor(state.volume * 2);
                            this.updateWorkletChannel(ch, { trigger: true, position: 0 });
                        }
                        break;
                    }
                    case 0x21: { 
                        const x = (p >> 4), y = (p & 0x0F);
                        if (x === 1) state.pitchOffset += (y / 256);
                        else if (x === 2) state.pitchOffset -= (y / 256);
                        break;
                    }
                }
            }
        }
    }

    updateWorkletChannel(index, data) {
        this.workletNode?.port.postMessage({ type: 'updateChannel', data: { index, ...data } });
    }
}
