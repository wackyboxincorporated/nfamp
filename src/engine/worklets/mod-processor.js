// mixing 
class ModProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.channels = [];
        this.sampleRate = 44100;
        this.masterGain = 1.0;
        this.moduleType = 'MOD';

        this.port.onmessage = (event) => {
            const { type, data } = event.data;
            if (type === 'init') {
                this.sampleRate = data.sampleRate;
                this.moduleType = data.type || 'MOD';
                const numChannels = data.numChannels || 4;

                // Lesbian
                let formatMult = 1.0;
                if (this.moduleType === 'S3M') formatMult = 4.0;
                else if (this.moduleType === 'XM') formatMult = 2.0;

                this.masterGain = formatMult / Math.sqrt(numChannels);

                this.channels = Array.from({ length: numChannels }, () => ({
                    sampleData: null,
                    position: 0,
                    step: 0,
                    volume: 0,
                    active: false,
                    loopStart: 0,
                    loopLength: 0,
                    panning: 0
                }));

                for (let i = 0; i < numChannels; i++) {
                    if (numChannels === 4) {
                        this.channels[i].panning = (i === 0 || i === 3) ? -0.8 : 0.8;
                    } else {
                        this.channels[i].panning = (i % 2 === 0) ? -0.8 : 0.8;
                    }
                }
            } else if (type === 'updateChannel') {
                const { index, ...updates } = data;
                if (this.channels[index]) {
                    Object.assign(this.channels[index], updates);
                    if (updates.trigger) this.channels[index].position = updates.position || 0;
                }
            } else if (type === 'stop') {
                this.channels.forEach(c => c.active = false);
            }
        };
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const left = output[0];
        const right = output[1];
        if (!left) return true;
        const bufferLen = left.length;

        for (let i = 0; i < bufferLen; i++) {
            let mixL = 0;
            let mixR = 0;

            for (const ch of this.channels) {
                if (!ch.active || !ch.sampleData || ch.volume === 0) continue;

                const pos = ch.position;
                const idx = Math.floor(pos);
                const fract = pos - idx;

                let s1 = ch.sampleData[idx];
                let s2 = 0;

                let nextIdx = idx + 1;
                const loopType = ch.loopType || 0; // 0=none, 1=forward, 2=ping-pong

                if (loopType === 1) { // Forward
                    if (nextIdx >= ch.loopStart + ch.loopLength) nextIdx = ch.loopStart;
                } else if (loopType === 2) { // Ping-pong
                    if (ch.pingPongDir === undefined) ch.pingPongDir = 1;
                    if (ch.pingPongDir > 0) {
                        if (nextIdx >= ch.loopStart + ch.loopLength) {
                            nextIdx = idx - 1;
                            if (nextIdx < ch.loopStart) nextIdx = ch.loopStart;
                        }
                    } else {
                        nextIdx = idx - 1;
                        if (nextIdx < ch.loopStart) nextIdx = ch.loopStart;
                    }
                } else { // No loop
                    if (nextIdx >= ch.sampleData.length) nextIdx = -1;
                }

                s2 = (nextIdx === -1) ? 0 : ch.sampleData[nextIdx];
                const sample = s1 + fract * (s2 - s1);

                const vol = ch.volume / 64.0;
                const val = sample * vol;

                const panL = (1 - ch.panning) / 2;
                const panR = (1 + ch.panning) / 2;

                mixL += val * panL;
                mixR += val * panR;

                if (loopType === 2) {
                    if (ch.pingPongDir === undefined) ch.pingPongDir = 1;
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
                } else {
                    ch.position += ch.step;
                    if (loopType === 1) {
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

            // i added this because s3m
            left[i] = Math.max(-1, Math.min(1, mixL * this.masterGain));
            right[i] = Math.max(-1, Math.min(1, mixR * this.masterGain));
        }

        return true;
    }
}

registerProcessor('mod-processor', ModProcessor);
