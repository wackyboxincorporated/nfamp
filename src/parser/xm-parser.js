export class XMParser {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.offset = 0;
        this.type = 'XM';
    }

    read8() { return this.offset < this.view.byteLength ? this.view.getUint8(this.offset++) : 0; }
    read16() { if (this.offset + 2 > this.view.byteLength) return 0; const val = this.view.getUint16(this.offset, true); this.offset += 2; return val; }
    read32() { if (this.offset + 4 > this.view.byteLength) return 0; const val = this.view.getUint32(this.offset, true); this.offset += 4; return val; }
    readString(len) {
        let str = '';
        const start = this.offset;
        for (let i = 0; i < len; i++) {
            const char = this.read8();
            if (char !== 0) str += String.fromCharCode(char);
        }
        this.offset = start + len;
        return str.trim();
    }
    seek(pos) { this.offset = Math.min(pos, this.view.byteLength); }

    parse() {
        this.seek(0);
        const signature = this.readString(17);
        if (!signature.startsWith('Extended Module')) throw new Error('Not a valid XM file');
        const name = this.readString(20);
        this.seek(0x3C);
        const headerSize = this.read32();
        const headerStart = 60;
        const songLength = this.read16();
        this.read16(); // Restart
        const numChannels = this.read16();
        const numPatterns = this.read16();
        const numInstruments = this.read16();
        const flags = this.read16();
        const defaultSpeed = this.read16();
        const defaultBPM = this.read16();

        const songOrder = [];
        for (let i = 0; i < songLength; i++) songOrder.push(this.read8());

        this.seek(headerStart + headerSize);
        const patterns = [];
        for (let i = 0; i < numPatterns; i++) patterns.push(this.parsePattern(numChannels));

        const instruments = [];
        for (let i = 0; i < numInstruments; i++) instruments.push(this.parseInstrument());

        return {
            name,
            songLength,
            songOrder,
            patterns,
            instruments,
            channels: numChannels,
            initialSpeed: defaultSpeed || 6,
            initialBPM: defaultBPM || 125,
            linearFreq: (flags & 1) !== 0,
            type: 'XM'
        };
    }

    parsePattern(channels) {
        const start = this.offset;
        const headerSize = this.read32();
        this.read8(); // packing
        const numRows = this.read16();
        const dataSize = this.read16();
        this.seek(start + headerSize);

        const rows = Array.from({ length: numRows }, () => []);
        if (dataSize > 0) {
            for (let r = 0; r < numRows; r++) {
                for (let c = 0; c < channels; c++) {
                    const b = this.read8();
                    const n = { note: 255, sample: 0, volume: 255, effect: 0, param: 0 };
                    if (b & 0x80) {
                        if (b & 1) {
                            const raw = this.read8();
                            n.note = (raw > 0 && raw < 97) ? raw - 1 : (raw === 0 ? 255 : raw);
                        }
                        if (b & 2) n.sample = this.read8();
                        if (b & 4) n.volume = this.read8();
                        if (b & 8) n.effect = this.read8();
                        if (b & 16) n.param = this.read8();
                    } else {
                        const raw = b;
                        n.note = (raw > 0 && raw < 97) ? raw - 1 : (raw === 0 ? 255 : raw);
                        n.sample = this.read8();
                        n.volume = this.read8();
                        n.effect = this.read8();
                        n.param = this.read8();
                    }
                    rows[r][c] = n;
                }
            }
        }
        return { rows, numRows };
    }

    parseInstrument() {
        const start = this.offset;
        const size = this.read32();
        const name = this.readString(22);
        this.read8(); // type
        const numSamples = this.read16();
        const inst = { name, samples: [], sampleMap: new Uint8Array(96) };

        if (numSamples > 0) {
            const sampleHeaderSize = this.read32();
            // kkeymap (96 bytes)
            for (let i = 0; i < 96; i++) inst.sampleMap[i] = this.read8();

            // volume envelope (48 bytes)
            inst.volPoints = [];
            for (let i = 0; i < 12; i++) {
                inst.volPoints.push({ x: this.read16(), y: this.read16() });
            }
            // Paanning Evelop (48 bytes)
            inst.panPoints = [];
            for (let i = 0; i < 12; i++) {
                inst.panPoints.push({ x: this.read16(), y: this.read16() });
            }

            inst.numVolPoints = this.read8();
            inst.numPanPoints = this.read8();
            inst.volSustain = this.read8();
            inst.volLoopStart = this.read8();
            inst.volLoopEnd = this.read8();
            inst.panSustain = this.read8();
            inst.panLoopStart = this.read8();
            inst.panLoopEnd = this.read8();
            inst.volType = this.read8();
            inst.panType = this.read8();

            inst.vibType = this.read8();
            inst.vibSweep = this.read8();
            inst.vibDepth = this.read8();
            inst.vibRate = this.read8();
            inst.fadeout = this.read16();

            this.seek(start + size); // mple headers
            const headers = [];
            for (let i = 0; i < numSamples; i++) headers.push(this.parseSampleHeader());
            for (let i = 0; i < numSamples; i++) inst.samples.push(this.loadSampleData(headers[i]));
        } else {
            this.seek(start + size);
        }
        return inst;
    }

    parseSampleHeader() {
        const length = this.read32();
        const loopStart = this.read32();
        const loopLength = this.read32();
        const volume = this.read8();
        const fine = this.view.getInt8(this.offset++);
        const type = this.read8();
        const pan = this.read8();
        const relativeNote = this.view.getInt8(this.offset++);
        this.read8(); // reserved
        const name = this.readString(22);
        return { length, loopStart, loopLength, volume, finetune: fine, relativeNote, type, name };
    }

    loadSampleData(header) {
        const is16Bit = (header.type & 16) !== 0;
        const dataLength = header.length / (is16Bit ? 2 : 1);
        const data = new Float32Array(dataLength);
        let last = 0;
        for (let i = 0; i < dataLength; i++) {
            const delta = is16Bit ? this.view.getInt16(this.offset, true) : this.view.getInt8(this.offset);
            this.offset += is16Bit ? 2 : 1;
            last += delta;
            if (is16Bit) {
                if (last > 32767) last -= 65536;
                else if (last < -32768) last += 65536;
                data[i] = last / 32768.0;
            } else {
                if (last > 127) last -= 256;
                else if (last < -128) last += 256;
                data[i] = last / 128.0;
            }
        }
        return { ...header, data };
    }
}
